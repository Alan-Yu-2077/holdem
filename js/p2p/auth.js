// 房主身份：邀请链接里带着房主公钥的指纹，好友连上后让对方签一个随机挑战，
// 证明自己确实是发链接的那个房主（拿到链接的其他人无法冒充房主）。
// Schnorr 签名，P-256 曲线，复用心理扑克的椭圆曲线实现。
import * as ec from '../../shared/mp/ec.js';
import { hashParts, toB64u } from '../../shared/mp/bytes.js';
import { randomBytes } from '../../shared/mp/random.js';

export const randomToken = (bytes = 16) => toB64u(randomBytes(bytes));

export function newIdentity() {
  const x = ec.randomScalar();
  return { secret: ec.encodeScalar(x), pub: ec.encodePoint(ec.mulG(x)) };
}

/** 公钥指纹（96 位，放进邀请链接） */
export const fingerprint = (pub) => toB64u(hashParts('holdem-p2p/fp', pub).subarray(0, 12));

const challenge = (R, P, msg) => ec.hashToScalar(hashParts('holdem-p2p/sig', R, P, msg));

export function sign(identity, msg) {
  const x = ec.decodeScalar(identity.secret);
  const k = ec.randomScalar();
  const R = ec.encodePoint(ec.mulG(k));
  const e = challenge(R, identity.pub, msg);
  return { R, s: ec.encodeScalar(ec.modN(k + e * x)) };
}

/** 校验签名，并确认公钥与链接里的指纹一致 */
export function verify(pub, fp, msg, sig) {
  try {
    if (fingerprint(pub) !== fp) return false;
    const P = ec.decodePoint(pub);
    const R = ec.decodePoint(sig.R);
    const s = ec.decodeScalar(sig.s);
    const e = challenge(sig.R, pub, msg);
    return ec.equal(ec.mulG(s), ec.add(R, ec.mul(e, P)));
  } catch {
    return false;
  }
}

/** 邀请链接里的房间信息：#j=房间号.房间密码.房主指纹 */
export function inviteLink(base, { roomId, password, fp }) {
  return `${base}#j=${roomId}.${password}.${fp}`;
}

export function parseInvite(text) {
  const m = String(text || '').match(/#j=([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{16})/);
  return m ? { roomId: m[1], password: m[2], fp: m[3] } : null;
}
