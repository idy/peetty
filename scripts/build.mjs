import { build } from 'esbuild';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { modules, global } from './build-options.mjs';
import { bundledLicenses } from './bundled-licenses.mjs';

await rm('dist', { recursive: true, force: true });
const builds = await Promise.all([
  build({ ...modules, outdir: 'dist', minify: true, metafile: true, legalComments: 'inline' }),
  build({ ...global, outfile: 'dist/peetty.global.js', minify: true, metafile: true, legalComments: 'inline' }),
]);
await writeFile('dist/THIRD_PARTY_NOTICES.txt', await bundledLicenses(
  builds.map(result => result.metafile), fileURLToPath(new URL('../', import.meta.url)),
));
