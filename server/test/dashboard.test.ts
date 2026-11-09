import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/index.ts';
import { dashboard } from '../src/services/dashboard.ts';
import type { Actor } from '../src/services/deal.ts';
import { addUser } from './helpers.ts';

let db: DatabaseSync;
let seller: Actor;
let buyer: Actor;
let demoSeller: Actor;
let demoBuyer: Actor;

function addItem(seller: Actor, opts: { price?: number; originalPrice?: number | null } = {}): number {
  const r = db
    .prepare(
      `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, original_price, handoff_location)
       VALUES (?, ?, 1, 'x', 'good', 'fixed', ?, ?, 'L')`,
    )
    .run(seller.id, `i${Math.random().toString(36).slice(2, 8)}`, opts.price ?? 100, opts.originalPrice ?? null);
  return Number(r.lastInsertRowid);
}

function request(buyer: Actor, itemId: number): number {
  const r = db.prepare('INSERT INTO deal_requests (item_id, buyer_id) VALUES (?, ?)').run(itemId, buyer.id);
  return Number(r.lastInsertRowid);
}

function complete(seller: Actor, buyer: Actor, itemId: number): void {
  void seller;
  const reqId = request(buyer, itemId);
  db.prepare("UPDATE deal_requests SET status='completed', accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(reqId);
  db.prepare("UPDATE items SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(itemId);
}

beforeEach(() => {
  db = openDb(':memory:');
  seller = addUser(db, 'S1');
  buyer = addUser(db, 'B1');
  demoSeller = addUser(db, 'D1');
  demoBuyer = addUser(db, 'D2');
  db.prepare("UPDATE users SET department='演示账号' WHERE employee_no IN ('D1','D2')").run();
});

describe('F5 演示数据剔除', () => {
  it('发布/申请/完成/活跃/心愿默认剔演示，includeDemo=true 全计', () => {
    addItem(seller); // 真实发布
    addItem(demoSeller); // 演示发布
    const it1 = addItem(seller);
    const it2 = addItem(demoSeller);
    complete(seller, buyer, it1); // 真实完成
    complete(demoSeller, demoBuyer, it2); // 双演示完成
    request(buyer, addItem(seller)); // 真实申请
    request(demoBuyer, addItem(seller)); // 演示买家申请
    db.prepare("INSERT INTO user_daily_activity (user_id, day) VALUES (?, date('now','+8 hours'))").run(demoSeller.id);
    db.prepare("INSERT INTO user_daily_activity (user_id, day) VALUES (?, date('now','+8 hours'))").run(buyer.id);
    db.prepare("INSERT INTO wishes (user_id, content) VALUES (?, 'w')").run(demoSeller.id);

    const clean = dashboard(db, { from: '2000-01-01' });
    assert.equal(clean.published, 4); // 演示卖家 1 件不计
    assert.equal(clean.completed, 1);
    assert.equal(clean.requests, 2); // 演示买家的申请不计
    assert.equal(clean.activeUsers, 1); // 演示活跃不计
    assert.equal(clean.wishes.active, 0);

    const all = dashboard(db, { from: '2000-01-01' }, true);
    assert.equal(all.published, 6);
    assert.equal(all.completed, 2);
    assert.equal(all.requests, 4);
    assert.equal(all.activeUsers, 2);
    assert.equal(all.wishes.active, 1);
  });
});

describe('F4 为同事节省', () => {
  it('口径：原价-成交价，免费件=原价，无原价不计；覆盖率正确', () => {
    complete(seller, buyer, addItem(seller, { price: 149, originalPrice: 599 })); // 省 450
    complete(seller, buyer, addItem(seller, { price: 0, originalPrice: 88 })); // 免费省 88 —— price 0 但 trade_type fixed？addItem 固定 fixed
    const d = dashboard(db, { from: '2000-01-01' });
    // addItem trade_type 固定为 fixed，price=0 的件按 fixed 价 0 计：省 = 599 类似逻辑 88-0=88
    assert.equal(d.saved, 450 + 88);
    assert.equal(d.savedCoverage.covered, 2);
    assert.equal(d.savedCoverage.total, 2);

    complete(seller, buyer, addItem(seller, { price: 200 })); // 无原价
    const d2 = dashboard(db, { from: '2000-01-01' });
    assert.equal(d2.saved, 538);
    assert.equal(d2.savedCoverage.covered, 2);
    assert.equal(d2.savedCoverage.total, 3);
  });

  it('差值为负按 0 计', () => {
    complete(seller, buyer, addItem(seller, { price: 300, originalPrice: 100 }));
    assert.equal(dashboard(db, { from: '2000-01-01' }).saved, 0);
  });
});
