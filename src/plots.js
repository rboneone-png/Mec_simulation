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

export function colormapCss(n = 12, bands = 0) {
  if (bands > 0) {
    const parts = [];
    for (let i = 0; i < bands; i++) {
      const c = colormap(1 - i / Math.max(1, bands - 1)).map((v) => Math.round(v * 255));
      parts.push(`rgb(${c}) ${(i / bands) * 100}%`, `rgb(${c}) ${((i + 1) / bands) * 100}%`);
    }
    return `linear-gradient(to bottom, ${parts.join(',')})`;
  }
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
export function drawStressStrain(canvas, m, sim) {
  const maxStress = sim?.stress || 0;
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
    // 對應點：ε = σ/E + εp（小應變近似）
    const e = maxStress / m.E + (sim.peeq || 0);
    ctx.fillStyle = '#ff5c8a'; ctx.textAlign = 'right';
    ctx.fillText(`模擬最大 σvm ${fmt(maxStress)}${sim.peeq > 0 ? `・εp ${sim.peeq.toExponential(1)}` : ''}`, W - R - 2, y - 4);
    if (e <= xMax) { ctx.beginPath(); ctx.arc(X(e), y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
}

/** 一般 XY 曲線（負載-位移），cur 為高亮點索引 */
export function drawCurve(canvas, pts, cur, xLabel, yLabel, title) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--text-dim').trim(), line = css.getPropertyValue('--line').trim(), accent = css.getPropertyValue('--accent').trim();
  const Lm = 52, R = 12, T = 22, B = 30;
  const xMax = Math.max(...pts.map((p) => p[0])) * 1.08 || 1, yMax = Math.max(...pts.map((p) => p[1])) * 1.1 || 1;
  const X = (v) => Lm + (v / xMax) * (W - Lm - R), Y = (v) => H - B - (v / yMax) * (H - T - B);
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = fg; ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Y((yMax * i) / 4);
    ctx.beginPath(); ctx.moveTo(Lm, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(fmt((yMax * i) / 4), Lm - 4, y + 3);
    ctx.textAlign = 'center'; ctx.fillText(fmt((xMax * i) / 4), X((xMax * i) / 4), H - B + 13);
  }
  ctx.textAlign = 'center'; ctx.fillText(xLabel, (Lm + W - R) / 2, H - 4);
  ctx.textAlign = 'left'; ctx.fillText(`${title}（縱軸：${yLabel}）`, Lm, 12);
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
  ctx.stroke();
  pts.forEach(([x, y], i) => {
    ctx.fillStyle = i === cur ? '#ff5c8a' : accent;
    ctx.beginPath(); ctx.arc(X(x), Y(y), i === cur ? 5 : 2.5, 0, Math.PI * 2); ctx.fill();
  });
}
