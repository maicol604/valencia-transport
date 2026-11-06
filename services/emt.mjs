const cache = new Map(), pending = new Map();
export function upstreamURL(kind, params) {
  if (kind === 'sae') {
    if (!/^\d{1,6}$/.test(params.get('parada') || '')) throw new Error('Invalid stop');
    const url = new URL('https://geoportal.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php');
    url.search = new URLSearchParams({ sec: 'getSAE', parada: params.get('parada'), adaptados: 'false', idioma: 'es', nocache: crypto.randomUUID() });
    return url;
  }
  if (kind !== 'wfs') throw new Error('Invalid service');
  const layer = params.get('typeName');
  if (!['emt:Paradas', 'emt:Lineas', 'emt:Tramos_Vigentes'].includes(layer)) throw new Error('Layer not allowed');
  const url = new URL('https://geoportal.emtvalencia.es/geoserver/emt/wfs');
  url.search = new URLSearchParams({ service: 'wfs', version: '1.1.0', request: 'GetFeature', outputFormat: 'json', srsName: 'EPSG:4326', typeName: layer });
  if (layer === 'emt:Tramos_Vigentes') {
    const view = params.get('viewparams') || '';
    if (!/^p_linea:\d{1,4};p_fecha:'\d{4}-\d{2}-\d{2}';p_hora:'\d{4}'$/.test(view)) throw new Error('Invalid route parameters');
    url.searchParams.set('viewparams', view);
  }
  return url;
}

export async function handleEmt(kind, params) {
  let url;
  try { url = upstreamURL(kind, params); } catch (error) { error.status = 400; throw error; }
  const key = kind === 'sae' ? `sae:${params.get('parada')}` : url.href;
  const old = cache.get(key);
  if (old && old.until > Date.now()) return old.value;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(14000), redirect: 'error',
      headers: { Referer: 'https://geoportal.emtvalencia.es/visor?lang=es', 'User-Agent': 'Mozilla/5.0 EMT-Map/1.0', Accept: '*/*' } });
    if (!response.ok) throw new Error(`EMT returned HTTP ${response.status}`);
    const text = await response.text();
    const value = { text, type: kind === 'sae' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' };
    if (kind === 'wfs' && text.trim().startsWith('{')) {
      for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: Date.now() + 300000 });
    }
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, promise); return promise;
}
