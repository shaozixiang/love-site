/* 我们的小站 PWA · Service Worker
 * 缓存策略：
 *  - 应用壳（app/ 静态文件）：安装时预缓存，更新时替换
 *  - 图片/视频等 GET 媒体：stale-while-revalidate（先返回缓存秒开，后台更新）
 *  - 接口 POST（登录/上传）：不缓存，直接走网络
 */
const SHELL = ['index.html', 'style.css', 'app.js', 'manifest.json'];
const CACHE = 'couple-pwa-v1';

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
  if (url.origin === self.location.origin && url.pathname.startsWith('/app/')) {
    // 应用壳：缓存优先
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }
  // 媒体（Supabase storage / GitHub raw）：缓存优先 + 后台更新
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
