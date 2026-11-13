import { chromium } from '@playwright/test';
import { createServer } from '../server.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const server = process.env.BASE_URL ? null : createServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = (process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
const browser = await chromium.launch({ headless: true });
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const allViewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
const requestedWidth = Number(process.env.UI_VIEWPORT);
const viewports = requestedWidth ? allViewports.filter(viewport => viewport.width === requestedWidth) : allViewports;
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce', hasTouch: true, isMobile: viewport.width <= 600, deviceScaleFactor: viewport.width <= 600 ? 3 : 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let leaflet;
      Object.defineProperty(window, 'L', { configurable: true, get: () => leaflet, set(value) {
        leaflet = value;
        const initialize = value.Map.prototype.initialize;
        value.Map.prototype.initialize = function(...args) { const result = initialize.apply(this, args); window.__appMap = this; return result; };
      } });
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
        getCurrentPosition(success) {
          window.__geoRequests = (window.__geoRequests || 0) + 1;
          success({ coords: { longitude: -0.38, latitude: 39.47, accuracy: 10 } });
        },
        watchPosition(success) {
          window.__geoWatchRequests = (window.__geoWatchRequests || 0) + 1;
          window.__geoWatchSuccess = success;
          success({ coords: { longitude: -0.381, latitude: 39.468, accuracy: 10 } });
          return 1;
        },
        clearWatch() {},
      } });
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'geoportal.emtvalencia.es') {
        if (url.pathname.endsWith('/wfs')) {
          const layer = url.searchParams.get('typeName');
          const features = layer === 'emt:Paradas' ? [
            { geometry: { type: 'Point', coordinates: [-0.38, 39.47] }, properties: { ID_PARADAS: 167, DENOMINACION: 'Centre' } },
            { geometry: { type: 'Point', coordinates: [-0.378, 39.47] }, properties: { ID_PARADAS: 168, DENOMINACION: 'Mercat' } },
          ] : layer === 'emt:Lineas' ? [{ properties: { ID_PUBLICO: '31', ID_SUBLINEA: 31, NOMBRE_LINEA: 'Port' } }] : [];
          return route.fulfill({ json: { features, totalFeatures: features.length } });
        }
        return route.fulfill({ contentType: 'application/xml', body: '<estimacion><solo_parada><bus><linea>31</linea><destino>Port</destino><minutos>3 min.</minutos></bus></solo_parada></estimacion>' });
      }
      if (url.hostname === 'www.metrovalencia.es' || url.pathname.startsWith('/api/providers/metro/')) {
        if (url.pathname.includes('consulta-mapas') || url.pathname.endsWith('/network')) return route.fulfill({ contentType: 'text/html', body: 'var datosMapaGeneral = { estaciones: [{"lng":-0.38,"lat":39.47},{"lng":-0.378,"lat":39.47}], infoEstaciones: [{"id":26,"nombre":"Facultats","lineas":[{"id":3,"color":"ed1222"},{"id":5,"color":"00aa88"}]},{"id":27,"nombre":"Alameda","lineas":[{"id":3,"color":"ed1222"}]}], lineas: {"3":[{"lng":-0.38,"lat":39.47},{"lng":-0.378,"lat":39.47}]}, coloresLineas: {"3":"ed1222"} };' });
        return route.fulfill({ json: { html: '<div class="item--proximos"><span class="linea-3"></span><span class="nombre-estacion">Rafelbunyol</span><span class="estacion__espera">2 min</span></div>' } });
      }
      if (url.hostname === 'api.softoursistemas.com') {
        if (url.pathname.endsWith('/old/stops')) return route.fulfill({ json: [{ stop_code: 77, stop_name: 'Centre', stop_lon: -0.38, stop_lat: 39.47 }] });
        if (url.pathname.endsWith('/old/routes')) return route.fulfill({ json: [{ route_short_name: '161A', route_long_name: 'Quart', route_id: 106, concesion: 'CV106' }] });
        if (url.pathname.includes('/estimacion/ocupacion/')) return route.fulfill({ json: [{ line: '161A', route: 'Quart', estimations: [{ minutesToArrival: 3, almex: { longitude: -0.381, latitude: 39.471 } }] }] });
        if (url.pathname.includes('/stops/code/')) return route.fulfill({ json: [{ route_short_name: '161A' }, { route_short_name: 'BUS-12345678901234567890' }] });
        if (url.pathname.includes('/shapes')) return route.fulfill({ json: { features: [], noServiceToday: true } });
        return route.fulfill({ json: { stops: [] } });
      }
      if (url.pathname.startsWith('/api/providers/cercanias/')) {
        const now = Math.floor(Date.now() / 1000);
        if (url.pathname.endsWith('/network')) return route.fulfill({ json: { stops: [{ id: 'B', name: 'València Nord', coords: [-0.383, 39.471], lines: ['C1'] }], lines: [{ id: 'C1', name: 'C1', features: [] }], trips: { trip1: { line: 'C1', destination: 'Nord', stops: ['B'] } } } });
        if (url.pathname.endsWith('/positions')) return route.fulfill({ json: { header: { timestamp: now }, entity: [] } });
        return route.fulfill({ json: { header: { timestamp: now }, entity: [] } });
      }
      if (url.pathname.startsWith('/api/providers/valenbisi/')) return route.fulfill({ json: { stations: [] } });
      if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1sAAAAASUVORK5CYII=', 'base64') });
      return route.continue();
    });
    await page.goto(`${base}/?stop=167`);
    await page.locator('#stop-name').waitFor();
    await page.locator('.arrival-card').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(100);
    await page.waitForFunction(() => window.__appMap.getZoom() >= 17);
    assert.ok(await page.evaluate(() => Math.abs(window.__appMap.getZoom() - 17) < .1), 'selected stop stays at close zoom after arrivals load instead of fitting all vehicles');
    assert.ok(await page.evaluate(() => {
      const map = window.__appMap, rotatePane = map.getPane('rotatePane'), mapPane = map.getPane('mapPane');
      return ['routes', 'stops'].every(name => map.getPane(name).parentElement === rotatePane)
        && ['railStops', 'vehicles', 'selection'].every(name => map.getPane(name).parentElement === mapPane);
    }), 'vector and canvas layers rotate while DOM markers use Leaflet rotation-aware positioning');
    assert.equal(await page.waitForFunction(() => window.__geoWatchRequests === 1).then(() => true), true, 'location tracking starts by default');
    assert.ok(await page.evaluate(() => Object.values(window.__appMap._layers).some(layer => layer instanceof window.L.CircleMarker && layer.options.radius === 8 && Math.abs(layer.getLatLng().lng + .381) < .001)), 'default location tracking displays the current position');
    assert.deepEqual(await page.locator('.mode-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.provider)), ['metro', 'emt', 'atmv', 'cercanias', 'valenbisi'], 'transport tabs follow the requested order');
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected stop details stay in the drawer');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page fits viewport');
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.47, -0.378], 17, { animate: false }); });
    assert.equal(await page.locator('.stop-number-tooltip').filter({ hasText: 'Mercat' }).count(), 0, 'dense bus labels stay hidden while a stop is selected');
    await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer._stopLabel?.stop.id === '168').fire('click'));
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Mercat');
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.47, -0.38], 17, { animate: false }); });
    await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer._stopLabel?.stop.id === '167').fire('click'));
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Centre');
    if (viewport.width <= 600) {
      const handle = await page.locator('#sheet-handle').boundingBox();
      const initialSheet = await page.locator('#sheet').evaluate(element => ({ height: element.getBoundingClientRect().height, bottom: element.getBoundingClientRect().bottom }));
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 80, { steps: 4 });
      const draggedSheet = await page.locator('#sheet').evaluate(element => ({ height: element.getBoundingClientRect().height, bottom: element.getBoundingClientRect().bottom }));
      assert.ok(draggedSheet.height > initialSheet.height + 30 && Math.abs(draggedSheet.bottom - initialSheet.bottom) < 1, 'drawer grows from its fixed bottom edge while dragging');
      assert.equal(await page.locator('#arrival-content').isVisible(), true, 'drawer content is visible during expansion');
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('#stop-panel-toggle')?.getAttribute('aria-expanded') === 'true');
      assert.equal(await page.locator('#stop-panel-toggle').getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('.map-shell').evaluate(element => element.getBoundingClientRect().height >= 205));
      await page.locator('#stop-panel-toggle').click();
    }
    await page.locator('[data-provider="metro"]').click();
    await page.locator('#search').fill('Facultats');
    await page.locator('[data-stop="26"]').click();
    await page.locator('.stop-lines .line-chip').first().waitFor();
    assert.ok(await page.locator('.stop-lines .line-chip').count() >= 1, 'stop lines are shown in the drawer');
    assert.ok(await page.locator('.stop-lines .line-chip').evaluateAll(elements => elements.every(element => getComputedStyle(element).color === 'rgb(255, 255, 255)')), 'line numbers use white text');
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected station has no map tooltip');
    const survivesHover = await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Facultats');
      marker.fire('mouseover'); marker.fire('mouseout');
      return marker.isTooltipOpen();
    });
    assert.equal(survivesHover, false, 'selected station label stays hidden after pointer events');
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected stop information is not repeated on the map');
    const markerOpacity = await page.evaluate(() => {
      const markers = Object.values(window.__appMap._layers).filter(layer => layer.options?.title?.startsWith('Metrovalencia ·'));
      return Object.fromEntries(markers.map(marker => [marker.options.title, marker.options.opacity]));
    });
    assert.equal(markerOpacity['Metrovalencia · Facultats'], 1, 'selected station remains prominent');
    assert.equal(markerOpacity['Metrovalencia · Alameda'], .38, 'other stations retain reduced opacity');
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setZoom(18, { animate: false }); });
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected tooltip stays hidden at close zoom');
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setZoom(17, { animate: false }); });
    await page.evaluate(() => document.querySelector('#stop-close').click());
    if (viewport.width > 600) {
      await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.47, -0.379], 17, { animate: false }); });
      assert.equal(await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Alameda').isTooltipOpen()), true, 'nearby station label appears at a readable zoom');
      await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setZoom(13, { animate: false }); });
      assert.equal(await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Alameda').isTooltipOpen()), false, 'nearby labels are hidden when zoomed out');
    }
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.47, -0.378], 17, { animate: false }); });
    const alamedaLabel = page.locator('.stop-map-label').filter({ hasText: 'Alameda' });
    await alamedaLabel.waitFor();
    const alamedaBox = await alamedaLabel.boundingBox();
    if (viewport.width <= 600) await page.touchscreen.tap(alamedaBox.x + alamedaBox.width * .75, alamedaBox.y + alamedaBox.height / 2);
    else await page.mouse.click(alamedaBox.x + alamedaBox.width * .75, alamedaBox.y + alamedaBox.height / 2);
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Alameda');
    await page.evaluate(() => document.querySelector('#stop-close').click());
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.47, -0.38], 17, { animate: false }); });
    const facultatsMarker = page.locator('.provider-stop-metro[title="Metrovalencia · Facultats"]');
    const markerBox = await facultatsMarker.boundingBox();
    assert.ok(markerBox.width >= 40 && markerBox.height >= 40, 'station marker has a larger touch target');
    if (viewport.width <= 600) await page.touchscreen.tap(markerBox.x + 7, markerBox.y + 20);
    else await page.mouse.click(markerBox.x + 7, markerBox.y + 20);
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Facultats');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'metro fits viewport');
    await page.screenshot({ path: new URL(`../test-results/ui-${viewport.width}.png`, import.meta.url).pathname });
    await page.evaluate(() => document.querySelector('#stop-close').click());
    await page.locator('#lines-toggle').click();
    await page.locator('#context-stops').check();
    await page.locator('#lines-close').click();
    await page.locator('.provider-stop-cercanias').waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.471, -0.383], 17, { animate: false }); });
    const contextLabel = page.locator('.stop-map-label').filter({ hasText: 'València Nord' });
    await contextLabel.waitFor();
    const contextBox = await contextLabel.boundingBox();
    if (viewport.width <= 600) await page.touchscreen.tap(contextBox.x + contextBox.width * .75, contextBox.y + contextBox.height / 2);
    else await page.mouse.click(contextBox.x + contextBox.width * .75, contextBox.y + contextBox.height / 2);
    await page.waitForFunction(() => document.querySelector('[data-provider="cercanias"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#stop-name')?.textContent === 'València Nord');
    await page.locator('[data-provider="atmv"]').click();
    await page.locator('#search').fill('77');
    await page.locator('[data-stop="77"]').click();
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected bus stop has no map tooltip');
    await page.locator('.inactive-lines-summary').filter({ hasText: 'Sin servicio hoy' }).waitFor();
    const longLineChip = page.locator('.stop-lines .line-chip[data-line="BUS-12345678901234567890"]');
    await longLineChip.waitFor();
    assert.ok(await longLineChip.evaluate(element => {
      const chip = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth + 1 && chip.right <= parent.right + 1;
    }), 'long bus line codes wrap within their chips');
    if (viewport.width <= 600) await page.locator('#stop-panel-toggle').click();
    await page.locator('.line-chip[data-line="161A"] .line-chip-status').filter({ hasText: 'Sin servicio hoy' }).waitFor();
    assert.equal(await page.locator('.bus-icon').count(), 0, 'vehicles without a valid current route are not drawn off-route');
    await page.screenshot({ path: new URL(`../test-results/ui-vehicle-${viewport.width}.png`, import.meta.url).pathname });
    await page.locator('[data-provider="cercanias"]').click();
    await page.locator('#search').fill('València Nord');
    await page.locator('[data-stop="B"]').click();
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected rail stop has no map tooltip');
    await page.evaluate(() => window.__appMap.setBearing(35));
    const stationOffset = await page.evaluate(() => {
      const map = window.__appMap;
      const marker = Object.values(map._layers).find(layer => layer._stopLabel?.provider.id === 'cercanias' && layer._stopLabel.stop.id === 'B');
      const point = map.latLngToContainerPoint(marker.getLatLng()), rect = marker.getElement().getBoundingClientRect(), mapRect = map.getContainer().getBoundingClientRect();
      return Math.hypot(point.x - (rect.left - mapRect.left + rect.width / 2), point.y - (rect.top - mapRect.top + rect.height / 2));
    });
    assert.ok(stationOffset < 2, `station marker remains aligned with its coordinates while the map rotates (${stationOffset.toFixed(2)} px)`);
    await page.locator('#orient').waitFor();
    await page.evaluate(() => window.__geoWatchSuccess({ coords: { longitude: -.38, latitude: 39.47, accuracy: 10 } }));
    await page.locator('#locate').click();
    assert.equal(await page.locator('#locate').getAttribute('aria-pressed'), null, 'location button does not toggle tracking');
    assert.equal(await page.evaluate(() => window.__geoRequests || 0), 0, 'centering uses the already-tracked location');
    assert.ok(await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer instanceof window.L.CircleMarker && layer.options.radius === 8);
      return marker && Math.abs(marker.getLatLng().lng + .38) < .001 && Math.abs(marker.getLatLng().lat - 39.47) < .001;
    }), 'location marker follows updates in the background');
    assert.ok(await page.evaluate(() => {
      const map = window.__appMap, point = map.latLngToContainerPoint([39.47, -.38]);
      const sheet = document.querySelector('#sheet').getBoundingClientRect(), top = document.querySelector('.topbar').getBoundingClientRect(), size = map.getSize();
      const insets = innerWidth >= 900 ? { left: sheet.right + 16, top: 24, right: 80, bottom: 24 } : { left: 16, top: top.bottom + 12, right: 64, bottom: innerHeight - sheet.top + 16 };
      const center = [(insets.left + size.x - insets.right) / 2, (insets.top + size.y - insets.bottom) / 2];
      return Math.hypot(point.x - center[0], point.y - center[1]) < 2;
    }), 'location action centers the current position in the visible map area without resetting map rotation');
    await page.locator('#orient').click();
    await page.waitForFunction(() => Math.abs(window.__appMap.getBearing()) < .5);
    await page.locator('#settings-open').click();
    await page.locator('#language').selectOption('en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'language selection updates the document language');
    assert.equal(await page.locator('#settings-title').textContent(), 'Settings', 'settings labels switch to English');
    assert.equal(await page.locator('#search').getAttribute('placeholder'), 'Search by stop name or number', 'search text switches to English');
    assert.equal(await page.locator('#all-routes + span').textContent(), 'Show the full network', 'map controls switch to English');
    assert.match(await page.locator('.stop-code').textContent(), /^Stop B · /, 'selected stop details switch to English');
    await page.locator('#language').selectOption('es');
    assert.equal(await page.locator('#settings-title').textContent(), 'Ajustes', 'Spanish can be restored without reloading');
    await page.locator('#settings').locator('form button').click();
    assert.deepEqual(errors, [], 'no browser exceptions');
    await page.close();
  }
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}