import { fileURLToPath } from 'node:url';
import { closeValenbisiBrowser, resolveValenbisiStations } from '../valenbisi.mjs';
import {
  closeHistoryPool, getHistoryPool, initializeHistorySchema, isCollectionComplete,
  recordCollectionFailure, saveAvailabilitySnapshot,
} from './store.mjs';

export const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const WORKER_LOCK_ID = 741038221;

export function intervalFromEnvironment(value = process.env.VALENBISI_HISTORY_INTERVAL_MINUTES || '20') {
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('VALENBISI_HISTORY_INTERVAL_MINUTES must be an integer from 1 to 1440.');
  }
  return minutes * 60 * 1000;
}

export function collectionSlot(timestamp, intervalMs = DEFAULT_INTERVAL_MS) {
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('A valid timestamp and collection interval are required.');
  }
  return new Date(Math.floor(timestamp / intervalMs) * intervalMs);
}

export async function collectCollectionSlot({
  pool, slotAt, resolveStations = resolveValenbisiStations, now = Date.now, logger = console,
}) {
  const startedAt = new Date(now());
  if (await isCollectionComplete(pool, slotAt)) return { skipped: true, slotAt };
  try {
    const snapshot = await resolveStations();
    if (!snapshot?.stations?.length) throw new Error('Valenbisi returned no stations; refusing to store an empty snapshot.');
    const capturedAt = new Date(now());
    const result = await saveAvailabilitySnapshot(pool, {
      slotAt, startedAt, capturedAt, stations: snapshot.stations,
      discardedStationCount: snapshot.discardedStationCount || 0,
    });
    logger.info(`[valenbisi-history] ${result.status}: ${result.storedStationCount} stations for ${slotAt.toISOString()}`);
    return { ...result, slotAt };
  } catch (error) {
    try { await recordCollectionFailure(pool, { slotAt, startedAt, error }); }
    catch (recordError) { logger.error(`[valenbisi-history] could not record failed collection: ${recordError.message}`); }
    throw error;
  }
}

function waitForNextCycle(signal, intervalMs) {
  const delay = intervalMs - (Date.now() % intervalMs) || intervalMs;
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function runHistoryWorker({ pool, intervalMs = DEFAULT_INTERVAL_MS, signal, resolveStations, logger = console }) {
  await initializeHistorySchema(pool);
  const lock = await pool.connect();
  let acquired;
  try { acquired = (await lock.query('SELECT pg_try_advisory_lock($1) AS acquired', [WORKER_LOCK_ID])).rows[0]?.acquired; }
  catch (error) {
    lock.release();
    throw error;
  }
  if (!acquired) { lock.release(); throw new Error('Another Valenbisi history worker already holds the database lock.'); }
  try {
    let lastSlot = null;
    while (!signal.aborted) {
      const slotAt = collectionSlot(Date.now(), intervalMs);
      if (lastSlot?.getTime() !== slotAt.getTime()) {
        lastSlot = slotAt;
        try {
          const result = await collectCollectionSlot({ pool, slotAt, resolveStations, logger });
          if (result.skipped) logger.info(`[valenbisi-history] slot already complete: ${slotAt.toISOString()}`);
        } catch (error) {
          logger.error(`[valenbisi-history] collection failed for ${slotAt.toISOString()}: ${error.stack || error.message}`);
        }
      }
      if (!signal.aborted) await waitForNextCycle(signal, intervalMs);
    }
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_ID]); }
    finally { lock.release(); }
  }
}

export async function startHistoryWorker() {
  const pool = getHistoryPool();
  if (!pool) throw new Error('History database configuration is required to run the Valenbisi history worker.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runHistoryWorker({ pool, intervalMs: intervalFromEnvironment(), signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await closeValenbisiBrowser();
    await closeHistoryPool();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startHistoryWorker().catch(error => {
    console.error(`[valenbisi-history] worker stopped: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
