// 代谈真 AI 冒烟：跑两场买卖双方小星对谈并打印完整记录。
// 运行：cd server && node test/nego-smoke.ts（需要项目根 .env 里有 AI_API_KEY）
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { runNegotiation, startNegotiation } from '../src/services/negotiation.ts';

const root = resolve(import.meta.dirname, '../..');
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
if (!process.env.AI_API_KEY) {
  console.error('缺少 AI_API_KEY，无法跑真对谈');
  process.exit(1);
}

const db = openDb(':memory:');
const mkUser = (no: string) =>
  Number(
    db.prepare('INSERT INTO users (employee_no, name, contact) VALUES (?, ?, ?)').run(no, `员工${no}`, `im-${no}`)
      .lastInsertRowid,
  );
const sellerId = mkUser('S1');
const buyerId = mkUser('B1');

const mkItem = (title: string, price: number, floor: number, description: string) =>
  Number(
    db
      .prepare(
        `INSERT INTO items (seller_id, title, category_id, description, condition, trade_type, price, handoff_location, negotiation_floor)
         VALUES (?, ?, 1, ?, 'good', 'fixed', ?, '一楼大厅', ?)`,
      )
      .run(sellerId, title, description, price, floor).lastInsertRowid,
  );

async function run(label: string, itemId: number, buyerMax: number, note: string | undefined) {
  const negoId = startNegotiation(db, { id: buyerId, role: 'employee' }, itemId, buyerMax, note);
  const t0 = Date.now();
  await runNegotiation(db, negoId);
  const row = db.prepare('SELECT status, agreed_price, turns_json FROM negotiations WHERE id = ?').get(negoId) as {
    status: string;
    agreed_price: number | null;
    turns_json: string;
  };
  const turns = JSON.parse(row.turns_json) as { role: string; say: string; offer: number; accept: boolean }[];
  console.log(`\n===== ${label} =====`);
  console.log(`结果：${row.status}${row.agreed_price !== null ? `，成交价 ¥${row.agreed_price}` : ''}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，共 ${turns.length} 轮发言`);
  for (const t of turns) {
    const who = t.role === 'buyer' ? '买家小星' : '卖家小星';
    const tail = t.accept ? '  → 接受成交' : `  → 出价 ¥${t.offer}`;
    console.log(`${who}：${t.say}${tail}`);
  }
  const dirty = turns.filter((t) => /\d/.test(t.say));
  if (dirty.length) console.log(`⚠ say 含数字的轮次：${dirty.length}（应被服务端替换为模板句，若出现说明替换逻辑没走到）`);
}

// 场景 1：差距可谈拢（挂牌 200 / 底价 150 / 心理价 170）
const item1 = mkItem('罗技 MX Keys 无线键盘', 200, 150, '用了一年，功能正常，键帽轻微打油，带接收器。');
await run('场景1 可谈拢：挂牌200 底价150 心理价170', item1, 170, '下周搬家急用，能谈成就今天来拿。');

// 场景 2：差距谈不拢（挂牌 200 / 底价 150 / 心理价 100）
const item2 = mkItem('索尼 WH-1000XM4 头戴降噪耳机', 200, 150, '九成新，耳罩无脱皮，盒说全。');
await run('场景2 谈不拢：挂牌200 底价150 心理价100', item2, 100, undefined);
