-- 所有时间戳存 UTC ISO 字符串（strftime('%Y-%m-%dT%H:%M:%fZ','now')）。
-- 金额为整数元，免费赠送 price = 0。

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_no   TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  department    TEXT,
  contact       TEXT,
  role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT,
  feishu_open_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  sort    INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id        INTEGER NOT NULL REFERENCES users(id),
  title            TEXT NOT NULL,
  category_id      INTEGER NOT NULL REFERENCES categories(id),
  description      TEXT NOT NULL,
  condition        TEXT NOT NULL CHECK (condition IN ('new', 'like_new', 'good', 'fair')),
  trade_type       TEXT NOT NULL CHECK (trade_type IN ('fixed', 'free')),
  price            INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  handoff_location TEXT NOT NULL,
  handoff_time     TEXT,
  original_price   INTEGER,            -- F4 全新参考价（F20 排行榜的节省口径也用它），NULL = 未填
  ai_risk_type     TEXT,               -- F2 小星预警类型 company_asset|prohibited，NULL = 无预警
  ai_risk_reason   TEXT,               -- F2 预警理由（服务端留存，不信任前端文本）
  ai_risk_ack      INTEGER NOT NULL DEFAULT 0,  -- F2 发布者已确认「个人物品」
  ai_risk_reviewed INTEGER NOT NULL DEFAULT 0,  -- F2 管理员已复核
  ai_risk_checked  INTEGER NOT NULL DEFAULT 0,  -- F2 是否经过小星预检（0 = 未检，如 AI 超时）
  negotiation_floor INTEGER,           -- F9 代谈底价（仅卖家本人可见），NULL = 未开启代谈
  kind             TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'voucher')),  -- F16 商品类型：goods 实物 | voucher 券·权益
  handoff_mode     TEXT NOT NULL DEFAULT 'offline' CHECK (handoff_mode IN ('offline', 'online')), -- F16 交接方式：线下当面 | 线上转赠
  expires_on       TEXT,               -- F16 有效期 YYYY-MM-DD（北京时间），NULL = 长期有效或实物
  listing_group    TEXT,               -- F16 数量 >1 时同组标识，同组商品共用
  withdraw_reason  TEXT,               -- F16 下架原因，过期自动下架记 expired
  publish_mode     TEXT NOT NULL DEFAULT 'single' CHECK (publish_mode IN ('single', 'batch')),  -- F1 发布方式：单件 | 清仓批量
  batch_id         TEXT,               -- F1 同一次批量发布共用的批次 id（UUID），单件发布为 NULL
  status           TEXT NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published', 'locked', 'handed_over', 'completed', 'withdrawn', 'hidden')),
  hidden_reason    TEXT,
  published_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at     TEXT,
  CHECK (trade_type = 'fixed' OR price = 0)
);
CREATE INDEX IF NOT EXISTS idx_items_status_published ON items (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_seller ON items (seller_id);

-- item_id 为空表示图片已上传但尚未被商品引用，可定期清理。
CREATE TABLE IF NOT EXISTS item_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER REFERENCES items(id),
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  path       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_images_item ON item_images (item_id);

-- 小星代谈（F9）。买卖双方各有一个信息隔离的小星代理人，服务端编排谈判。
-- 底价与挂牌价在发起时快照，之后卖家改价不影响进行中与已结束的谈判。
CREATE TABLE IF NOT EXISTS negotiations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id             INTEGER NOT NULL REFERENCES items(id),
  buyer_id            INTEGER NOT NULL REFERENCES users(id),
  buyer_max           INTEGER NOT NULL,       -- 买家心理价，仅买家本人可见
  buyer_note          TEXT,                   -- 买家附言，仅买家本人可见
  list_price_snapshot INTEGER NOT NULL,       -- 发起时的挂牌价
  floor_snapshot      INTEGER NOT NULL,       -- 发起时的卖家底价，不出现在任何接口响应里
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'deal', 'no_deal', 'ai_failed', 'used', 'expired')),
  agreed_price        INTEGER,                -- 谈成价，必然在 [floor_snapshot, buyer_max] 内
  turns_json          TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_negotiations_item_buyer ON negotiations (item_id, buyer_id);

-- 被卖家选中的申请（status = 'accepted'）即为交易，时间戳记录交付与完成节点。
CREATE TABLE IF NOT EXISTS deal_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id),
  buyer_id       INTEGER NOT NULL REFERENCES users(id),
  message        TEXT,
  agreed_price   INTEGER,                -- F9 小星谈成价；成交价口径 = MIN(COALESCE(agreed_price, price), price)
  negotiation_id INTEGER REFERENCES negotiations(id),
  source         TEXT NOT NULL DEFAULT 'normal',  -- 归因（F6）：wish_match|invite|ai_search|negotiation，默认 normal
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'closed', 'cancelled', 'completed')),
  close_reason   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  accepted_at    TEXT,
  handed_over_at TEXT,
  completed_at   TEXT,
  cancelled_at   TEXT,
  UNIQUE (item_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS idx_requests_buyer ON deal_requests (buyer_id);
-- 数据库层面的最后防线：同一商品同一时间最多一个被选中的买家。
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_accepted_per_item ON deal_requests (item_id) WHERE status = 'accepted';

-- 每人每天一行，用于统计活跃员工数。
CREATE TABLE IF NOT EXISTS user_daily_activity (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- 心愿墙（F3）。expired 不落库：按 COALESCE(renewed_at, created_at) + 14 天计算。
CREATE TABLE IF NOT EXISTS wishes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  content      TEXT NOT NULL,
  budget       INTEGER,               -- NULL = 不限
  free_ok      INTEGER NOT NULL DEFAULT 0 CHECK (free_ok IN (0, 1)),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'fulfilled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  renewed_at   TEXT,
  fulfilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wishes_user ON wishes (user_id);

-- 心愿与商品的匹配记录。invited_at 非空表示卖家已邀请求购者来看。
CREATE TABLE IF NOT EXISTS wish_matches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wish_id    INTEGER NOT NULL REFERENCES wishes(id),
  item_id    INTEGER NOT NULL REFERENCES items(id),
  reason     TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'direct')),
  seen_at    TEXT,
  invited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (wish_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_wish_matches_item ON wish_matches (item_id);

-- F2 公司资产识别与违规预检：服务端留存每次判定结果，发布时凭 riskCheckId 回查，不信任前端文本。
CREATE TABLE IF NOT EXISTS ai_risk_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  image_ids  TEXT,               -- 参与判定的图片 id（JSON 数组），纯文本判定为 NULL
  level      TEXT NOT NULL CHECK (level IN ('none', 'warn')),
  type       TEXT CHECK (type IN ('company_asset', 'prohibited')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_checks_user ON ai_risk_checks (user_id);

-- 问问小星（F12）：买家向小星提问商品细节，小星只依据商品信息回答。
-- 回答只给提问者本人看（买家视图 myQuestions）；卖家视图 questions 匿名，只有 question/known/created_at。
CREATE TABLE IF NOT EXISTS item_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  asker_id   INTEGER NOT NULL REFERENCES users(id),
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  known      INTEGER NOT NULL CHECK (known IN (0, 1)),  -- 1 = 依据足够直接回答；0 = 商品信息里没提到 / 与商品无关
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_item_questions_item ON item_questions (item_id);
CREATE INDEX IF NOT EXISTS idx_item_questions_asker ON item_questions (item_id, asker_id);
