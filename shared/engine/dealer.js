// 发牌员：一手牌里洗牌、发底牌、翻公共牌、摊牌的全部流程。
//   MentalDealer —— 心理扑克（默认）。服务器只负责转发与校验，不知道任何真人的底牌。
//   PlainDealer  —— 服务器直接发牌，只用于规则引擎的单元测试。
import * as mp from '../mp/protocol.js';

/** 本手牌无法继续，需要作废并退还筹码。seat 指向责任人（若能确定） */
export class VoidHand extends Error {
  constructor(reason, seat = null) {
    super(reason);
    this.reason = reason;
    this.seat = seat;
  }
}

export const TIMEOUTS = { step: 20000, keys: 25000, show: 15000, audit: 12000 };
const BOARD = ['flop', 'turn', 'river'];

export class MentalDealer {
  /** players：本手参与者，按发牌顺序（庄家左手边起） */
  constructor(room, hand, players) {
    this.room = room;
    this.pool = room.pool;
    this.hand = hand;
    this.n = players.length;
    this.parts = players.map((p, i) => ({ i, p, seat: p.seat, bot: p.bot, secret: null }));
    this.ctx = mp.context(room.code, hand.no, players.map((p) => p.id));
    this.layout = mp.layout(this.n);
    this.S = [];
    this.L = [];
    this.decksS = [];
    this.decksL = [];
    this.final = null;
    this.keys = this.parts.map(() => ({}));
    this.waits = this.parts.map(() => ({}));
    this.asks = new Map();
    this.seq = 0;
    this.closed = false;
    this.known = new Set(); // 服务器已经打开的牌（机器人底牌、公共牌、摊牌）
    this.onFail = null; // (VoidHand) => void   —— 不在任何 await 链上的失败（如玩家报警）
  }

  info() {
    return { ctx: this.ctx, parts: this.parts.map((x) => ({ seat: x.seat, id: x.p.id, bot: x.bot })) };
  }

  partOf(p) { return this.parts.find((x) => x.p === p) || null; }

  broadcast(msg) {
    this.room.broadcast({ t: 'mp', hand: this.hand.no, ...msg });
  }

  alive() {
    if (this.closed) throw new VoidHand('cancelled');
  }

  // ───────────────────────────── 向真人索取数据 ─────────────────────────────

  ask(part, req, ms) {
    if (this.closed) return Promise.reject(new VoidHand('cancelled'));
    if (part.p.left) return Promise.reject(new VoidHand('left', part.seat));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const entry = { id, part, req, resolve, reject };
      entry.timer = setTimeout(() => {
        this.asks.delete(id);
        reject(new VoidHand(part.p.connected ? 'timeout' : 'offline', part.seat));
      }, ms);
      this.asks.set(id, entry);
      this.sendAsk(entry);
    });
  }

  sendAsk(entry) {
    entry.part.p.conn?.send({ t: 'mp', k: 'req', hand: this.hand.no, id: entry.id, ...entry.req });
  }

  settle(entry, fn) {
    this.asks.delete(entry.id);
    clearTimeout(entry.timer);
    fn();
  }

  // ───────────────────────────── 洗牌 + 上锁 ─────────────────────────────

  async prepare(progress = () => {}) {
    this.broadcast({ k: 'begin', ...this.info() });
    let deck = mp.canonicalDeck();
    let sum = mp.canonicalSum();

    for (const part of this.parts) {
      this.alive();
      progress('S', part.i, part.seat);
      let step;
      if (part.bot) {
        part.secret = mp.newShuffleSecret();
        step = await this.pool.call('shuffleStep', { ctx: this.ctx, j: part.i, input: deck, ...part.secret });
      } else {
        const res = await this.ask(part, { what: 'S', j: part.i, input: deck, sumIn: sum }, TIMEOUTS.step);
        step = await this.checkShuffle(part, res, sum);
      }
      this.alive();
      const pub = { A: step.A, sumIn: step.sumIn, sumOut: step.sumOut, e: step.e, s: step.s };
      this.S[part.i] = pub;
      this.decksS[part.i] = step.out;
      this.broadcast({ k: 'S', j: part.i, ...pub });
      deck = step.out;
      sum = step.sumOut;
    }

    for (const part of this.parts) {
      this.alive();
      progress('L', part.i, part.seat);
      let out;
      let commits;
      if (part.bot) {
        part.secret.b = mp.newLockKeys();
        ({ out } = await this.pool.call('lockStep', { input: deck, a: part.secret.a, b: part.secret.b }));
        commits = mp.commitAll(this.ctx, this.n, part.i, part.secret.b);
      } else {
        const res = await this.ask(part, { what: 'L', j: part.i, input: deck }, TIMEOUTS.step);
        if (!res || !Array.isArray(res.out) || res.out.length !== 52 || !res.out.every((s) => mp.isB64(s, 44)) || !mp.isCommitSet(res.commits)) {
          throw new VoidHand('bad_step', part.seat);
        }
        try { await this.pool.call('sumOf', res.out); } catch { throw new VoidHand('bad_step', part.seat); } // 每个点都必须在曲线上
        out = res.out;
        commits = Object.fromEntries(mp.GROUPS.map((g) => [g, res.commits[g]]));
      }
      this.alive();
      this.L[part.i] = { commits };
      this.decksL[part.i] = out;
      this.broadcast({ k: 'L', j: part.i, commits });
      deck = out;
    }
    this.final = deck;
    this.broadcast({ k: 'final', deck });
  }

  async checkShuffle(part, res, sumIn) {
    const okShape = res && Array.isArray(res.out) && res.out.length === 52 && res.out.every((s) => mp.isB64(s, 44))
      && ['A', 'sumIn', 'sumOut'].every((f) => mp.isB64(res[f], 44)) && mp.isB64(res.e, 43) && mp.isB64(res.s, 43);
    if (!okShape || res.sumIn !== sumIn) throw new VoidHand('bad_step', part.seat);
    let realSum;
    try { realSum = await this.pool.call('sumOf', res.out); } catch { throw new VoidHand('bad_step', part.seat); }
    if (realSum !== res.sumOut) throw new VoidHand('bad_step', part.seat);
    const ok = await this.pool.call('verifyShuffle', { ctx: this.ctx, j: part.i, sumIn, step: res });
    if (!ok) throw new VoidHand('bad_step', part.seat);
    return res;
  }

  // ───────────────────────────── 钥匙 ─────────────────────────────

  /** 收下一组钥匙（校验承诺），成功返回 true */
  acceptGroup(part, name, keys) {
    if (this.keys[part.i][name]) return true;
    const commit = this.L[part.i]?.commits[name];
    if (!commit || !mp.verifyGroup(this.ctx, this.n, part.i, name, keys, commit)) return false;
    this.keys[part.i][name] = keys;
    this.broadcast({ k: 'keys', j: part.i, group: name, keys });
    return true;
  }

  publishBot(part, name) {
    const keys = mp.groupPositions(this.n, part.i, name).map((k) => part.secret.b[k]);
    this.acceptGroup(part, name, keys);
  }

  /** 向某位参与者要若干组钥匙（已有的跳过）；返回在全部到齐时 resolve 的 Promise */
  request(part, names, ms = TIMEOUTS.keys) {
    if (part.bot) {
      for (const g of names) this.publishBot(part, g);
      return Promise.resolve();
    }
    const missing = names.filter((g) => !this.keys[part.i][g] && !this.waits[part.i][g]);
    if (missing.length) {
      const job = this.ask(part, { what: 'keys', groups: missing }, ms).then((data) => {
        for (const g of missing) {
          if (!this.acceptGroup(part, g, data?.groups?.[g])) throw new VoidHand('bad_key', part.seat);
        }
      });
      for (const g of missing) {
        const w = job.finally(() => { if (this.waits[part.i][g] === w) delete this.waits[part.i][g]; });
        w.catch(() => {});
        this.waits[part.i][g] = w;
      }
    }
    return Promise.all(names.map((g) => (this.keys[part.i][g] ? null : this.waits[part.i][g])));
  }

  /** 玩家主动公布的钥匙（弃牌 / 离桌时）。只接受公共牌的组 */
  volunteer(part, groups) {
    if (!groups || typeof groups !== 'object') return;
    for (const g of BOARD) {
      if (!Array.isArray(groups[g]) || this.keys[part.i][g]) continue;
      if (!this.acceptGroup(part, g, groups[g])) {
        this.onFail?.(new VoidHand('bad_key', part.seat));
        return;
      }
    }
    // 正在等这些组的请求可以直接结束
    for (const entry of [...this.asks.values()]) {
      if (entry.part !== part || entry.req.what !== 'keys') continue;
      if (entry.req.groups.every((g) => this.keys[part.i][g])) {
        this.settle(entry, () => entry.resolve({ groups: Object.fromEntries(entry.req.groups.map((g) => [g, this.keys[part.i][g]])) }));
      }
    }
  }

  keyAt(part, k) {
    if (part.bot) return part.secret.b[k];
    const g = mp.groupOf(this.n, part.i, k);
    const list = this.keys[part.i][g];
    return list ? list[mp.groupPositions(this.n, part.i, g).indexOf(k)] : null;
  }

  async open(k) {
    const keys = this.parts.map((part) => this.keyAt(part, k));
    if (keys.some((x) => !x)) throw new Error(`missing key for position ${k}`);
    return this.pool.call('openCard', { point: this.final[k], keys });
  }

  /** 新打开的牌必须有效且不与已知的牌重复，否则说明有人篡改了牌堆 */
  async admit(cards) {
    const bad = cards.some((c) => !c) || new Set(cards).size !== cards.length || cards.some((c) => this.known.has(c));
    if (bad) await this.auditAndThrow(null);
    for (const c of cards) this.known.add(c);
  }

  // ───────────────────────────── 发牌流程 ─────────────────────────────

  async dealHole() {
    await Promise.all(this.parts.map((part) => this.request(part, ['hole'])));
    this.alive();
    for (const part of this.parts.filter((x) => x.bot)) {
      const cards = await Promise.all(this.layout.hole(part.i).map((k) => this.open(k)));
      await this.admit(cards);
      part.p.cards = cards;
    }
  }

  async openStreet(street) {
    await Promise.all(this.parts.map((part) => this.request(part, [street])));
    this.alive();
    const cards = await Promise.all(this.layout[street].map((k) => this.open(k)));
    await this.admit(cards);
    return cards;
  }

  /** 摊牌：参赛者公布自己那两把钥匙。拒绝 / 超时的人视为放弃这手牌 */
  async showdown(players) {
    const parts = players.map((p) => this.partOf(p));
    const results = await Promise.allSettled(parts.map((part) => this.request(part, ['own'], TIMEOUTS.show)));
    this.alive();
    const shown = new Map();
    const fresh = [];
    for (let x = 0; x < parts.length; x++) {
      if (results[x].status !== 'fulfilled') continue;
      const part = parts[x];
      const cards = part.bot ? part.p.cards : await Promise.all(this.layout.hole(part.i).map((k) => this.open(k)));
      if (!part.bot) fresh.push(...cards);
      shown.set(part.seat, cards);
    }
    await this.admit(fresh);
    return shown;
  }

  onFold(p) {
    const part = this.partOf(p);
    if (!part || part.bot || this.closed || !this.final) return;
    const need = BOARD.filter((g) => !this.keys[part.i][g]);
    if (need.length) this.request(part, need).catch(() => {});
  }

  // ───────────────────────────── 审计 ─────────────────────────────

  /** 发现牌堆异常：本手作废，所有人交出本手全部秘密，重算整条链找出责任人 */
  async auditAndThrow(accuser) {
    if (this.auditing) return this.auditing;
    this.auditing = (async () => {
      this.broadcast({ k: 'audit' });
      const secrets = await Promise.all(this.parts.map(async (part) => {
        if (part.bot) return part.secret;
        try {
          const r = await this.ask(part, { what: 'audit' }, TIMEOUTS.audit);
          return r && typeof r.a === 'string' && Array.isArray(r.perm) && Array.isArray(r.b) ? { a: r.a, perm: r.perm, b: r.b } : null;
        } catch {
          return null;
        }
      }));
      const res = await this.pool.call('audit', {
        ctx: this.ctx, n: this.n, decksS: this.decksS, decksL: this.decksL,
        commits: this.L.map((l) => l.commits), secrets,
      });
      if (res.culprit != null) {
        const reason = res.detail === 'no-secret' ? 'audit_timeout' : 'corrupt';
        throw new VoidHand(reason, this.parts[res.culprit].seat);
      }
      throw new VoidHand(accuser ? 'false_alarm' : 'corrupt', accuser ? accuser.seat : null);
    })();
    return this.auditing;
  }

  // ───────────────────────────── 来自客户端的消息 ─────────────────────────────

  handle(p, msg) {
    if (this.closed || msg.hand !== this.hand.no) return;
    const part = this.partOf(p);
    if (!part) return;
    if (msg.k === 'res') {
      const entry = this.asks.get(msg.id);
      if (entry && entry.part === part) this.settle(entry, () => entry.resolve(msg.data));
    } else if (msg.k === 'keys') {
      this.volunteer(part, msg.data?.groups);
    } else if (msg.k === 'lost') {
      this.onFail?.(new VoidHand('lost', part.seat));
    } else if (msg.k === 'refuse') {
      // 玩家的浏览器发现异常，拒绝继续交钥匙：立即作废，不必干等超时
      this.onFail?.(new VoidHand('refused', part.seat));
    } else if (msg.k === 'bad' && this.final) {
      // 玩家说自己的底牌打不开：只有审计能分清是真被篡改还是谎报
      this.auditAndThrow(part).catch((err) => this.onFail?.(err));
    }
  }

  onLeave(p) {
    const part = this.partOf(p);
    if (!part) return;
    for (const entry of [...this.asks.values()]) {
      if (entry.part === part) this.settle(entry, () => entry.reject(new VoidHand('left', part.seat)));
    }
  }

  /** 给（重新）连上来的人补发本手牌的全部公开记录，以及还欠着的请求 */
  sync(conn, p) {
    if (this.closed) return;
    conn.send({
      t: 'mp', k: 'sync', hand: this.hand.no, ...this.info(),
      S: this.S, L: this.L, final: this.final,
      keys: this.keys.map((byGroup) => Object.fromEntries(Object.entries(byGroup).filter(([g]) => g !== 'rest'))),
    });
    for (const entry of this.asks.values()) if (entry.part.p === p) this.sendAsk(entry);
  }

  cancel() {
    this.closed = true;
    for (const entry of [...this.asks.values()]) this.settle(entry, () => entry.reject(new VoidHand('cancelled')));
  }
}

/** 服务器直接发牌（只用于单元测试） */
export class PlainDealer {
  constructor(room, hand, players) {
    this.players = players;
    this.deck = room.makeDeck();
  }

  async prepare() {}

  async dealHole() {
    for (let round = 0; round < 2; round++) for (const p of this.players) p.cards.push(this.deck.pop());
  }

  async openStreet(street) {
    this.deck.pop(); // 烧牌
    const n = street === 'flop' ? 3 : 1;
    return Array.from({ length: n }, () => this.deck.pop());
  }

  async showdown(players) {
    return new Map(players.map((p) => [p.seat, p.cards]));
  }

  onFold() {}
  onLeave() {}
  handle() {}
  sync() {}
  cancel() {}
}
