import { useState } from 'react';

/** 首页横幅：优先用本地设计图（web/public/banner-star.png，不进仓库）；图缺失时回退纯 CSS 渐变横幅。 */
export function Hero() {
  const [imgOk, setImgOk] = useState(true);
  if (!imgOk) {
    return (
      <section className="hero" aria-label="闲置星球">
        <div>
          <h1>闲置星球</h1>
          <h2>公司内部闲置物品循环平台</h2>
          <span className="capsule">让闲置物品在同事之间重新流动</span>
        </div>
      </section>
    );
  }
  return (
    <section className="hero-art" aria-label="闲置星球">
      <img src="/banner-star.png" onError={() => setImgOk(false)} alt="闲置星球 — 让闲置物品重新流动" />
    </section>
  );
}
