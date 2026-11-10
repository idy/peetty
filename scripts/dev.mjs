// Watch the ESM SDK, its lazy chat chunks, and the script-tag build.
import { context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { modules, browserModules, global as script } from './build-options.mjs';

const port = Number(process.env.PORT ?? 4180);
await mkdir('site/figures', { recursive: true });
await cp('figures', 'site/figures', { recursive: true, filter: (path) => !path.includes('/src') });
const esm = await context({ ...modules, outdir: 'dist' });
const browser = await context({ ...browserModules, outdir: 'site/sdk' });
const global = await context({ ...script, outfile: 'site/sdk/peetty.global.js' });
await Promise.all([esm.watch(), browser.watch(), global.watch()]);
await esm.serve({ servedir: '.', port, host: '127.0.0.1' });
console.log(`Figure sheet: http://127.0.0.1:${port}/dev/figures.html`);
console.log(`Website:      http://127.0.0.1:${port}/site/`);
