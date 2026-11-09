import type { DatabaseSync } from 'node:sqlite';
import { NOW, tx } from '../db/index.ts';
import { all } from '../db/query.ts';
import { beijingToday } from '../../../shared/schemas.ts';

/**
 * F16 券·权益：过期处理。
 * 不需要外部定时任务：列表查询前（GET /api/items）与每 10 分钟的定时器各调一次 expireVouchers。
 * 条件 UPDATE：已过有效期的 published 券 → withdrawn + withdraw_reason='expired'，pending 申请关闭（close_reason=item_expired）。
 * locked / handed_over 的券不自动处理（交易已在进行，详情页显示红字催促完成转赠）。
 */

/** 过期清理：返回本次下架的商品数。幂等，可重复调用。 */
export function expireVouchers(db: DatabaseSync): number {
  return tx(db, () => {
    const expired = all<{ id: number }>(
      db,
      "SELECT id FROM items WHERE kind = 'voucher' AND status = 'published' AND expires_on IS NOT NULL AND expires_on < ?",
      [beijingToday()],
    );
    if (expired.length === 0) return 0;
    const ph = expired.map(() => '?').join(',');
    const ids = expired.map((x) => x.id);
    db.prepare(`UPDATE items SET status = 'withdrawn', withdraw_reason = 'expired', updated_at = ${NOW} WHERE id IN (${ph})`).run(...ids);
    db.prepare(`UPDATE deal_requests SET status = 'closed', close_reason = 'item_expired' WHERE status = 'pending' AND item_id IN (${ph})`).run(...ids);
    return ids.length;
  });
}

/** 券是否已到期或今天到期（北京时间）。locked/handed_over 状态的详情页据此显示红字提醒。 */
export function voucherExpiringTodayOrPast(expiresOn: string | null): boolean {
  return expiresOn !== null && expiresOn <= beijingToday();
}
