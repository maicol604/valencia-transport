import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = (process.env.BASE_URL || 'http://127.0.0.1:8083').replace(/\/$/, '');
const key = process.env.TRANSIT_API_KEY;
if (!key) throw new Error('Set TRANSIT_API_KEY to a configured API key.');

const unauthorized = await fetch(`${base}/api/v1/operators`);
assert.equal(unauthorized.status, 401, 'API requires a key');
const operators = await fetch(`${base}/api/v1/operators`, { headers: { 'X-API-Key': key } });
assert.equal(operators.status, 200, 'API accepts the configured key');
assert.equal((await operators.json()).data.length, 4, 'API lists the four operators');
const contract = await fetch(`${base}/api/v1/openapi.yaml`, { headers: { 'X-API-Key': key } });
assert.equal(contract.status, 200, 'OpenAPI contract is available');
const forbiddenOrigin = await fetch(`${base}/api/v1/operators`, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'GET' } });
assert.equal(forbiddenOrigin.status, 403, 'unconfigured origins are rejected');

await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('enruta-settings', JSON.stringify({ transport: 'proxy' })));
    const network = page.waitForResponse(response => response.url().includes('/api/providers/metro/network') && response.status() === 200, { timeout: 60000 });
    await page.goto(`${base}/?provider=metro&stop=26`);
    await network;
    await page.locator('#stop-name').waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.stop-map-label:visible').count(), 0, 'selected station details stay in the drawer');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page fits the viewport');
    assert.ok(await page.locator('.map-shell').evaluate(element => element.getBoundingClientRect().height >= 150), 'map remains usable');
    await page.locator('#search').fill('Alameda');
    await page.locator('.search-result').first().tap();
    await page.waitForFunction(() => document.querySelector('#stop-name')?.textContent.includes('Alameda'));
    await page.waitForFunction(() => document.querySelector('#refresh') && !document.querySelector('#refresh').disabled, null, { timeout: 45000 });
    assert.equal(await page.locator('#stop-panel .error').count(), 0, 'live arrivals complete without an error');
    if (viewport.width <= 600) {
      await page.locator('#stop-panel-toggle').tap();
      assert.equal(await page.locator('#stop-panel-toggle').getAttribute('aria-expanded'), 'true', 'arrivals sheet expands');
      assert.ok(await page.locator('.map-shell').evaluate(element => element.getBoundingClientRect().height >= 205), 'expanded sheet leaves room for the map');
      await page.locator('#stop-panel-toggle').tap();
    }
    await page.screenshot({ path: new URL(`../test-results/deployment-${viewport.width}x${viewport.height}.png`, import.meta.url).pathname });
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log(`Mobile ${viewport.width}x${viewport.height}: Metro proxy, search and map passed`);
    await page.close();
  }
} finally {
  await browser.close();
}