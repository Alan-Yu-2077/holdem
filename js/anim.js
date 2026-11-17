// 极简补间引擎：由渲染循环驱动，支持「瞬时模式」（页面在后台或事件积压时直接跳到终态）

const tweens = new Set();
let instant = false;

/** 全局节奏：所有动画和等待按这个倍数放慢（> 1 更慢） */
export const TEMPO = 1.35;

export const ease = {
  linear: (t) => t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inQuad: (t) => t * t,
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
};

export const isInstant = () => instant;

export function setInstant(v) {
  instant = v;
  if (v) finishAll();
}

/** update(k) 以缓动后的进度 0→1 调用；返回在结束时 resolve 的 Promise */
export function tween({ dur = 0.4, delay = 0, ease: fn = ease.outCubic, update }) {
  if (instant || dur <= 0) {
    update?.(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => tweens.add({ t: -delay * TEMPO, dur: dur * TEMPO, fn, update, resolve }));
}

export const wait = (sec) => tween({ dur: sec, ease: ease.linear });

export function tick(dt) {
  for (const tw of tweens) {
    tw.t += dt;
    if (tw.t < 0) continue;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update?.(tw.fn(k));
    if (k >= 1) {
      tweens.delete(tw);
      tw.resolve();
    }
  }
}

export function finishAll() {
  for (const tw of [...tweens]) {
    tweens.delete(tw);
    tw.update?.(1);
    tw.resolve();
  }
}

const lerp = (a, b, k) => a + (b - a) * k;
const shortAngle = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
};

/**
 * 把一个 THREE.Object3D 移动到目标姿态。
 * to: { x, y, z, rx, ry, rz, s }（缺省的分量保持不变）；arc 为途中抬起的高度
 */
export function moveObj(o, to, { dur = 0.4, delay = 0, ease: fn = ease.outCubic, arc = 0 } = {}) {
  let from = null;
  let end = null;
  return tween({
    dur, delay, ease: fn,
    update(k) {
      if (!from) {
        from = { x: o.position.x, y: o.position.y, z: o.position.z, rx: o.rotation.x, ry: o.rotation.y, rz: o.rotation.z, s: o.scale.x };
        end = { ...from, ...to };
        end.ry = shortAngle(from.ry, end.ry);
      }
      o.position.set(lerp(from.x, end.x, k), lerp(from.y, end.y, k) + arc * Math.sin(Math.PI * k), lerp(from.z, end.z, k));
      o.rotation.set(lerp(from.rx, end.rx, k), lerp(from.ry, end.ry, k), lerp(from.rz, end.rz, k));
      o.scale.setScalar(lerp(from.s, end.s, k));
    },
  });
}
