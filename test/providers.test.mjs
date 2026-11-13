import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseAtmvArrivals } from '../public/js/services/atmv.js';
import { parseRenfeArrivals } from '../public/js/services/cercanias.js';
import { extractMapValue } from '../public/js/services/metro.js';
import { shapeModel, directedApproach } from '../public/js/services/shapes.js';
import { reconcileArrivals } from '../public/js/arrivals.js';
import { atmvURL } from '../services/atmv.mjs';
import { dispatchProvider } from '../services/gateway.mjs';
import { normalizeValenbisiBikes, normalizeValenbisiStations } from '../services/valenbisi.mjs';
import { resolveValenbisiStations } from '../services/valenbisi.mjs';
import { updateBikeDetails } from '../public/js/services/valenbisi.js';
import { arrivalEntity, lineEntity, stationEntity } from '../services/adapters.mjs';

test('Valenbisi normalizes the station response captured from the public page', () => {
  const result = normalizeValenbisiStations([{
    number: 7, name: 'Plaça de l’Ajuntament', position: { latitude: 39.4699, longitude: -0.3763 },
    totalStands: { capacity: 20, availabilities: { bikes: 8, stands: 12 } }, status: 'OPEN', lastUpdate: 1700000000000,
  }], 1700000001000);
  assert.deepEqual(result.stations[0], {
    id: '7', name: 'Plaça de l’Ajuntament', coords: [-0.3763, 39.4699], capacity: 20,
    availableBikes: 8, availableDocks: 12, status: 'open', lastUpdated: 1700000000000, sourceUpdatedAt: 1700000000000,
  });
});

test('Valenbisi preserves individual bike ratings and review state', () => {
  assert.deepEqual(normalizeValenbisiBikes({ bikes: [
    { number: 789, standNumber: 5, rating: { value: 100, count: 21 }, checked: false, status: 'AVAILABLE', statusLabel: 'Enganchada', lastRevisionDateTime: '2025-09-30T05:06:26' },
    { id: '3228', score: 3, isReviewed: true },
  ] }), [
    { id: '789', rating: 3, ratingValue: 100, ratingCount: 21, ratingMax: 3, reviewed: false, standNumber: 5, status: 'AVAILABLE', statusLabel: 'Enganchada', lastRevisionAt: '2025-09-30T05:06:26' },
    { id: '3228', rating: 3, ratingValue: 3, ratingCount: null, ratingMax: 3, reviewed: true, standNumber: null, status: null, statusLabel: null, lastRevisionAt: null },
  ]);
});

test('Valenbisi keeps the last successful bike details after a temporary failure', () => {
  const stop = { id: '262' };
  const previous = [{ id: '789', rating: 3 }];
  updateBikeDetails(stop, { bikes: previous, fetchedAt: 123 });
  updateBikeDetails(stop, null, new Error('HTTP 502'));
  assert.equal(stop.bikes, previous);
  assert.equal(stop.bikesStale, true);
  assert.equal(stop.bikesError, 'HTTP 502');
});

test('Valenbisi prefers the API and keeps the normalized provider shape', async () => {
  const apiResult = normalizeValenbisiStations([{ number: 8, name: 'API station', position: { latitude: 39.47, longitude: -.37 } }]);
  let fallbackCalled = false;
  const result = await resolveValenbisiStations({ api: async () => apiResult, fallback: async () => { fallbackCalled = true; return { stations: [] }; } });
  assert.deepEqual(result, apiResult);
  assert.equal(fallbackCalled, false);
});

test('Valenbisi falls back after API authorization or payload failures', async () => {
  const fallback = { stations: [{ id: 'fallback' }], fetchedAt: 1 };
  for (const api of [async () => { throw Object.assign(new Error('Unauthorized'), { status: 403 }); }, async () => { throw new Error('invalid station list'); }, async () => null]) {
    assert.deepEqual(await resolveValenbisiStations({ api, fallback: async () => fallback }), fallback);
  }
});

test('common transport entities use English, stable fields', () => {
  assert.deepEqual(stationEntity('metro', { id: 1, name: 'X', coords: [-.4, 39.4] }), {
    operator: 'metro', id: '1', name: 'X', location: { type: 'Point', coordinates: [-.4, 39.4] }, lineIds: null,
    capacity: null, availableBikes: null, availableDocks: null, status: null, lastUpdated: null,
  });
  assert.equal(lineEntity('emt', { id: 10 }).id, '10');
  assert.equal(arrivalEntity('emt', { line: 4, arrivalAt: 1000 }).kind, 'realtime');
});

test('Met Go separates reported coordinates from ETA estimates and keeps actual vehicle IDs', () => {
  const data = [{ line: '161A', route: 'Quart', estimations: [
    { vehicleId: 6313, minutesToArrival: 2, almex: { longitude: '-0.40', latitude: '39.47' } },
    { vehicleId: 6315, minutesToArrival: 10 },
    { vehicleId: 6316, minutesToArrival: -1 },
  ] }];
  const parsed = parseAtmvArrivals(data, 100000);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].position.kind, 'reported');
  assert.equal(parsed[0].position.timestamp, null, 'never invent a GPS timestamp');
  assert.equal(parsed[1].position, null);
  assert.equal(parsed[0].arrivalAt, 220000);
  const reconciled = reconcileArrivals([], parsed);
  assert.equal(reconciled[0].id, reconcileArrivals([], parseAtmvArrivals(data, 130000))[0].id);
});

test('embedded Metro map extraction parses JSON strings without executing scripts', () => {
  const html = 'var datosMapaGeneral = { estaciones: [{"name":"x } \\\" y", "coord":[1,2]}], lineas: {} }; evil();';
  assert.equal(extractMapValue(html, 'estaciones')[0].name, 'x } " y');
  assert.throws(() => extractMapValue('var datosMapaGeneral = { estaciones: evil() }', 'estaciones'));
});

test('Metro direction follows destination and refuses an unrecognized destination', () => {
  const stops = [{ id: '1', name: 'Sud', coords: [-.40, 39.47] }, { id: '2', name: 'Centre', coords: [-.39, 39.47] }, { id: '3', name: 'Nord', coords: [-.38, 39.47] }];
  const features = [{ geometry: { type: 'LineString', coordinates: stops.map(s => s.coords) } }];
  const model = shapeModel(features, stops);
  const north = directedApproach([model], stops[1], { destination: 'Nord' }, stops);
  const south = directedApproach([model], stops[1], { destination: 'Sud' }, stops);
  assert.deepEqual(north.path.coords[0], stops[0].coords);
  assert.deepEqual(south.path.coords[0], stops[2].coords);
  assert.equal(directedApproach([model], stops[1], { destination: 'Unknown' }, stops), null);
});

function feeds() {
  const now = 2000000;
  const positions = { header: { timestamp: '2000' }, entity: [{ vehicle: { trip: { tripId: 'valencia' }, timestamp: '1990', stopId: 'B', position: { latitude: 39.47, longitude: -.38 }, vehicle: { id: '24001' } } }] };
  const updates = { header: { timestamp: '2000' }, entity: [{ tripUpdate: { trip: { tripId: 'valencia' }, stopTimeUpdate: [{ stopId: 'B', arrival: { time: '2120' } }] } }] };
  const data = { trips: { valencia: { line: 'C1', destination: 'Nord', stops: ['A', 'B', 'C'] } } };
  return { now, positions, updates, data };
}

test('Renfe uses trip stop order, excludes passed/unrelated stations, never invents ETAs', () => {
  const { now, positions, updates, data } = feeds();
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'A' }, data, now).length, 0);
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'X' }, data, now).length, 0);
  const current = parseRenfeArrivals(positions, updates, { id: 'B' }, data, now)[0];
  assert.equal(current.position.kind, 'gps');
  assert.equal(current.position.timestamp, 1990000);
  assert.equal(current.arrivalAt, 2120000);
  const later = parseRenfeArrivals(positions, updates, { id: 'C' }, data, now)[0];
  assert.equal(later.arrivalAt, null);
  assert.equal(later.position.kind, 'gps');
});

test('Renfe rejects stale feeds and positions, cancellations and skipped stops', () => {
  const { now, positions, updates, data } = feeds();
  assert.throws(() => parseRenfeArrivals(positions, updates, { id: 'B' }, data, now + 100000));
  positions.entity[0].vehicle.timestamp = '1800';
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'B' }, data, now)[0].position, null);
  updates.entity[0].tripUpdate.stopTimeUpdate[0].scheduleRelationship = 'SKIPPED';
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'B' }, data, now).length, 0);
  updates.entity[0].tripUpdate.trip.scheduleRelationship = 'CANCELED';
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'C' }, data, now).length, 0);
});

test('Renfe rejects future feed timestamps and ambiguous repeated stops', () => {
  const { now, positions, updates, data } = feeds();
  positions.header.timestamp = String(now / 1000 + 31);
  assert.throws(() => parseRenfeArrivals(positions, updates, { id: 'B' }, data, now));
  positions.header.timestamp = String(now / 1000);
  data.trips.valencia.stops = ['A', 'B', 'C', 'B'];
  assert.equal(parseRenfeArrivals(positions, updates, { id: 'B' }, data, now).length, 0);
});

test('Renfe keeps fresh GPS in degraded mode when trip updates are stale', () => {
  const { now, positions, updates, data } = feeds();
  updates.header.timestamp = String((now - 100000) / 1000);
  const result = parseRenfeArrivals(positions, updates, { id: 'B' }, data, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].arrivalAt, null);
  assert.equal(result[0].position.kind, 'gps');
  assert.equal(result[0].observedAt, 2000000);
});

test('Met Go proxy validates concession and direction; gateway supports separate services', async t => {
  assert.throws(() => atmvURL('users', new URLSearchParams()));
  assert.throws(() => atmvURL('routes/106/stops', new URLSearchParams({ direction: '5', concesion: 'CV106' })));
  assert.equal(atmvURL('old/stops', new URLSearchParams({ url: 'http://evil' })).hostname, 'api.softoursistemas.com');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, provider: 'atmv' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.ATMV_SERVICE_URL;
  process.env.ATMV_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { if (old) process.env.ATMV_SERVICE_URL = old; else delete process.env.ATMV_SERVICE_URL; await new Promise(resolve => server.close(resolve)); });
  const response = await dispatchProvider('atmv', 'old/stops', new URLSearchParams());
  assert.equal(JSON.parse(response.text).provider, 'atmv');
  await assert.rejects(dispatchProvider('atmv', 'https://evil.example/', new URLSearchParams()));
});
