// 打洞与中转服务器（ICE 服务器）。
//   · STUN：只帮浏览器查自己的公网地址，让两边「打洞」直连，不经手任何数据。
//   · TURN：直连失败时的中转。它只转发 WebRTC 端到端加密后的数据，看不到牌局内容。
//     双方网络都比较严格时（对称型 NAT：手机流量、校园网、公司网很常见），没有 TURN 就连不上。
//
// TURN 需要去服务商注册免费账号，下面两种方式填一种即可。
// 注意：这些凭证会出现在公开的网页里，拿到网页的人理论上都能蹭用你的免费额度。
//   · TURN_SERVERS：固定账号密码（例如 ExpressTURN 免费版），形如
//       { urls: 'turn:服务器地址:3478', username: '用户名', credential: '密码' }
//   · TURN_FETCH：运行时领取凭证的地址（例如 Metered Open Relay），形如
//       'https://应用名.metered.live/api/v1/turn/credentials?apiKey=密钥'
export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
];
export const TURN_SERVERS = [];
export const TURN_FETCH = '';

const CACHE = 'poker.turn';
const CACHE_MS = 6 * 3600 * 1000; // 领取到的凭证缓存 6 小时，免得每次进房都多等一次
const FETCH_MS = 5000;
const URL_OK = /^(stun|stuns|turn|turns):\S+$/;

/** 只保留格式正确的条目（服务商返回的东西也要过一遍，坏数据会让整条连接建不起来） */
export function cleanServers(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && URL_OK.test(u));
    if (!urls.length) return [];
    const out = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof s.username === 'string') out.username = s.username;
    if (typeof s.credential === 'string') out.credential = s.credential;
    return [out];
  });
}

export const hasTurn = (servers) => servers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

/** 运行时领取凭证的那个网址的来源（写进内容安全策略，允许网页去那里领取） */
export function turnFetchOrigin(url = TURN_FETCH) {
  try { return url ? new URL(url).origin : ''; } catch { return ''; }
}

async function fetchJson(fetchImpl, url, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctrl?.signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 这次联机用的 ICE 服务器：STUN + 固定的 TURN + 运行时领取的 TURN。
 * 领取失败时先用没过期太久的缓存，再不行就只靠直连（不会因此进不了房间）。
 */
export async function iceServers({
  turnServers = TURN_SERVERS, turnFetch = TURN_FETCH,
  fetchImpl = globalThis.fetch, storage = globalThis.localStorage, now = Date.now,
} = {}) {
  const base = [...STUN_SERVERS, ...cleanServers(turnServers)];
  if (!turnFetch) return base;
  let cached = null;
  try { cached = JSON.parse(storage?.getItem(CACHE)); } catch { /* 存储不可用 */ }
  if (cached?.from !== turnFetch) cached = null;
  if (cached && now() - cached.at < CACHE_MS) return [...base, ...cleanServers(cached.servers)];
  try {
    const servers = cleanServers(await fetchJson(fetchImpl, turnFetch, FETCH_MS));
    if (servers.length) {
      try { storage?.setItem(CACHE, JSON.stringify({ from: turnFetch, at: now(), servers })); } catch { /* 存储不可用 */ }
      return [...base, ...servers];
    }
  } catch { /* 网络不通或服务商出错 */ }
  return [...base, ...cleanServers(cached?.servers)];
}

/** 测试用：网址里带 ?relay 时只走中转（不直连），用来确认 TURN 真的可用 */
export const relayOnly = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay');
