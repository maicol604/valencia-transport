import { setTransport } from './services/emt-api.js';
import { estimatePosition, distance, pathTangent, approachForPosition, positionOnApproach } from './geo.js';
import { adjustedArrivalAt, reconcileArrivals } from './arrivals.js';
import { providers } from './services/index.js';
import { configureTransport } from './services/transport.js';
import { glyphPath, glyphSVG } from './icons.js';
import { applyDocumentTranslations, getLanguage, getLocale, setLanguage, t } from './i18n.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const latlng = coords => [coords[1], coords[0]];
const sortLines = (a, b) => a.localeCompare(b, getLocale(), { numeric: true });
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
applyDocumentTranslations();
$('#language').value = getLanguage();
const state = {
  stops: [], lines: new Map(), models: new Map(), loading: new Map(), routeLayers: new Map(),
  stopLayers: new Map(), buses: new Map(), approaches: new Map(), selected: null, arrivals: [],
  activeLine: null, allRoutes: false, sheetExpanded: false, speed: 12, advancedSettings: false, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  generation: 0, controller: null, poll: null, observedAt: null, lastError: '', busy: false,
  routeFailures: new Set(), source: 'direct', routeRefresh: 0,
  provider: providers.get('emt'), epoch: 0, networks: new Map(), contextStops: false, contextEpoch: 0,
  lineServiceStatus: new Map(),
};

const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10, maxZoom: 19, rotate: true, touchRotate: true, rotateControl: false }).setView([39.472, -0.370], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const stopRenderer = L.canvas({ pane: 'stops', tolerance: 10 });
const routeRenderer = L.svg({ pane: 'routes' });
const providerStyle = provider => `--provider-color:${provider.color};--provider-ink:${provider.ink || '#fff'}`;

// Canvas circle with the operator pictogram: thousands of bus stops stay cheap to draw.
const IconStop = L.CircleMarker.extend({
  _updatePath() {
    const renderer = this._renderer;
    if (!renderer._drawing || this._empty()) return;
    const ctx = renderer._ctx, { x, y } = this._point, radius = this._radius, options = this.options;
    ctx.save();
    ctx.globalAlpha = options.opacity;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (radius >= 7) { ctx.shadowColor = 'rgba(15,26,42,.3)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1.5; }
    ctx.fillStyle = options.fillColor; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = options.weight; ctx.strokeStyle = options.color; ctx.stroke();
    if (radius >= 7 && options.glyph) {
      const size = radius * 1.18;
      ctx.translate(x - size / 2, y - size / 2); ctx.scale(size / 24, size / 24);
      ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = options.ink;
      ctx.stroke(glyphPath(options.glyph));
    }
    ctx.restore();
  },
});
const stopRadius = (zoom, selected) => selected ? zoom >= 18 ? 6 : 13 : zoom <= 13 ? 3.5 : zoom === 14 ? 5 : zoom === 15 ? 9 : 11;
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).on('tileerror', () => toast('El mapa base no está disponible. Comprueba tu conexión.')).addTo(map);
const rotatePane = map.getPane('rotatePane');
map.createPane('routes', rotatePane); map.getPane('routes').style.zIndex = 410;
map.createPane('stops', rotatePane); map.getPane('stops').style.zIndex = 430;
map.createPane('railStops'); map.getPane('railStops').style.zIndex = 430;
map.createPane('vehicles'); map.getPane('vehicles').style.zIndex = 660;
map.createPane('selection'); map.getPane('selection').style.zIndex = 670;
const stopGroup = L.layerGroup().addTo(map);
const selectionGroup = L.layerGroup().addTo(map);
const busGroup = L.layerGroup().addTo(map);
const contextGroup = L.layerGroup().addTo(map);
let locationMarker = null, latestLocation = null, toastTimeout;
let latestConnection = { label: 'Conectando', status: 'loading', values: {} };

map.on('click', event => {
  if (event.layer || !(event.originalEvent?.target instanceof HTMLCanvasElement)) return;
  const point = event.originalEvent;
  const markers = [...state.stopLayers.values()];
  contextGroup.eachLayer(marker => { if (marker._stopLabel) markers.push(marker); });
  const nearest = markers.map(marker => ({ marker, point: map.latLngToContainerPoint(marker.getLatLng()) }))
    .map(item => ({ ...item, distance: item.point.distanceTo(event.containerPoint) }))
    .sort((first, second) => first.distance - second.distance)[0];
  if (nearest?.distance < 24) { nearest.marker.fire('click'); return; }
  const marker = markers.find(item => {
    const tooltip = item.isTooltipOpen() && item.getTooltip()?.getElement();
    if (!tooltip) return false;
    const bounds = tooltip.getBoundingClientRect();
    return point.clientX >= bounds.left && point.clientX <= bounds.right && point.clientY >= bounds.top && point.clientY <= bounds.bottom;
  });
  marker?.fire('click');
});

function toast(message, values = {}) {
  $('#toast').textContent = t(message, values); $('#toast').hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function connection(label, status = 'ok', values = {}) {
  latestConnection = { label, status, values };
  $('#connection').dataset.state = status;
  $('#connection span').textContent = t(label, values);
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
  const inactive = state.lineServiceStatus.get(line) === false;
  const label = `${state.lines.get(line)?.name || t('Línea {line}', { line })}${inactive ? `, ${t('Sin servicio hoy').toLowerCase()}` : ''}`;
  return `<button class="line-chip${inactive ? ' is-inactive' : ''}" data-line="${escape(line)}" style="--route-color:${color(line)};--route-ink:${contrastColor(color(line))}" aria-pressed="${state.activeLine === line}" aria-label="${escape(label)}" title="${escape(label)}">${escape(line)}${inactive ? `<span class="line-chip-status">${t('Sin servicio hoy')}</span>` : ''}</button>`;
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
      if (models.length && models.every(model => model.serviceToday === false)) state.lineServiceStatus.set(line, false);
      else if (models.some(model => model.serviceToday === true)) state.lineServiceStatus.set(line, true);
      else state.lineServiceStatus.delete(line);
      if (state.selected) renderStop();
      if (!models.some(m => m.paths.length)) throw new Error(t('Recorrido de la línea {line} no disponible.', { line }));
      state.models.set(line, models); item.loadedAt = Date.now(); state.routeFailures.delete(line);
      if (state.routeLayers.has(line)) map.removeLayer(state.routeLayers.get(line));
      const layer = L.geoJSON({ type: 'FeatureCollection', features: models.flatMap(m => m.features) }, {
        pane: 'routes', renderer: routeRenderer, className: 'route-path', style: { color: item.color, weight: 3, opacity: .45, lineCap: 'round', lineJoin: 'round' },
        onEachFeature: (_feature, part) => {
          part.bindTooltip(`${t('Línea {line}', { line: escape(line) })} · ${escape(item.name)}`, { sticky: true });
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
  const zoom = map.getZoom();
  map.getContainer().classList.toggle('zoom-far', zoom <= 14);
  map.getContainer().classList.toggle('zoom-close', zoom >= 18);
  contextGroup.eachLayer(marker => {
    if (marker.setStyle) { marker.setStyle({ opacity: .55, weight: zoom <= 14 ? 1.5 : 2.5 }); marker.setRadius(stopRadius(zoom, false)); }
    else marker.setOpacity(.6);
  });
  for (const [id, marker] of state.stopLayers) {
    const onLine = !state.activeLine || state.models.get(state.activeLine)?.some(m => m.stopIds.has(id));
    const selected = state.selected?.id === id;
    const opacity = selected ? 1 : state.selected ? .38 : 1;
    if (marker.setStyle) {
      marker.setStyle({ opacity, weight: zoom <= 14 ? 1.5 : 2.5 });
      marker.setRadius(stopRadius(zoom, selected));
    } else marker.setOpacity(opacity);
    const element = marker.getElement();
    if (element && !marker.setStyle) element.classList.toggle('is-selected', selected && zoom < 18);
    marker.setZIndexOffset?.(selected ? 1000 : 0);
    if (selected) marker.bringToFront?.();
  }
  updateStopNumberLabels();
}

function updateStopNumberLabels() {
  const bounds = map.getBounds();
  const occupied = [];
  const insets = mapInsets(), size = map.getSize();
  const uncovered = point => point.y > insets.top - 20 && point.y < size.y - insets.bottom + 10 && point.x > (innerWidth >= 900 ? insets.left - 16 : 0);
  const markers = [...state.stopLayers.entries()].map(([id, marker]) => ({ id, marker, selected: state.selected?.id === id, context: false }));
  contextGroup.eachLayer(marker => { if (marker._stopLabel) markers.push({ marker, selected: false, context: true }); });
  markers.sort((first, second) => Number(second.selected) - Number(first.selected) || Number(first.context) - Number(second.context));
  for (const { id, marker, selected, context } of markers) {
    const inView = bounds.contains(marker.getLatLng());
    let visible = false;
    const { stop, provider } = marker._stopLabel;
    const bike = provider.kind === 'bike';
    const showNearbyLabels = map.getZoom() >= (provider.kind === 'bus' ? 16 : 15);
    if (!state.selected && inView && showNearbyLabels) {
      const point = map.latLngToContainerPoint(marker.getLatLng());
      const lines = bike ? [] : (stop.lines || []).slice(0, 4);
      const width = bike ? 86 : Math.min(map.getSize().x <= 600 ? 235 : 265, 56 + stop.name.length * 7 + (provider.kind === 'bus' ? 38 : 0) + lines.length * 22);
      const needsLeft = point.x + width + 15 > map.getSize().x;
      const vertical = needsLeft && point.x - width - 10 < 0;
      const direction = vertical ? (point.y > 60 ? 'top' : 'bottom') : needsLeft ? 'left' : 'right';
      const left = vertical ? point.x - width / 2 : needsLeft ? point.x - width - 10 : point.x + (bike ? 10 : -17);
      const box = { left, right: left + width, top: vertical ? point.y + (direction === 'top' ? -60 : 10) : point.y - 24, bottom: vertical ? point.y + (direction === 'top' ? -10 : 60) : point.y + 24 };
      marker.getTooltip().options.direction = direction;
      // Rightward transit labels sit on the stop so their operator badge doubles as the marker.
      marker.getTooltip().options.offset = direction === 'left' ? [-14, 0] : direction === 'right' ? [bike ? 14 : -23, 0] : direction === 'top' ? [0, -14] : [0, 14];
      if (uncovered(point) && !occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) {
        occupied.push(box); visible = true;
      }
      marker.setTooltipContent(stopLabel(stop, provider, lines, context));
    }
    if (visible && !marker.isTooltipOpen()) marker.openTooltip();
    else if (!visible && marker.isTooltipOpen()) marker.closeTooltip();
    const tooltip = marker.getTooltip();
    if (tooltip && visible) {
      tooltip.setOpacity(bike ? 1 : context ? .58 : map.getZoom() <= 13 ? .88 : 1);
      tooltip.getElement()?.classList.remove('is-selected');
    }
  }
}

const availabilityLevel = count => count == null ? 'var(--muted)' : count === 0 ? 'var(--bad)' : count <= 3 ? 'var(--warn)' : 'var(--ok)';
const finite = value => Number.isFinite(value) ? value : null;
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>';
let renderedBikesKey = '';
function bikeRating(bike) {
  // A bike without any user rating is unrated, not badly rated.
  if (bike.rating == null || bike.ratingCount === 0) return { level: null, tone: 'none', label: t('Sin valoraciones') };
  const maximum = Math.max(1, bike.ratingMax || 3), level = Math.max(0, Math.min(3, Math.round((bike.rating / maximum) * 3)));
  return { level, tone: level === 3 ? 'good' : level === 2 ? 'fair' : 'poor', label: t('{level} de 3 estrellas', { level }) };
}
function bikeRow(bike, index) {
  const rating = bikeRating(bike);
  const stars = [1, 2, 3].map(n => `<i class="${rating.level != null && n <= rating.level ? 'on' : ''}">${STAR}</i>`).join('');
  const count = bike.ratingCount == null ? '' : bike.ratingCount === 0 ? t('Sin votos') : `${bike.ratingCount} ${t(bike.ratingCount === 1 ? 'voto' : 'votos')}`;
  const date = bike.lastRevisionAt ? new Date(bike.lastRevisionAt).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short' }) : null;
  const review = bike.reviewed === true ? t('Revisada') : t('Pendiente de revisión');
  return `<li class="bike-row tone-${rating.tone}" style="--i:${index}">
    <span class="bike-row-icon" aria-hidden="true">${glyphSVG('bike')}</span>
    <span class="bike-row-main"><strong>${t('Bici {id}', { id: escape(bike.id) })}</strong><small>${bike.standNumber == null ? t('Anclaje –') : t('Anclaje {number}', { number: escape(bike.standNumber) })}</small></span>
    <span class="bike-row-rating" role="img" aria-label="${escape(rating.label)}"><span class="bike-stars">${stars}</span><small>${count}</small></span>
    <span class="bike-review ${bike.reviewed === true ? 'is-reviewed' : ''}" title="${escape(`${review}${date ? t(' · última revisión {date}', { date }) : ''}`)}">${bike.reviewed === true ? t('Revisada') : t('Revisar')}${date ? `<small>${date}</small>` : ''}</span>
  </li>`;
}

function stopLabel(stop, provider, lines, context) {
  if (provider.kind === 'bike') {
    const bikes = finite(stop.availableBikes), docks = finite(stop.availableDocks);
    return `<span class="bike-count" style="--level:${availabilityLevel(bikes)}" title="${t('Bicicletas disponibles')}">${bikes ?? '–'}</span><span class="bike-docks" title="${t('Anclajes libres')}">${docks ?? '–'}</span>`;
  }
  const operator = `<span class="stop-label-operator" style="--operator-color:${provider.color};--operator-ink:${provider.ink || '#fff'}" aria-hidden="true">${glyphSVG(provider.glyph)}</span>`;
  const badges = lines.map(line => {
    const routeColor = context ? state.networks.get(provider.id)?.lines.find(item => item.id === line)?.color : state.lines.get(line)?.color;
    const safeColor = /^#[0-9a-f]{6}$/i.test(routeColor || '') ? routeColor : '#526575';
    return `<span class="stop-label-line" style="background:${safeColor};color:#fff">${escape(line)}</span>`;
  }).join('');
  return `${operator}<span class="stop-label-copy">${provider.kind === 'bus' ? `<span class="stop-label-code">${escape(stop.id)}</span>` : ''}<span class="stop-label-name">${escape(stop.name)}</span></span>${badges ? `<span class="stop-label-lines">${badges}</span>` : ''}`;
}

async function loadAllRoutes() {
  if (!state.provider.preloadRoutes) { $('#route-progress').textContent = t('Recorridos bajo demanda: elige una línea o una parada.'); state.routeRefresh = Date.now(); return; }
  const epoch = state.epoch;
  const pending = [...state.lines.keys()];
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length && epoch === state.epoch) {
      const line = pending.shift();
      await loadLine(line).catch(() => {});
      if (epoch !== state.epoch) return;
      done++;
      $('#route-progress').textContent = `${t('Recorridos: {done}/{total}', { done, total: state.lines.size })}${state.routeFailures.size ? t(' · No disponibles: {lines}', { lines: [...state.routeFailures].sort(sortLines).join(', ') }) : ''}`;
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
  if (stopRenderer._container) stopRenderer._container.style.pointerEvents = state.provider.kind === 'train' && !state.contextStops ? 'none' : 'auto';
  for (const stop of state.stops) {
    const marker = stopMarker(stop, state.provider);
    marker.on('click', () => selectStop(stop));
    marker.addTo(stopGroup); state.stopLayers.set(stop.id, marker);
  }
}

function stopMarker(stop, provider) {
  const marker = provider.kind === 'train'
    ? L.marker(latlng(stop.coords), { pane: 'railStops', icon: L.divIcon({ className: `provider-stop provider-stop-${provider.id}`, iconSize: [40, 40], iconAnchor: [20, 20], html: `<span class="stop-pin" style="${providerStyle(provider)}">${glyphSVG(provider.glyph)}</span>` }), title: `${provider.name} · ${stop.name}` })
    : new IconStop(latlng(stop.coords), { pane: 'stops', renderer: stopRenderer, className: `stop-marker provider-stop-${provider.id}`, radius: stopRadius(map.getZoom(), false), color: '#ffffff', weight: 2, opacity: 1, fillColor: provider.color, fillOpacity: 1, ink: provider.ink || '#fff', glyph: provider.glyph });
  marker._stopLabel = { stop, provider };
  marker.bindTooltip(escape(provider.kind === 'bus' ? stop.id : stop.name), { permanent: true, interactive: true, direction: 'right', offset: [14, 0], className: `stop-map-label${provider.id === 'emt' ? ' stop-number-tooltip' : ''}${provider.kind === 'bike' ? ' is-bike' : ''}` });
  marker.off('add', marker._openTooltip);
  // Leaflet does not forward tooltip clicks to canvas layers; labels must act as the stop button.
  marker.on('tooltipopen', ({ tooltip }) => {
    const element = tooltip.getElement();
    if (element && !element._selectsStop) { element._selectsStop = true; L.DomEvent.on(element, 'click', event => { L.DomEvent.stop(event); if (marker.isTooltipOpen()) marker.fire('click'); }); }
  });
  return marker;
}

async function showContextStops() {
  const generation = ++state.contextEpoch;
  contextGroup.eachLayer(clearStopTooltip);
  contextGroup.clearLayers();
  if (stopRenderer._container) stopRenderer._container.style.pointerEvents = state.provider.kind === 'train' && !state.contextStops ? 'none' : 'auto';
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
    } catch { if (generation === state.contextEpoch) toast('No se pueden cargar las paradas de {name}.', { name: provider.name }); }
  }));
}

async function selectStop(stop) {
  if (!stop) return;
  state.generation++; state.controller?.abort(); clearTimeout(state.poll);
  state.selected = stop; state.arrivals = []; state.observedAt = null; state.lastError = ''; state.busy = false; state.sheetExpanded = false;
  $('#workspace').classList.remove('is-stop-expanded');
  $('#workspace').classList.add('has-stop');
  state.activeLine = null; state.approaches.clear(); clearBuses(); selectionGroup.clearLayers();
  $('#search-results').hidden = true; $('#search').value = ''; $('#search').blur();
  L.marker(latlng(stop.coords), { pane: 'selection', interactive: false, keyboard: false, icon: L.divIcon({ className: 'selection-ring', iconSize: [56, 56], iconAnchor: [28, 28], html: `<span style="--ring:${state.provider.color}"></span>` }) }).addTo(selectionGroup);
  for (const [line, models] of state.models) state.approaches.set(line, state.provider.getApproach(models, stop));
  const url = new URL(location.href); url.searchParams.set('stop', stop.id); url.searchParams.set('provider', state.provider.id); history.replaceState(null, '', url);
  renderLineList(); renderStop(); updateLayers();
  const zoom = Math.max(map.getZoom(), 17);
  map.flyTo(visibleCenter(latlng(stop.coords), zoom), zoom, { duration: .85, easeLinearity: .25, animate: state.animate });
  await refreshArrivals();
}

// Map area not covered by the floating search, panel and dock.
function mapInsets() {
  const sheet = $('#sheet').getBoundingClientRect(), top = $('.topbar').getBoundingClientRect();
  if (innerWidth >= 900) return { left: sheet.right + 16, top: 24, right: 80, bottom: 24 };
  return { left: 16, top: top.bottom + 12, right: 64, bottom: innerHeight - sheet.top + 16 };
}
function visibleCenter(target, zoom) {
  const insets = mapInsets();
  const bearing = map.getBearing() * Math.PI / 180;
  const x = (insets.left - insets.right) / 2, y = (insets.top - insets.bottom) / 2;
  const offset = [x * Math.cos(bearing) + y * Math.sin(bearing), -x * Math.sin(bearing) + y * Math.cos(bearing)];
  const point = map.project(target, zoom).subtract(offset);
  return map.unproject(point, zoom);
}

function clearSelection() {
  state.generation++; state.controller?.abort(); clearTimeout(state.poll);
  state.selected = null; state.arrivals = []; state.observedAt = null; state.lastError = ''; state.busy = false; state.activeLine = null;
  state.sheetExpanded = false; state.approaches.clear(); clearBuses(); selectionGroup.clearLayers();
  $('#workspace').classList.remove('is-stop-expanded', 'has-stop');
  const url = new URL(location.href); url.searchParams.delete('stop'); history.replaceState(null, '', url);
  connection('{name} · red conectada', 'ok', { name: state.provider.name });
  renderIdle(); renderLineList(); updateLayers();
}

function renderIdle() {
  const provider = state.provider;
  $('#stop-panel').innerHTML = `<div class="idle"><span class="idle-icon" style="${providerStyle(provider)}" aria-hidden="true">${glyphSVG(provider.glyph)}</span><div><strong>${t(provider.kind === 'bike' ? 'Elige una estación' : 'Elige una parada')}</strong><p>${t('Tócala en el mapa o búscala por nombre o número.')}</p></div></div>`;
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
    connection('En directo · {name}{proxy}', 'ok', { name: provider.name, proxy: state.source === 'proxy' ? ' · proxy' : '' });
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
      state.lastError = t('Llegadas disponibles; no se han podido consultar todas las líneas: {error}', { error: error.message });
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
  arrival._approach = arrival.position?.coords && models
    ? approachForPosition(models.filter(model => model.allowEstimate !== false), state.selected, arrival.position.coords)
    : state.provider.getApproach(models || [], state.selected, arrival);
  return arrival._approach;
}

function vehicleHeading(approach, arrival, now) {
  const path = approach?.path;
  if (!path?.length || !Number.isFinite(approach.offset)) return null;
  let offset;
  if (arrival.position) {
    if (!Number.isFinite(approach.vehicleDistance)) return null;
    offset = approach.offset - approach.vehicleDistance;
  } else {
    if (!Number.isFinite(arrival.arrivalAt)) return null;
    const distanceToStop = Math.max(30, (arrival.arrivalAt - now) / 1000 * state.speed / 3.6);
    offset = approach.offset - distanceToStop;
  }
  const tangent = pathTangent(path, offset);
  if (!tangent) return null;
  const [from, to] = tangent;
  const start = map.latLngToContainerPoint(latlng(from));
  const end = map.latLngToContainerPoint(latlng(to));
  return Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
}

function arrivalPosition(arrival, now = Date.now(), approach = arrivalApproach(arrival)) {
  if (arrival.position) {
    const measured = arrival.position.timestamp ?? arrival.position.receivedAt;
    if (now - measured > 90000 || now - arrival.observedAt > 90000 || (arrival.arrivalAt != null && now > arrival.arrivalAt + 15000)) return null;
    if (!approach || !Number.isFinite(approach.vehicleDistance)) return null;
    return positionOnApproach(approach, approach.vehicleDistance);
  }
  return estimatePosition(approach, arrival, now, state.speed);
}

function positionNote(arrival) {
  if (arrival.position?.kind === 'gps') return t('GPS · {time}', { time: new Date(arrival.position.timestamp).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
  if (arrival.position?.kind === 'reported') return t('Posición publicada · hora GPS no indicada');
  return t('Estimación · ≈ {distance} km', { distance: (Math.max(0, arrival.arrivalAt - Date.now()) / 1000 * state.speed / 3600).toFixed(1) });
}

function busIcon(line) {
  const code = String(line);
  const width = Math.max(72, Math.min(130, 58 + code.length * 10));
  const mode = state.provider.id === 'metro' ? 'metro' : state.provider.kind === 'train' ? 'train' : 'bus';
  return L.divIcon({ className: `bus-icon bus-icon-${mode}`, iconSize: [width, 40], iconAnchor: [20, 20],
    html: `<span class="vehicle-badge" style="--route-color:${color(line)};--route-ink:${contrastColor(color(line))};--badge-width:${width}px"><span class="vehicle-disc"><span class="vehicle-direction" hidden aria-hidden="true"></span><span class="vehicle-mode" aria-hidden="true">${glyphSVG(state.provider.glyph)}</span></span><span class="vehicle-code">${escape(code)}</span></span>` });
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
      const marker = L.marker(latlng(position), { pane: 'vehicles', icon: busIcon(arrival.line), title: `${state.provider.name}, ${t(arrival.position ? 'Posición publicada' : 'Posición estimada')}, ${t('Línea {line}', { line: arrival.line })}, ${arrival.destination}`, riseOnHover: true });
      state.buses.set(arrival.id, { marker, arrival, approach, currentPosition: position, fromArrivalAt: arrival.arrivalAt, changedAt: now });
    }
    const bus = state.buses.get(arrival.id);
    bus.marker.bindPopup(`<strong>${escape(state.provider.name)} · ${escape(arrival.line)} → ${escape(arrival.destination)}</strong><br>${escape(t('Hacia {stop}', { stop: state.selected.name }))}<br>${escape(positionNote(arrival))}<br><small>${escape(t('Previsión'))}: ${escape(arrival.raw)}${arrival.vehicleId ? ` · ${escape(t('Vehículo'))} ${escape(arrival.vehicleId)}` : ''}${arrival.platform ? ` · ${escape(t('Andén {platform}', { platform: arrival.platform }))}` : ''}</small>`);
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
    let position = bus.arrival.position ? arrivalPosition(bus.arrival, now, bus.approach)
      : age <= 90000 && now <= bus.arrival.arrivalAt + 15000 ? estimatePosition(bus.approach, arrival, clock, state.speed) : null;
    const visible = position && (!state.activeLine || state.activeLine === bus.arrival.line);
    if (visible) {
      bus.currentPosition = position;
      bus.marker.setLatLng(latlng(position));
      if (!busGroup.hasLayer(bus.marker)) bus.marker.addTo(busGroup);
      bus.marker.getElement().dataset.positionKind = bus.arrival.position?.kind || 'estimated';
      const direction = bus.marker.getElement().querySelector('.vehicle-direction');
      const heading = vehicleHeading(bus.approach, bus.arrival.position ? bus.arrival : arrival, clock);
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
  if (arrival.programmed) return t('Horario programado · sin posición');
  if (Date.now() - arrival.observedAt > 90000) return t('Datos antiguos · sin posición');
  if (arrival.arrivalAt != null && Date.now() > arrival.arrivalAt + 15000) return t('Pendiente de nueva previsión');
  if (arrival.positionNote) return arrival.positionNote;
  if (arrival.position) return t('Posición publicada antigua · sin marcador');
  if (!state.models.has(arrival.line)) return state.routeFailures.has(arrival.line) ? t('Recorrido no disponible') : t('Cargando recorrido…');
  if (!arrivalApproach(arrival)) return t('Sentido no resuelto · sin posición');
  return t('Fuera del tramo estimable');
}

function etaLabel(arrival) {
  if (arrival.arrivalAt == null) return `<small>${t('Sin ETA')}</small>`;
  if (arrival.programmed) return escape(arrival.raw);
  const now = Date.now(), arrivalAt = adjustedArrivalAt(arrival, arrivalApproach(arrival), now, state.speed);
  if (now - arrival.observedAt > 90000 || now > arrival.arrivalAt + 15000) return '—';
  const minutes = Math.max(0, Math.ceil((arrivalAt - now) / 60000));
  const locationAdjusted = arrivalAt < arrival.arrivalAt;
  if (minutes <= 0) return locationAdjusted ? t('Ya<small>GPS</small>') : t('Ya');
  return locationAdjusted ? t('{minutes}<small>min · GPS</small>', { minutes }) : t('{minutes}<small>min</small>', { minutes });
}

function networkCount() {
  const stopCount = state.stops.length.toLocaleString(getLocale());
  $('#network-count').textContent = state.provider.kind === 'bike'
    ? t('{count} estaciones', { count: stopCount })
    : t('{stops} paradas · {lines} líneas', { stops: stopCount, lines: state.lines.size.toLocaleString(getLocale()) });
}

function providerDescription(provider) {
  const descriptions = {
    emt: 'Previsiones SAE en directo con posiciones estimadas según el tiempo de llegada.',
    atmv: 'Previsiones de Met Go y coordenadas del vehículo cuando están publicadas. La fuente no indica la hora de esas coordenadas; en caso contrario, se estima la posición.',
    metro: 'Próximas llegadas del panel de estación de Metrovalencia. Las posiciones son estimadas, no GPS; el destino permite determinar el sentido cuando la geometría lo permite.',
    cercanias: 'GPS de Renfe con hora de medición. Solo se muestran trenes cuyo recorrido pasa por la estación seleccionada; la previsión aparece únicamente cuando Renfe la publica.',
    valenbisi: 'Disponibilidad de bicicletas y anclajes libres en las estaciones.',
  };
  return t(descriptions[provider.id] || provider.description);
}

function renderStop() {
  if (!state.selected) return;
  const stop = state.selected, lines = servingLines(stop);
  const bike = state.provider.kind === 'bike';
  const toggleLabel = t(state.sheetExpanded ? 'Ocultar' : bike ? 'Disponibilidad' : 'Llegadas');
  const stopCode = bike ? t('Estación · {provider}', { provider: state.provider.name }) : t('Parada {id} · {provider}', { id: escape(stop.id), provider: state.provider.name });
  const heading = `<div class="stop-heading"><span class="stop-symbol" style="${providerStyle(state.provider)}" aria-hidden="true">${glyphSVG(state.provider.glyph)}</span><div class="stop-heading-copy"><span class="stop-code">${stopCode}</span><h2 id="stop-name">${escape(stop.name)}</h2></div><div class="stop-actions"><button id="stop-panel-toggle" class="sheet-toggle" aria-expanded="${state.sheetExpanded}" aria-controls="arrival-content"><span>${toggleLabel}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button><button id="stop-close" class="sheet-toggle" aria-label="${t('Cerrar')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div></div>`;
  const updateInfo = `<div class="update-info"><span id="updated-age">${t(state.observedAt ? 'Actualizado ahora' : 'Esperando datos')}</span><span>${t('Cada {seconds} s', { seconds: state.provider.interval / 1000 })}</span></div>`;
  const refresh = `<button id="refresh" class="text-button" ${state.busy ? 'disabled' : ''} aria-label="${t('Actualizar')}">${t('Actualizar')}</button>`;
  if (bike) {
    const available = finite(stop.availableBikes), docks = finite(stop.availableDocks), capacity = finite(stop.capacity);
    const bikes = (Array.isArray(stop.bikes) ? stop.bikes : []).slice().sort((a, b) => (a.standNumber ?? 999) - (b.standNumber ?? 999));
    const status = stop.status && stop.status !== 'open' ? t('Estado: {status}', { status: escape(stop.status) }) : t('Estación operativa');
    const updated = stop.lastUpdated ? new Date(stop.lastUpdated).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : null;
    const bikesKey = `${stop.id}:${bikes.map(bike => `${bike.id}@${bike.standNumber}`).join(',')}`;
    const entering = bikes.length && bikesKey !== renderedBikesKey;
    if (bikes.length) renderedBikesKey = bikesKey;
    const tones = bikes.reduce((total, bike) => { total[bikeRating(bike).tone]++; return total; }, { good: 0, fair: 0, poor: 0, none: 0 });
    const toneSummary = bikes.length ? `<span class="bike-tones">${[['good', 'buenas'], ['fair', 'regulares'], ['poor', 'malas']].filter(([tone]) => tones[tone]).map(([tone, label]) => `<span class="tone-${tone}" title="${tones[tone]} ${t(label)}"><i></i>${tones[tone]}</span>`).join('')}</span>` : '';
    const bikeList = bikes.length
      ? `<ul class="bike-list${entering ? ' is-entering' : ''}">${bikes.map(bikeRow).join('')}</ul>`
      : stop.bikes === undefined && state.busy
        ? `<ul class="bike-list is-loading" aria-label="${t('Cargando bicicletas')}">${'<li class="bike-row skeleton"></li>'.repeat(Math.min(3, available || 2))}</ul>`
        : `<p class="bike-empty">${t(stop.bikesError ? 'No se pudo actualizar la información de bicicletas.' : available === 0 ? 'No hay bicicletas ancladas ahora.' : 'Valoraciones no disponibles en este momento.')}</p>`;
    const bikeFreshness = bikes.length && (stop.bikesStale || stop.bikesError)
      ? `<p class="bike-freshness" role="status">${t('Mostrando la última información disponible; no se pudo actualizar.')}</p>` : '';
    $('#stop-panel').innerHTML = `${heading}
      <button class="sheet-summary" data-expand><span class="bike-count" style="--level:${availabilityLevel(available)}">${available ?? '–'}</span><span class="sheet-summary-copy">${t('bicis disponibles')}<small>${docks ?? '–'} ${t('anclajes libres')}</small></span></button>
      <div id="arrival-content" class="arrival-content"><div class="bike-status"><div class="is-bikes" style="--level:${availabilityLevel(available)}"><strong>${available ?? '–'}</strong><span>${t('bicis disponibles')}</span></div><div><strong>${docks ?? '–'}</strong><span>${t('parking libre')}${capacity == null ? '' : ` ${t('de')} ${capacity}`}</span></div></div><div class="section-heading"><h3>${t('Estado de las bicis')}</h3>${toneSummary}</div>${bikeFreshness}${bikeList}
      <div class="section-heading"><h3>${t('Estado')}</h3>${refresh}</div><p class="muted">${status}${updated ? ` · ${t('Dato de la fuente: {time}', { time: updated })}` : ''}</p>${state.lastError ? `<div class="notice error" role="alert">${escape(state.lastError)}</div>` : ''}${updateInfo}</div>`;
    $('#workspace').classList.toggle('is-stop-expanded', state.sheetExpanded);
    return;
  }
  const arrivals = state.arrivals.filter(a => !state.activeLine || a.line === state.activeLine);
  const next = arrivals[0];
  const routeStyle = line => `--route-color:${color(line)};--route-ink:${contrastColor(color(line))}`;
  const summary = next
    ? `<button class="sheet-summary" data-expand style="${routeStyle(next.line)}"><span class="route-badge">${escape(next.line)}</span><span class="sheet-summary-copy">${escape(next.destination)}<small>${t('Próxima llegada')}</small></span><span class="eta" data-eta-for="${escape(next.id)}">${etaLabel(next)}</span></button>`
    : `<div class="sheet-summary is-empty">${t(state.busy ? 'Consultando llegadas…' : state.lastError ? 'No se han podido consultar las llegadas' : 'Sin llegadas previstas ahora')}</div>`;
  const inactiveLines = lines.filter(line => state.lineServiceStatus.get(line) === false);
  const inactiveSummary = inactiveLines.length ? `<p class="inactive-lines-summary" role="status">${t('Sin servicio hoy: {lines}', { lines: inactiveLines.map(escape).join(', ') })}</p>` : '';
  const stopLines = lines.length ? `<div class="stop-lines" role="group" aria-label="${t('Líneas que pasan por esta parada')}">${lines.map(chip).join('')}</div>` : '';
  $('#stop-panel').innerHTML = `${heading}${stopLines}${summary}${inactiveSummary}
    <div id="arrival-content" class="arrival-content">
    <div class="section-heading"><h3>${t('Próximas llegadas')}${state.activeLine ? ` · ${escape(state.activeLine)}` : ''}</h3>${refresh}</div>
    ${state.lastError ? `<div class="notice error" role="alert">${escape(state.lastError)}${state.observedAt ? `<br>${t('Se muestra la última consulta; las posiciones caducan a los 90 s.')}` : ''}</div>` : ''}
    <div class="arrival-list">${arrivals.map(arrival => {
      const position = arrivalPosition(arrival);
      return `<article class="arrival-card" style="${routeStyle(arrival.line)}" data-arrival="${escape(arrival.id)}"><div class="arrival-main"><span class="route-badge">${escape(arrival.line)}</span><div class="arrival-destination">${escape(arrival.destination)}${arrival.occupancy ? `<small>${t('Ocupación: {occupancy}', { occupancy: escape(arrival.occupancy) })}</small>` : arrival.platform ? `<small>${t('Andén {platform}', { platform: escape(arrival.platform) })}</small>` : ''}</div><span class="eta">${etaLabel(arrival)}</span></div><div class="arrival-meta"><span data-position-note>${position ? positionNote(arrival) : reason(arrival)}</span><button data-bus="${escape(arrival.id)}" ${position ? '' : 'hidden'}>${t('Ver en mapa')}</button></div></article>`;
    }).join('') || (!state.lastError ? `<div class="empty-state"><p>${t(state.busy ? 'Consultando las próximas llegadas…' : state.activeLine ? 'Sin previsiones para esta línea.' : 'La fuente no publica llegadas para esta parada ahora mismo.')}</p></div>` : '')}</div>
    ${updateInfo}</div>`;
  $('#workspace').classList.toggle('is-stop-expanded', state.sheetExpanded);
}

function setStopPanelExpanded(expanded) {
  state.sheetExpanded = expanded;
  $('#workspace').classList.toggle('is-stop-expanded', expanded);
  $('#stop-panel-toggle')?.setAttribute('aria-expanded', String(expanded));
  const label = $('#stop-panel-toggle > span');
  if (label) label.textContent = t(expanded ? 'Ocultar' : state.provider.kind === 'bike' ? 'Disponibilidad' : 'Llegadas');
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
        if (bounds?.isValid()) { const insets = mapInsets(); map.fitBounds(bounds, { paddingTopLeft: [insets.left, insets.top], paddingBottomRight: [insets.right, insets.bottom], maxZoom: 15, animate: state.animate }); }
        syncBuses(); renderStop();
      }
    } catch (error) { if (state.epoch === epoch) toast(error.message); }
  }
}

function fitBuses() {
  const points = [...state.buses.values()].filter(b => busGroup.hasLayer(b.marker)).map(b => b.marker.getLatLng());
  if (state.selected) points.push(latlng(state.selected.coords));
  if (points.length) { const insets = mapInsets(); map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [insets.left + 20, insets.top + 20], paddingBottomRight: [insets.right + 20, insets.bottom + 20], maxZoom: 16, animate: state.animate }); }
  else map.setView([39.472, -0.370], 13);
}

function searchStops() {
  const query = normalize($('#search').value.trim());
  const results = $('#search-results');
  if (!query) { results.hidden = true; return; }
  const matches = state.stops.filter(stop => stop.id.includes(query) || normalize(stop.name).includes(query))
    .sort((a, b) => (b.id === query) - (a.id === query) || a.name.localeCompare(b.name, getLocale())).slice(0, 12);
  results.innerHTML = matches.map(stop => `<button class="search-result" data-stop="${escape(stop.id)}" style="${providerStyle(state.provider)}"><strong>${state.provider.kind === 'bike' ? glyphSVG('bike') : escape(stop.id)}</strong><span>${escape(stop.name)}</span></button>`).join('') || `<p>${t('No encontramos esa parada.')}</p>`;
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
  if (event.target.closest('#stop-panel-toggle') || event.target.closest('[data-expand]')) { setStopPanelExpanded(!state.sheetExpanded); return; }
  if (event.target.closest('#stop-close')) { clearSelection(); return; }
  const mode = event.target.closest('[data-provider]');
  if (mode) { if (mode.dataset.provider !== state.provider.id) switchProvider(mode.dataset.provider); return; }
  if (!event.target.closest('.topbar')) $('#search-results').hidden = true;
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
function updateLocation(position) {
  latestLocation = [position.coords.longitude, position.coords.latitude];
  const point = latlng(latestLocation);
  if (!locationMarker) locationMarker = L.circleMarker(point, { radius: 8, weight: 3, color: '#fff', fillColor: '#1f6fe5', fillOpacity: 1 }).addTo(map).bindTooltip(t('Tu ubicación'));
  else locationMarker.setLatLng(point);
}
if (navigator.geolocation?.watchPosition) navigator.geolocation.watchPosition(updateLocation, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 15000 });
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation?.getCurrentPosition) return toast('Tu navegador no permite geolocalización.');
  const center = position => {
    if (position) updateLocation(position);
    if (!latestLocation) return;
    const zoom = map.getZoom();
    map.flyTo(visibleCenter(latlng(latestLocation), zoom), zoom, { duration: .8, easeLinearity: .25, animate: state.animate });
  };
  if (latestLocation) center();
  else navigator.geolocation.getCurrentPosition(center, () => toast('No se ha podido obtener tu ubicación. Comprueba los permisos del navegador.'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 });
});
$('#orient').addEventListener('click', () => map.resetNorth({ animate: state.animate }));
map.on('rotate', () => {
  $('#orient').hidden = Math.abs(map.getBearing()) < .5;
  updateStopNumberLabels();
});
$('#all-routes').addEventListener('change', event => { state.allRoutes = event.target.checked; updateLayers(); });
$('#clear-line').addEventListener('click', () => { state.activeLine = null; renderLineList(); renderStop(); updateLayers(); drawBuses(Date.now()); });
function toggleLines(open) { $('#line-panel').hidden = !open; $('#lines-toggle').setAttribute('aria-expanded', String(open)); }
$('#lines-toggle').addEventListener('click', () => toggleLines($('#line-panel').hidden));
$('#lines-close').addEventListener('click', () => toggleLines(false));
$('#settings-open').addEventListener('click', () => $('#settings').showModal());
$('#settings').addEventListener('click', event => { if (event.target === $('#settings')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('#language').addEventListener('change', event => {
  setLanguage(event.target.value);
  applyDocumentTranslations();
  renderLineList();
  if (state.selected) renderStop(); else renderIdle();
  if ($('#search').value.trim()) searchStops();
  if (state.stops.length) networkCount();
  else $('#network-count').textContent = t('Cargando red…');
  $('#provider-description').textContent = providerDescription(state.provider);
  $('#provider-source').textContent = t('Fuente: {name} ↗', { name: state.provider.name });
  connection(latestConnection.label, latestConnection.status, latestConnection.values);
});
$('#speed').addEventListener('input', event => {
  state.speed = Number(event.target.value); $('#speed-value').value = state.speed;
  syncBuses(); renderStop(); saveSettings();
});
function updateAdvancedSettings() {
  $('#advanced-settings-panel').hidden = !state.advancedSettings;
}
$('#advanced-settings').addEventListener('change', event => { state.advancedSettings = event.target.checked; updateAdvancedSettings(); saveSettings(); });
$('#animate').addEventListener('change', event => { state.animate = event.target.checked; saveSettings(); drawBuses(Date.now()); });
$('#transport').addEventListener('change', event => {
  setTransport(event.target.value); configureTransport(event.target.value); saveSettings();
  if (state.stops.length) refreshArrivals(); else initialize();
});
map.on('zoomend', updateLayers);
map.on('moveend', updateStopNumberLabels);
new ResizeObserver(() => map.invalidateSize()).observe($('#map'));
new ResizeObserver(() => {
  const app = $('#workspace');
  app.style.setProperty('--sheet-h', `${$('#sheet').offsetHeight}px`);
  app.style.setProperty('--dock-h', `${$('#modebar').offsetHeight}px`);
}).observe($('#sheet'));

// Drag from the handle or heading while leaving the arrival list available for scrolling.
let dragStart = null;
const sheet = $('#sheet');
sheet.addEventListener('pointerdown', event => {
  if (innerWidth >= 900) return;
  if (event.target.closest('button:not(#sheet-handle), a, input, select')) return;
  if (!event.target.closest('.sheet-handle, .sheet-context, .stop-heading')) return;
  if (!state.selected) return;
  dragStart = { y: event.clientY, lastY: event.clientY, lastAt: performance.now(), height: sheet.offsetHeight, target: event.target, moved: false };
  sheet.classList.add('is-dragging');
  sheet.setPointerCapture?.(event.pointerId);
});
sheet.addEventListener('pointermove', event => {
  if (!dragStart) return;
  const delta = event.clientY - dragStart.y;
  if (Math.abs(delta) > 6) dragStart.moved = true;
  dragStart.velocity = (event.clientY - dragStart.lastY) / Math.max(1, performance.now() - dragStart.lastAt);
  dragStart.lastY = event.clientY; dragStart.lastAt = performance.now();
  sheet.classList.toggle('is-drag-expanding', !state.sheetExpanded && delta < -6);
  const maximum = Number.parseFloat(getComputedStyle(sheet).maxHeight) || innerHeight * .85;
  sheet.style.height = `${Math.max(84, Math.min(maximum, dragStart.height - delta))}px`;
  event.preventDefault();
});
sheet.addEventListener('pointerup', event => {
  if (!dragStart) return;
  const { y, target, moved, velocity } = dragStart;
  const delta = event.clientY - y; dragStart = null;
  sheet.classList.remove('is-dragging', 'is-drag-expanding'); sheet.style.removeProperty('height');
  if (delta < -56 || velocity < -.55) setStopPanelExpanded(true);
  else if (delta > 56 || velocity > .55) { if (state.sheetExpanded) setStopPanelExpanded(false); else clearSelection(); }
  else if (!moved && target.closest('.sheet-handle')) setStopPanelExpanded(!state.sheetExpanded);
});
sheet.addEventListener('pointercancel', () => { dragStart = null; sheet.classList.remove('is-dragging', 'is-drag-expanding'); sheet.style.removeProperty('height'); });
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
  try { localStorage.setItem('enruta-settings', JSON.stringify({ speed: state.speed, advancedSettings: state.advancedSettings, animate: state.animate, transport: $('#transport').value })); } catch { /* Storage may be disabled. */ }
}
try {
  const stored = JSON.parse(localStorage.getItem('enruta-settings') || '{}');
  if (stored.speed >= 6 && stored.speed <= 30) state.speed = Number(stored.speed);
  if (typeof stored.advancedSettings === 'boolean') state.advancedSettings = stored.advancedSettings;
  if (typeof stored.animate === 'boolean') state.animate = stored.animate;
  if (['auto', 'direct', 'proxy'].includes(stored.transport)) $('#transport').value = stored.transport;
} catch { /* Use defaults if storage is unavailable. */ }
$('#speed').value = state.speed; $('#speed-value').value = state.speed; $('#advanced-settings').checked = state.advancedSettings; $('#animate').checked = state.animate; updateAdvancedSettings();
setTransport($('#transport').value, source => { state.source = source; });
configureTransport($('#transport').value, source => { state.source = source; });

setInterval(() => {
  if (!state.selected || document.hidden) return;
  if (state.observedAt) {
    const age = Math.floor((Date.now() - state.observedAt) / 1000);
    if ($('#updated-age')) $('#updated-age').textContent = age > 90 ? t('Datos antiguos · hace {seconds} s', { seconds: age }) : t('Actualizado hace {seconds} s', { seconds: age });
    if (age > 90) connection('Datos antiguos', 'error');
  }
  for (const arrival of state.arrivals) {
    const summary = document.querySelector(`[data-eta-for="${CSS.escape(arrival.id)}"]`);
    if (summary) summary.innerHTML = etaLabel(arrival);
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
    networkCount();
    connection('{name} · red conectada', 'ok', { name: provider.name });
    const requested = new URLSearchParams(location.search).get('stop');
    if (requested) {
      const stop = state.stops.find(s => s.id === requested);
      if (stop) selectStop(stop); else toast('La parada {id} no está en la red publicada.', { id: requested });
    }
    loadAllRoutes();
    showContextStops();
  } catch (error) {
    if (epoch !== state.epoch) return;
    connection('Sin conexión con {name}', 'error', { name: provider.name });
    $('#network-error').hidden = false;
    $('#network-error').textContent = error.message;
    const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = t('Reintentar'); retry.addEventListener('click', initialize);
    $('#network-error').append(retry); $('#network-count').textContent = t('Red no disponible');
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
  state.lineServiceStatus.clear();
  stopGroup.eachLayer(clearStopTooltip); contextGroup.eachLayer(clearStopTooltip);
  stopGroup.clearLayers(); contextGroup.clearLayers(); selectionGroup.clearLayers();
  state.speed = provider.speed; $('#speed').value = state.speed; $('#speed-value').value = state.speed;
  $('#provider-name').textContent = provider.name; $('#provider-description').textContent = providerDescription(provider);
  $('#provider-source').href = provider.source; $('#provider-source').textContent = t('Fuente: {name} ↗', { name: provider.name });
  $('#network-name').textContent = provider.name; $('#sheet').style.cssText = providerStyle(provider);
  for (const tab of document.querySelectorAll('.mode-tab')) tab.setAttribute('aria-pressed', String(tab.dataset.provider === id));
  state.sheetExpanded = false; $('#workspace').classList.remove('is-stop-expanded', 'has-stop');
  renderIdle();
  $('#search').value = ''; $('#search-results').hidden = true; $('#line-list').innerHTML = '';
  $('#route-progress').textContent = ''; $('#network-count').textContent = t('Cargando red…');
  const url = new URL(location.href); url.searchParams.set('provider', id);
  if (stopId) url.searchParams.set('stop', stopId); else url.searchParams.delete('stop');
  history.replaceState(null, '', url);
  try { localStorage.setItem('enruta-provider', id); } catch { /* Storage may be disabled. */ }
  await initialize();
}
$('#modebar').style.setProperty('--modes', providers.size);
$('#modebar').innerHTML = ['metro', 'emt', 'atmv', 'cercanias', 'valenbisi'].map(id => providers.get(id)).map(p => `<button class="mode-tab" data-provider="${p.id}" aria-pressed="false" aria-label="${escape(p.name)}" style="--mode-color:${p.color};--mode-ink:${p.ink || '#fff'}"><span class="mode-icon">${glyphSVG(p.glyph)}</span><span>${escape(p.short || p.name)}</span></button>`).join('');
$('#context-stops').addEventListener('change', event => { state.contextStops = event.target.checked; showContextStops(); });

if ('serviceWorker' in navigator && isSecureContext) addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
let installPrompt = null;
addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#install-app').hidden = false; });
addEventListener('appinstalled', () => { installPrompt = null; $('#install-app').hidden = true; toast('En ruta se ha instalado en tu dispositivo.'); });
$('#install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt(); await installPrompt.userChoice.catch(() => {});
  installPrompt = null; $('#install-app').hidden = true;
});

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
$('#ios-install').hidden = standalone || !/iphone|ipad|ipod/i.test(navigator.userAgent);

const initial = new URLSearchParams(location.search);
let remembered = null;
try { remembered = localStorage.getItem('enruta-provider'); } catch { /* Storage may be disabled. */ }
const initialProvider = [initial.get('provider'), remembered].find(id => providers.has(id)) || 'emt';
switchProvider(initialProvider, initial.get('stop'));
