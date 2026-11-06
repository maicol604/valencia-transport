import { upstreamText } from './shared.mjs';

export function atmvURL(path, params) {
  const valid = /^(?:old\/(?:stops|routes)|estimacion\/ocupacion\/\d{1,8}|stops\/code\/\d{1,8}\/routes|routes\/\d{1,8}\/(?:shapes\/?|stops))$/.test(path);
  if (!valid) throw Object.assign(new Error('Met Go resource not allowed'), { status: 400 });
  const url = new URL(`https://api.softoursistemas.com/metrobus/${path}`);
  if (path.startsWith('routes/')) {
    if (!/^[01]$/.test(params.get('direction') || '') || !/^CV\d{3}$/.test(params.get('concesion') || '')) throw Object.assign(new Error('Invalid direction or concession'), { status: 400 });
    url.search = new URLSearchParams({ direction: params.get('direction'), concesion: params.get('concesion') });
  }
  return url;
}
export async function handleAtmv(path, params) {
  return { text: await upstreamText(atmvURL(path, params)), type: 'application/json; charset=utf-8' };
}
