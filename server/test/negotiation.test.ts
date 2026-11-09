import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { itemInputSchema } from '../../shared/schemas.ts';
import { AppError } from '../src/errors.ts';
import type { AiConfig, ChatOptions } from '../src/services/ai.ts';
import {
  negotiationEntry,
  negotiationView,
  negotiatedDeal,
  queueNegotiation,
  runNegotiation,
  startNegotiation,
  type NegoView,
} from '../src/services/negotiation.ts';
import { acceptRequest, completeDeal, createRequest, markHandedOver } from '../src/services/deal.ts';
import { createItem, getItemDetail, listMyRequests, updateItem } from '../src/services/items.ts';
import { dashboard } from '../src/services/dashboard.ts';
import { leaderboard } from '../src/services/leaderboard.ts';
import { addItem, addUser, memDb } from './helpers.ts';

// 测试文件独立进程：设置假 key 让 aiConfig() 非空，AI 调用全部走 mock。
process.env.AI_API_KEY = 'test-key';

/** 按脚本逐次返回 mock 回复，并记录每次收到的调用。 */
function mockScript(script: (string | null)[], calls: ChatOptions[] = []) {
  let i = 0;
  return async (_cfg: AiConfig, opts: ChatOptions): Promise<string | null> => {
    calls.push(opts);
    const reply = script[i++];
    return reply === undefined ? null : reply;
  };
}

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code, `expected AppError ${code}`);
}

/** 加一件开启代谈的一口价商品。 */
function addNegoItem(db: DatabaseSync, seller: { id: number }, price: number, floor: number): number {
  const r = db
    .prepare(
      `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, original_price, negotiation_floor, handoff_location)
       VALUES (?, ?, 1, '九成新显示器，无坏点', 'like_new', 'fixed', ?, 300, ?, '一楼大厅')`,
    )
    .run(seller.id, '九成新显示器 铝合金支架', price, floor);
  return Number(r.lastInsertRowid);
}

/** 插入一张未被引用的图（编辑商品时 attachImages 需要真实图片行）。 */
function addImage(db: DatabaseSync, uploaderId: number): number {
  const r = db.prepare('INSERT INTO item_images (item_id, uploader_id, path) VALUES (NULL, ?, ?)').run(uploaderId, `img-${Math.random().toString(36).slice(2)}.jpg`);
  return Number(r.lastInsertRowid);
}

function negoRow(db: DatabaseSync, id: number): { status: string; agreed_price: number | null; turns_json: string } {
  return db.prepare('SELECT status, agreed_price, turns_json FROM negotiations WHERE id = ?').get(id) as never;
}

const turnsOf = (v: NegoView) => v.turns.map((t) => ({ role: t.role, offer: t.offer, accept: t.accept }));

/** 底价保护断言辅助：去掉时间戳，避免毫秒位撞上底价数字。 */
const stripTs = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('代谈入口', () => {
  it('正常发起：写入 running 与底价/挂牌价快照', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 170, '下周搬家急用');
    const n = db.prepare('SELECT * FROM negotiations WHERE id = ?').get(id) as never as Record<string, unknown>;
    assert.equal(n.status, 'running');
    assert.equal(n.list_price_snapshot, 200);
    assert.equal(n.floor_snapshot, 150);
    assert.equal(n.buyer_max, 170);
    assert.equal(n.buyer_note, '下周搬家急用');
    assert.deepEqual(turnsOf(negotiationView(db, buyer, id)), []); // 开场发言在编排时写入
  });

  it('入口条件各 409', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const other = addUser(db, 'O1');
    const item = addNegoItem(db, seller, 200, 150);
    assertCode(() => startNegotiation(db, seller, item, 170), 'NEGOTIATION_UNAVAILABLE'); // 卖家本人

    const free = addItem(db, seller, '免费赠送的东西'); // trade_type=free，无底价
    assertCode(() => startNegotiation(db, buyer, free, 1), 'NEGOTIATION_UNAVAILABLE');

    const noFloor = db
      .prepare(`INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, handoff_location)
                VALUES (?, '没开代谈', 1, 'x', 'good', 'fixed', 100, 'x')`)
      .run(seller.id);
    assertCode(() => startNegotiation(db, buyer, Number(noFloor.lastInsertRowid), 50), 'NEGOTIATION_UNAVAILABLE');

    db.prepare("UPDATE items SET status = 'locked' WHERE id = ?").run(item);
    assertCode(() => startNegotiation(db, buyer, item, 170), 'NEGOTIATION_UNAVAILABLE');
    db.prepare("UPDATE items SET status = 'published' WHERE id = ?").run(item);

    assertCode(() => startNegotiation(db, buyer, item, 200), 'NEGOTIATION_UNAVAILABLE'); // 心理价 ≥ 挂牌价
    assertCode(() => startNegotiation(db, buyer, item, 0), 'NEGOTIATION_UNAVAILABLE'); // 心理价 < 1

    const r = createRequest(db, other, item);
    assertCode(() => startNegotiation(db, other, item, 170), 'NEGOTIATION_UNAVAILABLE'); // 已有 pending 申请
    acceptRequest(db, seller, r);
    assertCode(() => startNegotiation(db, other, item, 170), 'NEGOTIATION_UNAVAILABLE'); // accepted
    db.prepare("UPDATE deal_requests SET status = 'rejected' WHERE id = ?").run(r);
    assertCode(() => startNegotiation(db, other, item, 170), 'NEGOTIATION_UNAVAILABLE'); // 被拒过
    // withdrawn 不拦代谈
    db.prepare("UPDATE deal_requests SET status = 'withdrawn' WHERE id = ?").run(r);
    db.prepare("UPDATE items SET status = 'published' WHERE id = ?").run(item); // 选人曾把商品置为 locked
    assert.doesNotThrow(() => startNegotiation(db, other, item, 170));
  });

  it('同一买家同一商品最多 2 次，第 3 次 NEGOTIATION_LIMIT；他人不受影响', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const buyer2 = addUser(db, 'B2');
    const item = addNegoItem(db, seller, 200, 150);
    startNegotiation(db, buyer, item, 170);
    startNegotiation(db, buyer, item, 160);
    assertCode(() => startNegotiation(db, buyer, item, 150), 'NEGOTIATION_LIMIT');
    assert.doesNotThrow(() => startNegotiation(db, buyer2, item, 170));
    assert.equal(negotiationEntry(db, item, buyer.id).remaining, 0);
    assert.equal(negotiationEntry(db, item, buyer2.id).remaining, 1);
  });

  it('AI 未启用：503 AI_DISABLED', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    delete process.env.AI_API_KEY;
    try {
      assertCode(() => startNegotiation(db, buyer, item, 170), 'AI_DISABLED');
    } finally {
      process.env.AI_API_KEY = 'test-key';
    }
  });
});

describe('谈判编排（mock chat）', () => {
  it('卖方出价截断到底价与上次出价之间，买方截断到心理价；6 次未成 no_deal', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150); // floor=150, max=170
    const id = startNegotiation(db, buyer, item, 170);
    const mock = mockScript([
      JSON.stringify({ say: '我先出个价', offer: 50, accept: false }), // 首轮下限 1：保留
      JSON.stringify({ say: '太低了', offer: 120, accept: false }), // 低于底价 → 150
      JSON.stringify({ say: '加点', offer: 130, accept: false }),
      JSON.stringify({ say: '最低这个价', offer: 100, accept: false }), // 又低于底价 → 150
      JSON.stringify({ say: '再等等', offer: 140, accept: false }),
      JSON.stringify({ say: '不能再让', offer: 999, accept: false }), // 高于卖方上次出价 → 截回 150
    ]);
    await runNegotiation(db, id, mock);
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'no_deal');
    assert.equal(v.agreedPrice, null);
    assert.deepEqual(turnsOf(v), [
      { role: 'seller', offer: 200, accept: false }, // 开场 = 挂牌价（服务端模板，不调 AI）
      { role: 'buyer', offer: 50, accept: false },
      { role: 'seller', offer: 150, accept: false },
      { role: 'buyer', offer: 130, accept: false },
      { role: 'seller', offer: 150, accept: false },
      { role: 'buyer', offer: 140, accept: false },
      { role: 'seller', offer: 150, accept: false },
    ]);
  });

  it('卖方 accept 按买方上次出价成交，成交价必然落在 [底价, 心理价]', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 146); // floor=146
    const id = startNegotiation(db, buyer, item, 170);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '便宜点嘛', offer: 130, accept: false }),
      JSON.stringify({ say: '最低这个数', offer: 165, accept: false }),
      JSON.stringify({ say: '再加一点', offer: 150, accept: false }),
      JSON.stringify({ say: '成交', offer: 150, accept: true }), // 卖方接受 150 ∈ [146,170]
    ]));
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'deal');
    assert.equal(v.agreedPrice, 150);
    assert.ok(v.agreedPrice! >= 146 && v.agreedPrice! <= 170);
    assert.ok(v.turns.at(-1)!.accept);
  });

  it('买方出价越过卖方上次出价：按卖方价自动成交', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 170);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '诚心要', offer: 165, accept: false }),
      JSON.stringify({ say: '最低这个数了', offer: 165, accept: false }),
      JSON.stringify({ say: '行，就这个价', offer: 180, accept: false }), // 截断到 170，170 ≥ 165 → 按 165 成交
    ]));
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'deal');
    assert.equal(v.agreedPrice, 165); // 卖方上一次出价
    assert.equal(v.turns.filter((t) => t.role === 'buyer').length, 2);
    assert.ok(v.turns.at(-1)!.accept);
  });

  it('买方 accept 卖方出价：成交价截断到心理价，绝不高于心理价', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 170);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '行吧', offer: 170, accept: true }), // 接受开场 200 → 截断到心理价 170
    ]));
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'deal');
    assert.equal(v.agreedPrice, 170);
  });

  it('底价高于心理价时区间无交集：任何 accept 都按 no_deal 结束', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 180); // floor=180 > max=160
    const id = startNegotiation(db, buyer, item, 160);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '想少点', offer: 150, accept: false }),
      JSON.stringify({ say: '不能少', offer: 185, accept: true }), // 底价 180 > 心理价 160，不可能成交
    ]));
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'no_deal');
    assert.equal(v.agreedPrice, null);
  });

  it('6 次发言仍未成交 → no_deal；每方最多 3 次 AI 调用', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 160);
    const calls: ChatOptions[] = [];
    const script = [
      { say: '第一轮', offer: 150 }, { say: '不让', offer: 155 },
      { say: '第二轮', offer: 152 }, { say: '还是不让', offer: 154 },
      { say: '第三轮', offer: 153 }, { say: '真的不让', offer: 154 },
    ].map((m) => JSON.stringify(m));
    await runNegotiation(db, id, mockScript(script, calls));
    const v = negotiationView(db, buyer, id);
    assert.equal(v.status, 'no_deal');
    assert.equal(v.agreedPrice, null);
    assert.equal(calls.length, 6);
    assert.equal(v.turns.length, 7); // 开场 + 6
    assert.equal(v.turns.filter((t) => t.role === 'buyer').length, 3);
    assert.equal(v.turns.filter((t) => t.role === 'seller' && t.offer !== 200).length, 3);
  });

  it('AI 失败或输出不合法 → ai_failed', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    const b3 = addUser(db, 'B3');
    const item = addNegoItem(db, seller, 200, 150);
    const id1 = startNegotiation(db, b1, item, 170);
    await runNegotiation(db, id1, mockScript([null])); // 调用失败
    assert.equal(negoRow(db, id1).status, 'ai_failed');

    const id2 = startNegotiation(db, b2, item, 160);
    await runNegotiation(db, id2, mockScript(['我不是 JSON'])); // 解析失败
    assert.equal(negoRow(db, id2).status, 'ai_failed');

    const id3 = startNegotiation(db, b3, item, 160);
    await runNegotiation(db, id3, mockScript([JSON.stringify({ say: '话术', accept: false })])); // 缺 offer
    assert.equal(negoRow(db, id3).status, 'ai_failed');
    assert.equal(negotiationView(db, b3, id3).turns.length, 1); // 只剩开场
  });

  it('say 含数字或为空 → 整句替换为该角色模板句（价格不出现在文本里）', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 170);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '150 元可以吗', offer: 130, accept: false }), // 含数字
      JSON.stringify({ say: '最低 148', offer: 158, accept: false }), // 含数字
      JSON.stringify({ say: '   ', offer: 132, accept: false }), // 空
      JSON.stringify({ say: '真的不能再低了', offer: 162, accept: false }), // 正常保留
    ]));
    const v = negotiationView(db, buyer, id);
    assert.ok(!/\d/.test(v.turns.map((t) => t.say).join('')));
    assert.ok(v.turns.at(-1)!.say === '真的不能再低了');
  });

  it('异步队列：发起后后台完成谈判', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 170);
    queueNegotiation(db, id, mockScript([
      JSON.stringify({ say: '想少点', offer: 160, accept: false }),
      JSON.stringify({ say: '可以', offer: 160, accept: true }), // 卖方接受 160 ∈ [150,170]
    ]));
    await wait(30);
    assert.equal(negoRow(db, id).status, 'deal');
    assert.equal(negoRow(db, id).agreed_price, 160);
  });
});

/** 走完一次「谈成 ¥155」的谈判。脚本第 3 轮买方出价触及卖方价 → 自动成交。 */
async function dealAt155(db: DatabaseSync, itemId: number, negoId: number): Promise<void> {
  await runNegotiation(db, negoId, mockScript([
    JSON.stringify({ say: '想便宜点', offer: 150, accept: false }),
    JSON.stringify({ say: '最低这个数', offer: 155, accept: false }),
    JSON.stringify({ say: '行', offer: 155, accept: false }), // 155 ≥ 155 → 按卖方价 155 成交
  ]));
}

describe('结果与 24 小时有效期', () => {
  it('谈成后按代谈价提交申请：写入 agreed_price/negotiation_id/source=negotiation，谈判变 used', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 146);
    const id = startNegotiation(db, buyer, item, 170);
    await dealAt155(db, item, id);
    assert.equal(negotiatedDeal(db, buyer, item, id), 155);
    const reqId = createRequest(db, buyer, item, '小星代谈达成 ¥155', { agreedPrice: 155, negotiationId: id, source: 'negotiation' });
    const row = db.prepare('SELECT * FROM deal_requests WHERE id = ?').get(reqId) as never as Record<string, unknown>;
    assert.equal(row.agreed_price, 155);
    assert.equal(row.negotiation_id, id);
    assert.equal(row.source, 'negotiation');
    assert.equal(negoRow(db, id).status, 'used');
    // 谈判已使用，不能再次按代谈价提交
    assertCode(() => negotiatedDeal(db, buyer, item, id), 'NEGOTIATION_UNAVAILABLE');
    // 普通申请 source 默认 normal
    const other = addUser(db, 'B2');
    const r2 = createRequest(db, other, item);
    assert.equal((db.prepare('SELECT source FROM deal_requests WHERE id = ?').get(r2) as { source: string }).source, 'normal');
  });

  it('24 小时过期：提交 409 NEGOTIATION_EXPIRED，状态变 expired，查看也显示 expired', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 146);
    const id = startNegotiation(db, buyer, item, 170);
    await dealAt155(db, item, id);
    db.prepare("UPDATE negotiations SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours') WHERE id = ?").run(id);
    assertCode(() => negotiatedDeal(db, buyer, item, id), 'NEGOTIATION_EXPIRED');
    assert.equal(negoRow(db, id).status, 'expired');
    assert.equal(negotiationView(db, buyer, id).status, 'expired');
    // 过期后无法提交申请，卖家因此仍看不到谈判记录
    assertCode(() => negotiationView(db, seller, id), 'FORBIDDEN');
  });

  it('卖家仅在买家提交申请后可见谈判记录，且不含心理价与附言；他人 403', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const stranger = addUser(db, 'X1');
    const item = addNegoItem(db, seller, 200, 146);
    const id = startNegotiation(db, buyer, item, 170, '宿舍用的'); // 心理价 170、附言都是买家私有
    await dealAt155(db, item, id);

    assertCode(() => negotiationView(db, seller, id), 'FORBIDDEN'); // 未关联申请前卖家不可见
    assertCode(() => negotiationView(db, stranger, id), 'FORBIDDEN');
    createRequest(db, buyer, item, '小星代谈达成 ¥155', { agreedPrice: 155, negotiationId: id, source: 'negotiation' });

    const sv = negotiationView(db, seller, id);
    const sj = stripTs(JSON.stringify(sv));
    assert.ok(!sj.includes('170'), '卖家可见记录不含心理价');
    assert.ok(!sj.includes('宿舍用的'), '卖家可见记录不含附言');
    assert.ok(!('buyerMax' in sv) && !('buyerNote' in sv) && !('remaining' in sv));
    assert.equal(sv.agreedPrice, 155);
    assert.equal(sv.turns.length, 4); // 开场 + 3 轮（第 3 轮自动成交）

    const bv = negotiationView(db, buyer, id);
    assert.equal(bv.buyerMax, 170);
    assert.equal(bv.buyerNote, '宿舍用的');
    assert.equal(bv.remaining, 1);
  });
});

describe('秘密保护（原则 3）', () => {
  it('买家视图/谈判记录/申请/看板 JSON 全文不含底价数字', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const stranger = addUser(db, 'X1');
    const item = addNegoItem(db, seller, 200, 146); // 底价 146：谈判轨迹里不会出现
    const id = startNegotiation(db, buyer, item, 170);
    await runNegotiation(db, id, mockScript([
      JSON.stringify({ say: '便宜点嘛', offer: 130, accept: false }),
      JSON.stringify({ say: '最低这个数', offer: 165, accept: false }),
      JSON.stringify({ say: '再加一点', offer: 150, accept: false }),
      JSON.stringify({ say: '成交', offer: 150, accept: true }), // 成交 150 ≠ 底价
    ]));
    const reqId = createRequest(db, buyer, item, '小星代谈达成 ¥150', { agreedPrice: 150, negotiationId: id, source: 'negotiation' });
    acceptRequest(db, seller, reqId);
    markHandedOver(db, seller, reqId);
    completeDeal(db, buyer, reqId);

    // 买家商品详情
    assert.ok(!stripTs(JSON.stringify(getItemDetail(db, buyer, item))).includes('146'), '买家详情不含底价');

    // 谈判记录：卖家视角与买家视角都不含底价
    assert.ok(!stripTs(JSON.stringify(negotiationView(db, seller, id))).includes('146'));
    const bv = stripTs(JSON.stringify(negotiationView(db, buyer, id)));
    assert.ok(!bv.includes('146'));
    assert.ok(!bv.includes('floor_snapshot'));

    // 申请：卖家详情的申请人列表（不含底价字段本身；negotiationFloor 允许出现在卖家自己的表单里）+ 买家我的申请
    const sellerDetail = getItemDetail(db, seller, item) as unknown as Record<string, unknown>;
    assert.ok(!stripTs(JSON.stringify(sellerDetail.requests)).includes('146'));
    assert.ok(!JSON.stringify(sellerDetail.requests).includes('negotiationFloor'));
    const mine = listMyRequests(db, buyer);
    assert.equal(mine[0]!.dealPrice, 150);
    assert.ok(!stripTs(JSON.stringify(mine)).includes('146'));

    // 看板与第三方详情
    assert.ok(!JSON.stringify(dashboard(db, {}, true)).includes('146'));
    assert.ok(!stripTs(JSON.stringify(getItemDetail(db, stranger, item))).includes('146'));
  });

  it('底价只出现在卖家本人的编辑表单（详情）中，买家与第三方视图没有该字段', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 146);
    const sellerDetail = getItemDetail(db, seller, item);
    assert.equal((sellerDetail as unknown as { negotiationFloor: number | null }).negotiationFloor, 146);
    const buyerDetail = getItemDetail(db, buyer, item) as unknown as Record<string, unknown>;
    assert.ok(!('negotiationFloor' in buyerDetail));
    assert.ok(!stripTs(JSON.stringify(buyerDetail)).includes('146'));
    // 买家入口状态：可发起
    const nego = (getItemDetail(db, buyer, item) as unknown as { negotiation: { canStart: boolean; remaining: number; enabled: boolean } }).negotiation;
    assert.deepEqual(nego, { canStart: true, remaining: 2, enabled: true });
  });
});

describe('成交价口径、代谈设置与指标', () => {
  it('看板流转金额/节省/英雄榜按成交价计算；代谈指标卡有数；降价后按新挂牌价', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 146); // original_price=300
    const id = startNegotiation(db, buyer, item, 170);
    await dealAt155(db, item, id);
    const reqId = createRequest(db, buyer, item, '小星代谈达成 ¥155', { agreedPrice: 155, negotiationId: id, source: 'negotiation' });
    acceptRequest(db, seller, reqId);
    markHandedOver(db, seller, reqId);
    completeDeal(db, buyer, reqId);

    const d = dashboard(db, {}, true);
    assert.equal(d.flow.amount, 155); // 成交价，不是挂牌价 200
    assert.equal(d.saved, 145); // 300 − 155
    assert.ok(d.negotiation.started >= 1);
    assert.equal(d.negotiation.successRate, 1);
    assert.ok(Math.abs(d.negotiation.avgDiscount! - (1 - 155 / 200)) < 1e-9);

    const lb = leaderboard(db, 'all', seller.id);
    assert.equal(lb.sellers[0]!.amount, 155);
    assert.equal(lb.sellers[0]!.saved, 145);

    // pending 期间卖家降价低于 agreed_price：按新挂牌价
    db.prepare('UPDATE items SET price = 140 WHERE id = ?').run(item);
    assert.equal(dashboard(db, {}, true).flow.amount, 140);
    assert.equal(leaderboard(db, 'all', seller.id).sellers[0]!.amount, 140);
  });

  it('失败的谈判计入发起次数，不计入成交与让价比例', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addNegoItem(db, seller, 200, 150);
    const id = startNegotiation(db, buyer, item, 160);
    await runNegotiation(db, id, mockScript([null])); // ai_failed
    const d = dashboard(db, {}, true);
    assert.equal(d.negotiation.started, 1);
    assert.equal(d.negotiation.successRate, 0);
    assert.equal(d.negotiation.avgDiscount, null);
  });

  it('代谈设置：底价不高于挂牌价由 schema 校验；免费商品强制关闭；编辑改底价', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const base = {
      title: '测试键盘',
      categoryId: 1,
      description: '',
      condition: 'good' as const,
      tradeType: 'fixed' as const,
      price: 120,
      originalPrice: null,
      handoffLocation: '前台',
    };
    // 底价高于挂牌价 → schema 拒绝
    assert.equal(itemInputSchema.safeParse({ ...base, negotiationFloor: 130, imageIds: [1] }).success, false);
    assert.equal(itemInputSchema.safeParse({ ...base, negotiationFloor: 90, imageIds: [1] }).success, true);
    // 免费商品强制关闭
    const freeId = createItem(db, seller, { ...base, tradeType: 'free', price: 0, negotiationFloor: 90, imageIds: [addImage(db, seller.id)] });
    assert.equal(
      (db.prepare('SELECT negotiation_floor FROM items WHERE id = ?').get(freeId) as { negotiation_floor: number | null }).negotiation_floor,
      null,
    );
    // 开启、修改、关闭
    const id = createItem(db, seller, { ...base, negotiationFloor: 90, imageIds: [addImage(db, seller.id)] });
    assert.equal((db.prepare('SELECT negotiation_floor FROM items WHERE id = ?').get(id) as { negotiation_floor: number }).negotiation_floor, 90);
    updateItem(db, seller, id, { ...base, negotiationFloor: 100, imageIds: [addImage(db, seller.id)] });
    assert.equal((db.prepare('SELECT negotiation_floor FROM items WHERE id = ?').get(id) as { negotiation_floor: number }).negotiation_floor, 100);
    updateItem(db, seller, id, { ...base, negotiationFloor: null, imageIds: [addImage(db, seller.id)] });
    assert.equal((db.prepare('SELECT negotiation_floor FROM items WHERE id = ?').get(id) as { negotiation_floor: number | null }).negotiation_floor, null);
  });
});
