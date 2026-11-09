import { JSDOM } from 'jsdom';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dispatchProvider } from './gateway.mjs';
import { madridParts, parseArrivals } from '../public/js/arrivals.js';
import { buildRoutes } from '../public/js/geo.js';
import { parseAtmvArrivals } from '../public/js/services/atmv.js';
import { extractMapValue, parseMetroArrivals } from '../public/js/services/metro.js';
import { parseRenfeArrivals } from '../public/js/services/cercanias.js';
import { arrivalEntity, lineEntity, stationEntity } from './adapters.mjs';

const Parser = new JSDOM('').window.DOMParser;
const cache = new Map();
const cacheDir = process.env.CACHE_DIR || '';
const atmvQueue = [];
let activeAtmv = 0;
const sources = {
  emt: 'https://geoportal.emtvalencia.es/visor?lang=es',
  atmv: 'https://metgovalencia.com/',
  metro: 'https://www.metrovalencia.es/es/consulta-mapas/',
  cercanias: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
  valenbisi: 'https://www.valenbisi.es/es/mapping',
};

function cachePath(key) {
  return join(cacheDir, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

async function readPersistent(key, ttl) {
  if (!cacheDir) return null;
  try {
    const stored = JSON.parse(await readFile(cachePath(key), 'utf8'));
    if (!stored || Date.now() >= stored.expiresAt || !stored.value) return null;
    return stored.value;
  } catch { return null; }
}

async function writePersistent(key, value, ttl) {
  if (!cacheDir) return;
  const file = cachePath(key), temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify({ expiresAt: Date.now() + ttl, value }));
    await rename(temporary, file);
  } catch { /* A disk cache is an optimization; memory remains authoritative. */ }
}

function cached(key, ttl, load, { persist = false } = {}) {
  const now = Date.now();
  for (const [entry, value] of cache) if (value.until <= now) cache.delete(entry);
  if (!cache.has(key)) {
    if (cache.size >= 300) cache.delete(cache.keys().next().value);
    const promise = (persist ? readPersistent(key, ttl).then(value => value || load().then(result => writePersistent(key, result, ttl).then(() => result))) : load())
      .catch(error => { cache.delete(key); throw error; });
    cache.set(key, { until: now + ttl, promise });
  }
  return cache.get(key).promise;
}

async function request(operator, path, params = {}) {
  if (operator !== 'atmv') return (await dispatchProvider(operator, path, new URLSearchParams(params))).text;
  if (activeAtmv >= 4) await new Promise(resolve => atmvQueue.push(resolve));
  else activeAtmv++;
  try { return (await dispatchProvider(operator, path, new URLSearchParams(params))).text; }
  finally { if (atmvQueue.length) atmvQueue.shift()(); else activeAtmv--; }
}
async function json(operator, path, params) {
  return JSON.parse(await request(operator, path, params));
}
async function wfs(layer, params = {}) {
  const result = await json('emt', 'wfs', { typeName: `emt:${layer}`, ...params });
  if (!Array.isArray(result.features) || Number(result.totalFeatures) > result.features.length) throw new Error('Incomplete EMT layer');
  return result;
}
export function getNetwork(operator) {
  const ttl = operator === 'cercanias' ? 43200000 : operator === 'valenbisi' ? 45000 : 3600000;
  return cached(`network:${operator}`, ttl, async () => {
    let stops, lines, extra = {};
    if (operator === 'emt') {
      const [stopData, lineData] = await Promise.all([wfs('Paradas'), wfs('Lineas')]);
      stops = stopData.features.filter(feature => feature.geometry?.type === 'Point').map(feature => ({ id: String(feature.properties.ID_PARADAS), name: feature.properties.DENOMINACION, coords: feature.geometry.coordinates }));
      const groups = new Map();
      for (const feature of lineData.features) {
        const info = feature.properties, id = String(info.ID_PUBLICO);
        if (!groups.has(id)) groups.set(id, { id, name: info.NOMBRE_LINEA, variants: [] });
        groups.get(id).variants.push(info);
      }
      lines = [...groups.values()];
    } else if (operator === 'atmv') {
      const [stopData, routes] = await Promise.all([json(operator, 'old/stops'), json(operator, 'old/routes')]);
      stops = stopData.map(item => ({ id: String(item.stop_code), name: item.stop_name, coords: [Number(item.stop_lon), Number(item.stop_lat)] }));
      const groups = new Map();
      for (const route of routes) {
        const id = String(route.route_short_name);
        if (!groups.has(id)) groups.set(id, { id, name: route.route_long_name, variants: [] });
        groups.get(id).variants.push(route);
      }
      lines = [...groups.values()];
    } else if (operator === 'metro') {
      const html = await request(operator, 'network');
      const coords = extractMapValue(html, 'estaciones'), info = extractMapValue(html, 'infoEstaciones');
      const paths = extractMapValue(html, 'lineas'), colors = extractMapValue(html, 'coloresLineas');
      if (coords.length !== info.length) throw new Error('Metro station data is incomplete');
      stops = info.map((item, index) => ({ id: String(item.id), name: item.nombre, coords: [coords[index].lng, coords[index].lat], lines: item.lineas.map(value => String(value.id)) }));
      const publicLines = new Map(info.flatMap(item => item.lineas.map(value => [String(value.id), value])));
      lines = [...publicLines].map(([id, value]) => ({ id, name: `Línea ${id}`, color: `#${value.color}`, features: Object.entries(paths).filter(([key]) => colors[key] === value.color).map(([, points]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map(point => [point.lng, point.lat]) } })) }));
    } else if (operator === 'cercanias') {
      extra = await json(operator, 'network');
      ({ stops, lines } = extra);
    } else if (operator === 'valenbisi') {
      const result = await json(operator, 'stations');
      stops = result.stations;
      lines = [];
    } else throw Object.assign(new Error('Operator not found'), { status: 404 });
    if (!Array.isArray(stops) || !Array.isArray(lines)) throw new Error('Invalid network data');
    return { stops, lines, extra, fetchedAt: Date.now() };
  }, { persist: true });
}

export async function getStopStatus(operator, stopId) {
  const network = await getNetwork(operator);
  const selected = network.stops.find(item => String(item.id) === stopId);
  if (!selected) throw Object.assign(new Error('Stop not found'), { status: 404 });
  return {
    operator, id: String(selected.id), name: selected.name,
    capacity: selected.capacity ?? null, availableBikes: selected.availableBikes ?? null,
    availableDocks: selected.availableDocks ?? null, status: selected.status ?? null,
    lastUpdated: selected.lastUpdated ? new Date(selected.lastUpdated).toISOString() : null,
  };
}

export async function listNetwork(operator, kind) {
  const network = await getNetwork(operator);
  return { data: kind === 'stops' ? network.stops.map(item => stationEntity(operator, item)) : network.lines.map(item => lineEntity(operator, item)), meta: { source: sources[operator], fetchedAt: new Date(network.fetchedAt).toISOString() } };
}

export async function getRoutes(operator, lineId) {
  const network = await getNetwork(operator);
  const item = network.lines.find(value => String(value.id) === lineId);
  if (!item) throw Object.assign(new Error('Line not found'), { status: 404 });
  const result = await cached(`routes:${operator}:${lineId}`, 600000, async () => {
    const fetchedAt = new Date().toISOString();
    if (operator === 'emt') {
      const now = madridParts();
      const data = await Promise.all(item.variants.map(async variant => {
        const viewparams = `p_linea:${Number(variant.ID_SUBLINEA)};p_fecha:'${now.year}-${now.month}-${now.day}';p_hora:'${now.hour}${now.minute}'`;
        const model = buildRoutes(await wfs('Tramos_Vigentes', { viewparams }), variant);
        return { id: String(variant.ID_SUBLINEA), direction: null, concession: null, stopIds: [...model.stopIds], geometry: { type: 'FeatureCollection', features: model.features }, serviceToday: null };
      }));
      return { data, fetchedAt };
    }
    if (operator === 'atmv') {
      const results = await Promise.allSettled(item.variants.flatMap(variant => [0, 1].map(async direction => {
        const params = { direction: String(direction), concesion: variant.concesion };
        const [shape, stops] = await Promise.all([json(operator, `routes/${encodeURIComponent(variant.route_id)}/shapes/`, params), json(operator, `routes/${encodeURIComponent(variant.route_id)}/stops`, params)]);
        return { id: String(variant.route_id), direction, concession: variant.concesion, stopIds: (stops.stops || []).map(value => String(value.stop_code)), geometry: { type: 'FeatureCollection', features: shape.features || [] }, serviceToday: shape.noServiceToday ? false : null };
      })));
      const data = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      if (!data.length) throw new Error('No ATMV route variants available');
      return { data, fetchedAt, failedVariants: results.length - data.length };
    }
    return { data: [{ id: lineId, direction: null, concession: null, stopIds: null, geometry: { type: 'FeatureCollection', features: item.features || [] }, serviceToday: null }], fetchedAt };
  });
  return { data: result.data, meta: { source: sources[operator], fetchedAt: result.fetchedAt, ...(result.failedVariants ? { failedVariants: result.failedVariants } : {}) } };
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}
export async function getStopArrivals(operator, stopId) {
  const network = await getNetwork(operator);
  const selected = network.stops.find(item => String(item.id) === stopId);
  if (!selected) throw Object.assign(new Error('Stop not found'), { status: 404 });
  const result = await cached(`arrivals:${operator}:${stopId}`, operator === 'emt' || operator === 'cercanias' ? 20000 : 25000, async () => {
    let arrivals, feedAt = null;
    if (operator === 'valenbisi') arrivals = [];
    else if (operator === 'emt') arrivals = parseArrivals(await request(operator, 'sae', { parada: stopId }), Date.now(), Parser);
    else if (operator === 'atmv') arrivals = parseAtmvArrivals(await json(operator, `estimacion/ocupacion/${encodeURIComponent(stopId)}`));
    else if (operator === 'metro') arrivals = parseMetroArrivals(await json(operator, 'arrivals', { stop: stopId }), Date.now(), Parser);
    else {
      const [positions, updates] = await Promise.all([json(operator, 'positions'), json(operator, 'updates')]);
      arrivals = parseRenfeArrivals(positions, updates, selected, network.extra);
      feedAt = iso(Number(positions.header?.timestamp) * 1000);
    }
    return { data: arrivals.map(value => arrivalEntity(operator, value)), meta: { source: sources[operator], fetchedAt: new Date().toISOString(), positions: operator === 'emt' || operator === 'metro' || operator === 'valenbisi' ? 'not_published' : 'partial', ...(feedAt ? { feedAt } : {}) } };
  });
  if (operator !== 'cercanias') return result;
  const now = Date.now();
  if (now - Date.parse(result.meta.feedAt) > 90000 || result.data.some(item => item.observedAt && now - Date.parse(item.observedAt) > 90000)) throw new Error('Renfe feed is stale');
  return { ...result, data: result.data.map(item => item.position?.measuredAt && now - Date.parse(item.position.measuredAt) > 90000 ? { ...item, position: null } : item) };
}