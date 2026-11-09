import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError, z } from 'zod';
import { contactSchema, feishuBindSchema, itemInputSchema, listQuerySchema, loginSchema, requestInputSchema } from '../../shared/schemas.ts';
import { AppError, notFound } from './errors.ts';
import { all, one } from './db/query.ts';
import { adminRoutes, idParam, parseBody } from './routes/admin.ts';
import { aiRoutes, semanticSearch } from './routes/ai.ts';
import { askRoutes } from './routes/ask.ts';
import { negotiationRoutes } from './routes/negotiation.ts';
import { wishRoutes } from './routes/wishes.ts';
import { aiConfig, type AiConfig, type ChatOptions } from './services/ai.ts';
import { feishuIdentity } from './services/feishu.ts';
import { negotiatedDeal } from './services/negotiation.ts';
import { createDirectMatch, fulfilledPrompt, queueItemMatch, wishUpdates } from './services/wish.ts';
import { leaderboard } from './services/leaderboard.ts';
import { getUser, login, logout, startSession, bindFeishuOpenId, updateContact, userByEmployeeNo, userByOpenId, userFromSession } from './services/auth.ts';
import {
  acceptRequest,
  cancelDeal,
  completeDeal,
  createRequest,
  markHandedOver,
  rejectRequest,
  withdrawItem,
  withdrawRequest,
} from './services/deal.ts';
import { expireVouchers } from './services/voucher.ts';
import { badgeCounts, createItems, getItemDetail, itemCardById, listItems, listMyItems, listMyRequests, updateItem } from './services/items.ts';
import { MAX_IMAGE_BYTES, SAFE_IMAGE_NAME, saveImage } from './services/uploads.ts';
import type { Env } from './types.ts';

export interface AppConfig {
  uploadDir: string;
  cookieSecure: boolean;
  /** 前端构建产物目录；不存在则只提供 API。 */
  webDir?: string;
  /** 测试注入：覆盖 AI chat 实现（F2 风控测试用）。 */
  aiChat?: (cfg: AiConfig, opts: ChatOptions) => Promise<string | null>;
  /** F21 飞书扫码登录配置；未配置时入口隐藏、路由回退到工号登录提示。 */
  feishu?: { appId: string; appSecret: string; baseUrl: string };
  /** 测试注入：覆盖飞书 HTTP 调用。 */
  feishuHttp?: (url: string, init?: RequestInit) => Promise<Response>;
}

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE = 14 * 24 * 3600;
const FEISHU_STATE_COOKIE = 'fs_state';
const FEISHU_STATE_MAX_AGE = 600;
const FEISHU_PENDING_COOKIE = 'fs_pending';
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// 发布/编辑共用的请求体：在商品字段之外接受 F3 的 wishId 和 F2 的 riskCheckId/riskAck。
const itemBodySchema = itemInputSchema.extend({
  wishId: z.number().int().positive().optional(),
  riskCheckId: z.number().int().positive().optional(),
  riskAck: z.boolean().optional(),
});

// F1 清仓模式：批次共用信息 + 逐件商品。items 先收 unknown，逐件用与单件发布
// 完全相同的 schema 校验，某件不合法只影响该件（非原子），不整批 400。
const batchBodySchema = z.object({
  common: z.object({
    handoffLocation: z.string().trim().min(1, '请填写交接地点').max(100),
    handoffTime: z.string().trim().max(100).optional(),
  }),
  items: z.array(z.unknown()).min(1, '请至少添加一件商品').max(10, '一次最多发布 10 件'),
});

/** F1 批量发布逐件结果，与入参 items 顺序对应。 */
type BatchItemResult = { ok: true; id: number; ids: number[] } | { ok: false; error: { code: string; message: string } };

export function createApp(db: DatabaseSync, config: AppConfig): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => i.message).join('；');
      return c.json({ error: { code: 'VALIDATION_ERROR', message, issues: err.issues } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: 'INTERNAL', message: '服务器内部错误' } }, 500);
  });

  // ---- 认证 ----
  app.post('/api/auth/login', async (c) => {
    const { employeeNo } = await parseBody(c, loginSchema);
    const { sessionId, user } = login(db, employeeNo);
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
      secure: config.cookieSecure,
    });
    return c.json({ user });
  });

  // ---- F21 飞书扫码登录（公开路由，须注册在鉴权中间件之前）----
  // 演示阶段：发起跳转 + state 校验已实现；回调暂不換 token，扫码回来提示用工号登录。
  // 完整版（换 token / 取 userinfo / 匹配白名单 / 绑定分支）见 docs/功能全景.md 1.1。
  app.get('/api/auth/feishu', (c) => {
    const f = config.feishu;
    if (!f) return c.redirect('/login?err=feishu_disabled');
    const state = randomBytes(16).toString('hex');
    setCookie(c, FEISHU_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: FEISHU_STATE_MAX_AGE,
      secure: config.cookieSecure,
    });
    const url =
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize' +
      `?client_id=${encodeURIComponent(f.appId)}` +
      `&redirect_uri=${encodeURIComponent(`${f.baseUrl}/api/auth/feishu/callback`)}` +
      `&state=${state}`;
    return c.redirect(url);
  });

  app.get('/api/auth/feishu/callback', async (c) => {
    const f = config.feishu;
    if (!f) return c.redirect('/login?err=feishu_disabled');
    const state = c.req.query('state') ?? '';
    const saved = getCookie(c, FEISHU_STATE_COOKIE);
    deleteCookie(c, FEISHU_STATE_COOKIE, { path: '/' });
    if (!saved || saved !== state) return c.redirect('/login?err=feishu_state');
    const code = c.req.query('code');
    if (!code) return c.redirect('/login?err=feishu_denied');
    const identity = await feishuIdentity(f, code, config.feishuHttp).catch(() => null);
    if (!identity) return c.redirect('/login?err=feishu_failed');
    // 匹配顺序：employee_no 白名单 → 已绑定 open_id → 一次性绑定分支（功能全景 1.1）
    let user = identity.employeeNo ? userByEmployeeNo(db, identity.employeeNo) : undefined;
    const bound = userByOpenId(db, identity.openId);
    if (bound && user && bound.id !== user.id) return c.redirect('/login?err=feishu_bound');
    user = user ?? bound;
    if (user) {
      if (!bound) bindFeishuOpenId(db, user.id, identity.openId);
      setCookie(c, SESSION_COOKIE, startSession(db, user.id), {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_MAX_AGE,
        secure: config.cookieSecure,
      });
      return c.redirect('/');
    }
    const pending = encodeURIComponent(JSON.stringify({ openId: identity.openId, name: identity.name }));
    setCookie(c, FEISHU_PENDING_COOKIE, pending, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: FEISHU_STATE_MAX_AGE,
      secure: config.cookieSecure,
    });
    return c.redirect('/login?bind=feishu');
  });

  app.post('/api/auth/feishu/bind', async (c) => {
    if (!config.feishu) throw new AppError(400, 'FEISHU_DISABLED', '飞书登录未启用');
    const raw = getCookie(c, FEISHU_PENDING_COOKIE);
    if (!raw) throw new AppError(400, 'BIND_EXPIRED', '飞书身份已过期，请重新扫码');
    const pending = JSON.parse(decodeURIComponent(raw)) as { openId?: string; name?: string };
    if (!pending.openId) throw new AppError(400, 'BIND_EXPIRED', '飞书身份已过期，请重新扫码');
    const { employeeNo } = await parseBody(c, feishuBindSchema);
    const user = userByEmployeeNo(db, employeeNo);
    if (!user) throw new AppError(401, 'LOGIN_FAILED', '工号不存在或账号未开通');
    bindFeishuOpenId(db, user.id, pending.openId);
    deleteCookie(c, FEISHU_PENDING_COOKIE, { path: '/' });
    setCookie(c, SESSION_COOKIE, startSession(db, user.id), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
      secure: config.cookieSecure,
    });
    return c.json({ user });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/auth/login') return next();
    const sid = getCookie(c, SESSION_COOKIE);
    const user = sid ? userFromSession(db, sid) : undefined;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    c.set('user', user);
    await next();
  });

  app.post('/api/auth/logout', (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) logout(db, sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => {
    const user = c.get('user');
    const preferredHandoff = one<{ l: string }>(
      db,
      'SELECT handoff_location AS l FROM items WHERE seller_id = ? GROUP BY handoff_location ORDER BY COUNT(*) DESC, MAX(published_at) DESC LIMIT 1',
      [user.id],
    )?.l ?? null;
    return c.json({ user, badge: badgeCounts(db, user), wishUpdates: wishUpdates(db, user.id), preferredHandoff, aiEnabled: Boolean(aiConfig()) });
  });

  app.patch('/api/me', async (c) => {
    const { contact } = await parseBody(c, contactSchema);
    updateContact(db, c.get('user').id, contact);
    return c.json({ user: getUser(db, c.get('user').id) });
  });

  app.get('/api/categories', (c) => c.json({ categories: all(db, 'SELECT id, name FROM categories WHERE enabled = 1 ORDER BY sort, id') }));

  // ---- 图片 ----
  app.post(
    '/api/uploads',
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES + 512 * 1024,
      onError: (c) => c.json({ error: { code: 'IMAGE_TOO_LARGE', message: '图片不能超过 5MB' } }, 413),
    }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File)) throw new AppError(400, 'INVALID_IMAGE', '请通过 file 字段上传图片');
      const saved = saveImage(db, config.uploadDir, c.get('user').id, new Uint8Array(await file.arrayBuffer()));
      return c.json(saved, 201);
    },
  );

  app.get('/api/uploads/:name', (c) => {
    const name = c.req.param('name');
    if (!SAFE_IMAGE_NAME.test(name)) throw notFound('图片');
    const file = join(config.uploadDir, name);
    if (!existsSync(file)) throw notFound('图片');
    return c.body(readFileSync(file), 200, {
      'Content-Type': MIME[name.split('.')[1]!]!,
      'Cache-Control': 'private, max-age=86400',
    });
  });

  // ---- 商品 ----
  // 关键词搜不到时用 AI 语义兜底：把在售商品列表和搜索词发给模型做语义匹配。
  app.get('/api/items', async (c) => {
    const q = listQuerySchema.parse(c.req.query());
    expireVouchers(db); // F16：列表查询前先清理过期在售券（每 10 分钟另有定时器兜底）
    const result = listItems(db, q);
    const keyword = q.q?.trim();
    if (result.total === 0 && keyword && keyword.length >= 2) {
      const ai = await semanticSearch(db, keyword);
      if (ai && ai.matches.length > 0) {
        const results = ai.matches
          .map(({ id, reason }) => {
            const card = itemCardById(db, id);
            return card ? { item: card, reason } : null;
          })
          .filter((x): x is { item: NonNullable<ReturnType<typeof itemCardById>>; reason: string } => x !== null);
        return c.json({ ...result, ai: { understanding: ai.understanding, results } });
      }
    }
    return c.json(result);
  });

  app.get('/api/items/:id', (c) => c.json(getItemDetail(db, c.get('user'), idParam(c))));

  app.post('/api/items', async (c) => {
    const body = await parseBody(c, itemBodySchema);
    const { wishId, riskCheckId, riskAck, ...item } = body;
    // F16：券类数量 >1 时拆成 N 件共用 listing_group；id 兼容返回第一件，ids 返回全部。
    const ids = createItems(db, c.get('user'), item, { riskCheckId, riskAck });
    const id = ids[0];
    // 「我有这个」：直接与心愿建立匹配（不经 AI）；普通发布也会异步跑心愿匹配（同组只跑首件，避免 N 次相同调用）。
    if (wishId) {
      const wish = one(db, `SELECT id, user_id, status FROM wishes WHERE id = ? AND status = 'active'`, [wishId]) as
        | { id: number; user_id: number; status: string }
        | undefined;
      if (wish && wish.user_id !== c.get('user').id) createDirectMatch(db, wishId, id);
    }
    queueItemMatch(db, id);
    return c.json({ id, ids }, 201);
  });

  // F1 清仓模式批量发布：逐件走与单件发布完全相同的校验/图片绑定/风控（riskCheckId+riskAck 逐件），
  // 非原子——某件失败只记录该件错误，不影响其他件；返回数组与入参 items 顺序对应。
  // 同一次调用共享一个 batch_id（publish_mode='batch'），供 F6 统计与 F7 合并推送使用。
  app.post('/api/items/batch', async (c) => {
    const body = await parseBody(c, batchBodySchema);
    const { common } = body;
    const user = c.get('user');
    const batchId = randomUUID();
    const results: BatchItemResult[] = [];
    for (const raw of body.items) {
      try {
        // 交接地点/时间取批次共用信息（件内自带 handoffTime 时优先件内），再走单件同款校验
        const parsed = itemBodySchema.parse({
          ...(typeof raw === 'object' && raw !== null ? raw : {}),
          handoffLocation: common.handoffLocation,
          handoffTime: (raw as { handoffTime?: unknown })?.handoffTime ?? common.handoffTime,
        });
        const { wishId: _wishId, riskCheckId, riskAck, ...item } = parsed;
        const ids = createItems(db, user, item, { riskCheckId, riskAck }, { batchId });
        queueItemMatch(db, ids[0]); // 心愿匹配照常触发（券组同单件口径，只跑首件）
        results.push({ ok: true, id: ids[0], ids });
      } catch (e) {
        if (e instanceof ZodError) {
          results.push({ ok: false, error: { code: 'VALIDATION_ERROR', message: e.issues.map((i) => i.message).join('；') } });
        } else if (e instanceof AppError) {
          results.push({ ok: false, error: { code: e.code, message: e.message } });
        } else {
          console.error(e);
          results.push({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
        }
      }
    }
    return c.json(results);
  });

  app.patch('/api/items/:id', async (c) => {
    const body = await parseBody(c, itemBodySchema);
    const { riskCheckId, riskAck, ...item } = body;
    const itemId = idParam(c);
    updateItem(db, c.get('user'), itemId, item, { riskCheckId, riskAck });
    // 内容变了，旧的心愿匹配结果可能失效：清掉 AI 匹配（保留「我有这个」的 direct），重新匹配。
    db.prepare("DELETE FROM wish_matches WHERE item_id = ? AND origin = 'ai'").run(itemId);
    db.prepare('UPDATE items SET wish_matched_at = NULL WHERE id = ?').run(itemId);
    queueItemMatch(db, itemId);
    return c.json({ ok: true });
  });

  app.post('/api/items/:id/withdraw', (c) => {
    withdrawItem(db, c.get('user'), idParam(c));
    return c.json({ ok: true });
  });

  // ---- 申请与交易 ----
  // 带 negotiationId 时按小星谈成价提交（F9）：服务端校验已成/未过期后写入 agreed_price，source=negotiation
  app.post('/api/items/:id/requests', async (c) => {
    const body = await parseBody(c, requestInputSchema);
    const itemId = idParam(c);
    const extras = body.negotiationId
      ? {
          agreedPrice: negotiatedDeal(db, c.get('user'), itemId, body.negotiationId),
          negotiationId: body.negotiationId,
          source: 'negotiation',
        }
      : undefined;
    const id = createRequest(db, c.get('user'), itemId, body.message, extras);
    return c.json({ id }, 201);
  });

  const requestAction = (path: string, fn: (db: DatabaseSync, actor: Env['Variables']['user'], id: number) => void) => {
    app.post(`/api/requests/:id/${path}`, (c) => {
      fn(db, c.get('user'), idParam(c));
      return c.json({ ok: true });
    });
  };
  requestAction('withdraw', withdrawRequest);
  requestAction('reject', rejectRequest);
  requestAction('accept', acceptRequest);
  requestAction('cancel', cancelDeal);
  requestAction('handover', markHandedOver);

  // 确认收货后提示「心愿已实现吗」：返回 wishPrompt 供前端弹窗
  app.post('/api/requests/:id/complete', (c) => {
    const id = idParam(c);
    const actor = c.get('user');
    const itemId = one(db, 'SELECT item_id FROM deal_requests WHERE id = ?', [id]) as { item_id: number } | undefined;
    completeDeal(db, actor, id);
    const prompt = itemId ? fulfilledPrompt(db, actor.id, itemId.item_id) : null;
    return c.json({ ok: true, wishPrompt: prompt });
  });

  app.get('/api/me/items', (c) => c.json({ items: listMyItems(db, c.get('user')) }));
  app.get('/api/me/requests', (c) => c.json({ requests: listMyRequests(db, c.get('user')) }));

  // ---- 管理后台 ----
  app.route('/api/admin', adminRoutes(db));

  // ---- 心愿墙 ----
  app.route('/api', wishRoutes(db));

  // ---- 小星代谈（F9） ----
  app.route('/api', negotiationRoutes(db));

  // ---- 问问小星（F12） ----
  app.route('/api', askRoutes(db, config.uploadDir, config.aiChat));

  // ---- 闲置英雄榜（F20，纯 SQL 聚合，登录可见） ----
  app.get('/api/leaderboard', (c) => {
    const w = c.req.query('window');
    const window = w === 'all' || w === 'month' ? w : 'season';
    return c.json(leaderboard(db, window, c.get('user').id));
  });

  // ---- F19：首页 Hero 只读聚合。固定赛季口径（11-04 起、北京时间）、永远剔除演示账号，
  // 不接受 includeDemo；只返回三个整数，不含任何个人信息。 ----
  app.get('/api/stats/public', (c) => {
    const row = one<{ completed: number; saved: number; aiAssisted: number }>(
      db,
      `SELECT COUNT(*) AS completed,
              COALESCE(SUM(CASE WHEN i.original_price IS NULL THEN 0
                   ELSE MAX(0, i.original_price - MIN(COALESCE(dr.agreed_price, i.price), i.price)) END), 0) AS saved,
              COUNT(CASE WHEN dr.source != 'normal' THEN 1 END) AS aiAssisted
       FROM deal_requests dr
       JOIN items i ON i.id = dr.item_id
       JOIN users su ON su.id = i.seller_id AND COALESCE(su.department, '') != '演示账号'
       JOIN users bu ON bu.id = dr.buyer_id AND COALESCE(bu.department, '') != '演示账号'
       WHERE dr.status = 'completed' AND date(i.completed_at, '+8 hours') >= '2026-11-04'`,
    )!;
    const users = one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND COALESCE(department, '') != '演示账号'",
    )!.n;
    return c.json({ ...row, users });
  });

  // ---- AI ----
  app.route('/api/ai', aiRoutes(db, config.uploadDir, config.aiChat ? { chat: config.aiChat } : {}));

  app.all('/api/*', () => {
    throw notFound('接口');
  });

  // ---- 前端静态资源 ----
  if (config.webDir && existsSync(join(config.webDir, 'index.html'))) {
    const root = relative(process.cwd(), config.webDir) || '.';
    // 带 hash 的资源长缓存；HTML 一律 no-cache，否则浏览器缓存旧 index.html 会一直引用旧 bundle，发新版后用户看不到更新。
    app.use('*', async (c, next) => {
      await next();
      if (c.req.path.startsWith('/assets/')) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      else if ((c.res.headers.get('Content-Type') ?? '').includes('text/html')) c.res.headers.set('Cache-Control', 'no-cache');
    });
    app.use('*', serveStatic({ root }));
    app.get('*', (c) =>
      c.body(readFileSync(join(config.webDir!, 'index.html')), 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      }),
    );
  }

  return app;
}
