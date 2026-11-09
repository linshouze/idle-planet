import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../src/errors.ts';
import type { AiConfig, ChatOptions } from '../src/services/ai.ts';
import {
  closeWish,
  createDirectMatch,
  createWish,
  fulfillWish,
  fulfilledPrompt,
  inviteWisher,
  listWishes,
  markWishesSeen,
  matchItemToWishes,
  matchWishToItems,
  queueItemMatch,
  renewWish,
  wishState,
  wishUpdates,
} from '../src/services/wish.ts';
import { addItem, addUser, itemStatus, memDb } from './helpers.ts';

// 测试文件独立进程：设置假 key 让 aiConfig() 非空，AI 调用全部走 mock。
process.env.AI_API_KEY = 'test-key';
let nextReply: string | null = null;
const mockChat = async (_cfg: AiConfig, _opts: ChatOptions): Promise<string | null> => nextReply;

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code, `expected AppError ${code}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('心愿生命周期', () => {
  it('进行中心愿最多 5 个，关闭后可再发', () => {
    const db = memDb();
    const u = addUser(db, 'W1');
    for (let i = 1; i <= 5; i++) createWish(db, u, `心愿${i}`, 100, false);
    assertCode(() => createWish(db, u, '第 6 个', null, false), 'WISH_LIMIT');
    const list = listWishes(db, u, 'mine');
    closeWish(db, u, list.wishes[0]!.id);
    createWish(db, u, '第 6 个', null, false); // 不再报错
  });

  it('14 天过期：不在全部心愿展示、可续期、未过期续期报错', () => {
    const db = memDb();
    const u = addUser(db, 'W1');
    const other = addUser(db, 'O1');
    const id = createWish(db, u, '旧心愿', 50, true);
    db.prepare("UPDATE wishes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 days') WHERE id = ?").run(id);
    const w = db.prepare('SELECT * FROM wishes WHERE id = ?').get(id) as Parameters<typeof wishState>[0];
    assert.equal(wishState(w), 'expired');
    assert.equal(listWishes(db, other, 'all').wishes.length, 0);
    assertCode(() => renewWish(db, other, id), 'FORBIDDEN');
    renewWish(db, u, id);
    assert.equal(wishState(db.prepare('SELECT * FROM wishes WHERE id = ?').get(id) as typeof w), 'active');
    assertCode(() => renewWish(db, u, id), 'NOT_EXPIRED');
    assert.equal(listWishes(db, other, 'all').wishes.length, 1);
  });

  it('关闭/实现后为终态，他人不能操作', () => {
    const db = memDb();
    const u = addUser(db, 'W1');
    const other = addUser(db, 'O1');
    const id = createWish(db, u, '心愿', null, false);
    assertCode(() => fulfillWish(db, other, id), 'FORBIDDEN');
    fulfillWish(db, u, id);
    assertCode(() => closeWish(db, u, id), 'INVALID_STATE');
  });
});

describe('小星匹配', () => {
  it('货找人：只保留 strong，丢弃幻觉 id 和 weak，写匹配完成时间', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const w1 = addUser(db, 'W1');
    const w2 = addUser(db, 'W2');
    const wish1 = createWish(db, w1, '想要显示器支架', 100, false);
    const wish2 = createWish(db, w2, '想要机械键盘', 300, false);
    const item = addItem(db, seller, '显示器支架 铝合金');

    nextReply = JSON.stringify({
      matches: [
        { id: wish1, level: 'strong', reason: '正是显示器支架且在预算内' },
        { id: wish2, level: 'weak', reason: '品类不同' },
        { id: 9999, level: 'strong', reason: '幻觉 id' },
      ],
    });
    await matchItemToWishes(db, item, mockChat);

    const matches = db.prepare('SELECT * FROM wish_matches WHERE item_id = ?').all(item) as { wish_id: number; reason: string }[];
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.wish_id, wish1);
    const matched = db.prepare('SELECT wish_matched_at FROM items WHERE id = ?').get(item) as { wish_matched_at: string | null };
    assert.ok(matched.wish_matched_at);
  });

  it('不匹配卖家自己的心愿', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const own = createWish(db, seller, '想要显示器支架', 100, false);
    const item = addItem(db, seller, '显示器支架');
    nextReply = JSON.stringify({ matches: [{ id: own, level: 'strong', reason: '自己的心愿' }] });
    await matchItemToWishes(db, item, mockChat);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM wish_matches').get() as { n: number }).n, 0);
  });

  it('人找货：新心愿匹配在售商品，排除自己的商品，最多 5 个', async () => {
    const db = memDb();
    const buyer = addUser(db, 'B1');
    const s1 = addUser(db, 'S1');
    const own = addItem(db, buyer, '自己的支架');
    const a = addItem(db, s1, '显示器支架 A');
    const b = addItem(db, s1, '显示器支架 B');
    const wish = createWish(db, buyer, '想要显示器支架', 100, false);
    nextReply = JSON.stringify({
      matches: [
        { id: a, level: 'strong', reason: '支架且在预算内' },
        { id: own, level: 'strong', reason: '自己的商品不应在送入集合' },
        { id: b, level: 'strong', reason: '另一个支架' },
      ],
    });
    await matchWishToItems(db, wish, mockChat);
    const ids = (db.prepare('SELECT item_id FROM wish_matches WHERE wish_id = ?').all(wish) as { item_id: number }[]).map((x) => x.item_id);
    assert.deepEqual(ids.sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  });

  it('AI 不可用时不产生匹配，但匹配完成时间仍写入（前端结束加载态）', async () => {
    delete process.env.AI_API_KEY;
    try {
      const db = memDb();
      const seller = addUser(db, 'S1');
      const w1 = addUser(db, 'W1');
      createWish(db, w1, '想要显示器支架', 100, false);
      const item = addItem(db, seller, '显示器支架');
      await matchItemToWishes(db, item, mockChat);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM wish_matches').get() as { n: number }).n, 0);
      const row = db.prepare('SELECT wish_matched_at FROM items WHERE id = ?').get(item) as { wish_matched_at: string | null };
      assert.ok(row.wish_matched_at);
    } finally {
      process.env.AI_API_KEY = 'test-key';
    }
  });

  it('「我有这个」直接建立匹配，不经 AI', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const w1 = addUser(db, 'W1');
    const wish = createWish(db, w1, '想要显示器支架', 100, false);
    const item = addItem(db, seller, '显示器支架');
    nextReply = null;
    createDirectMatch(db, wish, item);
    const m = db.prepare('SELECT origin, reason FROM wish_matches WHERE wish_id = ?').get(wish) as { origin: string; reason: string };
    assert.equal(m.origin, 'direct');
  });

  it('异步队列：queueItemMatch 在后台完成匹配', async () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const w1 = addUser(db, 'W1');
    createWish(db, w1, '想要显示器支架', 100, false);
    const item = addItem(db, seller, '显示器支架');
    nextReply = JSON.stringify({ matches: [] });
    queueItemMatch(db, item, mockChat);
    await wait(30);
    const row = db.prepare('SELECT wish_matched_at FROM items WHERE id = ?').get(item) as { wish_matched_at: string | null };
    assert.ok(row.wish_matched_at);
  });
});

describe('邀请与未读', () => {
  function setup(db: DatabaseSync) {
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const stranger = addUser(db, 'X1');
    const wish = createWish(db, buyer, '想要显示器支架', 100, false);
    const item = addItem(db, seller, '显示器支架');
    createDirectMatch(db, wish, item);
    const matchId = (db.prepare('SELECT id FROM wish_matches LIMIT 1').get() as { id: number }).id;
    return { seller, buyer, stranger, wish, item, matchId };
  }

  it('只有卖家能邀请，且只能邀请一次', () => {
    const db = memDb();
    const { seller, buyer, stranger, matchId } = setup(db);
    assertCode(() => inviteWisher(db, stranger, matchId), 'FORBIDDEN');
    assertCode(() => inviteWisher(db, buyer, matchId), 'FORBIDDEN');
    inviteWisher(db, seller, matchId);
    assertCode(() => inviteWisher(db, seller, matchId), 'ALREADY_INVITED');
  });

  it('未读计数：新匹配 + 邀请计入，读过后清零；商品离开在售不计入', () => {
    const db = memDb();
    const { buyer, item } = setup(db);
    assert.equal(wishUpdates(db, buyer.id), 1);
    markWishesSeen(db, buyer);
    assert.equal(wishUpdates(db, buyer.id), 0);
    // 新匹配再次产生未读
    const s2 = addUser(db, 'S2');
    const item2 = addItem(db, s2, '另一个支架');
    createDirectMatch(db, (db.prepare('SELECT id FROM wishes LIMIT 1').get() as { id: number }).id, item2);
    assert.equal(wishUpdates(db, buyer.id), 1);
    // 商品被选走后不再计入未读
    db.prepare("UPDATE items SET status = 'locked' WHERE id = ?").run(item2);
    assert.equal(wishUpdates(db, buyer.id), 0);
    assert.equal(itemStatus(db, item), 'published');
  });

  it('心愿列表不泄露联系方式', () => {
    const db = memDb();
    const { buyer } = setup(db);
    db.prepare("UPDATE users SET contact = 'secret-contact-123' WHERE id = ?").run(buyer.id);
    const json = JSON.stringify(listWishes(db, addUser(db, 'V1'), 'all'));
    assert.ok(!json.includes('secret-contact-123'));
  });

  it('确认收货提示：命中进行中心愿时返回，实现后心愿 fulfilled', () => {
    const db = memDb();
    const { buyer, item, wish } = setup(db);
    const prompt = fulfilledPrompt(db, buyer.id, item);
    assert.equal(prompt?.wishId, wish);
    fulfillWish(db, buyer, wish);
    assert.equal(fulfilledPrompt(db, buyer.id, item), null);
  });
});

describe('编辑商品后重新匹配', () => {
  it('编辑清掉旧 ai 匹配并重新跑（direct 保留）', async () => {
    delete process.env.AI_API_KEY;
    try {
      const db = memDb();
      const seller = addUser(db, 'S1');
      const w1 = addUser(db, 'W1');
      const w2 = addUser(db, 'W2');
      const wish = createWish(db, w1, '想要二手手机', 500, false);
      const wish2 = createWish(db, w2, '想要手机相关的东西', 300, false);
      const item = addItem(db, seller, '手机信息');
      createDirectMatch(db, wish, item); // 「我有这个」语义绑定
      db.prepare("INSERT INTO wish_matches (wish_id, item_id, reason, origin) VALUES (?, ?, '旧的 ai 匹配', 'ai')").run(wish2, item);
      db.prepare('UPDATE items SET wish_matched_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', item);

      const upd = db.prepare("UPDATE items SET title = '二手苹果手机' WHERE id = ?").run(item);
      if (Number(upd.changes) !== 1) throw new Error('simulated edit failed');
      // 复现 app.ts PATCH 路由的清理+重排队逻辑（无 key 路径：匹配完成时间仍会写入）
      db.prepare("DELETE FROM wish_matches WHERE item_id = ? AND origin = 'ai'").run(item);
      db.prepare('UPDATE items SET wish_matched_at = NULL WHERE id = ?').run(item);
      queueItemMatch(db, item, mockChat);
      await wait(30);

      const matches = db.prepare('SELECT origin FROM wish_matches WHERE item_id = ?').all(item) as { origin: string }[];
      assert.deepEqual(matches.map((m) => m.origin).sort(), ['direct']); // 别人心愿的旧 ai 被清、direct 保留、无 key 不产生新 ai
      const row = db.prepare('SELECT wish_matched_at FROM items WHERE id = ?').get(item) as { wish_matched_at: string | null };
      assert.ok(row.wish_matched_at); // 重跑后完成时间重新写入
    } finally {
      process.env.AI_API_KEY = 'test-key';
    }
  });
});
