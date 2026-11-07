import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchProvider } from './services/gateway.mjs';
import { upstreamURL } from './services/emt.mjs';
import { handleApiV1 } from './services/api-v1.mjs';
export { upstreamURL } from './services/emt.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const leafletRoot = resolve(root, 'node_modules/leaflet/dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
        await handleApiV1(req, res, url); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      if (url.pathname.startsWith('/api/providers/')) {
        const [, , , provider, ...parts] = url.pathname.split('/');
        const result = await dispatchProvider(provider, parts.join('/'), url.searchParams);
        res.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : result.text); return;
      }
      if (url.pathname.startsWith('/api/')) {
        try { upstreamURL(url.pathname.slice(5), url.searchParams); }
        catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); return; }
        if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
        const result = await dispatchProvider('emt', url.pathname.slice(5), url.searchParams);
        res.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'no-store' }); res.end(result.text); return;
      }
      const path = decodeURIComponent(url.pathname);
      const vendorPrefix = ['/vendor/leaflet/'].find(prefix => path.startsWith(prefix));
      const vendorRoots = { '/vendor/leaflet/': leafletRoot };
      const base = vendorPrefix ? vendorRoots[vendorPrefix] : publicRoot;
      const relative = vendorPrefix ? path.slice(vendorPrefix.length) : path === '/' ? 'index.html' : path.slice(1);
      const file = resolve(base, relative);
      if (!file.startsWith(base + sep)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': vendorPrefix ? 'public, max-age=86400' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : req.url.startsWith('/api/') ? 502 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: status === 502 ? 'The transport provider could not be reached.' : 'Resource unavailable.' }));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`Transit map: http://${host}:${port}`));
}
