// Keep the animated companion small: chat is an ESM entry loaded on demand.
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const browserDefine = {
  __PEETTY_BROWSER_CATALOG__: JSON.stringify(`https://cdn.jsdelivr.net/gh/idy/peetty@v${version}/figures/`),
};
export const shared = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'info', legalComments: 'none' };
export const modules = {
  ...shared,
  entryPoints: { index: 'src/index.ts', 'chat/panel': 'src/chat/panel.ts' },
  format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]',
};
// Browser entries resolve the figure catalog from their own script URL.
export const browserModules = {
  ...modules, entryPoints: { ...modules.entryPoints, index: 'src/browser.ts' }, define: browserDefine,
};
export const global = {
  ...shared, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'Peetty',
  plugins: [{
    name: 'lazy-chat',
    setup(build) {
      // Keep the ESM chat entry out of the IIFE; load.ts captures the absolute script URL.
      build.onResolve({ filter: /(?:^|\/)panel\.ts$/ }, () => ({ path: './chat/panel.js', external: true }));
    },
  }],
};
export const browserGlobal = {
  ...global, entryPoints: ['src/browser-global.ts'], define: browserDefine,
};
