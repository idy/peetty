import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { modules, global } from './build-options.mjs';

await rm('dist', { recursive: true, force: true });
await Promise.all([
  build({ ...modules, outdir: 'dist', minify: true }),
  build({ ...global, outfile: 'dist/peetty.global.js', minify: true }),
]);
