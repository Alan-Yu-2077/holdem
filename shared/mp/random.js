// 密码学安全随机数：全部来自操作系统 CSPRNG（浏览器 / Node 都是 crypto.getRandomValues），
// 不使用任何可从输出反推内部状态的伪随机算法（如 Math.random 的 xorshift128+、Python random 的梅森旋转）。
import { bytesToBig } from './bytes.js';

const cryptoApi = globalThis.crypto;
if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
  throw new Error('当前环境没有安全随机数源（crypto.getRandomValues）');
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) cryptoApi.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
  return out;
}

// 小块缓冲，减少系统调用；缓冲里的每个字只用一次
const pool = new Uint32Array(256);
let poolPos = pool.length;

export function randomUint32() {
  if (poolPos >= pool.length) {
    cryptoApi.getRandomValues(pool);
    poolPos = 0;
  }
  const v = pool[poolPos];
  pool[poolPos++] = 0;
  return v;
}

/** [0, n) 的均匀整数（拒绝采样，无取模偏差），n ≤ 2^32 */
export function randomInt(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) throw new RangeError('randomInt: bad range');
  const limit = 0x100000000 - (0x100000000 % n);
  let x;
  do x = randomUint32(); while (x >= limit);
  return x % n;
}

/** [0, 1) 的均匀浮点数，53 位精度 —— 可直接替换 Math.random() */
export function random() {
  const hi = randomUint32() >>> 5;
  const lo = randomUint32() >>> 6;
  return (hi * 67108864 + lo) / 9007199254740992;
}

/** [1, max) 的均匀 BigInt（拒绝采样） */
export function randomBelow(max) {
  const bytes = Math.ceil(max.toString(16).length / 2);
  for (;;) {
    const k = bytesToBig(randomBytes(bytes));
    if (k > 0n && k < max) return k;
  }
}

/** 0..n-1 的均匀随机排列（Fisher–Yates） */
export function randomPermutation(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
