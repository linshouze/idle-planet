import { Link } from 'react-router-dom';
import { CONDITION_LABEL, ITEM_STATUS, expiryView, faceValueText, priceText, timeAgo } from '../format';
import type { ItemCard } from '../api/types';

const WANT_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  </svg>
);

export function ItemCardView({ item }: { item: ItemCard }) {
  const unavailable = item.status !== 'published';
  const isVoucher = item.kind === 'voucher';
  const expiry = isVoucher ? expiryView(item.expiresOn) : null;
  return (
    <Link to={`/items/${item.id}`} className="pcard">
      <span className={`corner ${item.tradeType}`}>{item.tradeType === 'free' ? '免费' : '一口价'}</span>
      {item.negotiable && (
        <span className="corner nego" title="卖家允许小星代谈">
          ✦ 可代谈
        </span>
      )}
      {expiry && expiry.tone === 'red' && item.status === 'published' && (
        <span className={`corner expiring${item.negotiable ? ' nego-stack' : ''}`} title="有效期即将截止">
          ⏳ {expiry.label}
        </span>
      )}
      <div className={`cover${unavailable ? ' dim' : ''}`}>
        {item.originalPrice != null && item.originalPrice > item.price && <span className="save-corner">省 ¥{item.originalPrice - item.price}</span>}
        {item.cover ? (
          <img src={item.cover} alt={item.title} loading="lazy" />
        ) : (
          isVoucher && (
            <div className="voucher-ph" aria-hidden="true">
              <span className="voucher-ph-icon">🎟</span>
              <span className="voucher-ph-text">{item.categoryName || '券·权益'}</span>
            </div>
          )
        )}
        {unavailable && <span className="state">{ITEM_STATUS[item.status].label}</span>}
      </div>
      <div className="pb">
        <div className="pt" title={item.title}>
          {item.title}
        </div>
        <div className="pm">
          {item.categoryName} · {isVoucher ? item.sellerName : `${CONDITION_LABEL[item.condition]} · ${item.sellerName}`}
        </div>
        {isVoucher && (
          <div className="pm voucher-line">
            {expiry ? (
              <span className={`expiry-tag ${expiry.tone}`}>⏳ {expiry.label}</span>
            ) : (
              <span className="expiry-tag plain">长期有效</span>
            )}
            {item.listingGroup && (item.groupRemaining ?? 0) > 1 && <span className="group-tag">剩 {item.groupRemaining} 张</span>}
          </div>
        )}
        <div className="pf">
          <span className="want" title="申请人数">
            {WANT_ICON}
            {item.requestCount}
          </span>
          <span>{timeAgo(item.publishedAt)}</span>
          <span className={`price${item.tradeType === 'free' ? ' free' : ''}`}>{priceText(item.tradeType, item.price)}</span>
          {item.originalPrice != null &&
            (isVoucher ? (
              <span className="orig">{faceValueText(item.originalPrice, item.tradeType, item.price)}</span>
            ) : (
              <span className="orig">
                {item.tradeType === 'free'
                  ? `全新约 ¥${item.originalPrice} · 免费领`
                  : item.originalPrice > item.price
                    ? `全新约 ¥${item.originalPrice} · 省 ¥${item.originalPrice - item.price}`
                    : `全新约 ¥${item.originalPrice}`}
              </span>
            ))}
        </div>
      </div>
    </Link>
  );
}
