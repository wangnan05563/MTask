/**
 * MTask 移动端 Service Worker：离线缓存静态资源，断网仍可打开界面（§3.4 / §4.4）。
 * - 数据接口（/api）一律走网络，不缓存，保证数据实时一致；
 * - 静态资源（/assets）cache-first，未命中回写缓存——断供 reload 时主 JS 仍能出（T02281）；
 * - 导航请求 network-first，失败回退缓存的 index.html（离线打开界面）。
 * 仅在生产构建注册（dev 不注册，避免干扰 Vite HMR）。
 */
const CACHE = 'mtask-v1';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      // T02281：断供 reload 真正缺的是带 hash 的主包，而 hash 名只有构建时才知道（PRECACHE 是静态名单）
      // → 首次访问那一趟导航不受新 SW 控制、回写路径来不及，故在 install 期从壳里解析清单预缓存。
      .then(() => precacheBuildAssets())
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

/** 取构建产物文件名里 hash 前的词干（`index-abc12345.js` → `index`）；不带 hash 返回 null */
function chunkStem(pathname) {
  const m = /\/([^/]+)-[0-9a-zA-Z_-]{8,}\.[^./]+$/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * T02281：同名分片只留最新。assets 文件名带内容 hash，每次构建换名，而缓存名 `mtask-v1` 固定、
 * activate 只清「别的缓存名」——回写若不清旧名，同一 chunk 的历次构建产物会永久堆积。
 * 离线壳只需要当前 index.html 引用的那一份，故写入时删掉同词干的其他条目。
 */
async function pruneReplacedChunk(cache, url) {
  const stem = chunkStem(url.pathname);
  if (!stem) return;
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    if (u.origin !== url.origin || !u.pathname.includes('/assets/') || req.url === url.href) continue;
    if (chunkStem(u.pathname) === stem) await cache.delete(req);
  }
}

/** 从缓存的界面壳里解析本次构建的 assets 清单并逐个预缓存（取不到不抛错，留给未命中回写路径兜底） */
async function precacheBuildAssets() {
  let html = '';
  try {
    const res = await fetch('./index.html');
    if (res.ok) html = await res.text();
  } catch { return; }
  const cache = await caches.open(CACHE);
  for (const m of html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)) {
    const url = new URL(m[1], self.location);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      await cache.put(url.href, res);
      await pruneReplacedChunk(cache, url);
    } catch { /* 单条失败不影响其余 */ }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 数据接口不缓存。前缀兼容：apiBase 从 baseURI 推导后，前缀部署（如 /mtask/api）的
  // pathname 带挂载前缀，根绝对 startsWith('/api') 会漏判 → API 请求掉进导航兜底分支，
  // 失败时把 index.html 当 API 响应缓存（内网穿透×移动端实测发现）。按路径段判断两种形态都豁免。
  if (url.pathname.split('/').includes('api')) return;
  // 静态资源：cache-first + 未命中回写（同上按路径段判断，前缀部署下 /mtask/assets/... 也命中）。
  // T02281：原先只 `r || fetch(req)` 读不写，assets 从未进缓存，而 PRECACHE 名单不含 hash 产物 →
  // 断供 reload 时主 JS `net::ERR_FAILED`、React 根不挂载（白板）。回写后正常浏览一次即可离线；
  // 只缓存成功响应，失败响应不入缓存以免固化。
  if (url.pathname.split('/').includes('assets')) {
    event.respondWith(
      caches.match(req).then((r) => r || fetch(req).then(async (res) => {
        if (res.ok) {
          const copy = res.clone();
          const cache = await caches.open(CACHE);
          await cache.put(req, copy);
          await pruneReplacedChunk(cache, url);
        }
        return res;
      })),
    );
    return;
  }
  // 导航 / 其它：network-first，失败回退缓存界面
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});

// ---------- T01440：Web Push ----------
self.addEventListener('push', (event) => {
  const data = (() => { try { return event.data ? event.data.json() : {}; } catch { return {}; } })();
  event.waitUntil(
    self.registration.showNotification(data.title || 'MTask', {
      body: data.body || '',
      icon: './icon.png',
      tag: 'mtask-push',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((cs) => {
      for (const c of cs) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    }),
  );
});
