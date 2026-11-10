// Production uses the same browser entries as development and the CDN release.
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSiteFigures } from './site-figures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = process.argv[2] ? resolve(process.argv[2]) : join(root, 'site');
await mkdir(site, { recursive: true });
await rm(join(site, 'sdk'), { recursive: true, force: true });
await cp(join(root, 'cdn'), join(site, 'sdk'), { recursive: true });
await writeSiteFigures(join(root, 'figures'), join(site, 'figures'));
await cp(join(root, 'schema'), join(site, 'schema'), { recursive: true });
console.log(`Website assets assembled: ${site}`);
