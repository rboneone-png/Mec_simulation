// 專案檔（.mecsim，JSON）：STEP 幾何、零件屬性、材料、邊界條件、零件結合與各項設定
export const PROJECT_EXT = '.mecsim';
const FORMAT = 'mecsim-project';

function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 由程式狀態建立專案物件 */
export function serializeProject(state, name, settings) {
  const usedFiles = [...new Set(state.parts.map((p) => p.fileIdx))].sort((a, b) => a - b);
  const fileMap = new Map(usedFiles.map((f, i) => [f, i]));
  const partIdx = new Map(state.parts.map((p, i) => [p.id, i]));
  return {
    format: FORMAT,
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    files: usedFiles.map((f) => ({ name: state.files[f].name, data: toBase64(state.files[f].bytes) })),
    parts: state.parts.map((p) => ({
      file: fileMap.get(p.fileIdx), mesh: p.meshIdx, name: p.name, color: p.color, visible: p.visible, material: p.material,
    })),
    bcs: state.bcs.map((b) => ({
      type: b.type, name: b.name, dirs: b.dirs, vector: b.vector, p: b.p,
      faces: [...b.faces].map((k) => { const [pid, fid] = k.split(':').map(Number); return [partIdx.get(pid), fid]; }).filter(([pi]) => pi !== undefined),
    })),
    contacts: Object.fromEntries(Object.entries(state.contacts).map(([k, v]) => {
      const [a, b] = k.split('-').map(Number);
      return [`${partIdx.get(a)}-${partIdx.get(b)}`, v];
    }).filter(([k]) => !k.includes('undefined'))),
    settings,
  };
}

/** 解析專案檔文字；回傳 { name, files:[{name, bytes}], parts, bcs, contacts, settings } */
export function parseProject(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('檔案格式錯誤：不是有效的 MecSim 專案檔'); }
  if (d.format !== FORMAT) throw new Error('檔案格式錯誤：不是 MecSim 專案檔');
  if (d.version > 1) throw new Error(`專案檔版本 ${d.version} 較新，請更新網頁後再開啟`);
  return { ...d, files: d.files.map((f) => ({ name: f.name, bytes: fromBase64(f.data) })) };
}

/** 檔名清理（移除不合法字元） */
export function safeFileName(name, fallback = 'MecSim') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return s || fallback;
}

/** 以指定檔名下載檔案（檔名由對話框決定），回傳檔名 */
export async function saveBlob(blob, fileName) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  // 延後移除連結與釋放 URL，確保瀏覽器採用指定檔名
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 3000);
  return fileName;
}

/** 瀏覽器是否支援系統「另存新檔」對話框（可自訂檔名與位置，中文檔名可靠） */
export function hasSavePicker() {
  return typeof window.showSaveFilePicker === 'function' && window.self === window.top && !window.__noSavePicker;
}

/**
 * 以系統對話框存檔：先開對話框取得檔名（需在使用者操作當下呼叫），再產生內容寫入
 * makeBlob(name) 可為非同步；回傳實際檔名（不含副檔名），取消回傳 null
 */
export async function saveWithPicker(makeBlob, suggestedName, ext, mime, description) {
  let h;
  try {
    h = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] });
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
  const name = h.name.replace(new RegExp(ext.replace('.', '\\.') + '$', 'i'), '');
  const blob = await makeBlob(name);
  const w = await h.createWritable();
  await w.write(blob);
  await w.close();
  return name;
}
