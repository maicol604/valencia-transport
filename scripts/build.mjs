import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
await promisify(execFile)(fileURLToPath(new URL('node_modules/.bin/esbuild', root)), ['scripts/map-entry.js', '--bundle', '--format=iife', '--target=es2022', '--outfile=public/vendor/map-runtime.js'], { cwd: fileURLToPath(root) });
await mkdir(new URL('dist/vendor/leaflet/', root), { recursive: true });
await cp(new URL('public/', root), new URL('dist/', root), { recursive: true });
await cp(new URL('node_modules/leaflet/dist/', root), new URL('dist/vendor/leaflet/', root), { recursive: true });
console.log(`Static frontend generated at ${fileURLToPath(new URL('dist/', root))}`);
