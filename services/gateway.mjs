import { handleProvider } from './index.mjs';

// These URLs are deployment configuration, never supplied by an HTTP caller.
export async function dispatchProvider(provider, path, params) {
  if (!['emt', 'atmv', 'metro', 'cercanias'].includes(provider)) throw Object.assign(new Error('Provider not allowed'), { status: 400 });
  const remote = process.env[`${provider.toUpperCase()}_SERVICE_URL`];
  if (!remote) return handleProvider(provider, path, params);
  const base = new URL(remote.endsWith('/') ? remote : `${remote}/`);
  const url = new URL(path, base); url.search = params.toString();
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw Object.assign(new Error('Path not allowed'), { status: 400 });
  const response = await fetch(url, { signal: AbortSignal.timeout(provider === 'cercanias' ? 120000 : 30000), redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('Service unavailable'), { status: response.status === 400 ? 400 : 502 });
  return { text: await response.text(), type: response.headers.get('content-type') || 'application/json' };
}
