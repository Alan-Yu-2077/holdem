// 一张牌桌的连接管理：入座、凭令牌重连、观战、限速、快照（浏览器 / Node 通用）。
// 点对点模式下它运行在房主浏览器的后台线程里；每位玩家（包括房主自己）都是一条「连接」。
import { Room } from './room.js';
import { inlinePool } from './inline-pool.js';

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || '玩家';
const SNAPSHOT_VERSION = 1;
// 这些事件之后牌桌有值得保存的变化（clock：锦标赛每分钟记一次已用时间）
const SAVE_ON = new Set(['join', 'leave', 'rebuy', 'settings', 'start', 'result', 'void', 'host', 'pause', 'presence',
  'level', 'elim', 'final', 'over', 'rematch', 'clock']);

export class Table {
  /**
   * code：牌桌标识（参与心理扑克的上下文绑定）
   * invite：邀请链接，进房时告诉每位玩家，方便他们继续邀请
   * snapshot：房主刷新页面后恢复用的快照
   */
  constructor({ code, settings, pool = inlinePool, invite = '', snapshot = null }) {
    this.room = new Room(code, settings, { pool });
    this.invite = invite;
    this.onChange = null; // 牌桌有值得保存的变化时回调（用于持久化快照）
    this.room.onEvent = (ev) => {
      if (SAVE_ON.has(ev.type)) this.onChange?.();
    };
    if (snapshot) this.restore(snapshot);
  }

  /** transport: { send(obj), close(reason) }。返回 { message(msg), closed() } */
  connect(transport) {
    const c = {
      player: null,
      spectator: false,
      bucket: { tokens: 60, at: Date.now(), drops: 0, chatAt: 0 },
      send: (obj) => transport.send(obj),
      detach: () => { c.player = null; },
      close: (reason) => { c.detach(); transport.close(reason); },
    };
    return {
      message: (msg) => {
        try { this.onMessage(c, msg); } catch (err) { console.error('处理消息出错', err); }
      },
      closed: () => this.onClosed(c),
    };
  }

  /** 令牌桶限速：平均每秒 20 条，最多攒 60 条；聊天另有间隔限制。返回是否放行 */
  allow(c, msg) {
    const b = c.bucket;
    const now = Date.now();
    b.tokens = Math.min(60, b.tokens + ((now - b.at) / 1000) * 20);
    b.at = now;
    if (b.tokens < 1) {
      if (++b.drops > 200) c.close('flood');
      return false;
    }
    b.tokens--;
    if (msg.t === 'chat') {
      if (now - b.chatAt < 700) { c.send({ t: 'error', msg: '说话太快了' }); return false; }
      b.chatAt = now;
    }
    return true;
  }

  welcome(c, p) {
    c.player = p;
    c.spectator = !p;
    c.send({ t: 'welcome', code: this.room.code, id: p ? p.id : null, token: p ? p.token : null, spectator: !p, invite: this.invite });
  }

  /** 整体状态 + 当前这手牌的加密记录（以及还欠着他的请求） */
  sendState(c, p) {
    c.send({ t: 'state', state: this.room.view(p) });
    this.room.syncHand(c, p);
  }

  onMessage(c, msg) {
    if (!msg || typeof msg.t !== 'string' || !this.allow(c, msg)) return;
    const room = this.room;
    if (msg.t === 'ping') return c.send({ t: 'pong' });

    if (msg.t === 'join') {
      if (c.player || c.spectator) return;
      let p = room.findByToken(msg.token);
      if (p) {
        this.welcome(c, p);
        room.reconnect(p, c); // 顶掉旧连接，回到原座位
        this.sendState(c, p);
        return;
      }
      p = room.addPlayer({ name: cleanName(msg.name), conn: c });
      if (!p) room.spectators.add(c); // 满座时观战
      this.welcome(c, p);
      this.sendState(c, p);
      return;
    }

    // 观战者在有空位时入座
    if (msg.t === 'sit' && c.spectator && !c.player) {
      const p = room.addPlayer({ name: cleanName(msg.name), conn: c });
      if (!p) return c.send({ t: 'error', msg: room.settings.mode === 'tourney' && room.phase !== 'lobby' ? '比赛进行中，只能观战' : '还没有空位' });
      room.spectators.delete(c);
      this.welcome(c, p);
      this.sendState(c, p);
      return;
    }

    if (c.player) room.handle(c.player, msg);
  }

  onClosed(c) {
    const room = this.room;
    if (c.player) {
      if (c.player.conn === c) room.disconnect(c.player);
    } else {
      room.spectators.delete(c);
    }
    c.player = null;
  }

  // ───────────────────────────── 快照：房主刷新页面后恢复 ─────────────────────────────

  /** 当前牌桌的可恢复状态。进行中的这手牌不保存：恢复时视为作废，各人拿回本手投入 */
  snapshot() {
    const r = this.room;
    const live = r.hand && !r.hand.ended;
    return {
      v: SNAPSHOT_VERSION,
      code: r.code,
      settings: r.settings,
      hostId: r.hostId,
      handNo: r.handNo,
      dealer: r.dealer,
      phase: r.phase,
      paused: r.paused,
      // 锦标赛：记下已用时间；恢复时从这里接着走（房主刷新的那几秒不算）
      tourney: r.tourney && { ...r.tourney, base: Math.round(r.elapsed()), since: null },
      seats: r.seats.map((p) => p && !p.left && {
        id: p.id, token: p.token, name: p.name, seat: p.seat,
        chips: p.chips + (live && p.inHand ? p.total : 0),
        buyIns: p.buyIns, bot: p.bot, hue: p.hue, suspect: p.suspect, sitOut: p.sitOut, style: p.style,
        out: p.out || 0, place: p.place || 0,
      }),
    };
  }

  restore(s) {
    if (!s || s.v !== SNAPSHOT_VERSION) return;
    const r = this.room;
    Object.assign(r, { hostId: s.hostId, handNo: s.handNo, dealer: s.dealer, phase: s.phase, paused: s.paused });
    r.seats = Array(r.settings.maxSeats).fill(null);
    for (const q of s.seats) {
      if (!q || q.seat < 0 || q.seat >= r.seats.length) continue;
      r.seats[q.seat] = {
        ...q, conn: null, connected: Boolean(q.bot), left: false, discAt: Date.now(), dropTimer: null, autoAway: false,
        inHand: false, folded: false, allIn: false, bet: 0, total: 0, cards: [],
        acted: false, actedAt: 0, revealed: false, last: null, timeouts: 0,
      };
    }
    if (s.tourney) {
      r.tourney = { ...s.tourney, since: null };
      if (r.tourney.final === 'time') r.tourney.final = null; // 最后一手作废了，到点检查会重新判断
      if (r.phase === 'playing' && !r.paused) r.clockRun(true);
    }
  }

  destroy() {
    this.room.destroy();
  }
}
