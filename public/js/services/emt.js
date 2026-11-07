import { getNetwork, getRoute, getArrivals } from './emt-api.js';
import { buildRoutes, approachForStop } from '../geo.js';

export const emt = {
  id: 'emt', name: 'EMT', color: '#176a9b', symbol: 'E', kind: 'bus', interval: 20000, speed: 12, preloadRoutes: true,
  description: 'Live SAE arrivals with positions estimated from time to arrival.',
  source: 'https://geoportal.emtvalencia.es/visor?lang=es',
  async getNetwork() {
    const data = await getNetwork();
    const codes = [...new Set(data.lines.map(l => String(l.ID_PUBLICO)))];
    return { stops: data.stops, lines: codes.map(code => ({
      id: code, name: data.lines.find(l => String(l.ID_PUBLICO) === code).NOMBRE_LINEA,
      variants: data.lines.filter(l => String(l.ID_PUBLICO) === code),
    })) };
  },
  getModels: item => Promise.all(item.variants.map(async info => buildRoutes(await getRoute(info.ID_SUBLINEA), info))),
  getArrivals: (stop, signal) => getArrivals(stop.id, signal),
  getApproach: (models, stop) => approachForStop(models, stop),
};
