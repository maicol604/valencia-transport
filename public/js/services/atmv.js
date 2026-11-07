import { jsonRequest, createCache } from './transport.js';
import { shapeModel } from './shapes.js';
import { approachForPosition, approachForStop } from '../geo.js';

const BASE = 'https://api.softoursistemas.com/metrobus';
const cache = createCache();
const waiting = [];
let active = 0;
async function request(path, signal) {
  if (active >= 4) await new Promise(resolve => waiting.push(resolve));
  active++;
  try { return await jsonRequest('atmv', `${BASE}/${path}`, path, { signal }); }
  finally { active--; waiting.shift()?.(); }
}
const stopFrom = s => ({ id: String(s.stop_code), name: s.stop_name, coords: [Number(s.stop_lon), Number(s.stop_lat)] });

export function parseAtmvArrivals(data, now = Date.now()) {
  if (!Array.isArray(data)) throw new Error('Met Go returned invalid estimates.');
  return data.flatMap(group => (group.estimations || []).flatMap(item => {
    if (item.minutesToArrival == null || !Number.isFinite(Number(item.minutesToArrival)) || Number(item.minutesToArrival) < 0) return [];
    const minutes = Number(item.minutesToArrival);
    const coords = [Number(item.almex?.longitude), Number(item.almex?.latitude)];
    const valid = coords.every(Number.isFinite) && coords[1] > 38 && coords[1] < 41 && coords[0] > -2 && coords[0] < 1;
    return [{ line: String(group.line), destination: group.route || '', raw: `${minutes} min.`, seconds: minutes * 60,
      observedAt: now, arrivalAt: now + minutes * 60000, programmed: false,
      vehicleId: item.vehicleId == null ? null : String(item.vehicleId),
      position: valid ? { coords, kind: 'reported', timestamp: null, receivedAt: now } : null,
      occupancy: item.ocupacion || null,
    }];
  })).sort((a, b) => a.arrivalAt - b.arrivalAt);
}

export const atmv = {
  id: 'atmv', name: 'ATMV · Met Go', color: '#a75119', symbol: 'A', kind: 'bus', interval: 30000, speed: 20, preloadRoutes: false,
  description: 'Met Go predictions and vehicle coordinates when published. The source does not timestamp those coordinates; otherwise the position is estimated.',
  source: 'https://metgovalencia.com/',
  getNetwork: () => cache('network', 3600000, async () => {
    const [stops, routes] = await Promise.all([request('old/stops'), request('old/routes')]);
    return { stops: stops.map(stopFrom), lines: routes.map(r => ({ id: String(r.route_short_name), name: r.route_long_name, variants: [r] })) };
  }),
  async getStopLines(stop, signal) {
    const routes = await request(`stops/code/${encodeURIComponent(stop.id)}/routes`, signal);
    return [...new Set(routes.map(r => String(r.route_short_name)))];
  },
  getModels: item => cache(`route:${item.id}`, 600000, async () => {
    const results = await Promise.allSettled(item.variants.flatMap(route => [0, 1].map(async direction => {
      const query = `direction=${direction}&concesion=${encodeURIComponent(route.concesion)}`;
      const [shape, data] = await Promise.all([
        request(`routes/${encodeURIComponent(route.route_id)}/shapes/?${query}`),
        request(`routes/${encodeURIComponent(route.route_id)}/stops?${query}`),
      ]);
      // The API may fall back to a different service day. Draw it, but don't derive current positions from it.
      return shapeModel(shape.features || [], (data.stops || []).map(stopFrom), { circular: data.isCircular, direction, allowEstimate: !shape.noServiceToday });
    })));
    const models = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!models.length) throw new Error(`Met Go route ${item.id} is unavailable.`);
    return models;
  }),
  getArrivals: async (stop, signal) => parseAtmvArrivals(await request(`estimacion/ocupacion/${encodeURIComponent(stop.id)}`, signal)),
  getApproach(models, stop, arrival) {
    const eligible = models.filter(model => model.allowEstimate);
    if (arrival?.position?.coords) {
      const located = approachForPosition(eligible, stop, arrival.position.coords);
      if (located) return located;
    }
    return approachForStop(eligible, stop);
  },
};
