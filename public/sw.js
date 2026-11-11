const VERSION = 'enruta-v2';
const TILE_CACHE = 'enruta-tiles-v1';
const TILE_META = 'enruta-tile-meta-v1';
const TILE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const TILE_LIMIT = 900;
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './vendor/map-runtime.js', './vendor/leaflet-rotate.js', './vendor/leaflet/leaflet.css',
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
    .then(keys => Promise.all(keys.filter(key => ![VERSION, TILE_CACHE, TILE_META].includes(key)).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.hostname === 'tile.openstreetmap.org' && isValenciaTile(url)) {
    event.respondWith(tileResponse(request)); return;
  }
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(networkFirst(request));
});

function isValenciaTile(url) {
  const match = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
  if (!match) return false;
  const zoom = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
  if (zoom < 10 || zoom > 19) return false;
  const count = 2 ** zoom;
  const longitude = tileX => tileX / count * 360 - 180;
  const latitude = tileY => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / count))) * 180 / Math.PI;
  const west = longitude(x), east = longitude(x + 1), north = latitude(y), south = latitude(y + 1);
  return east >= -.47 && west <= -.29 && north >= 39.34 && south <= 39.57;
}

function tileMetaKey(request) {
  return new Request(`${location.origin}/__tile-cache-meta${new URL(request.url).pathname}`);
}

async function trimTileCache(cache, meta) {
  const keys = (await cache.keys()).filter(request => new URL(request.url).hostname === 'tile.openstreetmap.org');
  if (keys.length <= TILE_LIMIT) return;
  const entries = await Promise.all(keys.map(async request => {
    const saved = await meta.match(tileMetaKey(request));
    return { request, expires: Number(await saved?.text()) || 0 };
  }));
  entries.sort((a, b) => a.expires - b.expires);
  await Promise.all(entries.slice(0, keys.length - TILE_LIMIT).map(({ request }) => Promise.all([
    cache.delete(request), meta.delete(tileMetaKey(request)),
  ])));
}

async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE), meta = await caches.open(TILE_META);
  const cached = await cache.match(request);
  const saved = await meta.match(tileMetaKey(request));
  const expires = Number(await saved?.text()) || 0;
  if (cached && expires > Date.now()) return cached;

  let response;
  try { response = await fetch(request); }
  catch (error) { if (cached) return cached; throw error; }
  if (!response.ok && response.type !== 'opaque') return cached || response;

  const policy = response.type === 'opaque' ? '' : response.headers.get('Cache-Control') || '';
  const maxAge = /\bmax-age=(\d+)/i.exec(policy);
  const ttl = /\b(?:no-store|no-cache|private)\b/i.test(policy)
    ? 0
    : response.type === 'opaque' ? TILE_MAX_AGE : maxAge ? Math.min(Number(maxAge[1]) * 1000, TILE_MAX_AGE) : 0;
  if (ttl > 0) {
    try {
      await cache.put(request, response.clone());
      await meta.put(tileMetaKey(request), new Response(String(Date.now() + ttl)));
      await trimTileCache(cache, meta);
    } catch { /* Keep the network tile usable when storage is unavailable. */ }
  } else if (cached) {
    await Promise.all([cache.delete(request), meta.delete(tileMetaKey(request))]);
  }
  return response;
}

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
