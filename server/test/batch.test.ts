/**
 * F1 多图一键清仓：draft 纯图识别 + POST /api/items/batch 批量发布。
 * mock chat 注入模式与 risk.test.ts 一致：假 key 让 aiConfig() 非空，AI 调用全部走 mock。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import type { AiConfig, ChatOptions } from '../src/services/ai.ts';
import { runRiskCheck } from '../src/services/risk.ts';
import type { Env } from '../src/types.ts';
import type { Actor } from '../src/services/deal.ts';
import { addUser, memDb } from './helpers.ts';

process.env.AI_API_KEY = 'test-key';
let nextReply: string | null = null;
let lastOpts: ChatOptions | null = null;
const mockChat = async (_cfg: AiConfig, opts: ChatOptions): Promise<string | null> => {
  lastOpts = opts;
  return nextReply;
};

const WARN = { level: 'warn', type: 'company_asset', reason: '照片右下角有白色条码资产标签' };

/** draft 模型返回的完整 JSON（可按字段覆盖）。 */
const draftReply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    title: '罗技无线键盘', description: '使用约一年，打字正常', categoryId: 1, condition: 'good',
    priceSuggestion: { min: 120, max: 200, reason: '同类二手常见价' }, newPriceEstimate: 299, price: null,
    missing: [], risk: { level: 'none' }, kind: 'goods', expiresOn: null, quantity: 1, uncertain: [],
    ...over,
  });

type ItemResult = { ok: true; id: number; ids: number[] } | { ok: false; error: { code: string; message: string } };

function expectOk(r: ItemResult | undefined): number {
  assert.ok(r, 'result missing');
  assert.equal(r.ok, true);
  return r.id;
}

function expectFail(r: ItemResult | undefined, code: string): string {
  assert.ok(r, 'result missing');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, code);
  return r.error.message;
}

let db: DatabaseSync;
let dir: string;
let seller: Actor;
let app: Hono<Env>;
let cookie: string;

beforeEach(async () => {
  nextReply = null;
  lastOpts = null;
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-batch-'));
  db = memDb();
  seller = addUser(db, 'B1');
  app = createApp(db, { uploadDir: dir, cookieSecure: false, aiChat: mockChat });
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeNo: 'B1' }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});

/** 插入一张属于 seller 的未绑定图片（带真实文件，draft 可读），返回图片 id。 */
function addImage(name: string): number {
  writeFileSync(join(dir, name), 'fake-image-bytes');
  const r = db.prepare('INSERT INTO item_images (uploader_id, path) VALUES (?, ?)').run(seller.id, name);
  return Number(r.lastInsertRowid);
}

const call = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** batch 的单件入参（handoffLocation/handoffTime 由 common 提供，件内不传）。 */
const batchItem = (imageIds: number[], over: Record<string, unknown> = {}) => ({
  title: '戴尔 U2720Q 显示器',
  categoryId: 1,
  description: '用了两年',
  condition: 'good',
  tradeType: 'fixed',
  price: 800,
  imageIds,
  ...over,
});

const itemCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

describe('F1 draft 纯图识别', () => {
  it('有 imageId、text 为空 → 识别成功，user 消息含纯图占位并附带图片', async () => {
    nextReply = draftReply();
    const img = addImage('a.jpg');
    const res = await call('POST', '/api/ai/draft', { imageId: img });
    assert.equal(res.status, 200);
    const v = (await res.json()) as { available: boolean; draft: { title: string; condition: string } };
    assert.equal(v.available, true);
    assert.equal(v.draft.title, '罗技无线键盘');
    assert.ok(lastOpts!.user.includes('用户输入：（无文字描述，仅依据图片识别）'));
    assert.equal(lastOpts!.contentBlocks?.length, 1); // 图片已附上
  });

  it('text 为空且无 imageId → 400 INVALID_INPUT', async () => {
    const res = await call('POST', '/api/ai/draft', { text: '   ' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'INVALID_INPUT');
  });

  it('纯图识别但图片不存在 → 400 INVALID_IMAGE', async () => {
    const res = await call('POST', '/api/ai/draft', { imageId: 9999 });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'INVALID_IMAGE');
  });

  it('uncertain 白名单：模型乱给的字段名被丢弃，白名单内保留', async () => {
    nextReply = draftReply({ uncertain: ['title', 'sellerName', 'expiresOn', 42, null, 'price'] });
    const res = await call('POST', '/api/ai/draft', { text: '出个键盘' });
    assert.equal(res.status, 200);
    const v = (await res.json()) as { draft: { uncertain: string[] } };
    assert.deepEqual(v.draft.uncertain, ['title', 'expiresOn', 'price']);
  });
});

describe('F1 POST /api/items/batch', () => {
  it('三件其中一件图片伪造 → 仅该件失败且无商品记录，其余成功且共享 batch_id、publish_mode=batch', async () => {
    const a = addImage('a.jpg');
    const b = addImage('b.jpg');
    const res = await call('POST', '/api/items/batch', {
      common: { handoffLocation: '一楼大厅', handoffTime: '工作日中午' },
      items: [batchItem([a]), batchItem([9999], { title: '伪造图片件' }), batchItem([b])],
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as ItemResult[];
    assert.equal(out.length, 3); // 与入参顺序对应
    const id0 = expectOk(out[0]);
    expectFail(out[1], 'INVALID_IMAGE');
    const id2 = expectOk(out[2]);

    const rows = db
      .prepare('SELECT id, batch_id, publish_mode, handoff_location, handoff_time FROM items ORDER BY id')
      .all() as { id: number; batch_id: string | null; publish_mode: string; handoff_location: string; handoff_time: string | null }[];
    assert.equal(rows.length, 2); // 失败件不产生商品记录
    assert.deepEqual(rows.map((r) => r.id), [id0, id2]);
    assert.ok(rows[0]!.batch_id);
    assert.equal(rows[0]!.batch_id, rows[1]!.batch_id); // 同一次调用共享一个 batch_id
    assert.match(rows[0]!.batch_id!, /^[0-9a-f-]{36}$/);
    assert.equal(rows[0]!.publish_mode, 'batch');
    assert.equal(rows[1]!.publish_mode, 'batch');
    // common 交接信息逐件生效
    assert.equal(rows[0]!.handoff_location, '一楼大厅');
    assert.equal(rows[1]!.handoff_time, '工作日中午');
    // 图片各自绑定到自己的商品，伪造 id 未绑定任何商品
    const bound = db.prepare('SELECT id, item_id FROM item_images ORDER BY id').all() as { id: number; item_id: number | null }[];
    assert.deepEqual(bound.find((x) => x.id === a)?.item_id, id0);
    assert.deepEqual(bound.find((x) => x.id === b)?.item_id, id2);
  });

  it('warn 未确认的件 → 仅该件 RISK_ACK_REQUIRED，不影响其他件；确认后单独重试成功并写预警字段', async () => {
    nextReply = JSON.stringify(WARN);
    const pre = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    assert.ok(pre.riskCheckId);
    const a = addImage('c.jpg');
    const b = addImage('d.jpg');
    const res = await call('POST', '/api/items/batch', {
      common: { handoffLocation: '三楼前台' },
      items: [batchItem([a]), batchItem([b], { riskCheckId: pre.riskCheckId })],
    });
    const out = (await res.json()) as ItemResult[];
    expectOk(out[0]);
    expectFail(out[1], 'RISK_ACK_REQUIRED');
    assert.equal(itemCount(), 1); // warn 未确认件没有商品记录

    // 失败卡重试（只发失败件）：带 riskAck 后成功，预警字段与单件发布一致
    const retry = await call('POST', '/api/items/batch', {
      common: { handoffLocation: '三楼前台' },
      items: [batchItem([b], { riskCheckId: pre.riskCheckId, riskAck: true })],
    });
    const out2 = (await retry.json()) as ItemResult[];
    const id = expectOk(out2[0]);
    const r = db.prepare('SELECT ai_risk_type, ai_risk_reason, ai_risk_ack, ai_risk_checked, publish_mode FROM items WHERE id = ?').get(id) as {
      ai_risk_type: string | null; ai_risk_reason: string | null; ai_risk_ack: number; ai_risk_checked: number; publish_mode: string;
    };
    assert.equal(r.ai_risk_type, 'company_asset');
    assert.equal(r.ai_risk_reason, WARN.reason);
    assert.equal(r.ai_risk_ack, 1);
    assert.equal(r.ai_risk_checked, 1);
    assert.equal(r.publish_mode, 'batch');
  });

  it('一件缺必填 → 该件 VALIDATION_ERROR，其余照常发布（顺序对应）', async () => {
    const a = addImage('e.jpg');
    const b = addImage('f.jpg');
    const res = await call('POST', '/api/items/batch', {
      common: { handoffLocation: '一楼大厅' },
      items: [batchItem([a], { title: '   ' }), batchItem([b])],
    });
    const out = (await res.json()) as ItemResult[];
    expectFail(out[0], 'VALIDATION_ERROR');
    expectOk(out[1]);
    assert.equal(itemCount(), 1);
  });

  it('common 缺交接地点 / items 为空 / 超过 10 件 → 整体 400，不产生记录', async () => {
    const r1 = await call('POST', '/api/items/batch', { common: {}, items: [batchItem([1])] });
    assert.equal(r1.status, 400);
    const r2 = await call('POST', '/api/items/batch', { common: { handoffLocation: '一楼' }, items: [] });
    assert.equal(r2.status, 400);
    const r3 = await call('POST', '/api/items/batch', {
      common: { handoffLocation: '一楼' },
      items: Array.from({ length: 11 }, () => batchItem([])),
    });
    assert.equal(r3.status, 400);
    assert.equal(itemCount(), 0);
  });

  it('单件发布不受影响：publish_mode=single、batch_id 为 NULL', async () => {
    const a = addImage('g.jpg');
    // 单件发布不走 common，交接地点要在件内自带
    const res = await call('POST', '/api/items', { ...batchItem([a]), handoffLocation: '一楼大厅' });
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: number };
    const r = db.prepare('SELECT publish_mode, batch_id FROM items WHERE id = ?').get(id) as { publish_mode: string; batch_id: string | null };
    assert.equal(r.publish_mode, 'single');
    assert.equal(r.batch_id, null);
  });

  it('未登录 → 401', async () => {
    const res = await app.request('/api/items/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ common: { handoffLocation: '一楼' }, items: [batchItem([1])] }),
    });
    assert.equal(res.status, 401);
  });
});

describe('F1 迁移', () => {
  it('新建库 items 含 publish_mode / batch_id 列', () => {
    const cols = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('publish_mode'));
    assert.ok(cols.includes('batch_id'));
  });
});
