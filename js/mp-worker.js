// 浏览器里的密码学计算线程：椭圆曲线运算放在这里，不卡动画
import * as mp from '../shared/mp/protocol.js';

const fns = {
  shuffleStep: mp.shuffleStep,
  verifyShuffle: mp.verifyShuffle,
  lockStep: mp.lockStep,
  sumOf: mp.sumOf,
  openCard: mp.openCard,
};

mp.canonicalDeck(); // 预热牌面点

self.onmessage = ({ data: { id, fn, args } }) => {
  try {
    if (!Object.hasOwn(fns, fn)) throw new Error(`unknown fn ${fn}`);
    self.postMessage({ id, ok: true, result: fns[fn](args) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message) });
  }
};
