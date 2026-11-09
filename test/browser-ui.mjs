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
        if (url.pathname.includes('/shapes')) return route.fulfill({ json: { features: [] } });
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
    await page.locator('.stop-number-tooltip.is-selected').waitFor();
    assert.equal(await page.locator('.stop-number-tooltip.is-selected .stop-label-code').innerText(), '167');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page fits viewport');
    await page.evaluate(() => window.__appMap.setView([39.47, -0.378], 17, { animate: false }));
    assert.equal(await page.locator('.stop-number-tooltip').filter({ hasText: 'Mercat' }).count(), 0, 'dense bus labels stay hidden while a stop is selected');
    const mercatPoint = await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer._stopLabel?.stop.id === '168');
      const point = window.__appMap.latLngToContainerPoint(marker.getLatLng());
      const bounds = document.querySelector('#map').getBoundingClientRect();
      return { x: bounds.x + point.x, y: bounds.y + point.y };
    });
    if (viewport.width <= 600) await page.touchscreen.tap(mercatPoint.x, mercatPoint.y); else await page.mouse.click(mercatPoint.x, mercatPoint.y);
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Mercat');
    await page.evaluate(() => window.__appMap.setView([39.47, -0.38], 17, { animate: false }));
    const emtPoint = await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer._stopLabel?.stop.id === '167');
      const point = window.__appMap.latLngToContainerPoint(marker.getLatLng());
      const bounds = document.querySelector('#map').getBoundingClientRect();
      return { x: bounds.x + point.x - 10, y: bounds.y + point.y };
    });
    if (viewport.width <= 600) await page.touchscreen.tap(emtPoint.x, emtPoint.y);
    else await page.mouse.click(emtPoint.x, emtPoint.y);
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
    await page.locator('.stop-map-label.is-selected').waitFor();
    assert.match(await page.locator('.stop-map-label.is-selected').innerText(), /Facultats/i);
    assert.ok(await page.locator('.stop-map-label.is-selected .stop-label-line').count() >= 1);
    await page.waitForFunction(() => {
      const badges = document.querySelectorAll('.stop-map-label.is-selected .stop-label-line');
      return badges.length >= 2 && getComputedStyle(badges[badges.length - 1]).color === 'rgb(0, 0, 0)';
    });
    assert.ok(await page.locator('.stop-map-label.is-selected').evaluate(element => element.getBoundingClientRect().height <= 50), 'station name is not squeezed into a vertical column');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.stop-map-label.is-selected')).opacity), '1');
    const survivesHover = await page.evaluate(() => {
      const marker = Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Facultats');
      marker.fire('mouseover'); marker.fire('mouseout');
      return marker.isTooltipOpen();
    });
    assert.equal(survivesHover, true, 'selected station label stays visible after pointer leaves');
    await page.locator('.stop-map-label.is-selected').hover();
    await page.mouse.move(1, 1);
    assert.equal(await page.locator('.stop-map-label.is-selected').isVisible(), true, 'selected label survives real pointer movement');
    if (viewport.width > 600) {
      await page.evaluate(() => window.__appMap.setView([39.47, -0.379], 17, { animate: false }));
      assert.equal(await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Alameda').isTooltipOpen()), true, 'nearby station label appears at a readable zoom');
      await page.evaluate(() => window.__appMap.setZoom(13, { animate: false }));
      assert.equal(await page.evaluate(() => Object.values(window.__appMap._layers).find(layer => layer.options?.title === 'Metrovalencia · Alameda').isTooltipOpen()), false, 'nearby labels are hidden when zoomed out');
      assert.equal(await page.locator('.stop-map-label.is-selected').isVisible(), true, 'selected label remains visible when zoomed out');
    }
    const markerOpacity = await page.evaluate(() => {
      const markers = Object.values(window.__appMap._layers).filter(layer => layer.options?.title?.startsWith('Metrovalencia ·'));
      return Object.fromEntries(markers.map(marker => [marker.options.title, marker.options.opacity]));
    });
    assert.equal(markerOpacity['Metrovalencia · Facultats'], 1, 'selected station remains prominent');
    assert.equal(markerOpacity['Metrovalencia · Alameda'], .9, 'other stations retain reduced opacity');
    await page.evaluate(() => window.__appMap.setView([39.47, -0.378], 17, { animate: false }));
    const alamedaLabel = page.locator('.stop-map-label').filter({ hasText: 'Alameda' });
    await alamedaLabel.waitFor();
    if (viewport.width <= 600) await alamedaLabel.tap(); else await alamedaLabel.click();
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Alameda');
    await page.evaluate(() => window.__appMap.setView([39.47, -0.38], 17, { animate: false }));
    const facultatsMarker = page.locator('.provider-stop-metro[title="Metrovalencia · Facultats"]');
    const markerBox = await facultatsMarker.boundingBox();
    assert.ok(markerBox.width >= 40 && markerBox.height >= 40, 'station marker has a larger touch target');
    if (viewport.width <= 600) await page.touchscreen.tap(markerBox.x + 7, markerBox.y + 20);
    else await page.mouse.click(markerBox.x + 7, markerBox.y + 20);
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent === 'Facultats');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'metro fits viewport');
    await page.screenshot({ path: new URL(`../test-results/ui-${viewport.width}.png`, import.meta.url).pathname });
    await page.locator('#lines-toggle').click();
    await page.locator('#context-stops').check();
    await page.locator('#lines-close').click();
    await page.locator('.provider-stop-cercanias').waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__appMap.stop(); window.__appMap.setView([39.471, -0.383], 17, { animate: false }); });
    const contextLabel = page.locator('.stop-map-label').filter({ hasText: 'València Nord' });
    await contextLabel.waitFor();
    if (viewport.width <= 600) await contextLabel.tap(); else await contextLabel.click();
    await page.waitForFunction(() => document.querySelector('[data-provider="cercanias"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#stop-name')?.textContent === 'València Nord');
    await page.locator('[data-provider="atmv"]').click();
    await page.locator('#search').fill('77');
    await page.locator('[data-stop="77"]').click();
    await page.locator('.stop-map-label.is-selected').waitFor();
    assert.equal(await page.locator('.stop-map-label.is-selected .stop-label-code').innerText(), '77');
    await page.locator('.vehicle-badge').waitFor();
    assert.equal(await page.locator('.vehicle-mode svg').isVisible(), true, 'vehicle marker has a recognizable vehicle pictogram');
    assert.equal(await page.locator('.vehicle-code').innerText(), '161A');
    assert.ok(await page.locator('.vehicle-code').evaluate(element => element.scrollWidth <= element.clientWidth), 'vehicle line fits its marker');
    await page.screenshot({ path: new URL(`../test-results/ui-vehicle-${viewport.width}.png`, import.meta.url).pathname });
    await page.locator('[data-provider="cercanias"]').click();
    await page.locator('#search').fill('València Nord');
    await page.locator('[data-stop="B"]').click();
    await page.locator('.stop-map-label.is-selected').waitFor();
    assert.match(await page.locator('.stop-map-label.is-selected').innerText(), /València Nord/i);
    assert.deepEqual(errors, [], 'no browser exceptions');
    await page.close();
  }
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}