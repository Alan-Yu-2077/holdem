// 扑克牌：牌面/牌背用 Canvas 绘制成贴图，几何体是带圆角的薄片（正面、背面、侧边三组材质）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const CARD_W = 0.1;
export const CARD_H = 0.14;
export const CARD_T = 0.0012;

const TW = 360;
const TH = 504;
const RED = '#c5132f';
const BLACK = '#18181c';

/** 以 (0,0) 为中心、宽约 s 的花色图形 */
export function suitPath(ctx, suit, s) {
  ctx.beginPath();
  if (suit === 'h') {
    ctx.moveTo(0, 0.46 * s);
    ctx.bezierCurveTo(-0.56 * s, 0.06 * s, -0.52 * s, -0.46 * s, -0.25 * s, -0.46 * s);
    ctx.bezierCurveTo(-0.08 * s, -0.46 * s, 0, -0.34 * s, 0, -0.22 * s);
    ctx.bezierCurveTo(0, -0.34 * s, 0.08 * s, -0.46 * s, 0.25 * s, -0.46 * s);
    ctx.bezierCurveTo(0.52 * s, -0.46 * s, 0.56 * s, 0.06 * s, 0, 0.46 * s);
  } else if (suit === 'd') {
    ctx.moveTo(0, -0.5 * s);
    ctx.quadraticCurveTo(0.15 * s, -0.2 * s, 0.38 * s, 0);
    ctx.quadraticCurveTo(0.15 * s, 0.2 * s, 0, 0.5 * s);
    ctx.quadraticCurveTo(-0.15 * s, 0.2 * s, -0.38 * s, 0);
    ctx.quadraticCurveTo(-0.15 * s, -0.2 * s, 0, -0.5 * s);
  } else if (suit === 's') {
    ctx.moveTo(0, -0.5 * s);
    ctx.bezierCurveTo(0.08 * s, -0.32 * s, 0.48 * s, -0.1 * s, 0.48 * s, 0.14 * s);
    ctx.bezierCurveTo(0.48 * s, 0.36 * s, 0.2 * s, 0.42 * s, 0.05 * s, 0.24 * s);
    ctx.quadraticCurveTo(0.07 * s, 0.4 * s, 0.18 * s, 0.5 * s);
    ctx.lineTo(-0.18 * s, 0.5 * s);
    ctx.quadraticCurveTo(-0.07 * s, 0.4 * s, -0.05 * s, 0.24 * s);
    ctx.bezierCurveTo(-0.2 * s, 0.42 * s, -0.48 * s, 0.36 * s, -0.48 * s, 0.14 * s);
    ctx.bezierCurveTo(-0.48 * s, -0.1 * s, -0.08 * s, -0.32 * s, 0, -0.5 * s);
  } else {
    const r = 0.205 * s;
    ctx.arc(0, -0.26 * s, r, 0, Math.PI * 2);
    ctx.moveTo(-0.24 * s + r, 0.07 * s);
    ctx.arc(-0.24 * s, 0.07 * s, r, 0, Math.PI * 2);
    ctx.moveTo(0.24 * s + r, 0.07 * s);
    ctx.arc(0.24 * s, 0.07 * s, r, 0, Math.PI * 2);
    ctx.moveTo(0.1 * s, 0);
    ctx.arc(0, 0, 0.1 * s, 0, Math.PI * 2);
    ctx.moveTo(-0.035 * s, 0.05 * s);
    ctx.quadraticCurveTo(-0.05 * s, 0.38 * s, -0.18 * s, 0.5 * s);
    ctx.lineTo(0.18 * s, 0.5 * s);
    ctx.quadraticCurveTo(0.05 * s, 0.38 * s, 0.035 * s, 0.05 * s);
    ctx.closePath();
  }
}

function drawSuit(ctx, suit, x, y, size, flip = false) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.rotate(Math.PI);
  suitPath(ctx, suit, size);
  ctx.fill();
  ctx.restore();
}

// 数字牌的点阵位置：[列(0左 1中 2右), 行高(0~1)]
const PIPS = {
  2: [[1, 0], [1, 1]],
  3: [[1, 0], [1, 0.5], [1, 1]],
  4: [[0, 0], [2, 0], [0, 1], [2, 1]],
  5: [[0, 0], [2, 0], [1, 0.5], [0, 1], [2, 1]],
  6: [[0, 0], [2, 0], [0, 0.5], [2, 0.5], [0, 1], [2, 1]],
  7: [[0, 0], [2, 0], [1, 0.25], [0, 0.5], [2, 0.5], [0, 1], [2, 1]],
  8: [[0, 0], [2, 0], [1, 0.25], [0, 0.5], [2, 0.5], [1, 0.75], [0, 1], [2, 1]],
  9: [[0, 0], [2, 0], [0, 1 / 3], [2, 1 / 3], [1, 0.5], [0, 2 / 3], [2, 2 / 3], [0, 1], [2, 1]],
  10: [[0, 0], [2, 0], [1, 1 / 6], [0, 1 / 3], [2, 1 / 3], [0, 2 / 3], [2, 2 / 3], [1, 5 / 6], [0, 1], [2, 1]],
};

function drawFace(id) {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d');
  const rank = id[0] === 'T' ? '10' : id[0];
  const suit = id[1];
  const color = suit === 'h' || suit === 'd' ? RED : BLACK;

  const bg = ctx.createLinearGradient(0, 0, TW, TH);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(1, '#f3f1ea');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, TW, TH);
  ctx.fillStyle = color;

  // 角标（左上 + 旋转 180° 的右下），做得偏大，远处也能看清
  const index = () => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 86px "Helvetica Neue", "Arial Narrow", Arial, sans-serif';
    ctx.save();
    ctx.translate(50, 66);
    if (rank === '10') ctx.scale(0.78, 1);
    ctx.fillText(rank, 0, 0);
    ctx.restore();
    drawSuit(ctx, suit, 50, 142, 50);
  };
  index();
  ctx.save();
  ctx.translate(TW, TH);
  ctx.rotate(Math.PI);
  index();
  ctx.restore();

  const cols = [TW * 0.345, TW * 0.5, TW * 0.655];
  const top = TH * 0.2;
  const bottom = TH * 0.8;
  if (rank === 'A') {
    drawSuit(ctx, suit, TW / 2, TH / 2, 170);
  } else if (PIPS[rank]) {
    for (const [col, row] of PIPS[rank]) drawSuit(ctx, suit, cols[col], top + (bottom - top) * row, 62, row > 0.5);
  } else {
    // J / Q / K：双线边框 + 衬线大字，上下各一枚花色
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillRect(98, 78, TW - 196, TH - 156);
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(98, 78, TW - 196, TH - 156);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(106, 86, TW - 212, TH - 172);
    ctx.font = '700 150px "Didot", "Bodoni MT", Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rank, TW / 2, TH / 2 + 6);
    drawSuit(ctx, suit, TW / 2, 132, 50);
    drawSuit(ctx, suit, TW / 2, TH - 132, 50, true);
  }
  return c;
}

function drawBack() {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f5ef';
  ctx.fillRect(0, 0, TW, TH);
  const m = 20;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(m, m, TW - 2 * m, TH - 2 * m, 16);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, TW, TH);
  g.addColorStop(0, '#9c2233');
  g.addColorStop(1, '#6a111f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TW, TH);
  ctx.strokeStyle = 'rgba(255,235,220,0.16)';
  ctx.lineWidth = 1.6;
  for (let i = -TH; i < TW + TH; i += 20) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + TH, TH);
    ctx.moveTo(i + TH, 0);
    ctx.lineTo(i, TH);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,240,225,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(m + 9, m + 9, TW - 2 * m - 18, TH - 2 * m - 18, 10);
  ctx.stroke();
  ctx.fillStyle = '#7a1524';
  ctx.beginPath();
  ctx.arc(TW / 2, TH / 2, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,240,225,0.85)';
  drawSuit(ctx, 's', TW / 2, TH / 2 - 2, 56);
  return c;
}

function cardGeometry() {
  const w = CARD_W;
  const h = CARD_H;
  const r = 0.0075;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0);
  shape.lineTo(w / 2, h / 2 - r);
  shape.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5);

  const front = new THREE.ShapeGeometry(shape, 5);
  const p = front.attributes.position;
  const uv = front.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  const back = front.clone();
  front.rotateX(-Math.PI / 2).translate(0, CARD_T / 2, 0); // 牌面朝 +Y，牌顶朝 -Z
  back.rotateX(Math.PI / 2).translate(0, -CARD_T / 2, 0);

  // 侧边
  const pts = shape.getPoints(5);
  const pos = [];
  const nor = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) continue;
    const nx = dy / len;
    const nz = dx / len;
    const base = pos.length / 3;
    pos.push(a.x, CARD_T / 2, -a.y, b.x, CARD_T / 2, -b.y, b.x, -CARD_T / 2, -b.y, a.x, -CARD_T / 2, -a.y);
    for (let k = 0; k < 4; k++) { nor.push(nx, 0, nz); uvs.push(0.5, 0.5); }
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const edge = new THREE.BufferGeometry();
  edge.setIndex(idx);
  edge.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  edge.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  edge.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  return mergeGeometries([front, back, edge], true);
}

export class Card {
  constructor(set, id = null) {
    this.set = set;
    this.id = null;
    this.materials = [set.blank, set.back, set.edge];
    this.mesh = new THREE.Mesh(set.geometry, this.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.obj = new THREE.Group();
    this.obj.rotation.order = 'YXZ'; // 先绕自身长轴翻面(Z)，再俯仰(X)，最后朝向(Y)
    this.obj.add(this.mesh);
    this.setFace(id);
  }

  setFace(id) {
    this.id = id || null;
    this.materials[0] = id ? this.set.face(id) : this.set.blank;
  }

  place(pose) {
    this.obj.position.set(pose.x, pose.y, pose.z);
    this.obj.rotation.set(pose.rx || 0, pose.ry || 0, pose.rz || 0);
    this.obj.scale.setScalar(pose.s || 1);
  }
}

export class CardSet {
  constructor(renderer) {
    this.renderer = renderer;
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.geometry = cardGeometry();
    this.faces = new Map();
    this.backTexture = this.tex(drawBack());
    this.back = new THREE.MeshStandardMaterial({ map: this.backTexture, roughness: 0.42 });
    this.edge = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 });
    this.blank = new THREE.MeshStandardMaterial({ color: 0xf7f5ef, roughness: 0.5 });
  }

  tex(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.aniso;
    return t;
  }

  face(id) {
    let m = this.faces.get(id);
    if (!m) {
      const map = this.tex(drawFace(id));
      m = new THREE.MeshStandardMaterial({ map, roughness: 0.4, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0 });
      this.faces.set(id, m);
    }
    return m;
  }

  /** 预先画好并上传 52 张牌面，避免第一次发牌时卡顿 */
  warmup() {
    for (const s of 'shdc') for (const r of '23456789TJQKA') this.renderer.initTexture(this.face(r + s).map);
  }

  resetLooks() {
    for (const m of this.faces.values()) {
      m.color.setScalar(1);
      m.emissiveIntensity = 0;
    }
  }

  create(id = null) {
    return new Card(this, id);
  }
}
