// 牵线：借公共的 Nostr 中继和 BitTorrent tracker 交换 WebRTC 连接信息，之后浏览器之间直连。
// 两条路同时走，谁先连上用谁；中继只转发经过房间密码 AES-GCM 加密的握手信息，看不到牌局内容。
// 直连打不通时走 TURN 中转（见 ice.js）。
import { joinRoom as joinNostr, selfId, getRelaySockets as nostrSockets } from '@trystero-p2p/nostr';
import { joinRoom as joinTorrent, getRelaySockets as torrentSockets } from '@trystero-p2p/torrent';
import { STUN_SERVERS, hasTurn } from './ice.js';

const APP_ID = 'holdem-p2p/v1';

// 记下每条 WebRTC 连接：Trystero 只在连通之后才报告对端，「找到人了、正在直连」这一步要自己看
const conns = new Set();
const Tracked = typeof RTCPeerConnection === 'function'
  ? class extends RTCPeerConnection {
    constructor(cfg) {
      super(cfg);
      conns.add(this);
      this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'closed') conns.delete(this); });
    }

    close() {
      conns.delete(this);
      super.close();
    }
  }
  : null;

export class Signal {
  /** ice: { iceServers, relayOnly } —— relayOnly 只走中转，用来测试 TURN */
  constructor(roomId, password, { iceServers = STUN_SERVERS, relayOnly = false } = {}) {
    this.selfId = selfId;
    this.rooms = [];
    this.peers = new Map(); // peerId → 能联系到他的房间序号（按连上的先后）
    this.unreachable = new Set(); // 交换过连接信息、但没能连通的对端
    this.badLink = false; // 有人用别的房间密码进了同一个房间：链接不完整或已失效
    this.turn = hasTurn(iceServers);
    this.onJoin = null;
    this.onLeave = null;
    this.onMessage = null;
    this.onTrouble = null; // (kind, peerId) => void，kind：'unreachable' | 'password'
    const config = {
      appId: APP_ID,
      password,
      rtcConfig: { iceServers, ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}) },
      ...(Tracked ? { rtcPolyfill: Tracked } : {}),
    };
    for (const join of [joinNostr, joinTorrent]) {
      const i = this.rooms.length;
      try {
        const room = join(config, roomId, { onJoinError: (e) => this.joinError(e) });
        const action = room.makeAction('m', { onMessage: (data, ctx) => this.onMessage?.(ctx.peerId, data) });
        room.onPeerJoin = (id) => this.joined(id, i);
        room.onPeerLeave = (id) => this.left(id, i);
        this.rooms.push({ room, action });
      } catch (err) {
        console.warn('牵线方式不可用', err);
        this.rooms.push(null);
      }
    }
  }

  joinError(e) {
    const text = String(e?.error || '');
    const peer = e?.peerId;
    if (/could not connect to peer/.test(text) && peer) {
      if (this.peers.has(peer) || this.unreachable.has(peer)) return;
      this.unreachable.add(peer);
      this.onTrouble?.('unreachable', peer);
    } else if (/incorrect room password/.test(text)) {
      if (this.badLink) return;
      this.badLink = true;
      this.onTrouble?.('password', peer);
    } else {
      console.warn('牵线失败', e);
    }
  }

  joined(id, i) {
    this.unreachable.delete(id);
    let list = this.peers.get(id);
    const fresh = !list;
    if (!list) this.peers.set(id, (list = []));
    if (!list.includes(i)) list.push(i);
    if (fresh) this.onJoin?.(id);
  }

  left(id, i) {
    const list = this.peers.get(id);
    if (!list) return;
    const k = list.indexOf(i);
    if (k >= 0) list.splice(k, 1);
    if (!list.length) {
      this.peers.delete(id);
      this.onLeave?.(id);
    }
  }

  /** 总是走最早连上的那条路，保证同一对浏览器之间的消息有序 */
  send(id, data) {
    const list = this.peers.get(id);
    if (!list || !list.length) return false;
    this.rooms[list[0]].action.send(data, { target: id }).catch(() => {});
    return true;
  }

  peerIds() {
    return [...this.peers.keys()];
  }

  /** 连接诊断：连上了几个中继、有没有正在直连的对端、有没有打不通的对端 */
  status() {
    let relays = 0;
    for (const get of [nostrSockets, torrentSockets]) {
      try {
        for (const ws of Object.values(get() || {})) if (ws?.readyState === 1) relays++;
      } catch { /* 拿不到就当没有 */ }
    }
    const dialing = [...conns].filter((pc) => pc.remoteDescription && ['new', 'connecting'].includes(pc.connectionState)).length;
    return { relays, dialing, peers: this.peers.size, unreachable: this.unreachable.size, badLink: this.badLink, turn: this.turn };
  }

  async close() {
    await Promise.all(this.rooms.map((r) => r && r.room.leave().catch(() => {})));
  }
}
