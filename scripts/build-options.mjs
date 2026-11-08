// Keep the animated companion small: chat is an ESM entry loaded on demand.
export const shared = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'info', legalComments: 'none' };
export const modules = {
  ...shared,
  entryPoints: { index: 'src/index.ts', 'chat/panel': 'src/chat/panel.ts' },
  format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]',
};
export const global = {
  ...shared, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'Peetty',
  plugins: [{
    name: 'lazy-chat',
    setup(build) {
      // Native import() resolves relative to the external SDK script, including CDN embeds.
      build.onResolve({ filter: /chat\/panel\.ts$/ }, () => ({ path: './chat/panel.js', external: true }));
    },
  }],
};
