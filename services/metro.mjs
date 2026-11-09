import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { memoize, validStop } from './shared.mjs';

const USER_AGENT = process.env.METRO_USER_AGENT || 'ValenciaLiveTransitMap/1.0';
const arrivalCache = new Map();
let blockedUntil = 0;
let backoffMs = 30000;

// Metrovalencia omits its issuing intermediate in TLS. Supply that public certificate
// as chain material and continue verifying hostname, signature and the trusted root.
const getAgent = memoize(86400000, async () => {
  const pem = await readFile(new URL('./certs/sectigo-ov-r36.pem', import.meta.url), 'utf8');
  const cert = new X509Certificate(pem);
  if (Date.parse(cert.validTo) < Date.now()) throw new Error('Intermediate certificate has expired');
  return new https.Agent({ ca: [...tls.rootCertificates, pem], keepAlive: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
});
// Metrovalencia silently stalls roughly one request in three while healthy ones answer in <1 s,
// so a hedged duplicate is launched when the first attempt is slow; the first success wins.
function metroRequest(path, body, { attempts = 3, timeout = 8000, hedgeAfter = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let started = 0, failed = 0, settled = false, hedge;
    const launch = () => {
      started++;
      metroAttempt(path, body, timeout).then(text => {
        if (settled) return;
        settled = true; clearTimeout(hedge); resolve(text);
      }, error => {
        if (settled) return;
        failed++;
        const retryable = !error.status || error.status >= 500;
        if (!retryable || failed >= attempts) { settled = true; clearTimeout(hedge); reject(error); }
        else if (started - failed === 0 && started < attempts) { clearTimeout(hedge); launch(); }
      });
      if (started < attempts) hedge = setTimeout(launch, hedgeAfter);
    };
    launch();
  });
}
async function metroAttempt(path, body, timeout) {
  if (Date.now() < blockedUntil) throw Object.assign(new Error('Metrovalencia rate limit is active'), { status: 429 });
  const agent = await getAgent();
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(path, 'https://www.metrovalencia.es'), {
      agent, method: body ? 'POST' : 'GET', timeout,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: body ? 'application/json' : 'text/html,application/xhtml+xml',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, response => {
      if (response.statusCode === 429) {
        const retryAfter = Number(response.headers['retry-after']);
        blockedUntil = Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10 * 60000);
        response.resume(); reject(Object.assign(new Error('Metrovalencia: HTTP 429'), { status: 429 })); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(Object.assign(new Error(`Metrovalencia: HTTP ${response.statusCode}`), { status: response.statusCode })); return; }
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; if (text.length > 5000000) request.destroy(new Error('Response is too large')); });
      response.on('end', () => { backoffMs = 30000; resolve(text); }); response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Metrovalencia request timed out')));
    request.on('error', reject); request.end(body);
  });
}
const getMap = memoize(3600000, () => metroRequest('/es/consulta-mapas/', undefined, { attempts: 3, timeout: 15000, hedgeAfter: 5000 }));
export async function handleMetro(path, params) {
  if (path === 'network') return { text: await getMap(), type: 'text/html; charset=utf-8' };
  if (path !== 'arrivals') throw Object.assign(new Error('Metrovalencia resource not allowed'), { status: 400 });
  const id = validStop(params.get('stop'));
  const cached = arrivalCache.get(id);
  if (cached && cached.until > Date.now()) return cached.promise;
  const body = new URLSearchParams({ action: 'formularios_ajax', data: `action=info-estacion&id=${id}&lang=es` }).toString();
  const promise = metroRequest('/wp-admin/admin-ajax.php', body)
    .then(text => ({ text, type: 'application/json; charset=utf-8' }))
    .catch(error => { arrivalCache.delete(id); throw error; });
  arrivalCache.set(id, { until: Date.now() + 25000, promise });
  return promise;
}
