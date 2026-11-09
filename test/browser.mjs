import { chromium } from '@playwright/test';
import { createServer } from '../server.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
await mkdir(new URL('test-results/', root), { recursive: true });
const server = process.env.BASE_URL ? null : createServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = (process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('Browser console:', message.text()); });
  await page.addInitScript(() => {
    let leaflet;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get() { return leaflet; },
      set(value) {
        leaflet = value;
        const initialize = leaflet.Map.prototype.initialize;
        leaflet.Map.prototype.initialize = function(...args) {
          const result = initialize.apply(this, args);
          window.__appMap = this;
          return result;
        };
      },
    });
  });
  await page.goto(`${base}/?stop=167`);
  await page.locator('#stop-name').waitFor({ timeout: 45000 });
  await page.locator('.stop-number-tooltip').waitFor();
  assert.equal(await page.locator('.stop-number-tooltip .stop-label-code').first().innerText(), '167', 'selected EMT stop shows its number on the map');
  await page.locator('text=OpenStreetMap contributors').waitFor({ timeout: 30000 });
  await page.locator('.leaflet-tile-loaded').first().waitFor({ timeout: 30000 });
  assert.equal((await page.locator('body').innerText()).includes('API key required'), false, 'basemap does not require an API key');
  await page.waitForFunction(() => document.querySelectorAll('.arrival-card').length > 0 || document.querySelector('#stop-panel .error'), null, { timeout: 45000 });
  await page.waitForFunction(() => /Recorridos: (\d+)\/\1(?:\D|$)/.test(document.querySelector('#route-progress').textContent), null, { timeout: 120000 });
  const paneOrder = await page.evaluate(() => ['routes', 'stops', 'vehicles', 'selection'].map(name => Number(getComputedStyle(document.querySelector(`.leaflet-${name}-pane`)).zIndex)));
  assert.ok(paneOrder[0] < paneOrder[1] && paneOrder[1] < paneOrder[2] && paneOrder[2] < paneOrder[3], 'buses render over stops and beneath the selected stop');
  assert.ok(await page.evaluate(() => Object.values(window.__appMap._layers).some(layer => layer.options?.className?.split(' ').includes('stop-marker') && layer._clickTolerance() >= 8)), 'stop markers have a forgiving click target');
  const badge = page.locator('.vehicle-badge').first();
  if (await badge.count()) assert.equal(await badge.evaluate(element => element.querySelector('.vehicle-code').scrollWidth <= element.clientWidth), true, 'vehicle code fits its marker');
  await page.waitForFunction(() => [...document.querySelectorAll('.vehicle-direction')].some(element => !element.hidden && Number.isFinite(Number(element.dataset.heading))), null, { timeout: 15000 });
  console.log('Live status:', await page.locator('#connection').innerText());
  console.log('Network:', await page.locator('#network-count').innerText());
  console.log('Routes:', await page.locator('#route-progress').innerText());
  console.log('Arrivals:', await page.locator('.arrival-card').count());
  console.log('Mapped buses:', await page.locator('.bus-icon').count());
  console.log('Position notes:', await page.locator('[data-position-note]').allTextContents());
  const unsupported = page.locator('.arrival-card').filter({ hasText: 'Fuera del tramo estimable' });
  for (let index = 0; index < await unsupported.count(); index++) {
    assert.equal(await unsupported.nth(index).locator('[data-bus]').isHidden(), true, 'an unestimable arrival does not offer a fabricated map position');
  }
  const marker = page.locator('.bus-icon').first();
  if (await marker.count()) {
    for (let zoom = 0; zoom < 2; zoom++) {
      await page.locator('.leaflet-control-zoom-in').click();
      await page.waitForTimeout(300);
    }
    const movingMarker = page.locator('.bus-icon[data-position-kind="estimated"]').first();
    await movingMarker.waitFor();
    const before = await movingMarker.getAttribute('style');
    await page.waitForTimeout(2000);
    assert.notEqual(await movingMarker.getAttribute('style'), before, 'estimated bus marker moves');
    for (let zoom = 0; zoom < 2; zoom++) {
      await page.locator('.leaflet-control-zoom-out').click();
      await page.waitForTimeout(300);
    }
  }
  await page.screenshot({ path: new URL('test-results/desktop.png', root).pathname });
  const stopTarget = await page.evaluate(() => {
    const map = window.__appMap;
    const markers = Object.values(map._layers).filter(layer => layer.options?.className?.split(' ').includes('stop-marker') && layer.getLatLng());
    const points = markers.map(marker => ({ marker, point: map.latLngToContainerPoint(marker.getLatLng()) }));
    const selectedId = document.querySelector('.stop-code').textContent.match(/PARADA\s+(\S+)/)?.[1];
    for (const { marker, point } of points) {
      const id = marker._stopLabel.stop.id;
      if (id === selectedId || point.x < 30 || point.x > map.getSize().x - 30 || point.y < 30 || point.y > map.getSize().y - 30) continue;
      const nearest = Math.min(...points.filter(other => other.marker !== marker).map(other => point.distanceTo(other.point)));
      if (nearest > 32) return { x: point.x, y: point.y, id };
    }
    return null;
  });
  assert.ok(stopTarget, 'a separated stop marker is available for hit-target testing');
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + stopTarget.x + 10, mapBox.y + stopTarget.y);
  await page.waitForFunction(id => document.querySelector('.stop-code')?.textContent.startsWith(`PARADA ${id}`), stopTarget.id);
  for (let zoom = 0; zoom < 3; zoom++) {
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => document.querySelectorAll('.stop-number-tooltip').length > 1, null, { timeout: 5000 });
  for (let zoom = 0; zoom < 3; zoom++) {
    await page.locator('.leaflet-control-zoom-out').click();
    await page.waitForTimeout(300);
  }
  await page.locator('#search').fill('154');
  await page.locator('[data-stop="154"]').click();
  await page.waitForFunction(() => document.querySelector('.stop-code')?.textContent.startsWith('PARADA 154'));
  assert.equal(await page.locator('.arrival-meta').first().evaluate(element => getComputedStyle(element).borderTopStyle), 'none', 'arrival details have no divider crossing the row');
  await page.locator('#settings-open').click();
  await page.locator('#speed').fill('18');
  assert.equal(await page.locator('#speed-value').innerText(), '18');
  await page.keyboard.press('Escape');
  await page.locator('#lines-toggle').click();
  await page.locator('#line-list [data-line="31"]').click();
  assert.equal(await page.locator('#line-list [data-line="31"]').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('.leaflet-routes-pane canvas').count() > 0, 'route renderer stays in its dedicated pane');
  await page.locator('#lines-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
  assert.equal(await page.locator('#lines-toggle .icon-layers').isVisible(), true, 'mobile layers control keeps its icon visible');
  await page.locator('#stop-panel-toggle').click();
  assert.equal(await page.locator('#stop-panel-toggle').getAttribute('aria-expanded'), 'true', 'mobile arrivals sheet expands');
  assert.ok(await page.locator('.map-shell').evaluate(element => element.getBoundingClientRect().height >= 205), 'expanded arrivals sheet leaves useful map height');
  await page.locator('#stop-panel-toggle').click();
  assert.equal(await page.locator('#stop-panel-toggle').getAttribute('aria-expanded'), 'false', 'mobile arrivals sheet collapses');
  await page.locator('#stop-panel-toggle').click();
  await page.screenshot({ path: new URL('test-results/mobile.png', root).pathname });
  const parsing = await page.evaluate(async () => {
    const { parseArrivals } = await import('./js/arrivals.js');
    const xml = '<estimacion><solo_parada><bus><linea>31</linea><destino><![CDATA[Port & Platja]]></destino><minutos>3 min.</minutos></bus><bus><linea>C2</linea><destino>Circular</destino><minutos>23:00</minutos></bus></solo_parada></estimacion>';
    const parsed = parseArrivals(xml, Date.parse('2026-09-14T13:00:00Z'));
    let failure = false, malformed = false;
    try { parseArrivals('<estimacion><solo_parada/><error><![CDATA[<b>Temporalmente no disponible</b>]]></error></estimacion>'); } catch { failure = true; }
    try { parseArrivals('<html>Bad gateway'); } catch { malformed = true; }
    return { length: parsed.length, destination: parsed[0].destination, programmed: parsed[1].programmed, failure, malformed };
  });
  assert.deepEqual(parsing, { length: 2, destination: 'Port & Platja', programmed: true, failure: true, malformed: true });

  // Simulate a browser-only block: automatic mode must use our fixed-host proxy.
  await page.route('https://geoportal.emtvalencia.es/**/MapUtilsPetitions.php*', route => route.abort('blockedbyclient'));
  await page.locator('#refresh').waitFor();
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const proxied = page.waitForResponse(response => response.url().includes('/api/sae?') && response.status() === 200, { timeout: 30000 });
  await page.locator('#refresh').click();
  await proxied;
  console.log('Automatic proxy fallback passed.');
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);

  // A service failure must stay visible, never be disguised as zero arrivals.
  await page.route('**/api/sae?*', route => route.fulfill({ status: 200, contentType: 'application/xml', body: '<estimacion><solo_parada/><error>Temporalmente no disponible</error></estimacion>' }));
  await page.locator('#refresh').click();
  await page.locator('#stop-panel .error').waitFor();
  assert.match(await page.locator('#stop-panel .error').innerText(), /Temporalmente no disponible/);
  console.log('XML parser and upstream-failure UI passed.');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('Browser interactions and responsive layout passed.');
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
