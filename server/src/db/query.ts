import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export function all<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** 用于 LIKE 查询：转义 % _ \ */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
