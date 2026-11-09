/**
 * 问问小星（F12）：买家向小星提问商品细节，小星只依据商品信息回答。
 *
 * 原则 2：回答只给提问者本人看（getItemDetail 的 myQuestions），卖家看到的是匿名问题列表。
 * 原则 3：卖家联系方式与代谈底价不进入 prompt，也不允许出现在回答里（服务端兜底拦截）。
 * 原则 6：AI 不可用 / 超时 / 输出不合法一律返回 { available: false }，不写库、不抛错。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, forbidden, notFound } from '../errors.ts';
import { one } from '../db/query.ts';
import { aiConfig, chat, extractJson, loadPrompt, type AiConfig, type ChatOptions } from './ai.ts';
import type { Actor } from './deal.ts';

export type ChatFn = (cfg: AiConfig, opts: ChatOptions) => Promise<string | null>;

/** 每人每件商品最多提问次数。 */
export const ASK_LIMIT = 5;
const ASK_TIMEOUT_MS = 10_000;

const CONDITION_TEXT: Record<string, string> = { new: '全新', like_new: '九成新', good: '八成新', fair: '其他' };

interface AskItemRow {
  id: number;
  seller_id: number;
  status: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  trade_type: string;
  price: number;
  original_price: number | null;
  handoff_location: string;
  handoff_time: string | null;
  kind: string;
  handoff_mode: string;
  expires_on: string | null;
  cover: string | null;
}

/** 当前用户对某商品已提问次数（只统计成功写库的）。 */
export function askCount(db: DatabaseSync, itemId: number, askerId: number): number {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM item_questions WHERE item_id = ? AND asker_id = ?', [itemId, askerId])!.n;
}

/** 组装给小星的商品信息。只含商品公开字段：不带卖家联系方式、不带代谈底价（原则 3）。 */
function buildContext(item: AskItemRow): string {
  const lines = [
    '商品信息：',
    `标题：${item.title}`,
    `分类：${item.category}`,
    `成色：${item.condition}（${CONDITION_TEXT[item.condition] ?? item.condition}）`,
    item.trade_type === 'free' ? '价格：免费赠送' : `价格：¥${item.price}`,
    `全新参考价：${item.original_price == null ? '未填写' : `¥${item.original_price}`}`,
  ];
  if (item.kind === 'voucher') {
    lines.push(`交接方式：${item.handoff_mode === 'online' ? '线上转赠' : '线下当面'}`);
    lines.push(`有效期：${item.expires_on ?? '长期有效'}`);
  }
  if (item.handoff_mode !== 'online') lines.push(`交接地点：${item.handoff_location}`);
  lines.push(`可交接时间：${item.handoff_time ?? '双方协商'}`);
  lines.push(`描述：${item.description.trim() ? item.description.trim() : '卖家没有填写描述'}`);
  return lines.join('\n');
}

export type AskResult = { available: true; answer: string; known: boolean; questionId: number } | { available: false };

/**
 * 提问入口：校验身份 / 状态 / 次数后同步调用小星（10s 超时）。
 * 成功（含 known=false 的回答）写库并返回 available:true；AI 不可用或输出不合法返回 available:false，不写库。
 */
export async function askQuestion(
  db: DatabaseSync,
  actor: Actor,
  itemId: number,
  question: string,
  opts: { uploadDir: string; chatFn?: ChatFn },
): Promise<AskResult> {
  const chatFn = opts.chatFn ?? chat;
  const item = one<AskItemRow>(
    db,
    `SELECT i.id, i.seller_id, i.status, i.title, i.description, c.name AS category, i.condition, i.trade_type, i.price,
            i.original_price, i.handoff_location, i.handoff_time, i.kind, i.handoff_mode, i.expires_on,
            (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover
     FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?`,
    [itemId],
  );
  if (!item) throw notFound('商品');
  if (item.seller_id === actor.id) throw forbidden('不能问自己发布的商品');
  if (item.status !== 'published') throw new AppError(409, 'INVALID_STATE', '只有发布中的商品可以提问');
  if (askCount(db, itemId, actor.id) >= ASK_LIMIT) throw new AppError(409, 'QUESTION_LIMIT', `每件商品最多问 ${ASK_LIMIT} 次`);

  const system = loadPrompt('ask');
  const cfg = aiConfig();
  if (!system || !cfg) return { available: false };

  // 首图（复用 draft 的读图方式）：只读本服务器已存图片，文件缺失就纯文字提问。
  let imageBlock: { type: string; [k: string]: unknown }[] | undefined;
  if (item.cover) {
    const file = join(opts.uploadDir, item.cover);
    if (existsSync(file)) {
      const b64 = readFileSync(file).toString('base64');
      const ext = item.cover.split('.').pop() ?? 'jpg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      imageBlock = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }];
    }
  }

  const user = `${buildContext(item)}\n${imageBlock ? '（已附带商品首图，请结合图片回答）\n' : ''}买家的问题：${question}`;
  const raw = await chatFn(cfg, { system, user, contentBlocks: imageBlock, maxTokens: 256, timeoutMs: ASK_TIMEOUT_MS, temperature: 0.2 });
  const result = extractJson<{ answer?: unknown; known?: unknown }>(raw);
  const answer = typeof result?.answer === 'string' ? result.answer.trim().slice(0, 80) : '';
  if (!answer) return { available: false }; // 超时 / 解析失败 / 空回答：安静降级，不写库

  // 原则 3 兜底：回答里出现卖家联系方式时按不可用处理，不落库不展示。
  const contact = one<{ contact: string | null }>(db, 'SELECT contact FROM users WHERE id = ?', [item.seller_id])?.contact;
  if (contact && contact.length >= 3 && answer.includes(contact)) return { available: false };

  const known = result!.known === true;
  const row = db
    .prepare('INSERT INTO item_questions (item_id, asker_id, question, answer, known) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, actor.id, question, answer, known ? 1 : 0);
  return { available: true, answer, known, questionId: Number(row.lastInsertRowid) };
}
