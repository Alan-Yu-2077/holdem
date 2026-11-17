// 筹码：每种面额一个 InstancedMesh（一次绘制调用），逻辑上的每枚筹码只是一个带坐标的普通对象
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tween, ease } from './anim.js';
import { random } from '../shared/mp/random.js'; // 连视觉抖动也用密码学安全随机数

export const CHIP_R = 0.0285;
export const CHIP_H = 0.0056;
const CAPACITY = 420;

export const DENOMS = [
  { v: 1, label: '1', color: '#e9e7e1', accent: '#3d6fb4', ink: '#2a2a2e' },
  { v: 5, label: '5', color: '#bf2630', accent: '#f4f1ea', ink: '#ffffff' },
  { v: 25, label: '25', color: '#1e8a4c', accent: '#f4f1ea', ink: '#ffffff' },
  { v: 100, label: '100', color: '#1d1d22', accent: '#e9e5d8', ink: '#f1e3b8' },
  { v: 500, label: '500', color: '#5b3fa9', accent: '#f4f1ea', ink: '#ffffff' },
  { v: 1000, label: '1K', color: '#dba51f', accent: '#1d1d22', ink: '#1d1d22' },
  { v: 5000, label: '5K', color: '#d9591b', accent: '#f4f1ea', ink: '#ffffff' },
  { v: 25000, label: '25K', color: '#2579b5', accent: '#f4f1ea', ink: '#ffffff' },
  { v: 100000, label: '100K', color: '#8a1f47', accent: '#e8c56a', ink: '#f6dc94' },
];

function chipTexture(d) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S + 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = d.color;
  ctx.fillRect(0, 0, S, S + 128);

  // ── 顶面 ──
  const R = S / 2 - 2;
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.fillStyle = d.accent;
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    ctx.beginPath();
    ctx.arc(0, 0, R + 4, a - 0.2, a + 0.2);
    ctx.arc(0, 0, R * 0.77, a + 0.2, a - 0.2, true);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.75, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = d.accent;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + Math.PI / 24;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * R * 0.68, Math.sin(a) * R * 0.68, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const inner = ctx.createRadialGradient(-30, -40, 10, 0, 0, R * 0.6);
  inner.addColorStop(0, 'rgba(255,255,255,0.2)');
  inner.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = d.accent;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = d.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${d.label.length > 3 ? 92 : d.label.length > 2 ? 112 : 140}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(d.label, 0, 8);
  ctx.restore();

  // ── 侧面（展开成一条带）──
  ctx.fillStyle = d.accent;
  const sw = (S * 0.4) / (Math.PI * 2);
  for (let m = 0; m < 6; m++) ctx.fillRect(((m + 0.5) / 6) * S - sw / 2, S, sw, 128);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, S, S, 14);
  ctx.fillRect(0, S + 114, S, 14);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function chipGeometry() {
  const seg = 36;
  const capV = 128 / 640; // 贴图下方 128px 是侧面，上方 512px 是顶面
  const remapCap = (g) => {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, capV + uv.getY(i) * (1 - capV));
    return g;
  };
  const top = remapCap(new THREE.CircleGeometry(CHIP_R, seg)).rotateX(-Math.PI / 2).translate(0, CHIP_H / 2, 0);
  const bottom = remapCap(new THREE.CircleGeometry(CHIP_R, seg)).rotateX(Math.PI / 2).translate(0, -CHIP_H / 2, 0);
  const side = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, seg, 1, true);
  const uv = side.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * capV);
  return mergeGeometries([top, bottom, side], false);
}

export class ChipField {
  constructor(scene) {
    const geo = chipGeometry();
    this.layers = DENOMS.map((d) => {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: chipTexture(d), roughness: 0.58 }), CAPACITY);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { mesh, n: 0 };
    });
    this.chips = new Set();
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3(1, 1, 1);
    this.up = new THREE.Vector3(0, 1, 0);
  }

  add(chip) { this.chips.add(chip); return chip; }
  remove(chip) { this.chips.delete(chip); }

  update() {
    for (const l of this.layers) l.n = 0;
    for (const c of this.chips) {
      const l = this.layers[c.d];
      if (l.n >= CAPACITY) continue;
      this.q.setFromAxisAngle(this.up, c.ry);
      this.p.set(c.x, c.y, c.z);
      this.m.compose(this.p, this.q, this.s);
      l.mesh.setMatrixAt(l.n++, this.m);
    }
    for (const l of this.layers) {
      l.mesh.count = l.n;
      l.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const greedy = (amount, top) => {
  const out = [];
  for (let i = top; i >= 0; i--) {
    const n = Math.floor(amount / DENOMS[i].v);
    for (let k = 0; k < n; k++) out.push(i);
    amount -= n * DENOMS[i].v;
  }
  return out;
};
const count = (amount, top) => {
  let n = 0;
  for (let i = top; i >= 0; i--) {
    const k = Math.floor(amount / DENOMS[i].v);
    n += k;
    amount -= k * DENOMS[i].v;
  }
  return n;
};

/** 把金额拆成筹码（面额下标，从大到小）。min/max 控制看起来的数量，mix 让一摞里多一种颜色 */
export function breakdown(amount, { min = 1, max = 30, mix = false } = {}) {
  amount = Math.floor(amount);
  if (amount <= 0) return [];
  let top = DENOMS.length - 1;
  while (top > 0 && DENOMS[top].v > amount) top--;
  while (top > 0 && count(amount, top) < min && count(amount, top - 1) <= max) top--;
  if (mix && top > 0) {
    const vt = DENOMS[top].v;
    const nTop = Math.floor(amount / vt);
    const k = Math.min(nTop - 1, Math.ceil((8 * DENOMS[top - 1].v) / vt));
    if (k > 0) {
      const lower = greedy(amount - (nTop - k) * vt, top - 1);
      if (nTop - k + lower.length <= max) return [...Array(nTop - k).fill(top), ...lower];
    }
  }
  let list = greedy(amount, top);
  if (list.length > max) list = list.slice(0, max); // 极端情况下只画大面额
  return list;
}

const hash = (a, b) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function flyChip(chip, to, { dur = 0.36, delay = 0, arc = 0.05 } = {}) {
  let from = null;
  return tween({
    dur, delay, ease: ease.inOutQuad,
    update(k) {
      if (!from) from = { x: chip.x, y: chip.y, z: chip.z };
      chip.x = from.x + (to.x - from.x) * k;
      chip.z = from.z + (to.z - from.z) * k;
      chip.y = from.y + (to.y - from.y) * k + arc * Math.sin(Math.PI * k);
    },
  });
}

/** 桌面上的一堆筹码（某个玩家的筹码、下注，或底池） */
export class ChipPile {
  constructor(field, { origin, tangent, inward, perRow = 3, colMax = 10, min = 1, max = 30, mix = false }) {
    this.field = field;
    this.o = origin;
    this.t = tangent;
    this.n = inward;
    this.perRow = perRow;
    this.colMax = colMax;
    this.opts = { min, max, mix };
    this.amount = 0;
    this.chips = [];
  }

  slots(amount) {
    const list = breakdown(amount, this.opts);
    const cols = [];
    let cur = null;
    for (const d of list) {
      if (!cur || cur.d !== d || cur.n >= this.colMax) cols.push((cur = { d, n: 0 }));
      cur.n++;
    }
    const gap = CHIP_R * 2 + 0.005;
    const out = [];
    cols.forEach((col, ci) => {
      const row = Math.floor(ci / this.perRow);
      const inRow = Math.min(this.perRow, cols.length - row * this.perRow);
      const offT = ((ci % this.perRow) - (inRow - 1) / 2) * gap;
      const offN = row * gap * 0.94;
      const cx = this.o.x + this.t.x * offT + this.n.x * offN;
      const cz = this.o.z + this.t.z * offT + this.n.z * offN;
      for (let lv = 0; lv < col.n; lv++) {
        out.push({
          key: `${ci}:${lv}:${col.d}`,
          d: col.d,
          x: cx + (hash(ci, lv) - 0.5) * 0.0026,
          y: 0.0006 + CHIP_H * (lv + 0.5),
          z: cz + (hash(lv, ci + 7) - 0.5) * 0.0026,
          ry: hash(ci + 3, lv + 11) * Math.PI * 2,
        });
      }
    });
    return out;
  }

  /** 这堆筹码顶部附近的位置（筹码飞出的起点） */
  top() {
    const h = this.chips.length ? Math.max(...this.chips.map((c) => c.y)) : 0;
    return { x: this.o.x, y: h + CHIP_H, z: this.o.z };
  }

  clear() {
    for (const c of this.chips) this.field.remove(c);
    this.chips = [];
    this.amount = 0;
  }

  /** 立即摆成指定金额 */
  set(amount) {
    if (amount === this.amount) return;
    this.clear();
    this.amount = amount;
    this.chips = this.slots(amount).map((s) => this.field.add(s));
  }

  /** 金额变为 amount，新增的筹码从 from 飞入 */
  async addFrom(amount, from, { stagger = 0.028, dur = 0.36 } = {}) {
    const have = new Map(this.chips.map((c) => [c.key, c]));
    const next = [];
    const flights = [];
    for (const s of this.slots(amount)) {
      const kept = have.get(s.key);
      if (kept) {
        have.delete(s.key);
        next.push(kept);
        // 列数变化后整排会重新居中，留下的筹码滑到新位置
        if (Math.abs(kept.x - s.x) + Math.abs(kept.z - s.z) > 0.004) flights.push(flyChip(kept, s, { dur: 0.2, arc: 0 }));
        continue;
      }
      const chip = this.field.add({ ...s, x: from.x + (random() - 0.5) * 0.02, y: from.y, z: from.z + (random() - 0.5) * 0.02 });
      next.push(chip);
      flights.push(flyChip(chip, s, { delay: flights.length * stagger, dur }));
    }
    for (const c of have.values()) this.field.remove(c);
    this.chips = next;
    this.amount = amount;
    await Promise.all(flights);
  }

  /** 整堆飞向 to 并消失 */
  async sendTo(to, { stagger = 0.012, dur = 0.42 } = {}) {
    const chips = this.chips;
    this.chips = [];
    this.amount = 0;
    await Promise.all(chips.map((c, i) => {
      const target = { x: to.x + (random() - 0.5) * 0.05, y: to.y + CHIP_H * 0.5, z: to.z + (random() - 0.5) * 0.05 };
      return flyChip(c, target, { delay: i * stagger, dur, arc: 0.035 }).then(() => this.field.remove(c));
    }));
  }
}

/** 一把临时筹码从 from 飞到 to（退注、分池时用） */
export async function flyAmount(field, amount, from, to, { max = 14 } = {}) {
  const list = breakdown(amount, { min: 3, max });
  await Promise.all(list.map((d, i) => {
    const chip = field.add({
      d,
      x: from.x + (random() - 0.5) * 0.05,
      y: (from.y || 0) + CHIP_H * (0.5 + (i % 5)),
      z: from.z + (random() - 0.5) * 0.05,
      ry: random() * 6.28,
    });
    const target = { x: to.x + (random() - 0.5) * 0.04, y: (to.y || 0) + CHIP_H * 0.5, z: to.z + (random() - 0.5) * 0.04 };
    return flyChip(chip, target, { delay: i * 0.03, dur: 0.5, arc: 0.07 }).then(() => field.remove(chip));
  }));
}
