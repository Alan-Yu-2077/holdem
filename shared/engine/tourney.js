// 锦标赛：盲注结构、奖金分配与名次 —— 规则引擎和界面共用的纯函数。
// 参考常见的单桌锦标赛（SNG）与家庭赛：
//   · 人人同样的起始筹码，不能重买；
//   · 按时间升盲，到点后从下一手开始生效；
//   · 输光出局，按出局先后排名；同一手里出局的，这手开始时筹码多的名次靠前，一样多则并列、平分奖金；
//   · 到了时限打完当前这手，剩下的人按筹码排名；前几名按比例分奖金（钱在线下结算，网页只给出比例）。

/** 可选的比赛时长（分钟） */
export const MINUTES = [60, 90, 120, 180];

/** 奖励名额 → 各名次分到的比例（%） */
export const PAYOUTS = { 1: [100], 2: [65, 35], 3: [50, 30, 20] };

const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/** 好记的大盲数值：1–1.2–1.5–2–2.5–3–4–5–6–8 × 10ⁿ，只取偶数（小盲 = 大盲 / 2 要是整数） */
function ladder(max) {
  const out = [];
  for (let e = 1; ; e *= 10) {
    for (const s of STEPS) {
      const v = Math.round(s * e);
      if (v >= 2 && v % 2 === 0 && v > (out[out.length - 1] || 0)) out.push(v);
    }
    if (e > max) return out;
  }
}

/** 按比例最接近的那一档 */
function nearest(list, want) {
  let best = list[0];
  for (const v of list) if (Math.abs(Math.log(v / want)) < Math.abs(Math.log(best / want))) best = v;
  return best;
}

/**
 * 按人数、起始筹码和时长生成盲注结构 { levelMs, levels: [[小盲, 大盲], …] }。
 *   · 每级 = 总时长的十分之一（2 小时 → 12 分钟一级）；
 *   · 第一级大盲 = 起始筹码的 1%，即人人 100 个大盲起步；
 *   · 到 80% 的时间点，大盲约为全场总筹码的 1/20：这时剩下的人平均只有十来个大盲，只能推或弃，
 *     比赛多半会在时限前自然分出胜负，时限只是兜底。
 */
export function makeLevels({ players, startingChips, minutes }) {
  const levelMin = Math.max(3, Math.round(minutes / 10));
  const count = Math.ceil(minutes / levelMin);
  const total = Math.max(2, players) * startingChips;
  const list = ladder(total);
  const first = nearest(list, Math.max(2, startingChips / 100));
  const k = Math.max(1, Math.round(count * 0.8));
  const growth = Math.min(2, Math.max(1.25, (total / 20 / first) ** (1 / k)));
  const levels = [];
  let prev = 0;
  for (let i = 0; i < count + 2; i++) {
    let bb = nearest(list, first * growth ** i);
    if (bb <= prev) bb = list.find((v) => v > prev) ?? prev * 2;
    levels.push([bb / 2, bb]);
    prev = bb;
  }
  return { levelMs: levelMin * 60000, levels };
}

/**
 * 奖励名额：paid = 0 时自动（报名 2 人赢家通吃，3–5 人前 2 名，6 人以上前 3 名）。
 * 名额最多 3 个，且至少留一个人没有奖金。返回各名次的比例
 */
export function payoutPlan(entrants, paid = 0) {
  const auto = entrants <= 2 ? 1 : entrants <= 5 ? 2 : 3;
  const k = Math.max(1, Math.min(paid || auto, entrants - 1, 3));
  return PAYOUTS[k];
}

/** 第 place 名（tie 人并列，占掉 place … place+tie-1 这几个名次）每人分到的比例 */
export function prizeShare(payouts, place, tie = 1) {
  let sum = 0;
  for (let i = place - 1; i < place - 1 + tie; i++) sum += payouts[i] || 0;
  return Math.round((sum / tie) * 100) / 100;
}

/**
 * 同一手里输光的人定名次：这手开始时筹码少的排在后面，一样多则并列。
 * busted: [{ start, … }]；remaining：仍在场的人数。返回加上 { place, tie } 的副本
 */
export function placeBusted(busted, remaining) {
  const list = [...busted].sort((a, b) => a.start - b.start);
  let worst = remaining + list.length;
  const res = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j < list.length && list[j].start === list[i].start) j++;
    const tie = j - i;
    for (let k = i; k < j; k++) res.push({ ...list[k], place: worst - tie + 1, tie });
    worst -= tie;
    i = j;
  }
  return res;
}

/**
 * 最终名次：仍在场的按筹码排（一样多则并列），已出局的沿用出局时定下的名次。
 * alive: [{ chips, … }]，out: [{ place, tie, … }]。返回按名次排好、带 { place, tie, prize } 的列表
 */
export function finalStandings(alive, out, payouts) {
  const rows = [];
  const sorted = [...alive].sort((a, b) => b.chips - a.chips);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].chips === sorted[i].chips) j++;
    for (let k = i; k < j; k++) rows.push({ ...sorted[k], place: i + 1, tie: j - i });
    i = j;
  }
  for (const o of out) rows.push({ ...o });
  rows.sort((a, b) => a.place - b.place);
  return rows.map((r) => ({ ...r, prize: prizeShare(payouts, r.place, r.tie || 1) }));
}

/** 比赛进行到 elapsed 毫秒时所在的级别（下标） */
export function levelAt(t, elapsed) {
  return Math.min(t.levels.length - 1, Math.max(0, Math.floor(elapsed / t.levelMs)));
}
