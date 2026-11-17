// 心理扑克的浏览器端：替自己完成洗牌 / 上锁 / 交钥匙，并独立核验其他人和服务器。
//
// 这里是防作弊的最后一道关：服务器（房主）不可信，所以
//   · 每一步洗牌的零知识证明、每一组钥匙的承诺都在本地重新校验；
//   · 只有规则允许时才交出钥匙（例如：自己没在这一轮行动过，就不交下一条街的钥匙；
//     公共牌没全部翻开前，绝不交出自己底牌的钥匙）；
//   · 公共牌、摊牌、结算都用本地解出的牌复核服务器的公告。
import * as mp from '../shared/mp/protocol.js';
import { settle } from '../shared/poker.js';

const PREV = { flop: 'preflop', turn: 'flop', river: 'turn' };
const STORE = 'poker.mp';

class Rpc {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./mp-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      if (data.ok) job.resolve(data.result);
      else job.reject(new Error(data.error));
    };
  }

  call(fn, args) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, fn, args });
    });
  }
}

export class MentalClient {
  constructor({ send, warn, changed }) {
    this.send = send;
    this.warn = warn;
    this.changed = changed || (() => {});
    this.rpc = new Rpc();
    this.hands = new Map();
    this.room = null;
    this.myId = null;
    this.state = null;
    this.acted = new Map(); // 手数 → 本手我行动过的街
    this.deadline = new Map(); // `手数:街` → 我这次行动的截止时间（判断服务器替我超时行动是否合理）
    this.stacks = new Map(); // 手数 → 开局时参与者筹码总和（复核筹码守恒）
  }

  setIdentity(room, id) {
    if (this.room !== room) this.hands.clear();
    this.room = room;
    this.myId = id;
  }

  reset() {
    this.hands.clear();
    this.acted.clear();
    this.stacks.clear();
    this.state = null;
  }

  // ───────────────────────────── 本地保存的秘密（刷新页面也能接着打） ─────────────────────────────

  storeKey(no) { return `${STORE}.${this.room}.${no}.${this.myId}`; }

  loadSecret(no) {
    try { return JSON.parse(sessionStorage.getItem(this.storeKey(no))); } catch { return null; }
  }

  saveSecret(H) {
    try {
      sessionStorage.setItem(this.storeKey(H.no), JSON.stringify(H.sec));
      // 只保留最近几手
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        const m = k && k.startsWith(`${STORE}.`) && k.split('.');
        if (m && Number(m[m.length - 2]) < H.no - 3) sessionStorage.removeItem(k);
      }
    } catch { /* 存储不可用时只在内存里 */ }
  }

  // ───────────────────────────── 观察牌局 ─────────────────────────────

  /** 每收到一条牌桌状态都调用（在动画排队之前），用于判断何时可以交钥匙 */
  observe(state, ev) {
    this.state = state;
    const h = state && state.hand;
    if (!h) return;
    const H = this.hands.get(h.no);
    if (ev) {
      this.check(ev, state, H);
      this.trackTurns(ev, state, H);
    }
    if (H) this.retry(H);
  }

  /**
   * 牌桌在我思考时间用完后会替我过牌 / 弃牌，这也算我在这条街行动过。
   * 但如果截止时间还没到牌桌就宣称我行动了，不算——防止房主借此提前骗走下一条街的钥匙。
   */
  trackTurns(ev, state, H) {
    const h = state.hand;
    const mine = state.you && ev.seat === state.you.seat;
    if (!mine) return;
    const key = `${h.no}:${h.street}`;
    if (ev.type === 'turn') this.deadline.set(key, h.timeLeft == null ? Infinity : performance.now() + h.timeLeft);
    if (ev.type === 'action' && !this.hasActed(h.no, h.street)) {
      const due = this.deadline.get(key);
      if (due != null && performance.now() >= due - 2500) this.markActed(h.no, h.street, H);
    }
  }

  hasActed(no, street) {
    return Boolean(this.acted.get(no)?.has(street));
  }

  markActed(no, street, H) {
    if (!this.acted.has(no)) this.acted.set(no, new Set());
    this.acted.get(no).add(street);
    if (H && H.sec) {
      H.sec.acted = [...this.acted.get(no)];
      this.saveSecret(H);
    }
  }

  /** 自己发出行动时记一笔：协议规定，我在这条街上行动过之后才交下一条街的钥匙 */
  noteAction() {
    const h = this.state && this.state.hand;
    if (!h || h.ended) return;
    this.markActed(h.no, h.street, this.hands.get(h.no));
  }

  me(state = this.state) {
    return state && state.you ? state.seats[state.you.seat] : null;
  }

  // ───────────────────────────── 服务器消息 ─────────────────────────────

  onMessage(m) {
    if (m.k === 'begin' || m.k === 'sync') return this.begin(m);
    const H = this.hands.get(m.hand);
    if (!H) return;
    switch (m.k) {
      case 'S': this.gotShuffle(H, m.j, m); break;
      case 'L':
        if (mp.isCommitSet(m.commits)) H.L[m.j] = m.commits;
        else this.alarm(H, `${this.nameOf(H, m.j)} 的钥匙承诺格式不对`);
        break;
      case 'final':
        H.final = m.deck;
        this.retry(H);
        break;
      case 'keys': this.gotKeys(H, m.j, m.group, m.keys); break;
      case 'audit':
        H.dead = true;
        H.auditing = true;
        break;
      case 'req': this.request(H, m); break;
    }
    this.changed(H);
  }

  begin(m) {
    let H = this.hands.get(m.hand);
    const fresh = !H || m.k === 'begin';
    if (fresh) {
      const j = m.parts.findIndex((x) => x.id === this.myId);
      H = {
        no: m.hand, ctx: m.ctx, n: m.parts.length, j, parts: m.parts,
        S: [], L: [], final: null, keys: m.parts.map(() => ({})), sec: null,
        checked: 0, keysChecked: 0, cards: null, opened: new Map(), boardSeen: {},
        waiters: [], pending: [], dead: false, problems: [], verify: Promise.resolve(),
      };
      this.hands.set(m.hand, H);
      for (const old of this.hands.keys()) if (old < m.hand - 3) this.hands.delete(old);
      // 上下文必须由我自己根据房间号、手数和参与者算出来；对不上说明服务器在给不同的人看不同的东西
      if (mp.context(this.room, m.hand, m.parts.map((x) => x.id)) !== m.ctx) this.alarm(H, '房主给出的牌局上下文不一致');
      if (j >= 0) H.sec = this.loadSecret(m.hand);
      if (H.sec?.acted) this.acted.set(m.hand, new Set(H.sec.acted));
    }
    if (m.k === 'sync') {
      (m.S || []).forEach((st, i) => st && this.gotShuffle(H, i, st));
      (m.L || []).forEach((l, i) => { if (l && mp.isCommitSet(l.commits)) H.L[i] = l.commits; });
      if (m.final) H.final = m.final;
      (m.keys || []).forEach((byGroup, i) => {
        for (const [g, keys] of Object.entries(byGroup || {})) this.gotKeys(H, i, g, keys);
      });
      // 我已经做过的步骤需要本地秘密才能继续；秘密丢了只能让这手作废
      if (H.j >= 0 && (H.S[H.j] && !H.sec?.a || H.L[H.j] && !H.sec?.b)) {
        this.send({ t: 'mp', k: 'lost', hand: H.no });
        H.dead = true;
      }
    }
    this.changed(H);
  }

  nameOf(H, j) {
    const seat = H.parts[j]?.seat;
    const p = this.state && this.state.seats[seat];
    return p ? p.name : `${j + 1} 号参与者`;
  }

  /** 发现异常：不再交出任何钥匙。refuse 为真时同时告诉牌桌，让这手牌立刻作废 */
  alarm(H, text, refuse = true) {
    if (H.problems.includes(text)) return;
    H.problems.push(text);
    H.dead = true;
    if (refuse && H.j >= 0 && !H.refused && !H.auditing) {
      H.refused = true;
      this.send({ t: 'mp', k: 'refuse', hand: H.no });
    }
    this.warn(text, H);
  }

  // ───────────────────────────── 核验洗牌证明与钥匙 ─────────────────────────────

  gotShuffle(H, j, st) {
    if (H.S[j]) return;
    H.S[j] = { A: st.A, sumIn: st.sumIn, sumOut: st.sumOut, e: st.e, s: st.s };
    const sumIn = j === 0 ? mp.canonicalSum() : H.S[j - 1]?.sumOut;
    if (!sumIn) return;
    H.verify = H.verify.then(async () => {
      if (sumIn !== st.sumIn) return this.alarm(H, `${this.nameOf(H, j)} 的洗牌输入和上一步的输出接不上`);
      const ok = await this.rpc.call('verifyShuffle', { ctx: H.ctx, j, sumIn, step: H.S[j] });
      if (!ok) return this.alarm(H, `${this.nameOf(H, j)} 的洗牌零知识证明没有通过`);
      H.checked++;
      this.changed(H);
    });
  }

  gotKeys(H, j, group, keys) {
    if (H.keys[j]?.[group]) return;
    const commit = H.L[j]?.[group];
    if (!commit || !mp.verifyGroup(H.ctx, H.n, j, group, keys, commit)) {
      this.alarm(H, `${this.nameOf(H, j)} 公布的钥匙和他事先的承诺不符`);
      return;
    }
    H.keys[j][group] = keys;
    H.keysChecked++;
    this.tryOpen(H);
  }

  keyAt(H, j, k) {
    if (j === H.j && H.sec?.b) return H.sec.b[k];
    const g = mp.groupOf(H.n, j, k);
    const list = H.keys[j]?.[g];
    return list ? list[mp.groupPositions(H.n, j, g).indexOf(k)] : null;
  }

  /** 凡是钥匙齐了的位置都在本地打开：自己的底牌、公共牌、摊牌 */
  tryOpen(H) {
    if (!H.final) return;
    const L = mp.layout(H.n);
    const targets = [...L.flop, ...L.turn, ...L.river];
    if (H.j >= 0) targets.push(...L.hole(H.j));
    for (let i = 0; i < H.n; i++) if (i !== H.j) targets.push(...L.hole(i));
    for (const k of targets) {
      if (H.opened.has(k)) continue;
      const keys = H.parts.map((_, j) => this.keyAt(H, j, k));
      if (keys.some((x) => !x)) continue;
      H.opened.set(k, null);
      this.rpc.call('openCard', { point: H.final[k], keys }).then((card) => {
        H.opened.set(k, card || '??');
        this.afterOpen(H, k);
      });
    }
  }

  afterOpen(H, k) {
    const L = mp.layout(H.n);
    const cards = [...H.opened.values()].filter((c) => c && c !== '??');
    if ([...H.opened.values()].includes('??') || new Set(cards).size !== cards.length) {
      if (!H.reported) {
        H.reported = true;
        this.send({ t: 'mp', k: 'bad', hand: H.no });
        this.alarm(H, '解出的牌无效或重复：牌堆被人动过手脚，已要求审计', false);
      }
      return;
    }
    if (H.j >= 0 && !H.cards) {
      const mine = L.hole(H.j).map((x) => H.opened.get(x));
      if (mine.every(Boolean)) {
        H.cards = mine;
        for (const w of H.waiters.splice(0)) w(mine);
      }
    }
    // 服务器公布的公共牌必须与本地解出来的一致
    for (const street of ['flop', 'turn', 'river']) {
      const said = H.boardSeen[street];
      const mineB = L[street].map((x) => H.opened.get(x));
      if (said && mineB.every(Boolean) && said.join() !== mineB.join()) this.alarm(H, `房主公布的${street === 'flop' ? '翻牌' : street === 'turn' ? '转牌' : '河牌'}与加密记录不符`);
    }
    this.retry(H);
    this.changed(H);
  }

  boardOpened(H, street) {
    return mp.layout(H.n)[street].every((k) => H.opened.get(k) && H.opened.get(k) !== '??');
  }

  // ───────────────────────────── 服务器的请求 ─────────────────────────────

  request(H, m) {
    if (H.j < 0 || H.dead && m.what !== 'audit') return;
    if (m.what === 'S') return this.doShuffle(H, m);
    if (m.what === 'L') return this.doLock(H, m);
    if (m.what === 'audit') return this.doAudit(H, m);
    if (m.what === 'keys') {
      H.pending = H.pending.filter((x) => x.id !== m.id);
      H.pending.push({ ...m, at: Date.now() });
      this.retry(H);
    }
  }

  reply(H, m, data) {
    this.send({ t: 'mp', k: 'res', hand: H.no, id: m.id, data });
  }

  async doShuffle(H, m) {
    if (m.j !== H.j || !Array.isArray(m.input)) return;
    const expect = H.j === 0 ? mp.canonicalSum() : H.S[H.j - 1]?.sumOut;
    let real;
    try { real = await this.rpc.call('sumOf', m.input); } catch { real = null; }
    if (!expect || real !== expect || m.sumIn !== expect) return this.alarm(H, '房主转来的牌堆和公开记录对不上（可能被篡改）');
    if (!H.sec?.a) {
      H.sec = { ...mp.newShuffleSecret(), b: null };
      this.saveSecret(H);
    }
    const step = await this.rpc.call('shuffleStep', { ctx: H.ctx, j: H.j, input: m.input, a: H.sec.a, perm: H.sec.perm });
    this.reply(H, m, step);
  }

  async doLock(H, m) {
    if (m.j !== H.j || !Array.isArray(m.input) || !H.sec?.a) return;
    await H.verify; // 先确认所有洗牌证明都通过
    if (H.dead) return;
    if (H.S.length < H.n || H.checked < H.n) return this.alarm(H, '洗牌记录不完整就被要求上锁');
    if (!H.sec.b) {
      H.sec.b = mp.newLockKeys();
      this.saveSecret(H);
    }
    try { await this.rpc.call('sumOf', m.input); } catch { return this.alarm(H, '房主转来的牌堆里有无效的点'); }
    const { out } = await this.rpc.call('lockStep', { input: m.input, a: H.sec.a, b: H.sec.b });
    this.reply(H, m, { out, commits: mp.commitAll(H.ctx, H.n, H.j, H.sec.b) });
  }

  doAudit(H, m) {
    // 只有本手已经作废时才交出全部秘密（这时牌已经没有意义了）
    H.dead = true;
    if (H.sec?.a && H.sec?.b) this.reply(H, m, { a: H.sec.a, perm: H.sec.perm, b: H.sec.b });
  }

  /** 这一组钥匙现在能不能交？返回 true / false / 'wait'（条件可能稍后满足） */
  allowed(H, group) {
    const st = this.state;
    const me = this.me();
    if (!st || !st.hand || st.hand.no !== H.no || !me) return 'wait';
    const allSteps = H.L.filter(Boolean).length === H.n && H.final && H.checked === H.n;
    if (group === 'hole') return allSteps ? true : 'wait';
    if (!allSteps || !H.cards) return 'wait';
    if (group === 'own') {
      // 摊牌：五张公共牌都已在本地翻开，并且我还在这手牌里
      if (me.folded) return false;
      return ['flop', 'turn', 'river'].every((s) => this.boardOpened(H, s)) ? true : 'wait';
    }
    if (!PREV[group]) return false;
    // 已弃牌 / 已全下：这几把钥匙只影响别人，交出去不会伤害任何还能下注的人
    if (me.folded || me.allIn) return true;
    if (group !== 'flop' && !this.boardOpened(H, PREV[group])) return 'wait';
    const h = st.hand;
    if (h.street !== PREV[group] || h.turn != null) return 'wait';
    const acted = this.hasActed(H.no, h.street);
    const othersAllIn = st.seats.every((q) => !q || !q.inHand || q.folded || q.allIn || q.id === me.id);
    return acted || (othersAllIn && me.bet >= h.currentBet) ? true : 'wait';
  }

  retry(H) {
    if (H.dead || !H.pending.length) return;
    const left = [];
    for (const req of H.pending) {
      const verdicts = req.groups.map((g) => this.allowed(H, g));
      if (verdicts.every((v) => v === true)) {
        const groups = {};
        for (const g of req.groups) groups[g] = mp.groupPositions(H.n, H.j, g).map((k) => H.sec.b[k]);
        this.reply(H, req, { groups });
      } else if (verdicts.includes(false) || Date.now() - req.at > 30000) {
        this.alarm(H, `房主在不该开牌的时候索要钥匙（${req.groups.join('、')}），已拒绝`);
      } else {
        left.push(req);
      }
    }
    H.pending = left;
    if (left.length && !H.retryTimer) {
      H.retryTimer = setTimeout(() => { H.retryTimer = null; this.retry(H); }, 500);
    }
  }

  /** 离桌前主动交出公共牌钥匙（离桌即弃牌），免得这手牌因为缺我的钥匙而作废 */
  beforeLeave() {
    const h = this.state && this.state.hand;
    const H = h && this.hands.get(h.no);
    if (!H || H.j < 0 || !H.sec?.b || H.dead || h.ended || !H.final) return;
    const groups = {};
    for (const g of ['flop', 'turn', 'river']) groups[g] = mp.groupPositions(H.n, H.j, g).map((k) => H.sec.b[k]);
    this.send({ t: 'mp', k: 'keys', hand: H.no, data: { groups } });
  }

  // ───────────────────────────── 给界面用 ─────────────────────────────

  /** 等自己的底牌解出来 */
  myCards(no, ms = 8000) {
    const H = this.hands.get(no);
    if (!H || H.j < 0) return Promise.resolve(null);
    if (H.cards) return Promise.resolve(H.cards);
    return new Promise((resolve) => {
      H.waiters.push(resolve);
      setTimeout(() => resolve(H.cards), ms);
    });
  }

  /** 把本地解出的底牌填进牌桌状态（房主本身不知道这两张牌） */
  decorate(state) {
    const h = state && state.hand;
    if (!h || !state.you) return state;
    const H = this.hands.get(h.no);
    const me = state.seats[state.you.seat];
    if (H && H.cards && me && me.hasCards && !me.cards) me.cards = H.cards;
    return state;
  }

  current() {
    const h = this.state && this.state.hand;
    return h ? this.hands.get(h.no) || null : null;
  }

  // ───────────────────────────── 复核服务器的公告 ─────────────────────────────

  check(ev, state, H) {
    const h = state.hand;
    if (ev.type === 'deal' || (ev.type === 'shuffle' && !this.stacks.has(h.no))) {
      this.stacks.set(h.no, state.seats.reduce((s, p) => s + (p && p.inHand ? p.chips + p.total : 0), 0));
    }
    if (ev.type === 'board' && H) {
      H.boardSeen[ev.street] = ev.cards;
      this.afterOpen(H, -1);
    }
    if ((ev.type === 'result' || ev.type === 'void') && this.stacks.has(h.no)) {
      const after = state.seats.reduce((s, p) => s + (p && p.inHand ? p.chips : 0), 0);
      const before = this.stacks.get(h.no);
      if (after !== before) this.warn(`筹码总数不守恒：本手开始 ${before}，结束 ${after}`, H);
    }
    if (ev.type === 'result' && ev.showdown && H) this.checkShowdown(ev, state, H);
  }

  checkShowdown(ev, state, H) {
    const L = mp.layout(H.n);
    const verify = () => {
      for (const shown of ev.hands) {
        const j = H.parts.findIndex((x) => x.seat === shown.seat);
        if (j < 0) continue;
        const mine = L.hole(j).map((k) => H.opened.get(k));
        if (!mine.every((c) => c && c !== '??')) return false; // 还在解
        if (mine.join() !== shown.cards.join()) {
          this.alarm(H, `房主公布的 ${this.nameOf(H, j)} 的底牌与加密记录不符`);
          return true;
        }
      }
      // 用本地解出的牌重新结算一遍
      const players = state.seats.filter((p) => p && p.inHand).map((p) => {
        const shown = ev.hands.find((x) => x.seat === p.seat);
        return { seat: p.seat, total: p.total, folded: p.folded || !shown, cards: shown ? shown.cards : [] };
      });
      const pot = players.reduce((s, p) => s + p.total, 0);
      try {
        const mine = settle({ players, board: state.hand.board, dealer: state.hand.dealer, seats: state.seats.length, pot }).pots;
        const norm = (pots) => JSON.stringify(pots.map((p) => [p.amount, p.winners.map((w) => [w.seat, w.amount])]));
        if (norm(mine) !== norm(ev.pots)) this.alarm(H, '房主的结算结果与规则复核不一致');
      } catch {
        this.alarm(H, '无法复核房主的结算结果');
      }
      return true;
    };
    let tries = 0;
    const tick = () => { if (!verify() && ++tries < 40) setTimeout(tick, 150); };
    tick();
  }
}
