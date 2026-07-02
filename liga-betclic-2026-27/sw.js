/* Liga Betclic 2026/27 — service worker */
const VERSION = 'v1.0.0';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // API e dados: network-first com fallback a cache (para offline)
  if (url.pathname.startsWith('/api') || url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        const c = await caches.open(DATA_CACHE);
        c.put(e.request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }

  // Shell: network-first (garante atualizações), fallback a cache
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      const c = await caches.open(SHELL_CACHE);
      c.put(e.request, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      return cached || caches.match('index.html');
    }
  })());
});
