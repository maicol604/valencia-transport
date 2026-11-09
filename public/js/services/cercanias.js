import { jsonRequest, createCache } from './transport.js';
import { shapeModel } from './shapes.js';

const cache = createCache();
let network;
const MAX_CLOCK_SKEW_MS = 30000;
function isFreshTimestamp(value, now) {
  return Number.isFinite(value) && value > 0 && now - value <= 90000 && value <= now + MAX_CLOCK_SKEW_MS;
}
export function parseRenfeArrivals(positions, updates, stop, data, now = Date.now()) {
  const headerAt = Number(positions.header?.timestamp) * 1000;
  const updateAt = Number(updates.header?.timestamp) * 1000;
  if (!isFreshTimestamp(headerAt, now)) throw new Error('Renfe vehicle positions are stale or have an invalid timestamp.');
  const updatesFresh = isFreshTimestamp(updateAt, now);
  const vehicles = new Map(positions.entity.filter(e => e.vehicle?.trip?.tripId).map(e => [e.vehicle.trip.tripId, e.vehicle]));
  const result = [];
  const entities = updatesFresh ? [...(updates.entity || [])] : [];
  const updatedTrips = new Set(entities.map(e => e.tripUpdate?.trip?.tripId));
  for (const [tripId] of vehicles) if (!updatedTrips.has(tripId)) entities.push({ tripUpdate: { trip: { tripId }, stopTimeUpdate: [] } });
  for (const entity of entities) {
    const update = entity.tripUpdate, tripId = update?.trip?.tripId, trip = data.trips[tripId];
    if (!trip || (updatesFresh && update.trip.scheduleRelationship === 'CANCELED')) continue;
    const selectedIndexes = trip.stops.flatMap((id, index) => id === stop.id ? [index] : []);
    if (selectedIndexes.length !== 1) continue;
    const index = selectedIndexes[0];
    const explicit = update.stopTimeUpdate?.find(s => s.stopId === stop.id);
    if (explicit?.scheduleRelationship === 'SKIPPED' || explicit?.scheduleRelationship === 'NO_DATA') continue;
    const vehicle = vehicles.get(tripId);
    const currentIndexes = vehicle ? trip.stops.flatMap((id, current) => id === vehicle.stopId ? [current] : []) : [];
    const currentIndex = currentIndexes.length === 1 ? currentIndexes[0] : -1;
    const future = currentIndex >= 0 && index >= currentIndex;
    const time = Number(explicit?.arrival?.time || explicit?.departure?.time) * 1000;
    const hasEta = Number.isFinite(time) && time > now - 15000;
    if (!hasEta && !future) continue;
    const positionAt = Number(vehicle?.timestamp) * 1000;
    const lat = vehicle?.position?.latitude, lon = vehicle?.position?.longitude;
    const valid = future && isFreshTimestamp(positionAt, now) && Number.isFinite(lat) && Number.isFinite(lon);
    const label = vehicle?.vehicle?.label || '';
    const platform = /PLATF\.\(([^)]+)\)/i.exec(label)?.[1] || null;
    result.push({ line: trip.line, destination: trip.destination, vehicleId: vehicle?.vehicle?.id || tripId,
      raw: hasEta ? `${Math.max(0, Math.ceil((time - now) / 60000))} min.` : 'Sin ETA publicada',
      arrivalAt: hasEta ? time : null, observedAt: updatesFresh ? updateAt : headerAt, programmed: false,
      position: valid ? { coords: [lon, lat], kind: 'gps', timestamp: positionAt, receivedAt: now } : null,
      positionNote: 'No recent GPS position is available for this service', platform, vehicleLabel: label,
    });
  }
  return result.sort((a, b) => (a.arrivalAt ?? Infinity) - (b.arrivalAt ?? Infinity));
}

export const cercanias = {
  id: 'cercanias', name: 'Cercanías', short: 'Cercanías', color: '#8a2d78', ink: '#ffffff', glyph: 'train', symbol: 'C', kind: 'train', interval: 20000, speed: 45, preloadRoutes: true,
  description: 'Renfe GPS with measurement time. Only trains whose trip serves the selected station are shown; ETA appears only when Renfe publishes it.',
  source: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
  getNetwork: () => cache('network', 43200000, async () => {
    // GTFS is large: its Valencia subset is prepared by the isolated Renfe service.
    network = await jsonRequest('cercanias', null, 'network'); return network;
  }),
  async getModels(item) { return [shapeModel(item.features, network.stops.filter(s => s.lines.includes(item.id)), { allowEstimate: false })]; },
  async getArrivals(stop, signal) {
    const [positions, updates] = await Promise.all([
      jsonRequest('cercanias', 'https://gtfsrt.renfe.com/vehicle_positions.json', 'positions', { signal }),
      jsonRequest('cercanias', 'https://gtfsrt.renfe.com/trip_updates.json', 'updates', { signal }),
    ]);
    return parseRenfeArrivals(positions, updates, stop, network);
  },
  getApproach: () => null,
};
