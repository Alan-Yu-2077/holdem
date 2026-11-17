// 房间 + 无限注德州扑克规则引擎（浏览器 / Node 通用）。
// 点对点模式下它运行在房主浏览器的后台线程里，负责下注规则与筹码记账；
// 牌由「心理扑克」协议发出，房主看不到任何真人的底牌。
import { makeDeck, shuffle, settle } from '../poker.js';
import { random, randomInt, randomBytes } from '../mp/random.js';
import { toHex } from '../mp/bytes.js';
import { botDecide, BOT_NAMES } from './bot.js';
import { MentalDealer, PlainDealer, VoidHand } from './dealer.js';
import { makeLevels, payoutPlan, prizeShare, placeBusted, finalStandings, levelAt } from './tourney.js';

const uid = (bytes = 8) => toHex(randomBytes(bytes));
const HUES = [38, 205, 152, 342, 268, 18, 182, 96, 300];
const CHEAT_REASONS = new Set(['bad_step', 'bad_key', 'corrupt', 'false_alarm']);
const AWAY_REASONS = new Set(['timeout', 'offline', 'lost', 'audit_timeout']);

function clampInt(v, lo, hi, dflt) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

export function cleanSettings(s = {}, base = {}) {
  const mode = (s.mode ?? base.mode) === 'tourney' ? 'tourney' : 'cash'; // 常规局 / 锦标赛
  const startingChips = clampInt(s.startingChips ?? base.startingChips, 100, 1_000_000, 2000);
  const bb = clampInt(s.bb ?? base.bb, 2, startingChips, 20);
  const sb = clampInt(s.sb ?? base.sb, 1, bb, Math.max(1, Math.floor(bb / 2)));
  return {
    mode,
    startingChips,
    bb,
    sb,
    maxSeats: base.maxSeats ?? clampInt(s.maxSeats, 2, 9, 6),
    turnTime: clampInt(s.turnTime ?? base.turnTime, 0, 120, 30), // 0 = 不限时
    allowRebuy: mode === 'tourney' ? false : Boolean(s.allowRebuy ?? base.allowRebuy ?? true),
    minutes: clampInt(s.minutes ?? base.minutes, 10, 600, 120), // 锦标赛时长
    paid: clampInt(s.paid ?? base.paid, 0, 3, 0), // 锦标赛奖励名额，0 = 按人数自动
  };
}

/** 常数时间比较令牌，避免计时侧信道 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export class Room {
  /** pool：密码学计算的执行器，{ call(fn, args) → Promise }（见 inline-pool.js） */
  constructor(code, settings, { pool } = {}) {
    this.code = code;
    this.pool = pool;
    this.settings = cleanSettings(settings);
    this.seats = Array(this.settings.maxSeats).fill(null);
    this.spectators = new Set();
    this.hostId = null;
    this.phase = 'lobby'; // lobby | playing | over（锦标赛结束）
    this.paused = false;
    this.tourney = null; // 锦标赛进行中的状态（盲注结构、计时、出局名单、最终名次）
    this.clockTimer = null;
    this.now = () => Date.now(); // 测试里可以换成假时钟
    this.hand = null;
    this.handNo = 0;
    this.dealer = -1;
    this.pace = 0;
    this.turnTimer = null;
    this.botTimer = null;
    this.nextTimer = null;
    this.manual = false; // 测试用：不启动任何定时器
    this.secure = true; // 心理扑克发牌；测试规则引擎时可关掉，改用服务器直接发牌
    this.makeDeck = () => shuffle(makeDeck());
    this.onEvent = null;
    this.onEmpty = null;
    this.idleSince = Date.now();
  }

  // ───────────────────────────── 玩家与座位 ─────────────────────────────

  players() { return this.seats.filter(Boolean); }
  humans() { return this.seats.filter((p) => p && !p.bot && !p.left); }
  hasLiveHuman() {
    return this.humans().some((p) => p.connected) || this.spectators.size > 0;
  }

  pickSeat() {
    const n = this.seats.length;
    const free = [];
    const taken = [];
    this.seats.forEach((p, i) => (p ? taken : free).push(i));
    if (!free.length) return -1;
    if (!taken.length) return 0;
    let best = free[0];
    let bestDist = -1;
    for (const f of free) {
      const d = Math.min(...taken.map((o) => Math.min(Math.abs(o - f), n - Math.abs(o - f))));
      if (d > bestDist) { bestDist = d; best = f; }
    }
    return best;
  }

  uniqueName(name) {
    const used = new Set(this.players().map((p) => p.name));
    if (!used.has(name)) return name;
    for (let i = 2; i < 99; i++) if (!used.has(`${name}${i}`)) return `${name}${i}`;
    return name + uid().slice(0, 3);
  }

  addPlayer({ name, conn = null, bot = false }) {
    if (this.settings.mode === 'tourney' && this.phase !== 'lobby') return null; // 开赛后不能再报名，只能观战
    const seat = this.pickSeat();
    if (seat < 0) return null;
    const p = {
      id: uid(), token: uid(32), name: this.uniqueName(name), seat,
      chips: this.settings.startingChips, buyIns: 1, bot, conn, connected: true,
      sitOut: false, left: false, hue: HUES[seat % HUES.length], discAt: 0, dropTimer: null,
      inHand: false, folded: false, allIn: false, bet: 0, total: 0, cards: [],
      acted: false, actedAt: 0, revealed: false, last: null, timeouts: 0, suspect: 0,
      style: bot ? { tight: random(), aggr: random() } : null,
    };
    this.seats[seat] = p;
    if (!bot && !this.hostId) this.hostId = p.id;
    this.emit({ type: 'join', seat, name: p.name });
    this.kickstart();
    return p;
  }

  addBot() {
    const used = new Set(this.players().map((p) => p.name));
    const pool = BOT_NAMES.filter((n) => !used.has(n));
    const name = pool.length ? pool[randomInt(pool.length)] : `机器人${this.players().length + 1}`;
    return this.addPlayer({ name, bot: true });
  }

  findByToken(token) {
    return this.seats.find((p) => p && !p.bot && !p.left && sameToken(p.token, token)) || null;
  }

  reconnect(p, conn) {
    if (p.conn && p.conn !== conn) p.conn.close('replaced');
    clearTimeout(p.dropTimer);
    p.conn = conn;
    p.connected = true;
    if (p.sitOut && p.autoAway) { p.sitOut = false; p.autoAway = false; }
    p.timeouts = 0;
    this.emit({ type: 'presence', seat: p.seat });
    this.kickstart();
  }

  /** 把当前这手牌的加密记录补发给某个连接（重连、中途入座、观战） */
  syncHand(conn, p = null) {
    const h = this.hand;
    if (h && !h.ended && h.cards) h.cards.sync(conn, p);
  }

  disconnect(p) {
    p.conn = null;
    p.connected = false;
    p.discAt = Date.now();
    this.emit({ type: 'presence', seat: p.seat });
    clearTimeout(p.dropTimer);
    if (this.manual) return;
    // 大厅阶段断线 30 秒后让出座位；对局中保留座位（自动暂离），房主断线 60 秒后移交
    p.dropTimer = setTimeout(() => {
      if (p.connected || this.seats[p.seat] !== p) return;
      if (this.phase === 'lobby') return this.removePlayer(p, 'timeout');
      if (this.hostId === p.id) this.transferHost(p);
    }, this.phase === 'lobby' ? 30000 : 60000);
    // 轮到他行动时不必等满思考时间
    const h = this.hand;
    if (h && !h.ended && h.turn === p.seat) {
      clearTimeout(this.turnTimer);
      this.turnTimer = setTimeout(() => this.timeout(p), 6000);
    }
  }

  transferHost(from) {
    const next = this.humans().find((p) => p !== from && p.connected) || this.humans().find((p) => p !== from);
    if (!next) return false;
    this.hostId = next.id;
    this.emit({ type: 'host', seat: next.seat, name: next.name });
    return true;
  }

  removePlayer(p, why = 'leave') {
    if (this.seats[p.seat] !== p || p.left) return;
    clearTimeout(p.dropTimer);
    const forfeit = this.forfeit(p);
    if (p.conn) { p.conn.send({ t: 'left', why }); p.conn.detach(); }
    p.conn = null;
    p.connected = false;
    const h = this.hand;
    if (h && !h.ended && p.inHand) {
      p.left = true; // 本手牌结束后再清走，保证底池计算完整
      h.cards?.onLeave(p);
      if (!p.folded && h.dealt) {
        if (h.turn === p.seat) this.act(p, 'fold', 0, true);
        else {
          p.folded = true;
          p.last = { a: 'fold' };
          this.emit({ type: 'action', seat: p.seat, kind: 'fold', amount: p.bet, delta: 0 });
          this.afterOutOfTurnFold();
        }
      }
    } else {
      this.seats[p.seat] = null;
    }
    this.emit({ type: 'leave', seat: p.seat, name: p.name, why });
    if (!p.bot && this.hostId === p.id) {
      if (!this.transferHost(p)) this.hostId = null;
    }
    if (forfeit && forfeit.left <= 1 && !(h && !h.ended)) this.endTourney('winner');
    if (!this.humans().length) this.onEmpty?.();
  }

  // ───────────────────────────── 消息 ─────────────────────────────

  handle(p, msg) {
    const isHost = p.id === this.hostId;
    switch (msg.t) {
      case 'start':
        if (!isHost || this.phase !== 'lobby') return;
        if (this.players().length < 2) return p.conn?.send({ t: 'error', msg: '至少需要 2 名玩家才能开始' });
        this.phase = 'playing';
        if (this.settings.mode === 'tourney') this.startTourney();
        this.emit({ type: 'start' });
        this.startHand();
        break;
      case 'rematch':
        if (!isHost || this.phase !== 'over') return;
        this.resetLobby();
        break;
      case 'finish': {
        // 房主提前结束锦标赛：打完当前这手，剩下的人按筹码排名
        const t = this.tourney;
        if (!isHost || !t || t.ended || this.phase !== 'playing') return;
        t.final = 'host';
        if (this.hand && !this.hand.ended) this.emit({ type: 'final', reason: 'host' });
        else this.endTourney('host');
        break;
      }
      case 'action':
        if (this.act(p, msg.a, msg.amount)) p.timeouts = 0;
        break;
      case 'mp': {
        const h = this.hand;
        if (h && !h.ended && h.cards) h.cards.handle(p, msg);
        break;
      }
      case 'addBot':
        if (!isHost) return;
        if (!this.addBot()) p.conn?.send({ t: 'error', msg: this.settings.mode === 'tourney' && this.phase !== 'lobby' ? '比赛已经开始，不能再加人' : '座位已满' });
        break;
      case 'kick': {
        if (!isHost) return;
        const target = this.seats.find((q) => q && q.id === msg.id);
        if (target && target !== p) this.removePlayer(target, 'kick');
        break;
      }
      case 'settings':
        if (!isHost) return;
        if (this.tourney) {
          // 比赛开始后结构已定，只能改思考时间
          this.settings.turnTime = cleanSettings({ turnTime: msg.settings?.turnTime }, this.settings).turnTime;
        } else {
          this.settings = cleanSettings({ ...msg.settings, mode: this.settings.mode }, this.settings);
          if (this.phase === 'lobby') {
            for (const q of this.players()) q.chips = this.settings.startingChips;
            if (this.settings.mode === 'tourney') this.previewBlinds();
          }
        }
        this.emit({ type: 'settings' });
        break;
      case 'rebuy': {
        const busy = this.hand && !this.hand.ended && p.inHand;
        if (!this.settings.allowRebuy || p.chips > 0 || busy) return;
        this.rebuy(p);
        this.kickstart();
        break;
      }
      case 'sitout':
        p.sitOut = Boolean(msg.value);
        p.autoAway = false;
        this.emit({ type: 'presence', seat: p.seat });
        if (!p.sitOut) this.kickstart();
        break;
      case 'pause':
        if (!isHost) return;
        this.paused = Boolean(msg.value);
        if (this.phase === 'playing') this.clockRun(!this.paused); // 锦标赛的计时随之停走
        this.emit({ type: 'pause', value: this.paused });
        if (!this.paused) this.kickstart();
        break;
      case 'chat': {
        const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (text) this.broadcast({ t: 'chat', id: p.id, seat: p.seat, name: p.name, text });
        break;
      }
      case 'leave':
        this.removePlayer(p, 'leave');
        break;
    }
  }

  rebuy(p) {
    p.chips = this.settings.startingChips;
    p.buyIns++;
    this.emit({ type: 'rebuy', seat: p.seat, name: p.name });
  }

  // ───────────────────────────── 广播 ─────────────────────────────

  broadcast(msg) {
    for (const p of this.seats) if (p && p.conn) p.conn.send(msg);
    for (const c of this.spectators) c.send(msg);
  }

  emit(ev) {
    for (const p of this.seats) if (p && p.conn) p.conn.send({ t: 'ev', ev, state: this.view(p) });
    for (const c of this.spectators) c.send({ t: 'ev', ev, state: this.view(null) });
    this.onEvent?.(ev);
  }

  view(p) {
    const h = this.hand;
    const live = h && !h.ended;
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      paused: this.paused,
      secure: this.secure,
      settings: this.settings,
      seats: this.seats.map((q) => q && {
        id: q.id, name: q.name, seat: q.seat, chips: q.chips, bot: q.bot,
        connected: q.connected, sitOut: q.sitOut, buyIns: q.buyIns, hue: q.hue, suspect: q.suspect,
        out: q.out || 0, place: q.place || 0, // 锦标赛：出局名次 / 最终名次
        inHand: Boolean(h) && q.inHand, folded: q.folded, allIn: q.allIn, bet: q.bet, total: q.total, last: q.last,
        hasCards: Boolean(h && h.dealt) && q.inHand && !q.folded,
        // 心理扑克下服务器只知道机器人的牌；真人的牌只有摊牌后才知道
        cards: h && q.inHand && !q.folded && q.cards.length === 2 && (q === p || q.revealed) ? q.cards : null,
      }),
      hand: h && {
        no: h.no, dealer: h.dealer, sb: h.sbSeat, bb: h.bbSeat, street: h.street, stage: h.stage,
        order: h.order, board: h.board, pot: h.pot,
        total: h.pot + this.seats.reduce((s, q) => s + (q && q.inHand ? q.bet : 0), 0),
        currentBet: h.currentBet, turn: h.turn, ended: Boolean(h.ended), voided: Boolean(h.voided),
        timeLeft: live && h.turnEnds ? Math.max(0, h.turnEnds - Date.now()) : null,
        turnTime: this.settings.turnTime * 1000,
        options: live && p && h.turn === p.seat ? this.options(p) : null,
      },
      tourney: this.tourneyView(),
      you: p ? { id: p.id, seat: p.seat } : null,
    };
  }

  tourneyView() {
    const t = this.tourney;
    if (!t) return null;
    return {
      levelMs: t.levelMs, levels: t.levels, durationMs: t.durationMs,
      elapsed: Math.round(this.elapsed()), running: t.since != null, level: t.level,
      entrants: t.entrants, payouts: t.payouts, out: t.out,
      final: t.final || null, ended: t.ended, reason: t.reason, standings: t.standings,
    };
  }

  // ───────────────────────────── 一手牌 ─────────────────────────────

  nextSeat(from, pred) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const s = (((from + i) % n) + n) % n;
      const p = this.seats[s];
      if (p && pred(p)) return s;
    }
    return -1;
  }

  eligible(p) {
    if (!p || p.left || p.sitOut || p.chips <= 0) return false;
    if (p.bot || this.manual) return true;
    // 加密发牌需要每位真人在线参与洗牌，所以掉线的人不发牌
    return this.secure ? p.connected : p.connected || Date.now() - p.discAt < 15000;
  }

  /** 牌局空闲时尝试开始下一手 */
  kickstart(delay = 1200) {
    if (this.manual || this.phase !== 'playing' || this.paused || this.nextTimer) return;
    if (this.hand && !this.hand.ended) return;
    this.nextTimer = setTimeout(() => { this.nextTimer = null; this.startHand(); }, delay);
  }

  live(h) { return this.hand === h && !h.ended; }

  async startHand() {
    clearTimeout(this.nextTimer);
    this.nextTimer = null;
    if (this.phase !== 'playing' || this.paused) return false;
    if (this.hand && !this.hand.ended) return false;
    const t = this.tourney;
    if (t && (t.final || this.elapsed() >= t.durationMs)) {
      this.endTourney(t.final || 'time'); // 到点了（或房主喊停）：不再发新的一手
      return false;
    }
    for (const p of this.players()) {
      if (p.left) { this.seats[p.seat] = null; continue; }
      Object.assign(p, { inHand: false, folded: false, allIn: false, bet: 0, total: 0, cards: [], acted: false, actedAt: 0, revealed: false, last: null });
    }
    const inPlay = this.seats.filter((p) => this.eligible(p));
    const humanOk = this.manual || this.humans().some((p) => p.connected) || this.spectators.size > 0;
    if (inPlay.length < 2 || !humanOk) {
      if (this.hand) { this.hand = null; this.emit({ type: 'waiting' }); }
      return false;
    }
    for (const p of inPlay) p.inHand = true;
    const inHand = (p) => p.inHand;
    // 锦标赛里按钮和盲注在所有仍在场的人之间轮转：暂离或掉线的人不发牌，但轮到他的盲注照扣，
    // 免得有人靠「躲盲注」熬名次
    const seated = t ? this.seats.filter((p) => p && !p.left && !p.out && p.chips > 0) : inPlay;
    const rotates = (p) => seated.includes(p);
    for (const p of seated) p.handStart = p.chips;

    this.dealer = this.nextSeat(this.dealer < 0 ? randomInt(this.seats.length) : this.dealer, rotates);
    const headsUp = seated.length === 2;
    const sbSeat = headsUp ? this.dealer : this.nextSeat(this.dealer, rotates);
    const bbSeat = this.nextSeat(sbSeat, rotates);
    let levelUp = null;
    if (t) {
      const idx = levelAt(t, this.elapsed());
      if (idx !== t.level) {
        if (t.level >= 0) levelUp = { type: 'level', level: idx, sb: t.levels[idx][0], bb: t.levels[idx][1] };
        t.level = idx;
        [this.settings.sb, this.settings.bb] = t.levels[idx];
      }
    }
    const { sb, bb } = this.settings;
    // 发牌顺序：从庄家左手边开始（只含拿牌的人）
    const order = [];
    let s = this.dealer;
    for (let i = 0; i < inPlay.length; i++) { s = this.nextSeat(s, inHand); order.push(s); }
    // 不在场却轮到盲注的人：照扣盲注，直接算弃牌（死盲）
    for (const seat of [sbSeat, bbSeat]) {
      const p = this.seats[seat];
      if (!p.inHand) Object.assign(p, { inHand: true, folded: true });
    }

    const h = this.hand = {
      no: ++this.handNo, dealer: this.dealer, sbSeat, bbSeat, street: 'preflop', stage: 'shuffle',
      order, board: [], pot: 0, currentBet: bb, minRaise: bb, blinds: [sb, bb],
      turn: null, turnEnds: null, ended: false, dealt: false, runout: 0,
    };
    const players = order.map((seat) => this.seats[seat]);
    h.cards = this.secure ? new MentalDealer(this, h, players) : new PlainDealer(this, h, players);
    h.cards.onFail = (err) => this.failHand(h, err);
    this.emit({ type: 'hand_start', no: h.no, dealer: h.dealer, sb: sbSeat, bb: bbSeat });
    if (levelUp) this.emit(levelUp);

    const post = (seat, amount, kind) => {
      const p = this.seats[seat];
      const paid = this.pay(p, amount);
      p.last = { a: p.allIn ? 'allin' : kind, amount: p.bet };
      this.emit({ type: 'blind', seat, kind, amount: paid });
    };
    post(sbSeat, sb, 'sb');
    post(bbSeat, bb, 'bb');

    try {
      if (this.secure) this.emit({ type: 'shuffle', order });
      await h.cards.prepare((phase, step, seat) => {
        if (this.live(h)) this.emit({ type: 'shuffling', phase, step, total: order.length, seat });
      });
      if (!this.live(h)) return false;
      h.stage = 'deal';
      await h.cards.dealHole();
      if (!this.live(h)) return false;
    } catch (err) {
      this.failHand(h, err);
      return false;
    }

    h.stage = 'bet';
    h.dealt = true;
    this.emit({ type: 'deal', order });
    this.pace = 1600 + order.length * 360; // 等发牌动画放完（客户端整体放慢了 1.35 倍）
    // 发牌期间有人离开：补上弃牌
    for (const p of players) if (p.left && !p.folded) { p.folded = true; p.last = { a: 'fold' }; }
    const alive = players.filter((p) => !p.folded);
    if (alive.length === 1) { this.winByFold(alive[0]); return true; }
    const first = headsUp ? sbSeat : this.nextSeat(bbSeat, inHand);
    this.afterAction(this.prevSeat(first)); // 从 first 开始（含）找第一个需要行动的人
    return true;
  }

  prevSeat(seat) {
    const n = this.seats.length;
    return (seat - 1 + n) % n;
  }

  pay(p, amount) {
    amount = Math.max(0, Math.min(amount, p.chips));
    p.chips -= amount;
    p.bet += amount;
    p.total += amount;
    if (p.chips === 0) p.allIn = true;
    return amount;
  }

  canAct(p) { return Boolean(p) && p.inHand && !p.folded && !p.allIn; }

  needsAction(p) {
    if (!this.canAct(p)) return false;
    if (p.bet < this.hand.currentBet) return true;
    if (!p.acted) return this.seats.filter((q) => this.canAct(q)).length > 1;
    return false;
  }

  options(p) {
    const h = this.hand;
    const toCall = Math.max(0, h.currentBet - p.bet);
    const maxTo = p.bet + p.chips;
    const someoneCanRespond = this.seats.some((q) => q !== p && this.canAct(q));
    // 不足额的全下不会重新开放加注权
    const reopened = !p.acted || h.currentBet - p.actedAt >= h.minRaise;
    const canRaise = someoneCanRespond && reopened && maxTo > h.currentBet;
    return {
      toCall: Math.min(toCall, p.chips),
      canCheck: toCall === 0,
      canRaise,
      minTo: Math.min(maxTo, h.currentBet + h.minRaise),
      maxTo,
    };
  }

  setTurn(seat) {
    const h = this.hand;
    const p = this.seats[seat];
    const tt = this.settings.turnTime;
    const pace = this.pace;
    this.pace = 0;
    h.turn = seat;
    h.turnEnds = tt > 0 && !p.bot ? Date.now() + tt * 1000 + pace : null;
    this.emit({ type: 'turn', seat });
    if (this.manual) return;
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    if (p.bot) this.botTimer = setTimeout(() => this.botAct(p), pace + 1000 + random() * 1600);
    else if (!p.connected) this.turnTimer = setTimeout(() => this.timeout(p), pace + 6000);
    else if (tt > 0) this.turnTimer = setTimeout(() => this.timeout(p), pace + tt * 1000 + 1200);
  }

  clearTurn() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    if (this.hand) { this.hand.turn = null; this.hand.turnEnds = null; }
  }

  timeout(p) {
    const h = this.hand;
    if (!h || h.ended || h.turn !== p.seat) return;
    p.timeouts++;
    if (p.timeouts >= 2 || !p.connected) { p.sitOut = true; p.autoAway = true; }
    this.act(p, this.options(p).canCheck ? 'check' : 'fold', 0, true);
  }

  botAct(p) {
    const h = this.hand;
    if (!h || h.ended || h.turn !== p.seat) return;
    let d;
    try { d = botDecide(this, p); } catch { d = null; }
    if (!d || !this.act(p, d.a, d.amount)) this.act(p, this.options(p).canCheck ? 'check' : 'fold');
  }

  /** 处理一次行动；amount 为「加注到」的本轮总下注额。返回是否合法 */
  act(p, a, amount) {
    const h = this.hand;
    if (!h || h.ended || h.turn !== p.seat || !this.canAct(p)) return false;
    const o = this.options(p);
    const before = p.bet;
    let kind;

    if (a === 'fold') {
      p.folded = true;
      kind = 'fold';
    } else if (a === 'check' || (a === 'call' && o.canCheck)) {
      if (!o.canCheck) return false;
      kind = 'check';
    } else if (a === 'call') {
      this.pay(p, o.toCall);
      kind = p.allIn ? 'allin' : 'call';
    } else if (a === 'raise' || a === 'allin') {
      let to = a === 'allin' ? o.maxTo : Math.floor(Number(amount));
      if (!Number.isFinite(to)) return false;
      to = Math.min(to, o.maxTo);
      if (!o.canRaise || to <= h.currentBet) {
        // 无权加注或筹码不够加注：全下只能算跟注
        if (a !== 'allin') return false;
        if (o.canCheck) kind = 'check';
        else { this.pay(p, o.toCall); kind = p.allIn ? 'allin' : 'call'; }
      } else {
        if (to < o.minTo && to !== o.maxTo) return false;
        const raiseBy = to - h.currentBet;
        const opening = h.currentBet === 0;
        this.pay(p, to - p.bet);
        if (raiseBy >= h.minRaise) h.minRaise = raiseBy;
        h.currentBet = to;
        kind = p.allIn ? 'allin' : opening ? 'bet' : 'raise';
      }
    } else {
      return false;
    }

    p.acted = true;
    p.actedAt = h.currentBet;
    p.last = { a: kind, amount: p.bet };
    this.clearTurn();
    this.emit({ type: 'action', seat: p.seat, kind, amount: p.bet, delta: p.bet - before });
    if (kind === 'fold') h.cards?.onFold(p);
    this.afterAction(p.seat);
    return true;
  }

  afterOutOfTurnFold() {
    const h = this.hand;
    const alive = this.seats.filter((p) => p && p.inHand && !p.folded);
    if (alive.length === 1) { this.clearTurn(); return this.winByFold(alive[0]); }
    const cur = h.turn != null ? this.seats[h.turn] : null;
    if (cur && !this.needsAction(cur)) { this.clearTurn(); this.afterAction(cur.seat); }
  }

  afterAction(seat) {
    const alive = this.seats.filter((p) => p && p.inHand && !p.folded);
    if (alive.length === 1) return this.winByFold(alive[0]);
    const next = this.nextSeat(seat, (p) => this.needsAction(p));
    if (next >= 0) return this.setTurn(next);
    this.endRound();
  }

  /** 把没人跟的那部分下注退回 */
  refundUncalled() {
    const ps = this.seats.filter((p) => p && p.inHand && p.bet > 0).sort((a, b) => b.bet - a.bet);
    if (!ps.length || ps[0].folded) return;
    const diff = ps[0].bet - (ps[1]?.bet ?? 0);
    if (diff <= 0) return;
    const p = ps[0];
    p.bet -= diff;
    p.total -= diff;
    p.chips += diff;
    p.allIn = false;
    this.emit({ type: 'refund', seat: p.seat, amount: diff });
  }

  collect() {
    const h = this.hand;
    let sum = 0;
    for (const p of this.seats) if (p && p.inHand) { sum += p.bet; p.bet = 0; }
    if (sum > 0) { h.pot += sum; this.emit({ type: 'collect', pot: h.pot }); }
  }

  async endRound() {
    const h = this.hand;
    this.refundUncalled();
    for (const p of this.seats) {
      if (!p || !p.inHand) continue;
      p.acted = false;
      p.actedAt = 0;
      if (p.last && p.last.a !== 'fold' && p.last.a !== 'allin') p.last = null;
      if (p.last && p.last.a === 'allin' && !p.allIn) p.last = null;
    }
    this.collect();
    h.currentBet = 0;
    h.minRaise = h.blinds[1];
    if (h.street === 'river') return this.showdown();

    try {
      if (this.seats.filter((p) => this.canAct(p)).length <= 1) {
        // 没有人还能下注：先把公共牌发完，再摊牌
        while (h.board.length < 5) {
          await this.dealStreet(h);
          if (!this.live(h)) return;
          h.runout++;
        }
        return this.showdown();
      }
      await this.dealStreet(h);
    } catch (err) {
      return this.failHand(h, err);
    }
    if (!this.live(h)) return;
    this.pace = h.street === 'flop' ? 2600 : 1900; // 等翻牌动画放完
    const first = this.nextSeat(h.dealer, (p) => this.needsAction(p));
    if (first >= 0) this.setTurn(first);
    else this.endRound();
  }

  async dealStreet(h) {
    const street = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
    h.stage = 'reveal';
    const cards = await h.cards.openStreet(street);
    if (!this.live(h)) return;
    h.stage = 'bet';
    h.board.push(...cards);
    h.street = street;
    this.emit({ type: 'board', street, cards });
  }

  winByFold(winner) {
    const h = this.hand;
    this.clearTurn();
    this.refundUncalled();
    this.collect();
    const amount = h.pot;
    winner.chips += amount;
    h.pot = 0;
    h.ended = true;
    h.cards?.cancel();
    this.emit({ type: 'result', showdown: false, hands: [], pots: [{ amount, winners: [{ seat: winner.seat, amount }], name: null }] });
    // 客户端：弃牌动画 → 横幅停顿 → 筹码飞向赢家 → 停一会儿（约 5 秒）
    this.afterHand(5600);
  }

  async showdown() {
    const h = this.hand;
    this.clearTurn();
    h.street = 'showdown';
    h.stage = 'reveal';
    const contenders = this.seats.filter((p) => p && p.inHand && !p.folded);
    let shown;
    try {
      shown = await h.cards.showdown(contenders);
    } catch (err) {
      return this.failHand(h, err);
    }
    if (!this.live(h)) return;

    // 不肯亮牌（超时 / 掉线）的人视为放弃这手牌
    const forfeit = contenders.filter((p) => !shown.has(p.seat));
    for (const p of forfeit) { p.folded = true; p.last = { a: 'fold' }; }
    const live = contenders.filter((p) => shown.has(p.seat));
    if (!live.length) return this.failHand(h, new VoidHand('no_show'));
    for (const p of live) { p.cards = shown.get(p.seat); p.revealed = true; }

    const inHand = this.seats.filter((p) => p && p.inHand);
    const { evals, pots } = settle({
      players: inHand.map((p) => ({ seat: p.seat, total: p.total, folded: p.folded, cards: p.cards })),
      board: h.board, dealer: h.dealer, seats: this.seats.length, pot: h.pot,
    });
    for (const pot of pots) for (const w of pot.winners) this.seats[w.seat].chips += w.amount;
    h.pot = 0;
    h.ended = true;
    h.cards.cancel();
    this.emit({
      type: 'result', showdown: true, pots, forfeit: forfeit.map((p) => p.seat),
      hands: live.map((p) => {
        const ev = evals.get(p.seat);
        return { seat: p.seat, cards: p.cards, name: ev.name, desc: ev.desc, best: ev.best };
      }),
    });
    // 留足结算动画的时间：逐个亮牌（每人约 1.6 秒）、每个底池「高亮 → 横幅 → 筹码飞过去 → 停顿」（约 4.5 秒），
    // 再多留一点余量，免得下一手的事件把结算动画挤成快进
    this.afterHand(2800 + live.length * 1600 + pots.length * 4600 + (h.runout ? 1000 + h.runout * 2300 : 0));
  }

  /**
   * 本手牌无法继续：作废。
   * 没有责任人时，每个人拿回本手投入的全部筹码；
   * 有责任人（拖延、掉线、拒绝配合、作弊）时，他按弃牌处理——本手投入的筹码分给其他参与者，
   * 这样「眼看要输就故意卡住让这手作废」永远不会比直接弃牌更划算。
   */
  failHand(h, err) {
    if (!this.live(h)) return;
    if (!(err instanceof VoidHand)) {
      console.error(`[房间 ${this.code}] 第 ${h.no} 手出错`, err);
      err = new VoidHand('internal');
    }
    if (err.reason === 'cancelled') return;
    this.clearTurn();
    h.cards?.cancel();
    const culprit = err.seat != null ? this.seats[err.seat] : null;
    const players = this.seats.filter((p) => p && p.inHand);
    const others = players.filter((p) => p !== culprit);
    const forfeit = culprit && others.length ? culprit.total : 0;
    const share = others.length ? Math.floor(forfeit / others.length) : 0;
    let odd = forfeit - share * others.length;
    for (const p of players) {
      if (p !== culprit || !forfeit) p.chips += p.total;
      if (p !== culprit && forfeit) p.chips += share + (odd-- > 0 ? 1 : 0);
      p.bet = 0;
      p.total = 0;
      p.allIn = false;
    }
    h.pot = 0;
    h.ended = true;
    h.voided = true;
    if (culprit && !culprit.bot) {
      if (CHEAT_REASONS.has(err.reason)) { culprit.suspect++; culprit.sitOut = true; culprit.autoAway = false; }
      else if (AWAY_REASONS.has(err.reason)) { culprit.sitOut = true; culprit.autoAway = true; }
    }
    console.log(`[房间 ${this.code}] 第 ${h.no} 手作废：${err.reason}${culprit ? `（${culprit.name}，罚没 ${forfeit}）` : ''}`);
    this.emit({ type: 'void', reason: err.reason, seat: culprit ? culprit.seat : null, name: culprit ? culprit.name : null, forfeit });
    this.afterHand(5200);
  }

  afterHand(delay) {
    let changed = false;
    for (const p of this.players()) {
      if (p.left) { this.seats[p.seat] = null; changed = true; continue; }
      if (p.bot && p.chips === 0 && !this.tourney) {
        if (this.settings.allowRebuy) this.rebuy(p);
        else this.removePlayer(p, 'bust');
      }
    }
    if (changed) this.emit({ type: 'sync' });
    if (this.tourney) {
      const busted = this.eliminate();
      if (this.tourney.ended) return;
      // 到点或房主喊停：这一手就是最后一手，直接结算（暂停中也一样）
      if (this.tourney.final) return this.endTourney(this.tourney.final);
      if (busted) delay += 3600; // 留时间播出局 / 进钱圈的字幕
    }
    if (this.manual) return;
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => { this.nextTimer = null; this.startHand(); }, delay);
  }

  // ───────────────────────────── 锦标赛 ─────────────────────────────

  /** 已用时间（毫秒）：只在比赛进行、没有暂停时走 */
  elapsed() {
    const t = this.tourney;
    if (!t) return 0;
    return t.base + (t.since != null ? this.now() - t.since : 0);
  }

  clockRun(on) {
    const t = this.tourney;
    if (!t || t.ended) return;
    if (on && t.since == null) t.since = this.now();
    if (!on && t.since != null) { t.base += this.now() - t.since; t.since = null; }
    this.armClock();
  }

  /** 到时限时提醒自己；顺便每分钟让外层存一次快照，房主刷新后能接着计时 */
  armClock() {
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    const t = this.tourney;
    if (this.manual || !t || t.ended || t.since == null) return;
    const left = t.durationMs - this.elapsed();
    this.clockTimer = setTimeout(() => this.onClock(), Math.min(60000, Math.max(0, left) + 50));
  }

  onClock() {
    const t = this.tourney;
    if (!t || t.ended) return;
    if (this.elapsed() < t.durationMs) {
      this.onEvent?.({ type: 'clock' });
      return this.armClock();
    }
    if (this.hand && !this.hand.ended) {
      // 时间到了：打完这一手再按筹码排名
      if (!t.final) { t.final = 'time'; this.emit({ type: 'final', reason: 'time' }); }
      return;
    }
    this.endTourney('time');
  }

  /** 大厅里按当前人数预览第一级盲注，让顶栏和等待面板显示的数字与开赛后一致 */
  previewBlinds() {
    const { levels } = makeLevels({ players: Math.max(2, this.players().length), startingChips: this.settings.startingChips, minutes: this.settings.minutes });
    [this.settings.sb, this.settings.bb] = levels[0];
  }

  startTourney() {
    const ps = this.players();
    for (const p of ps) Object.assign(p, { chips: this.settings.startingChips, buyIns: 1, out: 0, place: 0 });
    const { levelMs, levels } = makeLevels({ players: ps.length, startingChips: this.settings.startingChips, minutes: this.settings.minutes });
    this.tourney = {
      levelMs, levels, durationMs: this.settings.minutes * 60000,
      base: 0, since: null, level: -1,
      entrants: ps.length, payouts: payoutPlan(ps.length, this.settings.paid),
      out: [], final: null, ended: false, reason: null, standings: null,
    };
    [this.settings.sb, this.settings.bb] = levels[0];
    this.clockRun(!this.paused);
  }

  /** 记下一位出局者的名次 */
  recordOut(p, place, tie = 1) {
    const t = this.tourney;
    p.out = place;
    const rec = { id: p.id, name: p.name, hue: p.hue, bot: p.bot, place, tie, at: Math.round(this.elapsed()), prize: prizeShare(t.payouts, place, tie) };
    t.out.push(rec);
    return { ...rec, seat: p.seat };
  }

  /** 一手结束后：输光的人出局。返回出局人数 */
  eliminate() {
    const t = this.tourney;
    if (!t || t.ended || this.phase !== 'playing') return 0;
    const ps = this.players().filter((p) => !p.out && !p.left);
    const busted = ps.filter((p) => p.chips <= 0);
    const remaining = ps.length - busted.length;
    if (busted.length) {
      const placed = placeBusted(busted.map((p) => ({ p, start: p.handStart ?? 0 })), remaining);
      const list = placed.map(({ p, place, tie }) => this.recordOut(p, place, tie));
      const paid = t.payouts.length;
      this.emit({ type: 'elim', players: list, left: remaining, bubble: ps.length > paid && remaining <= paid && remaining > 1 });
    }
    if (remaining <= 1) this.endTourney('winner');
    return busted.length;
  }

  /** 比赛中途离开或被移出 = 弃权：按当前名次出局，筹码作废 */
  forfeit(p) {
    const t = this.tourney;
    if (!t || t.ended || this.phase !== 'playing' || p.out) return null;
    const ps = this.players().filter((q) => !q.out && !q.left);
    const rec = this.recordOut(p, ps.length, 1);
    const left = ps.length - 1;
    const paid = t.payouts.length;
    this.emit({ type: 'elim', players: [rec], left, forfeit: true, bubble: ps.length > paid && left <= paid && left > 1 });
    return { left };
  }

  endTourney(reason) {
    const t = this.tourney;
    if (!t || t.ended) return;
    this.clockRun(false);
    clearTimeout(this.clockTimer);
    clearTimeout(this.nextTimer);
    this.nextTimer = null;
    const alive = this.players().filter((p) => !p.out && !p.left);
    t.standings = finalStandings(alive.map((p) => ({ id: p.id, name: p.name, hue: p.hue, bot: p.bot, chips: p.chips })), t.out, t.payouts);
    for (const p of this.players()) p.place = t.standings.find((r) => r.id === p.id)?.place || 0;
    t.ended = true;
    t.reason = reason;
    this.phase = 'over';
    this.emit({ type: 'over', reason, standings: t.standings });
  }

  /** 再来一局：同一批人回到大厅，筹码重置 */
  resetLobby() {
    clearTimeout(this.clockTimer);
    this.tourney = null;
    this.phase = 'lobby';
    this.paused = false; // 上一场的暂停不带到新的一场
    this.hand = null;
    this.dealer = -1;
    for (const p of this.players()) {
      Object.assign(p, { chips: this.settings.startingChips, buyIns: 1, out: 0, place: 0, inHand: false, folded: false, allIn: false, bet: 0, total: 0, cards: [], last: null });
    }
    this.previewBlinds();
    this.emit({ type: 'rematch' });
  }

  destroy() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.nextTimer);
    clearTimeout(this.clockTimer);
    this.hand?.cards?.cancel();
    for (const p of this.players()) clearTimeout(p.dropTimer);
  }
}
