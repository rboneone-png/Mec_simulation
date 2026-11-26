// PDF 報告：以 canvas 繪製每一頁（支援中文，不需嵌入字型），再以 jsPDF 組成 A4 PDF
import { colormap } from './plots.js';

const W = 1240, H = 1754; // A4 @150 dpi
const M = 90; // 邊界
const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC",system-ui,sans-serif';
const C = { text: '#1d2530', dim: '#5d6878', line: '#d5dbe3', head: '#16324f', accent: '#2f6fd6', bad: '#c0392b', mid: '#c27c0e', ok: '#1e8a4f', band: '#eef2f7' };

class Doc {
  constructor(meta) {
    this.meta = meta;
    this.pages = [];
    this.newPage();
  }
  newPage() {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    this.cv = cv; this.g = g; this.y = M;
    this.pages.push(cv);
    // 頁首
    g.fillStyle = C.head; g.fillRect(0, 0, W, 8);
    g.font = `500 17px ${FONT}`; g.fillStyle = C.dim; g.textBaseline = 'alphabetic';
    g.textAlign = 'left'; g.fillText(`MecSim 結構分析報告｜${this.meta.name}`, M, 46);
    g.textAlign = 'right'; g.fillText(this.meta.date, W - M, 46);
    g.textAlign = 'left';
    g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(M, 60); g.lineTo(W - M, 60); g.stroke();
    this.y = 100;
  }
  ensure(h) { if (this.y + h > H - M) this.newPage(); }
  /** 自動換行（以字元為單位，適用中英文） */
  wrap(text, maxW, font) {
    const g = this.g;
    g.font = font;
    const lines = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const ch of para) {
        if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch;
      }
      lines.push(cur);
    }
    return lines;
  }
  text(t, { size = 19, weight = 400, color = C.text, indent = 0, gap = 8, lh = 1.5 } = {}) {
    const font = `${weight} ${size}px ${FONT}`;
    const lines = this.wrap(t, W - 2 * M - indent, font);
    for (const ln of lines) {
      this.ensure(size * lh);
      this.g.font = font; this.g.fillStyle = color;
      this.g.fillText(ln, M + indent, this.y + size);
      this.y += size * lh;
    }
    this.y += gap;
  }
  heading(t) {
    this.ensure(70);
    this.y += 14;
    const g = this.g;
    g.fillStyle = C.accent; g.fillRect(M, this.y + 4, 6, 28);
    g.font = `700 26px ${FONT}`; g.fillStyle = C.head; g.fillText(t, M + 18, this.y + 28);
    this.y += 48;
  }
  /** 表格：cols = [{ label, w(比例), align }]，rows = [[文字或 {t, color}]] */
  table(cols, rows) {
    const g = this.g, tw = W - 2 * M, size = 17, rh = 34;
    const xs = [];
    let x = M;
    const total = cols.reduce((s, c) => s + c.w, 0);
    for (const c of cols) { xs.push(x); x += (c.w / total) * tw; }
    xs.push(M + tw);
    const drawRow = (cells, head) => {
      this.ensure(rh);
      if (head) { g.fillStyle = C.band; g.fillRect(M, this.y, tw, rh); }
      cells.forEach((cell, i) => {
        const v = typeof cell === 'object' && cell !== null ? cell : { t: cell };
        g.font = `${head ? 600 : 400} ${size}px ${FONT}`;
        g.fillStyle = head ? C.head : v.color || C.text;
        const align = cols[i].align || 'left';
        let t = String(v.t ?? '');
        const maxW = xs[i + 1] - xs[i] - 16;
        while (g.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -2) + '…';
        g.textAlign = align;
        g.fillText(t, align === 'right' ? xs[i + 1] - 8 : xs[i] + 8, this.y + rh / 2 + size * 0.36);
        g.textAlign = 'left';
      });
      g.strokeStyle = C.line; g.beginPath(); g.moveTo(M, this.y + rh); g.lineTo(M + tw, this.y + rh); g.stroke();
      this.y += rh;
    };
    drawRow(cols.map((c) => c.label), true);
    for (const r of rows) drawRow(r, false);
    this.y += 14;
  }
  /** 鍵值清單（兩欄） */
  kv(pairs) {
    const rows = [];
    for (let i = 0; i < pairs.length; i += 2) rows.push([...pairs[i], ...(pairs[i + 1] || ['', ''])]);
    const g = this.g, size = 18, rh = 32, half = (W - 2 * M) / 2;
    for (const [k1, v1, k2, v2] of rows) {
      this.ensure(rh);
      for (const [k, v, x0] of [[k1, v1, M], [k2, v2, M + half]]) {
        if (!k) continue;
        g.font = `400 ${size}px ${FONT}`; g.fillStyle = C.dim; g.fillText(k, x0, this.y + size);
        g.font = `500 ${size}px ${FONT}`; g.fillStyle = C.text;
        let t = String(v);
        while (g.measureText(t).width > half - 200 && t.length > 1) t = t.slice(0, -2) + '…';
        g.fillText(t, x0 + 180, this.y + size);
      }
      this.y += rh;
    }
    this.y += 10;
  }
  /** 圖片（canvas 或 Image），寬度占滿版面，可附圖例 */
  image(img, caption, legend, maxFrac = 1) {
    const tw = (W - 2 * M) * maxFrac;
    const legendW = legend ? 150 : 0;
    const iw = tw - legendW, ih = Math.min((img.height / img.width) * iw, 620);
    const dw = Math.min(iw, (img.width / img.height) * ih);
    this.ensure(ih + 50);
    const g = this.g;
    g.fillStyle = '#f3f5f8'; g.fillRect(M, this.y, tw, ih);
    g.drawImage(img, M + (iw - dw) / 2, this.y, dw, ih);
    g.strokeStyle = C.line; g.strokeRect(M, this.y, tw, ih);
    if (legend) this.legend(M + iw + 20, this.y + 20, ih - 40, legend);
    this.y += ih + 8;
    if (caption) this.text(caption, { size: 16, color: C.dim, gap: 10 });
  }
  legend(x, y, h, { title, range, bands }) {
    const g = this.g, bw = 22;
    g.font = `600 14px ${FONT}`; g.fillStyle = C.text;
    const tl = this.wrap(title, 120, g.font);
    tl.forEach((t, i) => g.fillText(t, x, y + 14 + i * 18));
    const y0 = y + tl.length * 18 + 10, hh = h - tl.length * 18 - 10;
    for (let i = 0; i < hh; i++) {
      let t = 1 - i / hh;
      if (bands > 0) t = Math.min(bands - 1, Math.floor(t * bands)) / Math.max(1, bands - 1);
      const c = colormap(t).map((v) => Math.round(v * 255));
      g.fillStyle = `rgb(${c})`; g.fillRect(x, y0 + i, bw, 1);
    }
    g.strokeStyle = C.line; g.strokeRect(x, y0, bw, hh);
    g.font = `400 13px ${FONT}`; g.fillStyle = C.text;
    for (let i = 0; i <= 10; i++) {
      const v = range[1] - ((range[1] - range[0]) * i) / 10;
      g.fillText(fmtN(v), x + bw + 8, y0 + (hh * i) / 10 + 5);
    }
  }
}

export function fmtN(v, d = 3) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return String(Number(v.toPrecision(d)));
}

/**
 * 產生 PDF Blob
 * data = { name, date, parts:[], mesh, bcs:[], contacts:[], analysis:{}, results|null, images:[{img, caption, legend}], charts:[{img, caption}] }
 */
export async function buildReportPdf(data) {
  const doc = new Doc({ name: data.name, date: data.date });
  const g = doc.g;
  // 封面標題
  g.font = `700 44px ${FONT}`; g.fillStyle = C.head; g.fillText(data.name, M, doc.y + 44);
  doc.y += 70;
  doc.text(`結構分析報告｜${data.analysis.typeLabel}｜產出時間 ${data.date}`, { size: 19, color: C.dim, gap: 20 });

  doc.heading('1. 模型與材料');
  doc.table(
    [{ label: '零件', w: 2.2 }, { label: '分類', w: 0.8 }, { label: '材料', w: 2.6 }, { label: 'E [GPa]', w: 1, align: 'right' }, { label: 'ν', w: 0.7, align: 'right' }, { label: 'σy [MPa]', w: 1.1, align: 'right' }, { label: '質量', w: 1.2, align: 'right' }],
    data.parts.map((p) => [p.name, p.cat, p.material, fmtN(p.E / 1000), fmtN(p.nu), fmtN(p.sy), p.mass]),
  );

  doc.heading('2. 網格');
  if (data.mesh) doc.kv([['元素類型', data.mesh.type], ['元素尺寸', `${fmtN(data.mesh.size)} mm`], ['元素數', data.mesh.elems.toLocaleString()], ['節點數', data.mesh.nodes.toLocaleString()], ['最小縮放 Jacobian', data.mesh.quality ?? '—']]);
  else doc.text('尚未產生網格。', { color: C.dim });

  doc.heading('3. 邊界條件');
  if (data.bcs.length) doc.table([{ label: '名稱', w: 2 }, { label: '類型', w: 1 }, { label: '作用面', w: 2.6 }, { label: '數值', w: 2.2 }], data.bcs.map((b) => [b.name, b.type, b.faces, b.value]));
  else doc.text('未設定。', { color: C.dim });

  if (data.contacts.length) {
    doc.heading('4. 零件結合');
    doc.table([{ label: '零件組', w: 3 }, { label: '接觸面積 [mm²]', w: 1.4, align: 'right' }, { label: '結合方式', w: 2.4 }], data.contacts.map((c) => [c.pair, fmtN(c.area), c.type]));
  }

  doc.heading(`${data.contacts.length ? 5 : 4}. 分析設定`);
  doc.kv(data.analysis.kv);

  const sec = data.contacts.length ? 6 : 5;
  doc.heading(`${sec}. 結果摘要`);
  const R = data.results;
  if (!R) doc.text('尚未執行模擬（或設定已變更、結果已失效）。', { color: C.dim });
  else {
    doc.table(R.cols, R.rows);
    if (R.notes.length) for (const n of R.notes) doc.text(n, { size: 16, color: C.dim, gap: 2 });
    if (R.warnings.length) {
      doc.y += 8;
      doc.text('警告：', { size: 18, weight: 600, color: C.bad, gap: 2 });
      for (const w of R.warnings) doc.text(`• ${w}`, { size: 16, color: C.bad, gap: 2, indent: 12 });
    }
  }

  if (data.images.length || data.charts.length) {
    doc.ensure(560); // 標題與第一張圖放在同一頁
    doc.heading(`${sec + 1}. 結果圖`);
    for (const im of data.images) doc.image(im.img, im.caption, im.legend);
    for (const ch of data.charts) doc.image(ch.img, ch.caption, null, 0.62);
  }

  doc.y += 10;
  doc.text('說明：本報告由 MecSim 於瀏覽器端計算產生（小應變有限元素分析）。尖角與拘束邊緣的應力可能為數值奇異點；材料數值為典型值，正式設計請依實際材料規格與相關規範驗證。', { size: 15, color: C.dim });

  // 頁碼
  doc.pages.forEach((cv, i) => {
    const pg = cv.getContext('2d');
    pg.font = `400 15px ${FONT}`; pg.fillStyle = C.dim; pg.textAlign = 'center';
    pg.fillText(`${i + 1} / ${doc.pages.length}`, W / 2, H - 40);
  });

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  pdf.setProperties({ title: `${data.name} 結構分析報告`, creator: 'MecSim' });
  doc.pages.forEach((cv, i) => {
    if (i) pdf.addPage();
    pdf.addImage(cv.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
  });
  return { blob: pdf.output('blob'), pages: doc.pages.length };
}
