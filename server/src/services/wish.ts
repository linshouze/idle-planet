import type { DatabaseSync } from 'node:sqlite';
import { AppError, forbidden, notFound } from '../errors.ts';
import { NOW, tx } from '../db/index.ts';
import { all, one } from '../db/query.ts';
import { aiConfig, chat, extractJson, loadPrompt, type AiConfig, type ChatOptions } from './ai.ts';
import type { Actor } from './deal.ts';

export const WISH_TTL_DAYS = 14;
export const WISH_LIMIT = 5;

/** 14 天有效期在查询时计算，不需要定时任务。p 为列名前缀（如 'w.'）。 */
const fresh = (p = '') =>
  `${p}status = 'active' AND (strftime('%s','now') - strftime('%s', COALESCE(${p}renewed_at, ${p}created_at))) < ${WISH_TTL_DAYS * 86400}`;

export interface WishRow {
  id: number;
  user_id: number;
  content: string;
  budget: number | null;
  free_ok: number;
  status: string;
  created_at: string;
  renewed_at: string | null;
  fulfilled_at: string | null;
}

export function wishState(w: Pick<WishRow, 'status' | 'created_at' | 'renewed_at'>): 'active' | 'expired' | 'closed' | 'fulfilled' {
  if (w.status !== 'active') return w.status as 'closed' | 'fulfilled';
  const base = new Date(w.renewed_at ?? w.created_at).getTime();
  return Date.now() - base >= WISH_TTL_DAYS * 86400_000 ? 'expired' : 'active';
}

const budgetText = (w: { budget: number | null; free_ok: number }): string =>
  w.free_ok ? (w.budget ? `¥${w.budget} 以内，免费赠送` : '免费赠送') : w.budget ? `¥${w.budget} 以内` : '预算不限';

// ---- 心愿生命周期 ----

export function createWish(db: DatabaseSync, actor: Actor, content: string, budget: number | null, freeOk: boolean): number {
  return tx(db, () => {
    const n = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wishes WHERE user_id = ? AND ${fresh()}`, [actor.id])!.n;
    if (n >= WISH_LIMIT) throw new AppError(409, 'WISH_LIMIT', `同时进行中的心愿最多 ${WISH_LIMIT} 个，请先关闭或等待旧心愿过期`);
    const r = db
      .prepare('INSERT INTO wishes (user_id, content, budget, free_ok) VALUES (?, ?, ?, ?)')
      .run(actor.id, content, budget, freeOk ? 1 : 0);
    return Number(r.lastInsertRowid);
  });
}

function ownWish(db: DatabaseSync, actor: Actor, wishId: number): WishRow {
  const w = one<WishRow>(db, 'SELECT * FROM wishes WHERE id = ?', [wishId]);
  if (!w) throw notFound('心愿');
  if (w.user_id !== actor.id) throw forbidden('只有心愿发布者可以操作');
  return w;
}

export function closeWish(db: DatabaseSync, actor: Actor, wishId: number): void {
  tx(db, () => {
    const w = ownWish(db, actor, wishId);
    if (w.status !== 'active') throw new AppError(409, 'INVALID_STATE', '只有进行中的心愿可以关闭');
    db.prepare("UPDATE wishes SET status = 'closed' WHERE id = ?").run(wishId);
  });
}

export function renewWish(db: DatabaseSync, actor: Actor, wishId: number): void {
  tx(db, () => {
    const w = ownWish(db, actor, wishId);
    if (w.status !== 'active') throw new AppError(409, 'INVALID_STATE', '只有进行中的心愿可以续期');
    if (wishState(w) !== 'expired') throw new AppError(409, 'NOT_EXPIRED', '心愿还没有过期，不需要续期');
    db.prepare(`UPDATE wishes SET renewed_at = ${NOW} WHERE id = ?`).run(wishId);
  });
}

export function fulfillWish(db: DatabaseSync, actor: Actor, wishId: number): void {
  tx(db, () => {
    const w = ownWish(db, actor, wishId);
    if (w.status !== 'active') throw new AppError(409, 'INVALID_STATE', '该心愿已经结束');
    db.prepare(`UPDATE wishes SET status = 'fulfilled', fulfilled_at = ${NOW} WHERE id = ?`).run(wishId);
  });
}

// ---- 列表 ----

interface MatchRow {
  match_id: number;
  wish_id: number;
  item_id: number;
  reason: string;
  origin: string;
  seen_at: string | null;
  invited_at: string | null;
  item_title: string;
  item_status: string;
  item_price: number;
  item_trade_type: string;
  cover: string | null;
  seller_name: string;
  invited_by: string | null;
  budget: number | null;
}

const MATCH_SELECT = `
  SELECT m.id AS match_id, m.wish_id, m.item_id, m.reason, m.origin, m.seen_at, m.invited_at,
         i.title AS item_title, i.status AS item_status, i.price AS item_price, i.trade_type AS item_trade_type,
         (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover,
         u.name AS seller_name, w.budget,
         CASE WHEN m.invited_at IS NOT NULL THEN u.name END AS invited_by
  FROM wish_matches m
  JOIN items i ON i.id = m.item_id
  JOIN users u ON u.id = i.seller_id
  JOIN wishes w ON w.id = m.wish_id`;

export function listWishes(db: DatabaseSync, viewer: Actor, tab: 'all' | 'mine') {
  if (tab === 'all') {
    const rows = all<WishRow & { owner_name: string; owner_department: string | null; match_count: number }>(
      db,
      `SELECT w.*, u.name AS owner_name, u.department AS owner_department,
              (SELECT COUNT(*) FROM wish_matches m WHERE m.wish_id = w.id) AS match_count
       FROM wishes w JOIN users u ON u.id = w.user_id
       WHERE ${fresh('w.')} ORDER BY w.created_at DESC, w.id DESC LIMIT 100`,
    );
    return {
      stats: wishStats(db),
      wishes: rows.map((w) => ({
        id: w.id,
        content: w.content,
        budgetText: budgetText(w),
        ownerName: w.owner_name,
        ownerDepartment: w.owner_department,
        createdAt: w.created_at,
        matchCount: w.match_count,
        isMine: w.user_id === viewer.id,
      })),
    };
  }
  const rows = all<WishRow>(db, 'SELECT * FROM wishes WHERE user_id = ? ORDER BY created_at DESC, id DESC', [viewer.id]);
  const matches = rows.length
    ? all<MatchRow>(
        db,
        `${MATCH_SELECT} WHERE m.wish_id IN (${rows.map(() => '?').join(',')}) ORDER BY m.created_at DESC, m.id DESC`,
        rows.map((w) => w.id),
      )
    : [];
  return {
    stats: wishStats(db),
    wishes: rows.map((w) => ({
      id: w.id,
      content: w.content,
      budgetText: budgetText(w),
      state: wishState(w),
      createdAt: w.created_at,
      renewedAt: w.renewed_at,
      matches: matches
        .filter((m) => m.wish_id === w.id)
        .map((m) => ({
          matchId: m.match_id,
          itemId: m.item_id,
          item: {
            id: m.item_id,
            title: m.item_title,
            status: m.item_status,
            price: m.item_price,
            tradeType: m.item_trade_type,
            cover: m.cover ? `/api/uploads/${m.cover}` : null,
          },
          reason: m.reason,
          origin: m.origin,
          invitedBy: m.invited_by,
          budget: m.budget,
          isNew: m.seen_at === null && m.item_status === 'published',
        })),
    })),
  };
}

export function wishStats(db: DatabaseSync) {
  return {
    active: one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wishes WHERE ${fresh()}`, [])!.n,
    fulfilled: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wishes WHERE status = 'fulfilled'", [])!.n,
  };
}

/** 进入「我的心愿」即视为已读：未读匹配清零（已被选走/下架的不计入未读，也不标记）。 */
export function markWishesSeen(db: DatabaseSync, actor: Actor): void {
  db.prepare(
    `UPDATE wish_matches SET seen_at = ${NOW}
     WHERE seen_at IS NULL AND wish_id IN (SELECT id FROM wishes WHERE user_id = ?)`,
  ).run(actor.id);
}

/** /api/me 的心愿墙红点：未读的新匹配数（商品仍在售才算）。 */
export function wishUpdates(db: DatabaseSync, userId: number): number {
  return one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM wish_matches m
     JOIN wishes w ON w.id = m.wish_id JOIN items i ON i.id = m.item_id
     WHERE w.user_id = ? AND m.seen_at IS NULL AND i.status = 'published'`,
    [userId],
  )!.n;
}

// ---- 匹配 ----

type ChatFn = (cfg: AiConfig, opts: ChatOptions) => Promise<string | null>;

interface MatchAiResult {
  matches?: { id?: number; level?: string; reason?: string }[];
}

function insertMatches(db: DatabaseSync, pairs: { wishId: number; itemId: number; reason: string; origin: 'ai' | 'direct' }[]): number {
  const ins = db.prepare('INSERT OR IGNORE INTO wish_matches (wish_id, item_id, reason, origin) VALUES (?, ?, ?, ?)');
  let n = 0;
  for (const p of pairs) {
    if (Number(ins.run(p.wishId, p.itemId, p.reason, p.origin).changes) > 0) n++;
  }
  return n;
}

/** 货找人：新商品对全部进行中心愿。只保留 strong；id 必须在送入集合内（防幻觉）。AI 调用在事务外。 */
export async function matchItemToWishes(db: DatabaseSync, itemId: number, chatFn: ChatFn = chat): Promise<void> {
  const item = one<{ id: number; seller_id: number; title: string; category: string; price: number; trade_type: string; condition: string; description: string }>(
    db,
    `SELECT i.id, i.seller_id, i.title, c.name AS category, i.price, i.trade_type, i.condition, substr(i.description,1,80) AS description
     FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?`,
    [itemId],
  );
  if (!item) return;
  const wishes = all<WishRow>(
    db,
    `SELECT w.* FROM wishes w WHERE w.user_id != ? AND ${fresh('w.')} ORDER BY w.created_at DESC, w.id DESC LIMIT 100`,
    [item.seller_id],
  );

  let pairs: { wishId: number; itemId: number; reason: string }[] = [];
  if (wishes.length > 0 && aiConfig()) {
    const list = wishes.map((w) => `${w.id}|${w.content}|${budgetText(w)}`).join('\n');
    const system = loadPrompt('wish-match-goods');
    const raw = system
      ? await chatFn(aiConfig()!, {
          system,
      user: `新商品：${item.title}|${item.category}|${item.trade_type === 'free' ? '免费' : `¥${item.price}`}|${item.condition}|${item.description}\n\n进行中的心愿（id|内容|预算）：\n${list}`,
        maxTokens: 512,
        })
      : null;
    const parsed = extractJson<MatchAiResult>(raw);
    const valid = new Set(wishes.map((w) => w.id));
    pairs = (parsed?.matches ?? [])
      .filter((m): m is { id: number; level?: string; reason?: string } => typeof m.id === 'number' && valid.has(m.id) && m.level === 'strong')
      .map((m) => ({ wishId: m.id, itemId, reason: (m.reason ?? '').slice(0, 20) || '小星匹配' }));
  }

  tx(db, () => {
    insertMatches(db, pairs.map((p) => ({ ...p, origin: 'ai' as const })));
    // 无论有没有匹配、AI 是否可用，都记录匹配完成时间，前端据此结束「匹配中」。
    db.prepare(`UPDATE items SET wish_matched_at = ${NOW} WHERE id = ? AND wish_matched_at IS NULL`).run(itemId);
  });
}

/** 人找货：新心愿对全部在售商品，最多保留 5 个 strong。AI 调用在事务外。 */
export async function matchWishToItems(db: DatabaseSync, wishId: number, chatFn: ChatFn = chat): Promise<void> {
  const wish = one<WishRow>(db, 'SELECT * FROM wishes WHERE id = ?', [wishId]);
  if (!wish || wishState(wish) !== 'active') return;
  const items = all<{ id: number; title: string; category: string; price: number; trade_type: string; description: string }>(
    db,
    `SELECT i.id, i.title, c.name AS category, i.price, i.trade_type, substr(i.description,1,80) AS description
     FROM items i JOIN categories c ON c.id = i.category_id
     WHERE i.status = 'published' AND i.seller_id != ? ORDER BY i.published_at DESC LIMIT 100`,
    [wish.user_id],
  );
  if (items.length === 0) return;

  let pairs: { wishId: number; itemId: number; reason: string }[] = [];
  if (aiConfig()) {
    const list = items.map((x) => `${x.id}|${x.title}|${x.category}|${x.trade_type === 'free' ? '免费' : `¥${x.price}`}|${x.description}`).join('\n');
    const system = loadPrompt('wish-match-wish');
    const raw = system
      ? await chatFn(aiConfig()!, {
          system,
      user: `心愿：${wish.content}|${budgetText(wish)}\n\n在售商品（id|标题|分类|价格|描述）：\n${list}`,
        maxTokens: 512,
        })
      : null;
    const parsed = extractJson<MatchAiResult>(raw);
    const valid = new Set(items.map((x) => x.id));
    pairs = (parsed?.matches ?? [])
      .filter((m): m is { id: number; level?: string; reason?: string } => typeof m.id === 'number' && valid.has(m.id) && m.level === 'strong')
      .slice(0, 5)
      .map((m) => ({ wishId, itemId: m.id, reason: (m.reason ?? '').slice(0, 20) || '小星匹配' }));
  }

  tx(db, () => {
    insertMatches(db, pairs.map((p) => ({ ...p, origin: 'ai' as const })));
  });
}

/** 「我有这个」：不经 AI 直接建立匹配。 */
export function createDirectMatch(db: DatabaseSync, wishId: number, itemId: number): void {
  insertMatches(db, [{ wishId, itemId, reason: '同事响应心愿直接发布', origin: 'direct' }]);
}

// ---- 异步触发：发布后不等待 AI；进程内队列 + 读详情时的惰性补触发（覆盖进程重启丢队列的情况） ----

const running = new Set<string>();

function enqueue(key: string, run: () => Promise<void>): void {
  if (running.has(key)) return;
  running.add(key);
  setTimeout(() => {
    running.delete(key);
    run().catch((e) => console.warn('[wish] 后台匹配失败', e));
  }, 0);
}

export function queueItemMatch(db: DatabaseSync, itemId: number, chatFn: ChatFn = chat): void {
  enqueue(`item:${itemId}`, () => matchItemToWishes(db, itemId, chatFn));
}

export function queueWishMatch(db: DatabaseSync, wishId: number, chatFn: ChatFn = chat): void {
  enqueue(`wish:${wishId}`, () => matchWishToItems(db, wishId, chatFn));
}

/** 详情接口调用：商品还在匹配中且 AI 可用时补触发一次（重启后队列丢失的兜底）。 */
export function maybeRetryItemMatch(db: DatabaseSync, item: { id: number; status: string; wish_matched_at: string | null; published_at: string }): void {
  if (item.status !== 'published' || item.wish_matched_at !== null) return;
  if (!aiConfig()) return;
  if (Date.now() - new Date(item.published_at).getTime() > 24 * 3600_000) return;
  queueItemMatch(db, item.id);
}

// ---- 卖家详情页的心愿匹配面板 ----

export function wishMatchesForItem(db: DatabaseSync, itemId: number) {
  const rows = all<{
    match_id: number;
    wish_id: number;
    reason: string;
    origin: string;
    invited_at: string | null;
    content: string;
    budget: number | null;
    free_ok: number;
    owner_name: string;
    owner_department: string | null;
  }>(
    db,
    `SELECT m.id AS match_id, m.wish_id, m.reason, m.origin, m.invited_at,
            w.content, w.budget, w.free_ok, u.name AS owner_name, u.department AS owner_department
     FROM wish_matches m JOIN wishes w ON w.id = m.wish_id JOIN users u ON u.id = w.user_id
     WHERE m.item_id = ? AND ${fresh('w.')}
     ORDER BY m.created_at DESC, m.id DESC`,
    [itemId],
  );
  return rows.map((r) => ({
    matchId: r.match_id,
    wishId: r.wish_id,
    userName: r.owner_name,
    userDepartment: r.owner_department,
    content: r.content,
    budgetText: budgetText(r),
    reason: r.reason,
    invited: r.invited_at !== null,
  }));
}

/** 邀请 TA 来看看：仅商品卖家、商品在售、每条匹配只能一次。 */
export function inviteWisher(db: DatabaseSync, actor: Actor, matchId: number): void {
  tx(db, () => {
    const m = one<{ id: number; item_id: number; invited_at: string | null }>(db, 'SELECT id, item_id, invited_at FROM wish_matches WHERE id = ?', [matchId]);
    if (!m) throw notFound('匹配记录');
    const item = one<{ seller_id: number; status: string }>(db, 'SELECT seller_id, status FROM items WHERE id = ?', [m.item_id]);
    if (!item) throw notFound('商品');
    if (item.seller_id !== actor.id) throw forbidden('只有商品发布者可以邀请');
    if (item.status !== 'published') throw new AppError(409, 'INVALID_STATE', '商品不在发布中，不能邀请');
    const r = db.prepare(`UPDATE wish_matches SET invited_at = ${NOW} WHERE id = ? AND invited_at IS NULL`).run(matchId);
    if (Number(r.changes) !== 1) throw new AppError(409, 'ALREADY_INVITED', '已经邀请过这位同事了');
  });
}

/** 买家确认收货后：这件商品是否命中 TA 的进行中心愿，用于弹「心愿已实现吗」。 */
export function fulfilledPrompt(db: DatabaseSync, buyerId: number, itemId: number): { wishId: number; content: string } | null {
  return (
    one<{ wishId: number; content: string }>(
      db,
      `SELECT w.id AS wishId, w.content FROM wish_matches m JOIN wishes w ON w.id = m.wish_id
       WHERE m.item_id = ? AND w.user_id = ? AND w.status = 'active' ORDER BY m.created_at DESC LIMIT 1`,
      [itemId, buyerId],
    ) ?? null
  );
}
