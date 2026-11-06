// GeoJSON coordinates stay [longitude, latitude]; Leaflet conversion is at the UI boundary.
export function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function measurePath(coords) {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + distance(coords[i - 1], coords[i]));
  return { coords, cumulative, length: cumulative.at(-1) || 0 };
}

export function pointAt(path, meters) {
  if (!Number.isFinite(meters) || meters < 0 || meters > path.length || path.length === 0) return null;
  let lo = 1, hi = path.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.cumulative[mid] < meters) lo = mid + 1; else hi = mid;
  }
  const a = path.coords[lo - 1], b = path.coords[lo];
  const span = path.cumulative[lo] - path.cumulative[lo - 1];
  const t = span ? (meters - path.cumulative[lo - 1]) / span : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function segmentNodes(id = '') {
  const match = /^([PL]\d{8})([PL]\d{8})$/.exec(id);
  return match ? match.slice(1) : [];
}
export const nodeStop = node => node?.startsWith('P') ? String(Number(node.slice(1, 7))) : null;

// UNIQUE_ID supplies traversal order; IDTRAMO supplies directed stop endpoints.
// Never bridge disconnected pieces across streets, suppressed segments or termini.
export function buildRoutes(collection, info) {
  const termini = new Set(['PINI_I', 'PFIN_I', 'PINI_V', 'PFIN_V'].map(k => String(info[k])));
  const paths = [], stopIds = new Set();
  let coords = [], anchors = new Map(), legBoundaries = [];
  function flush() {
    if (coords.length > 1) {
      const path = measurePath(coords);
      path.anchors = new Map([...anchors].map(([id, indices]) => [id, indices.map(i => path.cumulative[i])]));
      // EMT publishes outbound and return legs as one ordered service cycle.
      // Termini identify leg changes but are not geometric discontinuities.
      path.circular = distance(coords[0], coords.at(-1)) < 30;
      path.legBoundaries = [...new Set(legBoundaries.map(i => path.cumulative[i]))].sort((a, b) => a - b);
      path.subline = String(info.ID_SUBLINEA);
      paths.push(path);
    }
    coords = []; anchors = new Map(); legBoundaries = [];
  }
  function anchor(id) {
    if (!id) return;
    stopIds.add(id);
    if (!anchors.has(id)) anchors.set(id, []);
    anchors.get(id).push(coords.length - 1);
  }
  const features = [...collection.features].sort((a, b) => Number(a.properties.UNIQUE_ID) - Number(b.properties.UNIQUE_ID));
  for (const feature of features) {
    if (Number(feature.properties.TRAMO_SUPRIMIDO) !== 0) { flush(); continue; }
    const geometry = feature.geometry;
    if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) { flush(); continue; }
    const parts = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    const [startNode, endNode] = segmentNodes(feature.properties.IDTRAMO);
    const start = nodeStop(startNode), end = nodeStop(endNode);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.length < 2) continue;
      if (coords.length && distance(coords.at(-1), part[0]) > 30) flush();
      if (!coords.length) coords.push(part[0]);
      else if (distance(coords.at(-1), part[0]) > 0.2) coords.push(part[0]);
      if (p === 0 && termini.has(start)) legBoundaries.push(coords.length - 1);
      if (p === 0) anchor(start);
      for (const point of part.slice(1)) if (distance(coords.at(-1), point) > 0.05) coords.push(point);
      if (p === parts.length - 1) anchor(end);
      if (p === parts.length - 1 && termini.has(end)) legBoundaries.push(coords.length - 1);
    }
  }
  flush();
  return { paths, stopIds, features: features.filter(f => Number(f.properties.TRAMO_SUPRIMIDO) === 0) };
}

export function projectStop(path, stop) {
  let best = { offset: 0, gap: Infinity };
  const cos = Math.cos(stop[1] * Math.PI / 180);
  for (let i = 1; i < path.coords.length; i++) {
    const a = path.coords[i - 1], b = path.coords[i];
    const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1];
    const square = dx * dx + dy * dy;
    if (!square) continue;
    const t = Math.max(0, Math.min(1, (((stop[0] - a[0]) * cos) * dx + (stop[1] - a[1]) * dy) / square));
    const gap = distance(stop, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (gap < best.gap) best = { offset: path.cumulative[i - 1] + t * (path.cumulative[i] - path.cumulative[i - 1]), gap };
  }
  return best;
}

export function approachForStop(models, stop) {
  const matches = [];
  for (const model of models) for (const path of model.paths) {
    // Actual stop membership prevents selecting the opposite carriageway at crossings.
    for (const offset of path.anchors.get(stop.id) || []) {
      const point = pointAt(path, offset);
      if (point && distance(point, stop.coords) <= 90 && (offset > 1 || path.circular)) {
        matches.push({ path, offset, gap: distance(point, stop.coords) });
      }
    }
  }
  matches.sort((a, b) => a.gap - b.gap);
  if (!matches.length) return null;
  // Repeated equivalent anchors are harmless; genuinely different approaches are not.
  const best = matches[0];
  const ambiguous = matches.slice(1).some(m => {
    if (m.gap > best.gap + 15) return false;
    const a = positionOnApproach(best, 100), b = positionOnApproach(m, 100);
    return a && b && distance(a, b) > 80;
  });
  return ambiguous ? null : best;
}

export function approachForPosition(models, stop, coords, maxGap = 120) {
  const candidates = [];
  for (const model of models) for (const path of model.paths) {
    for (const offset of path.anchors.get(stop.id) || []) {
      if (offset <= 1 && !path.circular) continue;
      const projected = projectStop(path, coords);
      if (projected.gap > maxGap) continue;
      let vehicleDistance = offset - projected.offset;
      if (path.circular && vehicleDistance < 0) vehicleDistance += path.length;
      if (vehicleDistance < 0 || vehicleDistance > path.length) continue;
      candidates.push({ path, offset, vehicleDistance, gap: projected.gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || a.vehicleDistance - b.vehicleDistance);
  return candidates[0] || null;
}

export function positionOnApproach(approach, meters) {
  if (!approach || !Number.isFinite(meters) || meters < 0) return null;
  const { path, offset } = approach;
  let target = offset - meters;
  if (path.circular && target < 0 && meters <= path.length) target = (target % path.length + path.length) % path.length;
  return pointAt(path, target);
}

export function estimatePosition(approach, arrival, now, speedKmh) {
  if (arrival.arrivalAt == null || arrival.programmed || now - arrival.observedAt > 90000 || now > arrival.arrivalAt + 15000) return null;
  const seconds = Math.max(0, (arrival.arrivalAt - now) / 1000);
  return positionOnApproach(approach, seconds * speedKmh / 3.6);
}
