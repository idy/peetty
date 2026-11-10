// Production uses the same browser entries as development and the CDN release.
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSiteFigures } from './site-figures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = args.indexOf('--catalog-base');
let catalogBase;
if (option !== -1) {
  catalogBase = args[option + 1];
  if (!catalogBase || catalogBase.startsWith('--')) throw new Error('--catalog-base requires an absolute catalog URL');
  args.splice(option, 2);
}
if (args.length > 1) throw new Error('Usage: site.mjs [output-directory] [--catalog-base URL]');
const site = args[0] ? resolve(args[0]) : join(root, 'site');
await mkdir(site, { recursive: true });
await rm(join(site, 'sdk'), { recursive: true, force: true });
await cp(join(root, 'cdn'), join(site, 'sdk'), { recursive: true });
await writeSiteFigures(join(root, 'figures'), join(site, 'figures'), catalogBase);
await cp(join(root, 'schema'), join(site, 'schema'), { recursive: true });
console.log(`Website assets assembled: ${site}`);
