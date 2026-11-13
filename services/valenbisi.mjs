import { chromium } from 'playwright';

const cache = { value: null, until: 0 };
const bikeCache = new Map();
const PUBLIC_PAGE = 'https://www.valenbisi.es/es/mapping';
const API_URL = 'https://api.jcdecaux.com/vls/v3/stations';
const BIKES_URL = 'https://api.cyclocity.fr/contracts/valence/bikes';
let browserPromise;
let refreshPromise;

async function browser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  try { return await browserPromise; } catch (error) { browserPromise = null; throw error; }
}

async function publicStations() {
  const fetchedAt = Date.now();
  const page = await (await browser()).newPage({ serviceWorkers: 'block' });
  try {
    const stationResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.hostname === 'api.jcdecaux.com' && url.pathname === '/vls/v3/stations' && response.request().method() === 'GET';
    }, { timeout: 30000 });
    await page.goto(PUBLIC_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const response = await stationResponse;
    if (!response.ok()) throw Object.assign(new Error(`Valenbisi page returned HTTP ${response.status()}`), { status: 502 });
    return normalizeValenbisiStations(await response.json(), fetchedAt);
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(`Valenbisi public page scraper failed: ${error.message}`), { status: 502 });
  } finally {
    await page.close();
  }
}

async function publicBikes(stationNumber) {
  const page = await (await browser()).newPage({ serviceWorkers: 'block' });
  let authorization = process.env.VALENBISI_BIKES_AUTH || '';
  const captureAuthorization = request => {
    const url = new URL(request.url());
    const header = request.headers().authorization;
    if (url.hostname === 'api.cyclocity.fr' && header) authorization = header;
  };
  page.on('request', captureAuthorization);
  try {
    await page.goto(PUBLIC_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const search = page.getByRole('textbox', { name: 'Buscar' });
    await search.fill(String(stationNumber));
    const station = page.locator('span.text-uppercase.text-bold:visible').filter({ hasText: String(stationNumber) }).first();
    await station.waitFor({ state: 'visible', timeout: 10000 });
    const responsePromise = page.waitForResponse(response => response.url().includes(`/contracts/valence/bikes?stationNumber=${encodeURIComponent(stationNumber)}`), { timeout: 15000 });
    await station.click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`Bike detail request returned HTTP ${response.status()}`);
    const payload = await response.json();
    return { bikes: normalizeValenbisiBikes(payload), stationNumber: String(stationNumber), fetchedAt: Date.now() };
  } catch (error) {
    console.warn(`Valenbisi bike detail unavailable (${error.name}: ${error.message})`);
    if (error.status) throw error;
    throw Object.assign(new Error(`Valenbisi bike detail scraper failed: ${error.message}`), { status: 502 });
  } finally {
    await page.close();
  }
}

async function apiStations() {
  const apiKey = process.env.VALENBISI_API_KEY;
  if (!apiKey) return null;
  const contract = process.env.VALENBISI_CONTRACT || 'valence';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL(API_URL);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('contract', contract);
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`JCDecaux API returned HTTP ${response.status}`);
    return normalizeValenbisiStations(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveValenbisiStations({ api = apiStations, fallback = publicStations } = {}) {
  try {
    const result = await api();
    if (result) return result;
  } catch (error) {
    console.warn(`Valenbisi API unavailable; using public page fallback (${error.name === 'AbortError' ? 'timeout' : 'request failed'})`);
  }
  return fallback();
}

function number(value, fallback = null) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function sourceTimestamp(value) {
  if (value == null || value === '') return null;
  const numeric = number(value);
  const milliseconds = numeric == null ? Date.parse(value) : numeric < 100000000000 ? numeric * 1000 : numeric;
  return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

export function normalizeValenbisiStations(payload, fetchedAt = Date.now()) {
  if (!Array.isArray(payload)) throw new Error('Valenbisi returned an invalid station list');
  const stations = payload.map(item => {
    const position = item.position || {};
    const id = item.number ?? item.stationCode ?? item.id;
    const latitude = number(position.latitude ?? item.latitude);
    const longitude = number(position.longitude ?? item.longitude);
    const capacity = number(item.totalStands?.capacity ?? item.bikeStands);
    const availableBikes = number(item.totalStands?.availabilities?.bikes ?? item.availableBikes ?? item.available_bikes);
    const availableDocks = number(item.totalStands?.availabilities?.stands ?? item.availableStands ?? item.available_docks);
    const sourceUpdatedAt = sourceTimestamp(item.lastUpdate ?? item.last_updated);
    if (id == null || latitude == null || longitude == null) return null;
    return {
      id: String(id), name: String(item.name || `Estación ${id}`), coords: [longitude, latitude],
      capacity, availableBikes, availableDocks,
      status: item.status ? String(item.status).toLowerCase() : null,
      lastUpdated: sourceUpdatedAt ?? fetchedAt, sourceUpdatedAt,
    };
  }).filter(Boolean);
  if (!stations.length && payload.length) throw new Error('Valenbisi returned no valid stations');
  return { stations, fetchedAt, discardedStationCount: payload.length - stations.length };
}

export async function closeValenbisiBrowser() {
  const current = browserPromise;
  browserPromise = null;
  if (current) await (await current).close();
}

export function normalizeValenbisiBikes(payload) {
  const list = Array.isArray(payload) ? payload : payload?.bikes || payload?.data || payload?.items;
  if (!Array.isArray(list)) throw new Error('Valenbisi returned an invalid bike list');
  return list.map(item => {
    const rawRating = number(item.rating?.value ?? item.rating ?? item.score ?? item.condition?.rating ?? item.quality);
    const rating = rawRating == null ? null : rawRating > 3 ? (rawRating / 100) * 3 : rawRating;
    const maximum = number(item.rating?.max ?? item.maxRating ?? item.condition?.maxRating, 3);
    const reviewed = item.checked ?? item.reviewed ?? item.isReviewed ?? item.review?.completed ?? item.reviewStatus === 'reviewed';
    return {
      id: String(item.number ?? item.bikeNumber ?? item.id ?? item.code),
      rating: rating == null ? null : Math.max(0, Math.min(3, Math.round(rating))), ratingValue: rawRating,
      ratingCount: number(item.rating?.count ?? item.ratingCount), ratingMax: rawRating > 3 ? 3 : Math.max(1, Math.round(maximum)),
      reviewed: reviewed == null ? null : Boolean(reviewed),
      standNumber: number(item.standNumber ?? item.stand?.number),
      status: item.status ?? item.state ?? item.bikeStatus ?? null, statusLabel: item.statusLabel ?? null,
      lastRevisionAt: item.lastRevisionDateTime ?? item.lastRevisionAt ?? null,
    };
  }).filter(item => item.id !== 'undefined');
}

export async function handleValenbisi(path, params) {
  if (path === 'bikes') {
    const stationNumber = params.get('stationNumber');
    if (!stationNumber || !/^\d+$/.test(stationNumber)) throw Object.assign(new Error('Valenbisi station number is required'), { status: 400 });
    const now = Date.now();
    let entry = bikeCache.get(stationNumber);
    if (!entry) {
      entry = { value: null, until: 0, errorUntil: 0, promise: null };
      bikeCache.set(stationNumber, entry);
    }
    if (entry.value && entry.until > now) {
      if (entry.errorUntil > now) return staleBikeResponse(entry.value);
      return entry.value;
    }
    if (!entry.promise && entry.errorUntil <= now) {
      entry.promise = publicBikes(stationNumber).then(result => {
        entry.value = { text: JSON.stringify(result), type: 'application/json; charset=utf-8' };
        entry.until = Date.now() + 60000;
        entry.errorUntil = 0;
        return entry.value;
      }).catch(error => {
        console.warn(`Valenbisi bike detail refresh failed (${error.status || error.name || 'request error'})`);
        entry.errorUntil = Date.now() + 15000;
        if (entry.value) return staleBikeResponse(entry.value);
        throw error;
      }).finally(() => { entry.promise = null; });
      if (bikeCache.size > 300) bikeCache.delete(bikeCache.keys().next().value);
    }
    if (entry.promise) return entry.promise;
    if (entry.value) return staleBikeResponse(entry.value);
    throw Object.assign(new Error('Valenbisi bike details temporarily unavailable'), { status: 502 });
  }
  if (path !== 'stations') throw Object.assign(new Error('Valenbisi resource not found'), { status: 404 });
  const now = Date.now();
  if (cache.value && cache.until > now) return cache.value;
  if (!refreshPromise) {
    refreshPromise = resolveValenbisiStations().then(result => {
      const value = { text: JSON.stringify(result), type: 'application/json; charset=utf-8' };
      cache.value = value; cache.until = Date.now() + 45000;
      return value;
    }).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function staleBikeResponse(response) {
  const result = JSON.parse(response.text);
  result.stale = true;
  return { ...response, text: JSON.stringify(result) };
}
