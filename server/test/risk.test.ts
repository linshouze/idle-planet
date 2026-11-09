import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import type { AiConfig, ChatOptions } from '../src/services/ai.ts';
import { normalizeRisk, parseRisk, resolveRiskForPublish, runRiskCheck } from '../src/services/risk.ts';
import { createItem, updateItem } from '../src/services/items.ts';
import type { Env } from '../src/types.ts';
import type { Actor } from '../src/services/deal.ts';
import { AppError } from '../src/errors.ts';
import { addUser, memDb } from './helpers.ts';

// 测试文件独立进程：设置假 key 让 aiConfig() 非空，AI 调用全部走 mock。
process.env.AI_API_KEY = 'test-key';
let nextReply: string | null = null;
const mockChat = async (_cfg: AiConfig, _opts: ChatOptions): Promise<string | null> => nextReply;

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code, `expected AppError ${code}`);
}

const WARN = { level: 'warn', type: 'company_asset', reason: '照片右下角有白色条码资产标签' };
const itemInput = (imageIds: number[]) => ({
  title: '戴尔 U2720Q 显示器',
  categoryId: 1,
  description: '用了两年',
  condition: 'good' as const,
  tradeType: 'fixed' as const,
  price: 800,
  handoffLocation: '一楼大厅',
  imageIds,
});

let db: DatabaseSync;
let dir: string;
let seller: Actor;
let other: Actor;

beforeEach(() => {
  nextReply = null;
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-risk-'));
  db = memDb();
  seller = addUser(db, 'S1');
  other = addUser(db, 'O2');
});

/** 插入一张属于 uploader 的未绑定图片，返回图片 id。 */
function addImage(uploader: Actor, name = 'a.jpg'): number {
  writeFileSync(join(dir, name), 'fake-image-bytes');
  const r = db.prepare('INSERT INTO item_images (uploader_id, path) VALUES (?, ?)').run(uploader.id, name);
  return Number(r.lastInsertRowid);
}

function riskRow(id: number) {
  return db.prepare('SELECT * FROM ai_risk_checks WHERE id = ?').get(id) as
    | { id: number; user_id: number; level: string; type: string | null; reason: string | null; image_ids: string | null }
    | undefined;
}

function itemRisk(db2: DatabaseSync, itemId: number) {
  return db2.prepare('SELECT ai_risk_type, ai_risk_reason, ai_risk_ack, ai_risk_reviewed, ai_risk_checked FROM items WHERE id = ?').get(itemId) as {
    ai_risk_type: string | null;
    ai_risk_reason: string | null;
    ai_risk_ack: number;
    ai_risk_reviewed: number;
    ai_risk_checked: number;
  };
}

describe('normalizeRisk / parseRisk：收紧模型输出', () => {
  it('warn 需要合法 type 和非空 reason；none 原样通过', () => {
    assert.deepEqual(normalizeRisk(WARN), WARN);
    assert.deepEqual(normalizeRisk({ level: 'none' }), { level: 'none' });
    assert.equal(normalizeRisk({ level: 'warn', type: 'other', reason: 'x' }), null);
    assert.equal(normalizeRisk({ level: 'warn', type: 'company_asset', reason: '  ' }), null);
    assert.equal(normalizeRisk({ level: 'warn' }), null);
    assert.equal(normalizeRisk({}), null);
    assert.equal(normalizeRisk(null), null);
    assert.equal(normalizeRisk('warn'), null);
  });

  it('reason 超过 40 字截断；parseRisk 容忍代码块和前后缀', () => {
    const long = { level: 'warn', type: 'prohibited', reason: '标'.repeat(50) };
    assert.equal((normalizeRisk(long) as { reason: string }).reason.length, 40);
    assert.deepEqual(parseRisk('```json\n{"level":"warn","type":"prohibited","reason":"标题写明收港币"}\n```'), {
      level: 'warn',
      type: 'prohibited',
      reason: '标题写明收港币',
    });
    assert.equal(parseRisk('不是 json'), null);
    assert.equal(parseRisk(null), null);
  });
});

describe('runRiskCheck：判定 + 服务端落库', () => {
  it('warn：落库并返回 riskCheckId，最多只带 2 张图', async () => {
    nextReply = JSON.stringify(WARN);
    const img = addImage(seller);
    const out = await runRiskCheck(db, seller.id, { title: '戴尔显示器', imageIds: [img, img, 999], uploadDir: dir }, mockChat);
    assert.equal(out.checked, true);
    assert.deepEqual(out.risk, WARN);
    const row = riskRow(out.riskCheckId!)!;
    assert.equal(row.user_id, seller.id);
    assert.equal(row.level, 'warn');
    assert.equal(row.type, 'company_asset');
    assert.equal(JSON.parse(row.image_ids!).length, 2); // ≤2 张
  });

  it('none：落库 level=none，type/reason 为空', async () => {
    nextReply = '{"level":"none"}';
    const out = await runRiskCheck(db, seller.id, { title: '罗技键盘', uploadDir: dir }, mockChat);
    assert.equal(out.checked, true);
    assert.deepEqual(out.risk, { level: 'none' });
    const row = riskRow(out.riskCheckId!)!;
    assert.equal(row.level, 'none');
    assert.equal(row.type, null);
  });

  it('超时/失败/解析失败：未检放行，不落库', async () => {
    for (const reply of [null, '抱歉我无法输出 JSON', '{"level":"warn","type":"bad","reason":"x"}']) {
      nextReply = reply;
      const out = await runRiskCheck(db, seller.id, { title: '东西', uploadDir: dir }, mockChat);
      assert.equal(out.checked, false);
      assert.equal(out.riskCheckId, null);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_risk_checks').get() as { n: number }).n, 0);
    }
  });
});

describe('resolveRiskForPublish + 发布写入预警字段', () => {
  let img: number;
  beforeEach(() => {
    img = addImage(seller);
  });

  it('warn 未确认 → 409 RISK_ACK_REQUIRED，不产生商品记录', async () => {
    nextReply = JSON.stringify(WARN);
    const { riskCheckId } = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    assertCode(() => createItem(db, seller, itemInput([img]), { riskCheckId: riskCheckId! }), 'RISK_ACK_REQUIRED');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 0);
  });

  it('确认后正常上架：写预警字段、ack=1、checked=1', async () => {
    nextReply = JSON.stringify(WARN);
    const { riskCheckId } = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    const id = createItem(db, seller, itemInput([img]), { riskCheckId: riskCheckId!, riskAck: true });
    const r = itemRisk(db, id);
    assert.equal(r.ai_risk_type, 'company_asset');
    assert.equal(r.ai_risk_reason, WARN.reason);
    assert.equal(r.ai_risk_ack, 1);
    assert.equal(r.ai_risk_checked, 1);
    assert.equal(r.ai_risk_reviewed, 0);
  });

  it('none：照常上架，checked=1、无预警字段', async () => {
    nextReply = '{"level":"none"}';
    const { riskCheckId } = await runRiskCheck(db, seller.id, { title: '罗技键盘', uploadDir: dir }, mockChat);
    const id = createItem(db, seller, itemInput([img]), { riskCheckId: riskCheckId! });
    const r = itemRisk(db, id);
    assert.equal(r.ai_risk_checked, 1);
    assert.equal(r.ai_risk_type, null);
    assert.equal(r.ai_risk_ack, 0);
  });

  it('riskCheckId 必须属于当前用户，否则忽略（按未检放行）', async () => {
    nextReply = JSON.stringify(WARN);
    const { riskCheckId } = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    assertCode(() => createItem(db, seller, itemInput([img]), { riskCheckId: riskCheckId! }), 'RISK_ACK_REQUIRED');
    // 别人拿这条记录发布：忽略归属不符的 id，不确认也能上架，记为未检
    const id = createItem(db, other, itemInput([addImage(other)]), { riskCheckId: riskCheckId!, riskAck: true });
    const r = itemRisk(db, id);
    assert.equal(r.ai_risk_checked, 0);
    assert.equal(r.ai_risk_type, null);
    // 不存在的 id 同样忽略
    const id2 = createItem(db, seller, itemInput([addImage(seller)]), { riskCheckId: 99999 });
    assert.equal(itemRisk(db, id2).ai_risk_checked, 0);
  });

  it('无 riskCheckId：未检上架（AI 未启用时主流程不受影响）', () => {
    const id = createItem(db, seller, itemInput([img]));
    const r = itemRisk(db, id);
    assert.equal(r.ai_risk_checked, 0);
    assert.equal(resolveRiskForPublish(db, seller.id, {}).applied, false);
  });

  it('编辑：不带 riskCheckId 保留原预警；带新判定 none 清掉旧预警', async () => {
    nextReply = JSON.stringify(WARN);
    const { riskCheckId } = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    const id = createItem(db, seller, itemInput([img]), { riskCheckId: riskCheckId!, riskAck: true });
    updateItem(db, seller, id, itemInput([img])); // 内容变动但没重新检：预警记录保留
    assert.equal(itemRisk(db, id).ai_risk_type, 'company_asset');
    nextReply = '{"level":"none"}';
    const recheck = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    updateItem(db, seller, id, itemInput([img]), { riskCheckId: recheck.riskCheckId! });
    const r = itemRisk(db, id);
    assert.equal(r.ai_risk_type, null);
    assert.equal(r.ai_risk_checked, 1);
    assert.equal(r.ai_risk_ack, 0);
  });
});

// ---- 路由层：createApp + aiChat 注入 ----

describe('F2 路由', () => {
  let app: Hono<Env>;
  let cookie: string;

  beforeEach(async () => {
    app = createApp(db, { uploadDir: dir, cookieSecure: false, aiChat: mockChat });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'S1' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  it('POST /api/ai/check warn → 409 RISK_ACK_REQUIRED → 确认后 201；普通用户详情不泄露预警字段', async () => {
    const img = addImage(seller);
    nextReply = JSON.stringify(WARN);
    const check = await app.request('/api/ai/check', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '戴尔显示器', description: '用了两年', imageIds: [img] }),
    });
    assert.equal(check.status, 200);
    const cv = (await check.json()) as { available: boolean; riskCheckId: number; risk: { level: string; type: string } };
    assert.equal(cv.available, true);
    assert.equal(cv.risk.level, 'warn');
    assert.equal(cv.risk.type, 'company_asset');

    const reject = await app.request('/api/items', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...itemInput([img]), riskCheckId: cv.riskCheckId }),
    });
    assert.equal(reject.status, 409);
    assert.equal(((await reject.json()) as { error: { code: string } }).error.code, 'RISK_ACK_REQUIRED');

    const ok = await app.request('/api/items', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...itemInput([img]), riskCheckId: cv.riskCheckId, riskAck: true }),
    });
    assert.equal(ok.status, 201);
    const { id } = (await ok.json()) as { id: number };
    // 集市与详情对普通用户不展示预警
    const detail = await app.request(`/api/items/${id}`, { headers: { Cookie: cookie } });
    const text = JSON.stringify(await detail.json());
    assert.equal(text.includes('aiRisk'), false);
    assert.equal(text.includes(WARN.reason), false);
    const list = await app.request('/api/items', { headers: { Cookie: cookie } });
    assert.equal(JSON.stringify(await list.json()).includes('aiRisk'), false);
  });

  it('POST /api/ai/check 超时 → available=false → 发布照常（未检）', async () => {
    const img = addImage(seller);
    nextReply = null; // 模拟超时/失败
    const check = await app.request('/api/ai/check', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '戴尔显示器', imageIds: [img] }),
    });
    assert.equal(check.status, 200);
    assert.equal(((await check.json()) as { available: boolean }).available, false);
    const ok = await app.request('/api/items', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(itemInput([img])),
    });
    assert.equal(ok.status, 201);
    const { id } = (await ok.json()) as { id: number };
    assert.equal(itemRisk(db, id).ai_risk_checked, 0);
  });

  it('check 入参缺标题和描述 → 400；draft 返回 risk + riskCheckId', async () => {
    const bad = await app.request('/api/ai/check', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '  ' }),
    });
    assert.equal(bad.status, 400);

    nextReply = JSON.stringify({
      title: '工牌套', description: '闲置', categoryId: 6, condition: 'good', priceSuggestion: null, newPriceEstimate: null, missing: [], risk: { level: 'warn', type: 'prohibited', reason: '标题写明出售工牌' },
    });
    const draft = await app.request('/api/ai/draft', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '出个闲置工牌' }),
    });
    const dv = (await draft.json()) as { available: boolean; draft: { risk: { level: string; type: string } }; riskCheckId: number };
    assert.equal(dv.available, true);
    assert.equal(dv.draft.risk.level, 'warn');
    assert.equal(dv.draft.risk.type, 'prohibited');
    assert.ok(dv.riskCheckId);
    const row = riskRow(dv.riskCheckId)!;
    assert.equal(row.user_id, seller.id);
    assert.equal(row.type, 'prohibited');
  });

  it('管理后台：aiFlag 筛选、预警字段、标记已复核；无预警标记复核报 409', async () => {
    const img = addImage(seller);
    nextReply = JSON.stringify(WARN);
    const pre = await runRiskCheck(db, seller.id, { title: '戴尔显示器', uploadDir: dir }, mockChat);
    const id = createItem(db, seller, itemInput([img]), { riskCheckId: pre.riskCheckId!, riskAck: true });
    const clean = createItem(db, seller, itemInput([addImage(seller, 'b.jpg')]));

    const admin = addUser(db, 'A9', { role: 'admin' });
    const adminLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'A9' }),
    });
    const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0]!;

    const flagged = await app.request('/api/admin/items?aiFlag=1', { headers: { Cookie: adminCookie } });
    const body = (await flagged.json()) as { items: { id: number; aiRiskType: string | null; aiRiskAck: boolean; aiRiskReviewed: boolean; aiRiskChecked: boolean; cover: string | null }[] };
    assert.deepEqual(body.items.map((x) => x.id), [id]); // 只含预警商品
    assert.equal(body.items[0]!.aiRiskType, 'company_asset');
    assert.equal(body.items[0]!.aiRiskAck, true);
    assert.equal(body.items[0]!.aiRiskReviewed, false);
    assert.equal(body.items[0]!.aiRiskChecked, true);
    assert.match(body.items[0]!.cover!, /^\/api\/uploads\//);

    const review = await app.request(`/api/admin/items/${id}/risk-reviewed`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.equal(review.status, 200);
    assert.equal(itemRisk(db, id).ai_risk_reviewed, 1);
    assert.equal(itemRisk(db, id).ai_risk_type, 'company_asset'); // 记录保留

    const noFlag = await app.request(`/api/admin/items/${clean}/risk-reviewed`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.equal(noFlag.status, 409);
    assert.equal(((await noFlag.json()) as { error: { code: string } }).error.code, 'NO_RISK_FLAG');
  });

  it('无 AI key：/api/ai/check 503，发布不带风控照常上架', async () => {
    const had = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    try {
      const img = addImage(seller);
      const check = await app.request('/api/ai/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '戴尔显示器' }),
      });
      assert.equal(check.status, 503);
      const ok = await app.request('/api/items', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(itemInput([img])),
      });
      assert.equal(ok.status, 201);
      const { id } = (await ok.json()) as { id: number };
      assert.equal(itemRisk(db, id).ai_risk_checked, 0);
    } finally {
      process.env.AI_API_KEY = had!;
    }
  });
});

describe('迁移：老库补列', () => {
  it('新建库包含 ai_risk_checks 表和 items 预警列', () => {
    const cols = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['ai_risk_type', 'ai_risk_reason', 'ai_risk_ack', 'ai_risk_reviewed', 'ai_risk_checked']) assert.ok(cols.includes(c), c);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_risk_checks'").get());
  });
});
