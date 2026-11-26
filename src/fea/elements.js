// 等參元素庫：HEX8（體素網格）與 TET10（二次四面體，節點順序採 Gmsh 慣例）

const G = 1 / Math.sqrt(3);
const HEX_SIGN = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

// TET10：0-3 角點，4:(0,1) 5:(1,2) 6:(0,2) 7:(0,3) 8:(2,3) 9:(1,3)
export const TET10_EDGES = [[0, 1], [1, 2], [0, 2], [0, 3], [2, 3], [1, 3]];
const TA = 0.5854101966249685, TB = 0.1381966011250105;

export const ELEMENTS = {
  hex8: {
    nen: 8,
    gauss: HEX_SIGN.map(([a, b, c]) => [a * G, b * G, c * G]),
    weights: new Array(8).fill(1),
    // dN/dξ（nen×3）
    dN(xi, out) {
      const [x, y, z] = xi;
      for (let n = 0; n < 8; n++) {
        const [sx, sy, sz] = HEX_SIGN[n];
        out[3 * n] = (sx * (1 + sy * y) * (1 + sz * z)) / 8;
        out[3 * n + 1] = (sy * (1 + sx * x) * (1 + sz * z)) / 8;
        out[3 * n + 2] = (sz * (1 + sx * x) * (1 + sy * y)) / 8;
      }
      return out;
    },
    /** 由積分點值外插到節點（積分點順序與節點相同） */
    extrapolate(gv, out) {
      const s = Math.sqrt(3);
      for (let n = 0; n < 8; n++) {
        const [nx, ny, nz] = HEX_SIGN[n];
        let v = 0;
        for (let k = 0; k < 8; k++) {
          const [kx, ky, kz] = HEX_SIGN[k];
          v += ((1 + kx * nx * s) * (1 + ky * ny * s) * (1 + kz * nz * s)) / 8 * gv[k];
        }
        out[n] = v;
      }
      return out;
    },
  },
  tet10: {
    nen: 10,
    gauss: [[TB, TB, TB], [TA, TB, TB], [TB, TA, TB], [TB, TB, TA]],
    weights: [1 / 24, 1 / 24, 1 / 24, 1 / 24],
    dN(xi, out) {
      const L = [1 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]];
      // dL/dξ
      const dL = [[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let i = 0; i < 4; i++)
        for (let d = 0; d < 3; d++) out[3 * i + d] = (4 * L[i] - 1) * dL[i][d];
      TET10_EDGES.forEach(([a, b], k) => {
        for (let d = 0; d < 3; d++) out[3 * (4 + k) + d] = 4 * (dL[a][d] * L[b] + L[a] * dL[b][d]);
      });
      return out;
    },
    // 積分點 i 位於 L_i = TA（i=0 對應 L0）
    extrapolate(gv, out) {
      const S = gv[0] + gv[1] + gv[2] + gv[3];
      for (let i = 0; i < 4; i++) out[i] = (gv[i] - TB * S) / (TA - TB);
      TET10_EDGES.forEach(([a, b], k) => (out[4 + k] = (out[a] + out[b]) / 2));
      return out;
    },
  },
};

/**
 * 預先計算每個元素、每個積分點的 dN/dx 與 w·detJ
 * 回傳 { dNdx: Float64Array(ne*ng*nen*3), wdet: Float64Array(ne*ng), bad: 負 Jacobian 元素數 }
 */
export function precomputeGeometry(type, nodes, elems) {
  const el = ELEMENTS[type];
  const nen = el.nen, ng = el.gauss.length;
  const ne = elems.length / nen;
  const dNdx = new Float64Array(ne * ng * nen * 3);
  const wdet = new Float64Array(ne * ng);
  const dNg = el.gauss.map((g) => el.dN(g, new Float64Array(nen * 3)));
  let bad = 0;
  for (let e = 0; e < ne; e++) {
    let neg = false;
    for (let g = 0; g < ng; g++) {
      const dn = dNg[g];
      // J = Σ x_n ⊗ dN_n/dξ  （J[i][j] = ∂x_i/∂ξ_j）
      let j00 = 0, j01 = 0, j02 = 0, j10 = 0, j11 = 0, j12 = 0, j20 = 0, j21 = 0, j22 = 0;
      for (let n = 0; n < nen; n++) {
        const p = 3 * elems[e * nen + n];
        const x = nodes[p], y = nodes[p + 1], z = nodes[p + 2];
        const a = dn[3 * n], b = dn[3 * n + 1], c = dn[3 * n + 2];
        j00 += x * a; j01 += x * b; j02 += x * c;
        j10 += y * a; j11 += y * b; j12 += y * c;
        j20 += z * a; j21 += z * b; j22 += z * c;
      }
      const det = j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) + j02 * (j10 * j21 - j11 * j20);
      if (!(det > 0)) neg = true;
      const id = 1 / det;
      // inv(J)
      const i00 = (j11 * j22 - j12 * j21) * id, i01 = (j02 * j21 - j01 * j22) * id, i02 = (j01 * j12 - j02 * j11) * id;
      const i10 = (j12 * j20 - j10 * j22) * id, i11 = (j00 * j22 - j02 * j20) * id, i12 = (j02 * j10 - j00 * j12) * id;
      const i20 = (j10 * j21 - j11 * j20) * id, i21 = (j01 * j20 - j00 * j21) * id, i22 = (j00 * j11 - j01 * j10) * id;
      const o = (e * ng + g) * nen * 3;
      for (let n = 0; n < nen; n++) {
        const a = dn[3 * n], b = dn[3 * n + 1], c = dn[3 * n + 2];
        // dN/dx_i = Σ_j dN/dξ_j · ∂ξ_j/∂x_i = Σ_j dN/dξ_j · invJ[j][i]
        dNdx[o + 3 * n] = a * i00 + b * i10 + c * i20;
        dNdx[o + 3 * n + 1] = a * i01 + b * i11 + c * i21;
        dNdx[o + 3 * n + 2] = a * i02 + b * i12 + c * i22;
      }
      wdet[e * ng + g] = el.weights[g] * Math.abs(det);
    }
    if (neg) bad++;
  }
  return { dNdx, wdet, bad };
}
