import { handleAtmv } from './atmv.mjs';
import { handleMetro } from './metro.mjs';
import { handleCercanias } from './cercanias.mjs';
import { handleEmt } from './emt.mjs';

const handlers = new Map([['emt', handleEmt], ['atmv', handleAtmv], ['metro', handleMetro], ['cercanias', handleCercanias]]);
export async function handleProvider(provider, path, params) {
  const handler = handlers.get(provider);
  if (!handler) throw Object.assign(new Error('Provider not allowed'), { status: 400 });
  return handler(path, params);
}
