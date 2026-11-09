import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import { extractJson, loadPrompt } from '../src/services/ai.ts';
import { parseWishDraft } from '../src/routes/ai.ts';
import type { Env } from '../src/types.ts';
import type { Actor } from '../src/services/deal.ts';
import { addItem, addUser } from './helpers.ts';

let db: DatabaseSync;
let app: Hono<Env>;
let dir: string;
let seller: Actor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-ai-'));
  db = openDb(':memory:');
  app = createApp(db, { uploadDir: join(dir, 'uploads'), cookieSecure: false });
  addUser(db, 'A1', { role: 'admin' });
  seller = addUser(db, 'S1');
});

describe('AI 关闭时的降级（测试进程不设 AI_API_KEY）', () => {
  it('/api/me 返回 aiEnabled=false', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'A1', name: '员工A1' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
    assert.equal(me.aiEnabled, false);
  });

  it('AI 接口返回 503', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'A1', name: '员工A1' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    for (const path of ['/api/ai/draft', '/api/ai/report', '/api/ai/wish-draft']) {
      const r = await app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.equal(body.error.code, 'AI_DISABLED');
    }
  });

  it('搜索无结果时响应里没有 ai 字段，不报错', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'A1', name: '员工A1' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const r = await app.request('/api/items?q=' + encodeURIComponent('不存在的怪东西'), { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.total, 0);
    assert.equal('ai' in body, false);
  });
});

describe('extractJson 容错解析', () => {
  it('纯 JSON、代码块包裹、前后带文字都能解析', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('好的，结果如下：{"a":1} 以上'), { a: 1 });
    assert.deepEqual(extractJson('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  });

  it('无 JSON、截断 JSON、null 输入返回 null', () => {
    assert.equal(extractJson('没有对象'), null);
    assert.equal(extractJson('{"a":1'), null);
    assert.equal(extractJson(null), null);
    assert.equal(extractJson(''), null);
  });
});

describe('AI 兜底不改变关键词搜索的既有行为', () => {
  it('关键词能搜到时不附带 ai 字段', async () => {
    addItem(db, seller, '戴尔显示器');
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'A1', name: '员工A1' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const r = await (await app.request('/api/items?q=' + encodeURIComponent('戴尔'), { headers: { Cookie: cookie } })).json();
    assert.equal(r.total, 1);
    assert.equal('ai' in r, false);
  });
});

describe('parseWishDraft 解析与收紧', () => {
  it('正常输出：预算取整、freeOk 强制布尔、理由保留', () => {
    const d = parseWishDraft('{"content":"想要显示器支架","budget":80.4,"freeOk":"yes","budgetReason":"二手常见 40-100 元"}');
    assert.equal(d?.content, '想要显示器支架');
    assert.equal(d?.budget, 80);
    assert.equal(d?.freeOk, false); // 非 true 一律 false
    assert.ok(d?.budgetReason);
  });

  it('用户已说预算时模型返回 null：保留 null', () => {
    const d = parseWishDraft('{"content":"想要键盘，300 以内","budget":null,"freeOk":false,"budgetReason":"沿用你说的预算"}');
    assert.equal(d?.budget, null);
  });

  it('缺 content、垃圾输入、null 都返回 null', () => {
    assert.equal(parseWishDraft('{"budget":10}'), null);
    assert.equal(parseWishDraft('不是 json'), null);
    assert.equal(parseWishDraft(null), null);
  });

  it('content 超过 100 字被截断', () => {
    const d = parseWishDraft(JSON.stringify({ content: '想要'.repeat(80) }));
    assert.equal(d?.content?.length, 100);
  });
});

describe('提示词配置化', () => {
  it('loadPrompt 读文件、热加载、缺失返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idle-prompts-'));
    const file = join(dir, 'x.txt');
    process.env.PROMPTS_DIR = dir;
    try {
      assert.equal(loadPrompt('x'), null);
      writeFileSync(file, 'v1');
      assert.equal(loadPrompt('x'), 'v1');
      writeFileSync(file, 'v2');
      const st = statSync(file);
      utimesSync(file, new Date(st.mtimeMs + 5000), new Date(st.mtimeMs + 5000));
      assert.equal(loadPrompt('x'), 'v2');
    } finally {
      delete process.env.PROMPTS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('仓库 prompts 目录七个文件齐全且非空', () => {
    delete process.env.PROMPTS_DIR;
    for (const n of ['draft', 'search', 'report', 'wish-draft', 'wish-match-goods', 'wish-match-wish', 'risk']) {
      const p = loadPrompt(n);
      assert.ok(p && p.length > 20, `prompts/${n}.txt 缺失或过短`);
    }
  });
});
