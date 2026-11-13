import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getRoutes, getStopArrivals, getStopStatus, listNetwork } from './api-data.mjs';
import { vehicleEntity } from './adapters.mjs';
import { getHistoryPool, readAvailabilityHistory } from './history/store.mjs';
import { parseAvailabilityHistoryQuery } from './history/query.mjs';

const operators = [
  { id: 'emt', name: 'EMT València', mode: 'bus' },
  { id: 'atmv', name: 'ATMV · Met Go', mode: 'bus' },
  { id: 'metro', name: 'Metrovalencia', mode: 'rail' },
  { id: 'cercanias', name: 'Cercanías', mode: 'rail' },
  { id: 'valenbisi', name: 'Valenbisi', mode: 'bike' },
];
const limits = new Map();

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export async function handleApiV1(req, res, url) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
  const origin = req.headers.origin;
  const origins = (process.env.API_CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origin) res.setHeader('Vary', 'Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    if (!origin || !origins.includes(origin)) return send(403, { error: { code: 'origin_forbidden', message: 'Origin not allowed.' } });
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'X-API-Key, Content-Type', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (!['GET', 'HEAD'].includes(req.method)) return send(405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, { Allow: 'GET, HEAD, OPTIONS' });
  const keys = (process.env.API_KEYS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!keys.length) return send(503, { error: { code: 'api_not_configured', message: 'API keys are not configured.' } });
  const supplied = digest(typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');
  if (!keys.map(key => timingSafeEqual(digest(key), supplied)).some(Boolean)) return send(401, { error: { code: 'unauthorized', message: 'A valid API key is required.' } });
  const maxRequests = Number(process.env.API_RATE_LIMIT || 120);
  const limit = Number.isSafeInteger(maxRequests) && maxRequests > 0 ? maxRequests : 120;
  const now = Date.now(), keyId = supplied.toString('hex');
  for (const [id, entry] of limits) if (entry.resetAt <= now) limits.delete(id);
  if (!limits.has(keyId)) {
    if (limits.size >= 10000) limits.delete(limits.keys().next().value);
    limits.set(keyId, { count: 0, resetAt: now + 60000 });
  }
  const bucket = limits.get(keyId);
  if (++bucket.count > limit) return send(429, { error: { code: 'rate_limited', message: 'Rate limit exceeded.' } }, { 'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)) });
  try {
    if (url.pathname === '/api/v1/openapi.yaml') {
      const contract = await readFile(new URL('../docs/openapi.yaml', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : contract);
    }
    if (url.pathname === '/api/v1/operators/valenbisi/availability/history') {
      let query;
      try { query = parseAvailabilityHistoryQuery(url.searchParams); }
      catch (error) {
        if (error.status !== 400) throw error;
        return send(400, { error: { code: error.code, message: error.message } });
      }
      const pool = getHistoryPool();
      if (!pool) return send(503, { error: { code: 'history_not_configured', message: 'Availability history storage is not configured.' } });
      try { return send(200, await readAvailabilityHistory(pool, query)); }
      catch (error) {
        console.error(`Availability history API failed: ${error.stack || error.message}`);
        return send(503, { error: { code: 'history_unavailable', message: 'Availability history is temporarily unavailable.' } });
      }
    }
    const parts = url.pathname.split('/').slice(3).map(part => decodeURIComponent(part));
    if (parts.length === 1 && parts[0] === 'operators') return send(200, { data: operators });
    if (parts[0] !== 'operators' || !operators.some(item => item.id === parts[1])) return send(404, { error: { code: 'not_found', message: 'Resource not found.' } });
    const [, operator, resource, id, action] = parts;
    if (!['stops', 'lines'].includes(resource) || parts.length > 5 || (id && (!id.trim() || id.length > 100)) || (action && !id)) return send(404, { error: { code: 'not_found', message: 'Resource not found.' } });
    if (parts.length === 3) {
      const allowed = new Set(['q', 'limit', 'offset']);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key)) || [...allowed].some(key => url.searchParams.getAll(key).length > 1)) return send(400, { error: { code: 'invalid_query', message: 'Invalid query parameters.' } });
      const limitValue = url.searchParams.get('limit') ?? '100', offsetValue = url.searchParams.get('offset') ?? '0';
      if (!/^\d+$/.test(limitValue) || !/^\d+$/.test(offsetValue) || Number(limitValue) < 1 || Number(limitValue) > 500 || !Number.isSafeInteger(Number(offsetValue))) return send(400, { error: { code: 'invalid_query', message: 'Invalid pagination.' } });
      const result = await listNetwork(operator, resource);
      const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('es');
      const items = result.data.filter(item => !query || `${item.id} ${item.name}`.toLocaleLowerCase('es').includes(query)).sort((first, second) => first.id.localeCompare(second.id, 'en', { numeric: true }));
      const offset = Number(offsetValue), pageSize = Number(limitValue);
      return send(200, { data: items.slice(offset, offset + pageSize), meta: { ...result.meta, total: items.length, limit: pageSize, offset } });
    }
    if ([...url.searchParams].length) return send(400, { error: { code: 'invalid_query', message: 'Invalid query parameters.' } });
    if (parts.length === 4 && id) {
      const result = await listNetwork(operator, resource);
      const item = result.data.find(value => value.id === id);
      return item ? send(200, { data: item, meta: result.meta }) : send(404, { error: { code: 'not_found', message: 'Resource not found.' } });
    }
    if (parts.length === 5 && resource === 'stops' && action === 'status') return send(200, { data: await getStopStatus(operator, id), meta: { source: 'cached-network' } });
    if (parts.length === 5 && resource === 'lines' && action === 'routes') return send(200, await getRoutes(operator, id));
    if (parts.length === 5 && resource === 'stops' && ['arrivals', 'vehicles'].includes(action)) {
      const result = await getStopArrivals(operator, id);
      const data = action === 'vehicles' ? result.data.filter(item => item.position).map(item => vehicleEntity(operator, item)) : result.data;
      return send(200, { ...result, data });
    }
    return send(404, { error: { code: 'not_found', message: 'Resource not found.' } });
  } catch (error) {
    if (error instanceof URIError) return send(400, { error: { code: 'invalid_path', message: 'Invalid path.' } });
    if (error.status === 404) return send(404, { error: { code: 'not_found', message: 'Resource not found.' } });
    if (error.status === 429) return send(503, { error: { code: 'provider_rate_limited', message: 'The transport provider is temporarily unavailable.' } });
    return send(502, { error: { code: 'provider_unavailable', message: 'The transport provider could not be reached or returned invalid data.' } });
  }
}