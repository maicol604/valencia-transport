import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeValenbisiStations } from '../services/valenbisi.mjs';
import { parseAvailabilityHistoryQuery } from '../services/history/query.mjs';
import { readAvailabilityHistory, saveAvailabilitySnapshot } from '../services/history/store.mjs';
import { collectionSlot, collectCollectionSlot, intervalFromEnvironment } from '../services/history/worker.mjs';

function fakePool({ rows = [], latest = [] } = {}) {
  const statements = [];
  const client = {
    async query(sql, params = []) { statements.push({ sql, params }); return { rows: [] }; },
    release() {},
  };
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('SELECT status FROM valenbisi_history_runs')) return { rows: [] };
      if (sql.includes('FROM valenbisi_availability_history')) return { rows };
      if (sql.includes('FROM valenbisi_history_runs ORDER BY')) return { rows: latest };
      return { rows: [] };
    },
    async connect() { return client; },
  };
}

test('Valenbisi stores a separate source timestamp and reports discarded stations', () => {
  const result = normalizeValenbisiStations([
    { number: 7, position: { latitude: 39.47, longitude: -.37 }, lastUpdate: 1700000000 },
    { number: 8, position: { latitude: 39.47 } },
  ], 1700000001000);
  assert.equal(result.stations[0].sourceUpdatedAt, 1700000000000);
  assert.equal(result.stations[0].lastUpdated, 1700000000000);
  assert.equal(result.stations[1], undefined);
  assert.equal(result.discardedStationCount, 1);
  const withoutSourceTime = normalizeValenbisiStations([{ number: 9, position: { latitude: 39.47, longitude: -.37 } }], 1234);
  assert.equal(withoutSourceTime.stations[0].sourceUpdatedAt, null);
  assert.equal(withoutSourceTime.stations[0].lastUpdated, 1234);
});

test('history query requires timezone-aware bounded pages and rejects malformed filters', () => {
  const query = parseAvailabilityHistoryQuery(new URLSearchParams({
    from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00+01:00',
    stationId: '007', limit: '5000', cursor: '123',
  }));
  assert.equal(query.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(query.stationId, '007');
  assert.equal(query.limit, 5000);
  assert.equal(query.cursor, '123');
  for (const params of [
    new URLSearchParams({ from: '2026-01-01', to: '2026-01-02T00:00:00Z' }),
    new URLSearchParams({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    new URLSearchParams({ from: '2026-02-31T00:00:00Z', to: '2026-03-02T00:00:00Z' }),
    new URLSearchParams({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', limit: '5001' }),
    new URLSearchParams([['from', '2026-01-01T00:00:00Z'], ['from', '2026-01-01T00:00:00Z'], ['to', '2026-01-02T00:00:00Z']]),
    new URLSearchParams({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', unknown: 'x' }),
  ]) assert.throws(() => parseAvailabilityHistoryQuery(params), { code: 'invalid_query', status: 400 });
});

test('history snapshots are committed as one idempotent slot and preserve missing metrics as null', async () => {
  const pool = fakePool();
  const slotAt = new Date('2026-01-01T12:00:00Z');
  const result = await saveAvailabilitySnapshot(pool, {
    slotAt, startedAt: new Date('2026-01-01T12:00:01Z'), capturedAt: new Date('2026-01-01T12:00:05Z'),
    stations: [{ id: '007', name: 'Station 7', coords: [-.37, 39.47], capacity: null, availableBikes: 0, availableDocks: null, status: 'open', sourceUpdatedAt: null }],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(pool.statements.filter(item => item.sql.includes('INSERT INTO valenbisi_availability_history'))[0].params.slice(4, 9), [null, 0, null, 'open', slotAt]);
  assert.equal(pool.statements[0].sql.includes('CREATE TABLE IF NOT EXISTS valenbisi_availability_history'), true);
  assert.equal(pool.statements.some(item => item.sql === 'COMMIT'), true);
  await assert.rejects(saveAvailabilitySnapshot(pool, {
    slotAt, startedAt: slotAt, capturedAt: slotAt,
    stations: [{ id: '7', coords: [-.37, 39.47] }, { id: '7', coords: [-.37, 39.47] }],
  }), /Duplicate Valenbisi station ID/);
});

test('history reads return UTC GeoJSON rows and stable cursor metadata', async () => {
  const pool = fakePool({
    rows: [
      { snapshot_id: '101', station_id: '7', station_name: 'Centre', longitude: -.37, latitude: 39.47, slot_at: new Date('2026-01-01T12:00:00Z'), captured_at: new Date('2026-01-01T12:00:03Z'), source_observed_at: null },
      { snapshot_id: '102', station_id: '8', station_name: 'Nord', longitude: -.38, latitude: 39.48, slot_at: new Date('2026-01-01T12:00:00Z'), captured_at: new Date('2026-01-01T12:00:03Z'), source_observed_at: null },
    ],
    latest: [{ slot_at: new Date('2026-01-01T12:00:00Z'), started_at: new Date('2026-01-01T12:00:00Z'), completed_at: new Date('2026-01-01T12:00:03Z'), status: 'completed', expected_station_count: 2, stored_station_count: 2, discarded_station_count: 0, error_message: null }],
  });
  const page = await readAvailabilityHistory(pool, {
    from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-02T00:00:00Z'),
    stationId: null, limit: 1, cursor: null,
  });
  assert.deepEqual(page.data[0].location, { type: 'Point', coordinates: [-.37, 39.47] });
  assert.equal(page.data[0].sourceObservedAt, null);
  assert.equal(page.meta.timezone, 'UTC');
  assert.equal(page.meta.hasMore, true);
  assert.equal(page.meta.nextCursor, '101');
  assert.equal(page.meta.latestCollection.status, 'completed');
});

test('history worker aligns slots to the configured interval and records valid captures', async () => {
  assert.equal(intervalFromEnvironment('20'), 20 * 60 * 1000);
  assert.throws(() => intervalFromEnvironment('0'), /integer from 1 to 1440/);
  assert.equal(collectionSlot(Date.parse('2026-01-01T12:19:59Z')).toISOString(), '2026-01-01T12:00:00.000Z');
  const pool = fakePool();
  const result = await collectCollectionSlot({
    pool, slotAt: new Date('2026-01-01T12:00:00Z'), now: () => Date.parse('2026-01-01T12:00:01Z'),
    resolveStations: async () => ({ stations: [{ id: '7', coords: [-.37, 39.47], availableBikes: 3 }] }),
    logger: { info() {}, error() {} },
  });
  assert.equal(result.status, 'completed');
  assert.equal(pool.statements.filter(item => item.sql.includes('INSERT INTO valenbisi_availability_history')).length, 1);
});
