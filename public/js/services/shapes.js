import { measurePath, projectStop, distance, pointAt } from '../geo.js';

export const normalizeName = text => String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function shapeModel(features, stops, { circular = false, direction, allowEstimate = true } = {}) {
  const paths = [];
  const stopIds = new Set(stops.map(s => s.id));
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) continue;
    for (const coords of geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates) {
      if (coords.length < 2) continue;
      const path = measurePath(coords);
      path.circular = circular && distance(coords[0], coords.at(-1)) < 30;
      path.anchors = new Map(); path.direction = direction;
      for (const stop of stops) {
        const projected = projectStop(path, stop.coords);
        if (projected.gap < 120) path.anchors.set(stop.id, [projected.offset]);
      }
      paths.push(path);
    }
  }
  return { paths, features, stopIds, allowEstimate };
}

export function directedApproach(models, stop, arrival, networkStops) {
  const destination = normalizeName(arrival.destination);
  const termini = networkStops.filter(s => normalizeName(s.name) === destination);
  const choices = [];
  for (const model of models) {
    if (!model.allowEstimate) continue;
    for (const path of model.paths) {
      const offset = path.anchors.get(stop.id)?.[0];
      if (offset === undefined) continue;
      for (const terminal of termini) {
        const target = path.anchors.get(terminal.id)?.[0];
        if (target === undefined || Math.abs(target - offset) < 1) continue;
        if (target > offset) choices.push({ path, offset });
        else {
          const reversed = measurePath([...path.coords].reverse());
          reversed.circular = path.circular;
          choices.push({ path: reversed, offset: path.length - offset });
        }
      }
    }
  }
  if (!choices.length) return null;
  const first = choices[0];
  const p = pointAt(first.path, Math.max(0, first.offset - 200));
  if (choices.some(c => distance(p, pointAt(c.path, Math.max(0, c.offset - 200))) > 100)) return null;
  return first;
}
