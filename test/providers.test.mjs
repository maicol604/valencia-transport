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
