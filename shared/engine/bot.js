// 简单的机器人：翻牌前用 Chen 公式，翻牌后用蒙特卡洛胜率对比底池赔率
import { makeDeck, evaluate, rankVal } from '../poker.js';
import { random, randomInt } from '../mp/random.js';

export const BOT_NAMES = ['阿尔法', '老K', '小七', '大鲨鱼', '石头', '幸运星', '夜猫', '铁算盘', '闪电', '南风'];

function chen(cards) {
  const [hi, lo] = cards.map(rankVal).sort((a, b) => b - a);
  const base = (r) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let score = base(hi);
  if (hi === lo) return Math.max(5, score * 2);
  if (cards[0][1] === cards[1][1]) score += 2;
  const gap = hi - lo - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) score += 1;
  return Math.ceil(score);
}

function equity(hole, board, opponents, iters = 180) {
  const dead = new Set([...hole, ...board]);
  const deck = makeDeck().filter((c) => !dead.has(c));
  const missing = 5 - board.length;
  const need = missing + opponents * 2;
  let score = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + randomInt(deck.length - i);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const full = board.concat(deck.slice(0, missing));
    const mine = evaluate(hole.concat(full)).value;
    let ties = 0;
    let lost = false;
    for (let o = 0, k = missing; o < opponents; o++, k += 2) {
      const v = evaluate([deck[k], deck[k + 1], ...full]).value;
      if (v > mine) { lost = true; break; }
      if (v === mine) ties++;
    }
    if (!lost) score += 1 / (ties + 1);
  }
  return score / iters;
}

export function botDecide(room, p) {
  const h = room.hand;
  const o = room.options(p);
  const bb = h.blinds ? h.blinds[1] : room.settings.bb;
  const { tight, aggr } = p.style;
  const opponents = room.seats.filter((q) => q && q !== p && q.inHand && !q.folded).length;
  const pot = h.pot + room.seats.reduce((s, q) => s + (q && q.inHand ? q.bet : 0), 0);
  const r = random();

  const raiseTo = (target) => {
    let to = Math.round(target / bb) * bb;
    to = Math.max(o.minTo, Math.min(o.maxTo, to));
    return to >= o.maxTo ? { a: 'allin' } : { a: 'raise', amount: to };
  };
  const potBet = (frac) => raiseTo(h.currentBet + (pot + o.toCall) * frac);

  if (h.street === 'preflop') {
    const score = chen(p.cards) + (6 - (opponents + 1)) * 0.8 + (1 - tight) * 2 + (random() * 2 - 1);
    const cost = o.toCall / bb;
    // 短码（锦标赛后期常见）：只推或弃，越短越松
    const depth = (p.chips + p.bet) / bb;
    if (depth <= 10) {
      if (score >= 6 + depth * 0.45) return o.canRaise ? { a: 'allin' } : { a: 'call' };
      return o.canCheck ? { a: 'check' } : { a: 'fold' };
    }
    if (o.canCheck) {
      if (o.canRaise && score >= 10 && r < 0.45 + aggr * 0.45) return potBet(0.8 + random() * 0.4);
      return { a: 'check' };
    }
    if (cost <= 1) {
      if (o.canRaise && score >= 10.5 && r < 0.5 + aggr * 0.45) return raiseTo(bb * (2.5 + random() * 1.5));
      return score >= 5.5 ? { a: 'call' } : { a: 'fold' };
    }
    if (cost <= 4.5) {
      if (o.canRaise && score >= 13 && r < 0.35 + aggr * 0.45) return potBet(0.9);
      return score >= 8 ? { a: 'call' } : { a: 'fold' };
    }
    if (o.toCall < p.chips * 0.35) {
      if (o.canRaise && score >= 15 && r < 0.5) return { a: 'allin' };
      return score >= 11 ? { a: 'call' } : { a: 'fold' };
    }
    return score >= 13.5 ? { a: 'call' } : { a: 'fold' };
  }

  const eq = equity(p.cards, h.board, Math.max(1, opponents));
  const strength = eq * (opponents + 1); // 1 表示平均水平

  if (o.canCheck) {
    if (o.canRaise) {
      const strong = strength > 1.45 + tight * 0.25 || eq > 0.62;
      if (strong && r < 0.45 + aggr * 0.45) return potBet(0.45 + random() * 0.4);
      if (r < 0.04 + aggr * 0.08) return potBet(0.5); // 偶尔诈唬
    }
    return { a: 'check' };
  }

  const odds = o.toCall / (pot + o.toCall);
  // 对手下注越重，越要打折看待「对随机牌」的胜率
  const pressure = Math.min(1, o.toCall / Math.max(pot - o.toCall, bb));
  const eqAdj = eq - (0.04 + 0.13 * pressure) * (0.6 + tight * 0.8);
  if (eqAdj > odds) {
    const monster = eq > 0.72 + tight * 0.08 || strength > 2.2;
    if (o.canRaise && monster && r < 0.35 + aggr * 0.5) {
      if (eq > 0.88 && random() < 0.25 + aggr * 0.3) return { a: 'allin' };
      return potBet(0.6 + random() * 0.5);
    }
    if (o.toCall > p.chips * 0.6 && eq < 0.5 + tight * 0.1) return { a: 'fold' };
    return { a: 'call' };
  }
  if (o.toCall <= bb && r < 0.5 - tight * 0.3) return { a: 'call' };
  return { a: 'fold' };
}
