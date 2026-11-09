import { jsonRequest } from './transport.js';

const SOURCE = 'https://www.valenbisi.es/es/mapping';
const stations = new Map();

// "148_XÀTIVA_PLAZA_DE_TOROS" → "Xàtiva Plaza de Toros"
export const stationName = raw => String(raw).replace(/^\s*\d+\s*[_\s-]+/, '').replace(/_/g, ' ').trim().toLocaleLowerCase('es')
  .replace(/(^|[\s\-/(])(\p{L})/gu, (_, before, letter) => before + letter.toLocaleUpperCase('es'))
  .replace(/(?<=\s)(De|Del|La|Las|Los|El|I|Y|Les|Dels)(?=\s)/g, word => word.toLowerCase());

export function updateBikeDetails(stop, result, error = null) {
  if (result) {
    stop.bikes = result.bikes;
    stop.bikesFetchedAt = result.fetchedAt;
    stop.bikesStale = Boolean(result.stale);
    stop.bikesError = null;
  } else {
    stop.bikesError = error?.message || 'Bike details unavailable';
    stop.bikesStale = Array.isArray(stop.bikes) && stop.bikes.length > 0;
    if (!Array.isArray(stop.bikes)) stop.bikes = [];
  }
  return stop;
}

export const valenbisi = {
  id: 'valenbisi', name: 'Valenbisi', short: 'Bici', color: '#1f6fe5', ink: '#ffffff', glyph: 'bike', symbol: 'V', kind: 'bike', interval: 60000, speed: 15,
  preloadRoutes: false, description: 'Disponibilidad de bicicletas y anclajes en las estaciones.', source: SOURCE,
  // Station objects are updated in place so map labels pick up fresh availability on every poll.
  async getNetwork() {
    const result = await jsonRequest('valenbisi', null, 'stations');
    for (const station of result.stations) {
      const next = { ...station, name: stationName(station.name) };
      if (stations.has(station.id)) Object.assign(stations.get(station.id), next); else stations.set(station.id, next);
    }
    return { stops: [...stations.values()], lines: [] };
  },
  getModels: () => Promise.resolve([]),
  async getArrivals(stop) {
    const network = await this.getNetwork();
    const current = network.stops.find(item => item.id === stop.id);
    if (current) Object.assign(stop, current);
    try {
      const result = await jsonRequest('valenbisi', null, `bikes?stationNumber=${encodeURIComponent(stop.id)}`);
      updateBikeDetails(stop, result);
    } catch (error) {
      updateBikeDetails(stop, null, error);
    }
    return [];
  },
  getApproach: () => null,
};
