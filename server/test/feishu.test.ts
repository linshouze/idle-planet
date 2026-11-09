import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import type { Env } from '../src/types.ts';
import { addUser } from './helpers.ts';

let db: DatabaseSync;
let dir: string;
let plain: Hono<Env>;

const FEISHU = { appId: 'cli_test', appSecret: 'sec', baseUrl: 'http://localhost:3100' };
const OPEN_ID = 'ou_test123';

/** mock 飞书四个端点；scenario 控制 contact 与 token 的行为。 */
function mockHttp(scenario: { contact?: 'ok' | 'forbidden'; token?: 'ok' | 'fail' } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/authen/v2/oauth/token')) {
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (scenario.token === 'fail' || body.code === 'badtoken') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return Response.json({ access_token: 'tok' });
    }
    if (url.includes('/authen/v1/user_info')) return Response.json({ code: 0, data: { open_id: OPEN_ID, name: '林寿泽' } });
    if (url.includes('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'tt' });
    if (url.includes('/contact/v3/users/')) {
      if (scenario.contact === 'forbidden') return new Response(JSON.stringify({ code: 40004, msg: 'no dept authority' }), { status: 403 });
      return Response.json({ code: 0, data: { user: { employee_no: 'T1' } } });
    }
    return new Response('unexpected url ' + url, { status: 500 });
  };
}

function makeApp(scenario: Parameters<typeof mockHttp>[0] = {}, withFeishu = true): Hono<Env> {
  return createApp(db, {
    uploadDir: join(dir, 'uploads'),
    cookieSecure: false,
    feishu: withFeishu ? FEISHU : undefined,
    feishuHttp: mockHttp(scenario),
  });
}

async function startState(app: Hono<Env>): Promise<{ cookie: string; state: string }> {
  const r = await app.request('/api/auth/feishu');
  return {
    cookie: cookieFrom(r, 'fs_state'),
    state: new URL(r.headers.get('location')!).searchParams.get('state')!,
  };
}

/** 从响应里取指定 cookie（set-cookie 可能有多个：删除项 + 新设项；个别 Response 实现会把多值逗号拼接）。 */
function cookieFrom(res: Response, name: string): string {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const c of all) {
    if (c.startsWith(name + '=')) return c.split(';')[0]!;
    const m = c.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
    if (m) return `${name}=${m[1]}`;
  }
  return '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-feishu-'));
  db = openDb(':memory:');
  plain = createApp(db, { uploadDir: join(dir, 'uploads'), cookieSecure: false });
});

describe('F21 飞书登录', () => {
  it('未配置凭据时发起与回调都回退到工号登录提示', async () => {
    const r = await plain.request('/api/auth/feishu');
    assert.equal(r.headers.get('location'), '/login?err=feishu_disabled');
    const r2 = await plain.request('/api/auth/feishu/callback?code=x&state=y');
    assert.equal(r2.headers.get('location'), '/login?err=feishu_disabled');
  });

  it('发起跳转：302 到飞书授权页，带 client_id、回调地址和 state cookie', async () => {
    const app = makeApp();
    const r = await app.request('/api/auth/feishu');
    assert.equal(r.status, 302);
    const loc = r.headers.get('location')!;
    assert.ok(loc.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?'), loc);
    assert.ok(loc.includes('client_id=cli_test'), loc);
    assert.ok(loc.includes(encodeURIComponent('http://localhost:3100/api/auth/feishu/callback')), loc);
    assert.match(r.headers.get('set-cookie') ?? '', /fs_state=[0-9a-f]{32}/);
  });

  it('回调 state 不匹配 / 无 code：分别拒绝', async () => {
    const app = makeApp();
    const bad = await app.request('/api/auth/feishu/callback?code=abc&state=wrong');
    assert.equal(bad.headers.get('location'), '/login?err=feishu_state');
    const { cookie, state } = await startState(app);
    const denied = await app.request(`/api/auth/feishu/callback?state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(denied.headers.get('location'), '/login?err=feishu_denied');
  });

  it('换 token 失败：回登录页提示不可用', async () => {
    const app = makeApp({ token: 'fail' });
    const { cookie, state } = await startState(app);
    const r = await app.request(`/api/auth/feishu/callback?code=badtoken&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(r.headers.get('location'), '/login?err=feishu_failed');
  });

  it('employee_no 命中白名单：直接建会话并绑定 open_id', async () => {
    addUser(db, 'T1');
    const app = makeApp();
    const { cookie, state } = await startState(app);
    const r = await app.request(`/api/auth/feishu/callback?code=good&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    assert.match(cookieFrom(r, 'sid'), /^sid=[0-9a-f]{64}$/);
    const bound = db.prepare('SELECT employee_no FROM users WHERE feishu_open_id = ?').get(OPEN_ID) as { employee_no: string };
    assert.equal(bound.employee_no, 'T1');
    // 会话可用
    const sid = cookieFrom(r, 'sid');
    const me = await (await app.request('/api/me', { headers: { Cookie: sid } })).json();
    assert.equal(me.user.employeeNo, 'T1');
  });

  it('contact 取不到 employee_no 且未绑定：进入绑定分支，输工号后登录', async () => {
    addUser(db, 'T1');
    const app = makeApp({ contact: 'forbidden' });
    const { cookie, state } = await startState(app);
    const r = await app.request(`/api/auth/feishu/callback?code=good&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(r.headers.get('location'), '/login?bind=feishu');
    const pending = cookieFrom(r, 'fs_pending');
    assert.match(pending, /^fs_pending=.+/);

    const wrong = await app.request('/api/auth/feishu/bind', {
      method: 'POST',
      headers: { Cookie: pending, 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'NOPE' }),
    });
    assert.equal(wrong.status, 401);

    const ok = await app.request('/api/auth/feishu/bind', {
      method: 'POST',
      headers: { Cookie: pending, 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'T1' }),
    });
    assert.equal(ok.status, 200);
    assert.match(cookieFrom(ok, 'sid'), /^sid=[0-9a-f]{64}$/);
    const bound = db.prepare('SELECT employee_no FROM users WHERE feishu_open_id = ?').get(OPEN_ID) as { employee_no: string };
    assert.equal(bound.employee_no, 'T1');
  });

  it('open_id 已绑他人时拒绝顶替', async () => {
    addUser(db, 'T1');
    const t2 = addUser(db, 'T2');
    db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(OPEN_ID, t2.id);
    const app = makeApp();
    const { cookie, state } = await startState(app);
    const r = await app.request(`/api/auth/feishu/callback?code=good&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(r.headers.get('location'), '/login?err=feishu_bound');
  });

  it('已绑定用户扫码：直接登录，不重复绑定', async () => {
    const t2 = addUser(db, 'T2');
    db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(OPEN_ID, t2.id);
    const app = makeApp({ contact: 'forbidden' });
    const { cookie, state } = await startState(app);
    const r = await app.request(`/api/auth/feishu/callback?code=good&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(r.headers.get('location'), '/');
    const sid = cookieFrom(r, 'sid');
    const me = await (await app.request('/api/me', { headers: { Cookie: sid } })).json();
    assert.equal(me.user.id, t2.id);
  });
});
