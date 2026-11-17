// 赢牌时的庆祝效果：纸屑 + 金粉，画在 3D 场景之上的一层画布里（不碰 3D 场景本身）
import { random } from '../shared/mp/random.js';

const PALETTE = ['#e0c288', '#b9955a', '#ece4d4', '#c4553f', '#6fae8c'];

export class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.running = false;
    this.last = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  /** level 1：小庆祝（赢下底池）；2：大庆祝（自己赢下一手）；3：好牌（顺子以上） */
  celebrate(level = 1, at = null) {
    if (document.hidden) return;
    this.resize();
    const x = at ? at.x : this.w / 2;
    const y = at ? at.y : this.h * 0.42;
    const count = level >= 3 ? 220 : level === 2 ? 140 : 46;
    const power = level >= 3 ? 15 : level === 2 ? 12 : 8;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (random() - 0.5) * Math.PI * (level >= 2 ? 1.25 : 0.9);
      const v = power * (0.45 + random() * 0.75);
      this.parts.push({
        kind: random() < (level >= 3 ? 0.35 : 0.2) ? 'dust' : 'paper',
        x: x + (random() - 0.5) * 40,
        y: y + (random() - 0.5) * 16,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        rot: random() * Math.PI * 2,
        spin: (random() - 0.5) * 0.4,
        flip: random() * Math.PI * 2,
        flipSpeed: 0.08 + random() * 0.18,
        w: 5 + random() * 6,
        h: 3 + random() * 4,
        color: PALETTE[Math.floor(random() * PALETTE.length)],
        life: 0,
        ttl: 2.2 + random() * 1.6,
      });
    }
    if (!this.running) {
      this.running = true;
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    const k = dt * 60;
    this.parts = this.parts.filter((p) => (p.life += dt) < p.ttl && p.y < this.h + 40);
    for (const p of this.parts) {
      p.vy += (p.kind === 'dust' ? 0.12 : 0.22) * k;
      p.vx *= 0.985 ** k;
      p.vy *= 0.985 ** k;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.rot += p.spin * k;
      p.flip += p.flipSpeed * k;
      const fade = Math.min(1, (p.ttl - p.life) / 0.6);
      ctx.globalAlpha = fade;
      if (p.kind === 'dust') {
        const r = 1.2 + Math.abs(Math.sin(p.flip)) * 1.6;
        ctx.fillStyle = '#f3dca6';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.flip)); // 纸片翻转
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    if (this.parts.length) requestAnimationFrame((t) => this.frame(t));
    else {
      this.running = false;
      ctx.clearRect(0, 0, this.w, this.h);
    }
  }
}
