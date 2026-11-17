// 牌桌模型：跑道形台呢、软包扶手、金属压条、木质围裙、底座与地面。全部程序化生成，无外部贴图。
import * as THREE from 'three';
import { random } from '../shared/mp/random.js'; // 连视觉抖动也用密码学安全随机数

export const A = 0.56;        // 直边半长（米）
export const R = 0.5;         // 台呢圆弧半径
export const RAIL = 0.12;     // 软包宽度
export const BOARD_Z = 0.035; // 公共牌所在的 z
export const BOARD_DX = 0.13;
export const BOARD_SCALE = 1.18;
export const FLOOR_Y = -0.76;

/**
 * 跑道形（两段直边 + 两个半圆）上的点。
 * s∈[0,1) 为周长比例，从靠近镜头的底边中点出发，按顺时针（俯视）前进。
 * 返回位置 (x,z) 与朝外的单位法线 (nx,nz)。
 */
export function stadium(s, a = A, r = R) {
  const P = 4 * a + 2 * Math.PI * r;
  let d = (((s % 1) + 1) % 1) * P;
  if (d < a) return { x: -d, z: r, nx: 0, nz: 1 };
  d -= a;
  if (d < Math.PI * r) {
    const t = d / r;
    return { x: -a - Math.sin(t) * r, z: Math.cos(t) * r, nx: -Math.sin(t), nz: Math.cos(t) };
  }
  d -= Math.PI * r;
  if (d < 2 * a) return { x: -a + d, z: -r, nx: 0, nz: -1 };
  d -= 2 * a;
  if (d < Math.PI * r) {
    const t = d / r;
    return { x: a + Math.sin(t) * r, z: -Math.cos(t) * r, nx: Math.sin(t), nz: -Math.cos(t) };
  }
  d -= Math.PI * r;
  return { x: a - d, z: r, nx: 0, nz: 1 };
}

function stadiumShape(a, r) {
  const s = new THREE.Shape();
  s.moveTo(-a, -r);
  s.lineTo(a, -r);
  s.absarc(a, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-a, r);
  s.absarc(-a, 0, r, Math.PI / 2, Math.PI * 1.5, false);
  return s;
}

/** 沿跑道把一条截面轮廓 [[外偏移, 高度], …] 扫掠成环形曲面 */
function sweep(r0, profile, { segs = 240, uRepeat = 1 } = {}) {
  const m = profile.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const b = stadium(i / segs, A, r0);
    for (let j = 0; j < m; j++) {
      const [o, y] = profile[j];
      pos.push(b.x + b.nx * o, y, b.z + b.nz * o);
      uv.push((i / segs) * uRepeat, j / (m - 1));
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < m - 1; j++) {
      const a0 = i * m + j;
      const b0 = (i + 1) * m + j;
      idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  // 首尾接缝处的法线取平均，避免一条可见的缝
  const n = geo.attributes.normal;
  for (let j = 0; j < m; j++) {
    const k = segs * m + j;
    const x = n.getX(j) + n.getX(k);
    const y = n.getY(j) + n.getY(k);
    const z = n.getZ(j) + n.getZ(k);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(j, x / l, y / l, z / l);
    n.setXYZ(k, x / l, y / l, z / l);
  }
  return geo;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function texture(c, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

function spacedText(ctx, text, cx, y, tracking) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0) + tracking * (text.length - 1);
  let x = cx - total / 2;
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x, y);
    x += widths[i] + tracking;
  });
}

function feltTexture() {
  const W = 2048;
  const H = Math.round((W * R) / (A + R));
  const S = W / (2 * (A + R)); // 每米像素
  const [c, ctx] = canvas(W, H);
  const X = (x) => W / 2 + x * S;
  const Z = (z) => H / 2 + z * S;

  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.08, W / 2, H / 2, W * 0.56);
  g.addColorStop(0, '#176b4b');
  g.addColorStop(0.5, '#0f5239');
  g.addColorStop(1, '#073020');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 绒面纤维
  for (let i = 0; i < 140000; i++) {
    const light = random() < 0.5;
    ctx.fillStyle = light ? `rgba(190,255,220,${0.02 + random() * 0.04})` : `rgba(0,20,10,${0.03 + random() * 0.06})`;
    ctx.fillRect(random() * W, random() * H, 1 + random() * 2.5, 1);
  }

  const gold = (a) => `rgba(238,216,160,${a})`;
  const track = (inset) => {
    const r = (R - inset) * S;
    ctx.beginPath();
    ctx.moveTo(X(-A), Z(0) + r);
    ctx.arc(X(-A), Z(0), r, Math.PI / 2, Math.PI * 1.5);
    ctx.lineTo(X(A), Z(0) - r);
    ctx.arc(X(A), Z(0), r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
  };
  // 下注线
  ctx.lineWidth = 3;
  ctx.strokeStyle = gold(0.3);
  track(0.2);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = gold(0.16);
  track(0.212);
  ctx.stroke();

  // 公共牌位
  ctx.lineWidth = 2;
  ctx.strokeStyle = gold(0.17);
  const cw = 0.126 * S;
  const ch = 0.175 * S;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.roundRect(X((i - 2) * BOARD_DX) - cw / 2, Z(BOARD_Z) - ch / 2, cw, ch, 9);
    ctx.stroke();
  }

  ctx.fillStyle = gold(0.24);
  ctx.textBaseline = 'middle';
  ctx.font = '500 34px "Didot", "Bodoni MT", "Playfair Display", Georgia, "Times New Roman", serif';
  spacedText(ctx, 'TEXAS HOLD’EM', W / 2, Z(-0.135), 15);
  ctx.fillStyle = gold(0.16);
  ctx.font = '500 17px "Helvetica Neue", Arial, sans-serif';
  spacedText(ctx, 'NO LIMIT', W / 2, Z(0.168), 12);
  ctx.fillStyle = gold(0.2);
  for (const dir of [-1, 1]) ctx.fillRect(W / 2 + dir * 215 - (dir < 0 ? 70 : 0), Z(-0.135), 70, 1.5);

  return texture(c, { aniso: 16 });
}

function grainTexture(size, draw, repeat) {
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  draw(ctx, size);
  return texture(c, { srgb: false, repeat });
}

function woodTexture() {
  const [c, ctx] = canvas(1024, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#5b3a22');
  g.addColorStop(1, '#3b2414');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 256);
  for (let i = 0; i < 520; i++) {
    const y = random() * 256;
    const amp = 1 + random() * 5;
    const ph = random() * 6.28;
    ctx.strokeStyle = random() < 0.6 ? `rgba(24,13,6,${0.05 + random() * 0.22})` : `rgba(150,104,62,${0.04 + random() * 0.12})`;
    ctx.lineWidth = 0.6 + random() * 2;
    ctx.beginPath();
    for (let x = 0; x <= 1024; x += 32) {
      // 周期取 1024 的整数分之一，保证左右无缝
      const yy = y + Math.sin((x / 1024) * Math.PI * 2 * (1 + (i % 3)) + ph) * amp;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  return texture(c, { repeat: [5, 1] });
}

export function buildTable() {
  const group = new THREE.Group();

  // ── 台呢 ──
  const feltGeo = new THREE.ShapeGeometry(stadiumShape(A, R + 0.004), 48);
  {
    const p = feltGeo.attributes.position;
    const uv = feltGeo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + A + R) / (2 * (A + R)), (p.getY(i) + R) / (2 * R));
  }
  feltGeo.rotateX(-Math.PI / 2);
  const felt = new THREE.Mesh(feltGeo, new THREE.MeshPhysicalMaterial({
    map: feltTexture(),
    roughness: 0.96,
    metalness: 0,
    sheen: 0.3,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0x3fae7c),
    bumpMap: grainTexture(256, (ctx, n) => {
      for (let i = 0; i < 26000; i++) {
        const v = Math.floor(90 + random() * 80);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(random() * n, random() * n, 1 + random() * 2, 1);
      }
    }, [26, 12]),
    bumpScale: 0.35,
  }));
  felt.receiveShadow = true;
  group.add(felt);

  // ── 金色压条 ──
  const trimProfile = [];
  for (let k = 0; k <= 8; k++) {
    const t = (k / 8) * Math.PI;
    trimProfile.push([-0.0065 + 0.0065 * (1 - Math.cos(t)), 0.0005 + 0.0052 * Math.sin(t)]);
  }
  const trim = new THREE.Mesh(sweep(R, trimProfile, { segs: 200 }), new THREE.MeshStandardMaterial({ color: 0xcaa35a, metalness: 1, roughness: 0.3 }));
  trim.receiveShadow = true;
  group.add(trim);

  // ── 软包扶手 ──
  const pad = [[0, -0.004], [0, 0.005]];
  for (let k = 1; k <= 13; k++) {
    const t = (k / 14) * Math.PI;
    pad.push([(RAIL / 2) * (1 - Math.cos(t)), 0.005 + 0.034 * Math.sin(t) ** 0.62]);
  }
  pad.push([RAIL, 0.005], [RAIL + 0.003, -0.008], [RAIL - 0.004, -0.022]);
  const leatherBump = grainTexture(512, (ctx, n) => {
    for (let i = 0; i < 9000; i++) {
      const v = random() < 0.5 ? 40 : 215;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.05 + random() * 0.1})`;
      ctx.beginPath();
      ctx.ellipse(random() * n, random() * n, 1.5 + random() * 5, 1.5 + random() * 4, random() * 3.14, 0, 6.3);
      ctx.fill();
    }
  }, [46, 2]);
  const rail = new THREE.Mesh(sweep(R + 0.004, pad, { segs: 260 }), new THREE.MeshPhysicalMaterial({
    color: 0x1c1512,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.55,
    bumpMap: leatherBump,
    bumpScale: 0.5,
  }));
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);

  // ── 木质围裙 ──
  const wood = new THREE.MeshPhysicalMaterial({ map: woodTexture(), roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.25 });
  const apron = new THREE.Mesh(
    sweep(R + 0.004 + RAIL - 0.01, [[-0.004, -0.012], [0.004, -0.02], [0.004, -0.088], [-0.006, -0.098], [-0.05, -0.1]], { segs: 200 }),
    wood,
  );
  apron.castShadow = true;
  apron.receiveShadow = true;
  group.add(apron);

  // ── 桌体与底座 ──
  const dark = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 0.7 });
  const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(stadiumShape(A, R + RAIL - 0.02), { depth: 0.09, bevelEnabled: false, curveSegments: 32 }), dark);
  slab.geometry.rotateX(Math.PI / 2);
  slab.position.y = -0.006;
  slab.castShadow = true;
  group.add(slab);
  for (const x of [-0.6, 0.6]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 0.62, 28), wood);
    leg.position.set(x, -0.1 - 0.31, 0);
    leg.castShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.045, 36), dark);
    foot.position.set(x, FLOOR_Y + 0.0225, 0);
    foot.castShadow = true;
    foot.receiveShadow = true;
    group.add(leg, foot);
  }

  // ── 地面 ──
  const floorTex = (() => {
    const [c, ctx] = canvas(512, 512);
    ctx.fillStyle = '#2b231d';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 40000; i++) {
      const v = random() < 0.5 ? 0 : 255;
      ctx.fillStyle = `rgba(${v},${v},${v},${random() * 0.05})`;
      ctx.fillRect(random() * 512, random() * 512, 2, 2);
    }
    return texture(c, { repeat: [14, 14] });
  })();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  group.add(floor);

  return group;
}
