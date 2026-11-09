import { chromium } from '@playwright/test';
import { createServer } from '../server.mjs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) console.log('API error',r.status(),r.url()); });
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
  for (const [provider, stop] of [['atmv', '487'], ['metro', '19'], ['cercanias', '65000'], ['emt', '167']]) {
    await page.goto(`${base}/?provider=${provider}&stop=${stop}`);
    await page.waitForFunction(() => document.querySelector('#stop-name') || !document.querySelector('#network-error').hidden, null, { timeout: 120000 });
    const error = await page.locator('#network-error').isVisible();
    if (error) console.log(provider, 'Network error:', await page.locator('#network-error').innerText());
    assert.equal(error, false, `${provider} network loaded`);
    await page.waitForFunction(() => document.querySelector('#refresh') && !document.querySelector('#refresh').disabled, null, { timeout: 120000 });
    await page.waitForTimeout(5000);
    console.log(provider, await page.locator('#network-count').innerText(), 'arrivals:', await page.locator('.arrival-card').count(), 'vehicles:', await page.locator('.bus-icon').count());
    const vehicleBadge = page.locator('.vehicle-badge').first();
    if (await vehicleBadge.count()) {
      assert.equal(await vehicleBadge.evaluate(element => element.querySelector('.vehicle-code').scrollWidth <= element.clientWidth), true, `${provider} vehicle code fits its marker`);
      await page.locator('.vehicle-direction:not([hidden])[data-heading]').first().waitFor({ timeout: 15000 });
    }
    if (provider === 'metro') {
      const alignment = await page.evaluate(() => {
        const map = window.__appMap;
        const selected = Object.values(map._layers).find(layer => layer.options?.pane === 'selection' && layer.getLatLng());
        const target = map.latLngToContainerPoint(selected.getLatLng());
        return [...document.querySelectorAll('.bus-icon')].flatMap(element => {
          const marker = Object.values(map._layers).find(layer => layer.getElement?.() === element);
          const angle = Number(element.querySelector('.vehicle-direction')?.dataset.heading);
          if (!marker || !Number.isFinite(angle)) return [];
          const point = map.latLngToContainerPoint(marker.getLatLng());
          return [(target.x - point.x) * Math.cos(angle * Math.PI / 180) + (target.y - point.y) * Math.sin(angle * Math.PI / 180)];
        });
      });
      assert.ok(alignment.length > 0 && alignment.every(dot => dot > 0), `Metrovalencia arrows point toward Paiporta: ${alignment.join(', ')}`);
    }
    console.log('notes', (await page.locator('[data-position-note]').allTextContents()).slice(0, 12));
    if (await page.locator('#stop-panel .error').count()) console.log('arrival error:', await page.locator('#stop-panel .error').innerText());
    await page.screenshot({ path: new URL(`../test-results/${provider}.png`, import.meta.url).pathname });
  }
  // Exercise async isolation with in-flight requests from multiple providers.
  await page.locator('[data-provider="atmv"]').click();
  await page.locator('[data-provider="metro"]').click();
  await page.locator('[data-provider="emt"]').click();
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('EMT') && document.querySelector('#network-count').textContent.includes('paradas'), null, { timeout: 60000 });
  assert.equal(await page.locator('[data-provider="emt"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#lines-toggle').click();
  await page.locator('#context-stops').check();
  await page.waitForFunction(() => Object.values(window.__appMap._layers).some(layer => layer.options?.className?.includes('provider-stop-atmv')), null, { timeout: 120000 });
  await page.locator('.provider-stop-metro').first().waitFor({ timeout: 120000 });
  await page.locator('.provider-stop-cercanias').first().waitFor({ timeout: 120000 });
  await page.locator('#lines-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL('../test-results/multimodal-mobile.png', import.meta.url).pathname });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const metroParsing = await page.evaluate(async () => {
    const { parseMetroArrivals } = await import('./js/services/metro.js');
    return parseMetroArrivals({ html: '<div class="item--proximos"><span class="linea linea-3"></span><div class="nombre-estacion">Rafelbunyol</div><div class="nombre-estacion estacion__espera"><span>1 h</span> <span>23 min</span></div></div>' }, 100000)[0];
  });
  assert.equal(metroParsing.seconds, 4980);
  assert.equal(metroParsing.line, '3');
  assert.deepEqual(errors, []);
  console.log('All provider browser flows passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
