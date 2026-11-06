import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, upstreamURL } from '../server.mjs';

test('proxy accepts only fixed EMT services and validated parameters', () => {
  assert.throws(() => upstreamURL('sae', new URLSearchParams({ parada: '167;DROP' })));
  assert.throws(() => upstreamURL('wfs', new URLSearchParams({ typeName: 'emt:private' })));
  assert.throws(() => upstreamURL('http://example.com', new URLSearchParams()));
  const url = upstreamURL('sae', new URLSearchParams({ parada: '167', url: 'http://localhost' }));
  assert.equal(url.hostname, 'geoportal.emtvalencia.es');
  assert.equal(url.searchParams.get('parada'), '167');
  assert.ok(url.searchParams.get('nocache'));
});

test('serves frontend, rejects proxy misuse, never exposes source or dotfiles', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/sae?parada=bad`)).status, 400);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
