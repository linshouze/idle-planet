import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import {
  closeWish,
  createWish,
  fulfillWish,
  inviteWisher,
  listWishes,
  markWishesSeen,
  queueWishMatch,
  renewWish,
} from '../services/wish.ts';
import type { Env } from '../types.ts';

const wishInputSchema = z.object({
  content: z.string().trim().min(1, '请填写心愿内容').max(100),
  budget: z.number().int().min(0).max(1_000_000).nullable().optional(),
  freeOk: z.boolean().optional(),
});

export function wishRoutes(db: DatabaseSync): Hono<Env> {
  const r = new Hono<Env>();

  r.get('/wishes', (c) => {
    const tab = c.req.query('tab') === 'mine' ? 'mine' : 'all';
    const viewer = c.get('user');
    const data = listWishes(db, viewer, tab);
    // 进入「我的心愿」即视为已读：红点清零，但本次响应仍带「新」标记。
    if (tab === 'mine') markWishesSeen(db, viewer);
    return c.json(data);
  });

  r.post('/wishes', async (c) => {
    const v = wishInputSchema.parse(await c.req.json().catch(() => null));
    const id = createWish(db, c.get('user'), v.content, v.budget ?? null, Boolean(v.freeOk));
    // 人找货：异步匹配，不阻塞响应
    queueWishMatch(db, id);
    return c.json({ id }, 201);
  });

  const own = (path: string, fn: (db: DatabaseSync, actor: Env['Variables']['user'], id: number) => void) => {
    r.post(`/wishes/:id/${path}`, (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
      fn(db, c.get('user'), id);
      return c.json({ ok: true });
    });
  };
  own('close', closeWish);
  own('renew', renewWish);
  own('fulfill', fulfillWish);

  r.post('/wish-matches/:id/invite', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'ID 不合法');
    inviteWisher(db, c.get('user'), id);
    return c.json({ ok: true });
  });

  return r;
}
