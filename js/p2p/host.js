// 房主端：在自己浏览器里开一张「牌桌服务器」（后台线程），通过公共中继牵线，接受好友直连。
import { Signal } from './signal.js';
import { sign } from './auth.js';

const STORE = 'poker.host';
export const LOCAL = 'local';

/** 读回本机正在主持的牌桌（房主刷新页面后恢复用） */
export function loadHosted(roomId) {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    return s && s.roomId === roomId ? s : null;
  } catch {
    return null;
  }
}

export class HostRuntime {
  /** cfg: { roomId, password, identity, fp, code, invite, settings, snapshot? } */
  constructor(cfg) {
    this.cfg = cfg;
    this.snapshot = cfg.snapshot || null;
    this.guests = new Set();
    this.localHandler = null;
    this.wakeLock = null;
    this.releaseLock = null;
    this.onTrouble = null; // (kind, peerId) => void：有人想加入却连不上，见 Signal
  }

  /** 同一张牌桌只能在一个标签页里主持，否则会出现两个房主 */
  async claim() {
    if (!navigator.locks) return true;
    return new Promise((resolve) => {
      navigator.locks.request(`holdem-host-${this.cfg.roomId}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((release) => { this.releaseLock = release; });
      });
    });
  }

  /** ice：{ iceServers, relayOnly }，见 ice.js */
  start(ice) {
    const { cfg } = this;
    this.worker = new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.fromWorker(data);
    this.worker.onerror = (e) => console.error('牌桌线程出错', e);
    this.worker.postMessage({ type: 'init', code: cfg.code, settings: cfg.settings, invite: cfg.invite, snapshot: this.snapshot });

    this.signal = new Signal(cfg.roomId, cfg.password, ice);
    this.signal.onTrouble = (kind, peer) => this.onTrouble?.(kind, peer);
    this.signal.onMessage = (peer, data) => this.fromPeer(peer, data);
    this.signal.onLeave = (peer) => {
      if (this.guests.delete(peer)) this.worker.postMessage({ type: 'gone', id: peer });
    };

    this.save();
    this.keepAwake();
    this.onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', this.onUnload);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.keepAwake(); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  fromWorker(d) {
    if (d.type === 'send') {
      if (d.id === LOCAL) this.localHandler?.(d.msg);
      else this.signal.send(d.id, { g: d.msg });
    } else if (d.type === 'close') {
      if (d.id === LOCAL) return;
      if (d.reason) this.signal.send(d.id, { g: { t: 'left', why: d.reason } });
      this.guests.delete(d.id);
    } else if (d.type === 'snapshot') {
      this.snapshot = d.snapshot;
      this.save();
    } else if (d.type === 'ended') {
      this.ended?.();
    }
  }

  fromPeer(peer, data) {
    if (!data || typeof data !== 'object') return;
    if (data.h === 'hello') {
      if (typeof data.nonce !== 'string' || data.nonce.length > 64) return;
      // 证明自己是链接里的那个房主：签名绑定对方的挑战、对方的 id 和自己的 id
      this.signal.send(peer, { h: 'auth', pub: this.cfg.identity.pub, sig: sign(this.cfg.identity, `${data.nonce}|${peer}|${this.signal.selfId}`) });
      // 每次 hello 都是一次新会话（好友刷新或重连）
      if (this.guests.has(peer)) this.worker.postMessage({ type: 'gone', id: peer });
      this.guests.add(peer);
      this.worker.postMessage({ type: 'open', id: peer });
      return;
    }
    if (data.g && this.guests.has(peer)) this.worker.postMessage({ type: 'msg', id: peer, msg: data.g });
  }

  // 房主自己的页面通过本地回环接入牌桌
  openLocal(handler) {
    this.localHandler = handler;
    this.worker.postMessage({ type: 'open', id: LOCAL });
  }

  sendLocal(msg) {
    this.worker.postMessage({ type: 'msg', id: LOCAL, msg });
  }

  save() {
    const { cfg } = this;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        roomId: cfg.roomId, password: cfg.password, identity: cfg.identity, fp: cfg.fp, token: cfg.token || null,
        code: cfg.code, invite: cfg.invite, settings: this.snapshot?.settings || cfg.settings,
        snapshot: this.snapshot, at: Date.now(),
      }));
    } catch { /* 存储不可用时刷新页面就无法恢复 */ }
  }

  async keepAwake() {
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch { /* 不支持或被拒绝 */ }
  }

  /** 房主结束牌桌：通知所有人，然后关掉一切 */
  async end() {
    await new Promise((resolve) => {
      this.ended = resolve;
      this.worker.postMessage({ type: 'end' });
      setTimeout(resolve, 1000);
    });
    await new Promise((r) => setTimeout(r, 400)); // 让「牌局结束」的消息发出去
    this.dispose();
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  }

  dispose() {
    window.removeEventListener('beforeunload', this.onUnload);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.worker?.terminate();
    this.signal?.close();
    this.wakeLock?.release().catch(() => {});
    this.releaseLock?.();
  }
}
