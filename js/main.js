// 入口：主页表单、开桌 / 入座（点对点）、把牌桌事件按顺序播放成动画
import { TableScene } from './scene.js';
import { Hud, fmt, pct, placeName, durText } from './hud.js';
import { MINUTES, makeLevels } from '../shared/engine/tourney.js';
import { Net } from './net.js';
import { HostRuntime, loadHosted } from './p2p/host.js';
import { newIdentity, fingerprint, randomToken, inviteLink, parseInvite } from './p2p/auth.js';
import { iceServers, relayOnly } from './p2p/ice.js';
import { randomInt } from '../shared/mp/random.js';
import { setInstant, finishAll, wait } from './anim.js';
import { sfx } from './sound.js';
import { MentalClient } from './mental.js';
import { Fx } from './fx.js';

const $ = (id) => document.getElementById(id);
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cardText = (c) => (c[0] === 'T' ? '10' : c[0]) + SUIT[c[1]];

const scene = new TableScene($('stage'));
document.body.classList.remove('booting');
const hud = new Hud({
  scene,
  inviteUrl,
  send: (m) => {
    if (m.t === 'action') mental.noteAction();
    net.send(m);
  },
  leave: () => {
    if (hosting) return goHome('牌局已结束'); // 房主离开 = 结束整桌
    mental.beforeLeave(); // 离桌即弃牌：先交出公共牌钥匙，免得这手牌作废
    net.send({ t: 'leave' });
  },
  isHosting: () => Boolean(hosting),
});
const mental = new MentalClient({
  send: (m) => net.send(m),
  warn: (text) => hud.securityWarn(text),
  changed: (H) => onMentalChange(H),
});
const net = new Net({
  message: onMessage,
  online: () => hideOffline(),
  offline: (why) => showOffline(why),
});

// ───────────────────────────── 连接诊断：找不到房主时说清楚卡在哪一步 ─────────────────────────────

let offlineTimer = null;

function showOffline(why) {
  $('offline-text').textContent = why === 'searching' ? '正在寻找房主…' : '与房主的连接断开了，正在重新连接…';
  $('offline').hidden = false;
  clearInterval(offlineTimer);
  const tick = () => { $('offline-detail').textContent = connectHint(net.diagnose()); };
  tick();
  offlineTimer = setInterval(tick, 1000);
}

function hideOffline() {
  clearInterval(offlineTimer);
  offlineTimer = null;
  $('offline').hidden = true;
}

/** d：Net.diagnose() 的结果 */
function connectHint(d) {
  if (!d.ready) return '正在准备连接…';
  if (d.badLink) return '邀请链接不完整或已经失效，请让房主重新发一次';
  if (d.unreachable) {
    return d.turn ? '找到了牌桌，但直连和中转都没连上。换个网络再试试' : '找到了牌桌，但你和房主的网络打不通直连，需要中转服务器（TURN）才能连上';
  }
  if (d.dialing) return '找到了牌桌，正在和房主建立直连…';
  if (d.peers && d.elapsed < 15000) return '已经连上，正在核对房主身份…';
  if (!d.relays) return d.elapsed > 10000 ? '连不上任何公共中继：当前网络可能屏蔽了它们，换个网络试试' : '正在连接公共中继…';
  if (d.elapsed > 20000) return `已连上 ${d.relays} 个公共中继，但一直没有找到房主：请确认房主的页面开着（手机别切到后台），链接是最新的`;
  return `已连上 ${d.relays} 个公共中继，正在寻找房主，通常几秒钟`;
}

// 房主端：有人想加入却连不上时提醒一下（同一阵子只提醒一次）
let troubleAt = 0;
function hostTrouble(kind) {
  if (kind !== 'unreachable' || Date.now() - troubleAt < 20000) return;
  troubleAt = Date.now();
  const text = hosting?.signal?.turn ? '有人想加入，但直连和中转都没连上' : '有人想加入，但你们的网络打不通直连，需要中转服务器（TURN）';
  hud.toast(text, 'err');
  hud.log(text, 'warn');
}
scene.onFrame = () => hud.layout();
const fx = new Fx($('fx'));
const STRONG = new Set(['顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺']);

// 视口适配：手机竖屏时把整个界面旋转 90°，始终以横向布局呈现
function fit() {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  const rot = ih > iw && iw < 700;
  const w = rot ? ih : iw;
  const h = rot ? iw : ih;
  const root = $('app');
  root.style.setProperty('--app-w', `${w}px`);
  root.style.setProperty('--app-h', `${h}px`);
  root.classList.toggle('rot', rot);
  root.classList.toggle('small', w < 860 || h < 520);
  root.classList.toggle('narrow', w < 560);
  root.classList.toggle('short', h < 520);
  scene.setSize(w, h);
}
window.addEventListener('resize', fit);
fit();
window.__poker = { scene, hud, net, mental, fx }; // 方便在控制台里调试
scene.enterHome();

const app = { state: null, code: null, inRoom: false, roomId: null, invite: '' };
let hosting = null; // 我是房主时：自己浏览器里的牌桌

// ───────────────────────────── 主页 ─────────────────────────────

const form = { chips: 2000, bb: 20, seats: 6, time: 30, mode: 'cash', minutes: 120 };

function seg(id, options, key, after) {
  const box = $(id);
  const draw = () => {
    box.replaceChildren(...options().map(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = form[key] === value ? 'on' : '';
      b.onclick = () => { form[key] = value; draw(); after?.(); };
      return b;
    }));
  };
  draw();
  return draw;
}

const drawBlinds = seg('opt-blinds', () => [100, 50, 25].map((deep) => {
  const bb = form.chips / deep;
  return [`${fmt(bb / 2)}/${fmt(bb)}`, bb];
}), 'bb');
seg('opt-chips', () => [1000, 2000, 5000, 10000].map((v) => [fmt(v), v]), 'chips', () => { form.bb = form.chips / 100; drawBlinds(); drawBrief(); });
seg('opt-minutes', () => MINUTES.map((m) => [durText(m), m]), 'minutes', () => drawBrief());
seg('opt-seats', () => [2, 4, 6, 8, 9].map((v) => [`${v} 人`, v]), 'seats', () => drawBrief());
seg('opt-time', () => [['15 秒', 15], ['30 秒', 30], ['60 秒', 60], ['不限', 0]], 'time');

/** 锦标赛的一句话规则：随所选的筹码和时长变化 */
function drawBrief() {
  const { levelMs, levels } = makeLevels({ players: form.seats, startingChips: form.chips, minutes: form.minutes });
  const [sb, bb] = levels[0];
  $('tourney-brief').textContent = `人人 ${fmt(form.chips)} 起步、不能重买，每 ${levelMs / 60000} 分钟升一级盲注（${fmt(sb)}/${fmt(bb)} 起）。`
    + `输光出局；${durText(form.minutes)}到点后按筹码排名，前 2–3 名分奖金。`;
}

const nick = $('nick');
nick.value = localStorage.getItem('poker.name') || '';

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  const join = name === 'join';
  $('tab-create').hidden = join;
  $('tab-join').hidden = !join;
  if (join) return;
  // 常规局和锦标赛共用一张表：锦标赛把「盲注」换成「比赛时长」（盲注按时长自动升级）
  form.mode = name === 'tourney' ? 'tourney' : 'cash';
  const tour = form.mode === 'tourney';
  $('row-blinds').hidden = tour;
  $('row-minutes').hidden = !tour;
  $('tourney-brief').hidden = !tour;
  $('lbl-chips').textContent = tour ? '起始筹码' : '初始筹码';
  $('create-label').textContent = tour ? '开赛' : '开桌';
  if (tour) drawBrief();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);

function myName() {
  const name = nick.value.trim().slice(0, 12);
  if (!name) {
    nick.focus();
    hud.toast('先给自己起个名字吧', 'err');
    return null;
  }
  localStorage.setItem('poker.name', name);
  return name;
}

// 点对点联机需要安全上下文（https 或 localhost）里的 WebCrypto 和 WebRTC
function p2pReady() {
  if (window.isSecureContext && globalThis.crypto?.subtle && window.RTCPeerConnection) return true;
  hud.toast('需要通过 https 或 localhost 打开这个网页才能联机', 'err');
  return false;
}

// 记住在每张牌桌上的座位令牌，刷新或掉线后凭它回到原座位
const TOKENS = 'poker.tokens';
function tokenFor(roomId) {
  try { return JSON.parse(localStorage.getItem(TOKENS))?.[roomId] || null; } catch { return null; }
}
function saveToken(roomId, token) {
  try {
    const all = JSON.parse(localStorage.getItem(TOKENS)) || {};
    all[roomId] = token;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
    localStorage.setItem(TOKENS, JSON.stringify(all));
  } catch { /* 存储不可用 */ }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const shortCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
const pageBase = () => location.origin + location.pathname;

$('btn-create').onclick = () => {
  const name = myName();
  if (!name || !p2pReady()) return;
  sfx.unlock();
  const identity = newIdentity();
  const cfg = { roomId: randomToken(16), password: randomToken(16), identity, fp: fingerprint(identity.pub), code: shortCode() };
  cfg.invite = inviteLink(pageBase(), cfg);
  const bb = form.mode === 'tourney' ? form.chips / 100 : form.bb;
  cfg.settings = { mode: form.mode, startingChips: form.chips, bb, sb: bb / 2, maxSeats: form.seats, turnTime: form.time, minutes: form.minutes };
  startHosting(cfg, name);
};

async function startHosting(cfg, name) {
  const runtime = new HostRuntime(cfg);
  if (!(await runtime.claim())) {
    hud.toast('这张牌桌已经在另一个标签页里打开了', 'err');
    return;
  }
  const ice = { iceServers: await iceServers(), relayOnly: relayOnly() };
  hosting = runtime;
  runtime.onTrouble = hostTrouble;
  runtime.start(ice);
  app.roomId = cfg.roomId;
  history.replaceState(null, '', `#h=${cfg.roomId}`);
  // 房主自己的座位令牌和牌桌状态存在一起，不与（同一浏览器里的）好友令牌混用
  net.local(runtime, () => ({ t: 'join', name, token: runtime.cfg.token || null }));
}

function joinInvite(invite, name) {
  if (!name || !p2pReady()) return;
  sfx.unlock();
  app.roomId = invite.roomId;
  history.replaceState(null, '', `#j=${invite.roomId}.${invite.password}.${invite.fp}`);
  net.guest(invite, () => ({ t: 'join', name, token: tokenFor(invite.roomId) }));
}

$('btn-join').onclick = () => {
  const invite = parseInvite($('invite-input').value);
  if (!invite) return hud.toast('请粘贴好友发来的完整邀请链接', 'err');
  joinInvite(invite, myName());
};
$('invite-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
nick.onkeydown = (e) => { if (e.key === 'Enter') ($('tab-join').hidden ? $('btn-create') : $('btn-join')).click(); };

// 打开带 #j= 的邀请链接：直接进入「加入」；带 #h= 的是房主刷新了页面：恢复牌桌
{
  const invite = parseInvite(location.hash);
  const host = location.hash.match(/^#h=([A-Za-z0-9_-]{16,64})$/);
  if (invite) {
    showTab('join');
    $('invite-input').value = location.href;
    if (nick.value.trim()) joinInvite(invite, nick.value.trim());
    else nick.focus();
  } else if (host) {
    const saved = loadHosted(host[1]);
    if (saved && nick.value.trim() && p2pReady()) startHosting(saved, nick.value.trim());
    else {
      history.replaceState(null, '', location.pathname);
      if (!saved) hud.toast('这张牌桌已经结束了');
    }
  }
}

function inviteUrl() {
  return app.invite || '';
}

// ───────────────────────────── 进出房间 ─────────────────────────────

function goHome(message) {
  net.close();
  if (hosting) {
    hosting.end(); // 通知所有人牌局结束，然后关掉自己浏览器里的牌桌
    hosting = null;
  }
  mental.reset();
  scene.stopShuffle();
  gen++;
  queue.length = 0;
  pendingHard = null;
  finishAll();
  app.state = null;
  app.inRoom = false;
  app.code = null;
  app.roomId = null;
  app.invite = '';
  history.replaceState(null, '', location.pathname);
  hideOffline();
  hud.showTable(false);
  scene.enterHome();
  showTab('create');
  $('invite-input').value = '';
  if (message) hud.toast(message);
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome': {
      app.code = m.code;
      app.inRoom = true;
      app.invite = m.invite || app.invite;
      mental.setIdentity(m.code, m.id);
      const name = nick.value.trim() || '玩家';
      if (m.token && hosting) {
        hosting.cfg.token = m.token;
        hosting.save();
      } else if (m.token && app.roomId) saveToken(app.roomId, m.token);
      net.hello = () => ({ t: 'join', name, token: m.token || null });
      break;
    }
    case 'state':
      m.state.recvAt = performance.now();
      mental.observe(m.state);
      hardSync(m.state);
      break;
    case 'ev':
      m.state.recvAt = performance.now();
      mental.observe(m.state, m.ev);
      queue.push(m);
      if (m.ev.type === 'turn' && m.state.you && m.ev.seat === m.state.you.seat) rushTo(m);
      pump();
      break;
    case 'mp':
      mental.onMessage(m);
      break;
    case 'chat':
      hud.log([{ b: `${m.name}：` }, m.text], 'chat');
      break;
    case 'error':
      hud.toast(m.msg, 'err');
      break;
    case 'left':
      goHome({ kick: '你被房主移出了房间', closed: '房主结束了牌局', timeout: '掉线太久，座位已让出', replaced: '你已在另一个窗口进入这张牌桌', flood: '发送消息过于频繁，已断开' }[m.why]);
      break;
  }
}

// ───────────────────────────── 加密发牌 ─────────────────────────────

const VOID_TEXT = {
  timeout: (n) => `${n} 没有及时完成加密步骤`,
  offline: (n) => `${n} 掉线了`,
  left: (n) => `${n} 中途离开，缺少他的发牌钥匙`,
  lost: (n) => `${n} 的发牌密钥丢失了（换了设备或清除了数据）`,
  bad_step: (n) => `${n} 提交的洗牌数据没有通过验证`,
  bad_key: (n) => `${n} 公布的钥匙与事先的承诺不符`,
  corrupt: (n) => (n ? `审计查出 ${n} 篡改了牌堆` : '牌堆数据异常'),
  false_alarm: (n) => `${n} 谎报牌堆异常`,
  audit_timeout: (n) => `${n} 拒绝配合审计`,
  refused: (n) => `${n} 的浏览器发现加密数据异常，拒绝继续`,
  no_show: () => '摊牌时没有人亮牌',
  internal: () => '牌桌程序出错',
};

function onMentalChange(H) {
  hud.securityChanged(H);
  const st = app.state;
  if (!H || !H.cards || !st || !st.hand || st.hand.no !== H.no || !st.you || pumping || queue.length) return;
  const me = st.seats[st.you.seat];
  if (me && me.hasCards && !me.cards && st.hand.dealt !== false) {
    mental.decorate(st);
    hud.render(st);
    scene.sync(sceneView(st));
  }
}

// ───────────────────────────── 状态同步与事件队列 ─────────────────────────────

const queue = [];
// 只刷新界面、不播动画的事件不算积压（洗牌进度、轮到谁、入座离座……）
const LIGHT = new Set(['shuffle', 'shuffling', 'turn', 'join', 'leave', 'rebuy', 'host', 'start', 'pause', 'sync', 'presence', 'settings', 'final', 'rematch']);
const backlog = () => queue.reduce((n, m) => n + (LIGHT.has(m.ev.type) ? 0 : 1), 0);
let rushTimer = 0;

/** 轮到自己了却还有动画没放完：先让它们正常放一会儿，到时候还没轮到就快进，别占用思考时间 */
function rushTo(m) {
  clearTimeout(rushTimer);
  const n = backlog();
  // 每段动画大约一秒多；积压太多就别等了
  rushTimer = setTimeout(() => { if (queue.includes(m)) setInstant(true); }, n > 6 ? 0 : Math.min(6000, 1500 + n * 1100));
}
let pumping = false;
let gen = 0;
let pendingHard = null;
let idleWaiters = [];

/** 把牌桌状态换算成「以自己为 0 号位」的场景视图 */
function sceneView(st) {
  const n = st.seats.length;
  const me = st.you ? st.you.seat : 0;
  const seats = Array(n).fill(null);
  st.seats.forEach((p, seat) => {
    if (p) seats[(seat - me + n) % n] = { chips: p.chips, bet: p.bet, hasCards: p.hasCards, cards: p.cards };
  });
  const h = st.hand;
  return { hero: Boolean(st.you), seats, board: h ? h.board : [], pot: h ? h.pot : 0, dealer: h ? (h.dealer - me + n) % n : null };
}

/** 整体状态（刚进房间 / 重连）：丢弃排队中的动画，直接摆到位 */
async function hardSync(state) {
  gen++;
  queue.length = 0;
  pendingHard = state;
  setInstant(true);
  if (pumping) await new Promise((r) => idleWaiters.push(r));
  if (pendingHard !== state) return;
  pendingHard = null;
  setInstant(document.hidden);
  const first = !app.state;
  app.state = state;
  if (first) hud.showTable(true);
  scene.enterTable(state.seats.length);
  scene.resetTable();
  hud.clearShowdown();
  mental.decorate(state);
  hud.render(state);
  scene.sync(sceneView(state));
  hud.updateBadge();
  if (state.hand && !state.hand.ended && state.hand.stage === 'shuffle') scene.startShuffle();
  else scene.stopShuffle();
  pump();
}

async function pump() {
  if (pumping || pendingHard) return;
  pumping = true;
  const myGen = gen;
  try {
    while (queue.length && gen === myGen) {
      if (backlog() > 10) setInstant(true); // 落后太多就快进
      const { ev, state } = queue.shift();
      if (!app.state) continue;
      mental.decorate(state);
      try { await play(ev, state); } catch (err) { console.error(err); }
      if (gen !== myGen) break;
      app.state = state;
      scene.sync(sceneView(state));
      if (!queue.length) setInstant(document.hidden);
    }
  } finally {
    pumping = false;
    for (const r of idleWaiters.splice(0)) r();
  }
}

document.addEventListener('visibilitychange', () => setInstant(document.hidden || backlog() > 10));

async function play(ev, st) {
  const n = st.seats.length;
  const me = st.you ? st.you.seat : 0;
  const V = (seat) => (seat - me + n) % n;
  const who = (seat) => ({ b: st.seats[seat]?.name ?? ev.name ?? '玩家' });

  switch (ev.type) {
    case 'hand_start':
      hud.clearShowdown();
      hud.hideBanner();
      hud.setShuffle(null);
      hud.render(st);
      await scene.clearTable();
      await scene.moveButton(V(ev.dealer));
      break;

    case 'shuffle':
      hud.render(st);
      hud.log('所有玩家正在轮流加密洗牌…');
      scene.startShuffle();
      break;

    case 'shuffling':
      hud.setShuffle({ seat: ev.seat, phase: ev.phase, step: ev.step, total: ev.total });
      break;

    case 'void': {
      hud.setShuffle(null);
      await scene.stopShuffle();
      const why = (VOID_TEXT[ev.reason] || (() => ev.reason))(ev.name || '有人');
      const money = ev.forfeit ? `${ev.name} 按弃牌处理，他本手投入的 ${fmt(ev.forfeit)} 分给其他玩家` : '筹码已全部退还';
      hud.banner({ kicker: '作废', who: '本手作废', what: why, amount: ev.forfeit ? '其余已退还' : '已退还', kind: 'void' }, 5000);
      hud.log(['本手作废：', { b: why }, `。${money}`], 'warn');
      hud.render(st);
      await scene.clearTable();
      break;
    }

    case 'blind': {
      hud.render(st);
      const p = st.seats[ev.seat];
      await scene.bet(V(ev.seat), p.bet, p.chips);
      break;
    }

    case 'deal': {
      hud.setShuffle(null);
      await scene.stopShuffle();
      // 加密发牌时服务器不知道我的牌，要等本地解密完成
      let mine = st.you ? st.seats[me].cards : null;
      if (st.you && !mine && st.seats[me]?.hasCards) {
        mine = await mental.myCards(st.hand.no);
        mental.decorate(st);
      }
      hud.render(st);
      await scene.dealHole(ev.order.map(V), mine);
      break;
    }

    case 'turn':
      hud.render(st);
      if (st.you && ev.seat === me) {
        sfx.turn();
        navigator.vibrate?.(20);
      }
      break;

    case 'action': {
      hud.render(st);
      const p = st.seats[ev.seat];
      const amount = { b: fmt(ev.amount) };
      if (ev.kind === 'fold') {
        hud.log([who(ev.seat), ' 弃牌']);
        await scene.fold(V(ev.seat));
      } else if (ev.kind === 'check') {
        hud.log([who(ev.seat), ' 过牌']);
        sfx.check();
        await wait(0.28);
      } else {
        const verb = { call: ' 跟注 ', bet: ' 下注 ', raise: ' 加注到 ', allin: ' 全下 ' }[ev.kind];
        hud.log([who(ev.seat), verb, amount], ev.kind === 'allin' ? 'gold' : '');
        await scene.bet(V(ev.seat), ev.amount, p ? p.chips : 0);
      }
      break;
    }

    case 'refund': {
      hud.render(st);
      const p = st.seats[ev.seat];
      await scene.refund(V(ev.seat), ev.amount, p.bet, p.chips);
      break;
    }

    case 'collect':
      hud.render(st);
      await scene.collect(ev.pot);
      await wait(0.12);
      break;

    case 'reveal':
      hud.render(st);
      await scene.reveal(ev.hands.map((h) => ({ vi: V(h.seat), cards: h.cards, hero: Boolean(st.you) && h.seat === me })));
      await wait(0.4);
      break;

    case 'board':
      // 牌型提示和动态等牌真正翻开以后再更新，别提前剧透
      hud.freezeHint = true;
      try {
        hud.render(st);
        await scene.dealBoard(ev.cards);
      } finally {
        hud.freezeHint = false;
      }
      hud.render(st);
      hud.log([{ flop: '翻牌 ', turn: '转牌 ', river: '河牌 ' }[ev.street], { b: ev.cards.map(cardText).join(' ') }]);
      await wait(0.3);
      break;

    case 'result':
      await playResult(ev, st, V);
      break;

    case 'waiting':
      hud.clearShowdown();
      hud.hideBanner();
      hud.setShuffle(null);
      await scene.stopShuffle();
      hud.render(st);
      await scene.clearTable();
      break;

    case 'join':
      hud.render(st);
      hud.log([who(ev.seat), ' 入座']);
      break;
    case 'leave':
      hud.render(st);
      hud.log([{ b: ev.name }, ev.why === 'kick' ? ' 被移出房间' : ev.why === 'bust' ? ' 输光离场' : ' 离开了牌桌']);
      break;
    case 'rebuy':
      hud.render(st);
      hud.log([{ b: ev.name }, ' 重新买入 ', { b: fmt(st.settings.startingChips) }]);
      break;
    case 'host':
      hud.render(st);
      hud.log([{ b: ev.name }, ' 成为房主']);
      break;
    case 'start': {
      hud.render(st);
      const t = st.tourney;
      if (!t) {
        hud.log('牌局开始，祝好运', 'gold');
        break;
      }
      const [sb, bb] = t.levels[0];
      hud.banner({ kicker: '开赛', who: '锦标赛开始', what: `人人 ${fmt(st.settings.startingChips)} 起步 · 每 ${t.levelMs / 60000} 分钟升盲`, amount: `${fmt(sb)}/${fmt(bb)}`, kind: 'level' }, 4200);
      hud.log(['锦标赛开始：', { b: `${t.entrants} 人` }, `参赛，${durText(t.durationMs / 60000)}，奖励前 ${t.payouts.length} 名。祝好运`], 'gold');
      sfx.win();
      break;
    }

    case 'level': {
      hud.render(st);
      const t = st.tourney;
      const next = t && t.levels[ev.level + 1];
      const last = !t || (ev.level + 1) * t.levelMs >= t.durationMs;
      hud.banner({
        kicker: '升盲', who: `盲注 ${fmt(ev.sb)} / ${fmt(ev.bb)}`,
        what: `第 ${ev.level + 1} 级 · ${last || !next ? '最后一级，到点按筹码排名' : `${t.levelMs / 60000} 分钟后升到 ${fmt(next[0])}/${fmt(next[1])}`}`,
        amount: '', kind: 'level',
      }, 3400);
      hud.log(['盲注升到 ', { b: `${fmt(ev.sb)}/${fmt(ev.bb)}` }, `（第 ${ev.level + 1} 级）`], 'gold');
      sfx.level();
      await wait(1.4);
      break;
    }

    case 'final':
      hud.render(st);
      hud.toast(ev.reason === 'host' ? '房主宣布结束：打完这一手按筹码排名' : '时间到：打完这一手按筹码排名');
      hud.log(ev.reason === 'host' ? '房主宣布提前结束，打完这一手后按筹码排名' : '比赛时间到，打完这一手后按筹码排名', 'warn');
      break;

    case 'elim':
      await playElim(ev, st);
      break;

    case 'over':
      await playOver(ev, st);
      break;

    case 'rematch':
      hud.closeModal();
      hud.clearShowdown();
      hud.render(st);
      await scene.clearTable();
      hud.log('房主开了新的一局，筹码已重置，等待开赛', 'gold');
      break;
    case 'pause':
      hud.render(st);
      hud.log(ev.value ? '房主暂停了发牌' : '房主恢复了发牌');
      break;
    default:
      hud.render(st);
  }
}

async function playResult(ev, st, V) {
  const me = st.you ? st.you.seat : null;
  // 先用「结算前」的筹码数渲染，等筹码飞到位再滚动更新数字
  const mid = structuredClone(app.state);
  mid.recvAt = st.recvAt;
  if (mid.hand) Object.assign(mid.hand, { turn: null, options: null, ended: true, timeLeft: null });
  for (const h of ev.hands) if (mid.seats[h.seat]) mid.seats[h.seat].cards = h.cards;
  hud.render(mid);

  if (ev.showdown) {
    if (me != null && ev.hands.some((h) => h.seat === me)) scene.showHero(); // 摊牌后我的牌已公开，不必再盖着
    // 一个一个亮牌，每人亮完停一下，让大家看清（本来就亮着的牌，比如自己的或全下时已摊开的，只停一小下）
    for (const h of ev.hands) {
      const flipped = await scene.reveal([{ vi: V(h.seat), cards: h.cards, hero: h.seat === me }]);
      hud.showHands([h]);
      await wait(flipped ? 0.6 : 0.25);
    }
    await wait(0.7);
  }

  const running = new Map();
  for (const [i, pot] of ev.pots.entries()) {
    const winners = pot.winners;
    const mine = winners.some((w) => w.seat === me);
    const split = winners.length > 1;
    const lead = ev.showdown ? ev.hands.find((h) => h.seat === winners[0].seat) : null;
    const big = Boolean(lead && STRONG.has(lead.name));
    if (ev.showdown) {
      const best = new Set();
      for (const w of winners) for (const c of ev.hands.find((h) => h.seat === w.seat).best) best.add(c);
      scene.highlight(best);
    }
    hud.markWinners(winners);
    const names = winners.map((w) => st.seats[w.seat]?.name ?? '玩家');
    const kicker = ev.pots.length > 1 ? (i === 0 ? '主池' : `边池`) : split ? '平分' : '赢家';
    hud.banner({
      kicker,
      who: mine ? (split ? '你平分了这个底池' : '你赢了') : names.join(' · '),
      what: pot.name || '其他人都弃牌了',
      amount: `+${fmt(mine ? winners.find((w) => w.seat === me).amount : pot.amount)}`,
      mine,
      big,
    }, i === ev.pots.length - 1 ? 15000 : 4400); // 最后一个底池的横幅一直留到下一手开始
    hud.log([{ b: names.join('、') }, split ? ' 平分 ' : ' 赢得 ', { b: fmt(pot.amount) }, pot.name ? `（${pot.name}）` : ''], 'gold');
    if (mine) {
      sfx.bigWin();
      fx.celebrate(big ? 3 : 2);
      navigator.vibrate?.([30, 40, 30]);
    } else {
      sfx.win();
      if (big) fx.celebrate(1, hud.platePoint(winners[0].seat));
    }
    await wait(1.3);
    await Promise.all(winners.map((w) => {
      const before = running.get(w.seat) ?? mid.seats[w.seat]?.chips ?? 0;
      running.set(w.seat, before + w.amount);
      return scene.award(V(w.seat), w.amount, before + w.amount).then(() => {
        hud.setChips(w.seat, before + w.amount);
        hud.gain(w.seat, w.amount, w.seat === me);
      });
    }));
    await wait(0.9);
  }
  hud.render(st);
}

// ───────────────────────────── 锦标赛：出局、进钱圈、颁奖 ─────────────────────────────

async function playElim(ev, st) {
  hud.render(st);
  const myId = st.you ? st.you.id : null;
  const mine = ev.players.find((x) => x.id === myId);
  for (const x of ev.players) {
    hud.log([{ b: x.name }, ev.forfeit ? ' 弃权出局' : ' 出局', `，${placeName(x.place, x.tie)}`, x.prize ? `，奖金 ${pct(x.prize)}` : ''], x.prize ? 'gold' : '');
  }
  if (mine) {
    hud.banner({
      kicker: '出局', who: mine.prize ? `你获得${placeName(mine.place, mine.tie)}` : '你出局了',
      what: mine.prize ? '进了奖励圈，漂亮！接下来看看谁能夺冠' : `${placeName(mine.place, mine.tie)} · 留下来看看谁能夺冠`,
      amount: mine.prize ? pct(mine.prize) : '', mine: Boolean(mine.prize), kind: mine.prize ? '' : 'elim',
    }, 4200);
    if (mine.prize) { sfx.bigWin(); fx.celebrate(2); }
    navigator.vibrate?.(40);
    await wait(2.6);
  } else if (ev.players.length) {
    const places = [...new Set(ev.players.map((x) => placeName(x.place, x.tie)))];
    const prize = ev.players[0].prize;
    hud.banner({
      kicker: '出局', who: ev.players.map((x) => x.name).join(' · '),
      what: `${places.join(' / ')}${ev.forfeit ? ' · 弃权' : ''} · 还剩 ${ev.left} 人`,
      amount: prize ? pct(prize) : '', kind: prize ? '' : 'elim',
    }, 3600);
    sfx.fold();
    await wait(2.2);
  }
  if (ev.bubble) {
    const t = st.tourney;
    const inMoney = Boolean(st.you && !st.seats[st.you.seat]?.out);
    hud.banner({
      kicker: '钱圈', who: inMoney ? '你进入钱圈了！' : '进入钱圈',
      what: `剩下的 ${ev.left} 人都有奖金`, amount: t ? t.payouts.map((v) => `${v}%`).join(' / ') : '', mine: inMoney, big: true,
    }, 4200);
    hud.log(['泡沫破裂：剩下的 ', { b: `${ev.left} 人` }, ' 都进入了钱圈'], 'gold');
    if (inMoney) { sfx.bigWin(); fx.celebrate(2); navigator.vibrate?.([30, 40, 30]); } else { sfx.win(); fx.celebrate(1); }
    await wait(2.6);
  }
}

async function playOver(ev, st) {
  hud.render(st);
  const rows = ev.standings;
  const champ = rows.find((r) => r.place === 1);
  const mine = st.you ? rows.find((r) => r.id === st.you.id) : null;
  const why = { winner: '最后只剩一人', time: '时间到，按筹码排名', host: '房主提前结束，按筹码排名' }[ev.reason] || '';
  const won = Boolean(mine && mine.prize > 0);
  hud.banner({
    kicker: '冠军', who: mine && mine.place === 1 ? '你夺冠了！' : `${champ ? champ.name : '—'} 夺冠`,
    what: won && mine.place > 1 ? `你获得${placeName(mine.place, mine.tie)} · 奖金 ${pct(mine.prize)}` : why,
    amount: champ ? pct(champ.prize) : '', mine: won, big: true,
  }, 8000);
  for (const r of rows.filter((x) => x.prize > 0)) hud.log([{ b: r.name }, ` ${placeName(r.place, r.tie)}，奖金 `, { b: pct(r.prize) }], 'gold');
  hud.log(`比赛结束（${why}）`, 'gold');
  if (won) {
    sfx.bigWin();
    fx.celebrate(3);
    navigator.vibrate?.([30, 40, 30, 40, 60]);
  } else {
    sfx.win();
    const seat = champ ? st.seats.findIndex((p) => p && p.id === champ.id) : -1;
    fx.celebrate(2, seat >= 0 ? hud.platePoint(seat) : null);
  }
  await wait(3.2);
  await scene.clearTable();
  hud.openResults();
}
