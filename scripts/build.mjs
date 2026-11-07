import { build } from 'esbuild';

const shared = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'info', legalComments: 'none' };

await Promise.all([
  build({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js' }),
  build({ ...shared, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'Peetty', outfile: 'dist/peetty.global.js', minify: true }),
]);
