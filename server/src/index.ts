// 启动时加载项目根目录的 .env（存在则生效，不覆盖已有环境变量）
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDb } from './db/index.ts';
import { ensureAdmin } from './services/auth.ts';
import { expireVouchers } from './services/voucher.ts';

const root = resolve(import.meta.dirname, '../..');

/** 启动时读取项目根目录的 .env（KEY=VALUE 每行一条）；不覆盖已有环境变量，方便临时覆盖。 */
function loadEnv(): void {
  const envFile = join(root, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

const dataDir = resolve(process.env.DATA_DIR ?? join(root, 'data'));
const port = Number(process.env.PORT ?? 3000);

const db = openDb(join(dataDir, 'app.db'));

if (process.env.ADMIN_EMPLOYEE_NO) {
  ensureAdmin(db, process.env.ADMIN_EMPLOYEE_NO, process.env.ADMIN_NAME ?? '管理员');
}

const app = createApp(db, {
  uploadDir: join(dataDir, 'uploads'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  webDir: join(root, 'web', 'dist'),
  feishu: process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET
    ? { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, baseUrl: process.env.APP_BASE_URL ?? `http://localhost:${port}` }
    : undefined,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`闲置星球已启动: http://localhost:${info.port}  数据目录: ${dataDir}`);
});

// F16：每 10 分钟清理一次过期在售券（列表查询前也会触发，这里兜底进程空闲时的场景）
const expireTimer = setInterval(() => {
  try {
    const n = expireVouchers(db);
    if (n > 0) console.log(`[voucher] 过期自动下架 ${n} 件券类商品`);
  } catch (e) {
    console.warn('[voucher] 过期清理失败', e);
  }
}, 10 * 60_000);
expireTimer.unref();
