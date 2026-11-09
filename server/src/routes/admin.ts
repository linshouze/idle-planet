import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { categoryInputSchema, dateRangeSchema, userInputSchema } from '../../../shared/schemas.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { all, likePattern, one } from '../db/query.ts';
import { dashboard } from '../services/dashboard.ts';
import { forceComplete, hideItem, restoreItem } from '../services/deal.ts';
import type { Env } from '../types.ts';

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw new AppError(400, 'INVALID_JSON', '请求体不是合法的 JSON');
  });
  return schema.parse(raw);
}

export function idParam(c: Context, name = 'id'): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
  return id;
}

interface CsvResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

/** 每行：工号,姓名[,部门[,角色]]。第一行是表头时自动跳过。 */
function importUsers(db: DatabaseSync, csv: string): CsvResult {
  const result: CsvResult = { created: 0, updated: 0, errors: [] };
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const upsert = db.prepare(
    `INSERT INTO users (employee_no, name, department, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(employee_no) DO UPDATE SET name = excluded.name, department = excluded.department, role = excluded.role`,
  );
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(',').map((s) => s.trim());
    if (i === 0 && ['工号', 'employee_no', 'employeeNo'].includes(cells[0]!)) return;
    const parsed = userInputSchema.safeParse({
      employeeNo: cells[0],
      name: cells[1],
      department: cells[2] || undefined,
      role: cells[3] || 'employee',
    });
    if (!parsed.success) {
      result.errors.push({ line: i + 1, message: '工号和姓名必填，角色只能是 employee 或 admin' });
      return;
    }
    const v = parsed.data;
    const existed = one(db, 'SELECT 1 AS ok FROM users WHERE employee_no = ?', [v.employeeNo]);
    upsert.run(v.employeeNo, v.name, v.department ?? null, v.role);
    if (existed) result.updated++;
    else result.created++;
  });
  return result;
}

export function adminRoutes(db: DatabaseSync): Hono<Env> {
  const r = new Hono<Env>();

  r.use('*', async (c, next) => {
    if (c.get('user').role !== 'admin') throw forbidden('需要管理员权限');
    await next();
  });

  r.get('/dashboard', (c) => c.json(dashboard(db, dateRangeSchema.parse(c.req.query()), c.req.query('includeDemo') === '1')));

  r.get('/items', (c) => {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const status = c.req.query('status');
    if (status) {
      where.push('i.status = ?');
      params.push(status);
    }
    const q = c.req.query('q')?.trim();
    if (q) {
      where.push("i.title LIKE ? ESCAPE '\\'");
      params.push(likePattern(q));
    }
    if (c.req.query('aiFlag') === '1') {
      where.push('i.ai_risk_type IS NOT NULL'); // F2：只看小星预警商品
    }
    const kind = c.req.query('kind');
    if (kind === 'goods' || kind === 'voucher') {
      where.push('i.kind = ?'); // F16：按类型筛选
      params.push(kind);
    }
    const rows = all(
      db,
      `SELECT i.id, i.title, i.status, i.trade_type AS tradeType, i.price, i.published_at AS publishedAt, i.hidden_reason AS hiddenReason,
              i.kind AS kind, i.withdraw_reason AS withdrawReason,
              i.ai_risk_type AS aiRiskType, i.ai_risk_reason AS aiRiskReason,
              i.ai_risk_ack AS aiRiskAck, i.ai_risk_reviewed AS aiRiskReviewed, i.ai_risk_checked AS aiRiskChecked,
              u.name AS sellerName, u.employee_no AS sellerEmployeeNo,
              (SELECT path FROM item_images WHERE item_id = i.id ORDER BY sort, id LIMIT 1) AS coverPath
       FROM items i JOIN users u ON u.id = i.seller_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.published_at DESC, i.id DESC LIMIT 200`,
      params,
    );
    return c.json({
      items: (rows as Record<string, unknown>[]).map((r) => {
        const { coverPath, aiRiskAck, aiRiskReviewed, aiRiskChecked, ...rest } = r;
        return { ...rest, cover: coverPath ? `/api/uploads/${coverPath}` : null, aiRiskAck: Boolean(aiRiskAck), aiRiskReviewed: Boolean(aiRiskReviewed), aiRiskChecked: Boolean(aiRiskChecked) };
      }),
    });
  });

  /** F2：标记小星预警已复核。清除高亮，保留预警记录。 */
  r.post('/items/:id/risk-reviewed', (c) => {
    const id = idParam(c);
    const row = one<{ ai_risk_type: string | null }>(db, 'SELECT ai_risk_type FROM items WHERE id = ?', [id]);
    if (!row) throw notFound('商品');
    if (!row.ai_risk_type) throw new AppError(409, 'NO_RISK_FLAG', '该商品没有小星预警记录');
    db.prepare('UPDATE items SET ai_risk_reviewed = 1 WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  r.post('/items/:id/hide', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : undefined;
    hideItem(db, c.get('user'), idParam(c), reason);
    return c.json({ ok: true });
  });

  r.post('/items/:id/restore', (c) => {
    restoreItem(db, c.get('user'), idParam(c));
    return c.json({ ok: true });
  });

  /** 已交付但买家超过 N 天（默认 3）未确认的交易。 */
  r.get('/deals/stale', (c) => {
    const rawDays = c.req.query('days');
    const parsedDays = rawDays === undefined ? 3 : Number(rawDays);
    const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 3;
    const rows = all(
      db,
      `SELECT dr.id AS requestId, i.id AS itemId, i.title, dr.handed_over_at AS handedOverAt,
              s.name AS sellerName, b.name AS buyerName, b.contact AS buyerContact
       FROM deal_requests dr JOIN items i ON i.id = dr.item_id
       JOIN users s ON s.id = i.seller_id JOIN users b ON b.id = dr.buyer_id
       WHERE dr.status = 'accepted' AND i.status = 'handed_over'
         AND dr.handed_over_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
       ORDER BY dr.handed_over_at`,
      [`-${days} days`],
    );
    return c.json({ deals: rows });
  });

  r.post('/requests/:id/force-complete', (c) => {
    forceComplete(db, c.get('user'), idParam(c));
    return c.json({ ok: true });
  });

  r.get('/users', (c) => {
    const rows = all(
      db,
      `SELECT id, employee_no AS employeeNo, name, department, contact, role, status, last_login_at AS lastLoginAt
       FROM users ORDER BY id`,
    );
    return c.json({ users: rows });
  });

  r.post('/users', async (c) => {
    const v = await parseBody(c, userInputSchema);
    if (one(db, 'SELECT 1 AS ok FROM users WHERE employee_no = ?', [v.employeeNo])) {
      throw new AppError(409, 'USER_EXISTS', '该工号已存在');
    }
    db.prepare('INSERT INTO users (employee_no, name, department, role) VALUES (?, ?, ?, ?)').run(v.employeeNo, v.name, v.department ?? null, v.role);
    return c.json({ ok: true }, 201);
  });

  r.post('/users/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.csv !== 'string') throw new AppError(400, 'INVALID_JSON', '需要 { csv: string }');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = importUsers(db, body.csv);
      db.exec('COMMIT');
      return c.json(result);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  r.patch('/users/:id', async (c) => {
    const id = idParam(c);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string; role?: string };
    const me = c.get('user');
    if (id === me.id) throw new AppError(400, 'SELF_MODIFY', '不能修改自己的状态或角色');
    if (!one(db, 'SELECT 1 AS ok FROM users WHERE id = ?', [id])) throw notFound('用户');
    if (body.status === 'active' || body.status === 'disabled') {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(body.status, id);
      if (body.status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (body.role === 'employee' || body.role === 'admin') {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
    }
    return c.json({ ok: true });
  });

  r.get('/categories', (c) => c.json({ categories: all(db, 'SELECT id, name, sort, enabled FROM categories ORDER BY sort, id') }));

  r.post('/categories', async (c) => {
    const v = await parseBody(c, categoryInputSchema);
    try {
      const res = db.prepare('INSERT INTO categories (name, sort, enabled) VALUES (?, ?, ?)').run(v.name, v.sort ?? 0, v.enabled === false ? 0 : 1);
      return c.json({ id: Number(res.lastInsertRowid) }, 201);
    } catch {
      throw new AppError(409, 'CATEGORY_EXISTS', '分类名称已存在');
    }
  });

  r.patch('/categories/:id', async (c) => {
    const id = idParam(c);
    const v = await parseBody(c, categoryInputSchema.partial());
    if (!one(db, 'SELECT 1 AS ok FROM categories WHERE id = ?', [id])) throw notFound('分类');
    try {
      if (v.name !== undefined) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(v.name, id);
      if (v.sort !== undefined) db.prepare('UPDATE categories SET sort = ? WHERE id = ?').run(v.sort, id);
      if (v.enabled !== undefined) db.prepare('UPDATE categories SET enabled = ? WHERE id = ?').run(v.enabled ? 1 : 0, id);
    } catch {
      throw new AppError(409, 'CATEGORY_EXISTS', '分类名称已存在');
    }
    return c.json({ ok: true });
  });

  return r;
}
