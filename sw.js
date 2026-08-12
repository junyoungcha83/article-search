// 앱 셸 오프라인 캐시. 캐시 이름을 바꾸면 옛 캐시는 자동 폐기된다.
// API 호출(api.anthropic.com)은 절대 가로채지 않는다 — 항상 네트워크로 직행.
const CACHE = 'article-search-v4';
const CORE = [
  './', './index.html', './assets/app.css', './assets/app.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // POST(API 호출) 통과
  if (new URL(req.url).origin !== self.location.origin) return;   // 외부 도메인 통과
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
