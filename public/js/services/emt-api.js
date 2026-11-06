import { madridParts, parseArrivals } from '../arrivals.js';

const WFS = 'https://geoportal.emtvalencia.es/geoserver/emt/wfs';
const SAE = 'https://geoportal.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php';
const cache = new Map();
let transport = 'auto';
let onTransport = () => {};
const proxyUntil = new Map();

export function setTransport(mode, callback) {
  transport = mode;
  if (callback) onTransport = callback;
  proxyUntil.clear();
}

function upstream(kind, params) {
  const url = new URL(kind === 'sae' ? SAE : WFS);
  url.search = new URLSearchParams(params);
  return url;
}

async function fetchText(url, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), credentials: 'omit' });
  if (!response.ok) throw new Error(`EMT service: HTTP ${response.status}`);
  return response.text();
}

async function request(kind, params, signal) {
  const mode = transport;
  const proxy = () => fetchText(new URL(`./api/${kind}?${new URLSearchParams(params)}`, document.baseURI), signal);
  if (mode === 'proxy' || (mode === 'auto' && (proxyUntil.get(kind) || 0) > Date.now())) {
    const text = await proxy(); onTransport('proxy'); return text;
  }
  try {
    const text = await fetchText(upstream(kind, params), signal);
    onTransport('direct'); return text;
  } catch (error) {
    if (signal?.aborted || mode === 'direct') throw error;
    try {
      const text = await proxy(); proxyUntil.set(kind, Date.now() + 300000); onTransport('proxy'); return text;
    } catch { throw new Error('EMT cannot be reached. Check the connection; if CORS is blocked, start the server with npm start.'); }
  }
}

function cached(key, ttl, load) {
  const old = cache.get(key);
  if (old && old.until > Date.now()) return old.promise;
  const promise = load().catch(error => { cache.delete(key); throw error; });
  cache.set(key, { promise, until: Date.now() + ttl });
  return promise;
}

export async function getFeatures(layer, params = {}) {
  const text = await request('wfs', {
    service: 'wfs', version: '1.1.0', request: 'GetFeature', outputFormat: 'json',
    srsName: 'EPSG:4326', typeName: `emt:${layer}`, ...params,
  });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`EMT returned invalid geographic data (${layer}).`); }
  if (!Array.isArray(data.features)) throw new Error(`EMT layer unavailable: ${layer}`);
  if (Number(data.totalFeatures) > data.features.length) throw new Error(`Layer ${layer} is incomplete; try again.`);
  return data;
}

export function getNetwork() {
  return cached('network', 3600000, async () => {
    const [stops, lines] = await Promise.all([getFeatures('Paradas'), getFeatures('Lineas')]);
    return {
      stops: stops.features.filter(f => f.geometry?.type === 'Point').map(f => ({
        id: String(f.properties.ID_PARADAS), name: f.properties.DENOMINACION, coords: f.geometry.coordinates,
      })),
      lines: lines.features.map(f => f.properties),
    };
  });
}

export function getRoute(subline) {
  const now = madridParts();
  const date = `${now.year}-${now.month}-${now.day}`;
  const bucket = `${date}-${now.hour}-${Math.floor(Number(now.minute) / 10)}`;
  // Limit retained time buckets for long-running map sessions.
  for (const [key, value] of cache) if (value.until < Date.now()) cache.delete(key);
  return cached(`route:${subline}:${bucket}`, 600000, () => getFeatures('Tramos_Vigentes', {
    viewparams: `p_linea:${Number(subline)};p_fecha:'${date}';p_hora:'${now.hour}${now.minute}'`,
  }));
}

export async function getArrivals(stop, signal) {
  const xml = await request('sae', {
    sec: 'getSAE', parada: stop, adaptados: 'false', idioma: 'es', nocache: crypto.randomUUID(),
  }, signal);
  return parseArrivals(xml);
}
