// 心理扑克（Mental Poker）协议 —— 浏览器、Web Worker、服务器共用的纯函数。
//
// 思路（SRA 可交换加密的椭圆曲线版本，P-256）：
//   · 52 张牌各对应一个「无人知道离散对数」的曲线点 M_c（哈希到曲线）。
//   · 洗牌阶段 S：参与者依次把整副牌每张乘上自己的秘密标量 a_j，再按自己的秘密排列打乱。
//     并附一个 Chaum–Pedersen 零知识证明：输出之和 = a_j × 输入之和，且 A_j = a_j·G。
//     这让「偷换成自己想要的牌」至少要塞进一张无效牌，一旦被翻开就会被发现。
//   · 上锁阶段 L：参与者依次对第 k 个位置乘上 a_j⁻¹·b_{j,k}，换成「每个位置一把钥匙」，
//     并公布按发牌用途分组的钥匙承诺（哈希）。承诺先于任何钥匙公开，事后无法改口。
//   · 发牌：某个位置需要翻开时，相关参与者公布该位置的 b_{j,k}（逐组校验承诺），
//     乘上 (Π b)⁻¹ 即得到牌面点。底牌位置只有主人不公布自己那把，所以只有主人能看到。
//
// 安全性：任何一方（包括运行服务器的房主）都看不到别人的底牌，也无法把某个位置定向换成指定的牌；
// 牌面隐私基于 P-256 上的 DDH 假设，证明基于随机预言机模型下的 Fiat–Shamir 变换。
import * as ec from './ec.js';
import { hashParts, toB64u, fromB64u, equalBytes, utf8, concat, toHex } from './bytes.js';
import { randomPermutation } from './random.js';
import { makeDeck } from '../poker.js';

export const VERSION = 'holdem-mp/v1';
export const DECK = makeDeck(); // 标准顺序：2s 3s … As 2h … Ac
export const GROUPS = ['hole', 'own', 'flop', 'turn', 'river', 'rest'];
const STRICT_B64 = /^[A-Za-z0-9_-]+$/;

// ───────────────────────────── 牌面点 ─────────────────────────────

let cardPts = null;
let cardByX = null;
let canonical = null;

function initCards() {
  if (cardPts) return;
  cardPts = DECK.map((id) => ec.hashToPoint(`${VERSION}/card/${id}`));
  cardByX = new Map(cardPts.map((pt, i) => [pt.x, i]));
  canonical = { deck: cardPts.map(ec.encodePoint), sum: ec.encodePoint(ec.sum(cardPts)) };
}

export function canonicalDeck() { initCards(); return canonical.deck; }
export function canonicalSum() { initCards(); return canonical.sum; }

/** 点 → 牌（不是牌面点返回 null） */
export function cardOf(pt) {
  initCards();
  if (!pt) return null;
  const i = cardByX.get(pt.x);
  return i != null && ec.equal(cardPts[i], pt) ? DECK[i] : null;
}

// ───────────────────────────── 上下文与位置 ─────────────────────────────

/** 本手牌的上下文：房间、手数、参与者顺序。所有证明和承诺都绑定它，防止跨手 / 跨视图重放 */
export function context(room, handNo, ids) {
  return toB64u(hashParts(VERSION, 'ctx', String(room), String(handNo), ids.join(',')));
}

/**
 * n 位参与者时每个位置的用途：
 *   第 i 位参与者的底牌在位置 i 和 n+i；随后依次是 烧牌、翻牌×3、烧牌、转牌、烧牌、河牌。
 */
export function layout(n) {
  const b = 2 * n;
  return {
    hole: (i) => [i, n + i],
    burn: [b, b + 4, b + 6],
    flop: [b + 1, b + 2, b + 3],
    turn: [b + 5],
    river: [b + 7],
  };
}

/** 第 j 位参与者的钥匙按公开时机分组（6 组正好覆盖 0..51） */
export function groupPositions(n, j, name) {
  const L = layout(n);
  switch (name) {
    case 'hole': {
      const out = [];
      for (let i = 0; i < n; i++) if (i !== j) out.push(...L.hole(i));
      return out.sort((x, y) => x - y);
    }
    case 'own': return L.hole(j);
    case 'flop': return L.flop;
    case 'turn': return L.turn;
    case 'river': return L.river;
    case 'rest': {
      const used = new Set([...Array.from({ length: n }, (_, i) => L.hole(i)).flat(), ...L.flop, ...L.turn, ...L.river]);
      return Array.from({ length: 52 }, (_, k) => k).filter((k) => !used.has(k));
    }
    default: throw new RangeError('unknown group');
  }
}

/** 位置 k 对参与者 j 来说属于哪一组 */
export function groupOf(n, j, k) {
  for (const g of GROUPS) if (groupPositions(n, j, g).includes(k)) return g;
  throw new RangeError('bad position');
}

// ───────────────────────────── 零知识证明（Chaum–Pedersen） ─────────────────────────────

function challenge(ctx, tag, pts) {
  return ec.hashToScalar(hashParts(VERSION, 'dleq', ctx, tag, ...pts.map(ec.pointBytes)));
}

/** 证明 log_g1(h1) = log_g2(h2) = x，g1 必须是 G */
function dleqProve(ctx, tag, x, h1, g2, h2) {
  const k = ec.randomScalar();
  const R1 = ec.mulG(k);
  const R2 = ec.mul(k, g2);
  const e = challenge(ctx, tag, [ec.G, h1, g2, h2, R1, R2]);
  return { e, s: ec.modN(k + e * x) };
}

function dleqVerify(ctx, tag, h1, g2, h2, e, s) {
  const R1 = ec.mul2(s, ec.G, ec.N - e, h1);
  const R2 = ec.mul2(s, g2, ec.N - e, h2);
  if (!R1 || !R2) return false;
  return challenge(ctx, tag, [ec.G, h1, g2, h2, R1, R2]) === e;
}

// ───────────────────────────── 输入校验 ─────────────────────────────

export function isB64(s, len) {
  return typeof s === 'string' && s.length === len && STRICT_B64.test(s);
}

/** 解码一整副牌（52 个点），任何一个无效都抛错 */
export function decodeDeck(list) {
  if (!Array.isArray(list) || list.length !== 52) throw new RangeError('deck must have 52 cards');
  return list.map((s) => ec.decodePoint(s));
}

export function sumOf(list) {
  return ec.encodePoint(ec.sum(decodeDeck(list)));
}

// ───────────────────────────── 洗牌阶段 S ─────────────────────────────

export function newShuffleSecret() {
  return { a: ec.encodeScalar(ec.randomScalar()), perm: randomPermutation(52) };
}

export function isPermutation(perm) {
  if (!Array.isArray(perm) || perm.length !== 52) return false;
  const seen = new Uint8Array(52);
  for (const v of perm) {
    if (!Number.isInteger(v) || v < 0 || v > 51 || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

/** 做一步洗牌：out[k] = a · in[perm[k]]，附带证明 */
export function shuffleStep({ ctx, j, input, a, perm }) {
  if (!isPermutation(perm)) throw new RangeError('bad permutation');
  const x = ec.decodeScalar(a);
  const inPts = decodeDeck(input);
  const outPts = perm.map((k) => ec.mul(x, inPts[k]));
  const sumIn = ec.sum(inPts);
  const sumOut = ec.sum(outPts);
  const A = ec.mulG(x);
  const { e, s } = dleqProve(ctx, `S${j}`, x, A, sumIn, sumOut);
  return {
    out: outPts.map(ec.encodePoint),
    A: ec.encodePoint(A),
    sumIn: ec.encodePoint(sumIn),
    sumOut: ec.encodePoint(sumOut),
    e: ec.encodeScalar(e),
    s: ec.encodeScalar(s),
  };
}

/** 校验一步洗牌的公开部分（不需要整副牌） */
export function verifyShuffle({ ctx, j, sumIn, step }) {
  try {
    if (step.sumIn !== sumIn) return false;
    const A = ec.decodePoint(step.A);
    const g2 = ec.decodePoint(sumIn);
    const h2 = ec.decodePoint(step.sumOut);
    return dleqVerify(ctx, `S${j}`, A, g2, h2, ec.decodeScalar(step.e), ec.decodeScalar(step.s));
  } catch {
    return false;
  }
}

// ───────────────────────────── 上锁阶段 L ─────────────────────────────

export function newLockKeys() {
  return Array.from({ length: 52 }, () => ec.encodeScalar(ec.randomScalar()));
}

/** out[k] = a⁻¹·b_k · in[k] */
export function lockStep({ input, a, b }) {
  const ainv = ec.invMod(ec.decodeScalar(a), ec.N);
  const inPts = decodeDeck(input);
  if (!Array.isArray(b) || b.length !== 52) throw new RangeError('need 52 keys');
  return { out: inPts.map((pt, k) => ec.encodePoint(ec.mul(ec.modN(ainv * ec.decodeScalar(b[k])), pt))) };
}

/** 某一组钥匙的承诺：H(上下文, 参与者序号, 组名, 位置, 钥匙…) 取前 16 字节 */
export function commitGroup(ctx, j, name, positions, keys) {
  const bytes = keys.map((k) => fromB64u(k, 32));
  return toB64u(hashParts(VERSION, 'commit', ctx, String(j), name, positions.join(','), concat(...bytes)).subarray(0, 16));
}

export function commitAll(ctx, n, j, b) {
  const out = {};
  for (const g of GROUPS) {
    const pos = groupPositions(n, j, g);
    out[g] = commitGroup(ctx, j, g, pos, pos.map((k) => b[k]));
  }
  return out;
}

export function isCommitSet(c) {
  return c && typeof c === 'object' && GROUPS.every((g) => isB64(c[g], 22));
}

/** 校验公布的一组钥匙与承诺一致，且每把钥匙都是合法标量 */
export function verifyGroup(ctx, n, j, name, keys, commit) {
  try {
    const pos = groupPositions(n, j, name);
    if (!Array.isArray(keys) || keys.length !== pos.length) return false;
    for (const k of keys) ec.decodeScalar(k);
    const got = fromB64u(commitGroup(ctx, j, name, pos, keys), 16);
    return equalBytes(got, fromB64u(commit, 16));
  } catch {
    return false;
  }
}

// ───────────────────────────── 开牌 ─────────────────────────────

/** 用各参与者在该位置的钥匙打开一张牌；打不开（不是有效牌面）返回 null */
export function openCard({ point, keys }) {
  let prod = 1n;
  for (const k of keys) prod = ec.modN(prod * ec.decodeScalar(k));
  const M = ec.mul(ec.invMod(prod, ec.N), ec.decodePoint(point));
  return cardOf(M);
}

// ───────────────────────────── 事后审计（只在本手作废时使用） ─────────────────────────────

/**
 * 给定每位参与者公开的全部秘密，重算整条链，找出第一个不按协议计算的人。
 * decksS[j] / decksL[j] 是服务器转发过的第 j 步输出。返回 { culprit: j | null, detail }
 */
export function audit({ ctx, n, decksS, decksL, commits, secrets }) {
  let prev = canonicalDeck();
  for (let j = 0; j < n; j++) {
    const sec = secrets[j];
    if (!sec || !isPermutation(sec.perm)) return { culprit: j, detail: 'no-secret' };
    let exp;
    try { exp = shuffleStep({ ctx, j, input: prev, a: sec.a, perm: sec.perm }).out; } catch { return { culprit: j, detail: 'bad-secret' }; }
    if (exp.some((s, k) => s !== decksS[j][k])) return { culprit: j, detail: 'shuffle' };
    prev = decksS[j];
  }
  for (let j = 0; j < n; j++) {
    const sec = secrets[j];
    if (!Array.isArray(sec.b) || sec.b.length !== 52) return { culprit: j, detail: 'no-keys' };
    for (const g of GROUPS) {
      const pos = groupPositions(n, j, g);
      if (!verifyGroup(ctx, n, j, g, pos.map((k) => sec.b[k]), commits[j][g])) return { culprit: j, detail: 'commit' };
    }
    let exp;
    try { exp = lockStep({ input: prev, a: sec.a, b: sec.b }).out; } catch { return { culprit: j, detail: 'bad-secret' }; }
    if (exp.some((s, k) => s !== decksL[j][k])) return { culprit: j, detail: 'lock' };
    prev = decksL[j];
  }
  return { culprit: null, detail: 'consistent' };
}

export const shortHash = (s) => toHex(hashParts(VERSION, 'short', s).subarray(0, 4));
export { utf8 };
