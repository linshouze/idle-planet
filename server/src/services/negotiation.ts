import type { DatabaseSync } from 'node:sqlite';
import { AppError, forbidden, notFound } from '../errors.ts';
import { NOW, tx } from '../db/index.ts';
import { all, one } from '../db/query.ts';
import { aiConfig, chat, extractJson, loadPrompt, type AiConfig, type ChatOptions } from './ai.ts';
import type { Actor } from './deal.ts';

/**
 * 小星代谈（F9）：买卖双方各有一个信息隔离的小星代理人，服务端编排整场谈判。
 *
 * 铁律（见 docs/功能全景.md 5.2 与小星设计原则 1/3）：
 * - 服务端强制截断，不信任 AI 输出：卖方出价 ∈ [底价, 卖方上次出价]，买方出价 ∈ [买方上次出价, 心理价]，
 *   因此成交价必然落在 [底价, 心理价] 内。
 * - 秘密不出服务端：底价不出现在任何接口响应里；心理价与附言只有买家本人能看；
 *   卖家在买家提交申请前看不到谈判记录，且看到的记录不含心理价与附言。
 * - 人做最后确认：谈成只是生成一个待买家确认提交的申请，不直接改交易状态。
 */

export const NEGOTIATION_TTL_HOURS = 24;
export const NEGOTIATION_LIMIT_PER_ITEM = 2;
const MAX_AI_TURNS = 6; // 卖方开场（模板）之后，双方轮流，每方最多 3 次
const TURN_TIMEOUT_MS = 8_000;
const MAX_SAY_LEN = 40;

export interface Turn {
  role: 'buyer' | 'seller';
  say: string;
  /** 本轮出价；accept=true 时为接受的成交价。 */
  offer: number;
  accept: boolean;
}

export type NegoStatus = 'running' | 'deal' | 'no_deal' | 'ai_failed' | 'used' | 'expired';

interface NegoRow {
  id: number;
  item_id: number;
  buyer_id: number;
  buyer_max: number;
  buyer_note: string | null;
  list_price_snapshot: number;
  floor_snapshot: number;
  status: NegoStatus;
  agreed_price: number | null;
  turns_json: string;
  created_at: string;
  finished_at: string | null;
}

interface ItemInfoRow {
  id: number;
  seller_id: number;
  title: string;
  category: string;
  condition: string;
  description: string;
  price: number;
  original_price: number | null;
  published_at: string;
  request_count: number;
}

type ChatFn = (cfg: AiConfig, opts: ChatOptions) => Promise<string | null>;

const expiredAt = (finishedAt: string | null): boolean =>
  finishedAt !== null && Date.now() - new Date(finishedAt).getTime() >= NEGOTIATION_TTL_HOURS * 3600_000;

// say 的兜底模板（均不含数字）。AI 的 say 含数字或为空时整句替换，防止价格从文本里漏出。
const SAY = {
  sellerOpen: '东西成色不错，价格实在，喜欢的话你出个价吧',
  buyer: '这价格超出我的预算了，你看能不能再让一点',
  seller: '这个价真的没法出手，你再考虑考虑，价格可以商量',
};

// ---- 发起 ----

/** 入口校验（5.2）。任何条件不满足抛 409。 */
export function startNegotiation(db: DatabaseSync, actor: Actor, itemId: number, buyerMax: number, note?: string): number {
  if (!aiConfig()) throw new AppError(503, 'AI_DISABLED', 'AI 能力未启用');
  const item = one<{ id: number; seller_id: number; status: string; trade_type: string; kind: string; price: number; negotiation_floor: number | null }>(
    db,
    'SELECT id, seller_id, status, trade_type, kind, price, negotiation_floor FROM items WHERE id = ?',
    [itemId],
  );
  if (!item) throw notFound('商品');
  if (item.seller_id === actor.id) throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '不能对自己发布的商品代谈');
  // 实物、一口价。F16：券类价格高度统一没有议价行为，不支持代谈。
  const isTradable = item.trade_type === 'fixed' && (item.kind ?? 'goods') !== 'voucher';
  if (!isTradable) throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '只有一口价实物商品可以代谈');
  if (item.status !== 'published') throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '商品当前不可代谈');
  if (item.negotiation_floor === null) throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '卖家没有开启小星代谈');

  const blocked = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM deal_requests WHERE item_id = ? AND buyer_id = ? AND status IN ('pending', 'accepted', 'rejected')",
    [itemId, actor.id],
  )!.n;
  if (blocked > 0) throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '你已申请过该商品，不能再发起代谈');

  const used = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM negotiations WHERE item_id = ? AND buyer_id = ?', [itemId, actor.id])!.n;
  if (used >= NEGOTIATION_LIMIT_PER_ITEM) throw new AppError(409, 'NEGOTIATION_LIMIT', '这件商品的代谈机会已用完，可以直接按原价申请');

  if (!Number.isInteger(buyerMax) || buyerMax < 1 || buyerMax >= item.price) {
    throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', buyerMax >= item.price ? '心理价不低于挂牌价，直接按原价申请即可' : '心理价需在 1 元到挂牌价之间');
  }

  const r = db
    .prepare('INSERT INTO negotiations (item_id, buyer_id, buyer_max, buyer_note, list_price_snapshot, floor_snapshot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(itemId, actor.id, buyerMax, note?.trim() ? note.trim().slice(0, 60) : null, item.price, item.negotiation_floor);
  return Number(r.lastInsertRowid);
}

// ---- 编排 ----

interface AiMove {
  say?: unknown;
  offer?: unknown;
  accept?: unknown;
}

const cleanSay = (raw: unknown, role: 'buyer' | 'seller'): string => {
  const say = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SAY_LEN) : '';
  if (!say || /\d/.test(say)) return role === 'buyer' ? SAY.buyer : SAY.seller;
  return say;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function turnInput(role: 'buyer' | 'seller', item: ItemInfoRow, buyerMax: number, note: string | null, floor: number, turns: Turn[]): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(item.published_at).getTime()) / 86_400_000));
  const transcript = turns.map((t) => `${t.role === 'buyer' ? '买家小星' : '卖家小星'}：${t.say}${t.accept ? '（接受成交）' : `（出价 ¥${t.offer}）`}`).join('\n') || '（谈判刚开始）';
  const round = role === 'buyer' ? Math.floor(turns.length / 2) + 1 : Math.ceil(turns.length / 2) + 1;
  if (role === 'buyer') {
    return [
      `商品：${item.title}｜${item.category}｜${item.condition}｜${item.description || '无描述'}`,
      `挂牌价：¥${item.price}`,
      `买家心理价（你的出价绝不能高于它）：¥${buyerMax}`,
      `买家附言：${note || '（无）'}`,
      `谈判记录：\n${transcript}`,
      `请给出买家小星的第 ${round} 轮回应，只输出 JSON。`,
    ].join('\n');
  }
  return [
    `商品：${item.title}｜${item.category}｜${item.condition}｜${item.description || '无描述'}`,
    `挂牌价：¥${item.price}`,
    `全新参考价：${item.original_price ? `¥${item.original_price}` : '未知'}`,
    `已发布：${days} 天｜当前申请人数：${item.request_count}`,
    `卖家底价（你的出价绝不能低于它，也绝不能说出口）：¥${floor}`,
    `谈判记录：\n${transcript}`,
    `请给出卖家小星的第 ${round} 轮回应，只输出 JSON。`,
  ].join('\n');
}

/** 谈判主循环。异步执行，结束后落库；任何 AI 失败记 ai_failed，不抛出。 */
export async function runNegotiation(db: DatabaseSync, negoId: number, chatFn: ChatFn = chat): Promise<void> {
  const nego = one<NegoRow>(db, 'SELECT * FROM negotiations WHERE id = ?', [negoId]);
  if (!nego || nego.status !== 'running') return;
  const item = one<ItemInfoRow>(
    db,
    `SELECT i.id, i.seller_id, i.title, c.name AS category, i.condition, i.description, i.price, i.original_price, i.published_at,
            (SELECT COUNT(*) FROM deal_requests r WHERE r.item_id = i.id AND r.status IN ('pending', 'accepted')) AS request_count
     FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?`,
    [nego.item_id],
  );
  if (!item) {
    finish(db, negoId, 'no_deal', []);
    return;
  }

  const floor = nego.floor_snapshot;
  const buyerMax = nego.buyer_max;
  const canDeal = floor <= buyerMax; // 区间无交集时不可能成交，accept 也按 no_deal 处理

  const turns: Turn[] = [{ role: 'seller', say: SAY.sellerOpen, offer: nego.list_price_snapshot, accept: false }];
  let sellerLast = nego.list_price_snapshot;
  let buyerLast: number | null = null;
  let outcome: { status: 'deal' | 'no_deal' | 'ai_failed'; agreedPrice: number | null } | null = null;

  for (let i = 0; i < MAX_AI_TURNS && !outcome; i++) {
    const role: 'buyer' | 'seller' = i % 2 === 0 ? 'buyer' : 'seller';
    const system = loadPrompt(role === 'buyer' ? 'negotiation-buyer' : 'negotiation-seller');
    const raw = system
      ? await chatFn(aiConfig()!, {
          system,
          user: turnInput(role, item, buyerMax, nego.buyer_note, floor, turns),
          maxTokens: 256,
          timeoutMs: TURN_TIMEOUT_MS,
        })
      : null;
    const move = extractJson<AiMove>(raw);
    const rawOffer = typeof move?.offer === 'number' && Number.isFinite(move.offer) ? Math.round(move.offer) : null;
    if (!move || rawOffer === null) {
      outcome = { status: 'ai_failed', agreedPrice: null }; // 单次超时/失败/输出不合法：整体判 ai_failed
      break;
    }
    const say = cleanSay(move.say, role);
    const accept = move.accept === true;

    if (role === 'buyer') {
      if (accept) {
        if (!canDeal) {
          outcome = { status: 'no_deal', agreedPrice: null };
        } else {
          const price = clamp(sellerLast, floor, buyerMax);
          turns.push({ role, say, offer: price, accept: true });
          outcome = { status: 'deal', agreedPrice: price };
        }
        break;
      }
      const offer = clamp(rawOffer, buyerLast ?? 1, buyerMax);
      buyerLast = offer;
      // 买方出价达到卖方上一次出价：按卖方价自动成交
      if (offer >= sellerLast && canDeal) {
        turns.push({ role, say, offer: sellerLast, accept: true });
        outcome = { status: 'deal', agreedPrice: sellerLast };
        break;
      }
      turns.push({ role, say, offer, accept: false });
    } else {
      if (accept) {
        if (!canDeal || buyerLast === null) {
          outcome = { status: 'no_deal', agreedPrice: null };
        } else {
          const price = clamp(buyerLast, floor, buyerMax);
          turns.push({ role, say, offer: price, accept: true });
          outcome = { status: 'deal', agreedPrice: price };
        }
        break;
      }
      const offer = clamp(rawOffer, floor, sellerLast);
      sellerLast = offer;
      turns.push({ role, say, offer, accept: false });
    }
  }

  if (!outcome) outcome = { status: 'no_deal', agreedPrice: null }; // 6 次发言仍未成交
  finish(db, negoId, outcome.status, turns, outcome.agreedPrice);
}

function finish(db: DatabaseSync, negoId: number, status: 'deal' | 'no_deal' | 'ai_failed', turns: Turn[], agreedPrice: number | null = null): void {
  tx(db, () => {
    db.prepare(`UPDATE negotiations SET status = ?, agreed_price = ?, turns_json = ?, finished_at = ${NOW} WHERE id = ? AND status = 'running'`).run(
      status,
      agreedPrice,
      JSON.stringify(turns),
      negoId,
    );
  });
}

// ---- 异步触发（进程内队列，同 wish.ts 模式）：发起接口立即返回，前端轮询进度 ----

const running = new Set<string>();

export function queueNegotiation(db: DatabaseSync, negoId: number, chatFn: ChatFn = chat): void {
  const key = `nego:${negoId}`;
  if (running.has(key)) return;
  running.add(key);
  setTimeout(() => {
    running.delete(key);
    runNegotiation(db, negoId, chatFn).catch((e) => {
      console.warn('[negotiation] 后台谈判失败', e);
      try {
        finish(db, negoId, 'ai_failed', []);
      } catch {
        /* 落库失败时保持 running，前端轮询超时后可见提示 */
      }
    });
  }, 0);
}

// ---- 查看 ----

export interface NegoView {
  id: number;
  itemId: number;
  status: NegoStatus;
  agreedPrice: number | null;
  listPrice: number;
  turns: Turn[];
  /** 仅买家本人可见。 */
  buyerMax?: number;
  buyerNote?: string | null;
  /** 仅买家本人可见：剩余可发起次数。 */
  remaining?: number;
}

/**
 * 谈判详情。买家本人可见心理价与附言；卖家仅在买家提交申请后可见，且不含心理价与附言；其他人 403。
 * deal 结果 24 小时过期，查看时惰性落库为 expired。
 */
export function negotiationView(db: DatabaseSync, actor: Actor, negoId: number): NegoView {
  const n = one<NegoRow>(db, 'SELECT * FROM negotiations WHERE id = ?', [negoId]);
  if (!n) throw notFound('代谈');
  const item = one<{ seller_id: number }>(db, 'SELECT seller_id FROM items WHERE id = ?', [n.item_id]);
  if (!item) throw notFound('商品');
  const isBuyer = n.buyer_id === actor.id;
  const isSeller = item.seller_id === actor.id;
  if (!isBuyer && !isSeller) throw forbidden('只能查看自己参与的代谈');

  let status = n.status;
  if (status === 'deal' && expiredAt(n.finished_at)) {
    tx(db, () => db.prepare("UPDATE negotiations SET status = 'expired' WHERE id = ? AND status = 'deal'").run(negoId));
    status = 'expired';
  }

  const base: NegoView = {
    id: n.id,
    itemId: n.item_id,
    status,
    agreedPrice: n.agreed_price,
    listPrice: n.list_price_snapshot,
    turns: JSON.parse(n.turns_json) as Turn[],
  };

  if (isSeller) {
    const linked = one<{ id: number }>(db, 'SELECT id FROM deal_requests WHERE negotiation_id = ? LIMIT 1', [negoId]);
    if (!linked) throw forbidden('买家提交申请后，卖家才能查看谈判记录');
    return base; // 不含 buyerMax / buyerNote / remaining
  }

  const remaining = Math.max(0, NEGOTIATION_LIMIT_PER_ITEM - one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM negotiations WHERE item_id = ? AND buyer_id = ?', [n.item_id, n.buyer_id])!.n);
  return { ...base, buyerMax: n.buyer_max, buyerNote: n.buyer_note, remaining };
}

/**
 * 买家按代谈价提交申请前的校验：谈判已成、未过期、属于本人和该商品。
 * 返回成交价；申请与「标记已使用」在 createRequest 的同一事务里落库。
 */
export function negotiatedDeal(db: DatabaseSync, actor: Actor, itemId: number, negoId: number): number {
  const n = one<NegoRow>(db, 'SELECT * FROM negotiations WHERE id = ?', [negoId]);
  if (!n) throw notFound('代谈');
  if (n.buyer_id !== actor.id) throw forbidden('只有发起代谈的买家可以按代谈价提交申请');
  if (n.item_id !== itemId) throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '代谈与商品不匹配');
  if (n.status === 'deal' && expiredAt(n.finished_at)) {
    tx(db, () => db.prepare("UPDATE negotiations SET status = 'expired' WHERE id = ? AND status = 'deal'").run(negoId));
    throw new AppError(409, 'NEGOTIATION_EXPIRED', '小星谈成的价格已过期（24 小时内有效），请重新发起代谈');
  }
  if (n.status !== 'deal') throw new AppError(409, 'NEGOTIATION_UNAVAILABLE', '小星还没有谈成，不能按代谈价提交申请');
  return n.agreed_price!;
}

/** 详情页买家视图的代谈入口状态。 */
export function negotiationEntry(db: DatabaseSync, itemId: number, buyerId: number): { canStart: boolean; remaining: number } {
  const remaining = Math.max(0, NEGOTIATION_LIMIT_PER_ITEM - one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM negotiations WHERE item_id = ? AND buyer_id = ?', [itemId, buyerId])!.n);
  const blocked = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM deal_requests WHERE item_id = ? AND buyer_id = ? AND status IN ('pending', 'accepted', 'rejected')",
    [itemId, buyerId],
  )!.n;
  return { canStart: remaining > 0 && blocked === 0, remaining };
}

/** 走查用：某商品某买家的全部代谈（测试与排查）。 */
export function listNegotiations(db: DatabaseSync, itemId: number, buyerId: number): NegoRow[] {
  return all<NegoRow>(db, 'SELECT * FROM negotiations WHERE item_id = ? AND buyer_id = ? ORDER BY id', [itemId, buyerId]);
}
