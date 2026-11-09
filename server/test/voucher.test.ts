import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import type { Env } from '../src/types.ts';
import { acceptRequest, completeDeal, createRequest, markHandedOver } from '../src/services/deal.ts';
import { startNegotiation } from '../src/services/negotiation.ts';
import { createItems, getItemDetail, listItems } from '../src/services/items.ts';
import { dashboard } from '../src/services/dashboard.ts';
import { addItem, addUser } from './helpers.ts';

// 本文件独立进程：设置假 key 让 aiConfig() 非空，代谈入口校验能走到券类拦截（AI 调用不会真的发生）。
process.env.AI_API_KEY = 'test-key';

let db: DatabaseSync;
let app: Hono<Env>;
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-voucher-'));
  db = openDb(':memory:');
  app = createApp(db, { uploadDir: join(dir, 'uploads'), cookieSecure: false });
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function call(method: string, path: string, opts: { cookie?: string; json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  const res = await app.request(path, { method, headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) });
  const text = await res.clone().text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function loginAs(employeeNo: string): Promise<{ cookie: string; id: number }> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeNo }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, id: body.user.id as number };
}

const seller = { no: 'V1' };
const buyerA = { no: 'V2' };
const buyerB = { no: 'V3' };
let sellerCookie = '';
let buyerACookie = '';
let buyerBCookie = '';
let sellerId = 0;
let buyerAId = 0;
let buyerBId = 0;

/** 券类发布体：无图、有效期 10 天后、默认线上转赠。 */
const voucherBody = (over: Record<string, unknown> = {}) => ({
  title: '京东洗鞋券（任洗 2 件）',
  categoryId: 1,
  description: '',
  condition: 'good',
  tradeType: 'fixed',
  price: 25,
  originalPrice: 40,
  handoffLocation: '',
  imageIds: [],
  kind: 'voucher',
  handoffMode: 'online',
  expiresOn: new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10),
  quantity: 1,
  ...over,
});

before(async () => {
  addUser(db, seller.no);
  addUser(db, buyerA.no);
  addUser(db, buyerB.no);
  const s = await loginAs(seller.no);
  const a = await loginAs(buyerA.no);
  const b = await loginAs(buyerB.no);
  sellerCookie = s.cookie;
  buyerACookie = a.cookie;
  buyerBCookie = b.cookie;
  sellerId = s.id;
  buyerAId = a.id;
  buyerBId = b.id;
});

describe('F16 券类发布校验', () => {
  it('券类无图可发布；实物无图仍拒绝；kind 非法值拒绝；过期日期拒绝', async () => {
    const ok = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody() });
    assert.equal(ok.status, 201);
    assert.equal(typeof ok.body.id, 'number');
    assert.deepEqual(ok.body.ids, [ok.body.id]);

    const goodsNoImg = await call('POST', '/api/items', {
      cookie: sellerCookie,
      json: { title: '实物', categoryId: 1, description: '', condition: 'good', tradeType: 'fixed', price: 100, handoffLocation: '前台', imageIds: [] },
    });
    assert.equal(goodsNoImg.status, 400);
    assert.ok(JSON.stringify(goodsNoImg.body).includes('请至少上传一张图片'));

    const badKind = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ kind: 'card' }) });
    assert.equal(badKind.status, 400);

    const pastExp = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ expiresOn: '2026-01-01' }) });
    assert.equal(pastExp.status, 400);
    assert.ok(JSON.stringify(pastExp.body).includes('有效期不能早于今天'));

    const badQty = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ quantity: 11 }) });
    assert.equal(badQty.status, 400);
  });

  it('券类分类固定为「券·权益」（客户端传其他分类也会被纠正）、成色库存 new', async () => {
    const r = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ categoryId: 1 }) });
    assert.equal(r.status, 201);
    const d = await call('GET', `/api/items/${r.body.id}`, { cookie: buyerACookie });
    assert.equal(d.body.categoryName, '券·权益');
    assert.equal(d.body.condition, 'new');
    assert.equal(d.body.kind, 'voucher');
    assert.equal(d.body.handoffMode, 'online');
    assert.equal(d.body.handoffLocation, ''); // 线上转赠库存空串
    assert.equal(d.body.expiresOn, voucherBody().expiresOn);
    // 券类买家视图不开代谈
    assert.equal(d.body.negotiation.enabled, false);
  });
});

describe('F16 数量拆分与集市折叠', () => {
  it('数量 4 拆 4 件共用 listing_group，集市折叠成一条「剩 4 张」，分页按展示单元计', async () => {
    const r = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ quantity: 4 }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.ids.length, 4);
    const ids: number[] = r.body.ids;
    const groups = (db.prepare('SELECT DISTINCT listing_group FROM items WHERE id IN (?, ?, ?, ?)').all(...ids) as { listing_group: string }[]).map((x) => x.listing_group);
    assert.equal(groups.length, 1);
    assert.ok(groups[0]);

    const list = await call('GET', '/api/items', { cookie: buyerACookie });
    // 同组只算一个展示单元：全列表里属于该组的卡片只有一张
    const cards = list.body.items.filter((x: any) => x.listingGroup === groups[0]);
    assert.equal(cards.length, 1);
    const card = cards[0];
    assert.equal(card.groupRemaining, 4);
    assert.equal(card.id, Math.min(...ids)); // 代表是组内第一件 published
    assert.equal(list.body.total, list.body.items.length); // 分页 total 与展示单元数一致（折叠后）

    // 每件独立申请选定：买家 A 选第 1 件，不影响其他 3 件
    const reqA = await call('POST', `/api/items/${ids[0]}/requests`, { cookie: buyerACookie, json: {} });
    assert.equal(reqA.status, 201);
    const sellerActor = { id: sellerId, role: 'employee' as const };
    acceptRequest(db, sellerActor, reqA.body.id); // 第 1 件进入 locked
    const after1 = await call('GET', '/api/items', { cookie: buyerACookie });
    assert.equal(after1.body.items.filter((x: any) => x.listingGroup === groups[0]).length, 1);
    assert.equal(after1.body.items.find((x: any) => x.listingGroup === groups[0]).groupRemaining, 3); // 成交（选定）1 张后剩 3 张

    // 拆分后每件独立选人：买家 B 申请第 2 件并选定，第 1 件的 locked 不阻塞
    const reqB = await call('POST', `/api/items/${ids[1]}/requests`, { cookie: buyerBCookie, json: {} });
    assert.equal(reqB.status, 201);
    acceptRequest(db, sellerActor, reqB.body.id);
    assert.equal((db.prepare('SELECT status FROM items WHERE id = ?').get(ids[1]) as { status: string }).status, 'locked');
    assert.equal((db.prepare('SELECT status FROM items WHERE id = ?').get(ids[0]) as { status: string }).status, 'locked');

    // 第 2 件也被选定后完成第 1 件：组内 published = 2，折叠卡显示剩 2 张（每件独立走流程）
    markHandedOver(db, sellerActor, reqA.body.id);
    completeDeal(db, { id: buyerAId, role: 'employee' }, reqA.body.id);
    const afterDone = await call('GET', '/api/items', { cookie: buyerACookie });
    assert.equal(afterDone.body.items.find((x: any) => x.listingGroup === groups[0]).groupRemaining, 2);
    assert.equal(afterDone.body.items.find((x: any) => x.listingGroup === groups[0]).id, Math.min(ids[2], ids[3])); // 代表切换到下一件 published

    // kind 筛选
    const onlyVoucher = await call('GET', '/api/items?kind=voucher', { cookie: buyerACookie });
    assert.ok(onlyVoucher.body.items.every((x: any) => x.kind === 'voucher'));
    const onlyGoods = await call('GET', '/api/items?kind=goods', { cookie: buyerACookie });
    assert.ok(onlyGoods.body.items.every((x: any) => x.kind === 'goods'));
  });

  it('编辑同组一件，公共字段同组一起改；详情显示共 N 张剩 M 张', async () => {
    const r = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ quantity: 3, title: '山姆副卡' }) });
    const ids: number[] = r.body.ids;
    await call('PATCH', `/api/items/${ids[0]}`, { cookie: sellerCookie, json: voucherBody({ quantity: 3, title: '山姆会员副卡', price: 30 }) });
    const titles = (db.prepare('SELECT title, price FROM items WHERE id IN (?, ?, ?) ORDER BY id').all(...ids) as { title: string; price: number }[]).map((x) => `${x.title}:${x.price}`);
    assert.deepEqual(titles, ['山姆会员副卡:30', '山姆会员副卡:30', '山姆会员副卡:30']);
    const d = await call('GET', `/api/items/${ids[0]}`, { cookie: buyerACookie });
    assert.deepEqual(d.body.group, { total: 3, remaining: 3 });
  });
});

describe('F16 过期清理', () => {
  it('过期在售券下架+pending 关闭(item_expired)；locked 不动；今天到期不下架', async () => {
    const yesterday = new Date(Date.now() + 8 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

    // 过期且有人申请（pending）
    const exp = await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ expiresOn: today, quantity: 1 }) });
    const expId = exp.body.id as number;
    const req = await call('POST', `/api/items/${expId}/requests`, { cookie: buyerACookie, json: {} });
    assert.equal(req.status, 201);
    db.prepare('UPDATE items SET expires_on = ? WHERE id = ?').run(yesterday, expId); // 直接管库模拟时间流逝

    // 今天到期的券不下架
    const todayId = (await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ expiresOn: today }) })).body.id as number;

    // 过期但已被选定（locked）
    const lockedId = (
      await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ expiresOn: today, price: 30, title: '过期锁定券' }) })
    ).body.id as number;
    const reqL = await call('POST', `/api/items/${lockedId}/requests`, { cookie: buyerBCookie, json: {} });
    acceptRequest(db, { id: sellerId, role: 'employee' }, reqL.body.id);
    db.prepare('UPDATE items SET expires_on = ? WHERE id = ?').run(yesterday, lockedId);

    const list = await call('GET', '/api/items', { cookie: buyerACookie }); // 列表查询触发 expireVouchers
    const listedIds = list.body.items.map((x: any) => x.id);
    assert.ok(!listedIds.includes(expId)); // 过期在售券从集市消失

    assert.equal((db.prepare('SELECT status, withdraw_reason FROM items WHERE id = ?').get(expId) as { status: string; withdraw_reason: string }).withdraw_reason, 'expired');
    assert.equal((db.prepare('SELECT status FROM items WHERE id = ?').get(expId) as { status: string }).status, 'withdrawn');
    assert.equal((db.prepare('SELECT status, close_reason FROM deal_requests WHERE id = ?').get(req.body.id) as { status: string; close_reason: string }).close_reason, 'item_expired');
    assert.equal((db.prepare('SELECT status FROM deal_requests WHERE id = ?').get(req.body.id) as { status: string }).status, 'closed');
    // locked 不自动处理，且仍在列表（locked 在列表状态集合内）
    assert.equal((db.prepare('SELECT status FROM items WHERE id = ?').get(lockedId) as { status: string }).status, 'locked');
    assert.equal((db.prepare('SELECT status FROM deal_requests WHERE id = ?').get(reqL.body.id) as { status: string }).status, 'accepted');
    assert.ok(listedIds.includes(lockedId));
    // 今天到期不下架
    assert.equal((db.prepare('SELECT status FROM items WHERE id = ?').get(todayId) as { status: string }).status, 'published');
    assert.ok(listedIds.includes(todayId));
  });

  it('券类买家视图开代谈被拒（409 NEGOTIATION_UNAVAILABLE）', async () => {
    const vid = (await call('POST', '/api/items', { cookie: sellerCookie, json: voucherBody({ tradeType: 'fixed' }) })).body.id as number;
    // 服务端强制券类关闭代谈（即使请求带了底价）
    assert.equal((db.prepare('SELECT negotiation_floor FROM items WHERE id = ?').get(vid) as { negotiation_floor: number | null }).negotiation_floor, null);
    assert.throws(
      () => startNegotiation(db, { id: buyerAId, role: 'employee' }, vid, 20),
      (e: unknown) => (e as { code?: string }).code === 'NEGOTIATION_UNAVAILABLE',
    );
  });
});

describe('F16 看板拆分口径', () => {
  it('发布/完成/流转金额按实物与券拆分；券节省=面值−成交价；过期未出件数', () => {
    const d = dashboard(db, { from: '2000-01-01' });
    assert.ok(d.split.published.voucher >= 1);
    assert.ok(d.split.completed.voucher >= 1); // 上面完成了 1 张洗鞋券
    assert.ok(d.split.completed.goods >= 0);
    assert.ok(d.split.flow.voucher.amount >= 25); // 25 元洗鞋券成交
    // 券节省按面值：40 − 25 = 15 已计入 saved
    assert.ok(d.saved >= 15);
    assert.ok(d.split.expiredVouchers >= 1); // 过期清理用例下架了 1 件
  });

  it('券完成交易的节省与流转按成交价（服务层直连验证面值口径）', () => {
    const sellerA = addUser(db, 'VK1');
    const buyerV = addUser(db, 'VK2');
    const ids = createItems(db, sellerA, {
      title: '京东卡', categoryId: 7, description: '', condition: 'new', tradeType: 'fixed', price: 450, originalPrice: 500,
      handoffLocation: '', imageIds: [], kind: 'voucher', handoffMode: 'online', expiresOn: null, quantity: 1,
    });
    const rid = createRequest(db, buyerV, ids[0]);
    acceptRequest(db, sellerA, rid);
    markHandedOver(db, sellerA, rid);
    completeDeal(db, buyerV, rid);
    const d = dashboard(db, { from: '2000-01-01' });
    assert.equal(d.split.completed.voucher, 2);
    assert.equal(d.split.flow.voucher.amount, 475); // 25 + 450
    // 节省：洗鞋券 40-25=15，京东卡 500-450=50（其他用例的实物无参考价不计）
    assert.ok(d.saved >= 65);
  });
});

describe('F16 服务层与列表排序', () => {
  it('过期排序：有有效期的券按有效期近到远排在前，无有效期的排后', () => {
    const s = addUser(db, 'VS1');
    const soon = createItems(db, s, {
      title: '快到期', categoryId: 7, description: '', condition: 'new', tradeType: 'fixed', price: 1,
      handoffLocation: '', imageIds: [], kind: 'voucher', handoffMode: 'online', expiresOn: '2026-11-08', quantity: 1,
    });
    const later = createItems(db, s, {
      title: '晚到期', categoryId: 7, description: '', condition: 'new', tradeType: 'fixed', price: 1,
      handoffLocation: '', imageIds: [], kind: 'voucher', handoffMode: 'online', expiresOn: '2026-12-31', quantity: 1,
    });
    const forever = createItems(db, s, {
      title: '长期券', categoryId: 7, description: '', condition: 'new', tradeType: 'fixed', price: 1,
      handoffLocation: '', imageIds: [], kind: 'voucher', handoffMode: 'online', expiresOn: null, quantity: 1,
    });
    const goods = addItem(db, s); // 实物，无有效期
    const rows = listItems(db, { sort: 'expiring', limit: 50, offset: 0 }).items;
    const pos = (id: number) => rows.findIndex((x) => x.id === id);
    assert.ok(pos(soon[0]) >= 0 && pos(later[0]) >= 0);
    assert.ok(pos(soon[0]) < pos(later[0]), '有效期近的在前');
    assert.ok(pos(later[0]) < pos(forever[0]), '无有效期的券排在有有效期的后面');
    // 即将过期排序只对券类生效：实物与无有效期券一起按发布时间排在后面
    const goodsCard = rows.find((x) => x.id === goods);
    assert.ok(goodsCard, '实物仍在列表中');
    const goodsOnly = listItems(db, { sort: 'latest', limit: 50, offset: 0 });
    assert.ok(goodsOnly.items.some((x) => x.id === goods && x.kind === 'goods'));
  });
});
