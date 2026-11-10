import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, measurePath, pointAt, buildRoutes, approachForStop, approachForPosition, positionOnApproach, estimatePosition, segmentNodes, nodeStop } from '../public/js/geo.js';
import { adjustedArrivalAt, parseMinutes, reconcileArrivals } from '../public/js/arrivals.js';

const a = [-0.38, 39.47], b = [-0.37, 39.47], c = [-0.36, 39.47];
const segment = (id, from, to, coords, suppressed = 0) => ({ type: 'Feature', properties: { UNIQUE_ID: id, IDTRAMO: `${from}${to}`, TRAMO_SUPRIMIDO: suppressed }, geometry: { type: 'LineString', coordinates: coords } });
const info = { ID_SUBLINEA: 31, TOPOLOGIA: 'general', PINI_I: 1, PFIN_I: 3, PINI_V: 3, PFIN_V: 1 };

test('meters are measured along the route, not the straight line to the stop', () => {
  const bend = [-0.37, 39.48], path = measurePath([a, bend, c]);
  assert.ok(path.length > distance(a, c));
  assert.deepEqual(pointAt(path, 0), a);
  assert.deepEqual(pointAt(path, path.length), c);
  assert.equal(pointAt(path, -1), null);
  assert.equal(pointAt(path, path.length + 1), null);
});

test('IDTRAMO decodes real stop IDs including leading zeros and platform suffix', () => {
  const nodes = segmentNodes('P00016602P00016701');
  assert.deepEqual(nodes, ['P00016602', 'P00016701']);
  assert.equal(nodeStop(nodes[1]), '167');
  assert.equal(nodeStop('L00034702'), null);
});

test('sorts segments, preserves continuous termini and selects the exact stop', () => {
  const model = buildRoutes({ features: [
    segment(3, 'P00000301', 'P00000401', [c, [-0.37, 39.471]]),
    segment(2, 'P00000201', 'P00000301', [b, c]),
    segment(1, 'P00000101', 'P00000201', [a, b]),
  ] }, info);
  assert.equal(model.paths.length, 1);
  assert.equal(model.paths[0].legBoundaries.length, 2);
  const approach = approachForStop([model], { id: '2', coords: b });
  assert.ok(approach);
  assert.deepEqual(positionOnApproach(approach, 0), b);
  assert.equal(positionOnApproach(approach, approach.offset + 1), null);
  assert.equal(approachForStop([model], { id: '999', coords: b }), null);
});

test('suppressed segments and gaps never create imaginary street-spanning edges', () => {
  const model = buildRoutes({ features: [
    segment(1, 'P00000101', 'P00000201', [a, b]),
    segment(2, 'P00000201', 'P00000301', [b, c], 1),
    segment(3, 'P00000301', 'P00000401', [c, [-0.35, 39.47]]),
  ] }, info);
  assert.equal(model.paths.length, 2);
  const approach = approachForStop([model], { id: '4', coords: [-0.35, 39.47] });
  assert.equal(positionOnApproach(approach, approach.offset + 5), null);
});

test('stop approaches extend across uniquely connected route fragments', () => {
  const d = [-0.39, 39.47], e = [-0.4, 39.47];
  const model = buildRoutes({ features: [
    segment(1, 'P00000101', 'P00000201', [a, b]),
    segment(2, 'P00000401', 'P00000501', [d, e]),
    segment(3, 'P00000301', 'P00000101', [c, a]),
  ] }, info);
  const approach = approachForStop([model], { id: '2', coords: b });
  const now = 100000;
  const arrival = { observedAt: now, arrivalAt: now + 5 * 60000, programmed: false };
  assert.ok(approach.offset > model.paths[0].length);
  assert.ok(estimatePosition(approach, arrival, now, 12));
});

test('closed service cycles wrap once while open paths do not', () => {
  const path = measurePath([a, b, [-0.37, 39.48], a]);
  path.circular = true;
  const approach = { path, offset: 50 };
  assert.ok(positionOnApproach(approach, 100));
  assert.equal(positionOnApproach(approach, path.length + 1), null);
  path.circular = false;
  assert.equal(positionOnApproach(approach, 100), null);
});

test('a general outbound-return route can estimate a vehicle before the previous terminus', () => {
  const d = [-0.36, 39.48];
  const closedInfo = { ...info, PINI_I: 1, PFIN_I: 3, PINI_V: 3, PFIN_V: 1 };
  const model = buildRoutes({ features: [
    segment(1, 'P00000101', 'P00000201', [a, b]),
    segment(2, 'P00000201', 'P00000301', [b, c]),
    segment(3, 'P00000301', 'P00000401', [c, d]),
    segment(4, 'P00000401', 'P00000101', [d, a]),
  ] }, closedInfo);
  assert.equal(model.paths.length, 1);
  assert.equal(model.paths[0].circular, true);
  const approach = approachForStop([model], { id: '2', coords: b });
  const beforeTerminus = positionOnApproach(approach, approach.offset + 100);
  assert.ok(beforeTerminus);
  assert.ok(distance(beforeTerminus, model.paths[0].coords.at(-1)) < model.paths[0].length);
  assert.equal(positionOnApproach(approach, model.paths[0].length + 1), null);
});

test('animation advances toward stop and expires stale, programmed and passed arrivals', () => {
  const path = measurePath([a, b, c]), approach = { path, offset: path.length };
  const arrival = { observedAt: 100000, arrivalAt: 160000, programmed: false };
  const first = estimatePosition(approach, arrival, 100000, 12);
  const next = estimatePosition(approach, arrival, 110000, 12);
  assert.ok(distance(next, c) < distance(first, c));
  assert.equal(estimatePosition(approach, arrival, 191000, 12), null);
  assert.equal(estimatePosition(approach, { ...arrival, programmed: true }, 100000, 12), null);
  assert.equal(estimatePosition(approach, arrival, 176000, 12), null);
});

test('zero-minute estimates keep the vehicle 30 seconds before the stop', () => {
  const path = measurePath([a, b, c]), approach = { path, offset: path.length };
  const now = 100000;
  const position = estimatePosition(approach, { observedAt: now, arrivalAt: now, programmed: false }, now, 12);
  assert.ok(position);
  assert.ok(Math.abs(distance(position, c) - 100) < 1);
});

test('reported vehicle position adjusts an inflated ETA only on its approaching route', () => {
  const stops = [{ id: '1', coords: a }, { id: '2', coords: b }, { id: '3', coords: c }];
  const models = [{ ...buildRoutes({ features: [segment(1, 'P00000101', 'P00000201', [a, b]), segment(2, 'P00000201', 'P00000301', [b, c])] }, info), allowEstimate: true }];
  const coords = [-0.375, 39.47];
  const approach = approachForPosition(models, stops[1], coords);
  const away = approachForPosition([{ ...buildRoutes({ features: [segment(1, 'P00000301', 'P00000201', [c, b]), segment(2, 'P00000201', 'P00000101', [b, a])] }, info), allowEstimate: true }], stops[1], coords);
  assert.ok(approach.vehicleDistance > 0);
  assert.equal(away, null);
  const arrival = { observedAt: 100000, arrivalAt: 100000 + 74 * 60000, position: { receivedAt: 100000 } };
  const adjusted = adjustedArrivalAt(arrival, approach, 100000, 20);
  assert.ok(adjusted < arrival.arrivalAt);
  assert.equal(adjustedArrivalAt(arrival, approach, 200000, 20), arrival.arrivalAt);
});

test('ETA formats, Europe/Madrid midnight and invalid times', () => {
  assert.deepEqual(parseMinutes('Pròxim'), { seconds: 60, programmed: false });
  assert.equal(parseMinutes('3 min.').seconds, 180);
  assert.equal(parseMinutes('1,5 min').seconds, 90);
  assert.equal(parseMinutes('00:05', Date.parse('2026-09-14T21:55:00Z')).seconds, 600);
  assert.equal(parseMinutes('16:05', Date.parse('2026-09-14T14:00:00Z')).programmed, true);
  assert.equal(parseMinutes('25:99'), null);
  assert.equal(parseMinutes('Sin servicio'), null);
});

test('reconciliation is one-to-one and does not turn second bus into departed first bus', () => {
  const old = [{ id: 'first', line: '31', destination: 'Port', arrivalAt: 100000 }, { id: 'second', line: '31', destination: 'Port', arrivalAt: 700000 }];
  const incoming = [{ line: '31', destination: 'Port', arrivalAt: 720000 }, { line: '31', destination: 'Port', arrivalAt: 1400000 }];
  const result = reconcileArrivals(old, incoming);
  assert.equal(result[0].id, 'second');
  assert.notEqual(result[1].id, 'first');
  assert.notEqual(result[0].id, result[1].id);
});
