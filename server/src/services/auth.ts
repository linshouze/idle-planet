import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { NOW } from '../db/index.ts';
import { one } from '../db/query.ts';

export interface SessionUser {
  id: number;
  employeeNo: string;
  name: string;
  department: string | null;
  contact: string | null;
  role: 'employee' | 'admin';
}

const SESSION_DAYS = 14;
// 活跃统计按北京时间切日。
const TODAY = "date('now', '+8 hours')";

interface UserRow {
  id: number;
  employee_no: string;
  name: string;
  department: string | null;
  contact: string | null;
  role: 'employee' | 'admin';
  status: string;
}

const toSessionUser = (u: UserRow): SessionUser => ({
  id: u.id,
  employeeNo: u.employee_no,
  name: u.name,
  department: u.department,
  contact: u.contact,
  role: u.role,
});

/** 工号与白名单匹配即登录（验证期简化：不校验姓名，后续接飞书登录）。返回会话 id。 */
export function login(db: DatabaseSync, employeeNo: string): { sessionId: string; user: SessionUser } {
  const u = one<UserRow>(db, 'SELECT * FROM users WHERE employee_no = ?', [employeeNo]);
  if (!u || u.status !== 'active') {
    throw new AppError(401, 'LOGIN_FAILED', '工号不存在或账号未开通');
  }
  return { sessionId: startSession(db, u.id), user: toSessionUser(u) };
}

/** 建会话并记录最近登录与当日活跃。F21 飞书登录复用。 */
export function startSession(db: DatabaseSync, userId: number): string {
  const sessionId = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${SESSION_DAYS} days'))`).run(sessionId, userId);
  db.prepare(`UPDATE users SET last_login_at = ${NOW} WHERE id = ?`).run(userId);
  db.prepare(`INSERT OR IGNORE INTO user_daily_activity (user_id, day) VALUES (?, ${TODAY})`).run(userId);
  return sessionId;
}

/** 白名单查找（仅启用账号），F21 匹配用。 */
export function userByEmployeeNo(db: DatabaseSync, employeeNo: string): SessionUser | undefined {
  const u = one<UserRow & { feishu_open_id?: string | null }>(db, 'SELECT * FROM users WHERE employee_no = ? AND status = ?', [employeeNo, 'active']);
  return u ? toSessionUser(u) : undefined;
}

/** 按飞书 open_id 查已绑定用户（仅启用账号）。 */
export function userByOpenId(db: DatabaseSync, openId: string): SessionUser | undefined {
  const u = one<UserRow>(db, 'SELECT * FROM users WHERE feishu_open_id = ? AND status = ?', [openId, 'active']);
  return u ? toSessionUser(u) : undefined;
}

/** 绑定飞书 open_id。已被他人绑定时报错。 */
export function bindFeishuOpenId(db: DatabaseSync, userId: number, openId: string): void {
  const occupied = one<UserRow>(db, 'SELECT * FROM users WHERE feishu_open_id = ? AND id <> ?', [openId, userId]);
  if (occupied) throw new AppError(409, 'OPENID_BOUND', '该飞书账号已绑定其他工号');
  db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(openId, userId);
}

export function logout(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** 返回有效会话对应的用户；会话过期或账号被停用返回 undefined。同时记录当日活跃。 */
export function userFromSession(db: DatabaseSync, sessionId: string): SessionUser | undefined {
  const u = one<UserRow>(
    db,
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ${NOW} AND u.status = 'active'`,
    [sessionId],
  );
  if (!u) return undefined;
  db.prepare(`INSERT OR IGNORE INTO user_daily_activity (user_id, day) VALUES (?, ${TODAY})`).run(u.id);
  return toSessionUser(u);
}

export function getUser(db: DatabaseSync, id: number): SessionUser | undefined {
  const u = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id]);
  return u ? toSessionUser(u) : undefined;
}

export function updateContact(db: DatabaseSync, userId: number, contact: string): void {
  db.prepare('UPDATE users SET contact = ? WHERE id = ?').run(contact, userId);
}

/** 启动时确保首个管理员存在。 */
export function ensureAdmin(db: DatabaseSync, employeeNo: string, name: string): void {
  db.prepare("INSERT OR IGNORE INTO users (employee_no, name, role) VALUES (?, ?, 'admin')").run(employeeNo, name);
}
