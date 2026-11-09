/** F19 成交彩带：手写 canvas 粒子，1.5s，不挡交互，reduced-motion 不播。 */
export function fireConfetti(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.className = 'f19-confetti';
  cv.width = innerWidth;
  cv.height = innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d')!;
  const colors = ['#6366f1', '#8b5cf6', '#22d3ee', '#22c55e', '#f59e0b'];
  const ps = Array.from({ length: 120 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 240,
    y: innerHeight * 0.42,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 3,
    s: Math.random() * 7 + 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)]!,
  }));
  const t0 = performance.now();
  const tick = (t: number) => {
    const el = t - t0;
    if (el > 1500) {
      cv.remove();
      return;
    }
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = el > 1100 ? 1 - (el - 1100) / 400 : 1;
    for (const p of ps) {
      p.vy += 0.32;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
