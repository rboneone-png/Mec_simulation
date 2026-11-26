// 8 節點六面體（trilinear hex）元素
// 節點順序（局部座標 ξ,η,ζ ∈ {-1,1}）：
// 0(-,-,-) 1(+,-,-) 2(+,+,-) 3(-,+,-) 4(-,-,+) 5(+,-,+) 6(+,+,+) 7(-,+,+)
export const HEX_NODES = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const SIGN = HEX_NODES.map(([a, b, c]) => [2 * a - 1, 2 * b - 1, 2 * c - 1]);

/** 等向性線彈性矩陣 D（6x6，Voigt：xx,yy,zz,xy,yz,zx，工程剪應變） */
export function dMatrix(E, nu) {
  const c = E / ((1 + nu) * (1 - 2 * nu));
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) D[i * 6 + j] = c * (i === j ? 1 - nu : nu);
  for (let i = 3; i < 6; i++) D[i * 6 + i] = (c * (1 - 2 * nu)) / 2;
  return D;
}

/** 應變-位移矩陣 B（6x24），邊長 h 的立方體元素 */
export function bMatrix(xi, eta, zeta, h) {
  const B = new Float64Array(144);
  const s = 2 / h / 8;
  for (let n = 0; n < 8; n++) {
    const [sx, sy, sz] = SIGN[n];
    const dx = sx * (1 + sy * eta) * (1 + sz * zeta) * s;
    const dy = sy * (1 + sx * xi) * (1 + sz * zeta) * s;
    const dz = sz * (1 + sx * xi) * (1 + sy * eta) * s;
    const c = 3 * n;
    B[0 * 24 + c] = dx;
    B[1 * 24 + c + 1] = dy;
    B[2 * 24 + c + 2] = dz;
    B[3 * 24 + c] = dy; B[3 * 24 + c + 1] = dx;
    B[4 * 24 + c + 1] = dz; B[4 * 24 + c + 2] = dy;
    B[5 * 24 + c] = dz; B[5 * 24 + c + 2] = dx;
  }
  return B;
}

/** E=1、h=1 的元素勁度矩陣（24x24）；實際 Ke = E·h·unitKe */
export function unitKe(nu) {
  const D = dMatrix(1, nu);
  const Ke = new Float64Array(576);
  const g = 1 / Math.sqrt(3);
  const detJ = 1 / 8;
  const DB = new Float64Array(144);
  for (const gx of [-g, g])
    for (const gy of [-g, g])
      for (const gz of [-g, g]) {
        const B = bMatrix(gx, gy, gz, 1);
        DB.fill(0);
        for (let i = 0; i < 6; i++)
          for (let k = 0; k < 6; k++) {
            const d = D[i * 6 + k];
            if (!d) continue;
            for (let j = 0; j < 24; j++) DB[i * 24 + j] += d * B[k * 24 + j];
          }
        for (let a = 0; a < 24; a++)
          for (let b = 0; b < 24; b++) {
            let sum = 0;
            for (let i = 0; i < 6; i++) sum += B[i * 24 + a] * DB[i * 24 + b];
            Ke[a * 24 + b] += sum * detJ;
          }
      }
  return Ke;
}

export function vonMises(s) {
  const [xx, yy, zz, xy, yz, zx] = s;
  return Math.sqrt(
    0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) +
      3 * (xy * xy + yz * yz + zx * zx),
  );
}
