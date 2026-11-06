import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { memoize, upstreamText, jsonResult } from './shared.mjs';

const GTFS = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';

async function eachCsv(zip, filename, visit) {
  const file = zip.files.find(f => f.path === filename);
  if (!file) throw new Error(`Renfe GTFS: missing ${filename}`);
  const stream = file.stream();
  const parser = stream.pipe(parse({ columns: headers => headers.map(h => h.trim()), trim: true, bom: true, relax_column_count: true }));
  stream.on('error', error => parser.destroy(error));
  for await (const row of parser) visit(row);
}

export const getRenfeNetwork = memoize(43200000, async () => {
  const response = await fetch(GTFS, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Renfe GTFS: HTTP ${response.status}`);
  const zip = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
  const routes = new Map(), trips = {}, stopMap = new Map(), shapes = new Map(), membership = new Map();
  await eachCsv(zip, 'routes.txt', r => {
    // 40 is the GTFS network code for Valencia, not a geographical guess.
    if (r.route_id.startsWith('40')) routes.set(r.route_id, { line: r.route_short_name, name: r.route_long_name, color: r.route_color });
  });
  await eachCsv(zip, 'trips.txt', t => {
    const route = routes.get(t.route_id);
    if (route) trips[t.trip_id] = { line: route.line, destination: t.trip_headsign, shape: t.shape_id, stops: [], sequences: [] };
  });
  await eachCsv(zip, 'stops.txt', s => { stopMap.set(s.stop_id, { id: s.stop_id, name: s.stop_name, coords: [+s.stop_lon, +s.stop_lat] }); });
  // Stream the large national stop_times file: keep only Valencia trips, never load it whole.
  await eachCsv(zip, 'stop_times.txt', s => {
    const trip = trips[s.trip_id];
    if (!trip) return;
    trip.sequences.push([Number(s.stop_sequence), s.stop_id]);
    if (!membership.has(s.stop_id)) membership.set(s.stop_id, new Set());
    membership.get(s.stop_id).add(trip.line);
  });
  const wantedShapes = new Set(Object.values(trips).map(t => t.shape));
  await eachCsv(zip, 'shapes.txt', s => {
    if (!wantedShapes.has(s.shape_id)) return;
    if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
    shapes.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lon, +s.shape_pt_lat]);
  });
  for (const trip of Object.values(trips)) {
    trip.stops = trip.sequences.sort((a, b) => a[0] - b[0]).map(s => s[1]);
    trip.destination ||= stopMap.get(trip.stops.at(-1))?.name || 'Destino no publicado';
    delete trip.sequences;
  }
  const lines = [...new Set([...routes.values()].map(r => r.line))].map(id => {
    const ids = new Set(Object.values(trips).filter(t => t.line === id).map(t => t.shape));
    return { id, name: `Valencia commuter rail · ${id}`, features: [...ids].filter(s => shapes.has(s)).map(s => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: shapes.get(s).sort((a, b) => a[0] - b[0]).map(p => p.slice(1)) } })) };
  });
  const stops = [...membership].filter(([id]) => stopMap.has(id)).map(([id, lines]) => ({ ...stopMap.get(id), lines: [...lines] }));
  if (!stops.length || !Object.keys(trips).length) throw new Error('Renfe GTFS does not contain the Valencia network');
  return { stops, lines, trips, generatedAt: Date.now(), source: GTFS };
});

export async function handleCercanias(path) {
  if (path === 'network') return jsonResult(await getRenfeNetwork());
  const names = { positions: 'vehicle_positions', updates: 'trip_updates' };
  if (!names[path]) throw Object.assign(new Error('Cercanias resource not allowed'), { status: 400 });
  return { text: await upstreamText(`https://gtfsrt.renfe.com/${names[path]}.json`), type: 'application/json; charset=utf-8' };
}
