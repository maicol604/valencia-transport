import { emt } from './emt.js';
import { atmv } from './atmv.js';
import { metro } from './metro.js';
import { cercanias } from './cercanias.js';
export const providers = new Map([emt, atmv, metro, cercanias].map(provider => [provider.id, provider]));
