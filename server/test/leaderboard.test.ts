import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/index.ts';
import { acceptRequest, completeDeal, createRequest, markHandedOver } from '../src/services/deal.ts';
import { leaderboard } from '../src/services/leaderboard.ts';
import type { Actor } from '../src/services/deal.ts';
import { addUser } from './helpers.ts';

let db: DatabaseSync;

function completeTx(db: DatabaseSync, seller: Actor, buyer: Actor, opts: { price?: number; free?: boolean; originalPrice?: number | null } = {}): number {
  const price = opts.free ? 0 : (opts.price ?? 100);
  const r = db
    .prepare(
      `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, handoff_location, original_price)
       VALUES (?, ?, 1, 'x', 'good', ?, ?, '一楼', ?)`,
    )
    .run(seller.id, `商品${Date.now()}${Math.random().toString(36).slice(2, 6)}`, opts.free ? 'free' : 'fixed', price, opts.originalPrice ?? null);
  const itemId = Number(r.lastInsertRowid);
  const reqId = createRequest(db, buyer, itemId);
  acceptRequest(db, seller, reqId);
  markHandedOver(db, seller, reqId);
  completeDeal(db, buyer, reqId);
  return reqId;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('闲置英雄榜（F20）', () => {
  it('出闲置榜：件数、免费件、金额、节省、徽章', () => {
    const s = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    completeTx(db, s, b1, { price: 100, originalPrice: 500 }); // 省 400
    completeTx(db, s, b2, { price: 80 }); // 无原价不计节省
    completeTx(db, s, b1, { free: true, originalPrice: 60 }); // 免费件，省 60

    const lb = leaderboard(db, 'all', b1.id);
    const top = lb.sellers.find((x) => x.userId === s.id)!;
    assert.equal(top.count, 3);
    assert.equal(top.freeCount, 1);
    assert.equal(top.amount, 180);
    assert.equal(top.saved, 460);
    assert.equal(top.rank, 1);
    assert.equal(top.badge, '初次出手');
  });

  it('演示账号永不入榜：任一方是演示账号的交易整笔不计', () => {
    const demo = addUser(db, 'D1');
    db.prepare("UPDATE users SET department='演示账号' WHERE id=?").run(demo.id);
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    const demoSeller = addUser(db, 'D2');
    db.prepare("UPDATE users SET department='演示账号' WHERE id=?").run(demoSeller.id);

    completeTx(db, s, b); // 真实交易 ✓
    completeTx(db, demo, b); // 演示卖家 ✗
    completeTx(db, s, demo); // 演示买家 ✗
    completeTx(db, demoSeller, demo); // 双演示 ✗

    const lb = leaderboard(db, 'all', b.id);
    assert.equal(lb.sellers.length, 1);
    assert.equal(lb.sellers[0]!.count, 1);
    assert.equal(lb.buyers.length, 1);
    assert.equal(lb.buyers[0]!.count, 1);
    assert.ok(!JSON.stringify(lb).includes('员工D1'));
    assert.ok(!JSON.stringify(lb).includes('员工D2'));
  });

  it('时间窗口：赛季起点前完成的不计入 season', () => {
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    const old = completeTx(db, s, b);
    const now = completeTx(db, s, b);
    // 赛季口径从北京时间 2026-11-04 起：第一笔挪到 10 月
    db.prepare("UPDATE deal_requests SET completed_at = '2026-10-01T04:00:00.000Z' WHERE id = ?").run(old);
    db.prepare("UPDATE deal_requests SET completed_at = '2026-11-05T04:00:00.000Z' WHERE id = ?").run(now);

    assert.equal(leaderboard(db, 'all', b.id).sellers[0]!.count, 2);
    assert.equal(leaderboard(db, 'season', b.id).sellers[0]!.count, 1);
    assert.equal(leaderboard(db, 'month', b.id).sellers[0]!.count, 1); // 当月=11月，旧的 10 月不计
  });

  it('并列同名次、下一名跳号', () => {
    const s1 = addUser(db, 'S1');
    const s2 = addUser(db, 'S2');
    const s3 = addUser(db, 'S3');
    const b = addUser(db, 'B1');
    completeTx(db, s1, b);
    completeTx(db, s1, b);
    completeTx(db, s2, b);
    completeTx(db, s2, b);
    completeTx(db, s3, b);

    const lb = leaderboard(db, 'all', b.id);
    assert.deepEqual(lb.sellers.map((x) => x.rank), [1, 1, 3]);
  });

  it('部门榜：未填写部门聚合，买卖各计本部门一次', () => {
    const s = addUser(db, 'S1'); // 未填写部门
    const b = addUser(db, 'B1');
    db.prepare("UPDATE users SET department='研发部' WHERE id=?").run(b.id);
    completeTx(db, s, b, { price: 50 });

    const lb = leaderboard(db, 'all', b.id);
    const dept = lb.departments;
    assert.equal(dept.find((d) => d.department === '研发部')!.count, 1); // 买侧
    assert.equal(dept.find((d) => d.department === '未填写部门')!.count, 1); // 卖侧
    assert.equal(dept.find((d) => d.department === '研发部')!.amount, 50);
  });

  it('我的排名与本周之星；响应不含 contact 与单笔明细', () => {
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    db.prepare("UPDATE users SET contact='secret-contact-x' WHERE id=?").run(b.id);
    completeTx(db, s, b, { price: 30, originalPrice: 100 });
    completeTx(db, s, b2, { price: 20 }); // 卖家共 3 件（买卖合并），b、b2 各 2
    completeTx(db, s, b2, { price: 10 });

    const lb = leaderboard(db, 'all', b.id);
    assert.equal(lb.me.sellerRank, null);
    assert.equal(lb.me.buyerRank, 2); // b2 买 2 件第 1，b 买 1 件第 2
    assert.equal(lb.me.buyerCount, 1);
    assert.equal(lb.star!.userId, s.id); // 卖家买卖合并 3+3=6 件最多
    assert.ok(!JSON.stringify(lb).includes('secret-contact-x'));
    assert.ok(!JSON.stringify(lb).includes('transactions'));
  });

  it('口径守恒：出榜件数总和 = 剔除演示账号后的完成交易数', () => {
    const demo = addUser(db, 'D1');
    db.prepare("UPDATE users SET department='演示账号' WHERE id=?").run(demo.id);
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    completeTx(db, s, b);
    completeTx(db, s, b);
    completeTx(db, demo, b);

    const lb = leaderboard(db, 'all', b.id);
    const total = lb.sellers.reduce((n, x) => n + x.count, 0);
    const direct = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM deal_requests dr
           JOIN items i ON i.id = dr.item_id
           JOIN users su ON su.id = i.seller_id JOIN users bu ON bu.id = dr.buyer_id
           WHERE dr.status='completed' AND COALESCE(su.department,'')!='演示账号' AND COALESCE(bu.department,'')!='演示账号'`,
        )
        .get() as { n: number }
    ).n;
    assert.equal(total, direct);
    assert.equal(total, 2);
  });

  it('空状态：无完成交易时榜单为空、star 为 null', () => {
    addUser(db, 'S1');
    const lb = leaderboard(db, 'season', 1);
    assert.equal(lb.sellers.length, 0);
    assert.equal(lb.star, null);
  });
});
