import type { DatabaseSync } from 'node:sqlite';
import { all, one } from '../db/query.ts';
import { wishStats } from './wish.ts';

// 日期按北京时间（UTC+8）切分，from/to 为 YYYY-MM-DD 闭区间。
const DAY = (col: string): string => `date(${col}, '+8 hours')`;
const DEFAULT_FROM = '2026-11-04';

export interface Range {
  from?: string;
  to?: string;
}

function bounds(range: Range): { from: string; to: string } {
  return { from: range.from ?? DEFAULT_FROM, to: range.to ?? '9999-12-31' };
}

/** 演示账号判定：部门 = 「演示账号」。 */
const DEMO_DEPT = '演示账号';
const sellerOk = (includeDemo: boolean) => (includeDemo ? '1=1' : `COALESCE(su.department,'')!='${DEMO_DEPT}'`);
const buyerOk = (includeDemo: boolean) => (includeDemo ? '1=1' : `COALESCE(bu.department,'')!='${DEMO_DEPT}'`);
/** 商品归属过滤：卖家非演示。返回可直接拼接的 SQL 片段（items 别名 i，需 JOIN users su）。 */
const itemJoin = (includeDemo: boolean) =>
  includeDemo ? '' : `JOIN users su ON su.id = i.seller_id AND ${sellerOk(includeDemo)}`;

/**
 * 价值看板。所有数字由 SQL 直接聚合，无人工填报。
 * includeDemo=false（默认）剔除演示账号（部门=「演示账号」）产生的全部数据：
 * 卖家或买家任一方是演示账号的商品、申请、交易不计，演示账号的活跃与心愿不计。
 */
export function dashboard(db: DatabaseSync, range: Range, includeDemo = false) {
  const { from, to } = bounds(range);
  const p = [from, to];
  const sj = itemJoin(includeDemo);

  const published = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM items i ${sj} WHERE ${DAY('i.published_at')} BETWEEN ? AND ?`,
    p,
  )!.n;

  // 申请：买卖任一方是演示账号则整笔不计
  const requests = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM deal_requests dr
     JOIN items i ON i.id = dr.item_id ${sj}
     ${includeDemo ? '' : "JOIN users bu ON bu.id = dr.buyer_id AND COALESCE(bu.department,'')!='" + DEMO_DEPT + "'"}
     WHERE ${DAY('dr.created_at')} BETWEEN ? AND ?`,
    p,
  )!.n;

  // 完成交易：买卖双方都非演示
  const completedBase = (extra = '') =>
    `FROM items i
     JOIN deal_requests dr ON dr.item_id = i.id AND dr.status = 'completed'
     ${includeDemo ? '' : "JOIN users su ON su.id = i.seller_id AND COALESCE(su.department,'')!='" + DEMO_DEPT + "'"}
     ${includeDemo ? '' : "JOIN users bu ON bu.id = dr.buyer_id AND COALESCE(bu.department,'')!='" + DEMO_DEPT + "'"}
     WHERE i.completed_at IS NOT NULL AND ${DAY('i.completed_at')} BETWEEN ? AND ? ${extra}`;

  const completed = one<{ n: number }>(db, `SELECT COUNT(*) AS n ${completedBase()}`, p)!.n;

  // 为同事节省（F4）：max(0, 原价-成交价)，免费件=原价；无原价不计节省。
  // F9 成交价口径 = MIN(COALESCE(agreed_price, 挂牌价), 挂牌价)：pending 期间卖家降价时按新挂牌价。
  const DEAL_PRICE = 'MIN(COALESCE(dr.agreed_price, i.price), i.price)';
  const savedRow = one<{ saved: number; covered: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN i.original_price IS NULL THEN 0
             ELSE MAX(0, i.original_price - ${DEAL_PRICE}) END), 0) AS saved,
            COUNT(CASE WHEN i.original_price IS NOT NULL THEN 1 END) AS covered
     ${completedBase()}`,
    p,
  )!;

  // 漏斗：requested/accepted 的 EXISTS 子查询同样剔除演示买家
  const reqExists = includeDemo
    ? 'EXISTS (SELECT 1 FROM deal_requests r WHERE r.item_id = i.id)'
    : `EXISTS (SELECT 1 FROM deal_requests r JOIN users rb ON rb.id = r.buyer_id
             WHERE r.item_id = i.id AND COALESCE(rb.department,'')!='${DEMO_DEPT}')`;
  const accExists = includeDemo
    ? 'EXISTS (SELECT 1 FROM deal_requests r WHERE r.item_id = i.id AND r.accepted_at IS NOT NULL)'
    : `EXISTS (SELECT 1 FROM deal_requests r JOIN users rb ON rb.id = r.buyer_id
             WHERE r.item_id = i.id AND r.accepted_at IS NOT NULL AND COALESCE(rb.department,'')!='${DEMO_DEPT}')`;
  const funnel = one<{ requested: number; accepted: number; completed: number }>(
    db,
    `SELECT
       COUNT(DISTINCT CASE WHEN ${reqExists} THEN i.id END) AS requested,
       COUNT(DISTINCT CASE WHEN ${accExists} THEN i.id END) AS accepted,
       COUNT(DISTINCT CASE WHEN i.status = 'completed' THEN i.id END) AS completed
     FROM items i ${sj} WHERE ${DAY('i.published_at')} BETWEEN ? AND ?`,
    p,
  )!;

  const avg = one<{ hours: number | null }>(
    db,
    `SELECT AVG((julianday(i.completed_at) - julianday(i.published_at)) * 24) AS hours
     ${completedBase()}`,
    p,
  )!.hours;

  const active = one<{ n: number }>(
    db,
    includeDemo
      ? 'SELECT COUNT(DISTINCT user_id) AS n FROM user_daily_activity WHERE day BETWEEN ? AND ?'
      : `SELECT COUNT(DISTINCT a.user_id) AS n FROM user_daily_activity a
         JOIN users u ON u.id = a.user_id AND COALESCE(u.department,'')!='${DEMO_DEPT}'
         WHERE a.day BETWEEN ? AND ?`,
    p,
  )!.n;

  const value = one<{ amount: number; free_count: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN i.trade_type = 'fixed' THEN ${DEAL_PRICE} ELSE 0 END), 0) AS amount,
            COALESCE(SUM(CASE WHEN i.trade_type = 'free' THEN 1 ELSE 0 END), 0) AS free_count
     ${completedBase()}`,
    p,
  )!;

  // F16 按类型拆分（实物 / 券·权益）：发布数、完成交易数、流转金额；券节省复用 saved 口径（original_price 即面值）。
  const byKind = (kind: 'goods' | 'voucher'): string => `AND i.kind = '${kind}'`;
  const publishedSplit = {
    goods: one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM items i ${sj} WHERE ${DAY('i.published_at')} BETWEEN ? AND ? ${byKind('goods')}`, p)!.n,
    voucher: one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM items i ${sj} WHERE ${DAY('i.published_at')} BETWEEN ? AND ? ${byKind('voucher')}`, p)!.n,
  };
  const completedSplit = {
    goods: one<{ n: number }>(db, `SELECT COUNT(*) AS n ${completedBase(byKind('goods'))}`, p)!.n,
    voucher: one<{ n: number }>(db, `SELECT COUNT(*) AS n ${completedBase(byKind('voucher'))}`, p)!.n,
  };
  const flowSplit = {
    goods: one<{ amount: number; free_count: number }>(db, `SELECT COALESCE(SUM(CASE WHEN i.trade_type = 'fixed' THEN ${DEAL_PRICE} ELSE 0 END), 0) AS amount,
            COALESCE(SUM(CASE WHEN i.trade_type = 'free' THEN 1 ELSE 0 END), 0) AS free_count ${completedBase(byKind('goods'))}`, p)!,
    voucher: one<{ amount: number; free_count: number }>(db, `SELECT COALESCE(SUM(CASE WHEN i.trade_type = 'fixed' THEN ${DEAL_PRICE} ELSE 0 END), 0) AS amount,
            COALESCE(SUM(CASE WHEN i.trade_type = 'free' THEN 1 ELSE 0 END), 0) AS free_count ${completedBase(byKind('voucher'))}`, p)!,
  };
  // 过期未出件数：因过期自动下架的券（按下架时间计入范围），体现「券到期作废」的浪费。
  const expiredVouchers = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM items i ${sj} WHERE i.kind = 'voucher' AND i.withdraw_reason = 'expired' AND ${DAY('i.updated_at')} BETWEEN ? AND ?`,
    p,
  )!.n;

  const daily = all<{ day: string; published: number; completed: number }>(
    db,
    includeDemo
      ? `SELECT day, SUM(published) AS published, SUM(completed) AS completed FROM (
           SELECT ${DAY('published_at')} AS day, 1 AS published, 0 AS completed FROM items
           UNION ALL
           SELECT ${DAY('completed_at')} AS day, 0 AS published, 1 AS completed FROM items WHERE completed_at IS NOT NULL
         ) WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`
      : `SELECT day, SUM(published) AS published, SUM(completed) AS completed FROM (
           SELECT ${DAY('i.published_at')} AS day, 1 AS published, 0 AS completed
           FROM items i ${sj}
           UNION ALL
           SELECT ${DAY('i.completed_at')} AS day, 0 AS published, 1 AS completed
           FROM items i JOIN users su2 ON su2.id = i.seller_id
           WHERE i.completed_at IS NOT NULL AND COALESCE(su2.department,'')!='${DEMO_DEPT}'
         ) WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`,
    p,
  );

  const byCategory = all<{ name: string; completed: number; published: number }>(
    db,
    `SELECT c.name,
            COUNT(CASE WHEN i.completed_at IS NOT NULL AND ${DAY('i.completed_at')} BETWEEN ? AND ? THEN 1 END) AS completed,
            COUNT(CASE WHEN ${DAY('i.published_at')} BETWEEN ? AND ? THEN 1 END) AS published
     FROM categories c LEFT JOIN items i ON i.category_id = c.id ${sj}
     GROUP BY c.id ORDER BY completed DESC, published DESC, c.sort`,
    [from, to, from, to],
  );

  // 心愿统计：剔除演示用户（includeDemo=false 时）
  const wishes = includeDemo
    ? wishStats(db)
    : {
        active: one<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM wishes w JOIN users u ON u.id = w.user_id
           WHERE COALESCE(u.department,'')!='${DEMO_DEPT}'
             AND w.status='active'
             AND (strftime('%s','now') - strftime('%s', COALESCE(w.renewed_at, w.created_at))) < 14*86400`,
        )!.n,
        fulfilled: one<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM wishes w JOIN users u ON u.id = w.user_id
           WHERE COALESCE(u.department,'')!='${DEMO_DEPT}' AND w.status='fulfilled'`,
        )!.n,
      };

  // F9 代谈指标：发起次数 / 成功率 / 平均让价比例（1 − 成交价/挂牌价）。演示过滤同申请口径（买家非演示、卖家非演示）。
  const negoFrom = `FROM negotiations n JOIN items i ON i.id = n.item_id ${sj}
    ${includeDemo ? '' : `JOIN users nb ON nb.id = n.buyer_id AND COALESCE(nb.department,'')!='${DEMO_DEPT}'`}
    WHERE ${DAY('n.created_at')} BETWEEN ? AND ?`;
  const negoStarted = one<{ n: number }>(db, `SELECT COUNT(*) AS n ${negoFrom}`, p)!.n;
  const negoDealt = one<{ n: number }>(db, `SELECT COUNT(*) AS n ${negoFrom} AND n.agreed_price IS NOT NULL`, p)!.n;
  const negoDiscount = one<{ v: number | null }>(
    db,
    `SELECT AVG(1 - n.agreed_price * 1.0 / n.list_price_snapshot) AS v ${negoFrom} AND n.agreed_price IS NOT NULL`,
    p,
  )!.v;

  const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
  return {
    range: { from, to: range.to ?? null },
    includeDemo,
    published,
    requests,
    completed,
    saved: savedRow.saved,
    savedCoverage: { covered: savedRow.covered, total: completed },
    matchRate: ratio(funnel.requested, published),
    completionRate: ratio(funnel.completed, published),
    avgCycleHours: avg,
    activeUsers: active,
    flow: { amount: value.amount, freeCount: value.free_count },
    // F16 实物 / 券·权益 拆分
    split: {
      published: publishedSplit,
      completed: completedSplit,
      flow: {
        goods: { amount: flowSplit.goods.amount, freeCount: flowSplit.goods.free_count },
        voucher: { amount: flowSplit.voucher.amount, freeCount: flowSplit.voucher.free_count },
      },
      expiredVouchers,
    },
    funnel: { published, requested: funnel.requested, accepted: funnel.accepted, completed: funnel.completed },
    wishes,
    negotiation: { started: negoStarted, successRate: ratio(negoDealt, negoStarted), avgDiscount: negoDiscount },
    daily,
    byCategory,
  };
}
