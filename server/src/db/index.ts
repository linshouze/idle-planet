import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export const DEFAULT_CATEGORIES = ['数码电子', '家居生活', '运动户外', '书籍文具', '办公用品', '其他'];

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  migrate(db);
  seedCategories(db);
  ensureVoucherCategory(db);
  return db;
}

/** 老库兼容：新增列用 ALTER 补，不要求删库重建。 */
function migrate(db: DatabaseSync): void {
  const itemCols = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
  if (!itemCols.some((c) => c.name === 'wish_matched_at')) {
    db.exec('ALTER TABLE items ADD COLUMN wish_matched_at TEXT');
  }
  if (!itemCols.some((c) => c.name === 'original_price')) {
    db.exec('ALTER TABLE items ADD COLUMN original_price INTEGER'); // F4/F20
  }
  // F2 公司资产识别与违规预检
  if (!itemCols.some((c) => c.name === 'ai_risk_type')) db.exec('ALTER TABLE items ADD COLUMN ai_risk_type TEXT');
  if (!itemCols.some((c) => c.name === 'ai_risk_reason')) db.exec('ALTER TABLE items ADD COLUMN ai_risk_reason TEXT');
  if (!itemCols.some((c) => c.name === 'ai_risk_ack')) db.exec("ALTER TABLE items ADD COLUMN ai_risk_ack INTEGER NOT NULL DEFAULT 0");
  if (!itemCols.some((c) => c.name === 'ai_risk_reviewed')) db.exec("ALTER TABLE items ADD COLUMN ai_risk_reviewed INTEGER NOT NULL DEFAULT 0");
  if (!itemCols.some((c) => c.name === 'ai_risk_checked')) db.exec("ALTER TABLE items ADD COLUMN ai_risk_checked INTEGER NOT NULL DEFAULT 0");
  if (!itemCols.some((c) => c.name === 'negotiation_floor')) {
    db.exec('ALTER TABLE items ADD COLUMN negotiation_floor INTEGER'); // F9
  }
  // F9：deal_requests 补成交价 / 代谈关联 / 归因来源。negotiations 表由 schema.sql 保证先建。
  const reqCols = db.prepare('PRAGMA table_info(deal_requests)').all() as { name: string }[];
  if (!reqCols.some((c) => c.name === 'agreed_price')) {
    db.exec('ALTER TABLE deal_requests ADD COLUMN agreed_price INTEGER');
  }
  if (!reqCols.some((c) => c.name === 'negotiation_id')) {
    db.exec('ALTER TABLE deal_requests ADD COLUMN negotiation_id INTEGER REFERENCES negotiations(id)');
  }
  if (!reqCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE deal_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'normal'");
  }
  // F16 券·权益：类型 / 交接方式 / 有效期 / 同组标识 / 下架原因（老库 ALTER 补列，默认按实物处理）
  if (!itemCols.some((c) => c.name === 'kind')) db.exec("ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'goods'");
  if (!itemCols.some((c) => c.name === 'handoff_mode')) db.exec("ALTER TABLE items ADD COLUMN handoff_mode TEXT NOT NULL DEFAULT 'offline'");
  if (!itemCols.some((c) => c.name === 'expires_on')) db.exec('ALTER TABLE items ADD COLUMN expires_on TEXT');
  if (!itemCols.some((c) => c.name === 'listing_group')) db.exec('ALTER TABLE items ADD COLUMN listing_group TEXT');
  if (!itemCols.some((c) => c.name === 'withdraw_reason')) db.exec('ALTER TABLE items ADD COLUMN withdraw_reason TEXT');
  // F1 多图一键清仓：发布方式与批次 id（老库 ALTER 补列，历史数据默认单件）
  if (!itemCols.some((c) => c.name === 'publish_mode')) db.exec("ALTER TABLE items ADD COLUMN publish_mode TEXT NOT NULL DEFAULT 'single'");
  if (!itemCols.some((c) => c.name === 'batch_id')) db.exec('ALTER TABLE items ADD COLUMN batch_id TEXT');
  // F21 飞书登录：白名单用户绑定飞书 open_id（老库 ALTER 补列）
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'feishu_open_id')) db.exec('ALTER TABLE users ADD COLUMN feishu_open_id TEXT');
}

/** F16：没有「券·权益」分类时自动创建并启用，插在「其他」之前（已有则不动）。 */
export const VOUCHER_CATEGORY = '券·权益';

function ensureVoucherCategory(db: DatabaseSync): void {
  const exists = db.prepare('SELECT 1 AS ok FROM categories WHERE name = ?').get(VOUCHER_CATEGORY);
  if (exists) return;
  const other = db.prepare("SELECT sort FROM categories WHERE name = '其他'").get() as { sort: number } | undefined;
  if (other) {
    db.prepare("UPDATE categories SET sort = sort + 1 WHERE sort >= ?").run(other.sort);
    db.prepare('INSERT INTO categories (name, sort, enabled) VALUES (?, ?, 1)').run(VOUCHER_CATEGORY, other.sort);
  } else {
    db.prepare('INSERT INTO categories (name, sort, enabled) VALUES (?, ?, 1)').run(VOUCHER_CATEGORY, DEFAULT_CATEGORIES.length);
  }
}

function seedCategories(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number };
  if (row.n > 0) return;
  const insert = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  DEFAULT_CATEGORIES.forEach((name, i) => insert.run(name, i));
}

/** 不支持嵌套。每个服务函数自己开一个事务。 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
