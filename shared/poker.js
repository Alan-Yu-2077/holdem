// 牌面、洗牌与牌力评估 —— 服务器与浏览器共用
// 牌的编码：点数 + 花色，例如 "As" 黑桃A、"Td" 方块10
import { randomInt } from './mp/random.js';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

export const rankVal = (card) => RANKS.indexOf(card[0]) + 2;
export const rankLabel = (v) => (v === 14 || v === 1 ? 'A' : v === 13 ? 'K' : v === 12 ? 'Q' : v === 11 ? 'J' : String(v));

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Fisher–Yates；randInt(n) 返回 [0, n) 的整数，默认使用密码学安全随机数 */
export function shuffle(deck, randInt = randomInt) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function result(cat, tiebreak, used) {
  let value = cat;
  for (let i = 0; i < 5; i++) value = value * 15 + (tiebreak[i] || 0);
  let name = CATEGORY_NAMES[cat];
  const t = tiebreak.map(rankLabel);
  let desc;
  switch (cat) {
    case 8:
      if (tiebreak[0] === 14) { name = '皇家同花顺'; desc = name; } else desc = `同花顺 ${t[0]} 高`;
      break;
    case 7: desc = `四条 ${t[0]}`; break;
    case 6: desc = `葫芦 ${t[0]} 带 ${t[1]}`; break;
    case 5: desc = `同花 ${t[0]} 高`; break;
    case 4: desc = `顺子 ${t[0]} 高`; break;
    case 3: desc = `三条 ${t[0]}`; break;
    case 2: desc = `两对 ${t[0]} 和 ${t[1]}`; break;
    case 1: desc = `一对 ${t[0]}`; break;
    default: desc = `高牌 ${t[0]}`;
  }
  return { cat, value, name, desc, best: used.map((x) => x.c) };
}

/**
 * 评估 2~7 张牌里最好的 5 张。
 * 返回 { cat, value, name, desc, best }，value 越大牌越强，可直接比较。
 */
export function evaluate(cards) {
  const cs = cards.map((c) => ({ c, r: rankVal(c), s: c[1] })).sort((a, b) => b.r - a.r);

  const bySuit = {};
  for (const x of cs) (bySuit[x.s] ||= []).push(x);
  const flush = Object.values(bySuit).find((list) => list.length >= 5);

  const straightIn = (list) => {
    const uniq = [];
    for (const x of list) if (!uniq.length || uniq[uniq.length - 1].r !== x.r) uniq.push(x);
    if (uniq.length && uniq[0].r === 14) uniq.push({ ...uniq[0], r: 1 }); // A 可以当 1
    for (let i = 0; i + 4 < uniq.length; i++) {
      if (uniq[i].r - uniq[i + 4].r === 4) return uniq.slice(i, i + 5);
    }
    return null;
  };

  if (flush) {
    const sf = straightIn(flush);
    if (sf) return result(8, [sf[0].r], sf);
  }

  const groups = new Map();
  for (const x of cs) {
    if (!groups.has(x.r)) groups.set(x.r, []);
    groups.get(x.r).push(x);
  }
  const gs = [...groups.values()].sort((a, b) => b.length - a.length || b[0].r - a[0].r);
  const kickers = (exclude, n) => cs.filter((x) => !exclude.includes(x.r)).slice(0, n);
  const rs = (list) => list.map((x) => x.r);

  if (gs[0].length === 4) {
    const k = kickers([gs[0][0].r], 1);
    return result(7, [gs[0][0].r, ...rs(k)], [...gs[0], ...k]);
  }
  if (gs[0].length === 3 && gs[1] && gs[1].length >= 2) {
    const pair = gs[1].slice(0, 2);
    return result(6, [gs[0][0].r, pair[0].r], [...gs[0], ...pair]);
  }
  if (flush) {
    const f = flush.slice(0, 5);
    return result(5, rs(f), f);
  }
  const st = straightIn(cs);
  if (st) return result(4, [st[0].r], st);
  if (gs[0].length === 3) {
    const k = kickers([gs[0][0].r], 2);
    return result(3, [gs[0][0].r, ...rs(k)], [...gs[0], ...k]);
  }
  if (gs[0].length === 2 && gs[1] && gs[1].length === 2) {
    const k = kickers([gs[0][0].r, gs[1][0].r], 1);
    return result(2, [gs[0][0].r, gs[1][0].r, ...rs(k)], [...gs[0], ...gs[1], ...k]);
  }
  if (gs[0].length === 2) {
    const k = kickers([gs[0][0].r], 3);
    return result(1, [gs[0][0].r, ...rs(k)], [...gs[0], ...k]);
  }
  const k = cs.slice(0, 5);
  return result(0, rs(k), k);
}

/**
 * 摊牌结算：拆分主池 / 边池并分配（服务器结算与客户端复核共用同一份逻辑）。
 *   players: 本手全部参与者 [{ seat, total, folded, cards }]，total 为本手累计投入
 *   dealer: 庄家座位号；seats: 桌上座位总数；pot: 底池总额
 * 平分时的零头给庄家左手边最近的赢家。
 */
export function settle({ players, board, dealer, seats, pot }) {
  const contenders = players.filter((p) => !p.folded);
  const evals = new Map(contenders.map((p) => [p.seat, evaluate([...p.cards, ...board])]));
  const levels = [...new Set(contenders.map((p) => p.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) amount += Math.max(0, Math.min(p.total, level) - prev);
    if (amount > 0) pots.push({ amount, eligible: contenders.filter((p) => p.total >= level) });
    prev = level;
  }
  const counted = pots.reduce((s, x) => s + x.amount, 0);
  if (pots.length && pot > counted) pots[pots.length - 1].amount += pot - counted;
  const fromButton = (p) => (p.seat - dealer - 1 + 2 * seats) % seats;
  return {
    evals,
    pots: pots.map((pt) => {
      const best = Math.max(...pt.eligible.map((p) => evals.get(p.seat).value));
      const winners = pt.eligible.filter((p) => evals.get(p.seat).value === best).sort((a, b) => fromButton(a) - fromButton(b));
      const share = Math.floor(pt.amount / winners.length);
      let odd = pt.amount - share * winners.length;
      return {
        amount: pt.amount,
        name: evals.get(winners[0].seat).desc,
        winners: winners.map((w) => ({ seat: w.seat, amount: share + (odd-- > 0 ? 1 : 0) })),
      };
    }),
  };
}
