// Local preview: serves the repository root and rebuilds on each request.
// dev/figures.html uses the ESM build; site/ uses the script-tag build,
// which is written to site/sdk/ (ignored by Git) on every change.
import { context } from 'esbuild';

const port = Number(process.env.PORT ?? 4180);
const shared = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'info' };
const esm = await context({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js' });
const global = await context({ ...shared, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'Peetty', outfile: 'site/sdk/peetty.global.js' });
await global.watch();
await esm.serve({ servedir: '.', port, host: '127.0.0.1' });
console.log(`Figure sheet: http://127.0.0.1:${port}/dev/figures.html`);
console.log(`Website:      http://127.0.0.1:${port}/site/`);
