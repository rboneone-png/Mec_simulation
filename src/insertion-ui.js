// 「插入力計算」分頁介面
import { MATERIALS, CATEGORIES } from './materials.js';
import { MU_PRESETS } from './fea/contact.js';
import { pressFit, snapFit } from './insertion.js';
import { drawXY, drawStressStrain, fmt } from './plots.js';

const $ = (id) => document.getElementById(id);
const MU_PLASTIC = [['PC–PC', 0.5], ['ABS–ABS', 0.5], ['PA–PA', 0.35], ['POM–POM', 0.25], ['POM–鋼', 0.2], ['PC／ABS–鋼', 0.4], ['PP–鋼', 0.3], ['PE–鋼', 0.25]];

const PRESS_FIELDS = ['d', 'D', 'delta', 'di', 'L', 'S', 'alpha'];
const SNAP_FIELDS = ['L', 'h', 'b', 'y', 'alpha', 'alpha2'];

export const INS_DEFAULTS = {
  kind: 'press', mu: 0.15, model: 'curve',
  press: { shaft: 's45c', hub: 's45c', d: 20, D: 40, delta: 0.02, di: 0, L: 20, S: 20, alpha: 15 },
  snap: { mat: 'pc', L: 15, h: 1.5, b: 5, y: 1, alpha: 30, alpha2: 90 },
};

const st = structuredClone(INS_DEFAULTS);
let result = null, error = null;
let onChange = () => {};

function matOptions() {
  const groups = new Map();
  for (const [k, m] of Object.entries(MATERIALS)) {
    const g = `${CATEGORIES[m.cat]}／${m.group}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`<option value="${k}">${m.name}</option>`);
  }
  return [...groups].map(([g, o]) => `<optgroup label="${g}">${o.join('')}</optgroup>`).join('');
}

const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : 0; };

function readForm() {
  st.mu = Math.max(0, num('insMu'));
  st.model = $('insModel').value;
  st.press.shaft = $('insShaft').value; st.press.hub = $('insHub').value; st.snap.mat = $('insSnapMat').value;
  for (const f of PRESS_FIELDS) st.press[f] = num(`in_${f}`);
  for (const f of SNAP_FIELDS) st.snap[f] = num(`sn_${f}`);
}

function writeForm() {
  $('insMu').value = st.mu; $('insModel').value = st.model;
  $('insShaft').value = st.press.shaft; $('insHub').value = st.press.hub; $('insSnapMat').value = st.snap.mat;
  for (const f of PRESS_FIELDS) $(`in_${f}`).value = st.press[f];
  for (const f of SNAP_FIELDS) $(`sn_${f}`).value = st.snap[f];
  setKind(st.kind, false);
}

function setKind(kind, recalc = true) {
  st.kind = kind;
  document.body.classList.toggle('ins-press', kind === 'press');
  document.body.classList.toggle('ins-snap', kind === 'snap');
  for (const b of $('insKind').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === kind);
  $('insKindNote').textContent = kind === 'press'
    ? '軸壓入孔（干涉配合）：以厚壁圓筒 Lamé 解求接觸壓力，導角段依楔形摩擦計算，圓柱段為 μ·p·πd·接觸長度。'
    : '懸臂卡扣插入：依應力-應變曲線積分彎矩-曲率求撓曲力，再以斜面摩擦換算插入力與退出力。';
  if (recalc) compute();
}

const mat = (k) => ({ key: k, ...MATERIALS[k] });

export function compute() {
  readForm();
  const linear = st.model === 'linear';
  error = null;
  try {
    result = st.kind === 'press'
      ? pressFit({ ...st.press, shaft: mat(st.press.shaft), hub: mat(st.press.hub), mu: st.mu, linear })
      : snapFit({ ...st.snap, mat: mat(st.snap.mat), mu: st.mu, linear });
  } catch (e) { result = null; error = e.message; }
  render();
  onChange();
}

const kpi = (k, v, unit, sub = '', main = false) => `<div class="kpi${main ? ' main' : ''}"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
const pct = (e) => `${fmt(e * 100)} %`;

/** 結果摘要（畫面與 PDF 共用） */
export function summary() {
  if (!result) return null;
  const R = result, lin = st.model === 'linear';
  if (R.kind === 'press') {
    const P = st.press, sh = MATERIALS[P.shaft], hb = MATERIALS[P.hub];
    return {
      kind: '壓入配合（軸／孔干涉配合）',
      inputs: [
        ['軸材料', sh.name], ['軸套材料', hb.name], ['公稱直徑 d', `${fmt(P.d)} mm`], ['軸套外徑 D', `${fmt(P.D)} mm`],
        ['軸內徑 dᵢ', P.di ? `${fmt(P.di)} mm` : '實心'], ['直徑干涉量 δ', `${fmt(P.delta)} mm`], ['軸套長度 L', `${fmt(P.L)} mm`],
        ['壓入深度 S', `${fmt(Math.min(P.S, P.L))} mm`], ['導角角度 α', `${fmt(P.alpha)}°`], ['摩擦係數 μ', fmt(st.mu)],
        ['應力-應變模型', lin ? '線彈性' : '依應力-應變曲線（割線模數）'],
      ],
      kpis: [
        ['最大插入力', fmt(R.Fmax), 'N', `${fmt(R.Fmax / 9.80665)} kgf${lin ? '' : `・線彈性 ${fmt(R.FmaxLinear)} N`}`, true],
        ['拔出力（保持力）', fmt(R.Fpull), 'N', 'μ·p·πd·S'],
        ['傳遞扭矩', fmt(R.torque), 'N·m', 'μ·p·πd·S·d/2'],
        ['接觸壓力 p', fmt(R.p), 'MPa', lin ? '' : `線彈性 ${fmt(R.pLinear)} MPa`],
      ],
      rows: [
        ['接觸壓力 p', `${fmt(R.p)} MPa`],
        ['軸套內壁 環向應力 σθ', `${fmt(R.hub.hoop)} MPa`],
        ['軸套內壁 von Mises', `${fmt(R.hub.vm)} MPa（σy ${hb.sy}）`],
        ['軸套等效應變', pct(R.hub.eps)],
        ['軸 von Mises', `${fmt(R.shaft.vm)} MPa（σy ${sh.sy}）`],
        ['軸等效應變', pct(R.shaft.eps)],
        ['軸套安全係數（降伏）', fmt(R.hub.sf)],
        ['軸安全係數（降伏）', fmt(R.shaft.sf)],
        ['軸套外徑膨脹量', `${fmt(R.hubGrowth * 1000)} µm`],
        ['有效導角長度 c', `${fmt(R.c)} mm`],
        ['壓入行程', `${fmt(R.xEnd)} mm`],
        ['壓入功', `${fmt(R.work)} J`],
      ],
      ss: [
        { title: `軸套：${hb.name}`, m: hb, stress: R.hub.vm, eps: R.hub.eps },
        { title: `軸：${sh.name}`, m: sh, stress: R.shaft.vm, eps: R.shaft.eps },
      ],
      warnings: R.warnings,
      method: '方法：厚壁圓筒 Lamé 解求干涉配合壓力 p = δ / { d·[(K<sub>h</sub>+ν<sub>h</sub>)/E<sub>h</sub> + (K<sub>s</sub>−ν<sub>s</sub>)/E<sub>s</sub>] }，K<sub>h</sub> = (D²+d²)/(D²−d²)。<b>依應力-應變曲線</b>時，以內壁 von Mises 等效應力查材料曲線取割線模數與等效蒲松比（變形理論），迭代求解，故降伏後壓力會低於線彈性值。插入力：圓柱段 μ·p·πd·接觸長度；導角段以局部干涉量求局部壓力，楔形係數 (tanα+μ)/(1−μ·tanα)。假設：平面應力、軸向均勻、靜摩擦＝動摩擦、未考慮溫度與表面粗糙度壓平。',
    };
  }
  const S = st.snap, m = MATERIALS[S.mat];
  return {
    kind: '懸臂卡扣（矩形等截面）',
    inputs: [
      ['材料', m.name], ['懸臂長度 L', `${fmt(S.L)} mm`], ['根部厚度 h', `${fmt(S.h)} mm`], ['寬度 b', `${fmt(S.b)} mm`],
      ['卡勾高度 y', `${fmt(S.y)} mm`], ['插入角 α', `${fmt(S.alpha)}°`], ['退出角 α′', `${fmt(S.alpha2)}°`], ['摩擦係數 μ', fmt(st.mu)],
      ['應力-應變模型', lin ? '線彈性' : '依應力-應變曲線（彎矩-曲率積分）'],
    ],
    kpis: [
      ['最大插入力', fmt(R.Fin), 'N', `${fmt(R.Fin / 9.80665)} kgf${lin ? '' : `・線彈性 ${fmt(R.FinLinear)} N`}`, true],
      ['退出力（保持力）', R.selfLockOut ? '自鎖' : fmt(R.Fout), R.selfLockOut ? '' : 'N', R.selfLockOut ? '退出面自鎖，無法以拉力脫開' : `退出角 ${fmt(S.alpha2)}°`],
      ['撓曲力 P', fmt(R.P), 'N', lin ? '' : `線彈性 ${fmt(R.Pel)} N`],
      ['根部最大應變', pct(R.eps), '', `降伏應變 ${pct(R.ey)}`],
    ],
    rows: [
      ['撓曲力 P', `${fmt(R.P)} N`],
      ['根部最大應變 ε', pct(R.eps)],
      ['根部最大應力', `${fmt(R.sRoot)} MPa（σy ${m.sy}）`],
      ['應變比 ε / ε降伏', fmt(R.eps / R.ey)],
      ['斷裂應變', pct(R.ef)],
      ['插入行程（斜面段）', `${fmt(R.xEnd)} mm`],
      ['插入功', `${fmt(R.work * 1000)} mJ`],
    ],
    ss: [{ title: `卡扣：${m.name}`, m, stress: R.sRoot, eps: R.eps }],
    warnings: R.warnings,
    method: '方法：撓曲力 P 由尖端撓度 y 反求。<b>依應力-應變曲線</b>時，對截面積分 M(κ) = 2b∫σ(κz)z dz 求彎矩-曲率關係，再沿懸臂積分撓度 y = ∫κ(P·s)·s ds（拉壓對稱），可反映降伏後剛性下降；線彈性時 P = 3EIy/L³、ε = 1.5·h·y/L²。插入力 W = P·(μ+tanα)/(1−μ·tanα)，退出力以退出角 α′ 計算。假設：等截面、小轉角、忽略卡勾本身變形與根部圓角應力集中（實際根部應力會更高，建議 R ≥ 0.5h）。',
  };
}

function render() {
  const S = summary();
  const wb = $('insWarn');
  if (error || !S) {
    $('insKpis').innerHTML = '';
    wb.hidden = false; wb.innerHTML = `<div class="ins-err">⚠ ${error || '無法計算'}</div>`;
    $('insTable').innerHTML = '';
    return;
  }
  $('insKpis').innerHTML = S.kpis.map((k) => kpi(...k)).join('');
  wb.hidden = !S.warnings.length;
  wb.innerHTML = S.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  $('insTable').innerHTML = S.rows.map(([k, v]) => `<tr><th>${k}</th><td class="num">${v}</td></tr>`).join('');
  $('insMethod').innerHTML = S.method;
  const brief = (m) => `<b>${m.name}</b>：E ${fmt(m.E / 1000)} GPa・σy ${m.sy}・σu ${m.su} MPa・εf ${fmt(m.ef * 100)}%`;
  $('insMatBrief').innerHTML = st.kind === 'press'
    ? `軸 ${brief(MATERIALS[st.press.shaft])}<br>軸套 ${brief(MATERIALS[st.press.hub])}`
    : brief(MATERIALS[st.snap.mat]);
  $('insSS2Card').hidden = S.ss.length < 2;
  S.ss.forEach((s, i) => { $(`insSS${i + 1}T`).textContent = `應力-應變曲線・${s.title}`; });
  draw();
}

/** 重新繪製圖表（分頁切換或視窗縮放時呼叫） */
export function draw() {
  if (!result || $('insPage').hidden) return;
  const S = summary(), R = result, lin = st.model === 'linear';
  const series = [{ pts: R.curve, color: '#3d8bfd', label: lin ? '線彈性' : '依應力-應變曲線' }];
  if (!lin) series.push({ pts: R.curveLinear, color: '#9aa4b2', dash: [5, 4], width: 1.5, label: '線彈性對照' });
  const peak = R.curve.reduce((b, q) => (q[1] > b[1] ? q : b), [0, 0]);
  drawXY($('insForce'), series, {
    title: R.kind === 'press' ? '插入力 - 壓入行程' : '插入力 - 插入行程',
    xLabel: '行程 [mm]', yLabel: '插入力 [N]',
    marks: [{ x: peak[0], y: peak[1], label: `最大 ${fmt(peak[1])} N` }],
  });
  S.ss.forEach((s, i) => drawStressStrain($(`insSS${i + 1}`), s.m, { stress: s.stress, peeq: Math.max(0, s.eps - s.stress / s.m.E), label: '工作點 σvm' }));
  drawSketch($('insSketch'));
}

function drawSketch(cv) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const dim = css.getPropertyValue('--text-dim').trim() || '#9aa4b2';
  g.font = '11px system-ui, sans-serif'; g.lineWidth = 1.5;
  const arrowH = (x0, x1, y, t) => { g.strokeStyle = dim; g.fillStyle = dim; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.textAlign = 'center'; g.fillText(t, (x0 + x1) / 2, y - 4); };
  const arrowV = (x, y0, y1, t, left) => { g.strokeStyle = dim; g.fillStyle = dim; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.textAlign = left ? 'right' : 'left'; g.fillText(t, x + (left ? -4 : 4), (y0 + y1) / 2 + 4); };
  if (st.kind === 'press') {
    const P = st.press;
    const cx = W * 0.56, cy = H / 2, sc = Math.min((H - 40) / P.D, (W * 0.42) / Math.max(P.L, 1));
    const rD = (P.D / 2) * sc, rd = (P.d / 2) * sc, Lp = P.L * sc;
    const x0 = cx - Lp / 2;
    g.fillStyle = 'rgba(143,163,184,.35)'; g.strokeStyle = '#8fa3b8';
    for (const s of [-1, 1]) { g.fillRect(x0, cy + s * rd - (s > 0 ? 0 : rD - rd), Lp, rD - rd); g.strokeRect(x0, cy + s * rd - (s > 0 ? 0 : rD - rd), Lp, rD - rd); }
    // 軸（自左方壓入，前端導角）
    const tip = x0 + Lp * 0.55, ch = Math.min(rd * 0.35, 10);
    g.fillStyle = 'rgba(61,139,253,.35)'; g.strokeStyle = '#3d8bfd';
    g.beginPath(); g.moveTo(14, cy - rd); g.lineTo(tip - ch, cy - rd); g.lineTo(tip, cy - rd + ch); g.lineTo(tip, cy + rd - ch); g.lineTo(tip - ch, cy + rd); g.lineTo(14, cy + rd); g.closePath(); g.fill(); g.stroke();
    if (P.di > 0) { const ri = (P.di / 2) * sc; g.fillStyle = css.getPropertyValue('--bg').trim(); g.fillRect(14, cy - ri, tip - 14 - ch, 2 * ri); }
    g.fillStyle = '#ff5c8a'; g.textAlign = 'left'; g.font = '600 12px system-ui, sans-serif'; g.fillText('F →', 18, cy + 4); g.font = '11px system-ui, sans-serif';
    arrowH(x0, x0 + Lp, cy - rD - 8, `L = ${fmt(P.L)}`);
    arrowV(x0 + Lp + 14, cy - rD, cy + rD, `D = ${fmt(P.D)}`);
    arrowV(x0 + Lp + 4, cy - rd, cy + rd, `d = ${fmt(P.d)}`, true);
    g.textAlign = 'center'; g.fillStyle = dim; g.fillText(`δ = ${fmt(P.delta)}・α = ${fmt(P.alpha)}°・μ = ${fmt(st.mu)}`, W / 2, H - 6);
  } else {
    const S = st.snap;
    const sc = Math.min((W - 90) / (S.L * 1.35), (H - 60) / (S.h * 2 + S.y * 2.2 + 2));
    const bx = 40, by = H * 0.38, h = S.h * sc, L = S.L * sc, y = S.y * sc;
    g.fillStyle = 'rgba(201,138,214,.3)'; g.strokeStyle = '#c98ad6';
    g.fillRect(bx - 26, by - 30, 26, h + 60); g.strokeRect(bx - 26, by - 30, 26, h + 60);
    // 懸臂與卡勾（插入面 α、退出面 α′）
    const tA = Math.tan((Math.max(S.alpha, 1) * Math.PI) / 180), tB = Math.tan((Math.max(Math.min(S.alpha2, 89.5), 1) * Math.PI) / 180);
    const xr = bx + L;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(xr, by); g.lineTo(xr + y / tA, by + h + y); g.lineTo(xr - 0, by + h + y); g.lineTo(xr - y / tB, by + h); g.lineTo(bx, by + h); g.closePath(); g.fill(); g.stroke();
    // 配合件（往上推）
    g.fillStyle = 'rgba(143,163,184,.3)'; g.strokeStyle = '#8fa3b8';
    g.fillRect(xr - 6, by + h + y + 6, 50, 18); g.strokeRect(xr - 6, by + h + y + 6, 50, 18);
    g.fillStyle = '#ff5c8a'; g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'left'; g.fillText('↑ F', xr + 48, by + h + y + 20); g.font = '11px system-ui, sans-serif';
    arrowH(bx, xr, by - 8, `L = ${fmt(S.L)}`);
    arrowV(bx + 10, by, by + h, `h = ${fmt(S.h)}`);
    arrowV(xr + y / tA + 10, by + h, by + h + y, `y = ${fmt(S.y)}`);
    g.textAlign = 'center'; g.fillStyle = dim; g.fillText(`b = ${fmt(S.b)}・α = ${fmt(S.alpha)}°・α′ = ${fmt(S.alpha2)}°・μ = ${fmt(st.mu)}`, W / 2, H - 6);
  }
}

export function getInsertionState() { return structuredClone(st); }
export function setInsertionState(s) {
  if (!s) return;
  const merge = (a, b) => { for (const k of Object.keys(a)) if (b?.[k] !== undefined) a[k] = typeof a[k] === 'object' ? (merge(a[k], b[k]), a[k]) : b[k]; };
  merge(st, s);
  for (const k of ['shaft', 'hub']) if (!MATERIALS[st.press[k]]) st.press[k] = INS_DEFAULTS.press[k];
  if (!MATERIALS[st.snap.mat]) st.snap.mat = INS_DEFAULTS.snap.mat;
  writeForm();
  compute();
}

/** PDF 報告用資料 */
export function insertionReportData() {
  const S = summary();
  if (!S) return null;
  const img = (id) => {
    const c = $(id);
    if (!c.width || c.offsetParent === null) return null;
    const out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    const g = out.getContext('2d');
    g.fillStyle = '#1b1f26'; g.fillRect(0, 0, out.width, out.height); g.drawImage(c, 0, 0);
    return out;
  };
  return { ...S, method: S.method.replace(/<\/?b>/g, '').replace(/<sub>(.*?)<\/sub>/g, '$1'), images: { force: img('insForce'), sketch: img('insSketch'), ss: S.ss.map((_, i) => img(`insSS${i + 1}`)) } };
}

export function initInsertion({ changed } = {}) {
  if (changed) onChange = changed;
  const opts = matOptions();
  for (const id of ['insShaft', 'insHub', 'insSnapMat']) $(id).innerHTML = opts;
  $('insMuPreset').innerHTML = '<option value="">選擇…</option>'
    + `<optgroup label="金屬">${MU_PRESETS.map(([n, v]) => `<option value="${v}">${n}：${v}</option>`).join('')}</optgroup>`
    + `<optgroup label="塑膠">${MU_PLASTIC.map(([n, v]) => `<option value="${v}">${n}：${v}</option>`).join('')}</optgroup>`;
  $('insMuPreset').onchange = (e) => { if (e.target.value) { $('insMu').value = e.target.value; e.target.value = ''; compute(); } };
  for (const b of $('insKind').querySelectorAll('button')) b.onclick = () => setKind(b.dataset.kind);
  for (const el of $('insPage').querySelectorAll('input, select:not(#insMuPreset)')) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', compute);
  new ResizeObserver(() => draw()).observe($('insView'));
  writeForm();
  compute();
}
