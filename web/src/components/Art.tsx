export function Logo({ size = 52 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id="ip-planet" cx="32%" cy="28%" r="80%">
          <stop offset="0" stopColor="#8FB2FF" />
          <stop offset=".62" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#1D5FD6" />
        </radialGradient>
      </defs>
      <g transform="rotate(-16 32 32)" fill="none" stroke="#9FC0FF" strokeWidth="3.5" strokeLinecap="round">
        <path d="M5 34 A27 8 0 0 1 59 34" />
      </g>
      <circle cx="32" cy="32" r="17" fill="url(#ip-planet)" />
      <circle cx="26" cy="25" r="4.5" fill="#fff" opacity=".45" />
      <g transform="rotate(-16 32 32)" fill="none" stroke="#9FC0FF" strokeWidth="3.5" strokeLinecap="round">
        <path d="M5 34 A27 8 0 0 0 59 34" />
      </g>
    </svg>
  );
}

function Star({ x, y, s, fill = '#FFE9A8' }: { x: number; y: number; s: number; fill?: string }) {
  return <path transform={`translate(${x} ${y}) scale(${s})`} d="M0 -10 C1 -3 3 -1 10 0 C3 1 1 3 0 10 C-1 3 -3 1 -10 0 C-3 -1 -1 -3 0 -10Z" fill={fill} />;
}

/** 首页横幅插画：星球、宇航员和纸箱，全部由矢量图形绘制。 */
export function BannerArt() {
  return (
    <svg viewBox="0 0 380 230" className="banner-art" aria-hidden="true">
      <defs>
        <radialGradient id="ba-earth" cx="30%" cy="22%" r="85%">
          <stop offset="0" stopColor="#B7EDB0" />
          <stop offset=".5" stopColor="#4CAF7D" />
          <stop offset="1" stopColor="#2A7F8F" />
        </radialGradient>
        <linearGradient id="ba-visor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3B5BB8" />
          <stop offset="1" stopColor="#1B2A5E" />
        </linearGradient>
      </defs>
      <Star x={30} y={42} s={1.2} />
      <Star x={118} y={22} s={0.8} />
      <Star x={352} y={36} s={1} />
      <Star x={322} y={118} s={0.7} fill="#FFD36B" />
      <circle cx="268" cy="262" r="138" fill="url(#ba-earth)" />
      <path d="M170 196c18-12 40-10 52 2s-4 26-22 24-40-10-30-26z" fill="#2E8B6A" opacity=".55" />
      <path d="M296 150c14-6 30 0 34 12s-10 20-24 16-20-20-10-28z" fill="#2E8B6A" opacity=".5" />
      <path d="M232 238c10-8 24-6 30 4s-6 18-18 14-20-10-12-18z" fill="#A8E6A3" opacity=".6" />
      <ellipse cx="270" cy="182" rx="34" ry="5" fill="#1E6B63" opacity=".25" />
      <rect x="218" y="132" width="16" height="30" rx="8" fill="#DCE6F7" />
      <rect x="258" y="132" width="16" height="30" rx="8" fill="#DCE6F7" />
      <rect x="212" y="84" width="68" height="70" rx="30" fill="#F4F8FF" />
      <rect x="258" y="86" width="22" height="66" rx="11" fill="#D8E4F8" />
      <circle cx="246" cy="64" r="36" fill="#F4F8FF" />
      <path d="M270 40a36 36 0 0 1-12 56 36 36 0 0 0 12-56z" fill="#D8E4F8" />
      <ellipse cx="250" cy="66" rx="26" ry="21" fill="url(#ba-visor)" />
      <ellipse cx="241" cy="58" rx="8" ry="4.5" fill="#fff" opacity=".4" transform="rotate(-24 241 58)" />
      <circle cx="232" cy="40" r="3" fill="#FFB84D" />
      <rect x="196" y="104" width="52" height="40" rx="5" fill="#E8A56B" />
      <rect x="196" y="104" width="52" height="11" rx="3" fill="#D68F52" />
      <rect x="217" y="104" width="10" height="40" fill="#F4D3A8" opacity=".7" />
      <rect x="208" y="98" width="26" height="14" rx="7" fill="#F4F8FF" />
      <rect x="240" y="104" width="22" height="13" rx="6.5" fill="#F4F8FF" />
    </svg>
  );
}

export function PlantArt() {
  return (
    <svg viewBox="0 0 160 80" className="tips-art" aria-hidden="true">
      <path d="M0 80C14 52 52 46 78 58c22-12 58-8 82 22z" fill="#CFE9D3" />
      <path d="M20 80C34 60 64 58 84 68c16-6 40-4 56 12z" fill="#7BC98F" />
      <path d="M92 62V34" stroke="#4CAF7D" strokeWidth="3" strokeLinecap="round" />
      <path d="M92 40c-10 0-18-8-18-18 12 0 18 8 18 18z" fill="#4CAF7D" />
      <path d="M92 36c10 0 18-8 18-18-12 0-18 8-18 18z" fill="#6CCB8B" />
    </svg>
  );
}
