import type { Condition, ItemStatus, RequestStatus, RiskType } from './api/types';

/** F2 风控预警类型的中文名。 */
export const RISK_TYPE_LABEL: Record<RiskType, string> = { company_asset: '疑似公司资产', prohibited: '疑似违规品' };

export const CONDITION_LABEL: Record<Condition, string> = {
  new: '全新',
  like_new: '九成新',
  good: '八成新',
  fair: '其他',
};

// ---- F16 券·权益 ----

/** 北京时间（UTC+8）的今天，YYYY-MM-DD。 */
export const beijingToday = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 有效期距北京时间的今天还有几天（负数 = 已过期）。 */
export const daysUntil = (date: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${beijingToday()}T00:00:00Z`)) / 86_400_000);

/** 券是否已到期或今天到期（locked/handed_over 详情页红字提醒用）。 */
export const voucherDue = (expiresOn: string | null): boolean => expiresOn !== null && expiresOn <= beijingToday();

export interface ExpiryView {
  /** red = 今天过期 / N 天后过期 / 已过期；plain = 正常。 */
  tone: 'red' | 'plain';
  label: string;
}

/** 卡片/详情的有效期展示：剩 3 天内红标。 */
export function expiryView(expiresOn: string | null): ExpiryView | null {
  if (!expiresOn) return null;
  const d = daysUntil(expiresOn);
  if (d < 0) return { tone: 'red', label: `已过期 ${Math.abs(d)} 天` };
  if (d === 0) return { tone: 'red', label: '今天过期' };
  if (d <= 3) return { tone: 'red', label: `${d} 天后过期` };
  return { tone: 'plain', label: `${expiresOn} 到期` };
}

/** 券类面值行：固定价「面值 ¥500 · 97 折」，免费「面值 ¥X · 免费」。 */
export const faceValueText = (face: number, tradeType: string, price: number): string =>
  tradeType === 'free' ? `面值 ¥${face} · 免费` : `面值 ¥${face} · ${Math.round((price / face) * 100)} 折`;

/** 有效期文案（无标签）：长期有效或具体日期。 */
export const expiresText = (expiresOn: string | null): string => (expiresOn ? `${expiresOn} 到期` : '长期有效');

export const ITEM_STATUS: Record<ItemStatus, { label: string; tone: 'green' | 'blue' | 'orange' | 'gray' }> = {
  published: { label: '发布中', tone: 'green' },
  locked: { label: '交易中', tone: 'orange' },
  handed_over: { label: '待确认收货', tone: 'orange' },
  completed: { label: '已完成', tone: 'blue' },
  withdrawn: { label: '已下架', tone: 'gray' },
  hidden: { label: '已隐藏', tone: 'gray' },
};

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: 'green' | 'blue' | 'orange' | 'gray' }> = {
  pending: { label: '等待确认', tone: 'orange' },
  accepted: { label: '已被选中', tone: 'green' },
  rejected: { label: '未通过', tone: 'gray' },
  withdrawn: { label: '已撤回', tone: 'gray' },
  closed: { label: '已关闭', tone: 'gray' },
  cancelled: { label: '交易已取消', tone: 'gray' },
  completed: { label: '已完成', tone: 'blue' },
};

export const CLOSE_REASON: Record<string, string> = {
  item_locked: '已有交易对象',
  item_withdrawn: '商品已下架',
  item_hidden: '商品已被隐藏',
  item_expired: '券已过期',
};

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const priceText = (tradeType: string, price: number): string => (tradeType === 'free' ? '免费' : `¥${price}`);

/** 上传前把图片缩到长边 1280px 以内并转成 JPEG，减小体积。 */
export async function compressImage(file: File, maxSide = 1280, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 800 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}
