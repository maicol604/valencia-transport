import { chromium } from '@playwright/test';
import { createServer } from '../server.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const server = process.env.BASE_URL ? null : createServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = (process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
const browser = await chromium.launch({ headless: true });
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
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
        watchPosition(success) {
          window.__geoSuccess = success;
          success({ coords: { longitude: -0.38, latitude: 39.47, accuracy: 10 } });
          return 1;
        },
        clearWatch() { window.__geoCleared = true; },
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
        if (url.pathname.includes('/stops/code/')) return route.fulfill({ json: [{ route_short_name: '161A' }] });
        if (url.pathname.includes('/shapes')) return route.fulfill({ json: { features: [], noServiceToday: true } });
        return route.fulfill({ json: { stops: [] } });
      }
      if (url.pathname.startsWith('/api/providers/cercanias/')) {
        const now = Math.floor(Date.now() / 1000);
        if (url.pathname.endsWith('/network')) return route.fulfill({ json: { stops: [{ id: 'B', name: 'València Nord', coords: [-0.383, 39.471], lines: ['C1'] }], lines: [{ id: 'C1', name: 'C1', features: [] }], trips: { trip1: { line: 'C1', destination: 'Nord', stops: ['B'] } } } });
        if (url.pathname.endsWith('/positions')) return route.fulfill({ json: { header: { timestamp: now }, entity: [] } });
        return route.fulfill({ json: { header: { timestamp: now }, entity: [] } });
      }
      return route.continue();
    });
    await page.goto(`${base}/?stop=167`);
    await page.locator('#stop-name').waitFor();
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
      await page.locator('#stop-panel-toggle').click();
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
    if (viewport.width <= 600) await page.locator('#stop-panel-toggle').click();
    await page.locator('.line-chip[data-line="161A"] .line-chip-status').filter({ hasText: 'Sin servicio hoy' }).waitFor();
    assert.equal(await page.locator('.bus-icon').count(), 0, 'vehicles without a valid current route are not drawn off-route');
    await page.screenshot({ path: new URL(`../test-results/ui-vehicle-${viewport.width}.png`, import.meta.url).pathname });
    await page.locator('[data-provider="cercanias"]').click();
    await page.locator('#search').fill('València Nord');
    await page.locator('[data-stop="B"]').click();
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected rail stop has no map tooltip');
    await page.evaluate(() => window.__appMap.setBearing(35));
    await page.locator('#orient').waitFor();
    await page.locator('#orient').click();
    await page.waitForFunction(() => Math.abs(window.__appMap.getBearing()) < .5);
    await page.locator('#locate').click();
    assert.equal(await page.locator('#locate').getAttribute('aria-pressed'), 'true', 'location button enables follow mode');
    await page.evaluate(() => window.__geoSuccess({ coords: { longitude: -0.379, latitude: 39.471, accuracy: 10 } }));
    assert.ok(await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer instanceof window.L.CircleMarker && layer.options.radius === 8);
      return marker && Math.abs(marker.getLatLng().lng + .379) < .001;
    }), 'follow mode updates the location marker');
    await page.locator('#locate').click();
    assert.equal(await page.locator('#locate').getAttribute('aria-pressed'), 'false', 'location button disables follow mode');
    assert.deepEqual(errors, [], 'no browser exceptions');
    await page.close();
  }
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}