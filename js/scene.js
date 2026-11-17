// 3D 场景：渲染器、灯光、镜头、座位布局，以及发牌 / 下注 / 收池 / 摊牌等动画
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { tick, tween, wait, ease, moveObj, isInstant } from './anim.js';
import { buildTable, stadium, RAIL, BOARD_Z, BOARD_DX, BOARD_SCALE } from './table.js';
import { CardSet, CARD_W, CARD_H } from './cards.js';
import { ChipField, ChipPile, flyAmount } from './chips.js';
import { sfx } from './sound.js';

const DECK = { x: 0.5, y: 0.017, z: BOARD_Z };
const POT = { x: -0.5, z: BOARD_Z + 0.03 };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const later = (delay, fn) => tween({ dur: 0.001, delay }).then(fn);
const jitter = (i) => {
  const x = Math.sin(i * 91.7 + 3.1) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

export class TableScene {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x07080a);
    scene.fog = new THREE.Fog(0x07080a, 4.2, 10.5);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.26;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 40);

    // 主光：牌桌正上方的一盏吊灯
    const key = new THREE.SpotLight(0xfff1de, 42, 0, 0.86, 0.8, 2);
    key.position.set(0, 2.5, 0.3);
    key.target.position.set(0, 0, 0.03);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 5;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.003;
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xc6d8ff, 0.55);
    fill.position.set(0.4, 1.4, 2.6);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xfff3e2, 0x17120e, 0.32));

    scene.add(buildTable());

    this.cards = new CardSet(renderer);
    this.cards.warmup();
    this.field = new ChipField(scene);

    // 牌堆
    const deck = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, 0.014, CARD_H), [this.cards.edge, this.cards.edge, this.cards.back, this.cards.edge, this.cards.edge, this.cards.edge]);
    deck.position.set(DECK.x, 0.0072, DECK.z);
    deck.rotation.y = 0.04;
    deck.castShadow = true;
    deck.receiveShadow = true;
    scene.add(deck);
    this.deckMesh = deck;
    // 洗牌动画用的两半牌堆
    const halfGeo = new THREE.BoxGeometry(CARD_W, 0.007, CARD_H);
    this.halves = [0, 1].map(() => {
      const m = new THREE.Mesh(halfGeo, deck.material);
      m.castShadow = true;
      m.visible = false;
      scene.add(m);
      return m;
    });
    this.shuffling = false;
    this.shuffleLoop = null;
    this.cover = false; // 盖牌模式：自己的底牌扣在桌上
    this.peeking = false;
    this.heroPublic = false; // 摊牌后自己的牌已公开，不再盖着

    // 庄家按钮
    const btnCanvas = document.createElement('canvas');
    btnCanvas.width = btnCanvas.height = 256;
    const g = btnCanvas.getContext('2d');
    g.fillStyle = '#f5f2ea';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#c9a45c';
    g.lineWidth = 10;
    g.beginPath();
    g.arc(128, 128, 104, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#1b1b1f';
    g.font = '800 132px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('D', 128, 136);
    const btnTex = new THREE.CanvasTexture(btnCanvas);
    btnTex.colorSpace = THREE.SRGBColorSpace;
    const ivory = new THREE.MeshStandardMaterial({ color: 0xf1eee6, roughness: 0.35 });
    this.button = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.008, 40), [ivory, new THREE.MeshStandardMaterial({ map: btnTex, roughness: 0.35 }), ivory]);
    this.button.castShadow = true;
    this.button.visible = false;
    scene.add(this.button);
    this.buttonAt = null;

    this.pot = new ChipPile(this.field, { origin: V(POT.x, 0, POT.z), tangent: V(1, 0, 0), inward: V(0, 0, -1), perRow: 3, colMax: 10, min: 5, max: 42 });
    this.board = [];
    this.spots = [];
    this.seatCount = 0;
    this.decor = null;

    this.mode = 'home';
    this.orbit = 0.55;
    this.cam = { pos: V(1.4, 1.5, 2.6), look: V(0, 0, 0), shift: 0 };
    this.pointer = { x: 0, y: 0 };
    this.playPose = { y: 1.7, z: 1.86, ly: -0.03, lz: 0.07 };
    this.tmpA = V(0, 0, 0);
    this.tmpB = V(0, 0, 0);
    this.onFrame = null;
    this.potAnchor = V(POT.x, 0.105, POT.z - 0.03);
    this.deckAnchor = V(DECK.x, 0.02, DECK.z + 0.13);
    this.peekAnchor = V(0, 0.02, 0.4);
    this.heroHintAnchor = V(0.045, 0.15, 0.34);

    window.addEventListener('pointermove', (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
    this.setSize(window.innerWidth, window.innerHeight);

    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────────────────────── 渲染循环与镜头 ─────────────────────────────

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 窄屏时把镜头拉远，保证整张牌桌和两端的名牌都在画面内；雾也跟着后移，画面不至于变暗
    const k = Math.max(1, 1.9 / (w / h)) ** 0.96;
    this.playPose = { y: 1.62 * k, z: 1.78 * k, ly: -0.03, lz: 0.07 };
    const extra = Math.hypot(1.62, 1.78) * (k - 1);
    this.scene.fog.near = 4.2 + extra;
    this.scene.fog.far = 10.5 + extra;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    // 帧率很低的设备上也按真实时间推进，动画不会越播越落后
    const dt = Math.min(this.clock.getDelta(), 0.25);
    tick(dt);
    const cam = this.cam;
    const a = this.tmpA;
    const b = this.tmpB;
    let shift = 0;
    if (this.mode === 'home') {
      this.orbit += dt * 0.06;
      a.set(Math.sin(this.orbit) * 2.3, 1.02, Math.cos(this.orbit) * 2.3);
      b.set(0, -0.02, 0);
      shift = this.w > 900 ? 0.13 : 0;
    } else {
      const p = this.playPose;
      a.set(this.pointer.x * 0.05, p.y - this.pointer.y * 0.025, p.z);
      b.set(this.pointer.x * 0.012, p.ly, p.lz);
    }
    const k = 1 - Math.exp(-dt * (this.mode === 'home' ? 1.4 : 2.4));
    cam.pos.lerp(a, k);
    cam.look.lerp(b, k);
    cam.shift += (shift - cam.shift) * k;
    this.camera.position.copy(cam.pos);
    this.camera.lookAt(cam.look);
    if (Math.abs(cam.shift) > 0.0005) this.camera.setViewOffset(this.w, this.h, -cam.shift * this.w, this.h * 0.02 * (cam.shift / 0.13), this.w, this.h);
    else if (this.camera.view) this.camera.clearViewOffset();
    this.field.update();
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** 世界坐标 → 屏幕像素 */
  project(v, out = {}) {
    const p = this.tmpA.copy(v).project(this.camera);
    out.x = (p.x * 0.5 + 0.5) * this.w;
    out.y = (-p.y * 0.5 + 0.5) * this.h;
    return out;
  }

  // ───────────────────────────── 布局 ─────────────────────────────

  setSeatCount(n) {
    if (this.seatCount === n) return;
    this.resetTable();
    this.seatCount = n;
    this.spots = [];
    for (let i = 0; i < n; i++) {
      const b = stadium(i / n);
      const inward = V(-b.nx, 0, -b.nz);
      const tangent = V(b.nz, 0, -b.nx); // 玩家的右手方向
      const at = (inw, tan, y = 0) => V(b.x - b.nx * inw + b.nz * tan, y, b.z - b.nz * inw - b.nx * tan);
      const hero = i === 0;
      const spot = {
        yaw: Math.atan2(b.nx, b.nz),
        cards: at(hero ? 0.085 : 0.115, hero ? 0.045 : 0.05),
        stack: at(0.085, hero ? -0.2 : -0.125),
        bet: at(0.27, hero ? -0.03 : 0),
        button: at(0.165, hero ? 0.215 : 0.185),
        plate: at(-(RAIL + 0.1), 0, 0.04),
        tangent,
        hole: null,
      };
      spot.betLabel = V(spot.bet.x, 0.085, spot.bet.z);
      spot.stackPile = new ChipPile(this.field, { origin: spot.stack, tangent, inward, perRow: 3, colMax: 10, min: 18, max: 48, mix: true });
      spot.betPile = new ChipPile(this.field, { origin: spot.bet, tangent, inward, perRow: 4, colMax: 8, min: 1, max: 20 });
      this.spots.push(spot);
    }
    const c = this.spots[0].cards;
    this.heroHintAnchor.set(c.x, 0.02, c.z + 0.112); // 自己手牌正下方的扶手上
    this.peekAnchor.set(c.x, 0.07, c.z - 0.11); // 盖牌时的「按住看牌」按钮在手牌上方
  }

  heroKind() {
    return this.cover && !this.peeking && !this.heroPublic ? 'heroDown' : 'hero';
  }

  /** 把自己的两张底牌摆到当前应有的姿态（盖着 / 翻开） */
  placeHero(dur = 0.32) {
    const hole = this.spots[0]?.hole;
    if (!hole || !hole.shown) return;
    const kind = this.heroKind();
    hole.cards.forEach((c, k) => moveObj(c.obj, this.holePose(0, k, kind), { dur, arc: kind === 'hero' ? 0.02 : 0.01, ease: ease.inOutCubic }));
  }

  setCover(on) { this.cover = on; this.placeHero(); }
  setPeek(on) { if (this.peeking === on) return; this.peeking = on; this.placeHero(0.18); }
  showHero() { this.heroPublic = true; this.placeHero(); }

  /** 洗牌动画：两半牌堆分开、交错落牌、合拢，循环到 stopShuffle() 为止 */
  startShuffle() {
    if (this.shuffling) return;
    this.shuffling = true;
    const [L, R] = this.halves;
    const loop = async () => {
      this.deckMesh.visible = false;
      [L, R].forEach((m, i) => { m.visible = true; m.position.set(DECK.x, 0.0035 + i * 0.0071, DECK.z); m.rotation.set(0, 0.04, 0); });
      while (this.shuffling) {
        if (isInstant()) { await new Promise((r) => setTimeout(r, 250)); continue; }
        await Promise.all([
          moveObj(L, { x: DECK.x - 0.07, y: 0.0035, z: DECK.z + 0.012, ry: 0.28 }, { dur: 0.3, ease: ease.inOutCubic, arc: 0.012 }),
          moveObj(R, { x: DECK.x + 0.07, y: 0.0035, z: DECK.z + 0.012, ry: -0.28 }, { dur: 0.3, ease: ease.inOutCubic, arc: 0.022 }),
        ]);
        const flicks = [];
        for (let i = 0; i < 8; i++) {
          const from = i % 2 ? R : L;
          const c = this.spawn(null, { x: from.position.x, y: 0.0105, z: from.position.z, ry: from.rotation.y, rz: Math.PI });
          flicks.push(c);
          moveObj(c.obj, { x: DECK.x, y: 0.0012 + i * 0.0011, z: DECK.z, ry: 0.04 }, { dur: 0.2, delay: i * 0.045, arc: 0.025 });
          if (i % 3 === 0) tween({ dur: 0.001, delay: i * 0.045 }).then(() => sfx.card());
        }
        await wait(0.2 + 8 * 0.045);
        await Promise.all([
          moveObj(L, { x: DECK.x, y: 0.0035, z: DECK.z, ry: 0.04 }, { dur: 0.22, ease: ease.inOutCubic }),
          moveObj(R, { x: DECK.x, y: 0.0106, z: DECK.z, ry: 0.04 }, { dur: 0.22, ease: ease.inOutCubic }),
        ]);
        for (const c of flicks) this.drop(c);
        await wait(0.15);
      }
      for (const m of [L, R]) m.visible = false;
      this.deckMesh.visible = true;
    };
    this.shuffleLoop = loop();
  }

  async stopShuffle() {
    this.shuffling = false;
    if (this.shuffleLoop) await this.shuffleLoop;
    this.shuffleLoop = null;
  }

  holePose(vi, k, kind) {
    const s = this.spots[vi];
    const c = s.cards;
    if (kind === 'heroDown') return { x: c.x + (k ? 0.06 : -0.06), y: 0.012 + k * 0.0016, z: c.z + 0.012, rx: 0.12, ry: k ? -0.06 : 0.06, rz: Math.PI, s: 1.18 };
    if (kind === 'hero') return { x: c.x + (k ? 0.067 : -0.067), y: 0.047 + k * 0.001, z: c.z, rx: 0.52, ry: k ? -0.05 : 0.05, rz: 0, s: 1.25 };
    if (kind === 'show') return { x: c.x + (k ? 0.058 : -0.058), y: 0.04 + k * 0.001, z: c.z, rx: 0.42, ry: 0, rz: 0, s: 1.12 };
    const off = k ? 0.027 : -0.027;
    return { x: c.x + s.tangent.x * off, y: 0.0013 + k * 0.0014, z: c.z + s.tangent.z * off, rx: 0, ry: s.yaw + (k ? -0.1 : 0.1), rz: Math.PI, s: 1 };
  }

  boardPose(i) {
    return { x: (i - 2) * BOARD_DX, y: 0.0014, z: BOARD_Z, rx: 0, ry: jitter(i) * 0.05, rz: 0, s: BOARD_SCALE };
  }

  deckPose() {
    return { x: DECK.x, y: DECK.y, z: DECK.z, rx: 0, ry: 0.04, rz: Math.PI, s: 1 };
  }

  spawn(id, pose) {
    const card = this.cards.create(id);
    card.place(pose);
    this.scene.add(card.obj);
    return card;
  }

  drop(card) {
    this.scene.remove(card.obj);
  }

  // ───────────────────────────── 主页装饰 / 进出牌桌 ─────────────────────────────

  enterHome() {
    this.resetTable();
    this.mode = 'home';
    if (this.decor) return;
    const d = (this.decor = { cards: [], piles: [] });
    ['Ts', 'Js', 'Qs', 'Ks', 'As'].forEach((id, i) => {
      d.cards.push(this.spawn(id, { x: (i - 2) * 0.083, y: 0.0015 + i * 0.0013, z: 0.02 + (i - 2) ** 2 * 0.008, ry: -(i - 2) * 0.12 }));
    });
    d.cards.push(this.spawn(null, { x: -0.03, y: 0.0015, z: 0.3, ry: 0.5, rz: Math.PI }));
    d.cards.push(this.spawn(null, { x: 0.03, y: 0.003, z: 0.31, ry: 0.15, rz: Math.PI }));
    for (const [x, z, amount] of [[-0.52, -0.08, 2650], [0.56, 0.2, 1385], [0.2, -0.27, 480], [-0.36, 0.27, 235]]) {
      const pile = new ChipPile(this.field, { origin: V(x, 0, z), tangent: V(1, 0, 0), inward: V(0, 0, -1), perRow: 3, colMax: 10, min: 9, max: 40, mix: true });
      pile.set(amount);
      d.piles.push(pile);
    }
    this.button.position.set(0.3, 0.004, 0.22);
    this.button.visible = true;
  }

  enterTable(seatCount) {
    if (this.decor) {
      for (const c of this.decor.cards) this.drop(c);
      for (const p of this.decor.piles) p.clear();
      this.decor = null;
      this.button.visible = false;
    }
    this.mode = 'play';
    this.setSeatCount(seatCount);
  }

  resetTable() {
    this.heroPublic = false;
    for (const c of this.board) this.drop(c);
    this.board = [];
    for (const s of this.spots) {
      if (s.hole) for (const c of s.hole.cards) this.drop(c);
      s.hole = null;
      s.stackPile.clear();
      s.betPile.clear();
    }
    this.pot.clear();
    this.cards.resetLooks();
    this.button.visible = false;
    this.buttonAt = null;
  }

  // ───────────────────────────── 硬同步（无动画，保证与服务器状态一致） ─────────────────────────────

  /** v: { hero, seats: [null | { chips, bet, hasCards, cards }]（按视角顺序）, board, pot, dealer } */
  sync(v) {
    this.spots.forEach((s, vi) => {
      const p = v.seats[vi];
      s.stackPile.set(p ? p.chips : 0);
      s.betPile.set(p ? p.bet : 0);
      const want = Boolean(p && p.hasCards);
      if (!want && s.hole) {
        for (const c of s.hole.cards) this.drop(c);
        s.hole = null;
      }
      if (want && !s.hole) s.hole = { shown: false, cards: [0, 1].map((k) => this.spawn(null, this.holePose(vi, k, 'down'))) };
      if (want && p.cards && !s.hole.shown) {
        s.hole.shown = true;
        s.hole.cards.forEach((c, k) => {
          c.setFace(p.cards[k]);
          c.place(this.holePose(vi, k, vi === 0 && v.hero ? this.heroKind() : 'show'));
        });
      }
    });
    while (this.board.length > v.board.length) this.drop(this.board.pop());
    v.board.forEach((id, i) => {
      if (!this.board[i]) this.board[i] = this.spawn(id, this.boardPose(i));
      else if (this.board[i].id !== id) this.board[i].setFace(id);
    });
    this.pot.set(v.pot);
    if (v.dealer == null) {
      this.button.visible = false;
      this.buttonAt = null;
    } else if (v.dealer !== this.buttonAt) {
      const b = this.spots[v.dealer].button;
      this.button.position.set(b.x, 0.004, b.z);
      this.button.visible = true;
      this.buttonAt = v.dealer;
    }
  }

  // ───────────────────────────── 动画 ─────────────────────────────

  async moveButton(vi) {
    const b = this.spots[vi].button;
    if (this.buttonAt == null) {
      this.button.position.set(b.x, 0.004, b.z);
      this.button.visible = true;
    } else if (this.buttonAt !== vi) {
      await moveObj(this.button, { x: b.x, y: 0.004, z: b.z }, { dur: 0.55, arc: 0.03, ease: ease.inOutCubic });
    }
    this.buttonAt = vi;
  }

  /** 把上一手留在桌上的牌收回牌堆 */
  async clearTable() {
    this.heroPublic = false;
    const cards = [...this.board, ...this.spots.flatMap((s) => (s.hole ? s.hole.cards : []))];
    this.board = [];
    for (const s of this.spots) s.hole = null;
    if (cards.length) {
      sfx.fold();
      await Promise.all(cards.map((c, i) => moveObj(c.obj, this.deckPose(), { dur: 0.42, delay: i * 0.02, arc: 0.04, ease: ease.inOutCubic })));
      for (const c of cards) this.drop(c);
    }
    this.cards.resetLooks();
  }

  /** order: 发牌顺序（视角下标）；heroCards: 自己的两张牌（观战时为 null） */
  async dealHole(order, heroCards) {
    const flights = [];
    let n = 0;
    for (let k = 0; k < 2; k++) {
      for (const vi of order) {
        const s = this.spots[vi];
        if (!s.hole) s.hole = { shown: false, cards: [] };
        const card = (s.hole.cards[k] = this.spawn(null, this.deckPose()));
        const delay = n++ * 0.085;
        later(delay, () => sfx.card());
        flights.push(moveObj(card.obj, this.holePose(vi, k, 'down'), { dur: 0.36, delay, arc: 0.07 }));
      }
    }
    await Promise.all(flights);
    if (heroCards && this.spots[0].hole) await this.reveal([{ vi: 0, cards: heroCards, hero: true }]);
  }

  /** 翻开某些座位的底牌 */
  async reveal(list) {
    const jobs = [];
    list.forEach(({ vi, cards, hero }, i) => {
      const hole = this.spots[vi]?.hole;
      if (!hole || hole.shown) return;
      hole.shown = true;
      hole.cards.forEach((c, k) => {
        c.setFace(cards[k]);
        const delay = i * 0.16 + k * 0.09;
        later(delay, () => sfx.flip());
        jobs.push(moveObj(c.obj, this.holePose(vi, k, hero ? this.heroKind() : 'show'), { dur: 0.46, delay, arc: 0.035 }));
      });
    });
    await Promise.all(jobs);
    return jobs.length; // 实际翻开了几张（已经亮着的牌不算）
  }

  async fold(vi) {
    const s = this.spots[vi];
    const hole = s.hole;
    if (!hole) return;
    s.hole = null;
    sfx.fold();
    await Promise.all(hole.cards.map((c, k) => moveObj(c.obj, this.deckPose(), { dur: 0.44, delay: k * 0.05, arc: 0.03, ease: ease.inOutCubic })));
    for (const c of hole.cards) this.drop(c);
  }

  async dealBoard(ids) {
    const start = this.board.length;
    const cards = ids.map((id) => {
      const c = this.spawn(id, this.deckPose());
      this.board.push(c);
      return c;
    });
    await Promise.all(cards.map((c, i) => {
      later(i * 0.1, () => sfx.card());
      return moveObj(c.obj, { ...this.boardPose(start + i), rz: Math.PI }, { dur: 0.34, delay: i * 0.1, arc: 0.05 });
    }));
    await wait(0.14);
    await Promise.all(cards.map((c, i) => {
      later(i * 0.14, () => sfx.flip());
      return moveObj(c.obj, this.boardPose(start + i), { dur: 0.42, delay: i * 0.14, arc: 0.06, ease: ease.inOutCubic });
    }));
  }

  /** 某座位的本轮下注变为 total，筹码从他的筹码堆飞到下注区 */
  async bet(vi, total, stackAfter) {
    const s = this.spots[vi];
    const from = s.stackPile.top();
    s.stackPile.set(stackAfter);
    later(0.3, () => sfx.chips(3));
    await s.betPile.addFrom(total, from);
  }

  async refund(vi, amount, betAfter, stackAfter) {
    const s = this.spots[vi];
    s.betPile.set(betAfter);
    later(0.42, () => sfx.chips(2));
    await flyAmount(this.field, amount, { x: s.bet.x, y: 0, z: s.bet.z }, s.stack);
    s.stackPile.set(stackAfter);
  }

  /** 所有下注收进底池 */
  async collect(total) {
    const live = this.spots.filter((s) => s.betPile.amount > 0);
    if (live.length) {
      later(0.36, () => sfx.chips(5));
      await Promise.all(live.map((s) => s.betPile.sendTo({ x: POT.x, y: 0, z: POT.z - 0.03 })));
    }
    this.pot.set(total);
  }

  /** 从底池分出 amount 给某个座位 */
  async award(vi, amount, stackAfter) {
    const s = this.spots[vi];
    this.pot.set(Math.max(0, this.pot.amount - amount));
    later(0.5, () => sfx.chips(6));
    await flyAmount(this.field, amount, { x: POT.x, y: 0, z: POT.z - 0.03 }, s.stack, { max: 22 });
    s.stackPile.set(stackAfter);
  }

  /** 高亮组成牌型的 5 张牌，其余变暗 */
  highlight(best) {
    const shown = [...this.board, ...this.spots.flatMap((s) => (s.hole && s.hole.shown ? s.hole.cards : []))];
    for (const c of shown) {
      if (!c.id) continue;
      const m = c.materials[0];
      const on = best.has(c.id);
      const from = { color: m.color.r, glow: m.emissiveIntensity };
      tween({
        dur: 0.3,
        update: (k) => {
          m.color.setScalar(from.color + ((on ? 1 : 0.4) - from.color) * k);
          m.emissiveIntensity = from.glow + ((on ? 0.2 : 0) - from.glow) * k;
        },
      });
      const bi = this.board.indexOf(c);
      if (bi >= 0) {
        const pose = this.boardPose(bi);
        moveObj(c.obj, on ? { ...pose, y: 0.03, z: pose.z - 0.014 } : pose, { dur: 0.32, ease: on ? ease.outBack : ease.outCubic });
      }
    }
  }
}
