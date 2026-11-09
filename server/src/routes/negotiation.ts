import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { aiConfig, chat, type AiConfig, type ChatOptions } from '../services/ai.ts';
import { negotiationView, queueNegotiation, startNegotiation } from '../services/negotiation.ts';
import type { Env } from '../types.ts';

const startSchema = z.object({
  buyerMax: z.number().int().min(1, '请填写心理价').max(1_000_000),
  note: z.string().trim().max(60, '附言最多 60 字').optional(),
});

export function negotiationRoutes(db: DatabaseSync, chatFn: (cfg: AiConfig, opts: ChatOptions) => Promise<string | null> = chat): Hono<Env> {
  const r = new Hono<Env>();

  // 发起代谈：校验入口条件后立即返回，谈判在后台异步执行，前端 1.5s 轮询
  r.post('/items/:id/negotiations', async (c) => {
    if (!aiConfig()) throw new AppError(503, 'AI_DISABLED', 'AI 能力未启用');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
    const v = startSchema.parse(await c.req.json().catch(() => null));
    const negoId = startNegotiation(db, c.get('user'), id, v.buyerMax, v.note);
    queueNegotiation(db, negoId, chatFn);
    return c.json({ id: negoId }, 201);
  });

  r.get('/negotiations/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
    return c.json(negotiationView(db, c.get('user'), id));
  });

  return r;
}
