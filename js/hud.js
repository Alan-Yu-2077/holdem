// HUD：叠在 3D 画面上的 DOM 界面 —— 座位名牌、下注/底池标签、操作栏、弹窗、动态栏
import { evaluate } from '../shared/poker.js';
import { MINUTES, makeLevels, payoutPlan } from '../shared/engine/tourney.js';
import { sfx } from './sound.js';

const $ = (id) => document.getElementById(id);
export const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
/** 奖金比例：50% / 12.5% */
export const pct = (v) => `${Math.round(Number(v) * 10) / 10}%`;
const PLACES = ['', '冠军', '亚军', '季军'];
export const placeName = (place, tie = 1) => (tie > 1 ? '并列' : '') + (PLACES[place] || `第 ${place} 名`);
export const durText = (min) => (min >= 60 && min % 30 === 0 ? `${min / 60} 小时` : `${min} 分钟`);
const pad = (v) => String(v).padStart(2, '0');
/** 1:05:09 / 05:09 */
export function hms(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
/** 锦标赛已用时间：服务器给的值 + 收到之后本地走过的时间 */
function elapsedOf(st) {
  const t = st.tourney;
  if (!t) return 0;
  const now = performance.now();
  return Math.min(t.durationMs, t.elapsed + (t.running ? now - (st.recvAt ?? now) : 0));
}
/** 某人在锦标赛里的最终 / 出局记录 */
function recordOf(st, id) {
  const t = st.tourney;
  if (!t) return null;
  return (t.standings || []).find((r) => r.id === id) || t.out.find((r) => r.id === id) || null;
}
const SUIT = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 一排小胶囊选项；选中后回调并刷新弹窗 */
function segBox(options, value, onPick) {
  const box = el('div', 'seg');
  for (const [label, v] of options) {
    const b = el('button', v === value ? 'on' : '', label);
    b.type = 'button';
    b.onclick = () => onPick(v);
    box.append(b);
  }
  return box;
}

/** 开关行 */
function switchRow(label, checked, onChange) {
  const row = el('label', 'switch');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.onchange = () => onChange(box.checked);
  row.append(el('span', '', label), box);
  return row;
}

/** 名单里的小圆点 + 名字 */
function nameCell(p, me) {
  const td = el('td');
  const dot = el('span', 'dot');
  dot.style.setProperty('--h', p.hue ?? 40);
  td.append(dot, document.createTextNode(p.name));
  if (me) td.append(el('small', 'you', '你'));
  return td;
}

function statusOf(p, st, winAmount, busy) {
  if (winAmount) return ['win', `+${fmt(winAmount)}`];
  if (busy) return ['shuffle', busy];
  // 锦标赛：出局的人挂着名次，比赛结束后人人挂上最终名次
  const place = st.phase === 'over' ? p.place : p.out;
  if (st.tourney && place) {
    const r = recordOf(st, p.id);
    return [r && r.prize > 0 ? (st.phase === 'over' ? 'win' : 'prize') : 'place', placeName(place, r?.tie)];
  }
  const a = st.hand && p.inHand && p.last ? p.last.a : null;
  if (a === 'fold') return ['fold', '弃牌'];
  if (a === 'allin') return ['allin', `全下 ${fmt(p.last.amount)}`];
  if (a === 'check') return ['check', '过牌'];
  if (a === 'call') return ['call', `跟注 ${fmt(p.last.amount)}`];
  if (a === 'bet') return ['bet', `下注 ${fmt(p.last.amount)}`];
  if (a === 'raise') return ['raise', `加注到 ${fmt(p.last.amount)}`];
  if (a === 'sb') return ['blind', `小盲 ${fmt(p.last.amount)}`];
  if (a === 'bb') return ['blind', `大盲 ${fmt(p.last.amount)}`];
  if (!p.connected && !p.bot) return ['away', '离线'];
  if (p.sitOut) return ['away', '暂离'];
  if (p.chips === 0 && !p.inHand && st.phase === 'playing') return ['away', '出局'];
  return ['', ''];
}

export class Hud {
  constructor({ scene, send, inviteUrl, leave, isHosting = () => false }) {
    this.scene = scene;
    this.send = send;
    this.inviteUrl = inviteUrl;
    this.leave = leave;
    this.isHosting = isHosting;
    this.st = null;
    this.n = 0;
    this.plates = [];
    this.betLabels = [];
    this.winners = new Map(); // seat → 赢得金额
    this.shown = new Map(); // seat → { cards, name }
    this.turn = null;
    this.actKey = null;
    this.sentKey = null;
    this.opt = null;
    this.raiseTo = 0;
    this.tmp = {};
    this.lastTick = 0;
    this.shuffle = null; // 正在加密洗牌：{ seat, phase, step, total }
    this.warnings = []; // 本地核验发现的异常
    this.secH = null; // 当前这手的加密核验进度
    this.cover = (() => { try { return localStorage.getItem('poker.cover') === '1'; } catch { return false; } })();
    this.peeking = false;

    this.potLabel = el('div');
    this.potLabel.id = 'pot-label';
    $('labels').append(this.potLabel);

    this.bind();
  }

  // ───────────────────────────── 事件绑定 ─────────────────────────────

  bind() {
    $('btn-code').onclick = () => this.copyInvite();
    $('btn-copy').onclick = () => this.copyInvite();
    $('btn-invite').onclick = () => this.openInvite();
    $('btn-score').onclick = () => this.openScore();
    $('btn-settings').onclick = () => this.openSettings();
    $('btn-leave').onclick = () => this.openLeave();
    $('btn-addbot').onclick = () => this.send({ t: 'addBot' });
    $('btn-start').onclick = () => this.send({ t: 'start' });
    $('btn-secure').onclick = () => this.openSecurity();
    $('btn-cover').onclick = () => this.setCover(!this.cover);
    this.setCover(this.cover);
    const peek = $('peek-btn');
    peek.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { peek.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
      this.setPeek(true);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) peek.addEventListener(t, () => this.setPeek(false));
    peek.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'v') this.setPeek(false); });
    window.addEventListener('blur', () => this.setPeek(false));
    const soundBtn = $('btn-sound');
    soundBtn.classList.toggle('off', !sfx.enabled);
    soundBtn.onclick = () => {
      sfx.setEnabled(!sfx.enabled);
      soundBtn.classList.toggle('off', !sfx.enabled);
    };

    $('act-fold').onclick = () => this.act('fold');
    $('act-call').onclick = () => this.act('call');
    $('act-raise').onclick = () => this.act('raise');
    $('raise-range').oninput = (e) => this.setRaise(Number(e.target.value));
    $('raise-minus').onclick = () => this.setRaise(this.raiseTo - this.opt.bb);
    $('raise-plus').onclick = () => this.setRaise(this.raiseTo + this.opt.bb);
    const input = $('raise-input');
    input.oninput = () => { input.value = input.value.replace(/[^\d]/g, ''); };
    input.onchange = () => this.setRaise(Number(input.value) || 0);
    input.onkeydown = (e) => { if (e.key === 'Enter') { input.blur(); this.setRaise(Number(input.value) || 0); } };

    $('chat-form').onsubmit = (e) => {
      e.preventDefault();
      const box = $('chat-input');
      const text = box.value.trim();
      if (text) this.send({ t: 'chat', text });
      box.value = '';
      box.blur();
    };

    $('modal').addEventListener('pointerdown', (e) => { if (e.target === $('modal')) this.closeModal(); });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return this.closeModal();
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('modal').hidden) return;
      if (e.key.toLowerCase() === 'v' && !e.repeat) return this.setPeek(true);
      if (e.key === 'Enter' && !$('table').hidden && !$('actions').classList.contains('show')) {
        e.preventDefault();
        return $('chat-input').focus();
      }
      if (!$('actions').classList.contains('show')) return;
      const k = e.key.toLowerCase();
      if (k === 'f') this.act('fold');
      else if (k === 'c' || k === ' ') { e.preventDefault(); this.act('call'); }
      else if (k === 'r' || k === 'enter') this.act('raise');
      else if (k === 'arrowup' || k === 'arrowright') this.setRaise(this.raiseTo + this.opt.bb);
      else if (k === 'arrowdown' || k === 'arrowleft') this.setRaise(this.raiseTo - this.opt.bb);
    });
  }

  // ───────────────────────────── 结构 ─────────────────────────────

  build(n) {
    this.n = n;
    $('plates').replaceChildren();
    for (const l of this.betLabels) l.remove();
    this.plates = [];
    this.betLabels = [];
    for (let v = 0; v < n; v++) {
      const root = el('div', 'plate empty');
      const vacant = el('span', 'vacant', '空位');
      const avatar = el('div', 'avatar');
      const initial = el('span');
      avatar.append(initial, el('i', 'ring'));
      const meta = el('div', 'meta');
      const name = el('div', 'name');
      const stack = el('div', 'stack');
      meta.append(name, stack);
      const status = el('div', 'status');
      status.hidden = true;
      const marks = el('div', 'marks');
      const reveal = el('div', 'reveal');
      reveal.hidden = true;
      const timer = el('i', 'timer');
      root.append(vacant, avatar, meta, status, marks, reveal, timer);
      $('plates').append(root);
      this.plates.push({ root, avatar, initial, name, stack, status, marks, reveal, key: {} });
      const bet = el('div', 'bet-label');
      $('labels').append(bet);
      this.betLabels.push(bet);
    }
  }

  showTable(on) {
    $('table').hidden = !on;
    $('home').classList.toggle('out', on);
    if (!on) {
      this.st = null;
      this.turn = null;
      this.winners.clear();
      this.shown.clear();
      $('actions').classList.remove('show');
      $('feed-list').replaceChildren();
      this.closeModal();
      this.shuffle = null;
      this.warnings = [];
      this.secH = null;
      this.updateBadge();
    }
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  render(st) {
    this.st = st;
    const n = st.seats.length;
    if (n !== this.n) this.build(n);
    const mySeat = st.you ? st.you.seat : 0;
    const me = st.you ? st.seats[st.you.seat] : null;
    const h = st.hand;
    const live = Boolean(h && !h.ended);
    const isHost = Boolean(st.you && st.you.id === st.hostId);
    const seated = st.seats.filter(Boolean);

    // 顶栏
    $('room-code').textContent = st.code;
    const t = st.tourney;
    const tour = st.settings.mode === 'tourney';
    const blinds = `${fmt(st.settings.sb)}/${fmt(st.settings.bb)}`;
    $('room-blinds').textContent = t ? `第 ${Math.max(0, t.level) + 1} 级 · ${blinds}` : tour ? `锦标赛 · ${blinds} 起` : `盲注 ${blinds}`;
    if (t && st.phase === 'playing') {
      this.clockKey = null;
      this.tickClock();
    } else {
      $('room-clock').hidden = true;
      $('room-hand').textContent = t ? `${t.entrants} 人参赛` : h ? `第 ${h.no} 手` : `${seated.length}/${n} 人`;
    }
    const status = st.phase === 'over' ? '比赛结束' : st.paused ? '已暂停' : st.phase === 'playing' && !h ? '等待更多玩家…' : '';
    $('room-status').hidden = !status;
    $('room-status').textContent = status;
    $('btn-settings').hidden = !isHost;

    // 名牌与下注标签
    for (let v = 0; v < n; v++) {
      const seat = (v + mySeat) % n;
      this.renderPlate(this.plates[v], st.seats[seat], st, seat);
      const p = st.seats[seat];
      const label = this.betLabels[v];
      const on = Boolean(p && p.bet > 0);
      if (on) label.textContent = fmt(p.bet);
      label.classList.toggle('on', on);
    }

    // 底池
    const potOn = Boolean(h && h.total > 0);
    if (potOn) this.potLabel.replaceChildren(el('span', '', '底池'), document.createTextNode(fmt(h.total)));
    this.potLabel.classList.toggle('on', potOn);

    // 等待面板
    const lobby = st.phase === 'lobby';
    $('waiting').hidden = !lobby;
    if (lobby) {
      $('waiting-code').textContent = st.code;
      const link = $('invite-link');
      const url = this.inviteUrl();
      if (link.value !== url) link.value = url;
      $('waiting-title').textContent = tour ? '锦标赛 · 等待报名' : '牌桌已开 · 等待入座';
      $('waiting-tourney').hidden = !tour;
      if (tour) this.renderLobbyTourney(st, isHost, seated.length);
      $('waiting-hint').textContent = tour
        ? `${seated.length}/${n} 人已报名` + (isHost ? ' · 好友打开链接即可报名，开赛后就不能再加入了' : ' · 等待房主开赛')
        : `${seated.length}/${n} 人已入座` + (isHost ? ' · 好友打开链接即可加入，也可以先加几个机器人试玩' : ' · 等待房主开始游戏');
      $('btn-start').textContent = tour ? '开始比赛' : '开始游戏';
      $('waiting-actions').hidden = !isHost;
      $('btn-start').disabled = seated.length < 2;
      $('btn-addbot').disabled = seated.length >= n;
    }

    // 轮到谁
    if (live && h.turn != null) {
      const v = (h.turn - mySeat + n) % n;
      const key = `${h.no}:${h.street}:${h.turn}:${h.currentBet}`;
      if (!this.turn || this.turn.key !== key) {
        this.turn = { key, v, total: h.turnTime, ends: h.timeLeft != null ? (st.recvAt ?? performance.now()) + h.timeLeft : null };
      }
    } else {
      this.turn = null;
    }

    // 操作栏
    const myTurn = live && me && h.turn === me.seat && h.options;
    if (myTurn) {
      const key = `${h.no}:${h.street}:${h.currentBet}:${me.bet}`;
      if (key !== this.actKey) {
        this.actKey = key;
        this.sentKey = null;
        this.setupActions(st, me, h);
      }
      $('actions').classList.toggle('show', this.sentKey !== key);
    } else {
      this.actKey = null;
      $('actions').classList.remove('show');
    }

    // 底部提示：出局 / 暂离 / 观战
    let notice = null;
    if (!st.you) {
      if (tour && st.phase !== 'lobby') notice = [st.phase === 'over' ? '比赛已经结束' : '比赛进行中，你正在观战', '赛况', () => this.openScore()];
      else notice = st.seats.some((s) => !s)
        ? ['你正在观战，现在有空位', '入座', () => this.send({ t: 'sit', name: localStorage.getItem('poker.name') || '玩家' })]
        : ['座位已满，你正在观战'];
    }
    else if (st.phase === 'over') {
      const r = recordOf(st, me.id);
      const text = r ? `比赛结束 · 你获得${placeName(r.place, r.tie)}${r.prize ? `（${pct(r.prize)}）` : ''}` : '比赛结束';
      notice = isHost ? [text, '再来一局', () => this.send({ t: 'rematch' })] : [`${text} · 等房主再开一局`, '名次', () => this.openResults()];
    }
    else if (st.phase === 'playing' && me.out) {
      const r = recordOf(st, me.id);
      notice = [`你获得${placeName(me.out, r?.tie)}${r?.prize ? `（${pct(r.prize)}）` : ''}，正在观战`, '赛况', () => this.openScore()];
    }
    else if (st.phase === 'playing' && me.chips === 0 && !(live && me.inHand)) {
      notice = st.settings.allowRebuy ? ['筹码输光了', `重新买入 ${fmt(st.settings.startingChips)}`, () => this.send({ t: 'rebuy' })] : ['你已出局，正在观战'];
    } else if (me.sitOut) notice = [t ? '你已暂离：不发牌，但轮到的盲注照扣' : '你已暂离，不会参与发牌', '回到牌桌', () => this.send({ t: 'sitout', value: false })];
    else if (live && !me.inHand) notice = ['本手已开始，下一手自动加入'];
    $('notice').hidden = !notice;
    if (notice) {
      $('notice-text').textContent = notice[0];
      $('notice-btn').hidden = !notice[1];
      $('notice-btn').textContent = notice[1] || '';
      $('notice-btn').onclick = notice[2] || null;
    }

    // 自己当前的牌型（盖牌模式下只在按住看牌时显示）
    const hint = $('hand-hint');
    const holding = Boolean(me && me.cards && h && !me.folded);
    if (holding && !this.freezeHint) {
      const ev = evaluate([...me.cards, ...h.board]);
      hint.textContent = ev.desc;
      // 公共牌让我的牌型升级：闪一下并给一个提示音
      const last = this.myHand;
      if (last && last.no === h.no && ev.cat > last.cat && h.board.length > last.board) {
        hint.classList.remove('up');
        void hint.offsetWidth;
        hint.classList.add('up');
        if (!this.cover || this.peeking) sfx.rise();
      }
      this.myHand = { no: h.no, cat: ev.cat, board: h.board.length };
    }
    hint.hidden = !holding || (this.cover && !this.peeking);
    $('peek-btn').hidden = !(holding && this.cover && live);

    // 加密洗牌进度
    const cs = $('crypto-status');
    const sh = live && h.stage === 'shuffle' ? this.shuffle : null;
    cs.hidden = !sh;
    if (sh) {
      const who = st.seats[sh.seat]?.name ?? '';
      const step = (sh.phase === 'L' ? sh.total : 0) + sh.step + 1;
      cs.textContent = `加密洗牌 ${step}/${sh.total * 2} · ${who}`;
    }

    if (!$('modal').hidden && this.modalRefresh) this.modalRefresh();
  }

  renderPlate(pl, p, st, seat) {
    if (!p) {
      pl.root.className = 'plate empty' + (st.phase !== 'lobby' ? ' gone' : '');
      pl.key = {};
      return;
    }
    const h = st.hand;
    const live = Boolean(h && !h.ended);
    const cls = ['plate'];
    if (st.you && p.id === st.you.id) cls.push('me');
    if (live && h.turn === seat) cls.push('active');
    if (this.winners.has(seat)) cls.push('winner');
    const idle = st.phase === 'playing' && h && !p.inHand;
    // 比赛结束：拿到奖金的人亮起来，其余的暗下去
    if (st.phase === 'over' && st.tourney) cls.push((recordOf(st, p.id)?.prize || 0) > 0 ? 'winner' : 'out');
    else if (p.folded || idle || p.sitOut || p.out) cls.push('out');
    pl.root.className = cls.join(' ');

    pl.avatar.style.setProperty('--h', p.hue);
    pl.initial.textContent = [...p.name][0] || '?';
    pl.name.textContent = p.name;
    if (pl.key.chips !== p.chips) {
      const from = pl.key.chips;
      pl.key.chips = p.chips;
      this.roll(pl.stack, from, p.chips);
    }

    const h0 = st.hand;
    const busy = h0 && !h0.ended && h0.stage === 'shuffle' && this.shuffle && this.shuffle.seat === seat ? (this.shuffle.phase === 'S' ? '洗牌中' : '上锁中') : null;
    const [kind, text] = statusOf(p, st, this.winners.get(seat), busy);
    const sKey = `${kind}|${text}`;
    if (pl.key.status !== sKey) {
      pl.key.status = sKey;
      pl.status.hidden = !text;
      pl.status.className = `status ${kind}`;
      pl.status.textContent = text;
      pl.status.style.animation = 'none';
      void pl.status.offsetWidth;
      pl.status.style.animation = '';
    }

    const marks = [];
    if (h && h.dealer === seat) marks.push(['d', 'D']);
    if (h && h.sb === seat) marks.push(['', 'SB']);
    if (h && h.bb === seat) marks.push(['', 'BB']);
    if (p.id === st.hostId) marks.push(['host', '房主']);
    if (p.bot) marks.push(['', 'BOT']);
    if (p.suspect) marks.push(['sus', '⚠ 数据异常']);
    const mKey = marks.map((m) => m[1]).join();
    if (pl.key.marks !== mKey) {
      pl.key.marks = mKey;
      pl.marks.replaceChildren(...marks.map(([c, t]) => el('span', `mark ${c}`, t)));
    }

    const shown = st.you && seat === st.you.seat ? null : this.shown.get(seat); // 自己的牌就摆在面前，不必重复
    const rKey = shown ? shown.cards.join() + shown.name : '';
    if (pl.key.reveal !== rKey) {
      pl.key.reveal = rKey;
      pl.reveal.hidden = !shown;
      if (shown) {
        const cards = el('div', 'mini-cards');
        for (const c of shown.cards) {
          const mc = el('div', 'mini-card' + (c[1] === 'h' || c[1] === 'd' ? ' red' : ''));
          mc.append(document.createTextNode(c[0] === 'T' ? '10' : c[0]), el('i', '', SUIT[c[1]]));
          cards.append(mc);
        }
        pl.reveal.replaceChildren(cards, el('div', 'hand-name', shown.name));
      }
    }
  }

  plateOf(seat) {
    if (!this.st) return null;
    const mySeat = this.st.you ? this.st.you.seat : 0;
    return this.plates[(seat - mySeat + this.n) % this.n] || null;
  }

  setChips(seat, chips) {
    const pl = this.plateOf(seat);
    if (!pl) return;
    const from = pl.key.chips;
    pl.key.chips = chips;
    this.roll(pl.stack, from, chips);
  }

  /** 筹码数字滚动到新值；增加时短暂高亮 */
  roll(elm, from, to) {
    cancelAnimationFrame(elm.rollId);
    if (from == null || from === to || document.hidden) {
      elm.textContent = fmt(to);
      return;
    }
    const t0 = performance.now();
    const dur = Math.min(1400, 600 + Math.abs(to - from) * 0.4);
    elm.classList.toggle('up', to > from);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      elm.textContent = fmt(from + (to - from) * e);
      if (k < 1) elm.rollId = requestAnimationFrame(step);
      else setTimeout(() => elm.classList.remove('up'), 900);
    };
    elm.rollId = requestAnimationFrame(step);
  }

  /** 某个座位名牌在屏幕上的位置 */
  platePoint(seat) {
    if (!this.st) return null;
    const v = (seat - (this.st.you ? this.st.you.seat : 0) + this.n) % this.n;
    const s = this.scene.spots[v];
    return s ? this.scene.project(s.plate, {}) : null;
  }

  /** 名牌上方飘起「+数额」 */
  gain(seat, amount, mine = false) {
    const v = this.plateOf(seat) ? (seat - (this.st.you ? this.st.you.seat : 0) + this.n) % this.n : -1;
    const s = this.scene.spots[v];
    if (!s) return;
    const t = this.scene.project(s.plate, {});
    const g = el('div', `gain${mine ? ' mine' : ''}`, `+${fmt(amount)}`);
    g.style.transform = `translate(${t.x.toFixed(1)}px, ${(t.y - 34).toFixed(1)}px) translate(-50%, -50%)`;
    $('labels').append(g);
    setTimeout(() => g.remove(), 2800);
  }

  /** 摊牌：在名牌下方显示底牌和牌型 */
  showHands(hands) {
    for (const h of hands) this.shown.set(h.seat, { cards: h.cards, name: h.desc });
    if (this.st) this.render(this.st);
  }

  markWinners(list) {
    this.winners.clear();
    for (const w of list) this.winners.set(w.seat, w.amount);
    if (this.st) this.render(this.st);
  }

  clearShowdown() {
    this.winners.clear();
    this.shown.clear();
    $('banner').classList.remove('on');
  }

  // ───────────────────────────── 盖牌（防窥屏） ─────────────────────────────

  setCover(on) {
    this.cover = on;
    try { localStorage.setItem('poker.cover', on ? '1' : '0'); } catch { /* 无痕模式 */ }
    $('btn-cover').classList.toggle('on', on);
    $('btn-cover').title = on ? '盖牌模式：已开启（按住「看牌」或 V 键查看底牌）' : '盖牌模式：关闭（点击开启，防止被窥屏）';
    this.scene.setCover(on);
    if (!on) this.setPeek(false);
    if (this.st) this.render(this.st);
  }

  setPeek(on) {
    on = Boolean(on && this.cover);
    if (this.peeking === on) return;
    this.peeking = on;
    $('peek-btn').classList.toggle('on', on);
    this.scene.setPeek(on);
    if (this.st) this.render(this.st);
  }

  // ───────────────────────────── 加密发牌状态 ─────────────────────────────

  setShuffle(info) {
    this.shuffle = info;
    if (this.st) this.render(this.st);
    this.updateBadge();
  }

  securityWarn(text) {
    this.warnings.push({ text, at: new Date() });
    if (this.warnings.length > 30) this.warnings.shift();
    this.toast(`安全警告：${text}`, 'err');
    this.log(`⚠ ${text}`, 'warn');
    this.updateBadge();
    if (!$('modal').hidden && this.modalRefresh) this.modalRefresh();
  }

  securityChanged(H) {
    this.secH = H;
    this.updateBadge();
    if (!$('modal').hidden && this.modalRefresh && this.modalTitle === '牌局安全') this.modalRefresh();
  }

  updateBadge() {
    const b = $('btn-secure');
    const st = this.st;
    const off = st && st.secure === false;
    const bad = this.warnings.length > 0;
    b.classList.toggle('warn', bad || off);
    b.classList.toggle('ok', !bad && !off);
    b.title = off ? '本房间没有开启加密发牌' : bad ? `发现 ${this.warnings.length} 条安全异常，点击查看` : '加密发牌已开启：任何人（包括房主）都看不到你的底牌';
  }

  openSecurity() {
    this.openModal('牌局安全', (body) => {
      const st = this.st;
      const H = this.secH;
      const rows = [];
      const row = (ok, text) => {
        const r = el('div', `sec-row ${ok === true ? 'ok' : ok === false ? 'bad' : 'wait'}`);
        r.append(el('i', '', ok === true ? '✓' : ok === false ? '✕' : '…'), el('span', '', text));
        rows.push(r);
      };
      if (st && st.secure === false) row(false, '本房间没有开启加密发牌，房主理论上能看到所有人的牌');
      else row(true, '加密发牌已开启：每位玩家的浏览器都参与洗牌加密（心理扑克 · P-256 椭圆曲线）');
      const head = el('h3', '', H ? `第 ${H.no} 手` : '本手');
      if (H) {
        const names = H.parts.map((x) => st?.seats[x.seat]?.name ?? '?').join('、');
        row(true, `${H.n} 位参与者轮流洗牌、上锁：${names}`);
        row(H.checked === H.n ? true : null, `洗牌零知识证明：${H.checked}/${H.n} 已在你的浏览器里验证通过`);
        row(H.keysChecked ? true : null, `公开的钥匙：${H.keysChecked} 组与事先承诺一致`);
        if (H.j >= 0) row(H.cards ? true : null, H.cards ? '你的底牌：已在你的浏览器里解密（房主和其他人都不知道）' : '你的底牌：等待其他人交出钥匙…');
        else row(null, '你没有参与这手牌');
        if (H.problems.length) for (const t of H.problems) row(false, t);
      } else {
        row(null, '还没有开始发牌');
      }
      const list = el('div', 'sec-list');
      list.append(...rows.slice(0, 1), head, ...rows.slice(1));
      const parts = [list];
      if (this.warnings.length) {
        parts.push(el('h3', '', '异常记录'));
        const w = el('div', 'sec-list');
        for (const x of this.warnings.slice().reverse()) {
          const r = el('div', 'sec-row bad');
          r.append(el('i', '', '✕'), el('span', '', `${x.at.toLocaleTimeString()}  ${x.text}`));
          w.append(r);
        }
        parts.push(w);
      }
      parts.push(el('p', 'modal-note', '牌桌由房主的浏览器主持，但它看不到任何人的底牌：你的浏览器会独立核验每一步洗牌证明和每一把钥匙，发现异常就停止交钥匙并在这里提示，这手牌随后作废、筹码退还。'
        + '只有当规则允许时才会交出钥匙（例如你在这一轮行动之前，不会交出下一张公共牌的钥匙；公共牌没全部翻开前，绝不交出你底牌的钥匙）。'
        + '注意：机器人的密钥由房主的浏览器代管，所以房主能看到机器人的牌。'));
      body.replaceChildren(...parts);
    });
  }

  // ───────────────────────────── 每帧：把 DOM 贴到 3D 位置上 ─────────────────────────────

  layout() {
    const st = this.st;
    if (!st || !this.scene.spots.length || this.scene.spots.length !== this.n) return;
    const { w, h } = this.scene;
    const t = this.tmp;
    const small = w < 860 || h < 520;
    const mx = small ? 58 : 74;
    const actionsUp = w < 560 && $('actions').classList.contains('show');
    const top = small ? 56 : 78;
    const actions = $('actions');
    const bar = actions.classList.contains('show') && w >= 560 ? { left: actions.offsetLeft, top: actions.offsetTop } : this.lastBar;
    if (actions.classList.contains('show')) this.lastBar = bar;
    for (let v = 0; v < this.n; v++) {
      const s = this.scene.spots[v];
      this.scene.project(s.plate, t);
      let x = clamp(t.x, mx, w - mx);
      let y = clamp(t.y, top, h - (small ? 26 : 34));
      if (v === 0 && actionsUp) y = Math.min(y, h - $('actions').offsetHeight - 40);
      // 操作栏弹出时，被它挡住的名牌平滑地让开
      const pl = this.plates[v];
      let blocked = actions.classList.contains('show') && w >= 560 && bar && x > bar.left - mx && y > bar.top - 30;
      // 自己的名牌在正下方，上面紧挨着底牌和牌型提示：能往左挪开就往左挪，不往上顶
      let slide = 0;
      if (blocked && v === 0) {
        const room = bar.left - 14 - pl.root.offsetWidth / 2;
        if (room >= mx) { slide = Math.max(0, x - room); blocked = false; }
      }
      pl.slide = (pl.slide || 0) + (slide - (pl.slide || 0)) * 0.2;
      if (pl.slide > 0.1) x -= pl.slide;
      pl.lift = (pl.lift || 0) + ((blocked ? 1 : 0) - (pl.lift || 0)) * 0.2;
      if (pl.lift > 0.002) y -= pl.lift * Math.max(0, y - (bar ? bar.top - 36 : y));
      this.plates[v].root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      this.scene.project(s.betLabel, t);
      this.betLabels[v].style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    this.scene.project(this.scene.potAnchor, t);
    this.potLabel.style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -50%)`;
    const shownHole = Boolean(this.scene.spots[0].hole?.shown);
    if (!$('hand-hint').hidden) {
      // 等自己的牌翻开后再显示牌型
      $('hand-hint').style.opacity = shownHole ? 1 : 0;
      this.scene.project(this.scene.heroHintAnchor, t);
      $('hand-hint').style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    if (!$('peek-btn').hidden) {
      $('peek-btn').style.opacity = shownHole ? 1 : 0;
      this.scene.project(this.scene.peekAnchor, t);
      $('peek-btn').style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    if (!$('crypto-status').hidden) {
      this.scene.project(this.scene.deckAnchor, t);
      $('crypto-status').style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -50%)`;
    }

    this.tickClock();

    // 倒计时
    const turn = this.turn;
    if (turn) {
      const now = performance.now();
      const p = turn.ends ? clamp((turn.ends - now) / turn.total, 0, 1) : 1;
      const root = this.plates[turn.v].root;
      root.style.setProperty('--p', p.toFixed(3));
      root.classList.toggle('low', p < 0.25);
      const mine = $('actions').classList.contains('show');
      if (mine) {
        const fill = $('turn-bar-fill');
        fill.style.transform = `scaleX(${p.toFixed(3)})`;
        fill.classList.toggle('low', p < 0.25);
        const left = turn.ends ? (turn.ends - now) / 1000 : 99;
        const tl = $('turn-left');
        tl.textContent = turn.ends ? `${Math.max(0, Math.ceil(left))}s` : '不限时';
        tl.classList.toggle('low', p < 0.25);
        if (left < 5.2 && left > 0 && now - this.lastTick > 1000) {
          this.lastTick = now;
          sfx.tick();
        }
      }
    }
  }

  // ───────────────────────────── 操作栏 ─────────────────────────────

  setupActions(st, me, h) {
    const o = h.options;
    this.opt = { ...o, pot: h.total, cur: h.currentBet, bb: st.settings.bb, sb: st.settings.sb, chips: me.chips };
    $('act-call-label').textContent = o.canCheck ? '过牌' : o.toCall >= me.chips ? `全下 ${fmt(o.toCall)}` : `跟注 ${fmt(o.toCall)}`;
    $('raise-box').classList.toggle('off', !o.canRaise);
    $('act-raise').disabled = !o.canRaise;
    if (!o.canRaise) {
      $('act-raise-label').textContent = '加注';
      $('act-raise').classList.remove('allin');
      return;
    }
    const range = $('raise-range');
    range.min = o.minTo;
    range.max = o.maxTo;
    range.step = 1;
    range.disabled = o.minTo >= o.maxTo;
    const q = this.opt;
    const pot = (f) => q.cur + (q.pot + q.toCall) * f; // 先跟注，再按跟注后的底池比例加注
    const presets = [['最小', o.minTo], ['½ 池', pot(0.5)], ['¾ 池', pot(0.75)], ['满池', pot(1)], ['全下', o.maxTo]];
    $('presets').replaceChildren(...presets.map(([label, value]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.onclick = () => this.setRaise(value);
      return b;
    }));
    this.setRaise(o.minTo);
  }

  setRaise(v) {
    const o = this.opt;
    if (!o || !o.canRaise) return;
    v = clamp(Math.round(v), o.minTo, o.maxTo);
    if (v !== o.minTo && v !== o.maxTo) v = clamp(Math.round(v / o.sb) * o.sb, o.minTo, o.maxTo);
    this.raiseTo = v;
    const range = $('raise-range');
    range.value = v;
    range.style.setProperty('--fill', `${o.maxTo > o.minTo ? ((v - o.minTo) / (o.maxTo - o.minTo)) * 100 : 100}%`);
    $('raise-input').value = v;
    const allin = v >= o.maxTo;
    $('act-raise-label').textContent = allin ? `全下 ${fmt(v)}` : `${o.cur === 0 ? '下注' : '加注到'} ${fmt(v)}`;
    $('act-raise').classList.toggle('allin', allin);
  }

  act(kind) {
    if (!this.actKey || this.sentKey === this.actKey || !this.opt) return;
    const o = this.opt;
    if (kind === 'raise') {
      if (!o.canRaise) return;
      this.send(this.raiseTo >= o.maxTo ? { t: 'action', a: 'allin' } : { t: 'action', a: 'raise', amount: this.raiseTo });
    } else {
      this.send({ t: 'action', a: kind });
    }
    const key = (this.sentKey = this.actKey);
    $('actions').classList.remove('show');
    // 服务器若没有接受（极少见），稍后把操作栏放回来
    setTimeout(() => {
      if (this.sentKey === key && this.actKey === key) {
        this.sentKey = null;
        $('actions').classList.add('show');
      }
    }, 2500);
  }

  // ───────────────────────────── 横幅 / 提示 / 动态 ─────────────────────────────

  /** 结算横幅：{ kicker, who, what, amount, mine, big, kind } */
  banner({ kicker = '', who = '', what = '', amount = '', mine = false, big = false, kind = '' }, ms = 3600) {
    const b = $('banner');
    const band = el('div', 'band');
    const mid = el('div');
    mid.append(el('div', 'who', who), el('div', 'what', what));
    band.append(el('div', 'kicker', kicker), mid, el('div', 'amount', amount));
    b.replaceChildren(band);
    b.className = [mine && 'mine', big && 'big', kind].filter(Boolean).join(' ');
    void b.offsetWidth;
    b.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.remove('on'), ms);
  }

  hideBanner() {
    clearTimeout(this.bannerTimer);
    $('banner').classList.remove('on');
  }

  toast(text, kind = '') {
    const t = el('div', `toast ${kind}`, text);
    $('toasts').append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3100);
  }

  /** parts: 字符串或 { b: '加粗文字' } */
  log(parts, cls = '') {
    const line = el('div', `feed-line ${cls}`);
    for (const part of [].concat(parts)) line.append(typeof part === 'string' ? document.createTextNode(part) : el('b', '', part.b));
    const list = $('feed-list');
    list.append(line);
    while (list.children.length > 9) list.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 9000);
  }

  async copyInvite() {
    const url = this.inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      this.toast('邀请链接已复制');
    } catch {
      const input = $('invite-link');
      input.value = url;
      input.select();
      this.toast('请手动复制链接');
    }
  }

  // ───────────────────────────── 弹窗 ─────────────────────────────

  openModal(title, build) {
    const card = $('modal-card');
    const head = el('h2');
    const close = el('button', '', '✕');
    close.onclick = () => this.closeModal();
    head.append(document.createTextNode(title), close);
    const body = el('div');
    card.replaceChildren(head, body);
    this.modalTitle = title;
    this.modalRefresh = () => build(body);
    this.modalRefresh();
    $('modal').hidden = false;
  }

  closeModal() {
    $('modal').hidden = true;
    this.modalRefresh = null;
  }

  openInvite() {
    this.openModal('邀请好友', (body) => {
      if (body.childElementCount) return;
      const row = el('div', 'invite-row');
      const input = el('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = this.inviteUrl();
      const btn = el('button', 'btn primary', '复制');
      btn.onclick = () => this.copyInvite();
      row.append(input, btn);
      const note = el('p', 'modal-note', '把链接发给好友，浏览器打开就能入座。链接里带着这张牌桌的通行密钥和房主身份指纹，只发给你想邀请的人。'
        + (this.isHosting() ? '你是房主：牌桌运行在你的浏览器里，请保持这个页面开着（可以切到别的标签页，但别关掉或让手机锁屏）。' : ''));
      body.append(row, note);
    });
  }

  openScore() {
    if (this.st && this.st.settings.mode === 'tourney') return this.openStandings();
    this.openModal('积分榜', (body) => {
      const st = this.st;
      const rows = st.seats.filter(Boolean).map((p) => ({ p, net: p.chips + p.bet - p.buyIns * st.settings.startingChips }))
        .sort((a, b) => b.net - a.net);
      const table = el('table', 'score');
      const head = el('tr');
      for (const t of ['玩家', '筹码', '买入', '盈亏']) head.append(el('th', '', t));
      table.append(head);
      for (const { p, net } of rows) {
        const tr = el('tr');
        const name = el('td');
        const dot = el('span', 'dot');
        dot.style.setProperty('--h', p.hue);
        name.append(dot, document.createTextNode(p.name));
        tr.append(name, el('td', '', fmt(p.chips + p.bet)), el('td', '', `${p.buyIns} 次`), el('td', net > 0 ? 'pos' : net < 0 ? 'neg' : '', (net > 0 ? '+' : '') + fmt(net)));
        table.append(tr);
      }
      body.replaceChildren(table);
    });
  }

  openLeave() {
    const host = this.isHosting();
    const st = this.st;
    const me = st && st.you ? st.seats[st.you.seat] : null;
    const tour = Boolean(st && st.tourney && st.phase === 'playing');
    const forfeit = tour && me && !me.out;
    this.openModal(host ? (tour ? '结束比赛？' : '结束牌局？') : forfeit ? '弃权离开？' : '离开房间？', (body) => {
      if (body.childElementCount) return;
      const note = el('p', 'modal-note', host
        ? `你是房主，牌桌运行在你的浏览器里。离开会结束整${tour ? '场比赛' : '桌牌局'}，所有人都会回到首页。`
        : forfeit ? '比赛进行中离开算弃权：按当前名次出局，筹码作废，之后不能再回来参赛。只是暂时走开的话，用「暂离」就好——座位保留，盲注照扣。'
          : '离开后座位会空出来。如果正在一手牌中，会自动弃牌。');
      const foot = el('div', 'modal-foot');
      const cancel = el('button', 'btn', '再玩一会儿');
      cancel.onclick = () => this.closeModal();
      const ok = el('button', 'btn danger', host ? (tour ? '结束比赛' : '结束牌局') : forfeit ? '弃权离开' : '离开');
      ok.onclick = () => { this.closeModal(); this.leave(); };
      foot.append(cancel, ok);
      body.append(note, foot);
    });
  }

  openSettings() {
    if (this.st && this.st.settings.mode === 'tourney') return this.openTourneySettings();
    let draft = null;
    this.openModal('房间设置', (body) => {
      const st = this.st;
      if (!draft) draft = { ...st.settings };
      const seg = (options, value, onPick) => {
        const box = el('div', 'seg');
        for (const [label, v] of options) {
          const b = el('button', v === value ? 'on' : '', label);
          b.type = 'button';
          b.onclick = () => { onPick(v); this.modalRefresh(); };
          box.append(b);
        }
        return box;
      };
      const bbs = [...new Set([draft.bb, st.settings.bb, 10, 20, 50, 100, 200, 400, 1000].filter((b) => b <= draft.startingChips))].sort((a, b) => a - b).slice(0, 7);

      const h1 = el('h3', '', '盲注（下一手生效）');
      const blinds = seg(bbs.map((b) => [`${fmt(Math.max(1, Math.floor(b / 2)))}/${fmt(b)}`, b]), draft.bb, (v) => { draft.bb = v; draft.sb = Math.max(1, Math.floor(v / 2)); });
      const h2 = el('h3', '', '思考时间');
      const time = seg([['15 秒', 15], ['30 秒', 30], ['60 秒', 60], ['不限', 0]], draft.turnTime, (v) => { draft.turnTime = v; });

      const sw = (label, checked, onChange) => {
        const row = el('label', 'switch');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.onchange = () => onChange(box.checked);
        row.append(el('span', '', label), box);
        return row;
      };
      const rebuy = sw('允许输光后重新买入', draft.allowRebuy, (v) => { draft.allowRebuy = v; });
      const pause = sw('暂停发牌（打完当前这手后生效）', st.paused, (v) => this.send({ t: 'pause', value: v }));

      const h3 = el('h3', '', '玩家');
      const members = el('div');
      for (const p of st.seats.filter(Boolean)) {
        const row = el('div', 'member');
        const name = el('span', 'grow', p.name);
        if (p.bot) name.append(el('small', '', '机器人'));
        if (p.id === st.hostId) name.append(el('small', '', '房主'));
        row.append(name);
        if (p.id !== st.you.id) {
          const kick = el('button', 'btn small danger', '移出');
          kick.onclick = () => this.send({ t: 'kick', id: p.id });
          row.append(kick);
        }
        members.append(row);
      }
      const foot = el('div', 'modal-foot');
      const addBot = el('button', 'btn', '＋ 机器人');
      addBot.disabled = st.seats.every(Boolean);
      addBot.onclick = () => this.send({ t: 'addBot' });
      const save = el('button', 'btn primary', '保存设置');
      save.onclick = () => {
        this.send({ t: 'settings', settings: draft });
        this.closeModal();
        this.toast('设置已保存');
      };
      foot.append(addBot, save);
      body.replaceChildren(h1, blinds, h2, time, rebuy, pause, h3, members, foot);
    });
  }
  // ───────────────────────────── 锦标赛 ─────────────────────────────

  /** 顶栏：距下次升盲 / 最后一手，以及在场人数和剩余时间（每帧调用，只在文字变化时改 DOM） */
  tickClock() {
    const st = this.st;
    const t = st && st.tourney;
    const clock = $('room-clock');
    if (!t || st.phase !== 'playing') {
      if (!clock.hidden) clock.hidden = true;
      return;
    }
    const elapsed = elapsedOf(st);
    let text;
    let cls = '';
    if (t.final || elapsed >= t.durationMs) {
      text = '最后一手';
      cls = 'final';
    } else {
      const nextAt = (Math.max(0, t.level) + 1) * t.levelMs;
      const left = Math.min(nextAt, t.durationMs) - elapsed;
      // 最后一级：下一级要到时限之后，不会再升盲了，改为倒数到结束
      text = nextAt >= t.durationMs ? `距结束 ${hms(left)}` : left > 0 ? `升盲 ${hms(left)}` : '下一手升盲';
      if (left < 60000) cls = 'soon';
      if (!t.running) { text = `暂停 · ${text}`; cls = 'paused'; }
    }
    const alive = st.seats.filter((p) => p && !p.out).length;
    const rest = `${alive}/${t.entrants} 人 · 剩余 ${hms(t.durationMs - elapsed)}`;
    const key = `${text}|${cls}|${rest}`;
    if (key === this.clockKey) return;
    this.clockKey = key;
    clock.hidden = false;
    clock.textContent = text;
    clock.className = `chip-tag clock ${cls}`;
    $('room-hand').textContent = rest;
  }

  /** 等待面板里的赛制与奖励（报名人数变化时跟着变） */
  renderLobbyTourney(st, isHost, count) {
    const s = st.settings;
    const entrants = Math.max(2, count);
    const key = [s.startingChips, s.minutes, s.paid, entrants, isHost].join();
    if (this.lobbyKey === key) return;
    this.lobbyKey = key;
    const { levelMs, levels } = makeLevels({ players: entrants, startingChips: s.startingChips, minutes: s.minutes });
    const fact = (k, v) => {
      const x = el('span', 'fact');
      x.append(el('i', '', k), el('b', '', v));
      return x;
    };
    const more = el('button', 'link', '盲注结构 ›');
    more.type = 'button';
    more.onclick = () => this.openScore();
    $('wt-facts').replaceChildren(fact('起始', fmt(s.startingChips)), fact('时长', durText(s.minutes)), fact('升盲', `每 ${levelMs / 60000} 分钟`),
      fact('起步', `${fmt(levels[0][0])}/${fmt(levels[0][1])}`), more);
    const prizes = el('div', 'prizes');
    payoutPlan(entrants, s.paid).forEach((v, i) => {
      const x = el('span', 'prize');
      x.append(el('i', '', placeName(i + 1)), el('b', '', `${v}%`));
      prizes.append(x);
    });
    const parts = [el('span', 'wt-label', '奖励'), prizes];
    if (isHost) parts.push(segBox([['自动', 0], ['前 2 名', 2], ['前 3 名', 3]], s.paid, (v) => this.send({ t: 'settings', settings: { ...s, paid: v } })));
    $('wt-pay').replaceChildren(...parts);
  }

  /** 赛况：概况、奖励、名次、盲注结构（开赛前是预览） */
  openStandings() {
    this.openModal('赛况', (body) => {
      const st = this.st;
      if (!st) return;
      const s = st.settings;
      const t = st.tourney;
      const seated = st.seats.filter(Boolean);
      const entrants = t ? t.entrants : Math.max(2, seated.length);
      const plan = t || {
        ...makeLevels({ players: entrants, startingChips: s.startingChips, minutes: s.minutes }),
        durationMs: s.minutes * 60000, level: -1, payouts: payoutPlan(entrants, s.paid), out: [],
      };
      const elapsed = elapsedOf(st);
      const lvl = Math.max(0, plan.level);
      const cur = plan.levels[lvl];
      const nxt = plan.levels[lvl + 1];
      const alive = seated.filter((p) => !p.out);
      const inPlay = t ? alive.reduce((sum, p) => sum + p.chips + (p.inHand ? p.total : 0), 0) : entrants * s.startingChips;
      const paid = plan.payouts.length;

      const stat = (k, v, sub) => {
        const x = el('div', 'tstat');
        x.append(el('i', '', k), el('b', '', v), el('small', '', sub));
        return x;
      };
      const left = (lvl + 1) * plan.levelMs - elapsed;
      const last = t && (lvl + 1) * plan.levelMs >= plan.durationMs;
      const stats = el('div', 'tstats');
      stats.append(
        stat('级别', t ? `第 ${lvl + 1} 级` : '开赛前', `${fmt(cur[0])}/${fmt(cur[1])}`),
        stat('下一级', nxt && !last ? `${fmt(nxt[0])}/${fmt(nxt[1])}` : '—', !t ? `每 ${plan.levelMs / 60000} 分钟` : t.ended ? '已结束' : t.final ? '最后一手' : last ? '已是最后一级' : left > 0 ? `${hms(left)} 后` : '下一手生效'),
        stat('在场', `${t && !t.ended ? alive.length : entrants}/${entrants}`, `均码 ${fmt(inPlay / Math.max(1, t && !t.ended ? alive.length : entrants))}`),
        stat('用时', hms(elapsed), `共 ${durText(plan.durationMs / 60000)}`),
      );

      const prizes = el('div', 'prizes wide');
      plan.payouts.forEach((v, i) => {
        const x = el('span', 'prize');
        x.append(el('i', '', placeName(i + 1)), el('b', '', `${v}%`));
        prizes.append(x);
      });

      // 名次：结束后是最终名次；进行中在场的人按筹码暂排，出局的人按名次
      const table = el('table', 'score standings');
      const head = el('tr');
      for (const h of ['名次', '玩家', '筹码', '奖金']) head.append(el('th', '', h));
      table.append(head);
      const meId = st.you ? st.you.id : null;
      let rows;
      if (t && t.standings) rows = t.standings.map((r) => ({ ...r, final: true }));
      else {
        const stack = (p) => p.chips + (p.inHand ? p.total : 0);
        const live = alive.slice().sort((a, b) => stack(b) - stack(a));
        rows = live.map((p) => ({ id: p.id, name: p.name, hue: p.hue, chips: stack(p), place: 1 + live.filter((q) => stack(q) > stack(p)).length, live: true }));
        rows.push(...plan.out.slice().sort((a, b) => a.place - b.place));
      }
      for (const r of rows) {
        const tr = el('tr', [r.prize > 0 ? 'itm' : '', r.live && alive.length <= paid && t ? 'itm' : '', !r.live && !r.final ? 'gone' : ''].filter(Boolean).join(' '));
        tr.append(
          el('td', 'rank', r.live ? (t ? String(r.place) : '—') : placeName(r.place, r.tie)),
          nameCell(r, r.id === meId),
          el('td', '', r.chips != null ? fmt(r.chips) : `出局 ${hms(r.at || 0)}`),
          el('td', r.prize > 0 ? 'pos' : '', r.prize > 0 ? pct(r.prize) : '—'),
        );
        table.append(tr);
      }
      if (!rows.length) {
        const tr = el('tr');
        const td = el('td', 'empty', '还没有人报名');
        td.colSpan = 4;
        tr.append(td);
        table.append(tr);
      }

      // 盲注结构：只列到时限之内的级别
      const levels = el('table', 'score levels');
      const lh = el('tr');
      for (const h of ['级别', '盲注', '开始于']) lh.append(el('th', '', h));
      levels.append(lh);
      const levelMin = plan.levelMs / 60000;
      plan.levels.forEach(([sb, bb], i) => {
        if (i * plan.levelMs >= plan.durationMs) return;
        const tr = el('tr', t && i === lvl ? 'cur' : t && i < lvl ? 'past' : '');
        const m = i * levelMin;
        tr.append(el('td', '', `第 ${i + 1} 级`), el('td', '', `${fmt(sb)}/${fmt(bb)}`), el('td', '', `${Math.floor(m / 60)}:${pad(m % 60)}`));
        levels.append(tr);
      });

      body.replaceChildren(
        stats,
        el('h3', '', `奖励 · 前 ${paid} 名`), prizes,
        el('h3', '', t && t.ended ? '最终名次' : t ? '名次（在场的人按筹码暂排）' : '已报名'), table,
        el('h3', '', '盲注结构'), levels,
        el('p', 'modal-note', '人人同样的起始筹码，不能重买；盲注按时间升级，到点后从下一手开始生效。输光出局，按出局先后排名，同一手出局的，这手开始时筹码多的名次靠前。'
          + '暂离或掉线的人不发牌，但轮到的盲注照扣；中途离开算弃权。到了时限打完当前这手，剩下的人按筹码排名。奖金比例只是记分，钱由大家在线下结算。'),
      );
    });
  }

  /** 比赛结果：领奖台 + 完整名次 */
  openResults() {
    this.openModal('比赛结果', (body) => {
      const st = this.st;
      const t = st && st.tourney;
      if (!t || !t.standings) {
        body.replaceChildren(el('p', 'modal-note', '比赛还没有结束。'));
        return;
      }
      const meId = st.you ? st.you.id : null;
      const why = { winner: '最后只剩一人', time: '时间到，按筹码排名', host: '房主提前结束，按筹码排名' }[t.reason] || '';
      const sub = el('p', 'result-sub', `${t.entrants} 人参赛 · 用时 ${hms(t.elapsed)} · ${why}`);
      const winners = t.standings.filter((x) => x.prize > 0);
      const podium = el('div', `podium${winners.map((r) => r.place).join() === '1,2,3' ? ' classic' : ''}`);
      for (const r of winners) {
        const step = el('div', `pod p${Math.min(3, r.place)}${r.id === meId ? ' me' : ''}`);
        const av = el('div', 'avatar');
        av.style.setProperty('--h', r.hue ?? 40);
        av.append(el('span', '', [...r.name][0] || '?'));
        step.append(av, el('div', 'pname', r.name), el('div', 'pplace', placeName(r.place, r.tie)), el('div', 'pprize', pct(r.prize)));
        podium.append(step);
      }
      const rest = el('div', 'result-rest');
      for (const r of t.standings.filter((x) => !(x.prize > 0))) {
        const row = el('div', `rrow${r.id === meId ? ' me' : ''}`);
        row.append(el('span', 'rplace', placeName(r.place, r.tie)), el('span', 'rname', r.name));
        rest.append(row);
      }
      const parts = [sub, podium];
      if (rest.childElementCount) parts.push(rest);
      parts.push(el('p', 'modal-note', '奖金按上面的比例分配，钱由大家在线下结算。'));
      const foot = el('div', 'modal-foot');
      const close = el('button', 'btn', '关闭');
      close.onclick = () => this.closeModal();
      foot.append(close);
      if (st.you && st.you.id === st.hostId && st.phase === 'over') {
        const again = el('button', 'btn primary', '再来一局');
        again.onclick = () => { this.closeModal(); this.send({ t: 'rematch' }); };
        foot.append(again);
      }
      parts.push(foot);
      body.replaceChildren(...parts);
    });
  }

  /** 房主的比赛设置：开赛前可改时长 / 奖励 / 起始筹码；开赛后只能改思考时间、暂停、提前结束、移出 */
  openTourneySettings() {
    let draft = null;
    let confirmEnd = false;
    this.openModal('比赛设置', (body) => {
      const st = this.st;
      if (!draft) draft = { ...st.settings };
      const lobby = st.phase === 'lobby';
      const pick = (key, after) => (v) => { draft[key] = v; after?.(v); this.modalRefresh(); };
      const parts = [];
      if (lobby) {
        parts.push(el('h3', '', '比赛时长'), segBox(MINUTES.map((m) => [durText(m), m]), draft.minutes, pick('minutes')));
        parts.push(el('h3', '', '起始筹码'), segBox([1000, 2000, 5000, 10000].map((v) => [fmt(v), v]), draft.startingChips, pick('startingChips', (v) => { draft.bb = v / 100; draft.sb = v / 200; })));
        parts.push(el('h3', '', '奖励名额'), segBox([['自动', 0], ['前 2 名', 2], ['前 3 名', 3]], draft.paid, pick('paid')));
      }
      parts.push(el('h3', '', '思考时间'), segBox([['15 秒', 15], ['30 秒', 30], ['60 秒', 60], ['不限', 0]], draft.turnTime, pick('turnTime')));
      if (st.phase === 'playing') parts.push(switchRow('暂停（计时立即停下，打完当前这手后不再发牌）', st.paused, (v) => this.send({ t: 'pause', value: v })));

      parts.push(el('h3', '', '玩家'));
      const members = el('div');
      for (const p of st.seats.filter(Boolean)) {
        const row = el('div', 'member');
        const name = el('span', 'grow', p.name);
        if (p.bot) name.append(el('small', '', '机器人'));
        if (p.id === st.hostId) name.append(el('small', '', '房主'));
        if (p.out) name.append(el('small', '', placeName(p.out)));
        row.append(name);
        if (p.id !== st.you.id && !(st.phase === 'playing' && p.out)) {
          const kick = el('button', 'btn small danger', st.phase === 'playing' ? '取消资格' : '移出');
          kick.title = st.phase === 'playing' ? '按当前名次出局，筹码作废' : '';
          kick.onclick = () => this.send({ t: 'kick', id: p.id });
          row.append(kick);
        }
        members.append(row);
      }
      parts.push(members);

      const foot = el('div', 'modal-foot');
      if (lobby) {
        const addBot = el('button', 'btn', '＋ 机器人');
        addBot.disabled = st.seats.every(Boolean);
        addBot.onclick = () => this.send({ t: 'addBot' });
        foot.append(addBot);
      }
      if (st.phase === 'playing') {
        const end = el('button', 'btn danger', confirmEnd ? '确定结束？' : '提前结束');
        end.title = '打完当前这手，剩下的人按筹码排名';
        end.onclick = () => {
          if (!confirmEnd) { confirmEnd = true; this.modalRefresh(); return; }
          this.send({ t: 'finish' });
          this.closeModal();
        };
        foot.append(end);
      }
      const save = el('button', 'btn primary', '保存设置');
      save.onclick = () => {
        this.send({ t: 'settings', settings: draft });
        this.closeModal();
        this.toast('设置已保存');
      };
      foot.append(save);
      parts.push(foot);
      body.replaceChildren(...parts);
    });
  }
}
