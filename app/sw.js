/* 我们的小站 PWA · Service Worker v3
 * 缓存策略：
 *  - 应用壳（/app/ 静态文件）：network-first —— 每次打开都检查最新代码，失败才用缓存
 *  - 媒体 /api/img/：cache-first + 后台更新（媒体离线秒开，弱网可用）
 *  - 其余 /api/ 接口：一律 network only，不缓存（数据实时性，避免读到旧会话数据）
 *  - 接口 POST（登录/上传）：不缓存，直接走网络
 */
const SHELL = ['index.html', 'style.css', 'app.js', 'manifest.json'];
const CACHE = 'couple-pwa-v3';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // POST/上传直接网络
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨站请求不拦截

  // 接口数据：/api/ 前缀一律不缓存（/api/img/ 媒体除外）
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/img/')) {
      // 媒体：缓存优先 + 后台更新
      e.respondWith(caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      }));
    }
    // 其余 /api/：默认 fetch，不进入 respondWith，即 network only
    return;
  }

  if (url.pathname.startsWith('/app/')) {
    // 应用壳：网络优先，拿不到才用缓存 —— 保证永远是最新代码
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
});
