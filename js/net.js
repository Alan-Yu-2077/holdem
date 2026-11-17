// 联网层（点对点）：
//   房主 —— 通过本地回环连到自己浏览器后台线程里的牌桌；
//   好友 —— 借公共中继找到房主，验证房主签名后直连。断线后自动重新寻找房主并回到原座位。
import { Signal } from './p2p/signal.js';
import { verify, randomToken } from './p2p/auth.js';
import { iceServers, relayOnly } from './p2p/ice.js';

const PING_EVERY = 4000;
const DEAD_AFTER = 12000;
const SEARCH_EVERY = 3000;

export class Net {
  constructor({ message, online, offline }) {
    this.onMessage = message;
    this.onOnline = online;
    this.onOffline = offline;
    this.mode = null;
    this.hello = null;
    this.connected = false;
    this.lastHeard = 0;
    this.gen = 0;
    this.since = 0;
    setInterval(() => this.heartbeat(), PING_EVERY);
  }

  /** 房主：连到自己浏览器里的牌桌 */
  local(runtime, hello) {
    this.close();
    this.mode = 'local';
    this.runtime = runtime;
    this.hello = hello;
    runtime.openLocal((msg) => this.deliver(msg));
    this.connected = true;
    this.onOnline?.();
    runtime.sendLocal(this.hello());
  }

  /** 好友：invite = { roomId, password, fp } */
  async guest(invite, hello) {
    this.close();
    const gen = this.gen;
    this.mode = 'guest';
    this.invite = invite;
    this.hello = hello;
    this.host = null;
    this.nonces = new Map();
    this.since = Date.now();
    this.onOffline?.('searching');
    const ice = { iceServers: await iceServers(), relayOnly: relayOnly() };
    if (gen !== this.gen) return; // 准备期间已经离开
    const signal = (this.signal = new Signal(invite.roomId, invite.password, ice));
    signal.onJoin = (peer) => this.challenge(peer);
    signal.onLeave = (peer) => { if (peer === this.host) this.lost(); };
    signal.onMessage = (peer, data) => this.fromPeer(peer, data);
    // 还没找到房主时，定期向所有已连上的人再问一次
    this.searchTimer = setInterval(() => {
      if (!this.host && this.signal) for (const p of this.signal.peerIds()) this.challenge(p);
    }, SEARCH_EVERY);
  }

  /** 好友端在找房主时卡在哪一步（给等待画面用） */
  diagnose() {
    const s = this.signal?.status();
    return s ? { ...s, ready: true, elapsed: Date.now() - this.since } : { ready: false, elapsed: Date.now() - this.since };
  }

  challenge(peer) {
    const nonce = randomToken(16);
    this.nonces.set(peer, nonce);
    this.signal.send(peer, { h: 'hello', nonce });
  }

  fromPeer(peer, data) {
    if (!data || typeof data !== 'object') return;
    if (data.h === 'auth') {
      if (this.host) return;
      const nonce = this.nonces.get(peer);
      // 只认能用链接里那把公钥签名的人为房主
      if (!nonce || !verify(data.pub, this.invite.fp, `${nonce}|${this.signal.selfId}|${peer}`, data.sig || {})) return;
      this.host = peer;
      this.connected = true;
      this.lastHeard = Date.now();
      this.onOnline?.();
      this.send(this.hello());
      return;
    }
    if (data.g && peer === this.host) this.deliver(data.g);
  }

  deliver(msg) {
    this.lastHeard = Date.now();
    if (!msg || msg.t === 'pong') return;
    this.onMessage(msg);
  }

  lost() {
    this.host = null;
    this.connected = false;
    this.since = Date.now();
    if (this.mode === 'guest') this.onOffline?.('host');
  }

  heartbeat() {
    if (this.mode !== 'guest' || !this.connected) return;
    if (Date.now() - this.lastHeard > DEAD_AFTER) return this.lost();
    this.send({ t: 'ping' });
  }

  send(obj) {
    if (this.mode === 'local') this.runtime?.sendLocal(obj);
    else if (this.mode === 'guest' && this.host) this.signal.send(this.host, { g: obj });
  }

  close() {
    this.gen++;
    clearInterval(this.searchTimer);
    this.signal?.close();
    this.signal = null;
    this.host = null;
    this.runtime = null;
    this.connected = false;
    this.mode = null;
  }
}
