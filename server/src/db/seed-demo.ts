import { deflateSync, crc32 } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { acceptRequest, completeDeal, createRequest, markHandedOver } from '../services/deal.ts';
import { createItem } from '../services/items.ts';
import { createDirectMatch, createWish } from '../services/wish.ts';
import { saveImage } from '../services/uploads.ts';
import type { Actor } from '../services/deal.ts';
import type { ItemInput } from '../../../shared/schemas.ts';

/** 生成纯色 PNG 作为演示图片，不依赖任何图片库。 */
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

const dataDir = resolve(process.env.DATA_DIR ?? join(import.meta.dirname, '../../../data'));
const db: DatabaseSync = openDb(join(dataDir, 'app.db'));
const uploadDir = join(dataDir, 'uploads');

const existing = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (existing > 0) {
  console.error(`数据库 ${dataDir} 里已有 ${existing} 个用户，拒绝写入演示数据。如需重置演示环境，请换一个 DATA_DIR。`);
  process.exit(1);
}

const addUser = (employeeNo: string, name: string, role: 'employee' | 'admin' = 'employee'): Actor => {
  const r = db
    .prepare('INSERT INTO users (employee_no, name, department, contact, role) VALUES (?, ?, ?, ?, ?)')
    .run(employeeNo, name, '演示账号', `${name}@demo`, role);
  return { id: Number(r.lastInsertRowid), role };
};

addUser('A001', '管理员', 'admin');
const people = [
  addUser('E001', '陈小明'),
  addUser('E002', '林小雨'),
  addUser('E003', '王大伟'),
  addUser('E004', '赵晓敏'),
  addUser('E005', '刘一帆'),
  addUser('E006', '周子墨'),
];

const COLORS: [number, number, number][] = [
  [91, 127, 232],
  [34, 197, 94],
  [255, 138, 76],
  [165, 190, 243],
  [120, 144, 156],
  [186, 104, 200],
];
const image = (i: number, seller: Actor): number => saveImage(db, uploadDir, seller.id, solidPng(480, 360, COLORS[i % COLORS.length]!)).id;

const cat = (name: string): number => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

interface Seed extends Omit<ItemInput, 'imageIds' | 'categoryId'> {
  category: string;
  seller: number;
}

const seeds: Seed[] = [
  { seller: 0, category: '数码电子', title: '戴尔 U2720Q 4K 显示器', description: '使用两年，功能正常，无坏点，带原装底座和线材。', condition: 'good', tradeType: 'fixed', price: 800, handoffLocation: '3 楼前台', handoffTime: '工作日 12:00-13:00' },
  { seller: 1, category: '数码电子', title: '罗技 MX Keys 无线键盘', description: '使用约一年，外观有轻微使用痕迹，附带接收器。', condition: 'good', tradeType: 'fixed', price: 250, handoffLocation: '一楼大厅' },
  { seller: 2, category: '书籍文具', title: '《深入理解计算机系统》第三版', description: '有少量笔记，不影响阅读。', condition: 'good', tradeType: 'free', price: 0, handoffLocation: '5 楼茶水间' },
  { seller: 3, category: '家居生活', title: '小米空气炸锅 4L', description: '用过几次，搬家用不上了，送给需要的同事。', condition: 'like_new', tradeType: 'free', price: 0, handoffLocation: '一楼大厅', handoffTime: '周五下班后' },
  { seller: 4, category: '运动户外', title: '迪卡侬瑜伽垫', description: '几乎全新，只用过两次。', condition: 'like_new', tradeType: 'fixed', price: 30, handoffLocation: '2 楼健身角' },
  { seller: 5, category: '办公用品', title: '人体工学护腰靠垫', description: '记忆棉，用了半年，已清洗。', condition: 'good', tradeType: 'fixed', price: 40, handoffLocation: '4 楼工位区' },
  { seller: 0, category: '数码电子', title: 'Anker 65W 氮化镓充电器', description: '功能完好，送一根 Type-C 线。', condition: 'good', tradeType: 'free', price: 0, handoffLocation: '3 楼前台' },
  { seller: 1, category: '家居生活', title: '宜家台灯', description: '白色，可调光，灯泡已换新。', condition: 'good', tradeType: 'fixed', price: 25, handoffLocation: '一楼大厅' },
  { seller: 2, category: '其他', title: '行李箱 24 寸', description: '万向轮，拉杆正常，有些划痕。', condition: 'fair', tradeType: 'fixed', price: 60, handoffLocation: '5 楼茶水间' },
  { seller: 3, category: '书籍文具', title: '设计模式、重构、代码大全三本', description: '三本技术书合售，品相良好。', condition: 'good', tradeType: 'fixed', price: 80, handoffLocation: '一楼大厅' },
];

const ids = seeds.map((s, i) => {
  const seller = people[s.seller]!;
  const { category, seller: _s, ...rest } = s;
  return createItem(db, seller, { ...rest, categoryId: cat(category), imageIds: [image(i, seller)] });
});

// 让集市里有几种不同状态：有人申请、交易中、已交付待确认、已完成。
const req = (itemIdx: number, buyerIdx: number, message: string): number => createRequest(db, people[buyerIdx]!, ids[itemIdx]!, message);
req(0, 4, '周五下午可以来取吗？');
req(0, 5, '我想要，随时可以');
req(2, 0, '想领取这本书');
req(2, 5, '我也在找这本书');
const locked = req(3, 1, '想要，周五下班可以');
acceptRequest(db, people[3]!, locked);
const handedOver = req(4, 2, '我想要');
acceptRequest(db, people[4]!, handedOver);
markHandedOver(db, people[4]!, handedOver);
const done = req(1, 3, '想要这个键盘');
acceptRequest(db, people[1]!, done);
markHandedOver(db, people[1]!, done);
completeDeal(db, people[3]!, done);

// 预置心愿：保证心愿墙不空；第一条与种子商品（戴尔显示器）直接建立匹配。
const wish1 = createWish(db, people[4]!, '想要个 4K 显示器，预算 1000 以内', 1000, false);
createDirectMatch(db, wish1, ids[0]!);
createWish(db, people[5]!, '求一个无线键盘，200 以内', 200, false);
createWish(db, people[1]!, '想找几本通勤看的小说或散文集，免费赠送', null, true);

console.log(`演示数据已写入 ${dataDir}`);
console.log('  管理员登录: 工号 A001 / 姓名 管理员');
console.log('  员工登录:   E001 陈小明、E002 林小雨、E003 王大伟、E004 赵晓敏、E005 刘一帆、E006 周子墨');
console.log('  注意: 这些是演示账号和模拟数据（部门标记为「演示账号」），不能当作真实使用数据展示。');
