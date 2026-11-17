// NIST P-256 椭圆曲线运算（纯 JS BigInt 实现，浏览器 / Web Worker / Node 通用）。
// 群的阶 n 为素数、余因子为 1，所以任何曲线上的非无穷远点都在同一个素数阶群里，
// 适合做「可交换加密」：k1·(k2·P) = k2·(k1·P)。
//
// 注意：BigInt 运算不是常数时间的。这里的秘密标量只在玩家自己的浏览器里使用，
// 攻击者只能经由网络观察（噪声远大于计时差），作为桌游场景可以接受。
import { bigToBytes, bytesToBig, toB64u, fromB64u, sha256, concat, utf8 } from './bytes.js';
import { randomBelow } from './random.js';

export const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const G = Object.freeze({
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
});

const md = (a) => { const r = a % P; return r < 0n ? r + P : r; };

export function modN(a) { const r = a % N; return r < 0n ? r + N : r; }

export function invMod(a, m) {
  let r0 = a % m;
  if (r0 < 0n) r0 += m;
  if (r0 === 0n) throw new RangeError('not invertible');
  let r1 = m;
  let s0 = 1n;
  let s1 = 0n;
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new RangeError('not invertible');
  return s0 < 0n ? s0 + m : s0;
}

function powMod(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

export const randomScalar = () => randomBelow(N);

// ───────────────────────────── 雅可比坐标 ─────────────────────────────
// 点用 [X, Y, Z] 表示（x = X/Z², y = Y/Z³），无穷远点用 null。

function jDouble(p) {
  if (!p) return null;
  const [X1, Y1, Z1] = p;
  if (Y1 === 0n) return null;
  const delta = md(Z1 * Z1);
  const gamma = md(Y1 * Y1);
  const beta = md(X1 * gamma);
  const alpha = md(3n * md(X1 - delta) * (X1 + delta));
  const X3 = md(alpha * alpha - 8n * beta);
  const Z3 = md((Y1 + Z1) * (Y1 + Z1) - gamma - delta);
  const Y3 = md(alpha * (4n * beta - X3) - 8n * md(gamma * gamma));
  return [X3, Y3, Z3];
}

function jAdd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [X1, Y1, Z1] = p;
  const [X2, Y2, Z2] = q;
  const Z1Z1 = md(Z1 * Z1);
  const Z2Z2 = md(Z2 * Z2);
  const U1 = md(X1 * Z2Z2);
  const U2 = md(X2 * Z1Z1);
  const S1 = md(Y1 * Z2 * Z2Z2);
  const S2 = md(Y2 * Z1 * Z1Z1);
  const H = md(U2 - U1);
  const r = md(2n * (S2 - S1));
  if (H === 0n) return r === 0n ? jDouble(p) : null;
  const I = md(4n * H * H);
  const J = md(H * I);
  const V = md(U1 * I);
  const X3 = md(r * r - J - 2n * V);
  const Y3 = md(r * (V - X3) - 2n * S1 * J);
  const Z3 = md(((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
}

/** 雅可比点 + 仿射点 */
function jAddAffine(p, q) {
  if (!q) return p;
  if (!p) return [q.x, q.y, 1n];
  const [X1, Y1, Z1] = p;
  const Z1Z1 = md(Z1 * Z1);
  const U2 = md(q.x * Z1Z1);
  const S2 = md(q.y * Z1 * Z1Z1);
  const H = md(U2 - X1);
  const r = md(2n * (S2 - Y1));
  if (H === 0n) return r === 0n ? jDouble(p) : null;
  const HH = md(H * H);
  const I = md(4n * HH);
  const J = md(H * I);
  const V = md(X1 * I);
  const X3 = md(r * r - J - 2n * V);
  const Y3 = md(r * (V - X3) - 2n * Y1 * J);
  const Z3 = md((Z1 + H) * (Z1 + H) - Z1Z1 - HH);
  return [X3, Y3, Z3];
}

function toAffine(p) {
  if (!p) return null;
  const zi = invMod(p[2], P);
  const zi2 = md(zi * zi);
  return { x: md(p[0] * zi2), y: md(p[1] * zi2 * zi) };
}

/** 批量转仿射（Montgomery 技巧：只做一次求逆） */
function toAffineBatch(ps) {
  const n = ps.length;
  const acc = new Array(n);
  let run = 1n;
  for (let i = 0; i < n; i++) {
    acc[i] = run;
    if (ps[i]) run = md(run * ps[i][2]);
  }
  let inv = invMod(run, P);
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const p = ps[i];
    if (!p) { out[i] = null; continue; }
    const zi = md(inv * acc[i]);
    inv = md(inv * p[2]);
    const zi2 = md(zi * zi);
    out[i] = { x: md(p[0] * zi2), y: md(p[1] * zi2 * zi) };
  }
  return out;
}

export function isOnCurve(pt) {
  if (!pt || pt.x < 0n || pt.x >= P || pt.y < 0n || pt.y >= P) return false;
  return md(pt.y * pt.y) === md(pt.x * pt.x * pt.x - 3n * pt.x + B);
}

export const equal = (a, b) => (a === b) || (Boolean(a) && Boolean(b) && a.x === b.x && a.y === b.y);
export const neg = (pt) => (pt ? { x: pt.x, y: md(-pt.y) } : null);

export function add(a, b) {
  return toAffine(jAddAffine(a ? [a.x, a.y, 1n] : null, b));
}

/** 一组点求和 */
export function sum(pts) {
  let acc = null;
  for (const p of pts) acc = jAddAffine(acc, p);
  return toAffine(acc);
}

// ───────────────────────────── 标量乘 ─────────────────────────────

function windowTable(pt) {
  const t = new Array(16);
  t[0] = null;
  t[1] = [pt.x, pt.y, 1n];
  t[2] = jDouble(t[1]);
  for (let i = 3; i < 16; i++) t[i] = jAddAffine(t[i - 1], pt);
  return toAffineBatch(t);
}

const nib = (k, i) => Number((k >> BigInt(i * 4)) & 15n);

/** k·pt（4 位固定窗口） */
export function mul(k, pt) {
  k = modN(k);
  if (k === 0n || !pt) return null;
  const t = windowTable(pt);
  let r = null;
  for (let i = 63; i >= 0; i--) {
    if (r) r = jDouble(jDouble(jDouble(jDouble(r))));
    const w = nib(k, i);
    if (w) r = jAddAffine(r, t[w]);
  }
  return toAffine(r);
}

/** k1·p1 + k2·p2（Shamir 技巧，共享倍点） */
export function mul2(k1, p1, k2, p2) {
  k1 = modN(k1);
  k2 = modN(k2);
  const t1 = k1 && p1 ? windowTable(p1) : null;
  const t2 = k2 && p2 ? windowTable(p2) : null;
  let r = null;
  for (let i = 63; i >= 0; i--) {
    if (r) r = jDouble(jDouble(jDouble(jDouble(r))));
    if (t1) { const w = nib(k1, i); if (w) r = jAddAffine(r, t1[w]); }
    if (t2) { const w = nib(k2, i); if (w) r = jAddAffine(r, t2[w]); }
  }
  return toAffine(r);
}

// 基点 G 的固定基预计算表：GT[i][j] = j·16^i·G
let GT = null;
function gTable() {
  if (GT) return GT;
  const rows = [];
  let base = [G.x, G.y, 1n];
  for (let i = 0; i < 64; i++) {
    const row = new Array(16);
    row[0] = null;
    row[1] = base;
    for (let j = 2; j < 16; j++) row[j] = jAdd(row[j - 1], base);
    rows.push(row);
    base = jDouble(jDouble(jDouble(jDouble(base))));
  }
  const flat = toAffineBatch(rows.flat());
  GT = rows.map((_, i) => flat.slice(i * 16, i * 16 + 16));
  return GT;
}

export function mulG(k) {
  k = modN(k);
  if (k === 0n) return null;
  const t = gTable();
  let r = null;
  for (let i = 0; i < 64; i++) {
    const w = nib(k, i);
    if (w) r = jAddAffine(r, t[i][w]);
  }
  return toAffine(r);
}

// ───────────────────────────── 编码 ─────────────────────────────

function sqrtModP(a) {
  // P ≡ 3 (mod 4)
  const r = powMod(a, (P + 1n) / 4n, P);
  return md(r * r) === md(a) ? r : null;
}

/** 由 x 坐标求点（y 取偶），x 不在曲线上返回 null */
export function liftX(x) {
  if (x < 0n || x >= P) return null;
  const y = sqrtModP(md(x * x * x - 3n * x + B));
  if (y == null) return null;
  return { x, y: y & 1n ? P - y : y };
}

/** 压缩点编码（33 字节）→ base64url 44 字符 */
export function encodePoint(pt) {
  if (!pt) throw new RangeError('cannot encode infinity');
  const out = new Uint8Array(33);
  out[0] = pt.y & 1n ? 3 : 2;
  out.set(bigToBytes(pt.x, 32), 1);
  return toB64u(out);
}

/** 解码并校验：必须是曲线上的有效点，否则抛错（防无效曲线攻击） */
export function decodePoint(s) {
  const b = fromB64u(s, 33);
  if (b[0] !== 2 && b[0] !== 3) throw new RangeError('bad point prefix');
  const x = bytesToBig(b.subarray(1));
  const pt = liftX(x);
  if (!pt) throw new RangeError('point not on curve');
  const odd = b[0] === 3;
  return (pt.y & 1n) === (odd ? 1n : 0n) ? pt : { x: pt.x, y: P - pt.y };
}

export const encodeScalar = (k) => toB64u(bigToBytes(k, 32));

/** 解码标量并校验范围 [1, n-1] */
export function decodeScalar(s) {
  const k = bytesToBig(fromB64u(s, 32));
  if (k <= 0n || k >= N) throw new RangeError('scalar out of range');
  return k;
}

/** 「无人知道离散对数」的点：try-and-increment 哈希到曲线 */
export function hashToPoint(label) {
  for (let ctr = 0; ctr < 1000; ctr++) {
    const x = bytesToBig(sha256(concat(utf8(label), utf8(`#${ctr}`))));
    const pt = liftX(x);
    if (pt) return pt;
  }
  throw new Error('hashToPoint failed');
}

/** 把哈希值映射成标量（512 位再取模，偏差可忽略） */
export function hashToScalar(bytes) {
  const wide = concat(sha256(concat(bytes, Uint8Array.of(0))), sha256(concat(bytes, Uint8Array.of(1))));
  return modN(bytesToBig(wide));
}

export const pointBytes = (pt) => fromB64u(encodePoint(pt), 33);
