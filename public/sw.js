const VERSION = 'enruta-v1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './vendor/map-runtime.js', './vendor/leaflet/leaflet.css',
  './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/api.js', './js/arrivals.js', './js/geo.js', './js/icons.js',
  './js/services/index.js', './js/services/transport.js', './js/services/shapes.js',
  './js/services/emt.js', './js/services/emt-api.js', './js/services/atmv.js',
  './js/services/metro.js', './js/services/cercanias.js', './js/services/valenbisi.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  // Live transport data and third-party map tiles are never served from this cache.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request.mode === 'navigate' ? './' : request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request.mode === 'navigate' ? './' : request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    throw error;
  }
}
