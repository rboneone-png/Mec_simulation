import { stressStrainCurve } from './materials.js';

// 經典 FEA 彩虹色帶：藍 → 青 → 綠 → 黃 → 紅
const STOPS = [
  [0, [0.0, 0.0, 0.85]], [0.125, [0.0, 0.35, 1.0]], [0.25, [0.0, 0.75, 1.0]],
  [0.375, [0.0, 0.95, 0.7]], [0.5, [0.2, 0.95, 0.2]], [0.625, [0.7, 0.95, 0.0]],
  [0.75, [1.0, 0.85, 0.0]], [0.875, [1.0, 0.45, 0.0]], [1, [0.9, 0.0, 0.0]],
];

export function colormap(t, out = [0, 0, 0]) {
  t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      for (let k = 0; k < 3; k++) out[k] = c0[k] + (c1[k] - c0[k]) * f;
      return out;
    }
  }
  return out;
}

export function colormapCss(n = 12) {
  const parts = [];
  for (let i = 0; i <= n; i++) {
    const c = colormap(1 - i / n).map((v) => Math.round(v * 255));
    parts.push(`rgb(${c}) ${(i / n) * 100}%`);
  }
  return `linear-gradient(to bottom, ${parts.join(',')})`;
}

export function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return Number(v.toPrecision(digits)).toString();
}

/** 在 canvas 上繪製應力-應變曲線，maxStress 為模擬最大 von Mises（可選） */
export function drawStressStrain(canvas, m, maxStress) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--text-dim').trim() || '#9aa4b2';
  const line = css.getPropertyValue('--line').trim() || '#333';
  const accent = css.getPropertyValue('--accent').trim() || '#3d8bfd';

  const { pts, ey, ef } = stressStrainCurve(m);
  const L = 44, R = 10, T = 12, B = 30;
  const xMax = ef * 1.08;
  const yMax = Math.max(m.su, maxStress || 0) * 1.15;
  const X = (e) => L + (e / xMax) * (W - L - R);
  const Y = (s) => H - B - (s / yMax) * (H - T - B);

  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = fg; ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const s = (yMax * i) / 4, y = Y(s);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(s), L - 4, y + 3);
    const e = (xMax * i) / 4, x = X(e);
    ctx.textAlign = 'center'; ctx.fillText(`${(e * 100).toFixed(1)}`, x, H - B + 13);
  }
  ctx.fillText('應變 ε [%]', (L + W - R) / 2, H - 4);
  ctx.save(); ctx.translate(10, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('應力 σ [MPa]', 0, 0); ctx.restore();

  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([e, s], i) => (i ? ctx.lineTo(X(e), Y(s)) : ctx.moveTo(X(e), Y(s))));
  ctx.stroke();

  const mark = (e, s, label, color) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(e), Y(s), 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillText(label, X(e) + 6, Y(s) - 5);
  };
  mark(ey, m.sy, `σy ${m.sy}`, '#f5b84a');
  const iu = pts.reduce((b, p, i) => (p[1] > pts[b][1] ? i : b), 0);
  mark(pts[iu][0], pts[iu][1], `σu ${m.su}`, '#f07167');

  if (maxStress > 0) {
    const y = Y(maxStress);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.setLineDash([]);
    const e = maxStress <= m.sy ? maxStress / m.E : null;
    ctx.fillStyle = '#ff5c8a'; ctx.textAlign = 'right';
    ctx.fillText(`模擬最大 σvm ${fmt(maxStress)}`, W - R - 2, y - 4);
    if (e !== null) { ctx.beginPath(); ctx.arc(X(e), y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
}
