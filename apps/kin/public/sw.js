// Kin service worker — minimal app-shell cache so it installs as a PWA/TWA.
// Deliberately network-first for everything (chat must never serve stale data);
// the cache is only a fallback so the shell opens offline.
const CACHE = 'kin-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/emoji.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// ── Real push notifications ──
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Kin', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    // If the app is already open AND focused, a message push is redundant (the WS
    // delivered it live) — suppress it. Calls always notify.
    if (d.tag !== 'kin-call') {
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (cs.some(c => c.visibilityState === 'visible' && c.focused)) return;
    }
    await self.registration.showNotification(d.title || 'Kin', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: d.tag || 'kin-msg',
      renotify: !!d.renotify,
      vibrate: d.tag === 'kin-call' ? [200, 100, 200, 100, 200] : [120],
      data: { url: d.url || '/' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { c.focus(); return; } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API / websocket / uploads — always live.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && (SHELL.includes(url.pathname) || url.pathname === '/')) {
        const clone = r.clone(); caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/index.html')))
  );
});
