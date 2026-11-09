import type { DatabaseSync } from 'node:sqlite';
import { all, one } from '../db/query.ts';

/**
 * 闲置英雄榜（F20）。纯 SQL 聚合：不需要 AI、不需要埋点、不新增表。
 * 数据源：deal_requests.status='completed' 即交易记录（buyer_id 买家 / items.seller_id 卖家）。
 * 口径：
 * - 永远剔除演示账号（部门='演示账号'）参与的交易（买卖任一方是演示账号即不计），与 F5 看板口径一致。
 * - 成交价 = MIN(COALESCE(agreed_price, 挂牌价), 挂牌价)（F9：小星谈成价；卖家降价时按新挂牌价）。
 * - 节省 = max(0, original_price − 成交价)；免费件节省 = 原价；无 original_price 的交易不计节省，不影响件数。
 * - 名次用 RANK() 语义：并列同名次，下一名跳号。
 */

export const SEASON_START = '2026-11-04'; // 北京时间，比赛口径

export type LeaderboardWindow = 'all' | 'month' | 'season';

const WINDOW_SQL: Record<LeaderboardWindow, string> = {
  all: '1=1',
  month: "strftime('%Y-%m', dr.completed_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours')",
  season: "date(dr.completed_at, '+8 hours') >= '" + SEASON_START + "'",
};

/** 剔除演示账号 + 时间窗口内的完成交易（含双方用户信息）。 */
const TX_CTE = (w: LeaderboardWindow) => `
  SELECT i.seller_id, dr.buyer_id, MIN(COALESCE(dr.agreed_price, i.price), i.price) AS price, i.trade_type, i.original_price
  FROM deal_requests dr
  JOIN items i ON i.id = dr.item_id
  JOIN users su ON su.id = i.seller_id
  JOIN users bu ON bu.id = dr.buyer_id
  WHERE dr.status = 'completed'
    AND COALESCE(su.department, '') != '演示账号'
    AND COALESCE(bu.department, '') != '演示账号'
    AND ${WINDOW_SQL[w]}`;

export interface BoardRow {
  rank: number;
  userId: number;
  name: string;
  department: string;
  count: number;
  amount: number;
  freeCount: number;
  saved: number;
  badge: string | null;
}

export interface DeptRow {
  rank: number;
  department: string;
  count: number;
  amount: number;
  saved: number;
}

// 徽章：完成件数达到门槛解锁，展示最高档。
const BADGES: { min: number; label: string }[] = [
  { min: 20, label: '闲置星球传奇' },
  { min: 10, label: '清仓达人' },
  { min: 5, label: '断舍离能手' },
  { min: 1, label: '初次出手' },
];
const BUY_BADGES: { min: number; label: string }[] = [
  { min: 20, label: '薅羊毛大师' },
  { min: 10, label: '省钱高手' },
  { min: 5, label: '淘货能手' },
  { min: 1, label: '捡漏新手' },
];

const badgeFor = (kind: 'sell' | 'buy', count: number): string | null =>
  (kind === 'sell' ? BADGES : BUY_BADGES).find((b) => count >= b.min)?.label ?? null;

// 节省额：无 original_price 贡献 0；免费件（price=0 且有原价）节省 = 原价。
// 引用 CTE（tx/sides）输出列，不带表前缀。
const SAVED_EXPR = `SUM(CASE WHEN original_price IS NULL THEN 0
  ELSE MAX(0, original_price - COALESCE(price, 0)) END)`;

function sellerBoard(db: DatabaseSync, w: LeaderboardWindow): BoardRow[] {
  return all<{ rank: number; userId: number; name: string; department: string | null; count: number; amount: number; freeCount: number; saved: number }>(
    db,
    `WITH tx AS (${TX_CTE(w)})
     SELECT RANK() OVER (ORDER BY COUNT(*) DESC, ${SAVED_EXPR} DESC) AS rank,
            su.id AS userId, su.name, su.department, COUNT(*) AS count,
            COALESCE(SUM(tx.price), 0) AS amount,
            COALESCE(SUM(CASE WHEN tx.trade_type = 'free' THEN 1 ELSE 0 END), 0) AS freeCount,
            COALESCE(${SAVED_EXPR}, 0) AS saved
     FROM tx JOIN users su ON su.id = tx.seller_id
     GROUP BY su.id ORDER BY rank LIMIT 50`,
  ).map((r) => ({ ...r, department: r.department ?? '未填写部门', badge: badgeFor('sell', r.count) }));
}

function buyerBoard(db: DatabaseSync, w: LeaderboardWindow): BoardRow[] {
  return all<{ rank: number; userId: number; name: string; department: string | null; count: number; saved: number }>(
    db,
    `WITH tx AS (${TX_CTE(w)})
     SELECT RANK() OVER (ORDER BY COUNT(*) DESC, ${SAVED_EXPR} DESC) AS rank,
            bu.id AS userId, bu.name, bu.department, COUNT(*) AS count,
            COALESCE(${SAVED_EXPR}, 0) AS saved
     FROM tx JOIN users bu ON bu.id = tx.buyer_id
     GROUP BY bu.id ORDER BY rank LIMIT 50`,
  ).map((r) => ({ ...r, department: r.department ?? '未填写部门', amount: 0, freeCount: 0, badge: badgeFor('buy', r.count) }));
}

function deptBoard(db: DatabaseSync, w: LeaderboardWindow): DeptRow[] {
  return all<{ rank: number; department: string; count: number; amount: number; saved: number }>(
    db,
    `WITH tx AS (${TX_CTE(w)}),
     sides AS (
       SELECT seller_id AS uid, price, trade_type, original_price FROM tx
       UNION ALL
       SELECT buyer_id AS uid, price, trade_type, original_price FROM tx
     )
     SELECT RANK() OVER (ORDER BY COUNT(*) DESC, COALESCE(${SAVED_EXPR}, 0) DESC) AS rank,
            COALESCE(u.department, '未填写部门') AS department,
            COUNT(*) AS count,
            COALESCE(SUM(sides.price), 0) AS amount,
            COALESCE(${SAVED_EXPR}, 0) AS saved
     FROM sides JOIN users u ON u.id = sides.uid
     GROUP BY COALESCE(u.department, '未填写部门')
     ORDER BY rank LIMIT 50`,
  );
}

function myRank(db: DatabaseSync, w: LeaderboardWindow, userId: number) {
  const tx = TX_CTE(w);
  const sell = one<{ rank: number; count: number }>(
    db,
    `WITH tx AS (${tx}), agg AS (
       SELECT seller_id, COUNT(*) AS count, RANK() OVER (ORDER BY COUNT(*) DESC) AS rank
       FROM tx GROUP BY seller_id
     ) SELECT agg.rank, agg.count FROM agg WHERE seller_id = ?`,
    [userId],
  );
  const buy = one<{ rank: number; count: number }>(
    db,
    `WITH tx AS (${tx}), agg AS (
       SELECT buyer_id, COUNT(*) AS count, RANK() OVER (ORDER BY COUNT(*) DESC) AS rank
       FROM tx GROUP BY buyer_id
     ) SELECT agg.rank, agg.count FROM agg WHERE buyer_id = ?`,
    [userId],
  );
  return {
    sellerRank: sell?.rank ?? null,
    sellerCount: sell?.count ?? 0,
    buyerRank: buy?.rank ?? null,
    buyerCount: buy?.count ?? 0,
  };
}

function starOfWindow(db: DatabaseSync, w: LeaderboardWindow) {
  return (
    one<{ userId: number; name: string; department: string | null; count: number; saved: number }>(
      db,
      `WITH tx AS (${TX_CTE(w)}),
       sides AS (
         SELECT seller_id AS uid, original_price, price FROM tx
         UNION ALL
         SELECT buyer_id AS uid, original_price, price FROM tx
       )
       SELECT u.id AS userId, u.name, u.department, COUNT(*) AS count,
              COALESCE(${SAVED_EXPR}, 0) AS saved
       FROM sides JOIN users u ON u.id = sides.uid
       GROUP BY u.id ORDER BY count DESC, saved DESC LIMIT 1`,
    ) ?? null
  );
}

export function leaderboard(db: DatabaseSync, w: LeaderboardWindow, viewerId: number) {
  return {
    window: w,
    seasonStart: SEASON_START,
    sellers: sellerBoard(db, w),
    buyers: buyerBoard(db, w),
    departments: deptBoard(db, w),
    me: myRank(db, w, viewerId),
    star: starOfWindow(db, w),
  };
}
