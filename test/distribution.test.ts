import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { PRESETS, FIGURE_CATALOG } from '../src/presets.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const { global, browserGlobal } = await import(new URL('../scripts/build-options.mjs', import.meta.url).href);

describe('browser distribution compatibility', () => {
  for (const browser of [false, true]) {
    it(`${browser ? 'CDN' : 'npm'} classic entry ${browser ? 'uses a sibling catalog' : 'retains the public fallback without local figures'}`, async (t) => {
      const bundle = await build({ ...(browser ? browserGlobal : global), absWorkingDir: root, write: false, minify: true });
      const window = new Window({ url: 'https://embedding.example/page/' });
      t.after(async () => { await window.happyDOM.abort(); window.close(); });
      const script = window.document.createElement('script');
      script.src = 'https://static.example/assets/peetty.global.js';
      Object.defineProperty(window.document, 'currentScript', { value: script });
      const requests: string[] = [];
      const exports = runInNewContext(`${bundle.outputFiles![0]!.text}; Peetty;`, {
        document: window.document, window, URL,
        fetch: async (url: URL) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ ...PRESETS.miru, id: 'shiori' }));
        },
      });
      const expected = browser ? 'https://static.example/figures/' : FIGURE_CATALOG;
      assert.equal(exports.FIGURE_CATALOG, expected);
      assert.equal((await exports.resolveFigure('shiori')).id, 'shiori');
      assert.deepEqual(requests, [`${expected}shiori.json`]);
      assert.equal(window.document.querySelector('peetty-companion'), null);
    });
  }

  it('ships browser entries in production while preserving the legacy website catalog', async (t) => {
    const site = await mkdtemp(join(tmpdir(), 'peetty-site-'));
    t.after(() => rm(site, { recursive: true, force: true }));
    execFileSync(process.execPath, [join(root, 'scripts/site.mjs'), site], { cwd: root });
    for (const entry of ['index.js', 'peetty.global.js', 'chat/panel.js', 'THIRD_PARTY_NOTICES.txt']) {
      assert.equal(await readFile(join(site, 'sdk', entry), 'utf8'), await readFile(join(root, 'cdn', entry), 'utf8'));
    }
    const portable = JSON.parse(await readFile(join(root, 'figures/index.json'), 'utf8'));
    const legacy = JSON.parse(await readFile(join(site, 'figures/index.json'), 'utf8'));
    // SDK 0.3.0 filters out relative URLs. Its deployed endpoint must keep absolute entries.
    const oldClientEntries = legacy.figures.filter((entry: { url: string }) => /^https?:\/\//.test(entry.url));
    assert.equal(oldClientEntries.length, portable.figures.length);
    for (const entry of oldClientEntries) {
      assert.equal(entry.url, `https://peetty.idy.dev/figures/${entry.id}.json`);
      assert.equal(typeof JSON.parse(await readFile(join(site, 'figures', `${entry.id}.json`), 'utf8')), 'object');
    }
    assert.ok(portable.figures.every((entry: { url: string }) => !entry.url.includes('://')));
    const notices = await readFile(join(site, 'sdk/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.match(notices, /openai.*7\.19\.0/);
    assert.match(notices, /Apache License/);
    assert.match(notices, /Version 2\.0, January 2004/);
  });
});
