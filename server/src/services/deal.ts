import type { DatabaseSync } from 'node:sqlite';
import { AppError, forbidden, notFound } from '../errors.ts';
import { NOW, tx } from '../db/index.ts';

export interface Actor {
  id: number;
  role: 'employee' | 'admin';
}

interface ItemRow {
  id: number;
  seller_id: number;
  status: string;
}

interface RequestRow {
  id: number;
  item_id: number;
  buyer_id: number;
  status: string;
}

const changed = (r: { changes: number | bigint }): number => Number(r.changes);

function getItem(db: DatabaseSync, id: number): ItemRow | undefined {
  return db.prepare('SELECT id, seller_id, status FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
}

function getRequest(db: DatabaseSync, id: number): RequestRow | undefined {
  return db
    .prepare('SELECT id, item_id, buyer_id, status FROM deal_requests WHERE id = ?')
    .get(id) as unknown as RequestRow | undefined;
}

/** 读取申请和对应商品，并要求操作人是该商品的发布者。 */
function loadForSeller(db: DatabaseSync, actor: Actor, requestId: number): { req: RequestRow; item: ItemRow } {
  const req = getRequest(db, requestId);
  if (!req) throw notFound('申请');
  const item = getItem(db, req.item_id);
  if (!item) throw notFound('商品');
  if (item.seller_id !== actor.id) throw forbidden('只有商品发布者可以执行此操作');
  return { req, item };
}

/** F9 代谈附加信息：由路由层先经 negotiatedDeal() 校验后传入，随申请在同一事务落库。 */
export interface RequestExtras {
  agreedPrice?: number;
  negotiationId?: number;
  source?: string;
}

/** 买家提交申请。撤回过的申请可以重新申请。状态机不变：F9 只多写成交价/代谈关联/归因三列。 */
export function createRequest(db: DatabaseSync, actor: Actor, itemId: number, message?: string, extras?: RequestExtras): number {
  return tx(db, () => {
    const item = getItem(db, itemId);
    if (!item) throw notFound('商品');
    if (item.seller_id === actor.id) throw new AppError(400, 'OWN_ITEM', '不能申请自己发布的商品');
    if (item.status !== 'published') throw new AppError(409, 'ITEM_NOT_AVAILABLE', '该商品当前不可申请');

    const user = db.prepare('SELECT contact FROM users WHERE id = ?').get(actor.id) as { contact: string | null } | undefined;
    if (!user?.contact) throw new AppError(400, 'CONTACT_REQUIRED', '请先填写联系方式');

    const existing = db
      .prepare('SELECT id, status FROM deal_requests WHERE item_id = ? AND buyer_id = ?')
      .get(itemId, actor.id) as { id: number; status: string } | undefined;
    if (existing) {
      if (existing.status !== 'withdrawn') throw new AppError(409, 'ALREADY_REQUESTED', '你已申请过该商品');
      db.prepare(
        `UPDATE deal_requests SET status = 'pending', message = ?, close_reason = NULL, created_at = ${NOW},
           agreed_price = ?, negotiation_id = ?, source = ? WHERE id = ?`,
      ).run(message ?? null, extras?.agreedPrice ?? null, extras?.negotiationId ?? null, extras?.source ?? 'normal', existing.id);
      if (extras?.negotiationId) markNegotiationUsed(db, extras.negotiationId);
      return existing.id;
    }
    const r = db
      .prepare('INSERT INTO deal_requests (item_id, buyer_id, message, agreed_price, negotiation_id, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, actor.id, message ?? null, extras?.agreedPrice ?? null, extras?.negotiationId ?? null, extras?.source ?? 'normal');
    if (extras?.negotiationId) markNegotiationUsed(db, extras.negotiationId);
    return Number(r.lastInsertRowid);
  });
}

/** 申请落库成功后把代谈标记为已使用（同一事务内执行）。 */
function markNegotiationUsed(db: DatabaseSync, negotiationId: number): void {
  db.prepare("UPDATE negotiations SET status = 'used' WHERE id = ? AND status = 'deal'").run(negotiationId);
}

/** 买家撤回尚未处理的申请。 */
export function withdrawRequest(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    const req = getRequest(db, requestId);
    if (!req) throw notFound('申请');
    if (req.buyer_id !== actor.id) throw forbidden('只有申请人可以撤回申请');
    const r = db.prepare("UPDATE deal_requests SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").run(requestId);
    if (changed(r) !== 1) throw new AppError(409, 'INVALID_STATE', '该申请已处理，不能撤回');
  });
}

/** 卖家拒绝一个待处理申请。 */
export function rejectRequest(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    loadForSeller(db, actor, requestId);
    const r = db.prepare("UPDATE deal_requests SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(requestId);
    if (changed(r) !== 1) throw new AppError(409, 'INVALID_STATE', '该申请不是待处理状态');
  });
}

/** 卖家选人：商品进入 locked，其他待处理申请关闭。 */
export function acceptRequest(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    const { req } = loadForSeller(db, actor, requestId);
    const lock = db
      .prepare(`UPDATE items SET status = 'locked', updated_at = ${NOW} WHERE id = ? AND status = 'published'`)
      .run(req.item_id);
    if (changed(lock) !== 1) throw new AppError(409, 'ITEM_NOT_AVAILABLE', '商品当前不可选人，可能已有交易对象');
    const accepted = db
      .prepare(`UPDATE deal_requests SET status = 'accepted', accepted_at = ${NOW} WHERE id = ? AND status = 'pending'`)
      .run(requestId);
    if (changed(accepted) !== 1) throw new AppError(409, 'INVALID_STATE', '该申请不是待处理状态');
    db.prepare(
      "UPDATE deal_requests SET status = 'closed', close_reason = 'item_locked' WHERE item_id = ? AND status = 'pending' AND id != ?",
    ).run(req.item_id, requestId);
  });
}

/** 卖家取消交易：商品回到 published，因选人被关闭的申请恢复为待处理。只能在尚未交付时取消。 */
export function cancelDeal(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    const { req } = loadForSeller(db, actor, requestId);
    const cancelled = db
      .prepare(`UPDATE deal_requests SET status = 'cancelled', cancelled_at = ${NOW} WHERE id = ? AND status = 'accepted' AND handed_over_at IS NULL`)
      .run(requestId);
    if (changed(cancelled) !== 1) throw new AppError(409, 'INVALID_STATE', '只有尚未交付的交易可以取消');
    const unlock = db
      .prepare(`UPDATE items SET status = 'published', updated_at = ${NOW} WHERE id = ? AND status = 'locked'`)
      .run(req.item_id);
    if (changed(unlock) !== 1) throw new AppError(409, 'INVALID_STATE', '商品状态异常，无法取消');
    db.prepare(
      "UPDATE deal_requests SET status = 'pending', close_reason = NULL WHERE item_id = ? AND status = 'closed' AND close_reason = 'item_locked'",
    ).run(req.item_id);
  });
}

/** 卖家标记已交付。 */
export function markHandedOver(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    const { req } = loadForSeller(db, actor, requestId);
    const r = db
      .prepare(`UPDATE deal_requests SET handed_over_at = ${NOW} WHERE id = ? AND status = 'accepted' AND handed_over_at IS NULL`)
      .run(requestId);
    if (changed(r) !== 1) throw new AppError(409, 'INVALID_STATE', '该交易不能标记交付');
    const item = db
      .prepare(`UPDATE items SET status = 'handed_over', updated_at = ${NOW} WHERE id = ? AND status = 'locked'`)
      .run(req.item_id);
    if (changed(item) !== 1) throw new AppError(409, 'INVALID_STATE', '商品状态异常，无法标记交付');
  });
}

function finishDeal(db: DatabaseSync, requestId: number, itemId: number): void {
  const r = db
    .prepare(`UPDATE deal_requests SET status = 'completed', completed_at = ${NOW} WHERE id = ? AND status = 'accepted' AND handed_over_at IS NOT NULL`)
    .run(requestId);
  if (changed(r) !== 1) throw new AppError(409, 'INVALID_STATE', '该交易还不能确认完成');
  const item = db
    .prepare(`UPDATE items SET status = 'completed', completed_at = ${NOW}, updated_at = ${NOW} WHERE id = ? AND status = 'handed_over'`)
    .run(itemId);
  if (changed(item) !== 1) throw new AppError(409, 'INVALID_STATE', '商品状态异常，无法完成');
}

/** 买家确认收到，交易完成。 */
export function completeDeal(db: DatabaseSync, actor: Actor, requestId: number): void {
  tx(db, () => {
    const req = getRequest(db, requestId);
    if (!req) throw notFound('申请');
    if (req.buyer_id !== actor.id) throw forbidden('只有被选中的申请人可以确认完成');
    finishDeal(db, requestId, req.item_id);
  });
}

/** 管理员强制完成已交付但买家长期未确认的交易。 */
export function forceComplete(db: DatabaseSync, actor: Actor, requestId: number): void {
  if (actor.role !== 'admin') throw forbidden('仅管理员可以强制完成');
  tx(db, () => {
    const req = getRequest(db, requestId);
    if (!req) throw notFound('申请');
    finishDeal(db, requestId, req.item_id);
  });
}

/** 卖家下架：只能在 published 状态，待处理申请关闭。 */
export function withdrawItem(db: DatabaseSync, actor: Actor, itemId: number): void {
  tx(db, () => {
    const item = getItem(db, itemId);
    if (!item) throw notFound('商品');
    if (item.seller_id !== actor.id) throw forbidden('只有商品发布者可以下架');
    const r = db.prepare(`UPDATE items SET status = 'withdrawn', updated_at = ${NOW} WHERE id = ? AND status = 'published'`).run(itemId);
    if (changed(r) !== 1) throw new AppError(409, 'INVALID_STATE', '只有发布中的商品可以下架，交易中请先取消交易');
    db.prepare("UPDATE deal_requests SET status = 'closed', close_reason = 'item_withdrawn' WHERE item_id = ? AND status = 'pending'").run(itemId);
  });
}

/** 管理员隐藏任何未结束的商品。待处理申请和进行中的交易都会被关闭，恢复时重新打开。 */
export function hideItem(db: DatabaseSync, actor: Actor, itemId: number, reason?: string): void {
  if (actor.role !== 'admin') throw forbidden('仅管理员可以隐藏商品');
  tx(db, () => {
    const r = db
      .prepare(
        `UPDATE items SET status = 'hidden', hidden_reason = ?, updated_at = ${NOW} WHERE id = ? AND status IN ('published', 'locked', 'handed_over')`,
      )
      .run(reason ?? null, itemId);
    if (changed(r) !== 1) {
      if (!getItem(db, itemId)) throw notFound('商品');
      throw new AppError(409, 'INVALID_STATE', '该商品已结束或已被隐藏');
    }
    // 选人时因 item_locked 被关闭的申请也改记为 item_hidden，这样恢复商品时能一并重新打开。
    db.prepare(
      `UPDATE deal_requests SET status = 'closed', close_reason = 'item_hidden'
       WHERE item_id = ? AND (status IN ('pending', 'accepted') OR (status = 'closed' AND close_reason = 'item_locked'))`,
    ).run(itemId);
  });
}

/** 管理员恢复被隐藏的商品。被隐藏时关闭的申请恢复为待处理，卖家需要重新选人。 */
export function restoreItem(db: DatabaseSync, actor: Actor, itemId: number): void {
  if (actor.role !== 'admin') throw forbidden('仅管理员可以恢复商品');
  tx(db, () => {
    const r = db
      .prepare(`UPDATE items SET status = 'published', hidden_reason = NULL, updated_at = ${NOW} WHERE id = ? AND status = 'hidden'`)
      .run(itemId);
    if (changed(r) !== 1) {
      if (!getItem(db, itemId)) throw notFound('商品');
      throw new AppError(409, 'INVALID_STATE', '只有被隐藏的商品可以恢复');
    }
    db.prepare(
      "UPDATE deal_requests SET status = 'pending', close_reason = NULL, accepted_at = NULL, handed_over_at = NULL WHERE item_id = ? AND status = 'closed' AND close_reason = 'item_hidden'",
    ).run(itemId);
  });
}
