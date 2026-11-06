import http from 'node:http';
import { handleProvider } from './index.mjs';

const provider = process.argv[2];
const defaults = { emt: 3101, atmv: 3102, metro: 3103, cercanias: 3104 };
if (!defaults[provider]) throw new Error('Usage: node services/serve.mjs emt|atmv|metro|cercanias');
const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || defaults[provider]);
http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { res.end(JSON.stringify({ provider, status: 'ok' })); return; }
    const result = await handleProvider(provider, url.pathname.slice(1), url.searchParams);
    res.setHeader('Content-Type', result.type); res.end(result.text);
  } catch (error) { res.writeHead(error.status || 502); res.end(JSON.stringify({ provider, error: 'Source unavailable' })); }
}).listen(port, host, () => console.log(`${provider} service: http://${host}:${port}`));
