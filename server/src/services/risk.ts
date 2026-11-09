/**
 * F2 公司资产识别与违规预检。
 * 判定规则写死在 prompts/risk.txt（draft 内嵌判定在 prompts/draft.txt），后台只读展示。
 * 原则：强提醒 + 发布者确认 + 管理员复核，不自动拦截；AI 失败或超时一律「未检」放行，主流程永不阻塞。
 * 预警结果必须由服务端落库（ai_risk_checks），发布时凭 riskCheckId 回查，不信任前端传入的理由文本。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { one } from '../db/query.ts';
import { aiConfig, chat, extractJson, loadPrompt, type AiConfig, type ChatOptions } from './ai.ts';

export type RiskLevel = 'none' | 'warn';
export type RiskType = 'company_asset' | 'prohibited';

export type RiskResult = { level: 'none' } | { level: 'warn'; type: RiskType; reason: string };

const RISK_CHECK_TIMEOUT_MS = 6_000;

/**
 * 收紧模型给出的 risk 结构：warn 必须带合法 type 和非空 reason，否则视为无效。
 * 返回 null 表示没有有效的判定结果（按「未检」处理，不放报预警）。
 */
export function normalizeRisk(raw: unknown): RiskResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { level?: unknown; type?: unknown; reason?: unknown };
  if (r.level === 'none') return { level: 'none' };
  if (r.level === 'warn') {
    if (r.type !== 'company_asset' && r.type !== 'prohibited') return null;
    const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 40) : '';
    if (!reason) return null;
    return { level: 'warn', type: r.type, reason };
  }
  return null;
}

/** 解析模型针对 check 请求的输出（整个输出就是一个 risk JSON）。 */
export function parseRisk(raw: string | null): RiskResult | null {
  return normalizeRisk(extractJson<unknown>(raw));
}

export interface RiskPublishMeta {
  /** draft/check 返回并落库的预检记录 id；必须属于当前用户，否则忽略。 */
  riskCheckId?: number;
  /** 发布者已勾选「我确认这是个人物品」。 */
  riskAck?: boolean;
}

export interface AppliedRisk {
  /** false = 没有（有效的）riskCheckId，不写入商品预警字段，保持原值/默认未检。 */
  applied: boolean;
  checked: 0 | 1;
  type: RiskType | null;
  reason: string | null;
  ack: 0 | 1;
}

/**
 * 发布/编辑时的风险确认校验：
 * - warn 且未确认 → 409 RISK_ACK_REQUIRED（强提醒，不拦截：确认后照常上架）。
 * - riskCheckId 不属于当前用户或不存在 → 忽略（按未检放行）。
 */
export function resolveRiskForPublish(db: DatabaseSync, userId: number, meta?: RiskPublishMeta): AppliedRisk {
  const unchecked: AppliedRisk = { applied: false, checked: 0, type: null, reason: null, ack: 0 };
  if (!meta?.riskCheckId) return unchecked;
  const row = one<{ level: RiskLevel; type: RiskType | null; reason: string | null }>(
    db,
    'SELECT level, type, reason FROM ai_risk_checks WHERE id = ? AND user_id = ?',
    [meta.riskCheckId, userId],
  );
  if (!row) return unchecked; // 归属校验失败：忽略
  if (row.level === 'warn') {
    if (meta.riskAck !== true) {
      throw new AppError(409, 'RISK_ACK_REQUIRED', '小星注意到这件商品可能是公司资产或违规品，请先确认这是个人物品');
    }
    return { applied: true, checked: 1, type: row.type, reason: row.reason, ack: 1 };
  }
  return { applied: true, checked: 1, type: null, reason: null, ack: 0 };
}

export interface RiskCheckInput {
  title: string;
  description?: string;
  imageIds?: number[];
  uploadDir: string;
}

export interface RiskCheckOutcome {
  /** false = AI 失败或超时，按「未检」放行，不落库。 */
  checked: boolean;
  riskCheckId: number | null;
  risk: RiskResult | null;
}

/** 读图片转 base64（复用 draft 的方式），最多 2 张，读不到的跳过。 */
function imageBlocks(db: DatabaseSync, uploadDir: string, imageIds: number[]): { type: string; [k: string]: unknown }[] {
  const blocks: { type: string; [k: string]: unknown }[] = [];
  for (const id of imageIds.slice(0, 2)) {
    const img = one<{ path: string }>(db, 'SELECT path FROM item_images WHERE id = ?', [id]);
    const file = img ? join(uploadDir, img.path) : null;
    if (!img || !file || !existsSync(file)) continue;
    const b64 = readFileSync(file).toString('base64');
    const ext = img.path.split('.').pop() ?? 'jpg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    blocks.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  return blocks;
}

/**
 * 独立补检：判定 + 落库。chatFn 可注入用于测试。
 * 任何失败（无 key、prompt 缺失、超时 6s、解析失败）都返回 checked=false（未检放行，不落库）。
 */
export async function runRiskCheck(
  db: DatabaseSync,
  userId: number,
  input: RiskCheckInput,
  chatFn: (cfg: AiConfig, opts: ChatOptions) => Promise<string | null> = chat,
): Promise<RiskCheckOutcome> {
  const unchecked: RiskCheckOutcome = { checked: false, riskCheckId: null, risk: null };
  const cfg = aiConfig();
  const system = loadPrompt('risk');
  if (!cfg || !system) return unchecked;
  const blocks = input.imageIds?.length ? imageBlocks(db, input.uploadDir, input.imageIds) : undefined;
  const desc = (input.description ?? '').trim().slice(0, 300);
  const user = `商品信息：\n标题：${input.title.trim().slice(0, 60)}\n描述：${desc || '（无）'}${blocks ? '\n（已附带商品照片，请结合照片判断）' : ''}`;
  const raw = await chatFn(cfg, { system, user, contentBlocks: blocks, maxTokens: 256, timeoutMs: RISK_CHECK_TIMEOUT_MS });
  const risk = parseRisk(raw);
  if (!risk) return unchecked;
  const imageIds = (input.imageIds ?? []).slice(0, 2);
  const r = db
    .prepare('INSERT INTO ai_risk_checks (user_id, image_ids, level, type, reason) VALUES (?, ?, ?, ?, ?)')
    .run(userId, imageIds.length ? JSON.stringify(imageIds) : null, risk.level, risk.level === 'warn' ? risk.type : null, risk.level === 'warn' ? risk.reason : null);
  return { checked: true, riskCheckId: Number(r.lastInsertRowid), risk };
}
