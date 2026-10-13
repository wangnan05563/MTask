/**
 * MTask 移动端 Service Worker：离线缓存静态资源，断网仍可打开界面（§3.4 / §4.4）。
 * - 数据接口（/api）一律走网络，不缓存，保证数据实时一致；
 * - 静态资源（/assets）cache-first，加速二次加载；
 * - 导航请求 network-first，失败回退缓存的 index.html（离线打开界面）。
 * 仅在生产构建注册（dev 不注册，避免干扰 Vite HMR）。
 */
const CACHE = 'mtask-v1';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 数据接口不缓存。前缀兼容：apiBase 从 baseURI 推导后，前缀部署（如 /mtask/api）的
  // pathname 带挂载前缀，根绝对 startsWith('/api') 会漏判 → API 请求掉进导航兜底分支，
  // 失败时把 index.html 当 API 响应缓存（内网穿透×移动端实测发现）。按路径段判断两种形态都豁免。
  if (url.pathname.split('/').includes('api')) return;
  // 静态资源：cache-first（同上按路径段判断，前缀部署下 /mtask/assets/... 也命中）
  if (url.pathname.split('/').includes('assets')) {
    event.respondWith(caches.match(req).then((r) => r || fetch(req)));
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
