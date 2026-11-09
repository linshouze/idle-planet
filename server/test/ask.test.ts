import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import type { AiConfig, ChatOptions } from '../src/services/ai.ts';
import { ASK_LIMIT, askCount } from '../src/services/ask.ts';
import type { Env } from '../src/types.ts';
import type { Actor } from '../src/services/deal.ts';
import { addUser, addItem, memDb } from './helpers.ts';

// 测试文件独立进程：设置假 key 让 aiConfig() 非空，AI 调用全部走 mock。
process.env.AI_API_KEY = 'test-key';
let nextReply: string | null = null;
const mockChat = async (_cfg: AiConfig, _opts: ChatOptions): Promise<string | null> => nextReply;

const KNOWN_TRUE = { answer: '描述里写了带接收器，配件齐全。', known: true };
const KNOWN_FALSE = { answer: '商品信息里没提到电池续航，建议在申请留言里问卖家。', known: false };

interface AskBody {
  available: boolean;
  answer?: string;
  known?: boolean;
  questionId?: number;
  error?: { code: string };
}

interface BuyerDetailView {
  viewer: string;
  myQuestions: { question: string; answer: string; known: boolean; createdAt: string }[];
  canAsk: number;
}

interface SellerDetailView {
  viewer: string;
  questions: Record<string, unknown>[];
}

let db: DatabaseSync;
let dir: string;
let app: Hono<Env>;
let seller: Actor;
let buyerA: Actor;
let buyerB: Actor;
let itemId: number;
let sellerCookie: string;
let cookieA: string;
let cookieB: string;

async function login(employeeNo: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeNo }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function ask(cookie: string, id: number, question: string): Promise<Response> {
  return app.request(`/api/items/${id}/ask`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
}

async function detail(cookie: string, id: number): Promise<Response> {
  return app.request(`/api/items/${id}`, { headers: { Cookie: cookie } });
}

function questionRows() {
  return db.prepare('SELECT * FROM item_questions').all() as {
    id: number;
    item_id: number;
    asker_id: number;
    question: string;
    answer: string;
    known: number;
  }[];
}

beforeEach(async () => {
  nextReply = null;
  dir = mkdtempSync(join(tmpdir(), 'idle-planet-ask-'));
  db = memDb();
  seller = addUser(db, 'S1');
  buyerA = addUser(db, 'B2');
  buyerB = addUser(db, 'B3');
  itemId = addItem(db, seller, '罗技 M720 无线鼠标');
  app = createApp(db, { uploadDir: dir, cookieSecure: false, aiChat: mockChat });
  sellerCookie = await login('S1');
  cookieA = await login('B2');
  cookieB = await login('B3');
});

describe('F12 POST /api/items/:id/ask', () => {
  it('known=true：返回 answer/known/questionId 并写库，买家详情出现 myQuestions 且 canAsk 减一', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    const res = await ask(cookieA, itemId, '配件齐全吗');
    assert.equal(res.status, 200);
    const body = (await res.json()) as AskBody;
    assert.equal(body.available, true);
    assert.equal(body.answer, KNOWN_TRUE.answer);
    assert.equal(body.known, true);
    assert.ok(Number.isInteger(body.questionId));

    const rows = questionRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.item_id, itemId);
    assert.equal(rows[0]!.asker_id, buyerA.id);
    assert.equal(rows[0]!.question, '配件齐全吗');
    assert.equal(rows[0]!.answer, KNOWN_TRUE.answer);
    assert.equal(rows[0]!.known, 1);

    const view = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    assert.equal(view.viewer, 'buyer');
    assert.equal(view.myQuestions.length, 1);
    assert.equal(view.myQuestions[0]!.question, '配件齐全吗');
    assert.equal(view.myQuestions[0]!.answer, KNOWN_TRUE.answer);
    assert.equal(view.myQuestions[0]!.known, true);
    assert.ok(view.myQuestions[0]!.createdAt);
    assert.equal(view.canAsk, ASK_LIMIT - 1);
  });

  it('known=false：同样写库并返回（回答只给提问者本人看）', async () => {
    nextReply = JSON.stringify(KNOWN_FALSE);
    const res = await ask(cookieA, itemId, '电池能用多久');
    const body = (await res.json()) as AskBody;
    assert.equal(body.available, true);
    assert.equal(body.known, false);
    assert.equal(body.answer, KNOWN_FALSE.answer);
    assert.equal(questionRows()[0]!.known, 0);

    const view = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    assert.equal(view.myQuestions[0]!.known, false);
    assert.equal(view.canAsk, ASK_LIMIT - 1);
  });

  it('第 6 次提问 → 409 QUESTION_LIMIT，canAsk 归 0', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    for (let i = 0; i < ASK_LIMIT; i++) {
      const ok = await ask(cookieA, itemId, `问题 ${i + 1}`);
      assert.equal(((await ok.json()) as AskBody).available, true);
    }
    assert.equal(askCount(db, itemId, buyerA.id), ASK_LIMIT);
    const sixth = await ask(cookieA, itemId, '第六个问题');
    assert.equal(sixth.status, 409);
    assert.equal(((await sixth.json()) as AskBody).error!.code, 'QUESTION_LIMIT');
    assert.equal(questionRows().length, ASK_LIMIT);

    const view = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    assert.equal(view.canAsk, 0);
    // 别人的次数不受影响
    assert.equal(askCount(db, itemId, buyerB.id), 0);
  });

  it('卖家问自己的商品 → 403 FORBIDDEN', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    const res = await ask(sellerCookie, itemId, '这个还有人问吗');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as AskBody).error!.code, 'FORBIDDEN');
    assert.equal(questionRows().length, 0);
  });

  it('商品非 published → 409 INVALID_STATE', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    const off = await app.request(`/api/items/${itemId}/withdraw`, { method: 'POST', headers: { Cookie: sellerCookie } });
    assert.equal(off.status, 200);
    const res = await ask(cookieA, itemId, '还在吗');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as AskBody).error!.code, 'INVALID_STATE');
    assert.equal(questionRows().length, 0);
  });

  it('AI 超时/输出不合法 → available:false，不写库、不占次数', async () => {
    for (const reply of [null, '小星暂时说不出 JSON', '{"known":true}', '{"answer":"  ","known":true}']) {
      nextReply = reply;
      const res = await ask(cookieA, itemId, '配件齐全吗');
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as AskBody).available, false);
    }
    assert.equal(questionRows().length, 0);
    const view = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    assert.equal(view.canAsk, ASK_LIMIT);
  });

  it('无 AI key → available:false，不写库', async () => {
    const had = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    try {
      nextReply = JSON.stringify(KNOWN_TRUE);
      const res = await ask(cookieA, itemId, '配件齐全吗');
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as AskBody).available, false);
      assert.equal(questionRows().length, 0);
    } finally {
      process.env.AI_API_KEY = had!;
    }
  });

  it('回答里出现卖家联系方式 → 按不可用处理，不落库（原则 3 兜底）', async () => {
    nextReply = JSON.stringify({ answer: '可以直接加微信 im-S1 问卖家。', known: true });
    const res = await ask(cookieA, itemId, '怎么联系卖家');
    assert.equal(((await res.json()) as AskBody).available, false);
    assert.equal(questionRows().length, 0);
    // 正常回答不含联系方式
    nextReply = JSON.stringify(KNOWN_TRUE);
    const ok = (await (await ask(cookieA, itemId, '配件齐全吗')).json()) as AskBody;
    assert.equal(ok.available, true);
    assert.equal(ok.answer!.includes('im-S1'), false);
  });

  it('入参校验：空问题 / 超过 60 字 / ID 不合法 → 400；商品不存在 → 404', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    const empty = await ask(cookieA, itemId, '   ');
    assert.equal(empty.status, 400);
    const long = await ask(cookieA, itemId, '问'.repeat(61));
    assert.equal(long.status, 400);
    const badId = await ask(cookieA, 0, '配件齐全吗');
    assert.equal(badId.status, 400);
    const missing = await ask(cookieA, 99999, '配件齐全吗');
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as AskBody).error!.code, 'NOT_FOUND');
    assert.equal(questionRows().length, 0);
  });

  it('未登录 → 401', async () => {
    const res = await app.request(`/api/items/${itemId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '配件齐全吗' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('F12 匿名与隔离', () => {
  it('卖家视图匿名：JSON 全文不含提问者姓名/工号/id，questions 只有 question/known/createdAt', async () => {
    nextReply = JSON.stringify(KNOWN_FALSE);
    const asked = await ask(cookieA, itemId, '电池能用多久');
    assert.equal(((await asked.json()) as AskBody).available, true);

    const res = await detail(sellerCookie, itemId);
    const raw = await res.json();
    const text = JSON.stringify(raw);
    const view = raw as SellerDetailView;
    assert.equal(view.viewer, 'seller');
    assert.equal(view.questions.length, 1);
    // 提问者身份三要素全部不出现（姓名「员工B2」、工号 B2、任何 asker 字段）
    assert.equal(text.includes('员工B2'), false);
    assert.equal(text.includes('B2'), false);
    assert.equal(text.includes('asker'), false);
    assert.equal(text.toLowerCase().includes('askerid'), false);
    // 问题条目字段白名单：只有 question/known/createdAt，id 无从泄露
    assert.deepEqual(Object.keys(view.questions[0]!).sort(), ['createdAt', 'known', 'question']);
    assert.equal(view.questions[0]!.question, '电池能用多久');
    assert.equal(view.questions[0]!.known, false);
    // 卖家的 questions 里没有回答文本（回答只给提问者本人看）
    assert.equal(text.includes(KNOWN_FALSE.answer), false);
  });

  it('买家隔离：A 的问答不出现在 B 的 myQuestions，互相看不到对方的回答', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    await ask(cookieA, itemId, '配件齐全吗');
    nextReply = JSON.stringify(KNOWN_FALSE);
    await ask(cookieB, itemId, '电池能用多久');

    const viewA = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    const viewB = (await (await detail(cookieB, itemId)).json()) as BuyerDetailView;
    assert.deepEqual(
      viewA.myQuestions.map((q) => q.question),
      ['配件齐全吗'],
    );
    assert.deepEqual(
      viewB.myQuestions.map((q) => q.question),
      ['电池能用多久'],
    );
    assert.equal(JSON.stringify(viewA).includes(KNOWN_FALSE.answer), false);
    assert.equal(JSON.stringify(viewB).includes(KNOWN_TRUE.answer), false);
    assert.equal(viewA.canAsk, ASK_LIMIT - 1);
    assert.equal(viewB.canAsk, ASK_LIMIT - 1);

    // 卖家看到两条问题，依旧匿名
    const sellerView = (await (await detail(sellerCookie, itemId)).json()) as SellerDetailView;
    assert.equal(sellerView.questions.length, 2);
  });

  it('myQuestions 按时间倒序', async () => {
    nextReply = JSON.stringify(KNOWN_TRUE);
    await ask(cookieA, itemId, '第一问');
    await ask(cookieA, itemId, '第二问');
    const view = (await (await detail(cookieA, itemId)).json()) as BuyerDetailView;
    assert.deepEqual(
      view.myQuestions.map((q) => q.question),
      ['第二问', '第一问'],
    );
  });
});

describe('F12 迁移：老库兼容', () => {
  it('老库（无 item_questions 表）打开时自动补建', () => {
    const file = join(dir, 'old.db');
    const old = openDb(file);
    old.exec('DROP TABLE item_questions'); // 模拟升级前的库
    old.close();
    const reopened = openDb(file);
    assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_questions'").get());
    const cols = (reopened.prepare('PRAGMA table_info(item_questions)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'item_id', 'asker_id', 'question', 'answer', 'known', 'created_at']) assert.ok(cols.includes(c), c);
    reopened.close();
  });
});

// 临时目录清理放在进程退出前（node:test 无 afterAll 全局钩子时也能兜底）
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});
