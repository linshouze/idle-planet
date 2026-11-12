import { useState, type ReactNode } from 'react';

/** 小星星形图标（SVG，描边风格与导航一致）。 */
export function XingIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.2 5.6L20 10l-4.5 3.8L17 20l-5-3.2L7 20l1.5-6.2L4 10l5.8-1.4z" />
    </svg>
  );
}

/**
 * 小星虚拟形象：圆形徽章头像（web/public/xiaoxing.png，不进仓库）。
 * 图片缺失时回退紫色星徽；talking 时做说话动效，否则待机漂浮。
 */
export function XingAvatar({ size = 34, talking = false }: { size?: number; talking?: boolean }) {
  const [ok, setOk] = useState(true);
  return (
    <span className={`xing-avatar${talking ? ' talking' : ' idle'}`} style={{ width: size, height: size }} aria-hidden="true">
      {ok ? (
        <img src="/xiaoxing.png" alt="" onError={() => setOk(false)} />
      ) : (
        <span className="xing-avatar-fb">
          <XingIcon size={Math.round(size * 0.5)} />
        </span>
      )}
    </span>
  );
}

/** 小星：全站统一的 AI 品牌徽标（紫渐变 + SVG 星）。 */
export function XingBadge({ label = '小星' }: { label?: string }) {
  return (
    <span className="xing-badge">
      <XingIcon />
      {label}
    </span>
  );
}

/** 小星面板：aurora 流动描边外壳；working=true 时叠加扫光 + 骨架行。 */
export function XingPanel({ children, working = false, className = '' }: { children?: ReactNode; working?: boolean; className?: string }) {
  return (
    <div className={`xing-panel${working ? ' working' : ''} ${className}`}>
      {working && (
        <>
          <div className="xing-skel w85" />
          <div className="xing-skel w60" />
        </>
      )}
      <div className={working ? '' : 'fade-in'}>{children}</div>
    </div>
  );
}
