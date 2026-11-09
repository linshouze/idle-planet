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
import { addUser } from './helpers.ts';

const PNG: Uint8Array<ArrayBuffer> = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

let db: DatabaseSync;
let app: Hono<Env>;
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-api-'));
  db = openDb(':memory:');
  app = createApp(db, { uploadDir: join(dir, 'uploads'), cookieSecure: false });
  addUser(db, 'A1', { role: 'admin', contact: null });
  addUser(db, 'S1', { contact: null }); // 卖家，稍后补联系方式
  addUser(db, 'B1');
  addUser(db, 'B2');
});
after(() => rmSync(dir, { recursive: true, force: true }));

interface Res {
  status: number;
  body: any;
  res: Response;
}

async function call(method: string, path: string, opts: { cookie?: string; json?: unknown; form?: FormData } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.clone().text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body: parsed, res };
}

async function loginAs(employeeNo: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', { json: { employeeNo } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.res.headers.get('set-cookie')!.split(';')[0]!;
}

async function upload(cookie: string, bytes: Uint8Array<ArrayBuffer> = PNG, name = 'a.png'): Promise<Res> {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type: 'image/png' }));
  return call('POST', '/api/uploads', { cookie, form });
}

const itemBody = (imageIds: number[], over: Record<string, unknown> = {}) => ({
  title: '戴尔显示器',
  categoryId: 1,
  description: '用了两年，功能正常',
  condition: 'good',
  tradeType: 'fixed',
  price: 300,
  handoffLocation: '一楼大厅',
  imageIds,
  ...over,
});

describe('登录与权限', () => {
  it('未登录访问接口返回 401', async () => {
    assert.equal((await call('GET', '/api/items')).status, 401);
    assert.equal((await call('GET', '/api/items/1')).status, 401);
    assert.equal((await call('GET', '/api/uploads/' + 'a'.repeat(32) + '.png')).status, 401);
  });

  it('白名单外或已停用的工号登录失败，错误信息一致', async () => {
    const unknown1 = await call('POST', '/api/auth/login', { json: { employeeNo: 'NOPE' } });
    const unknown2 = await call('POST', '/api/auth/login', { json: { employeeNo: 'X999' } });
    assert.equal(unknown1.status, 401);
    assert.equal(unknown2.status, 401);
    assert.equal(unknown1.body.error.message, unknown2.body.error.message);
  });

  it('被停用的账号：已有会话立即失效，也不能再登录', async () => {
    const cookie = await loginAs('B2');
    assert.equal((await call('GET', '/api/me', { cookie })).status, 200);
    const admin = await loginAs('A1');
    const users = (await call('GET', '/api/admin/users', { cookie: admin })).body.users as any[];
    const b2 = users.find((u) => u.employeeNo === 'B2');
    assert.equal((await call('PATCH', `/api/admin/users/${b2.id}`, { cookie: admin, json: { status: 'disabled' } })).status, 200);
    assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { json: { employeeNo: 'B2', name: '员工B2' } })).status, 401);
    await call('PATCH', `/api/admin/users/${b2.id}`, { cookie: admin, json: { status: 'active' } });
  });

  it('普通员工访问管理接口返回 403', async () => {
    const cookie = await loginAs('B1');
    assert.equal((await call('GET', '/api/admin/dashboard', { cookie })).status, 403);
    assert.equal((await call('POST', '/api/admin/users/import', { cookie, json: { csv: '' } })).status, 403);
  });
});

describe('发布', () => {
  it('没有联系方式不能发布，补填后可以', async () => {
    const cookie = await loginAs('S1');
    const img = await upload(cookie);
    assert.equal(img.status, 201);
    const blocked = await call('POST', '/api/items', { cookie, json: itemBody([img.body.id]) });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'CONTACT_REQUIRED');
    assert.equal((await call('PATCH', '/api/me', { cookie, json: { contact: 'feishu-s1' } })).status, 200);
    assert.equal((await call('POST', '/api/items', { cookie, json: itemBody([img.body.id]) })).status, 201);
  });

  it('伪造的图片 id 或他人的图片：发布失败且不产生商品记录', async () => {
    const seller = await loginAs('S1');
    const other = await loginAs('B1');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    const bogus = await call('POST', '/api/items', { cookie: seller, json: itemBody([99999]) });
    assert.equal(bogus.status, 400);
    const foreign = await upload(other);
    const stolen = await call('POST', '/api/items', { cookie: seller, json: itemBody([foreign.body.id]) });
    assert.equal(stolen.status, 400);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    assert.equal(after, before);
  });

  it('商品描述是选填的：不填也能发布', async () => {
    const cookie = await loginAs('S1');
    const img = await upload(cookie);
    const body: Record<string, unknown> = itemBody([img.body.id], { title: '没有描述的商品' });
    delete body.description;
    const r = await call('POST', '/api/items', { cookie, json: body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const detail = await call('GET', `/api/items/${r.body.id}`, { cookie });
    assert.equal(detail.body.description, '');
  });

  it('价格规则：一口价必须大于 0，免费必须为 0', async () => {
    const cookie = await loginAs('S1');
    const img = await upload(cookie);
    assert.equal((await call('POST', '/api/items', { cookie, json: itemBody([img.body.id], { price: 0 }) })).status, 400);
    assert.equal((await call('POST', '/api/items', { cookie, json: itemBody([img.body.id], { tradeType: 'free', price: 5 }) })).status, 400);
  });

  it('非图片文件被拒绝，真实类型按文件头判断', async () => {
    const cookie = await loginAs('S1');
    const fake = await upload(cookie, new TextEncoder().encode('<script>alert(1)</script>'), 'evil.png');
    assert.equal(fake.status, 400);
    assert.equal(fake.body.error.code, 'INVALID_IMAGE');
  });

  it('上传的图片登录后可读取', async () => {
    const cookie = await loginAs('S1');
    const img = await upload(cookie);
    const r = await call('GET', img.body.url, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get('content-type'), 'image/png');
  });
});

describe('完整交易流程与联系方式可见性', () => {
  it('发布 → 搜索 → 申请 → 选人 → 交付 → 完成', async () => {
    const seller = await loginAs('S1');
    const buyer = await loginAs('B1');
    const third = await loginAs('B2');

    const img = await upload(seller);
    const created = await call('POST', '/api/items', {
      cookie: seller,
      json: itemBody([img.body.id], { title: '罗技键盘 MX Keys', description: '无线键盘，轻微使用痕迹', price: 200 }),
    });
    const itemId = created.body.id as number;

    // 搜索
    const found = await call('GET', '/api/items?q=' + encodeURIComponent('罗技'), { cookie: buyer });
    assert.ok((found.body.items as any[]).some((i) => i.id === itemId));
    const miss = await call('GET', '/api/items?q=' + encodeURIComponent('不存在的东西xyz'), { cookie: buyer });
    assert.equal(miss.body.total, 0);
    // LIKE 通配符按字面匹配
    assert.equal((await call('GET', '/api/items?q=%25', { cookie: buyer })).body.total, 0);

    // 两人申请
    const r1 = await call('POST', `/api/items/${itemId}/requests`, { cookie: buyer, json: { message: '今天 17:30 可以' } });
    const r2 = await call('POST', `/api/items/${itemId}/requests`, { cookie: third, json: {} });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    // 选人前：卖家和第三方都看不到买家联系方式，买家看不到卖家联系方式
    let sellerView = (await call('GET', `/api/items/${itemId}`, { cookie: seller })).body;
    assert.equal(sellerView.viewer, 'seller');
    assert.equal(sellerView.requests.length, 2);
    assert.ok(sellerView.requests.every((q: any) => q.contact === null));
    let buyerView = (await call('GET', `/api/items/${itemId}`, { cookie: buyer })).body;
    assert.equal(buyerView.myRequest.sellerContact, null);
    assert.ok(!JSON.stringify(buyerView).includes('feishu-s1'));

    // 买家不能选人
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/accept`, { cookie: buyer })).status, 403);

    // 红点
    assert.equal((await call('GET', '/api/me', { cookie: seller })).body.badge.toReview >= 1, true);

    // 选人
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/accept`, { cookie: seller })).status, 200);
    assert.equal((await call('POST', `/api/requests/${r2.body.id}/accept`, { cookie: seller })).status, 409);

    // 选人后：交易双方互看联系方式，未被选中的人仍然看不到
    sellerView = (await call('GET', `/api/items/${itemId}`, { cookie: seller })).body;
    assert.equal(sellerView.requests.find((q: any) => q.id === r1.body.id).contact, 'im-B1');
    assert.equal(sellerView.requests.find((q: any) => q.id === r2.body.id).contact, null);
    buyerView = (await call('GET', `/api/items/${itemId}`, { cookie: buyer })).body;
    assert.equal(buyerView.myRequest.sellerContact, 'feishu-s1');
    const thirdView = (await call('GET', `/api/items/${itemId}`, { cookie: third })).body;
    assert.equal(thirdView.myRequest.sellerContact, null);
    assert.ok(!JSON.stringify(thirdView).includes('im-B1'));
    const mine = (await call('GET', '/api/me/requests', { cookie: buyer })).body.requests as any[];
    assert.equal(mine.find((x) => x.id === r1.body.id).sellerContact, 'feishu-s1');

    // 交付与完成的权限
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/handover`, { cookie: buyer })).status, 403);
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/handover`, { cookie: seller })).status, 200);
    assert.equal((await call('GET', '/api/me', { cookie: buyer })).body.badge.toConfirm, 1);
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/complete`, { cookie: seller })).status, 403);
    assert.equal((await call('POST', `/api/requests/${r1.body.id}/complete`, { cookie: buyer })).status, 200);

    // 已完成：详情状态正确，不能再申请
    assert.equal((await call('GET', `/api/items/${itemId}`, { cookie: buyer })).body.status, 'completed');
    const late = await call('POST', `/api/items/${itemId}/requests`, { cookie: await loginAs('A1'), json: {} });
    assert.ok(late.status === 400 || late.status === 409);

    // 我的发布 / 我的申请
    const myItems = (await call('GET', '/api/me/items', { cookie: seller })).body.items as any[];
    assert.equal(myItems.find((i) => i.id === itemId).status, 'completed');
  });
});

describe('管理后台', () => {
  it('隐藏的商品对普通员工不可见，列表中消失；恢复后重新出现', async () => {
    const seller = await loginAs('S1');
    const buyer = await loginAs('B1');
    const admin = await loginAs('A1');
    const img = await upload(seller);
    const id = (await call('POST', '/api/items', { cookie: seller, json: itemBody([img.body.id], { title: '待隐藏商品' }) })).body.id as number;

    assert.equal((await call('POST', `/api/admin/items/${id}/hide`, { cookie: seller, json: {} })).status, 403);
    assert.equal((await call('POST', `/api/admin/items/${id}/hide`, { cookie: admin, json: { reason: '测试' } })).status, 200);
    assert.equal((await call('GET', `/api/items/${id}`, { cookie: buyer })).status, 404);
    const list = (await call('GET', '/api/items?q=' + encodeURIComponent('待隐藏'), { cookie: buyer })).body;
    assert.equal(list.total, 0);
    assert.equal((await call('GET', `/api/items/${id}`, { cookie: seller })).status, 200);

    assert.equal((await call('POST', `/api/admin/items/${id}/restore`, { cookie: admin })).status, 200);
    assert.equal((await call('GET', `/api/items/${id}`, { cookie: buyer })).status, 200);
  });

  it('CSV 导入白名单：新增、更新、坏行报告', async () => {
    const admin = await loginAs('A1');
    const csv = '工号,姓名,部门,角色\nE100,张三,研发部\nE101,李四\n,缺工号\nE102,王五,行政,admin\n';
    const r = await call('POST', '/api/admin/users/import', { cookie: admin, json: { csv } });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 3);
    assert.equal(r.body.errors.length, 1);
    const again = await call('POST', '/api/admin/users/import', { cookie: admin, json: { csv: 'E100,张三丰,研发部' } });
    assert.equal(again.body.updated, 1);
    const login = await call('POST', '/api/auth/login', { json: { employeeNo: 'E100', name: '张三丰' } });
    assert.equal(login.status, 200);
  });

  it('看板数字与数据库记录一致', async () => {
    const admin = await loginAs('A1');
    const d = (await call('GET', '/api/admin/dashboard?from=2000-01-01', { cookie: admin })).body;
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    assert.equal(d.published, n('SELECT COUNT(*) AS n FROM items'));
    assert.equal(d.requests, n('SELECT COUNT(*) AS n FROM deal_requests'));
    assert.equal(d.completed, n("SELECT COUNT(*) AS n FROM items WHERE status = 'completed'"));
    assert.equal(d.completed, 1);
    assert.equal(d.flow.amount, 200);
    assert.ok(d.avgCycleHours !== null && d.avgCycleHours >= 0);
    assert.ok(d.activeUsers >= 3);
    assert.equal(d.funnel.completed, 1);
    assert.ok(d.matchRate > 0 && d.matchRate <= 1);
    // 范围在未来：全部为 0，比率为 null，不报错
    const empty = (await call('GET', '/api/admin/dashboard?from=2099-01-01', { cookie: admin })).body;
    assert.equal(empty.published, 0);
    assert.equal(empty.matchRate, null);
    assert.equal(empty.avgCycleHours, null);
  });

  it('交易未确认列表与强制完成', async () => {
    const seller = await loginAs('S1');
    const buyer = await loginAs('B1');
    const admin = await loginAs('A1');
    const img = await upload(seller);
    const itemId = (await call('POST', '/api/items', { cookie: seller, json: itemBody([img.body.id], { title: '卡住的交易' }) })).body.id as number;
    const reqId = (await call('POST', `/api/items/${itemId}/requests`, { cookie: buyer, json: {} })).body.id as number;
    await call('POST', `/api/requests/${reqId}/accept`, { cookie: seller });
    await call('POST', `/api/requests/${reqId}/handover`, { cookie: seller });

    // 刚交付，超过 3 天的列表里没有；days=0 能看到
    const fresh = (await call('GET', '/api/admin/deals/stale', { cookie: admin })).body.deals as any[];
    assert.ok(!fresh.some((x) => x.requestId === reqId));
    const zero = (await call('GET', '/api/admin/deals/stale?days=0', { cookie: admin })).body.deals as any[];
    assert.ok(zero.some((x) => x.requestId === reqId));

    assert.equal((await call('POST', `/api/admin/requests/${reqId}/force-complete`, { cookie: admin })).status, 200);
    assert.equal((await call('GET', `/api/items/${itemId}`, { cookie: admin })).body.status, 'completed');
  });
});
