import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/index.ts';
import type { Actor } from '../src/services/deal.ts';

export function memDb(): DatabaseSync {
  return openDb(':memory:');
}

export function addUser(db: DatabaseSync, employeeNo: string, opts: { role?: 'employee' | 'admin'; contact?: string | null } = {}): Actor {
  const contact = opts.contact === undefined ? `im-${employeeNo}` : opts.contact;
  const r = db
    .prepare('INSERT INTO users (employee_no, name, contact, role) VALUES (?, ?, ?, ?)')
    .run(employeeNo, `员工${employeeNo}`, contact, opts.role ?? 'employee');
  return { id: Number(r.lastInsertRowid), role: opts.role ?? 'employee' };
}

export function addItem(db: DatabaseSync, seller: Actor, title = '测试商品'): number {
  const r = db
    .prepare(
      `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, handoff_location)
       VALUES (?, ?, 1, '描述', 'good', 'fixed', 100, '一楼大厅')`,
    )
    .run(seller.id, title);
  return Number(r.lastInsertRowid);
}

export function itemStatus(db: DatabaseSync, itemId: number): string {
  return (db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string }).status;
}

export function requestStatus(db: DatabaseSync, requestId: number): string {
  return (db.prepare('SELECT status FROM deal_requests WHERE id = ?').get(requestId) as { status: string }).status;
}
