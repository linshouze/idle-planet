// 往当前 data/app.db 造英雄榜演示素材（真实部门感的账号 + 12 笔完成交易）。
// 幂等补齐式：账号不存在则建；交易按目标笔数补齐缺失（防外部清理误删后可重跑恢复）。
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '../..');
const db = new DatabaseSync(join(root, 'data', 'app.db'));

const uid = (no: string): number =>
  (db.prepare('SELECT id FROM users WHERE employee_no = ?').get(no) as { id: number } | undefined)?.id ?? 0;
const ensureU = (no: string, name: string, dept: string): number => {
  const existing = uid(no);
  if (existing) return existing;
  return Number(db.prepare('INSERT INTO users (employee_no, name, department, contact) VALUES (?, ?, ?, ?)').run(no, name, dept, `${dept}-${no}`).lastInsertRowid);
};
const seedTxCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM items WHERE seller_id IN (SELECT id FROM users WHERE employee_no LIKE 'F10_')").get() as { n: number }).n;

if (seedTxCount() >= 12) {
  console.log('英雄榜演示素材已齐全，跳过。');
  process.exit(0);
}

db.exec('BEGIN');
try {
  const wang = ensureU('F101', '王强', '研发部');
  const su = ensureU('F102', '苏珊', '产品部');
  const lu = ensureU('F103', '陆明', '设计部');
  const gao = ensureU('F104', '高鑫', '研发部');
  const he = ensureU('F105', '何芳', '市场部');
  const deng = ensureU('F106', '邓磊', '运营部');

  let n = 0;
  const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const tx = (seller: number, buyer: number, price: number, originalPrice: number | null, when: string | null = null): void => {
    const t = db
      .prepare(
        `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, handoff_location, original_price, status, completed_at)
         VALUES (?, ?, 1, '演示素材', 'good', ?, ?, '一楼大厅', ?, 'completed', COALESCE(?, ${NOW}))`,
      )
      .run(seller, `演示素材${++n}`, price === 0 ? 'free' : 'fixed', price, originalPrice, when);
    const itemId = Number(t.lastInsertRowid);
    const at = when ?? null;
    db.prepare(
      `INSERT INTO deal_requests (item_id, buyer_id, status, accepted_at, handed_over_at, completed_at)
       VALUES (?, ?, 'completed', COALESCE(?, ${NOW}), COALESCE(?, ${NOW}), COALESCE(?, ${NOW}))`,
    ).run(itemId, buyer, at, at, at);
  };

  // 赛季内（当前时间完成）
  tx(wang, gao, 300, 700);
  tx(wang, he, 50, 120);
  tx(wang, deng, 0, 88);
  tx(wang, gao, 120, 500);
  tx(su, he, 80, 200);
  tx(su, deng, 60, null);
  tx(su, he, 0, 45);
  tx(lu, gao, 45, null);
  tx(lu, deng, 200, 1000);
  tx(gao, su, 35, 99);
  tx(he, wang, 100, 600);
  // 10 月旧交易：只计入「全部」窗口
  tx(su, gao, 70, null, '2026-10-20T04:00:00.000Z');

  db.exec('COMMIT');
  console.log('已写入 6 个演示同事 + 12 笔完成交易。清理：DELETE FROM users WHERE employee_no LIKE \'F10_\'; 及关联 items/deal_requests。');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
