import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { askQuestion, type ChatFn } from '../services/ask.ts';
import type { Env } from '../types.ts';

const askSchema = z.object({
  question: z.string().trim().min(1, '请输入要问小星的问题').max(60, '问题最多 60 字'),
});

export function askRoutes(db: DatabaseSync, uploadDir: string, chatFn?: ChatFn): Hono<Env> {
  const r = new Hono<Env>();

  // 问问小星（F12）：同步调用，10s 超时。AI 未启用 / 失败不抛 503，返回 available:false，
  // 前端提示「小星暂时不在」（降级原则：主流程永不阻塞，提问失败不写库、不占次数）。
  r.post('/items/:id/ask', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
    const { question } = askSchema.parse(await c.req.json().catch(() => null));
    const result = await askQuestion(db, c.get('user'), id, question, { uploadDir, chatFn });
    return c.json(result);
  });

  return r;
}
