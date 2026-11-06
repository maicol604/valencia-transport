export function memoize(ttl, load) {
  let value, until = 0, pending;
  return async () => {
    if (value && Date.now() < until) return value;
    if (!pending) pending = load().then(result => { value = result; until = Date.now() + ttl; return result; }).finally(() => { pending = null; });
    return pending;
  };
}
export async function upstreamText(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error', ...options });
  if (!response.ok) throw new Error(`Transport source: HTTP ${response.status}`);
  return response.text();
}
export function validStop(value) {
  if (!/^\d{1,8}$/.test(value || '')) throw Object.assign(new Error('Invalid stop'), { status: 400 });
  return value;
}
export const jsonResult = value => ({ text: JSON.stringify(value), type: 'application/json; charset=utf-8' });
