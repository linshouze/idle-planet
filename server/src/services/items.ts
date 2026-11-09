import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ItemInput, ListQuery } from '../../../shared/schemas.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { NOW, tx, VOUCHER_CATEGORY } from '../db/index.ts';
import { all, likePattern, one } from '../db/query.ts';
import type { Actor } from './deal.ts';
import { ASK_LIMIT, askCount } from './ask.ts';
import { resolveRiskForPublish, type RiskPublishMeta } from './risk.ts';
import { negotiationEntry } from './negotiation.ts';
import { maybeRetryItemMatch, wishMatchesForItem } from './wish.ts';

const imageUrl = (file: string): string => `/api/uploads/${file}`;

interface CardRow {
  id: number;
  title: string;
  price: number;
  original_price: number | null;
  trade_type: string;
  condition: string;
  status: string;
  published_at: string;
  seller_name: string;
  seller_department: string | null;
  category_name: string;
  cover: string | null;
  request_count: number;
  negotiable: number;
  kind: string;
  handoff_mode: string;
  expires_on: string | null;
  listing_group: string | null;
  group_remaining: number;
}

const toCard = (r: CardRow) => ({
  id: r.id,
  title: r.title,
  price: r.price,
  originalPrice: r.original_price,
  tradeType: r.trade_type,
  condition: r.condition,
  status: r.status,
  publishedAt: r.published_at,
  sellerName: r.seller_name,
  sellerDepartment: r.seller_department,
  categoryName: r.category_name,
  cover: r.cover ? imageUrl(r.cover) : null,
  requestCount: r.request_count,
  negotiable: r.negotiable === 1, // F9 可代谈（布尔，不含底价）
  // F16 券·权益
  kind: r.kind,
  handoffMode: r.handoff_mode,
  expiresOn: r.expires_on,
  listingGroup: r.listing_group,
  groupRemaining: r.listing_group ? r.group_remaining : undefined, // 同组在售张数（非组商品不带）
});

/** 底价本身（negotiation_floor）只进卖家本人可见的查询；卡片只带布尔 negotiable。 */
const NEGOTIABLE_SQL = `CASE WHEN i.trade_type = 'fixed' AND i.negotiation_floor IS NOT NULL THEN 1 ELSE 0 END AS negotiable`;

/** F16 同组折叠代表行：组内第一件 published；全组不在售时取组内最小 id（按普通非在售商品展示）。 */
const GROUP_REPRESENTATIVE_SQL = `(i.listing_group IS NULL OR i.id = COALESCE(
   (SELECT MIN(g.id) FROM items g WHERE g.listing_group = i.listing_group AND g.status = 'published'),
   (SELECT MIN(g.id) FROM items g WHERE g.listing_group = i.listing_group)))`;

/** 同组在售张数（未分组的行恒为 0，展示层忽略）。 */
const GROUP_REMAINING_SQL = `(SELECT COUNT(*) FROM items g WHERE g.listing_group IS NOT NULL AND g.listing_group = i.listing_group AND g.status = 'published') AS group_remaining`;

const CARD_SELECT = `
  SELECT i.id, i.title, i.price, i.original_price, i.trade_type, i.condition, i.status, i.published_at,
         i.kind, i.handoff_mode, i.expires_on, i.listing_group,
         u.name AS seller_name, u.department AS seller_department, c.name AS category_name,
         ${NEGOTIABLE_SQL},
         ${GROUP_REMAINING_SQL},
         (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover,
         (SELECT COUNT(*) FROM deal_requests r WHERE r.item_id = i.id AND r.status IN ('pending', 'accepted')) AS request_count
  FROM items i
  JOIN users u ON u.id = i.seller_id
  JOIN categories c ON c.id = i.category_id`;

function requireContact(db: DatabaseSync, userId: number): void {
  const u = one<{ contact: string | null }>(db, 'SELECT contact FROM users WHERE id = ?', [userId]);
  if (!u?.contact) throw new AppError(400, 'CONTACT_REQUIRED', '请先填写联系方式');
}

/** 校验图片都由本人上传且尚未被引用，然后绑定到商品。 */
function attachImages(db: DatabaseSync, actor: Actor, itemId: number, imageIds: number[]): void {
  const bind = db.prepare('UPDATE item_images SET item_id = ?, sort = ? WHERE id = ? AND uploader_id = ? AND (item_id IS NULL OR item_id = ?)');
  imageIds.forEach((id, i) => {
    if (Number(bind.run(itemId, i, id, actor.id, itemId).changes) !== 1) {
      throw new AppError(400, 'INVALID_IMAGE', '图片不存在或已被使用，请重新上传');
    }
  });
}

function requireEnabledCategory(db: DatabaseSync, categoryId: number): void {
  if (!one(db, 'SELECT 1 AS ok FROM categories WHERE id = ? AND enabled = 1', [categoryId])) {
    throw new AppError(400, 'INVALID_CATEGORY', '分类不存在或已停用');
  }
}

/** 券·权益分类固定为「券·权益」，返回其 id。 */
function voucherCategoryId(db: DatabaseSync): number {
  const row = one<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', [VOUCHER_CATEGORY]);
  if (!row) throw new AppError(400, 'INVALID_CATEGORY', '「券·权益」分类不存在');
  return row.id;
}

/** F16 的发布归一化：券类强制 new 成色、固定分类、线上转赠时交接地点存空串、代谈强制关闭、实物无有效期。 */
function normalizeInput(db: DatabaseSync, input: ItemInput): {
  categoryId: number;
  condition: string;
  floor: number | null;
  handoffMode: string;
  handoffLocation: string;
  expiresOn: string | null;
  quantity: number;
  isVoucher: boolean;
} {
  const isVoucher = (input.kind ?? 'goods') === 'voucher';
  const categoryId = isVoucher ? voucherCategoryId(db) : input.categoryId;
  requireEnabledCategory(db, categoryId);
  const handoffMode = isVoucher ? (input.handoffMode ?? 'offline') : 'offline';
  return {
    categoryId,
    condition: isVoucher ? 'new' : input.condition, // 券类无成色，库存 new
    // F9 底价：仅一口价实物可开（免费商品与券类强制关闭）
    floor: isVoucher || input.tradeType !== 'fixed' ? null : input.negotiationFloor ?? null,
    handoffMode,
    // 线上转赠不需要交接地点，库存空串
    handoffLocation: isVoucher && handoffMode === 'online' ? '' : input.handoffLocation,
    expiresOn: isVoucher ? input.expiresOn ?? null : null,
    quantity: isVoucher ? Math.min(10, Math.max(1, Math.round(input.quantity ?? 1))) : 1,
    isVoucher,
  };
}

const INSERT_ITEM_SQL = `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, original_price, negotiation_floor,
                             handoff_location, handoff_time, kind, handoff_mode, expires_on, listing_group,
                             ai_risk_type, ai_risk_reason, ai_risk_ack, ai_risk_checked, publish_mode, batch_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 数量 N 的券拆成 N 件相同商品共用一个 listing_group；每件独立走申请-选人流程，状态机与唯一索引不变。 */
function duplicateGroupImages(db: DatabaseSync, fromItemId: number, toItemId: number): void {
  db.prepare('INSERT INTO item_images (item_id, uploader_id, path, sort) SELECT ?, uploader_id, path, sort FROM item_images WHERE item_id = ? ORDER BY sort, id').run(
    toItemId,
    fromItemId,
  );
}

/** F1 清仓模式批次信息：同一次批量发布的商品共用一个 batch_id，publish_mode 记 batch。 */
export interface BatchMeta {
  batchId: string;
}

/** 发布。券类数量 >1 时拆成多件，返回全部 id（第一件为主商品）。 */
export function createItems(db: DatabaseSync, actor: Actor, input: ItemInput, risk?: RiskPublishMeta, batch?: BatchMeta): number[] {
  return tx(db, () => {
    requireContact(db, actor.id);
    // F2：校验 riskCheckId 归属与确认状态（warn 未确认时抛 409 RISK_ACK_REQUIRED），据此写入预警字段。
    const riskResult = resolveRiskForPublish(db, actor.id, risk);
    const v = normalizeInput(db, input);
    const listingGroup = v.quantity > 1 ? randomUUID() : null;
    const ids: number[] = [];
    for (let i = 0; i < v.quantity; i++) {
      const r = db
        .prepare(INSERT_ITEM_SQL)
        .run(
          actor.id, input.title, v.categoryId, input.description, v.condition, input.tradeType, input.price, input.originalPrice ?? null, v.floor,
          v.handoffLocation, input.handoffTime ?? null, input.kind ?? 'goods', v.handoffMode, v.expiresOn, listingGroup,
          riskResult.applied ? riskResult.type : null,
          riskResult.applied ? riskResult.reason : null,
          riskResult.applied ? riskResult.ack : 0,
          riskResult.applied ? riskResult.checked : 0,
          batch ? 'batch' : 'single',
          batch?.batchId ?? null,
        );
      ids.push(Number(r.lastInsertRowid));
    }
    attachImages(db, actor, ids[0], input.imageIds);
    // 同组其余各件复制首件的图片引用（同一文件可被多件商品引用）
    for (let i = 1; i < ids.length; i++) duplicateGroupImages(db, ids[0], ids[i]);
    return ids;
  });
}

/** 单件发布（quantity 恒为 1），返回商品 id。 */
export function createItem(db: DatabaseSync, actor: Actor, input: ItemInput, risk?: RiskPublishMeta, batch?: BatchMeta): number {
  return createItems(db, actor, input, risk, batch)[0];
}

/** 同组公共字段（编辑时同组一起改，各件的申请不受影响）。 */
const COMMON_FIELDS = `title = ?, category_id = ?, description = ?, condition = ?, trade_type = ?, price = ?, original_price = ?, negotiation_floor = ?,
  handoff_location = ?, handoff_time = ?, kind = ?, handoff_mode = ?, expires_on = ?, updated_at = ${NOW}`;

/** 仅发布者、仅发布中的商品可编辑。改底价只影响之后发起的代谈；同组券一起改公共字段。 */
export function updateItem(db: DatabaseSync, actor: Actor, itemId: number, input: ItemInput, risk?: RiskPublishMeta): void {
  tx(db, () => {
    const item = one<{ seller_id: number; status: string; listing_group: string | null }>(
      db,
      'SELECT seller_id, status, listing_group FROM items WHERE id = ?',
      [itemId],
    );
    if (!item) throw notFound('商品');
    if (item.seller_id !== actor.id) throw forbidden('只有商品发布者可以编辑');
    if (item.status !== 'published') throw new AppError(409, 'INVALID_STATE', '只有发布中的商品可以编辑');
    const v = normalizeInput(db, input);
    // F2：带有效 riskCheckId 时覆盖预警字段（新判定为 none 会清掉旧预警）；没带则保留原预警记录。
    const riskResult = resolveRiskForPublish(db, actor.id, risk);
    const riskSet = riskResult.applied ? ', ai_risk_type = ?, ai_risk_reason = ?, ai_risk_ack = ?, ai_risk_checked = ?' : '';
    const riskParams: SQLInputValue[] = riskResult.applied ? [riskResult.type, riskResult.reason, riskResult.ack, riskResult.checked] : [];
    const fieldParams: SQLInputValue[] = [
      input.title, v.categoryId, input.description, v.condition, input.tradeType, input.price, input.originalPrice ?? null, v.floor,
      v.handoffLocation, input.handoffTime ?? null, input.kind ?? 'goods', v.handoffMode, v.expiresOn,
    ];
    db.prepare(`UPDATE items SET ${COMMON_FIELDS}${riskSet} WHERE id = ?`).run(...fieldParams, ...riskParams, itemId);
    // 同组券一起改公共字段（listing_group 拆分后不再增减件数，各件的申请不受影响）
    if (item.listing_group) {
      db.prepare(`UPDATE items SET ${COMMON_FIELDS}${riskSet} WHERE listing_group = ? AND id != ?`).run(
        ...fieldParams,
        ...riskParams,
        item.listing_group,
        itemId,
      );
      // 图片重新绑定首件后复制到同组其余各件
      const members = all<{ id: number }>(db, 'SELECT id FROM items WHERE listing_group = ? AND id != ?', [item.listing_group, itemId]);
      db.prepare('UPDATE item_images SET item_id = NULL WHERE item_id = ?').run(itemId);
      attachImages(db, actor, itemId, input.imageIds);
      for (const m of members) {
        db.prepare('UPDATE item_images SET item_id = NULL WHERE item_id = ?').run(m.id);
        if (input.imageIds.length > 0) duplicateGroupImages(db, itemId, m.id);
      }
    } else {
      // 被移除的图片解除引用，留给清理任务处理。
      db.prepare('UPDATE item_images SET item_id = NULL WHERE item_id = ?').run(itemId);
      attachImages(db, actor, itemId, input.imageIds);
    }
  });
}

/** 按 id 取单张商品卡片（AI 语义搜索兜底用）。 */
export function itemCardById(db: DatabaseSync, id: number) {
  const r = one<CardRow>(db, `${CARD_SELECT} WHERE i.id = ?`, [id]);
  return r ? toCard(r) : null;
}

/** 集市列表：发布中与交易中的商品；同组券折叠成一条（每页 20 个展示单元）。 */
export function listItems(db: DatabaseSync, q: ListQuery) {
  const where = ["i.status IN ('published', 'locked', 'handed_over')", GROUP_REPRESENTATIVE_SQL];
  const params: SQLInputValue[] = [];
  if (q.q) {
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\')");
    const p = likePattern(q.q);
    params.push(p, p);
  }
  if (q.category) {
    where.push('i.category_id = ?');
    params.push(q.category);
  }
  if (q.tradeType) {
    where.push('i.trade_type = ?');
    params.push(q.tradeType);
  }
  if (q.kind) {
    where.push('i.kind = ?');
    params.push(q.kind);
  }
  const order = {
    latest: 'i.published_at DESC, i.id DESC',
    price_asc: 'i.price ASC, i.id DESC',
    price_desc: 'i.price DESC, i.id DESC',
    // F16 即将过期：只对有有效期的券类生效（有效期近到远），其余商品排在其后按发布时间
    expiring:
      "CASE WHEN i.kind = 'voucher' AND i.expires_on IS NOT NULL THEN 0 ELSE 1 END ASC, (i.expires_on IS NULL) ASC, i.expires_on ASC, i.published_at DESC, i.id DESC",
  }[q.sort];
  const whereSql = where.join(' AND ');
  const total = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM items i WHERE ${whereSql}`, params)!.n;
  const rows = all<CardRow>(db, `${CARD_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]);
  return { total, items: rows.map(toCard) };
}

interface DetailRow extends CardRow {
  description: string;
  category_id: number;
  seller_id: number;
  handoff_location: string;
  handoff_time: string | null;
  wish_matched_at: string | null;
  negotiation_floor: number | null;
  withdraw_reason: string | null;
}

interface RequestDetailRow {
  id: number;
  buyer_id: number;
  buyer_name: string;
  buyer_department: string | null;
  buyer_contact: string | null;
  message: string | null;
  status: string;
  close_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  handed_over_at: string | null;
  agreed_price: number | null;
  negotiation_id: number | null;
}

/**
 * 商品详情。联系方式只在申请被接受后返回给交易双方：
 * 发布者看到买家联系方式，被选中的买家看到发布者联系方式。
 */
export function getItemDetail(db: DatabaseSync, viewer: Actor, itemId: number) {
  const r = one<DetailRow>(
    db,
    `SELECT i.*, u.name AS seller_name, u.department AS seller_department, c.name AS category_name,
            ${GROUP_REMAINING_SQL},
            (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover,
            0 AS request_count
     FROM items i JOIN users u ON u.id = i.seller_id JOIN categories c ON c.id = i.category_id WHERE i.id = ?`,
    [itemId],
  );
  if (!r) throw notFound('商品');
  // 匹配中且 AI 可用时惰性补触发（覆盖进程重启丢队列的情况）
  maybeRetryItemMatch(db, { id: r.id, status: r.status, wish_matched_at: r.wish_matched_at, published_at: r.published_at });
  // 隐藏的商品只有发布者和管理员能看。
  if (r.status === 'hidden' && r.seller_id !== viewer.id && viewer.role !== 'admin') throw notFound('商品');

  const images = all<{ id: number; path: string }>(db, 'SELECT id, path FROM item_images WHERE item_id = ? ORDER BY sort, id', [itemId]).map((x) => ({
    id: x.id,
    url: imageUrl(x.path),
  }));
  const base = {
    ...toCard(r),
    description: r.description,
    categoryId: r.category_id,
    handoffLocation: r.handoff_location,
    handoffTime: r.handoff_time,
    images,
  };
  // F16 同组券：共 N 张、剩 M 张（M = 组内仍发布中的件数）
  const group = r.kind === 'voucher' && r.listing_group
    ? one<{ total: number; remaining: number }>(
        db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS remaining
         FROM items WHERE listing_group = ?`,
        [r.listing_group],
      )!
    : null;

  const reqs = all<RequestDetailRow>(
    db,
    `SELECT dr.id, dr.buyer_id, u.name AS buyer_name, u.department AS buyer_department, u.contact AS buyer_contact,
            dr.message, dr.status, dr.close_reason, dr.created_at, dr.accepted_at, dr.handed_over_at,
            dr.agreed_price, dr.negotiation_id
     FROM deal_requests dr JOIN users u ON u.id = dr.buyer_id WHERE dr.item_id = ? ORDER BY dr.created_at`,
    [itemId],
  );

  if (r.seller_id === viewer.id) {
    // F12 问问小星：卖家看到全部问题，匿名——只有 question/known/createdAt，
    // SELECT 不取 asker 任何字段，提问人姓名/工号/id 不进响应（原则 3）。
    const questions = all<{ question: string; known: number; created_at: string }>(
      db,
      'SELECT question, known, created_at FROM item_questions WHERE item_id = ? ORDER BY created_at DESC, id DESC',
      [itemId],
    ).map((x) => ({ question: x.question, known: x.known === 1, createdAt: x.created_at }));
    return {
      ...base,
      viewer: 'seller' as const,
      group: group ? { total: group.total, remaining: group.remaining ?? 0 } : null,
      withdrawReason: r.withdraw_reason,
      negotiationFloor: r.negotiation_floor, // 底价只有卖家本人可见（原则 3）
      questions,
      wishPanel: {
        matching: r.status === 'published' && r.wish_matched_at === null,
        matches: wishMatchesForItem(db, itemId),
      },
      requests: reqs.map((q) => ({
        id: q.id,
        buyerName: q.buyer_name,
        buyerDepartment: q.buyer_department,
        message: q.message,
        status: q.status,
        closeReason: q.close_reason,
        createdAt: q.created_at,
        acceptedAt: q.accepted_at,
        handedOverAt: q.handed_over_at,
        agreedPrice: q.agreed_price,
        negotiationId: q.negotiation_id,
        contact: q.status === 'accepted' ? q.buyer_contact : null,
      })),
    };
  }

  const mine = reqs.find((q) => q.buyer_id === viewer.id);
  let sellerContact: string | null = null;
  if (mine?.status === 'accepted') {
    sellerContact = one<{ contact: string | null }>(db, 'SELECT contact FROM users WHERE id = ?', [r.seller_id])?.contact ?? null;
  }
  // F12 问问小星：只返回本人问答（时间倒序），canAsk = 剩余提问次数。
  const myQuestions = all<{ question: string; answer: string; known: number; created_at: string }>(
    db,
    'SELECT question, answer, known, created_at FROM item_questions WHERE item_id = ? AND asker_id = ? ORDER BY created_at DESC, id DESC',
    [itemId, viewer.id],
  ).map((x) => ({ question: x.question, answer: x.answer, known: x.known === 1, createdAt: x.created_at }));
  return {
    ...base,
    viewer: 'buyer' as const,
    group: group ? { total: group.total, remaining: group.remaining ?? 0 } : null,
    withdrawReason: r.withdraw_reason,
    myQuestions,
    canAsk: Math.max(0, ASK_LIMIT - askCount(db, itemId, viewer.id)),
    negotiation: {
      ...negotiationEntry(db, itemId, viewer.id),
      // 券类不支持小星代谈（真实群聊中券价高度统一，没有议价行为）
      enabled: r.status === 'published' && r.trade_type === 'fixed' && r.negotiation_floor !== null && r.kind !== 'voucher',
    },
    myRequest: mine
      ? {
          id: mine.id,
          status: mine.status,
          message: mine.message,
          handedOverAt: mine.handed_over_at,
          agreedPrice: mine.agreed_price,
          sellerContact,
        }
      : null,
  };
}

/** 我的发布：每件商品附带待处理申请数、底价（仅本人可见）与当前交易信息（含成交价）。 */
export function listMyItems(db: DatabaseSync, actor: Actor) {
  const rows = all<
    CardRow & {
      pending_count: number;
      wish_count: number;
      withdraw_reason: string | null;
      negotiation_floor: number | null;
      deal_id: number | null;
      deal_handed_over_at: string | null;
      deal_price: number | null;
      buyer_name: string | null;
      buyer_contact: string | null;
    }
  >(
    db,
    `SELECT i.id, i.title, i.price, i.original_price, i.trade_type, i.condition, i.status, i.published_at,
            i.kind, i.handoff_mode, i.expires_on, i.listing_group, i.withdraw_reason,
            u.name AS seller_name, u.department AS seller_department, c.name AS category_name,
            ${NEGOTIABLE_SQL}, i.negotiation_floor,
            ${GROUP_REMAINING_SQL},
            (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover,
            (SELECT COUNT(*) FROM deal_requests r WHERE r.item_id = i.id AND r.status IN ('pending', 'accepted')) AS request_count,
            (SELECT COUNT(*) FROM deal_requests r WHERE r.item_id = i.id AND r.status = 'pending') AS pending_count,
            (SELECT COUNT(*) FROM wish_matches m JOIN wishes w ON w.id = m.wish_id WHERE m.item_id = i.id AND w.status = 'active') AS wish_count,
            d.id AS deal_id, d.handed_over_at AS deal_handed_over_at, MIN(COALESCE(d.agreed_price, i.price), i.price) AS deal_price,
            b.name AS buyer_name, b.contact AS buyer_contact
     FROM items i
     JOIN users u ON u.id = i.seller_id
     JOIN categories c ON c.id = i.category_id
     LEFT JOIN deal_requests d ON d.item_id = i.id AND d.status = 'accepted'
     LEFT JOIN users b ON b.id = d.buyer_id
     WHERE i.seller_id = ? ORDER BY i.published_at DESC, i.id DESC`,
    [actor.id],
  );
  return rows.map((r) => ({
    ...toCard(r),
    pendingCount: r.pending_count,
    wishCount: r.wish_count,
    withdrawReason: r.withdraw_reason, // F16 过期自动下架记 expired，前端显示「已过期」
    negotiationFloor: r.negotiation_floor, // 底价只出现在卖家本人的我的发布（原则 3）
    deal: r.deal_id ? { requestId: r.deal_id, handedOverAt: r.deal_handed_over_at, price: r.deal_price, buyerName: r.buyer_name, buyerContact: r.buyer_contact } : null,
  }));
}

/** 我的申请：被接受后附带发布者联系方式；代谈申请附带谈成价。 */
export function listMyRequests(db: DatabaseSync, actor: Actor) {
  const rows = all<{
    id: number;
    status: string;
    message: string | null;
    created_at: string;
    handed_over_at: string | null;
    agreed_price: number | null;
    negotiation_id: number | null;
    item_id: number;
    title: string;
    item_status: string;
    item_price: number;
    cover: string | null;
    seller_name: string;
    seller_contact: string | null;
  }>(
    db,
    `SELECT dr.id, dr.status, dr.message, dr.created_at, dr.handed_over_at, dr.agreed_price, dr.negotiation_id,
            i.id AS item_id, i.title, i.status AS item_status, i.price AS item_price,
            (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS cover,
            u.name AS seller_name, u.contact AS seller_contact
     FROM deal_requests dr JOIN items i ON i.id = dr.item_id JOIN users u ON u.id = i.seller_id
     WHERE dr.buyer_id = ? ORDER BY dr.created_at DESC, dr.id DESC`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    message: r.message,
    createdAt: r.created_at,
    handedOverAt: r.handed_over_at,
    agreedPrice: r.agreed_price,
    negotiationId: r.negotiation_id,
    dealPrice: r.agreed_price === null ? r.item_price : Math.min(r.agreed_price, r.item_price), // 成交价口径：卖家降价时按新挂牌价
    item: { id: r.item_id, title: r.title, status: r.item_status, price: r.item_price, cover: r.cover ? imageUrl(r.cover) : null },
    sellerName: r.seller_name,
    sellerContact: r.status === 'accepted' ? r.seller_contact : null,
  }));
}

/** 导航红点：待我处理的数量，实时查询，不建消息表。 */
export function badgeCounts(db: DatabaseSync, actor: Actor) {
  const n = (sql: string): number => one<{ n: number }>(db, sql, [actor.id])!.n;
  const toReview = n(
    `SELECT COUNT(DISTINCT dr.item_id) AS n FROM deal_requests dr JOIN items i ON i.id = dr.item_id
     WHERE i.seller_id = ? AND i.status = 'published' AND dr.status = 'pending'`,
  );
  const toDeliver = n("SELECT COUNT(*) AS n FROM items WHERE seller_id = ? AND status = 'locked'");
  const toConfirm = n(
    `SELECT COUNT(*) AS n FROM deal_requests dr JOIN items i ON i.id = dr.item_id
     WHERE dr.buyer_id = ? AND dr.status = 'accepted' AND i.status = 'handed_over'`,
  );
  return { toReview, toDeliver, toConfirm, total: toReview + toDeliver + toConfirm };
}
