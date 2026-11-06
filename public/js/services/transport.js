let mode = 'auto';
let listener = () => {};
const fallbackUntil = new Map();
export function configureTransport(value, callback) {
  mode = value;
  if (callback) listener = callback;
  fallbackUntil.clear();
}
export async function transportRequest(provider, direct, endpoint, { signal, method = 'GET', body } = {}) {
  const fetchOne = async (url, proxy) => {
    const response = await fetch(url, {
      method: proxy ? 'GET' : method, body: proxy ? undefined : body,
      credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(provider === 'cercanias' && endpoint === 'network' ? 120000 : 25000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`${provider}: HTTP ${response.status}`);
    listener(proxy ? 'proxy' : 'direct');
    return response.text();
  };
  const proxy = () => fetchOne(new URL(`./api/providers/${provider}/${endpoint}`, document.baseURI), true);
  if (mode === 'proxy' || (!direct && mode !== 'direct') || (mode === 'auto' && (fallbackUntil.get(provider) || 0) > Date.now())) return proxy();
  if (!direct) throw new Error(`${provider}: this source requires the intermediary service. Use automatic connection and npm start.`);
  try { return await fetchOne(direct, false); }
  catch (error) {
    if (signal?.aborted || mode === 'direct') throw error;
    const result = await proxy(); fallbackUntil.set(provider, Date.now() + 300000); return result;
  }
}

export const jsonRequest = async (...args) => JSON.parse(await transportRequest(...args));

export function createCache() {
  const entries = new Map();
  return (key, ttl, load) => {
    for (const [k, v] of entries) if (v.until < Date.now()) entries.delete(k);
    if (!entries.has(key)) {
      const promise = load().catch(error => { entries.delete(key); throw error; });
      entries.set(key, { until: Date.now() + ttl, promise });
    }
    return entries.get(key).promise;
  };
}
