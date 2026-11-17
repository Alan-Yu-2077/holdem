// 房主浏览器里的「牌桌服务器」：规则引擎、心理扑克编排、机器人都在这个后台线程里跑。
// 放在 Worker 里是因为页面切到后台时，主线程的定时器会被浏览器大幅降频，而 Worker 不会。
import { Table } from '../../shared/engine/table.js';

let table = null;
let snapTimer = null;
const links = new Map(); // 连接 id → { message, closed }

function postSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => self.postMessage({ type: 'snapshot', snapshot: table.snapshot() }), 300);
}

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init':
      table = new Table({ code: data.code, settings: data.settings, invite: data.invite, snapshot: data.snapshot });
      table.onChange = postSnapshot;
      postSnapshot();
      break;
    case 'open': {
      const id = data.id;
      links.get(id)?.closed();
      const link = table.connect({
        send: (msg) => self.postMessage({ type: 'send', id, msg }),
        close: (reason) => {
          links.delete(id);
          self.postMessage({ type: 'close', id, reason });
        },
      });
      links.set(id, link);
      break;
    }
    case 'msg':
      links.get(data.id)?.message(data.msg);
      break;
    case 'gone':
      links.get(data.id)?.closed();
      links.delete(data.id);
      break;
    case 'end':
      // 房主结束牌桌：通知所有人
      for (const id of links.keys()) self.postMessage({ type: 'send', id, msg: { t: 'left', why: 'closed' } });
      table.destroy();
      self.postMessage({ type: 'ended' });
      break;
  }
};
