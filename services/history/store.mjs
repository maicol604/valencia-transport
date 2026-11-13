import { Pool } from 'pg';

const schemaReady = new WeakMap();
let historyPool;

const schema = `
  CREATE TABLE IF NOT EXISTS valenbisi_history_runs (
    slot_at timestamptz PRIMARY KEY,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
    expected_station_count integer NOT NULL DEFAULT 0,
    stored_station_count integer NOT NULL DEFAULT 0,
    discarded_station_count integer NOT NULL DEFAULT 0,
    error_message text
  );
  CREATE TABLE IF NOT EXISTS valenbisi_availability_history (
    snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    station_id text NOT NULL,
    station_name text NOT NULL,
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    capacity integer CHECK (capacity IS NULL OR capacity >= 0),
    available_bikes integer CHECK (available_bikes IS NULL OR available_bikes >= 0),
    available_docks integer CHECK (available_docks IS NULL OR available_docks >= 0),
    status text,
    slot_at timestamptz NOT NULL,
    captured_at timestamptz NOT NULL,
    source_observed_at timestamptz,
    UNIQUE (station_id, slot_at)
  );
  CREATE INDEX IF NOT EXISTS valenbisi_history_time_idx
    ON valenbisi_availability_history (slot_at, snapshot_id);
  CREATE INDEX IF NOT EXISTS valenbisi_history_station_time_idx
    ON valenbisi_availability_history (station_id, slot_at);
`;

export function getHistoryPool() {
  if (historyPool) return historyPool;
  const password = process.env.HISTORY_DB_PASSWORD;
  if (!password) return null;
  const port = Number(process.env.HISTORY_DB_PORT || 5432);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('HISTORY_DB_PORT must be a valid TCP port.');
  historyPool = new Pool({
    host: process.env.HISTORY_DB_HOST || '127.0.0.1',
    port,
    database: process.env.HISTORY_DB_NAME || 'valenbisi_history',
    user: process.env.HISTORY_DB_USER || 'valenbisi',
    password,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  historyPool.on('error', error => console.error(`Availability history database connection failed: ${error.message}`));
  return historyPool;
}

export async function closeHistoryPool() {
  if (!historyPool) return;
  const current = historyPool;
  historyPool = null;
  await current.end();
}

export async function initializeHistorySchema(pool) {
  let ready = schemaReady.get(pool);
  if (!ready) {
    ready = pool.query(schema).catch(error => {
      schemaReady.delete(pool);
      throw error;
    });
    schemaReady.set(pool, ready);
  }
  await ready;
}

export async function isCollectionComplete(pool, slotAt) {
  await initializeHistorySchema(pool);
  const { rows } = await pool.query(
    `SELECT status FROM valenbisi_history_runs
     WHERE slot_at = $1 AND status IN ('completed', 'partial')`,
    [slotAt],
  );
  return rows.length > 0;
}

function nullableCount(value, field, stationId) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field} for Valenbisi station ${stationId}.`);
  return value;
}

function validDate(value, field, stationId) {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${field} for Valenbisi station ${stationId}.`);
  return date;
}

function validateStations(stations) {
  if (!Array.isArray(stations) || !stations.length) throw new Error('Valenbisi returned no stations; refusing to store an empty snapshot.');
  const seen = new Set();
  return stations.map(station => {
    const id = String(station.id ?? '').trim();
    const [longitude, latitude] = station.coords || [];
    if (!id || id.length > 100 || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new Error(`Invalid identity or coordinates for Valenbisi station ${id || '(unknown)'}.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate Valenbisi station ID ${id} in one snapshot.`);
    seen.add(id);
    return {
      id,
      name: String(station.name || `Station ${id}`).slice(0, 300),
      longitude,
      latitude,
      capacity: nullableCount(station.capacity, 'capacity', id),
      availableBikes: nullableCount(station.availableBikes, 'available bikes', id),
      availableDocks: nullableCount(station.availableDocks, 'available docks', id),
      status: station.status == null ? null : String(station.status).slice(0, 100),
      sourceObservedAt: validDate(station.sourceUpdatedAt, 'source timestamp', id),
    };
  });
}

export async function saveAvailabilitySnapshot(pool, { slotAt, startedAt, capturedAt, stations, discardedStationCount = 0 }) {
  await initializeHistorySchema(pool);
  const normalized = validateStations(stations);
  if (!Number.isSafeInteger(discardedStationCount) || discardedStationCount < 0) throw new Error('Invalid discarded station count.');
  const slot = validDate(slotAt, 'collection slot', 'all');
  const started = validDate(startedAt, 'collection start timestamp', 'all');
  const captured = validDate(capturedAt, 'capture timestamp', 'all');
  if (!slot || !started || !captured) throw new Error('Collection slot, start time and capture timestamp are required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO valenbisi_history_runs
        (slot_at, started_at, status, expected_station_count, stored_station_count, discarded_station_count)
       VALUES ($1, $2, 'running', $3, 0, $4)
       ON CONFLICT (slot_at) DO UPDATE SET
         started_at = EXCLUDED.started_at, completed_at = NULL, status = 'running',
         expected_station_count = EXCLUDED.expected_station_count,
         stored_station_count = 0, discarded_station_count = EXCLUDED.discarded_station_count,
         error_message = NULL`,
      [slot, started, normalized.length + discardedStationCount, discardedStationCount],
    );
    for (const station of normalized) {
      await client.query(
        `INSERT INTO valenbisi_availability_history
          (station_id, station_name, longitude, latitude, capacity, available_bikes,
           available_docks, status, slot_at, captured_at, source_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (station_id, slot_at) DO NOTHING`,
        [
          station.id, station.name, station.longitude, station.latitude, station.capacity,
          station.availableBikes, station.availableDocks, station.status, slot, captured,
          station.sourceObservedAt,
        ],
      );
    }
    const runStatus = discardedStationCount ? 'partial' : 'completed';
    await client.query(
      `UPDATE valenbisi_history_runs
       SET completed_at = $2, status = $3, stored_station_count = $4
       WHERE slot_at = $1`,
      [slot, captured, runStatus, normalized.length],
    );
    await client.query('COMMIT');
    return { status: runStatus, storedStationCount: normalized.length, discardedStationCount };
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { console.error(`Availability history transaction rollback failed: ${rollbackError.message}`); }
    throw error;
  } finally {
    client.release();
  }
}

export async function recordCollectionFailure(pool, { slotAt, startedAt, error }) {
  await initializeHistorySchema(pool);
  await pool.query(
    `INSERT INTO valenbisi_history_runs
      (slot_at, started_at, completed_at, status, error_message)
     VALUES ($1, $2, NOW(), 'failed', $3)
     ON CONFLICT (slot_at) DO UPDATE SET
       completed_at = NOW(), status = 'failed', error_message = EXCLUDED.error_message
     WHERE valenbisi_history_runs.status NOT IN ('completed', 'partial')`,
    [slotAt, startedAt, String(error?.message || error).slice(0, 2000)],
  );
}

function dateTime(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function readAvailabilityHistory(pool, { from, to, stationId, limit, cursor }) {
  await initializeHistorySchema(pool);
  const conditions = ['slot_at >= $1', 'slot_at < $2'];
  const params = [from, to];
  if (stationId) {
    params.push(stationId);
    conditions.push(`station_id = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`snapshot_id > $${params.length}::bigint`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT snapshot_id, station_id, station_name, longitude, latitude, capacity,
            available_bikes, available_docks, status, slot_at, captured_at, source_observed_at
     FROM valenbisi_availability_history
     WHERE ${conditions.join(' AND ')}
     ORDER BY snapshot_id ASC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const latest = await pool.query(
    `SELECT slot_at, started_at, completed_at, status, expected_station_count,
            stored_station_count, discarded_station_count, error_message
     FROM valenbisi_history_runs ORDER BY slot_at DESC LIMIT 1`,
  );
  const latestRow = latest.rows[0];
  return {
    data: page.map(row => ({
      id: String(row.snapshot_id),
      stationId: row.station_id,
      stationName: row.station_name,
      location: { type: 'Point', coordinates: [row.longitude, row.latitude] },
      capacity: row.capacity,
      availableBikes: row.available_bikes,
      availableDocks: row.available_docks,
      status: row.status,
      slotAt: dateTime(row.slot_at),
      capturedAt: dateTime(row.captured_at),
      sourceObservedAt: row.source_observed_at ? dateTime(row.source_observed_at) : null,
    })),
    meta: {
      from: dateTime(from),
      to: dateTime(to),
      timezone: 'UTC',
      count: page.length,
      limit,
      hasMore,
      nextCursor: hasMore ? String(page.at(-1).snapshot_id) : null,
      latestCollection: latestRow ? {
        slotAt: dateTime(latestRow.slot_at),
        startedAt: dateTime(latestRow.started_at),
        completedAt: latestRow.completed_at ? dateTime(latestRow.completed_at) : null,
        status: latestRow.status,
        expectedStationCount: latestRow.expected_station_count,
        storedStationCount: latestRow.stored_station_count,
        discardedStationCount: latestRow.discarded_station_count,
        error: latestRow.error_message,
      } : null,
    },
  };
}
