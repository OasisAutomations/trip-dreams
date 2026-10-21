// Trip Dreams service worker: installable + works offline. Your trips are never sent anywhere.
// Bump CACHE when you publish a new version so devices pick it up.
const CACHE = 'trip-dreams-v1.0';
const SHELL = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css', './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png', './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && /^trip-dreams-v/.test(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // map tiles + place search go straight to the network
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
