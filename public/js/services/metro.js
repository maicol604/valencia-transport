import { transportRequest, jsonRequest, createCache } from './transport.js';
import { shapeModel, directedApproach } from './shapes.js';

const cache = createCache();
let network;

// Decode only JSON values embedded in the public map, never execute scraped JavaScript.
export function extractMapValue(html, key) {
  const section = html.split('var datosMapaGeneral =')[1];
  if (!section) throw new Error('Metrovalencia public map was not found.');
  const match = new RegExp(`\\b${key}:\\s*`).exec(section);
  if (!match) throw new Error(`Metrovalencia map is missing ${key}.`);
  const text = section.slice(match.index + match[0].length);
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return JSON.parse(text.slice(0, i + 1)); }
  }
  throw new Error('Metrovalencia map is incomplete.');
}

export function parseMetroArrivals(data, now = Date.now(), Parser = globalThis.DOMParser) {
  if (!data.html || data.error) throw new Error('Metrovalencia returned no station information.');
  const doc = new Parser().parseFromString(data.html, 'text/html');
  const rows = [...doc.querySelectorAll('.item--proximos')];
  if (!rows.length && !/arribada|llegada|próxim|pròxim/i.test(doc.body.textContent)) throw new Error('Metrovalencia next-arrival format is not recognized.');
  return rows.flatMap(row => {
    const line = row.querySelector('[class*="linea-"]')?.className.match(/\blinea-(\d+)/)?.[1];
    const destination = row.querySelector('.nombre-estacion:not(.estacion__espera)')?.textContent.trim();
    const raw = row.querySelector('.estacion__espera')?.textContent.replace(/\s+/g, ' ').trim() || '';
    const hours = raw.match(/(\d+)\s*h\b/), minutes = raw.match(/(\d+)\s*min/);
    const imminent = /pr[oóò]xim|llegando|arribant|<<|^0$/.test(raw.toLowerCase());
    if (!line || !destination || (!hours && !minutes && !imminent)) return [];
    const seconds = (Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0)) * 60;
    return [{ line, destination, raw, seconds, observedAt: now, arrivalAt: now + seconds * 1000, programmed: false }];
  }).sort((a, b) => a.arrivalAt - b.arrivalAt);
}

export const metro = {
  id: 'metro', name: 'Metrovalencia', color: '#c93f4b', symbol: 'M', kind: 'train', interval: 30000, speed: 30, preloadRoutes: true,
  description: 'Next arrivals from the Metrovalencia station board. Positions are estimated, not GPS; destination resolves direction where geometry allows it.',
  source: 'https://www.metrovalencia.es/es/consulta-mapas/',
  getNetwork: () => cache('network', 3600000, async () => {
    const html = await transportRequest('metro', 'https://www.metrovalencia.es/es/consulta-mapas/', 'network');
    const coords = extractMapValue(html, 'estaciones'), info = extractMapValue(html, 'infoEstaciones');
    const paths = extractMapValue(html, 'lineas'), colors = extractMapValue(html, 'coloresLineas');
    if (coords.length !== info.length) throw new Error('Metrovalencia station and coordinate counts do not match.');
    const stops = info.map((s, i) => ({ id: String(s.id), name: s.nombre, coords: [coords[i].lng, coords[i].lat], lines: s.lineas.map(l => String(l.id)) }));
    const publicLines = new Map(info.flatMap(s => s.lineas.map(l => [String(l.id), l])));
    const lines = [...publicLines].map(([id, line]) => ({ id, name: `${['4', '6', '8', '10'].includes(id) ? 'Tram' : 'Metro'} · Line ${id}`, color: `#${line.color}`, features: Object.entries(paths).filter(([key]) => colors[key] === line.color).map(([, points]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map(p => [p.lng, p.lat]) } })) }));
    network = { stops, lines }; return network;
  }),
  async getModels(item) { return [shapeModel(item.features, network.stops.filter(s => s.lines.includes(item.id)))]; },
  async getArrivals(stop, signal) {
    const body = new URLSearchParams({ action: 'formularios_ajax', data: `action=info-estacion&id=${encodeURIComponent(stop.id)}&lang=es` });
    return parseMetroArrivals(await jsonRequest('metro', 'https://www.metrovalencia.es/wp-admin/admin-ajax.php', `arrivals?stop=${encodeURIComponent(stop.id)}`, { method: 'POST', body, signal }));
  },
  getApproach: (models, stop, arrival) => arrival ? directedApproach(models, stop, arrival, network?.stops || []) : null,
};
