export type Condition = 'new' | 'like_new' | 'good' | 'fair';
export type TradeType = 'fixed' | 'free';
export type ItemKind = 'goods' | 'voucher';
export type HandoffMode = 'offline' | 'online';
export type ItemStatus = 'published' | 'locked' | 'handed_over' | 'completed' | 'withdrawn' | 'hidden';
export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'closed' | 'cancelled' | 'completed';

export interface User {
  id: number;
  employeeNo: string;
  name: string;
  department: string | null;
  contact: string | null;
  role: 'employee' | 'admin';
}

export interface Badge {
  toReview: number;
  toDeliver: number;
  toConfirm: number;
  total: number;
}

export interface Category {
  id: number;
  name: string;
}

export interface ItemCard {
  id: number;
  title: string;
  price: number;
  originalPrice: number | null;
  tradeType: TradeType;
  condition: Condition;
  status: ItemStatus;
  publishedAt: string;
  sellerName: string;
  sellerDepartment: string | null;
  categoryName: string;
  cover: string | null;
  requestCount: number;
  /** F9 可代谈：一口价且卖家开启了底价（布尔，不含底价数值）。 */
  negotiable: boolean;
  /** F16 商品类型：goods 实物 | voucher 券·权益。 */
  kind: ItemKind;
  /** F16 交接方式：线下当面 | 线上转赠（仅券类可选）。 */
  handoffMode: HandoffMode;
  /** F16 有效期 YYYY-MM-DD（北京时间）；null = 长期有效或实物。 */
  expiresOn: string | null;
  /** F16 同组标识（数量 >1 拆分的多件共用）。 */
  listingGroup: string | null;
  /** F16 同组仍在售的张数（非组商品不带该字段）。 */
  groupRemaining?: number;
}

export interface ItemList {
  total: number;
  items: ItemCard[];
  /** 关键词无结果且 AI 可用时的语义匹配结果。 */
  ai?: {
    understanding: string;
    results: { item: ItemCard; reason: string }[];
  };
}

/** F2 风控判定结果（服务端收紧后的结构）。 */
export type RiskType = 'company_asset' | 'prohibited';
export interface RiskInfo {
  level: 'none';
  type?: never;
  reason?: never;
}
export interface RiskWarn {
  level: 'warn';
  type: RiskType;
  reason: string;
}
export type Risk = RiskInfo | RiskWarn;

export interface AiDraft {
  title?: string;
  newPriceEstimate?: number | null;
  description?: string;
  categoryId?: number;
  condition?: string;
  priceSuggestion?: { min?: number; max?: number; reason?: string } | null;
  /** F16 用户原话里说的出售价（转述，非估价），用于预填挂牌价。 */
  price?: number | null;
  missing?: string[];
  risk?: Risk;
  /** F16 识别出的商品类型与券类字段（草稿阶段，由用户确认）。 */
  kind?: ItemKind;
  expiresOn?: string | null;
  quantity?: number;
  /** F1：小星拿不准的字段名（白名单 title/categoryId/condition/price/newPriceEstimate/expiresOn/quantity），前端标黄提示核对。 */
  uncertain?: string[];
}

/** F1 清仓模式批量发布逐件结果（非原子，与入参 items 顺序对应）。 */
export type BatchItemResult =
  | { ok: true; id: number; ids?: number[] }
  | { ok: false; error: { code: string; message: string } };

export interface AiDraftResponse {
  available: boolean;
  draft?: AiDraft;
  /** F2：服务端留存的预检记录 id，发布时回传。 */
  riskCheckId?: number | null;
}

/** F2 风控补检响应：available=false 表示超时或失败（未检，放行）。 */
export interface RiskCheckResponse {
  available: boolean;
  riskCheckId?: number;
  risk?: Risk;
}

export interface SellerRequest {
  id: number;
  buyerName: string;
  buyerDepartment: string | null;
  message: string | null;
  status: RequestStatus;
  closeReason: string | null;
  createdAt: string;
  acceptedAt: string | null;
  handedOverAt: string | null;
  /** F9 小星谈成价；null = 非代谈申请。 */
  agreedPrice: number | null;
  negotiationId: number | null;
  contact: string | null;
}

export interface ItemDetailBase extends ItemCard {
  description: string;
  categoryId: number;
  handoffLocation: string;
  handoffTime: string | null;
  images: { id: number; url: string }[];
  /** F16 同组券：共 total 张、剩 remaining 张（非组商品为 null）。 */
  group: { total: number; remaining: number } | null;
  /** F16 下架原因：expired = 过期自动下架。 */
  withdrawReason: string | null;
}

export interface SellerDetail extends ItemDetailBase {
  viewer: 'seller';
  /** F9 代谈底价，仅卖家本人可见（原则 3）。null = 未开启代谈。 */
  negotiationFloor: number | null;
  /** F12 同事问过小星（匿名）：只有问题本身，不含提问人任何信息。 */
  questions: SellerQuestion[];
  wishPanel: {
    matching: boolean;
    matches: {
      matchId: number;
      wishId: number;
      userName: string;
      userDepartment: string | null;
      content: string;
      budgetText: string;
      reason: string;
      invited: boolean;
    }[];
  };
  requests: SellerRequest[];
}

export interface BuyerDetail extends ItemDetailBase {
  viewer: 'buyer';
  /** F9 代谈入口状态。 */
  negotiation: { canStart: boolean; remaining: number; enabled: boolean };
  /** F12 我问过小星的问答（仅本人可见，时间倒序）。 */
  myQuestions: MyQuestion[];
  /** F12 剩余提问次数（每件商品最多 5 次）。 */
  canAsk: number;
  myRequest: {
    id: number;
    status: RequestStatus;
    message: string | null;
    handedOverAt: string | null;
    agreedPrice: number | null;
    sellerContact: string | null;
  } | null;
}

export type ItemDetail = SellerDetail | BuyerDetail;

// ---- 问问小星（F12） ----

/** 买家本人的问答记录（回答只给提问者本人看，原则 2）。 */
export interface MyQuestion {
  question: string;
  answer: string;
  /** false = 商品信息里没提到 / 与商品无关，可引导写进申请留言。 */
  known: boolean;
  createdAt: string;
}

/** 卖家视图的匿名问题条目：不含提问人任何信息。 */
export interface SellerQuestion {
  question: string;
  known: boolean;
  createdAt: string;
}

/** POST /items/:id/ask 响应：available=false 表示小星暂时不在（不写库、不占次数）。 */
export interface AskResponse {
  available: boolean;
  answer?: string;
  known?: boolean;
  questionId?: number;
}

// ---- 小星代谈（F9） ----

export interface NegoTurn {
  role: 'buyer' | 'seller';
  say: string;
  offer: number;
  accept: boolean;
}

export type NegoStatus = 'running' | 'deal' | 'no_deal' | 'ai_failed' | 'used' | 'expired';

/** GET /negotiations/:id。buyerMax/buyerNote/remaining 仅买家本人可见。 */
export interface NegotiationView {
  id: number;
  itemId: number;
  status: NegoStatus;
  agreedPrice: number | null;
  listPrice: number;
  turns: NegoTurn[];
  buyerMax?: number;
  buyerNote?: string | null;
  remaining?: number;
}

export interface MyItem extends ItemCard {
  pendingCount: number;
  wishCount: number;
  /** F16 下架原因：expired = 过期自动下架，显示「已过期」。 */
  withdrawReason: string | null;
  /** F9 代谈底价，仅卖家本人可见。 */
  negotiationFloor: number | null;
  deal: { requestId: number; handedOverAt: string | null; price: number | null; buyerName: string | null; buyerContact: string | null } | null;
}

export interface MyRequest {
  id: number;
  status: RequestStatus;
  message: string | null;
  createdAt: string;
  handedOverAt: string | null;
  agreedPrice: number | null;
  negotiationId: number | null;
  /** 成交价口径：MIN(COALESCE(agreed_price, 挂牌价), 挂牌价)。 */
  dealPrice: number;
  item: { id: number; title: string; status: ItemStatus; price: number; cover: string | null };
  sellerName: string;
  sellerContact: string | null;
}

export interface Dashboard {
  range: { from: string; to: string | null };
  includeDemo: boolean;
  saved: number;
  savedCoverage: { covered: number; total: number };
  published: number;
  requests: number;
  completed: number;
  matchRate: number | null;
  completionRate: number | null;
  avgCycleHours: number | null;
  activeUsers: number;
  flow: { amount: number; freeCount: number };
  funnel: { published: number; requested: number; accepted: number; completed: number };
  wishes: { active: number; fulfilled: number };
  /** F9 代谈指标。 */
  negotiation: { started: number; successRate: number | null; avgDiscount: number | null };
  /** F16 实物 / 券·权益拆分。 */
  split: {
    published: { goods: number; voucher: number };
    completed: { goods: number; voucher: number };
    flow: { goods: { amount: number; freeCount: number }; voucher: { amount: number; freeCount: number } };
    expiredVouchers: number;
  };
  daily: { day: string; published: number; completed: number }[];
  byCategory: { name: string; completed: number; published: number }[];
}

export interface AdminItem {
  id: number;
  title: string;
  status: ItemStatus;
  tradeType: TradeType;
  price: number;
  publishedAt: string;
  hiddenReason: string | null;
  /** F16 类型与过期下架原因。 */
  kind: ItemKind;
  withdrawReason: string | null;
  sellerName: string;
  sellerEmployeeNo: string;
  /** F2 小星预警（管理后台专用；普通用户接口不返回这些字段）。 */
  cover: string | null;
  aiRiskType: RiskType | null;
  aiRiskReason: string | null;
  aiRiskAck: boolean;
  aiRiskReviewed: boolean;
  aiRiskChecked: boolean;
}

export interface StaleDeal {
  requestId: number;
  itemId: number;
  title: string;
  handedOverAt: string;
  sellerName: string;
  buyerName: string;
  buyerContact: string | null;
}

export interface AdminUser {
  id: number;
  employeeNo: string;
  name: string;
  department: string | null;
  contact: string | null;
  role: 'employee' | 'admin';
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
}

export interface AdminCategory {
  id: number;
  name: string;
  sort: number;
  enabled: number;
}

// ---- 闲置英雄榜（F20） ----

export interface BoardRow {
  rank: number;
  userId: number;
  name: string;
  department: string;
  count: number;
  amount: number;
  freeCount: number;
  saved: number;
  badge: string | null;
}

export interface DeptRow {
  rank: number;
  department: string;
  count: number;
  amount: number;
  saved: number;
}

export interface LeaderboardData {
  window: 'all' | 'month' | 'season';
  seasonStart: string;
  sellers: BoardRow[];
  buyers: BoardRow[];
  departments: DeptRow[];
  me: { sellerRank: number | null; sellerCount: number; buyerRank: number | null; buyerCount: number };
  star: { userId: number; name: string; department: string | null; count: number; saved: number } | null;
}

// ---- 心愿墙 ----

export interface WishStats {
  active: number;
  fulfilled: number;
}

export interface WishPublic {
  id: number;
  content: string;
  budgetText: string;
  ownerName: string;
  ownerDepartment: string | null;
  createdAt: string;
  matchCount: number;
  isMine: boolean;
}

export interface WishMatchView {
  matchId: number;
  itemId: number;
  item: { id: number; title: string; status: ItemStatus; price: number; tradeType: TradeType; cover: string | null };
  reason: string;
  origin: 'ai' | 'direct';
  invitedBy: string | null;
  isNew: boolean;
  /** F9：心愿预算，用于代谈弹窗预填心理价。 */
  budget: number | null;
}

export interface WishMine {
  id: number;
  content: string;
  budgetText: string;
  state: 'active' | 'expired' | 'closed' | 'fulfilled';
  createdAt: string;
  renewedAt: string | null;
  matches: WishMatchView[];
}
