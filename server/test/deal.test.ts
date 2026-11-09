import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { AppError } from '../src/errors.ts';
import {
  acceptRequest,
  cancelDeal,
  completeDeal,
  createRequest,
  forceComplete,
  hideItem,
  markHandedOver,
  rejectRequest,
  restoreItem,
  withdrawItem,
  withdrawRequest,
} from '../src/services/deal.ts';
import { addItem, addUser, itemStatus, memDb, requestStatus } from './helpers.ts';

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code, `expected AppError ${code}`);
}

describe('申请', () => {
  it('不能申请自己的商品', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const item = addItem(db, seller);
    assertCode(() => createRequest(db, seller, item), 'OWN_ITEM');
  });

  it('没有联系方式不能申请', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1', { contact: null });
    const item = addItem(db, seller);
    assertCode(() => createRequest(db, buyer, item), 'CONTACT_REQUIRED');
  });

  it('重复申请被拒绝，撤回后可以重新申请', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r1 = createRequest(db, buyer, item, '想要');
    assertCode(() => createRequest(db, buyer, item), 'ALREADY_REQUESTED');
    withdrawRequest(db, buyer, r1);
    assert.equal(requestStatus(db, r1), 'withdrawn');
    const r2 = createRequest(db, buyer, item, '再次申请');
    assert.equal(r2, r1);
    assert.equal(requestStatus(db, r2), 'pending');
  });

  it('只有申请人能撤回；卖家拒绝后不能再申请', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const other = addUser(db, 'B2');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    assertCode(() => withdrawRequest(db, other, r), 'FORBIDDEN');
    assertCode(() => rejectRequest(db, other, r), 'FORBIDDEN');
    rejectRequest(db, seller, r);
    assert.equal(requestStatus(db, r), 'rejected');
    assertCode(() => createRequest(db, buyer, item), 'ALREADY_REQUESTED');
  });
});

describe('选人与取消', () => {
  it('选人后商品锁定，其他申请被关闭，锁定后不能再申请', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    const b3 = addUser(db, 'B3');
    const item = addItem(db, seller);
    const r1 = createRequest(db, b1, item);
    const r2 = createRequest(db, b2, item);
    acceptRequest(db, seller, r1);
    assert.equal(itemStatus(db, item), 'locked');
    assert.equal(requestStatus(db, r1), 'accepted');
    assert.equal(requestStatus(db, r2), 'closed');
    assertCode(() => createRequest(db, b3, item), 'ITEM_NOT_AVAILABLE');
  });

  it('非发布者不能选人', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    assertCode(() => acceptRequest(db, buyer, r), 'FORBIDDEN');
    assertCode(() => acceptRequest(db, addUser(db, 'X'), r), 'FORBIDDEN');
    assert.equal(itemStatus(db, item), 'published');
  });

  it('取消交易后商品回到发布中，被关闭的申请恢复，可以改选他人', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    const item = addItem(db, seller);
    const r1 = createRequest(db, b1, item);
    const r2 = createRequest(db, b2, item);
    acceptRequest(db, seller, r1);
    cancelDeal(db, seller, r1);
    assert.equal(itemStatus(db, item), 'published');
    assert.equal(requestStatus(db, r1), 'cancelled');
    assert.equal(requestStatus(db, r2), 'pending');
    acceptRequest(db, seller, r2);
    assert.equal(itemStatus(db, item), 'locked');
    assert.equal(requestStatus(db, r2), 'accepted');
  });

  it('已交付后不能取消交易', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    acceptRequest(db, seller, r);
    markHandedOver(db, seller, r);
    assertCode(() => cancelDeal(db, seller, r), 'INVALID_STATE');
    assert.equal(itemStatus(db, item), 'handed_over');
  });
});

describe('交付与完成', () => {
  it('完整流程：买家不能代卖家交付，卖家不能代买家确认', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    acceptRequest(db, seller, r);

    assertCode(() => markHandedOver(db, buyer, r), 'FORBIDDEN');
    assertCode(() => completeDeal(db, buyer, r), 'INVALID_STATE'); // 还没交付
    markHandedOver(db, seller, r);
    assert.equal(itemStatus(db, item), 'handed_over');

    assertCode(() => completeDeal(db, seller, r), 'FORBIDDEN');
    completeDeal(db, buyer, r);
    assert.equal(itemStatus(db, item), 'completed');
    assert.equal(requestStatus(db, r), 'completed');

    assertCode(() => createRequest(db, addUser(db, 'B2'), item), 'ITEM_NOT_AVAILABLE');
    assertCode(() => markHandedOver(db, seller, r), 'INVALID_STATE');
  });

  it('管理员强制完成：只能在已交付后，普通员工不行', () => {
    const db = memDb();
    const admin = addUser(db, 'A1', { role: 'admin' });
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    acceptRequest(db, seller, r);
    assertCode(() => forceComplete(db, admin, r), 'INVALID_STATE');
    markHandedOver(db, seller, r);
    assertCode(() => forceComplete(db, seller, r), 'FORBIDDEN');
    forceComplete(db, admin, r);
    assert.equal(itemStatus(db, item), 'completed');
  });
});

describe('下架与隐藏', () => {
  it('下架：只有发布者、只能在发布中；待处理申请被关闭', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    assertCode(() => withdrawItem(db, buyer, item), 'FORBIDDEN');
    withdrawItem(db, seller, item);
    assert.equal(itemStatus(db, item), 'withdrawn');
    assert.equal(requestStatus(db, r), 'closed');
    assertCode(() => createRequest(db, addUser(db, 'B2'), item), 'ITEM_NOT_AVAILABLE');
  });

  it('交易中不能下架', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    acceptRequest(db, seller, r);
    assertCode(() => withdrawItem(db, seller, item), 'INVALID_STATE');
  });

  it('隐藏会关闭进行中的交易，恢复后申请回到待处理', () => {
    const db = memDb();
    const admin = addUser(db, 'A1', { role: 'admin' });
    const seller = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    const item = addItem(db, seller);
    const r1 = createRequest(db, b1, item);
    const r2 = createRequest(db, b2, item);
    acceptRequest(db, seller, r1);

    assertCode(() => hideItem(db, seller, item), 'FORBIDDEN');
    hideItem(db, admin, item, '违规');
    assert.equal(itemStatus(db, item), 'hidden');
    assert.equal(requestStatus(db, r1), 'closed');
    assert.equal(requestStatus(db, r2), 'closed');
    assertCode(() => createRequest(db, addUser(db, 'B3'), item), 'ITEM_NOT_AVAILABLE');

    restoreItem(db, admin, item);
    assert.equal(itemStatus(db, item), 'published');
    assert.equal(requestStatus(db, r1), 'pending');
    assert.equal(requestStatus(db, r2), 'pending');
  });

  it('已完成的商品不能被隐藏', () => {
    const db = memDb();
    const admin = addUser(db, 'A1', { role: 'admin' });
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    acceptRequest(db, seller, r);
    markHandedOver(db, seller, r);
    completeDeal(db, buyer, r);
    assertCode(() => hideItem(db, admin, item), 'INVALID_STATE');
  });
});

describe('并发保护', () => {
  it('两个数据库连接先后选人，只有第一个成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idle-planet-'));
    try {
      const file = join(dir, 'app.db');
      const dbA = openDb(file);
      const dbB = openDb(file);
      const seller = addUser(dbA, 'S1');
      const b1 = addUser(dbA, 'B1');
      const b2 = addUser(dbA, 'B2');
      const item = addItem(dbA, seller);
      const r1 = createRequest(dbA, b1, item);
      const r2 = createRequest(dbA, b2, item);

      acceptRequest(dbA, seller, r1);
      assertCode(() => acceptRequest(dbB, seller, r2), 'ITEM_NOT_AVAILABLE');

      const accepted = dbA.prepare("SELECT COUNT(*) AS n FROM deal_requests WHERE item_id = ? AND status = 'accepted'").get(item) as { n: number };
      assert.equal(accepted.n, 1);
      dbA.close();
      dbB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('唯一索引是最后防线：绕过服务层直接写入第二个 accepted 会失败', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const b1 = addUser(db, 'B1');
    const b2 = addUser(db, 'B2');
    const item = addItem(db, seller);
    const r1 = createRequest(db, b1, item);
    const r2 = createRequest(db, b2, item);
    acceptRequest(db, seller, r1);
    assert.throws(() => db.prepare("UPDATE deal_requests SET status = 'accepted' WHERE id = ?").run(r2), /UNIQUE/);
  });

  it('选人失败时整个事务回滚', () => {
    const db = memDb();
    const seller = addUser(db, 'S1');
    const buyer = addUser(db, 'B1');
    const item = addItem(db, seller);
    const r = createRequest(db, buyer, item);
    rejectRequest(db, seller, r); // r 已不是 pending
    assertCode(() => acceptRequest(db, seller, r), 'INVALID_STATE');
    assert.equal(itemStatus(db, item), 'published'); // 商品锁定被回滚
  });
});
