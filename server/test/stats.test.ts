import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import { acceptRequest, completeDeal, createRequest, markHandedOver } from '../src/services/deal.ts';
import type { Env } from '../src/types.ts';
import type { Actor } from '../src/services/deal.ts';
import { addUser } from './helpers.ts';

let db: DatabaseSync;
let app: Hono<Env>;
let dir: string;

function seed(seller: Actor, buyer: Actor, opts: { price?: number; originalPrice?: number | null; source?: string } = {}): void {
  const price = opts.price ?? 100;
  const r = db
    .prepare(
      `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, original_price, handoff_location)
       VALUES (?, ?, 1, 'x', 'good', 'fixed', ?, ?, 'L')`,
    )
    .run(seller.id, `i${Math.random().toString(36).slice(2, 7)}`, price, opts.originalPrice ?? null);
  const itemId = Number(r.lastInsertRowid);
  const reqId = createRequest(db, buyer, itemId);
  if (opts.source) db.prepare('UPDATE deal_requests SET source = ? WHERE id = ?').run(opts.source, reqId);
  acceptRequest(db, seller, reqId);
  markHandedOver(db, seller, reqId);
  completeDeal(db, buyer, reqId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idle-f19-'));
  db = openDb(':memory:');
  app = createApp(db, { uploadDir: join(dir, 'uploads'), cookieSecure: false });
  rmSync(dir, { recursive: true, force: true });
});

async function login(no: string): Promise<string> {
  const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeNo: no }) });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

describe('GET /api/stats/public（F19）', () => {
  it('未登录 401', async () => {
    assert.equal((await app.request('/api/stats/public')).status, 401);
  });

  it('口径与看板一致：剔演示、节省=原价-成交价、aiAssisted=source!=normal', async () => {
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    const demo = addUser(db, 'D1');
    db.prepare("UPDATE users SET department='演示账号' WHERE id=?").run(demo.id);
    seed(s, b, { price: 100, originalPrice: 500 }); // 省 400
    seed(s, b, { price: 80 }); // 无原价
    seed(s, b, { price: 0, originalPrice: 60, source: 'negotiation' }); // 免费省 60 + AI 促成
    seed(demo, b, { price: 999 }); // 演示卖家整笔剔除

    const cookie = await login('B1');
    const r = await (await app.request('/api/stats/public', { headers: { Cookie: cookie } })).json();
    assert.equal(r.completed, 3);
    assert.equal(r.saved, 460);
    assert.equal(r.aiAssisted, 1);
  });

  it('响应只有三个键；传 includeDemo=1 不改变结果', async () => {
    const s = addUser(db, 'S1');
    const b = addUser(db, 'B1');
    seed(s, b, { price: 50 });
    const cookie = await login('B1');
    const a = await (await app.request('/api/stats/public', { headers: { Cookie: cookie } })).json();
    const b2 = await (await app.request('/api/stats/public?includeDemo=1', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(Object.keys(a).sort(), ['aiAssisted', 'completed', 'saved', 'users']);
    assert.deepEqual(a, b2);
    assert.ok(!JSON.stringify(a).includes('name'));
  });

  it('无交易时交易指标全 0（users 为真实活跃白名单数）', async () => {
    addUser(db, 'S1');
    const cookie = await login('S1');
    const r = await (await app.request('/api/stats/public', { headers: { Cookie: cookie } })).json();
    assert.equal(r.completed, 0);
    assert.equal(r.saved, 0);
    assert.equal(r.aiAssisted, 0);
    assert.equal(r.users, 1);
  });
});
