import * as THREE from 'three';
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

const PALETTE = ['#8fa3b8', '#c9a26b', '#7fb28a', '#b58fc0', '#c98282', '#7fb5c4', '#c4b97f', '#9a9fd6'];
let partSeq = 0;
let occtPromise = null;

function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: () => wasmUrl });
  return occtPromise;
}

/**
 * Part 資料結構：
 * { id, name, color, geometry: BufferGeometry(非索引), faceOfTri: Int32Array, faceCount }
 */
function makePart(name, positions, normals, faceOfTri, faceCount, color) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
  geometry.computeBoundingBox();
  const id = ++partSeq;
  return {
    id,
    name: name || `Part ${id}`,
    color: color || PALETTE[(id - 1) % PALETTE.length],
    geometry,
    basePositions: positions.slice(),
    faceOfTri,
    faceCount,
  };
}

/** 讀取 STEP 檔，每個實體 mesh 成為一個零件 */
export async function loadStep(file) {
  const occt = await getOcct();
  const buf = new Uint8Array(await file.arrayBuffer());
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.35,
  };
  const res = occt.ReadStepFile(buf, params);
  if (!res.success) throw new Error(`無法解析 STEP 檔：${file.name}`);
  const base = file.name.replace(/\.(step|stp)$/i, '');
  return res.meshes.map((m, mi) => {
    const P = m.attributes.position.array;
    const N = m.attributes.normal?.array;
    const I = m.index.array;
    const triCount = I.length / 3;
    const positions = new Float32Array(triCount * 9);
    const normals = N ? new Float32Array(triCount * 9) : null;
    for (let t = 0; t < I.length; t++) {
      const v = I[t];
      positions[3 * t] = P[3 * v]; positions[3 * t + 1] = P[3 * v + 1]; positions[3 * t + 2] = P[3 * v + 2];
      if (normals) { normals[3 * t] = N[3 * v]; normals[3 * t + 1] = N[3 * v + 1]; normals[3 * t + 2] = N[3 * v + 2]; }
    }
    const faces = m.brep_faces || [];
    const faceOfTri = new Int32Array(triCount).fill(faces.length);
    faces.forEach((f, fi) => { for (let t = f.first; t <= f.last; t++) faceOfTri[t] = fi; });
    const hasExtra = faceOfTri.some((f) => f === faces.length);
    const name = (m.name && !/^Open CASCADE/i.test(m.name) ? m.name : null) || (res.meshes.length > 1 ? `${base}_${mi + 1}` : base);
    return makePart(name, positions, normals, faceOfTri, faces.length + (hasExtra ? 1 : 0));
  });
}

function boxPart(name, x0, y0, z0, x1, y1, z1, color) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const triCount = g.attributes.position.count / 3;
  const faceOfTri = new Int32Array(triCount);
  g.groups.forEach((gr, fi) => { for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) faceOfTri[t] = fi; });
  return makePart(name, g.attributes.position.array.slice(), g.attributes.normal.array.slice(), faceOfTri, 6, color);
}

/** 示範組合件：底板 + 立柱 + 肋板（三件，黏合接觸） */
export function demoAssembly() {
  return [
    boxPart('底板', 0, 0, 0, 160, 40, 12, '#8fa3b8'),
    boxPart('立柱', 130, 0, 12, 160, 40, 90, '#c9a26b'),
    boxPart('肋板', 110, 15, 12, 130, 25, 50, '#7fb28a'),
  ];
}
