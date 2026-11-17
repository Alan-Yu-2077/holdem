// 用 WebAudio 合成的音效：发牌、筹码、过牌、提示音……无需任何音频文件
import { isInstant } from './anim.js';
import { random } from '../shared/mp/random.js'; // 连视觉抖动也用密码学安全随机数

let ctx = null;
let master = null;
let noise = null;
let enabled = localStorage.getItem('poker.sound') !== '0';

function ready() {
  if (!enabled || isInstant() || !ctx || ctx.state !== 'running') return false;
  return true;
}

function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function env(gain, t0, attack, decay, peak) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function burst({ at = 0, freq = 3000, q = 1, type = 'bandpass', attack = 0.004, decay = 0.08, peak = 0.3, sweep = 0 }) {
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq + sweep), t0 + attack + decay);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, attack, decay, peak);
  src.connect(f).connect(g).connect(master);
  src.start(t0, random() * 0.5);
  src.stop(t0 + attack + decay + 0.02);
}

function tone({ at = 0, freq = 440, type = 'sine', attack = 0.005, decay = 0.2, peak = 0.2, slide = 0 }) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + attack + decay);
  const g = ctx.createGain();
  env(g, t0, attack, decay, peak);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.02);
}

export const sfx = {
  unlock,
  get enabled() { return enabled; },
  setEnabled(v) {
    enabled = v;
    localStorage.setItem('poker.sound', v ? '1' : '0');
  },
  card() {
    if (!ready()) return;
    burst({ freq: 5200, q: 0.8, decay: 0.07, peak: 0.16, sweep: -3200 });
  },
  flip() {
    if (!ready()) return;
    burst({ freq: 2600, q: 0.9, decay: 0.05, peak: 0.14, sweep: 2400 });
    burst({ at: 0.05, freq: 900, q: 0.7, type: 'lowpass', decay: 0.05, peak: 0.12 });
  },
  chips(n = 3) {
    if (!ready()) return;
    const k = Math.max(1, Math.min(6, n));
    for (let i = 0; i < k; i++) {
      const at = i * 0.035 + random() * 0.012;
      burst({ at, freq: 3600 + random() * 1400, q: 9, decay: 0.045, peak: 0.34 });
      tone({ at, freq: 2100 + random() * 500, type: 'triangle', decay: 0.03, peak: 0.05 });
    }
  },
  check() {
    if (!ready()) return;
    tone({ freq: 150, decay: 0.07, peak: 0.42, slide: -60 });
    tone({ at: 0.1, freq: 140, decay: 0.07, peak: 0.34, slide: -60 });
  },
  fold() {
    if (!ready()) return;
    burst({ freq: 1400, q: 0.6, type: 'lowpass', attack: 0.02, decay: 0.16, peak: 0.12, sweep: -900 });
  },
  turn() {
    if (!ready()) return;
    tone({ freq: 660, decay: 0.22, peak: 0.16 });
    tone({ at: 0.11, freq: 990, decay: 0.3, peak: 0.14 });
  },
  tick() {
    if (!ready()) return;
    tone({ freq: 1200, decay: 0.04, peak: 0.08, type: 'square' });
  },
  win() {
    if (!ready()) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ at: i * 0.11, freq: f, type: 'triangle', decay: 0.45, peak: 0.15 }));
  },
  /** 自己赢下一手：更长的上行琶音 + 一串筹码声 */
  bigWin() {
    if (!ready()) return;
    [392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone({ at: i * 0.1, freq: f, type: 'triangle', decay: 0.6, peak: 0.16 }));
    tone({ at: 0.62, freq: 1567.98, type: 'sine', decay: 1.2, peak: 0.1 });
    for (let i = 0; i < 6; i++) {
      const at = 0.3 + i * 0.07;
      burst({ at, freq: 3600 + random() * 1400, q: 9, decay: 0.05, peak: 0.28 });
    }
  },
  /** 锦标赛升盲：两声清脆的铃 */
  level() {
    if (!ready()) return;
    tone({ freq: 1046.5, decay: 0.5, peak: 0.12 });
    tone({ at: 0.16, freq: 1396.9, decay: 0.7, peak: 0.1 });
  },
  /** 公共牌让自己的牌型升级 */
  rise() {
    if (!ready()) return;
    tone({ freq: 880, decay: 0.16, peak: 0.08, slide: 220 });
    tone({ at: 0.09, freq: 1318.5, decay: 0.26, peak: 0.07 });
  },
};

window.addEventListener('pointerdown', unlock, { passive: true });
window.addEventListener('keydown', unlock);
