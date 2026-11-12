import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../errors.ts';
import { all, one } from '../db/query.ts';
import { aiConfig, chat, extractJson, loadPrompt, type AiConfig, type ChatOptions } from '../services/ai.ts';
import { beijingToday } from '../../../shared/schemas.ts';
import { dashboard, type Range } from '../services/dashboard.ts';
import { normalizeRisk, runRiskCheck } from '../services/risk.ts';
import type { Env } from '../types.ts';

async function aiJson<T>(system: string, user: string, maxTokens = 1024): Promise<T | null> {
  const cfg = aiConfig();
  if (!cfg) return null;
  return extractJson<T>(await chat(cfg, { system, user, maxTokens }));
}

// ---- 发布助手 ----

interface DraftResult {
  title?: string;
  description?: string;
  categoryId?: number;
  condition?: string;
  priceSuggestion?: { min?: number; max?: number; reason?: string } | null;
  newPriceEstimate?: number | null;
  price?: unknown; // F16：用户原话里说的出售价（转述，不是估价）
  missing?: string[];
  risk?: unknown; // F2：结构由 normalizeRisk 收紧
  kind?: unknown; // F16：goods | voucher，非法值按 goods
  expiresOn?: unknown; // F16：YYYY-MM-DD | null，非法值归 null
  quantity?: unknown; // F16：1-10，默认 1
  uncertain?: unknown; // F1/F16：拿不准的字段名，服务端按 UNCERTAIN_WHITELIST 过滤
}

/** F1：uncertain 白名单。模型给出的其他字段名一律丢弃，前端只对白名单字段标黄。 */
const UNCERTAIN_WHITELIST = ['title', 'categoryId', 'condition', 'price', 'newPriceEstimate', 'expiresOn', 'quantity'];

// ---- 语义搜索 ----

interface SearchAiResult {
  understanding?: string;
  matches?: { id?: number; reason?: string }[];
}

/** 关键词搜不到时由列表接口调用；返回 null 表示 AI 不可用。 */
export async function semanticSearch(
  db: DatabaseSync,
  q: string,
): Promise<{ understanding: string; matches: { id: number; reason: string }[] } | null> {
  const items = all<{ id: number; title: string; category: string; price: number; trade_type: string; description: string }>(
    db,
    `SELECT i.id, i.title, c.name AS category, i.price, i.trade_type, substr(i.description, 1, 80) AS description
     FROM items i JOIN categories c ON c.id = i.category_id
     WHERE i.status = 'published' ORDER BY i.published_at DESC LIMIT 100`,
  );
  if (items.length === 0) return null;
  const list = items.map((x) => `${x.id}|${x.title}|${x.category}|${x.trade_type === 'free' ? '免费' : `¥${x.price}`}|${x.description}`).join('\n');
  const system = loadPrompt('search');
  if (!system) return null;
  const result = await aiJson<SearchAiResult>(system, `用户搜索：${q}\n\n在售商品（id|标题|分类|价格|描述）：\n${list}`, 768);
  if (!result) return null;
  const validIds = new Set(items.map((x) => x.id));
  const matches = (result.matches ?? [])
    .filter((m): m is { id: number; reason?: string } => typeof m.id === 'number' && validIds.has(m.id))
    .map((m) => ({ id: m.id, reason: (m.reason ?? '').slice(0, 40) }));
  return { understanding: (result.understanding ?? '').slice(0, 40), matches };
}

// ---- 价值报告（管理员） ----

interface ReportResult {
  report?: string;
}

// ---- 心愿助手 ----

export interface WishDraft {
  content?: string;
  budget?: number | null;
  freeOk?: boolean;
  budgetReason?: string | null;
}

/** 解析并收紧模型输出；失败返回 null。 */
export function parseWishDraft(raw: string | null): WishDraft | null {
  const d = extractJson<WishDraft>(raw);
  if (!d || typeof d.content !== 'string' || !d.content.trim()) return null;
  const out: WishDraft = { content: d.content.trim().slice(0, 100) };
  if (typeof d.budget === 'number' && Number.isFinite(d.budget) && d.budget >= 0) out.budget = Math.round(d.budget);
  else out.budget = null;
  out.freeOk = d.freeOk === true;
  out.budgetReason = typeof d.budgetReason === 'string' ? d.budgetReason.slice(0, 60) : null;
  return out;
}

export function aiRoutes(db: DatabaseSync, uploadDir: string, opts: { chat?: (cfg: AiConfig, opts: ChatOptions) => Promise<string | null> } = {}): Hono<Env> {
  const chatFn = opts.chat ?? chat;
  const r = new Hono<Env>();

  // 未配置 AI key 时全部返回 503，前端隐藏入口
  r.use('*', async (_c, next) => {
    if (!aiConfig()) throw new AppError(503, 'AI_DISABLED', 'AI 能力未启用');
    await next();
  });

  r.post('/draft', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string; imageId?: number } | null;
    const text = body?.text?.trim();
    const imageId = typeof body?.imageId === 'number' ? body.imageId : undefined;
    // F1：有 imageId 时 text 可为空（纯图识别，清仓模式依赖）；两者都没有才拒绝
    if (!text && !imageId) throw new AppError(400, 'INVALID_INPUT', '请输入一句话描述（300 字以内）或提供一张图片');
    if (text && text.length > 300) throw new AppError(400, 'INVALID_INPUT', '请输入一句话描述（300 字以内）');

    // 用户已上传图片时附第一张，让模型结合图片识别（只读本服务器的已存图片）
    let imageBlock: { type: string; [k: string]: unknown }[] | undefined;
    if (imageId) {
      const img = one<{ path: string }>(db, 'SELECT path FROM item_images WHERE id = ?', [imageId]);
      const file = img ? join(uploadDir, img.path) : null;
      if (img && file && existsSync(file)) {
        const b64 = readFileSync(file).toString('base64');
        const ext = img.path.split('.').pop() ?? 'jpg';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        imageBlock = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }];
      }
    }
    // 纯图识别时图片必须真实可读，否则模型无米下锅
    if (!text && !imageBlock) throw new AppError(400, 'INVALID_IMAGE', '图片不存在或已失效，请重新上传');

    const categories = all<{ id: number; name: string }>(db, 'SELECT id, name FROM categories WHERE enabled = 1 ORDER BY sort, id');
    const userPrompt = `分类列表：${categories.map((x) => `${x.id}=${x.name}`).join('、')}\n今天是 ${beijingToday()}（北京时间）\n${imageBlock ? '（已附带商品图片，请结合图片内容）\n' : ''}用户输入：${text || '（无文字描述，仅依据图片识别）'}`;
    const cfg = aiConfig()!;
    const system = loadPrompt('draft');
    if (!system) return c.json({ available: false });
    const chatOpts = { system, user: userPrompt, contentBlocks: imageBlock, maxTokens: 2048, timeoutMs: 20_000 };
    let raw = await chatFn(cfg, chatOpts);
    let result = extractJson<DraftResult>(raw);
    // 输出被截断或格式跑偏时自动重试一次，仍失败才降级
    if (!result) {
      raw = await chatFn(cfg, chatOpts);
      result = extractJson<DraftResult>(raw);
      if (!result) console.warn('[ai] draft 解析失败（两次）:', (raw ?? 'null').slice(0, 300));
    }
    if (!result) return c.json({ available: false });
    // 分类不在列表里就丢弃，让用户自己选
    if (result.categoryId && !categories.some((x) => x.id === result.categoryId)) delete result.categoryId;
    if (result.condition && !['new', 'like_new', 'good', 'fair'].includes(result.condition)) delete result.condition;
    if (typeof result.newPriceEstimate !== 'number' || !Number.isFinite(result.newPriceEstimate) || result.newPriceEstimate <= 0) delete result.newPriceEstimate;
    else result.newPriceEstimate = Math.round(result.newPriceEstimate);
    // F16：用户原话里的挂牌价（不是估价），只在 1-100 万的整数范围内采信
    result.price =
      typeof result.price === 'number' && Number.isFinite(result.price) && result.price >= 1 && result.price <= 1_000_000
        ? Math.round(result.price)
        : null;
    // F16 券类字段收紧：kind 非法按 goods；expiresOn 必须是真实存在的日期否则归 null；quantity 夹在 1-10
    if (result.kind !== 'goods' && result.kind !== 'voucher') result.kind = 'goods';
    const rawExp = typeof result.expiresOn === 'string' ? result.expiresOn : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawExp) || Number.isNaN(new Date(`${rawExp}T00:00:00Z`).getTime())) result.expiresOn = null;
    result.quantity =
      typeof result.quantity === 'number' && Number.isFinite(result.quantity)
        ? Math.min(10, Math.max(1, Math.round(result.quantity)))
        : 1;
    // F1：uncertain 按白名单过滤（前端据此标黄），模型乱给的字段名丢弃
    result.uncertain = Array.isArray(result.uncertain)
      ? result.uncertain.filter((x): x is string => typeof x === 'string' && UNCERTAIN_WHITELIST.includes(x))
      : [];
    // F2：draft 顺带的风控判定（不增加调用次数）。结果服务端落库，发布时凭 riskCheckId 回查；
    // 模型没给出有效判定时按「未检」处理（不落库、不返回 riskCheckId）。
    let riskCheckId: number | null = null;
    const risk = normalizeRisk(result.risk);
    if (risk) {
      const row = db
        .prepare('INSERT INTO ai_risk_checks (user_id, image_ids, level, type, reason) VALUES (?, ?, ?, ?, ?)')
        .run(c.get('user').id, imageId ? JSON.stringify([imageId]) : null, risk.level, risk.level === 'warn' ? risk.type : null, risk.level === 'warn' ? risk.reason : null);
      riskCheckId = Number(row.lastInsertRowid);
    }
    return c.json({ available: true, draft: { ...result, risk: risk ?? { level: 'none' } }, riskCheckId });
  });

  // F2 风控补检：手动发布未经识别、编辑后内容变动时由前端调用。6s 超时，失败按「未检」放行。
  r.post('/check', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { title?: string; description?: string; imageIds?: number[] } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const imageIds = Array.isArray(body?.imageIds)
      ? body.imageIds.filter((n) => Number.isInteger(n) && n > 0).slice(0, 2)
      : [];
    if (!title && !description) throw new AppError(400, 'INVALID_INPUT', '标题或描述至少填写一项');
    if (title.length > 60 || description.length > 2000) throw new AppError(400, 'INVALID_INPUT', '标题或描述过长');
    const outcome = await runRiskCheck(db, c.get('user').id, { title, description, imageIds, uploadDir }, chatFn);
    if (!outcome.checked) return c.json({ available: false });
    return c.json({ available: true, riskCheckId: outcome.riskCheckId, risk: outcome.risk });
  });

  r.post('/wish-draft', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    const text = body?.text?.trim();
    if (!text || text.length > 200) throw new AppError(400, 'INVALID_INPUT', '请用一句话描述想要的物品（200 字以内）');
    const system = loadPrompt('wish-draft');
    if (!system) return c.json({ available: false });
    const raw = await chat(aiConfig()!, { system, user: text, maxTokens: 384 });
    const draft = parseWishDraft(raw);
    if (!draft) return c.json({ available: false });
    return c.json({ available: true, draft });
  });

  r.post('/report', async (c) => {
    if (c.get('user').role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理员权限');
    const query = c.req.query();
    const range: Range = { from: query.from, to: query.to };
    const includeDemo = query.includeDemo === '1';
    const d = dashboard(db, range, includeDemo);
    const summary = {
      统计口径: includeDemo ? '含演示数据' : '仅真实员工', 统计范围: `${d.range.from} 至 ${d.range.to ?? '今天'}`,
      发布数: d.published,
      申请数: d.requests,
      完成交易数: d.completed,
      供需匹配率: d.matchRate === null ? null : `${Math.round(d.matchRate * 100)}%`,
      交易完成率: d.completionRate === null ? null : `${Math.round(d.completionRate * 100)}%`,
      平均交易周期小时: d.avgCycleHours === null ? null : Math.round(d.avgCycleHours * 10) / 10,
      活跃员工数: d.activeUsers,
      流转金额元: d.flow.amount,
      为同事节省元: d.saved,
      节省覆盖笔数: `${d.savedCoverage.covered}/${d.savedCoverage.total}`,
      免费送出件数: d.flow.freeCount,
      漏斗: d.funnel,
      各分类发布与完成: d.byCategory,
    };
    const system = loadPrompt('report');
    if (!system) return c.json({ available: false });
    const result = await aiJson<ReportResult>(system, JSON.stringify(summary, null, 1), 768);
    if (!result?.report) return c.json({ available: false });
    return c.json({ available: true, report: result.report.slice(0, 600) });
  });

  return r;
}
