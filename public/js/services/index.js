import { emt } from './emt.js';
import { atmv } from './atmv.js';
import { metro } from './metro.js';
import { cercanias } from './cercanias.js';
import { valenbisi } from './valenbisi.js';
export const providers = new Map([metro, emt, atmv, cercanias, valenbisi].map(provider => [provider.id, provider]));
