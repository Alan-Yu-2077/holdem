// 在当前线程里直接执行密码学计算（房主的后台线程、Node 测试里用）
import * as mp from '../mp/protocol.js';

const fns = {
  shuffleStep: mp.shuffleStep,
  verifyShuffle: mp.verifyShuffle,
  lockStep: mp.lockStep,
  sumOf: mp.sumOf,
  openCard: mp.openCard,
  audit: mp.audit,
};

export const inlinePool = {
  async call(fn, args) {
    if (!Object.hasOwn(fns, fn)) throw new Error(`unknown fn ${fn}`);
    await null; // 保持异步语义
    return fns[fn](args);
  },
};
