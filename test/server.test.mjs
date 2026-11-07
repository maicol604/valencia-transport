import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { createServer, upstreamURL } from '../server.mjs';

const contract = parseYaml(await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: 'urn:transit:contract', components: contract.components });
function conforms(name, value) {
  const validate = ajv.getSchema(`urn:transit:contract#/components/schemas/${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`);
}

test('proxy accepts only fixed EMT services and validated parameters', () => {
  assert.throws(() => upstreamURL('sae', new URLSearchParams({ parada: '167;DROP' })));
  assert.throws(() => upstreamURL('wfs', new URLSearchParams({ typeName: 'emt:private' })));
  assert.throws(() => upstreamURL('http://example.com', new URLSearchParams()));
  const url = upstreamURL('sae', new URLSearchParams({ parada: '167', url: 'http://localhost' }));
  assert.equal(url.hostname, 'geoportal.emtvalencia.es');
  assert.equal(url.searchParams.get('parada'), '167');
  assert.ok(url.searchParams.get('nocache'));
});

test('serves frontend, rejects proxy misuse, never exposes source or dotfiles', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/sae?parada=bad`)).status, 400);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('versioned API fails closed and authenticates without changing legacy routes', async t => {
  const oldKeys = process.env.API_KEYS;
  delete process.env.API_KEYS;
  t.after(() => { if (oldKeys === undefined) delete process.env.API_KEYS; else process.env.API_KEYS = oldKeys; });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/operators`)).status, 503);
  process.env.API_KEYS = 'first-secret,second-secret';
  assert.equal((await fetch(`${base}/api/v1/operators`)).status, 401);
  const response = await fetch(`${base}/api/v1/operators`, { headers: { 'X-API-Key': 'second-secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(operator => operator.id), ['emt', 'atmv', 'metro', 'cercanias']);
  assert.equal((await fetch(`${base}/api/sae?parada=bad`)).status, 400);
});

test('versioned API normalizes a remote provider and protects cross-origin access', async t => {
  const remote = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/old/stops') return res.end(JSON.stringify([{ stop_code: 77, stop_name: 'Centre', stop_lon: '-0.4', stop_lat: '39.5' }]));
    if (req.url === '/old/routes') return res.end(JSON.stringify([{ route_short_name: '161A', route_long_name: 'Quart', route_id: 106, concesion: 'CV106' }, { route_short_name: '161A', route_long_name: 'Quart', route_id: 107, concesion: 'CV106' }]));
    if (req.url === '/estimacion/ocupacion/77') return res.end(JSON.stringify([{ line: '161A', route: 'Quart', estimations: [{ vehicleId: 123, minutesToArrival: 2, almex: { longitude: '-0.4', latitude: '39.5' } }] }]));
    if (req.url.startsWith('/routes/107/') && req.url.includes('direction=1')) { res.writeHead(500); return res.end(); }
    if (req.url.startsWith('/routes/') && req.url.includes('/shapes/')) return res.end(JSON.stringify({ features: [], noServiceToday: true }));
    if (req.url.startsWith('/routes/') && req.url.includes('/stops')) return res.end(JSON.stringify({ stops: [{ stop_code: 77 }] }));
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const previous = { API_KEYS: process.env.API_KEYS, API_CORS_ORIGINS: process.env.API_CORS_ORIGINS, ATMV_SERVICE_URL: process.env.ATMV_SERVICE_URL };
  process.env.API_KEYS = 'fixture-key';
  process.env.API_CORS_ORIGINS = 'https://client.example';
  process.env.ATMV_SERVICE_URL = `http://127.0.0.1:${remote.address().port}`;
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => remote.close(resolve))]);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const headers = { 'X-API-Key': 'fixture-key', Origin: 'https://client.example' };
  const options = await fetch(`${base}/operators`, { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), 'https://client.example');
  assert.equal((await fetch(`${base}/operators`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  const stops = await fetch(`${base}/operators/atmv/stops?limit=1`, { headers });
  assert.equal(stops.headers.get('access-control-allow-origin'), 'https://client.example');
  const stopResult = await stops.json();
  assert.deepEqual(stopResult.data[0].location.coordinates, [-0.4, 39.5]);
  conforms('Stop', stopResult.data[0]);
  conforms('PageMetadata', stopResult.meta);
  const lines = await (await fetch(`${base}/operators/atmv/lines`, { headers })).json();
  assert.equal(lines.data.length, 1);
  conforms('Line', lines.data[0]);
  const routes = await (await fetch(`${base}/operators/atmv/lines/161A/routes`, { headers })).json();
  assert.equal(routes.data.length, 3);
  assert.equal(routes.meta.failedVariants, 1);
  assert.equal(routes.data[0].serviceToday, false);
  conforms('Route', routes.data[0]);
  const arrivals = await (await fetch(`${base}/operators/atmv/stops/77/arrivals`, { headers })).json();
  assert.equal(arrivals.data[0].position.kind, 'reported');
  assert.equal(arrivals.data[0].position.measuredAt, null);
  conforms('Arrival', arrivals.data[0]);
  conforms('RealtimeMetadata', arrivals.meta);
  const vehicles = await (await fetch(`${base}/operators/atmv/stops/77/vehicles`, { headers })).json();
  assert.equal(vehicles.data[0].vehicleId, '123');
  conforms('Vehicle', vehicles.data[0]);
  const cachedArrivals = await (await fetch(`${base}/operators/atmv/stops/77/arrivals`, { headers })).json();
  assert.equal(cachedArrivals.data[0].kind, 'realtime');
  assert.equal((await fetch(`${base}/operators/atmv/stops?limit=0`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/operators/atmv/stops/unknown`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/operators`, { method: 'HEAD', headers })).status, 200);
  assert.match(await (await fetch(`${base}/openapi.yaml`, { headers })).text(), /openapi: 3\.1\.0/);
});

test('versioned API normalizes EMT, Metro and Cercanias fixtures', async t => {
  const now = Math.floor(Date.now() / 1000);
  const remote = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/wfs') {
      const layer = url.searchParams.get('typeName');
      const features = layer === 'emt:Paradas' ? [{ geometry: { type: 'Point', coordinates: [-0.38, 39.47] }, properties: { ID_PARADAS: 167, DENOMINACION: 'Centre' } }] : [{ properties: { ID_PUBLICO: '31', ID_SUBLINEA: 31, NOMBRE_LINEA: 'Port' } }];
      return res.end(JSON.stringify({ features, totalFeatures: features.length }));
    }
    if (url.pathname === '/sae') return res.end('<estimacion><solo_parada><bus><linea>31</linea><destino>Port</destino><minutos>3 min.</minutos></bus></solo_parada></estimacion>');
    if (url.pathname === '/metro/network') return res.end('var datosMapaGeneral = { estaciones: [{"lng":-0.38,"lat":39.47}], infoEstaciones: [{"id":26,"nombre":"Facultats","lineas":[{"id":3,"color":"ed1222"}]}], lineas: {"3":[{"lng":-0.38,"lat":39.47},{"lng":-0.39,"lat":39.48}]}, coloresLineas: {"3":"ed1222"} };');
    if (url.pathname === '/metro/arrivals') return res.end(JSON.stringify({ html: '<div class="item--proximos"><span class="linea-3"></span><span class="nombre-estacion">Rafelbunyol</span><span class="estacion__espera">2 min</span></div>' }));
    if (url.pathname === '/renfe/network') return res.end(JSON.stringify({ stops: [{ id: 'B', name: 'Nord', coords: [-0.38, 39.47], lines: ['C1'] }], lines: [{ id: 'C1', name: 'C1', features: [] }], trips: { trip1: { line: 'C1', destination: 'Nord', stops: ['B'] } } }));
    if (url.pathname === '/renfe/positions') return res.end(JSON.stringify({ header: { timestamp: now }, entity: [{ vehicle: { trip: { tripId: 'trip1' }, timestamp: now - 85, stopId: 'B', position: { latitude: 39.47, longitude: -0.38 }, vehicle: { id: 'v1' } } }] }));
    if (url.pathname === '/renfe/updates') return res.end(JSON.stringify({ header: { timestamp: now }, entity: [{ tripUpdate: { trip: { tripId: 'trip1' }, stopTimeUpdate: [{ stopId: 'B', arrival: { time: now + 120 } }] } }] }));
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const previous = Object.fromEntries(['API_KEYS', 'EMT_SERVICE_URL', 'METRO_SERVICE_URL', 'CERCANIAS_SERVICE_URL'].map(key => [key, process.env[key]]));
  const remoteUrl = `http://127.0.0.1:${remote.address().port}`;
  Object.assign(process.env, { API_KEYS: 'fixture-other-key', EMT_SERVICE_URL: remoteUrl, METRO_SERVICE_URL: `${remoteUrl}/metro/`, CERCANIAS_SERVICE_URL: `${remoteUrl}/renfe/` });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => remote.close(resolve))]);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/operators`;
  const get = async path => {
    const response = await fetch(`${base}/${path}`, { headers: { 'X-API-Key': 'fixture-other-key' } });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const emt = (await get('emt/stops/167/arrivals')).data[0];
  assert.equal(emt.lineId, '31');
  conforms('Arrival', emt);
  assert.equal((await get('emt/stops/167/vehicles')).meta.positions, 'not_published');
  assert.equal((await get('metro/stops/26')).data.name, 'Facultats');
  const metro = (await get('metro/stops/26/arrivals')).data[0];
  assert.equal(metro.destination, 'Rafelbunyol');
  conforms('Arrival', metro);
  const vehicle = (await get('cercanias/stops/B/vehicles')).data[0];
  assert.equal(vehicle.position.kind, 'gps');
  assert.equal(vehicle.position.measuredAt, new Date((now - 85) * 1000).toISOString());
  conforms('Vehicle', vehicle);
  t.mock.method(Date, 'now', () => (now + 10) * 1000);
  assert.equal((await get('cercanias/stops/B/vehicles')).data.length, 0, 'cached GPS expires at 90 seconds');
});

test('versioned API enforces a per-key rate limit and returns structured errors', async t => {
  const oldKeys = process.env.API_KEYS, oldLimit = process.env.API_RATE_LIMIT;
  process.env.API_KEYS = 'rate-test-key'; process.env.API_RATE_LIMIT = '1';
  t.after(() => {
    if (oldKeys === undefined) delete process.env.API_KEYS; else process.env.API_KEYS = oldKeys;
    if (oldLimit === undefined) delete process.env.API_RATE_LIMIT; else process.env.API_RATE_LIMIT = oldLimit;
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/operators`;
  const headers = { 'X-API-Key': 'rate-test-key' };
  assert.equal((await fetch(url, { headers })).status, 200);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  conforms('Error', await response.json());
});
