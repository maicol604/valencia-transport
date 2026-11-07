import { setTransport } from './services/emt-api.js';
import { estimatePosition, distance, pointAt, approachForPosition } from './geo.js';
import { adjustedArrivalAt, reconcileArrivals } from './arrivals.js';
import { providers } from './services/index.js';
import { configureTransport } from './services/transport.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const latlng = coords => [coords[1], coords[0]];
const sortLines = (a, b) => a.localeCompare(b, 'es', { numeric: true });
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const state = {
  stops: [], lines: new Map(), models: new Map(), loading: new Map(), routeLayers: new Map(),
  stopLayers: new Map(), buses: new Map(), approaches: new Map(), selected: null, arrivals: [],
  activeLine: null, allRoutes: false, sheetExpanded: false, speed: 12, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  generation: 0, controller: null, poll: null, observedAt: null, lastError: '', busy: false,
  routeFailures: new Set(), source: 'direct', routeRefresh: 0,
  provider: providers.get('emt'), epoch: 0, networks: new Map(), contextStops: false, contextEpoch: 0,
};

const map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 10, maxZoom: 19 }).setView([39.472, -0.370], 13);
const stopRenderer = L.canvas({ pane: 'stops', tolerance: 12 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).on('tileerror', () => toast('El mapa base no está disponible. Comprueba tu conexión.')).addTo(map);
map.createPane('routes'); map.getPane('routes').style.zIndex = 410;
map.createPane('stops'); map.getPane('stops').style.zIndex = 430;
map.createPane('vehicles'); map.getPane('vehicles').style.zIndex = 620;
map.createPane('selection'); map.getPane('selection').style.zIndex = 640;
const stopGroup = L.layerGroup().addTo(map);
const selectionGroup = L.layerGroup().addTo(map);
const busGroup = L.layerGroup().addTo(map);
const contextGroup = L.layerGroup().addTo(map);
let locationMarker = null, toastTimeout;

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function connection(label, status = 'ok') {
  $('#connection').dataset.state = status;
  $('#connection span').textContent = label;
}

const routePalette = ['#176a9b', '#c94d53', '#16816c', '#c66a28', '#665aab', '#287e9a', '#a54872', '#967319'];
function color(line) { return state.lines.get(line)?.color || '#176a9b'; }
function contrastColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value || '')?.[1];
  if (!hex) return '#fff';
  const [red, green, blue] = [0, 2, 4].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return red * .2126 + green * .7152 + blue * .0722 > .179 ? '#000' : '#fff';
}
function chip(line) {
  return `<button class="line-chip" data-line="${escape(line)}" style="--route-color:${color(line)};--route-ink:${contrastColor(color(line))}" aria-pressed="${state.activeLine === line}" title="${escape(state.lines.get(line)?.name || `Línea ${line}`)}">${escape(line)}</button>`;
}

function servingLines(stop) {
  const lines = new Set([...(stop.lines || []), ...state.arrivals.map(a => a.line)]);
  for (const [line, models] of state.models) if (models.some(model => model.stopIds.has(stop.id))) lines.add(line);
  return [...lines].sort(sortLines);
}

async function loadLine(line) {
  const item = state.lines.get(line);
  const epoch = state.epoch, provider = state.provider;
  if (!item) return [];
  if (state.models.has(line) && Date.now() - item.loadedAt < 600000) return state.models.get(line);
  if (state.loading.has(line)) return state.loading.get(line);
  const promise = provider.getModels(item)
    .then(models => {
      if (epoch !== state.epoch) return [];
      if (!models.some(m => m.paths.length)) throw new Error(`Recorrido de la línea ${line} no disponible.`);
      state.models.set(line, models); item.loadedAt = Date.now(); state.routeFailures.delete(line);
      if (state.routeLayers.has(line)) map.removeLayer(state.routeLayers.get(line));
      const layer = L.geoJSON({ type: 'FeatureCollection', features: models.flatMap(m => m.features) }, {
        pane: 'routes', className: 'route-path', style: { color: item.color, weight: 3, opacity: .45, lineCap: 'round', lineJoin: 'round' },
        onEachFeature: (_feature, part) => {
          part.bindTooltip(`Línea ${escape(line)} · ${escape(item.name)}`, { sticky: true });
          part.on('click', event => { L.DomEvent.stopPropagation(event); selectLine(line); });
        },
      });
      state.routeLayers.set(line, layer);
      if (state.selected) state.approaches.set(line, provider.getApproach(models, state.selected));
      updateLayers();
      return models;
    }).catch(error => { if (epoch === state.epoch) state.routeFailures.add(line); throw error; }).finally(() => { if (epoch === state.epoch) state.loading.delete(line); });
  state.loading.set(line, promise);
  return promise;
}

function updateLayers() {
  const relevant = new Set(state.selected ? servingLines(state.selected) : []);
  for (const [line, layer] of state.routeLayers) {
    const visible = state.allRoutes || line === state.activeLine || (!state.activeLine && relevant.has(line));
    const highlighted = state.activeLine ? state.activeLine === line : relevant.has(line);
    layer.setStyle({ weight: highlighted ? 5 : 2, opacity: highlighted ? 1 : state.selected || state.activeLine ? .12 : .35, lineCap: 'round', lineJoin: 'round' });
    if (visible && !map.hasLayer(layer)) layer.addTo(map);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
    if (highlighted && visible) layer.bringToFront();
  }
  for (const [id, marker] of state.stopLayers) {
    const onLine = !state.activeLine || state.models.get(state.activeLine)?.some(m => m.stopIds.has(id));
    const selected = state.selected?.id === id;
    const zoom = map.getZoom();
    const cityScale = zoom <= 13;
    const opacity = selected ? 1 : state.selected ? (onLine ? .78 : .32) : cityScale ? .88 : 1;
    if (marker.setStyle) {
      marker.setStyle({
        color: '#ffffff', weight: selected ? 3 : cityScale ? 1.5 : 2,
        fillColor: state.provider.color,
        fillOpacity: selected ? 1 : state.selected ? (onLine ? .86 : .3) : cityScale ? .8 : .96,
        opacity,
      });
      marker.setRadius?.(selected ? 9 : cityScale ? 4 : zoom >= 15 ? 7 : 6);
    } else marker.setOpacity(opacity);
    const element = marker.getElement();
    if (element && !marker.setStyle) element.classList.toggle('is-selected', selected);
    marker.setZIndexOffset?.(selected ? 1000 : 0);
    if (selected) marker.bringToFront?.();
  }
  updateStopNumberLabels();
}

function updateStopNumberLabels() {
  const bounds = map.getBounds();
  const occupied = [];
  const markers = [...state.stopLayers.entries()].map(([id, marker]) => ({ id, marker, selected: state.selected?.id === id, context: false }));
  contextGroup.eachLayer(marker => { if (marker._stopLabel) markers.push({ marker, selected: false, context: true }); });
  markers.sort((first, second) => Number(second.selected) - Number(first.selected) || Number(first.context) - Number(second.context));
  for (const { id, marker, selected, context } of markers) {
    const inView = bounds.contains(marker.getLatLng());
    let visible = selected && inView;
    const { stop, provider } = marker._stopLabel;
    const showNearbyLabels = map.getZoom() >= (provider.kind === 'train' ? 15 : 16);
    if (inView && (selected || showNearbyLabels)) {
      const point = map.latLngToContainerPoint(marker.getLatLng());
      const lines = (selected ? servingLines(stop) : stop.lines || []).slice(0, 4);
      const width = Math.min(map.getSize().x <= 600 ? 235 : 265, 50 + stop.name.length * 6.5 + (provider.kind === 'bus' ? 38 : 0) + lines.length * 21);
      const needsLeft = point.x + width + 15 > map.getSize().x;
      const vertical = needsLeft && point.x - width - 10 < 0;
      const direction = vertical ? (point.y > 60 ? 'top' : 'bottom') : needsLeft ? 'left' : 'right';
      const left = vertical ? point.x - width / 2 : needsLeft ? point.x - width - 10 : point.x + 10;
      const box = { left, right: left + width, top: vertical ? point.y + (direction === 'top' ? -60 : 10) : point.y - 24, bottom: vertical ? point.y + (direction === 'top' ? -10 : 60) : point.y + 24 };
      marker.getTooltip().options.direction = direction;
      marker.getTooltip().options.offset = direction === 'left' ? [-10, 0] : direction === 'right' ? [10, 0] : direction === 'top' ? [0, -10] : [0, 10];
      if (selected || !occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) {
        occupied.push(box); visible = true;
      }
      const badges = lines.map(line => {
        const routeColor = context ? state.networks.get(provider.id)?.lines.find(item => item.id === line)?.color : state.lines.get(line)?.color;
        const safeColor = /^#[0-9a-f]{6}$/i.test(routeColor || '') ? routeColor : '#526575';
        return `<span class="stop-label-line" style="background:${safeColor};color:${contrastColor(safeColor)}">${escape(line)}</span>`;
      }).join('');
      marker.setTooltipContent(`<span class="stop-label-operator" style="--operator-color:${provider.color}" aria-hidden="true">${escape(provider.symbol)}</span><span class="stop-label-copy">${provider.kind === 'bus' ? `<span class="stop-label-code">${escape(stop.id)}</span>` : ''}<span class="stop-label-name">${escape(stop.name)}</span></span>${badges ? `<span class="stop-label-lines">${badges}</span>` : ''}`);
    }
    if (visible && !marker.isTooltipOpen()) marker.openTooltip();
    else if (!visible && marker.isTooltipOpen()) marker.closeTooltip();
    const tooltip = marker.getTooltip();
    if (tooltip && visible) {
      const onLine = !state.activeLine || state.models.get(state.activeLine)?.some(model => model.stopIds.has(id));
      tooltip.setOpacity(selected ? 1 : context ? .58 : state.selected ? (onLine ? .78 : .32) : map.getZoom() <= 13 ? .88 : 1);
      tooltip.getElement()?.classList.toggle('is-selected', selected);
    }
  }
}

async function loadAllRoutes() {
  if (!state.provider.preloadRoutes) { $('#route-progress').textContent = 'Recorridos bajo demanda: elige una línea o una parada.'; state.routeRefresh = Date.now(); return; }
  const epoch = state.epoch;
  const pending = [...state.lines.keys()];
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length && epoch === state.epoch) {
      const line = pending.shift();
      await loadLine(line).catch(() => {});
      if (epoch !== state.epoch) return;
      done++;
      $('#route-progress').textContent = `Recorridos: ${done}/${state.lines.size}${state.routeFailures.size ? ` · No disponibles: ${[...state.routeFailures].sort(sortLines).join(', ')}` : ''}`;
      if (state.selected && done % 5 === 0) renderStop();
    }
  }));
  if (epoch !== state.epoch) return;
  state.routeRefresh = Date.now();
  if (state.selected) { syncBuses(); renderStop(); }
}

function clearStopTooltip(marker) {
  marker.getTooltip?.()?.getElement()?.classList.remove('is-selected');
  marker.closeTooltip?.();
}

function showStops() {
  stopGroup.eachLayer(clearStopTooltip);
  stopGroup.clearLayers(); state.stopLayers.clear();
  for (const stop of state.stops) {
    const marker = stopMarker(stop, state.provider);
    marker.on('click', () => selectStop(stop));
    marker.addTo(stopGroup); state.stopLayers.set(stop.id, marker);
  }
}

function stopMarker(stop, provider) {
  const marker = provider.id === 'emt'
    ? L.circleMarker(latlng(stop.coords), { pane: 'stops', renderer: stopRenderer, className: 'stop-marker', radius: 3, color: '#ffffff', weight: 1.5, fillColor: provider.color, fillOpacity: .8 })
    : L.marker(latlng(stop.coords), { pane: 'stops', icon: L.divIcon({ className: `provider-stop provider-stop-${provider.id}`, iconSize: [40, 40], iconAnchor: [20, 20], html: `<span style="--provider-color:${provider.color}">${provider.symbol}</span>` }), title: `${provider.name} · ${stop.name}` });
  marker._stopLabel = { stop, provider };
  marker.bindTooltip(escape(provider.id === 'emt' || provider.id === 'atmv' ? stop.id : stop.name), { permanent: true, interactive: true, direction: 'right', offset: [10, 0], className: `stop-map-label${provider.id === 'emt' ? ' stop-number-tooltip' : ''}` });
  marker.off('add', marker._openTooltip);
  return marker;
}

async function showContextStops() {
  const generation = ++state.contextEpoch;
  contextGroup.eachLayer(clearStopTooltip);
  contextGroup.clearLayers();
  if (!state.contextStops) return;
  const currentProvider = state.provider.id;
  await Promise.all([...providers.values()].filter(p => p.id !== currentProvider).map(async provider => {
    try {
      const network = state.networks.get(provider.id) || await provider.getNetwork();
      state.networks.set(provider.id, network);
      if (generation !== state.contextEpoch || !state.contextStops) return;
      for (const stop of network.stops) {
        stopMarker(stop, provider).on('click', () => switchProvider(provider.id, stop.id)).addTo(contextGroup);
      }
      updateStopNumberLabels();
    } catch { if (generation === state.contextEpoch) toast(`No se pueden cargar las paradas de ${provider.name}.`); }
  }));
}

async function selectStop(stop) {
  if (!stop) return;
  state.generation++; state.controller?.abort(); clearTimeout(state.poll);
  state.selected = stop; state.arrivals = []; state.observedAt = null; state.lastError = ''; state.busy = false; state.sheetExpanded = false;
  $('#workspace').classList.remove('is-stop-expanded');
  state.activeLine = null; state.approaches.clear(); clearBuses(); selectionGroup.clearLayers();
  $('#search-results').hidden = true; $('#search').value = '';
  const selectionColor = state.provider.color;
  L.circleMarker(latlng(stop.coords), { pane: 'selection', radius: 18, color: selectionColor, weight: 3, fillColor: selectionColor, fillOpacity: .16 }).addTo(selectionGroup);
  L.circleMarker(latlng(stop.coords), { pane: 'selection', radius: 7, color: '#ffffff', weight: 3, fillColor: selectionColor, fillOpacity: 1 }).addTo(selectionGroup);
  for (const [line, models] of state.models) state.approaches.set(line, state.provider.getApproach(models, stop));
  const url = new URL(location.href); url.searchParams.set('stop', stop.id); url.searchParams.set('provider', state.provider.id); history.replaceState(null, '', url);
  map.flyTo(latlng(stop.coords), Math.max(map.getZoom(), 16), { duration: .7, animate: state.animate });
  renderLineList(); renderStop(); updateLayers();
  await refreshArrivals();
}

function schedulePoll() {
  clearTimeout(state.poll);
  if (!document.hidden && state.selected) state.poll = setTimeout(refreshArrivals, state.provider.interval);
}

async function refreshArrivals() {
  if (state.busy || !state.selected || document.hidden) return;
  const generation = state.generation, stop = state.selected, provider = state.provider;
  state.busy = true; state.controller = new AbortController();
  connection('Actualizando', 'loading'); renderStop();
  try {
    const incoming = await provider.getArrivals(stop, state.controller.signal);
    if (generation !== state.generation) return;
    state.arrivals = reconcileArrivals(state.arrivals, incoming);
    state.observedAt = Date.now(); state.lastError = '';
    // Render the ETA immediately; geographic requests may complete independently.
    syncBuses(); updateLayers();
    // Geometry cannot delay the realtime polling clock or hide already-published GPS.
    loadStopRoutes(provider, stop, generation, incoming, state.controller.signal);
    connection(`En directo · ${provider.name}${state.source === 'proxy' ? ' · proxy' : ''}`);
  } catch (error) {
    if (generation !== state.generation || state.controller.signal.aborted) return;
    state.lastError = error.message; connection('Sin actualización', 'error');
  } finally {
    if (generation === state.generation) { state.busy = false; renderStop(); schedulePoll(); }
  }
}

async function loadStopRoutes(provider, stop, generation, incoming, signal) {
  if (provider.getStopLines) {
    try {
      const lines = await provider.getStopLines(stop, signal);
      if (generation !== state.generation) return;
      stop.lines = lines;
    } catch (error) {
      if (generation !== state.generation || signal.aborted) return;
      state.lastError = `Llegadas disponibles; no se han podido consultar todas las líneas: ${error.message}`;
    }
  }
  if (generation !== state.generation) return;
  const routeQueue = [...new Set([...incoming.map(a => a.line), ...servingLines(stop)])];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (routeQueue.length && generation === state.generation) {
      const line = routeQueue.shift();
      const models = await loadLine(line).catch(() => []);
      if (generation !== state.generation) return;
      state.approaches.set(line, provider.getApproach(models, stop));
      syncBuses(); renderStop(); updateLayers();
    }
  }));
}

function clearBuses() { busGroup.clearLayers(); state.buses.clear(); }

function arrivalApproach(arrival) {
  if (!state.selected) return null;
  const models = state.models.get(arrival.line);
  if (arrival._models === models && arrival._stop === state.selected) return arrival._approach;
  arrival._models = models; arrival._stop = state.selected;
  arrival._approach = state.provider.getApproach(models || [], state.selected, arrival);
  if (!arrival._approach && arrival.position?.coords && models) {
    arrival._approach = approachForPosition(models, state.selected, arrival.position.coords);
  }
  return arrival._approach;
}

function vehicleHeading(approach, arrival, now) {
  const path = approach?.path;
  if (!path?.length || !Number.isFinite(approach.offset)) return null;
  const distanceToStop = Number.isFinite(approach.vehicleDistance)
    ? approach.vehicleDistance
    : arrival.arrivalAt == null ? null : Math.max(0, (arrival.arrivalAt - now) / 1000 * state.speed / 3.6);
  if (distanceToStop == null) return null;

  let currentOffset = approach.offset - distanceToStop;
  if (path.circular) currentOffset = (currentOffset % path.length + path.length) % path.length;
  else if (currentOffset < 0 || currentOffset > path.length) return null;
  const step = path.circular ? 20 : Math.min(20, currentOffset);
  if (step < 1) return null;
  let nextOffset = currentOffset + step;
  if (path.circular) nextOffset = (nextOffset % path.length + path.length) % path.length;

  const from = pointAt(path, currentOffset), to = pointAt(path, nextOffset);
  if (!from || !to) return null;
  const start = map.latLngToLayerPoint(latlng(from));
  const end = map.latLngToLayerPoint(latlng(to));
  return Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
}

function arrivalPosition(arrival, now = Date.now(), approach = arrivalApproach(arrival)) {
  if (arrival.position) {
    const measured = arrival.position.timestamp ?? arrival.position.receivedAt;
    if (now - measured > 90000 || now - arrival.observedAt > 90000 || (arrival.arrivalAt != null && now > arrival.arrivalAt + 15000)) return null;
    return arrival.position.coords;
  }
  return estimatePosition(approach, arrival, now, state.speed);
}

function positionNote(arrival) {
  if (arrival.position?.kind === 'gps') return `GPS · ${new Date(arrival.position.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  if (arrival.position?.kind === 'reported') return 'Posición publicada · hora GPS no indicada';
  return `Estimación · ≈ ${(Math.max(0, arrival.arrivalAt - Date.now()) / 1000 * state.speed / 3600).toFixed(1)} km`;
}

function busIcon(line) {
  const code = String(line);
  const width = Math.max(66, Math.min(120, 48 + code.length * 9));
  const mode = state.provider.id === 'metro' ? 'metro' : state.provider.kind === 'train' ? 'train' : 'bus';
  return L.divIcon({ className: `bus-icon bus-icon-${mode}`, iconSize: [width, 40], iconAnchor: [20, 20],
    html: `<span class="vehicle-badge" style="--route-color:${color(line)};--route-ink:${contrastColor(color(line))};--badge-width:${width}px"><span class="vehicle-disc"><span class="vehicle-direction" hidden aria-hidden="true"></span><span class="vehicle-mode" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="16" rx="3"></rect><path d="M5 11h14M8 19v2m8-2v2M8 15h.01M16 15h.01"></path></svg></span></span><span class="vehicle-code">${escape(code)}</span></span>` });
}

function syncBuses() {
  const ids = new Set(state.arrivals.map(a => a.id));
  for (const [id, bus] of state.buses) if (!ids.has(id)) { busGroup.removeLayer(bus.marker); state.buses.delete(id); }
  for (const arrival of state.arrivals) {
    const approach = arrivalApproach(arrival);
    const position = arrivalPosition(arrival, Date.now(), approach);
    if (!position) {
      const old = state.buses.get(arrival.id);
      if (old) { busGroup.removeLayer(old.marker); state.buses.delete(arrival.id); }
      continue;
    }
    const old = state.buses.get(arrival.id);
    // Blend prediction times rather than latitude/longitude: corrections stay on the route.
    const now = Date.now();
    if (old) {
      const fraction = Math.min(1, (now - old.changedAt) / 4000);
      old.fromArrivalAt = old.fromArrivalAt + (old.arrival.arrivalAt - old.fromArrivalAt) * fraction;
      old.arrival = arrival; old.changedAt = now; old.approach = approach;
    } else {
      const marker = L.marker(latlng(position), { pane: 'vehicles', icon: busIcon(arrival.line), title: `${state.provider.name}, ${arrival.position ? 'posición publicada' : 'posición estimada'}, línea ${arrival.line}, ${arrival.destination}`, riseOnHover: true });
      state.buses.set(arrival.id, { marker, arrival, approach, fromArrivalAt: arrival.arrivalAt, changedAt: now });
    }
    const bus = state.buses.get(arrival.id);
    bus.marker.bindPopup(`<strong>${escape(state.provider.name)} · ${escape(arrival.line)} → ${escape(arrival.destination)}</strong><br>Hacia ${escape(state.selected.name)}<br>${escape(positionNote(arrival))}<br><small>Previsión: ${escape(arrival.raw)}${arrival.vehicleId ? ` · Vehículo ${escape(arrival.vehicleId)}` : ''}${arrival.platform ? ` · Andén ${escape(arrival.platform)}` : ''}</small>`);
    if (bus.marker.getElement()) bus.marker.getElement().dataset.positionKind = arrival.position?.kind || 'estimated';
  }
  drawBuses(Date.now());
}

function drawBuses(now) {
  for (const bus of state.buses.values()) {
    const age = now - bus.arrival.observedAt;
    const fraction = state.animate ? Math.min(1, (now - bus.changedAt) / 4000) : 1;
    const arrival = { ...bus.arrival, arrivalAt: bus.fromArrivalAt + (bus.arrival.arrivalAt - bus.fromArrivalAt) * fraction };
    const clock = state.animate ? now : bus.arrival.observedAt;
    const position = bus.arrival.position ? arrivalPosition(bus.arrival, now, bus.approach)
      : age <= 90000 && now <= bus.arrival.arrivalAt + 15000 ? estimatePosition(bus.approach, arrival, clock, state.speed) : null;
    const visible = position && (!state.activeLine || state.activeLine === bus.arrival.line);
    if (visible) {
      bus.marker.setLatLng(latlng(position));
      if (!busGroup.hasLayer(bus.marker)) bus.marker.addTo(busGroup);
      bus.marker.getElement().dataset.positionKind = bus.arrival.position?.kind || 'estimated';
      const direction = bus.marker.getElement().querySelector('.vehicle-direction');
      const heading = vehicleHeading(bus.approach, bus.arrival, now);
      direction.hidden = heading == null;
      if (heading != null) {
        direction.style.setProperty('--heading', `${heading}deg`);
        direction.dataset.heading = heading.toFixed(1);
      } else delete direction.dataset.heading;
      bus.marker.setOpacity(age > 45000 ? .5 : 1);
    } else busGroup.removeLayer(bus.marker);
  }
}

let lastFrame = 0;
function animate(now) {
  if (!document.hidden && now - lastFrame > 50) { drawBuses(Date.now()); lastFrame = now; }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function reason(arrival) {
  if (arrival.programmed) return 'Horario programado · sin posición';
  if (Date.now() - arrival.observedAt > 90000) return 'Datos antiguos · sin posición';
  if (arrival.arrivalAt != null && Date.now() > arrival.arrivalAt + 15000) return 'Pendiente de nueva previsión';
  if (arrival.positionNote) return arrival.positionNote;
  if (arrival.position) return 'Posición publicada antigua · sin marcador';
  if (!state.models.has(arrival.line)) return state.routeFailures.has(arrival.line) ? 'Recorrido no disponible' : 'Cargando recorrido…';
  if (!arrivalApproach(arrival)) return 'Sentido no resuelto · sin posición';
  return 'Fuera del tramo estimable';
}

function etaLabel(arrival) {
  if (arrival.arrivalAt == null) return '<small>Sin ETA</small>';
  if (arrival.programmed) return escape(arrival.raw);
  const now = Date.now(), arrivalAt = adjustedArrivalAt(arrival, arrivalApproach(arrival), now, state.speed);
  if (now - arrival.observedAt > 90000 || now > arrival.arrivalAt + 15000) return '—';
  const minutes = Math.max(0, Math.ceil((arrivalAt - now) / 60000));
  const locationAdjusted = arrivalAt < arrival.arrivalAt;
  return minutes <= 0 ? `Ya${locationAdjusted ? '<small>GPS</small>' : ''}` : `${minutes}<small>min${locationAdjusted ? ' · GPS' : ''}</small>`;
}

function renderStop() {
  if (!state.selected) return;
  const stop = state.selected, lines = servingLines(stop);
  const arrivals = state.arrivals.filter(a => !state.activeLine || a.line === state.activeLine);
  const nextArrival = arrivals[0];
  const nextSummary = nextArrival ? `<span>Próxima llegada</span><strong>${etaLabel(nextArrival)}</strong><span>${escape(nextArrival.line)} · ${escape(nextArrival.destination)}</span>` : `<span>${state.busy ? 'Consultando llegadas' : 'Sin llegadas disponibles ahora'}</span>`;
  $('#stop-panel').innerHTML = `<div class="stop-heading"><span class="stop-symbol" style="--provider-color:${state.provider.color}" aria-hidden="true">${state.provider.symbol}</span><div class="stop-heading-copy"><span class="stop-code">PARADA ${escape(stop.id)} · ${escape(state.provider.name)}</span><h2 id="stop-name">${escape(stop.name)}</h2></div><button id="stop-panel-toggle" class="sheet-toggle" aria-expanded="${state.sheetExpanded}" aria-controls="arrival-content"><span>${state.sheetExpanded ? 'Ocultar' : 'Llegadas'}</span><span aria-hidden="true">${state.sheetExpanded ? '⌄' : '⌃'}</span></button></div>
    <div class="sheet-summary">${nextSummary}</div>
    <div id="arrival-content" class="arrival-content"><div class="stop-lines">${lines.map(chip).join('')}</div>
    <div class="section-heading"><h3>PRÓXIMAS LLEGADAS${state.activeLine ? ` · ${escape(state.activeLine)}` : ''}</h3><button id="refresh" class="text-button" ${state.busy ? 'disabled' : ''} aria-label="Actualizar llegadas">↻ Actualizar</button></div>
    ${state.lastError ? `<div class="notice error" role="alert">${escape(state.lastError)}${state.observedAt ? '<br>Se muestra la última consulta; las posiciones caducan a los 90 s.' : ''}</div>` : ''}
    <div class="arrival-list">${arrivals.map(arrival => {
      const position = arrivalPosition(arrival);
      return `<article class="arrival-card" style="--route-color:${color(arrival.line)};--route-ink:${contrastColor(color(arrival.line))}" data-arrival="${escape(arrival.id)}"><div class="arrival-main"><span class="route-badge">${escape(arrival.line)}</span><div class="arrival-destination">${escape(arrival.destination)}<small>${arrival.occupancy ? `Ocupación: ${escape(arrival.occupancy)}` : 'Dirección'}</small></div><span class="eta">${etaLabel(arrival)}</span></div><div class="arrival-meta"><span data-position-note>${position ? positionNote(arrival) : reason(arrival)}</span><button data-bus="${escape(arrival.id)}" ${position ? '' : 'hidden'}>Ver en mapa ↗</button></div></article>`;
    }).join('') || (!state.lastError ? `<div class="empty-state"><p>${state.busy ? 'Consultando las próximas llegadas…' : state.activeLine ? 'Sin previsiones disponibles para esta línea.' : 'La fuente no publica llegadas o vehículos asociados a esta parada en este momento.'}</p></div>` : '')}</div>
    <div class="update-info"><span id="updated-age">${state.observedAt ? 'Actualizado ahora' : 'Esperando datos'}</span><span>Consulta cada ${state.provider.interval / 1000} s</span></div>
    ${lines.length && !state.activeLine ? `<p class="muted">${lines.filter(line => !state.arrivals.some(a => a.line === line)).length ? 'También se muestran líneas sin previsión de llegada en sus recorridos vigentes.' : 'Pulsa una línea para destacar su recorrido.'}</p>` : ''}</div>`;
  $('#workspace').classList.toggle('is-stop-expanded', state.sheetExpanded);
}

function setStopPanelExpanded(expanded) {
  state.sheetExpanded = expanded;
  $('#workspace').classList.toggle('is-stop-expanded', expanded);
  $('#stop-panel-toggle')?.setAttribute('aria-expanded', String(expanded));
  const label = $('#stop-panel-toggle span');
  if (label) label.textContent = expanded ? 'Ocultar' : 'Llegadas';
  $('#stop-panel-toggle span:last-child').textContent = expanded ? '⌄' : '⌃';
  requestAnimationFrame(() => map.invalidateSize({ pan: false }));
}

function renderLineList() { $('#line-list').innerHTML = [...state.lines.keys()].sort(sortLines).map(chip).join(''); }

async function selectLine(line) {
  const epoch = state.epoch;
  state.activeLine = state.activeLine === line ? null : line;
  renderLineList(); renderStop(); updateLayers(); drawBuses(Date.now());
  if (state.activeLine) {
    try {
      await loadLine(line);
      if (state.epoch === epoch && state.activeLine === line) {
        const bounds = state.routeLayers.get(line)?.getBounds();
        if (bounds?.isValid()) map.fitBounds(bounds, { padding: [55, 55], maxZoom: 15, animate: state.animate });
        syncBuses(); renderStop();
      }
    } catch (error) { if (state.epoch === epoch) toast(error.message); }
  }
}

function fitBuses() {
  const points = [...state.buses.values()].filter(b => busGroup.hasLayer(b.marker)).map(b => b.marker.getLatLng());
  if (state.selected) points.push(latlng(state.selected.coords));
  if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [65, 65], maxZoom: 16, animate: state.animate });
  else map.setView([39.472, -0.370], 13);
}

function searchStops() {
  const query = normalize($('#search').value.trim());
  const results = $('#search-results');
  if (!query) { results.hidden = true; return; }
  const matches = state.stops.filter(stop => stop.id.includes(query) || normalize(stop.name).includes(query))
    .sort((a, b) => (b.id === query) - (a.id === query) || a.name.localeCompare(b.name)).slice(0, 12);
  results.innerHTML = matches.map(stop => `<button class="search-result" data-stop="${escape(stop.id)}"><strong>${escape(stop.id)}</strong><span>${escape(stop.name)}</span></button>`).join('') || '<p>No encontramos esa parada.</p>';
  results.hidden = false;
}

$('#search').addEventListener('input', searchStops);
$('#search').addEventListener('keydown', event => {
  if (event.key === 'Escape') $('#search-results').hidden = true;
  if (event.key === 'ArrowDown') { event.preventDefault(); $('#search-results button')?.focus(); }
  if (event.key === 'Enter') $('#search-results button')?.click();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('#settings').open) { event.preventDefault(); $('#search').focus(); }
});
document.addEventListener('click', event => {
  if (event.target.closest('#stop-panel-toggle')) { setStopPanelExpanded(!state.sheetExpanded); return; }
  const stop = event.target.closest('[data-stop]');
  if (stop) selectStop(state.stops.find(s => s.id === stop.dataset.stop));
  const line = event.target.closest('[data-line]');
  if (line) selectLine(line.dataset.line);
  const busButton = event.target.closest('[data-bus]');
  if (busButton) {
    const bus = state.buses.get(busButton.dataset.bus);
    if (bus && busGroup.hasLayer(bus.marker)) { map.setView(bus.marker.getLatLng(), 16, { animate: state.animate }); bus.marker.openPopup(); }
  }
  if (event.target.closest('#refresh')) refreshArrivals();
});
$('#fit').addEventListener('click', fitBuses);
$('#all-routes').addEventListener('change', event => { state.allRoutes = event.target.checked; updateLayers(); });
$('#clear-line').addEventListener('click', () => { state.activeLine = null; renderLineList(); renderStop(); updateLayers(); drawBuses(Date.now()); });
function toggleLines(open) { $('#line-panel').hidden = !open; $('#lines-toggle').setAttribute('aria-expanded', String(open)); }
$('#lines-toggle').addEventListener('click', () => toggleLines($('#line-panel').hidden));
$('#lines-close').addEventListener('click', () => toggleLines(false));
$('#settings-open').addEventListener('click', () => $('#settings').showModal());
$('#settings').addEventListener('click', event => { if (event.target === $('#settings')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('#speed').addEventListener('input', event => {
  state.speed = Number(event.target.value); $('#speed-value').value = state.speed;
  syncBuses(); renderStop(); saveSettings();
});
$('#animate').addEventListener('change', event => { state.animate = event.target.checked; saveSettings(); drawBuses(Date.now()); });
$('#transport').addEventListener('change', event => {
  setTransport(event.target.value); configureTransport(event.target.value); saveSettings();
  if (state.stops.length) refreshArrivals(); else initialize();
});
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Tu navegador no permite geolocalización.');
  navigator.geolocation.getCurrentPosition(position => {
    const coords = [position.coords.longitude, position.coords.latitude];
    if (locationMarker) map.removeLayer(locationMarker);
    locationMarker = L.circleMarker(latlng(coords), { radius: 7, color: '#fff', fillColor: '#7dbaf5', fillOpacity: 1 }).addTo(map).bindTooltip('Tu ubicación');
    map.setView(latlng(coords), 16);
    const nearest = [...state.stops].sort((a, b) => distance(a.coords, coords) - distance(b.coords, coords))[0];
    if (nearest) toast(`Parada más cercana: ${nearest.id} · ${nearest.name} (${Math.round(distance(nearest.coords, coords))} m)`);
  }, () => toast('No se ha podido obtener tu ubicación. Puedes buscar una parada.'), { timeout: 10000, maximumAge: 60000 });
});
map.on('zoomend', updateLayers);
map.on('moveend', updateStopNumberLabels);
new ResizeObserver(() => map.invalidateSize()).observe($('#map'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.poll);
  else { if (!state.busy) refreshArrivals(); if (Date.now() - state.routeRefresh > 600000 && !state.loading.size) loadAllRoutes(); }
});
window.addEventListener('online', () => { if (state.stops.length) refreshArrivals(); else initialize(); });
window.addEventListener('offline', () => connection('Sin conexión', 'error'));
setInterval(() => {
  if (!document.hidden && state.lines.size && !state.loading.size && Date.now() - state.routeRefresh >= 600000) loadAllRoutes();
}, 60000);

function saveSettings() {
  try { localStorage.setItem('enruta-settings', JSON.stringify({ speed: state.speed, animate: state.animate, transport: $('#transport').value })); } catch { /* Storage may be disabled. */ }
}
try {
  const stored = JSON.parse(localStorage.getItem('enruta-settings') || '{}');
  if (stored.speed >= 6 && stored.speed <= 30) state.speed = Number(stored.speed);
  if (typeof stored.animate === 'boolean') state.animate = stored.animate;
  if (['auto', 'direct', 'proxy'].includes(stored.transport)) $('#transport').value = stored.transport;
} catch { /* Use defaults if storage is unavailable. */ }
$('#speed').value = state.speed; $('#speed-value').value = state.speed; $('#animate').checked = state.animate;
setTransport($('#transport').value, source => { state.source = source; });
configureTransport($('#transport').value, source => { state.source = source; });

setInterval(() => {
  if (!state.selected || document.hidden) return;
  if (state.observedAt) {
    const age = Math.floor((Date.now() - state.observedAt) / 1000);
    if ($('#updated-age')) $('#updated-age').textContent = age > 90 ? `Datos antiguos · hace ${age} s` : `Actualizado hace ${age} s`;
    if (age > 90) connection('Datos antiguos', 'error');
  }
  for (const arrival of state.arrivals) {
    const card = document.querySelector(`[data-arrival="${CSS.escape(arrival.id)}"]`);
    if (!card) continue;
    card.querySelector('.eta').innerHTML = etaLabel(arrival);
    const position = arrivalPosition(arrival);
    card.querySelector('[data-position-note]').textContent = position ? positionNote(arrival) : reason(arrival);
    card.querySelector('[data-bus]').hidden = !position;
  }
}, 1000);

async function initialize() {
  const epoch = state.epoch, provider = state.provider;
  connection('Cargando red', 'loading'); $('#network-error').hidden = true;
  try {
    const network = await provider.getNetwork();
    state.networks.set(provider.id, network);
    if (epoch !== state.epoch) return;
    state.stops = network.stops;
    if ($('#search').value.trim()) searchStops();
    network.lines.sort((a, b) => sortLines(a.id, b.id)).forEach((item, index) => state.lines.set(item.id, {
      ...item, color: item.color || routePalette[index % routePalette.length], loadedAt: 0,
    }));
    showStops(); renderLineList();
    $('#network-count').textContent = `${state.stops.length.toLocaleString('es')} paradas · ${state.lines.size} líneas`;
    connection(`${provider.name} · red conectada`);
    const requested = new URLSearchParams(location.search).get('stop');
    if (requested) {
      const stop = state.stops.find(s => s.id === requested);
      if (stop) selectStop(stop); else toast(`La parada ${requested} no está en la red publicada.`);
    }
    loadAllRoutes();
    showContextStops();
  } catch (error) {
    if (epoch !== state.epoch) return;
    connection(`Sin conexión con ${provider.name}`, 'error');
    $('#network-error').hidden = false;
    $('#network-error').textContent = error.message;
    const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = 'Reintentar'; retry.addEventListener('click', initialize);
    $('#network-error').append(retry); $('#network-count').textContent = 'Red no disponible';
  }
}

async function switchProvider(id, stopId) {
  const provider = providers.get(id);
  if (!provider) return;
  state.epoch++; state.generation++; state.contextEpoch++;
  state.controller?.abort(); clearTimeout(state.poll);
  state.provider = provider; state.selected = null; state.arrivals = []; state.observedAt = null;
  state.lastError = ''; state.busy = false; state.stops = []; state.activeLine = null;
  for (const layer of state.routeLayers.values()) map.removeLayer(layer);
  for (const key of ['lines', 'models', 'loading', 'routeLayers', 'approaches', 'stopLayers']) state[key].clear();
  state.routeFailures.clear(); clearBuses();
  stopGroup.eachLayer(clearStopTooltip); contextGroup.eachLayer(clearStopTooltip);
  stopGroup.clearLayers(); contextGroup.clearLayers(); selectionGroup.clearLayers();
  state.speed = provider.speed; $('#speed').value = state.speed; $('#speed-value').value = state.speed;
  $('#provider-select').value = id; $('#provider-description').textContent = provider.description;
  $('#provider-source').href = provider.source; $('#provider-source').textContent = `Fuente: ${provider.name} ↗`;
  $('.city-label').textContent = `VALÈNCIA / ${provider.name.toUpperCase()}`;
  state.sheetExpanded = false; $('#workspace').classList.remove('is-stop-expanded');
  $('#stop-panel').innerHTML = '<div class="empty-state"><h2>Selecciona una parada</h2><p>Busca por nombre o número, o elige una parada directamente en el mapa.</p></div>';
  $('#search').value = ''; $('#search-results').hidden = true; $('#line-list').innerHTML = '';
  $('#route-progress').textContent = ''; $('#network-count').textContent = 'Cargando red…';
  const url = new URL(location.href); url.searchParams.set('provider', id);
  if (stopId) url.searchParams.set('stop', stopId); else url.searchParams.delete('stop');
  history.replaceState(null, '', url);
  await initialize();
}
$('#provider-select').innerHTML = [...providers.values()].map(p => `<option value="${p.id}">${p.name}</option>`).join('');
$('#provider-select').addEventListener('change', event => switchProvider(event.target.value));
$('#context-stops').addEventListener('change', event => { state.contextStops = event.target.checked; showContextStops(); });
const initial = new URLSearchParams(location.search);
switchProvider(providers.has(initial.get('provider')) ? initial.get('provider') : 'emt', initial.get('stop'));
