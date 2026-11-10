import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESETS, resolveFigure, listFigures, FIGURE_CATALOG } from '../src/presets.ts';
import { setFigureScriptSource } from '../src/catalog.ts';
import { stubGlobals } from './helpers/stubs.ts';

describe('figure resolution', () => {
  for (const source of [
    'https://cdn.jsdelivr.net/gh/idy/peetty@v0.3.1/cdn/index.js',
    'https://mirror.example/releases/v42/cdn/peetty.global.js?cache=1',
  ]) {
    it(`loads extra figures from the browser entry's host and version: ${source}`, async (t) => {
      t.after(stubGlobals({ document: { baseURI: 'https://embedding.example/nested/page' } }));
      const original = FIGURE_CATALOG;
      t.after(() => setFigureScriptSource(new URL('../cdn/index.js', original).href));
      const requests: string[] = [];
      t.mock.method(globalThis, 'fetch', async (url: URL) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ ...PRESETS.miru, id: 'shiori' }));
      });
      setFigureScriptSource(source);
      assert.equal((await resolveFigure('shiori')).id, 'shiori');
      assert.deepEqual(requests, [new URL('../figures/shiori.json', source).href]);
    });
  }

  it('resolves portable catalog URLs against the fetched index and rejects non-HTTP entries', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'https://embedding.example/page' } }));
    t.mock.method(globalThis, 'fetch', async () => {
      const response = new Response(JSON.stringify({ format: 'peetty.catalog', figures: [
        { id: 'shiori', url: 'shiori.json' },
        { id: 'miru', url: 'https://another.example/figures/miru.json' },
        { id: 'bad', url: 'javascript:alert(1)' },
        { id: 'missing' },
      ] }));
      Object.defineProperty(response, 'url', { value: 'https://cdn.example/pinned/v9/figures/index.json' });
      return response;
    });
    assert.deepEqual((await listFigures('https://redirect.example/figures/')).map(entry => entry.url), [
      'https://cdn.example/pinned/v9/figures/shiori.json',
      'https://another.example/figures/miru.json',
    ]);
  });
  it('uses bundled presets without making a request', async (t) => {
    t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Bundled presets must not fetch');
    });
    assert.equal(await resolveFigure('miru'), PRESETS.miru);
  });

  it('loads a catalog ID that also names an inherited object property', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'https://example.test/page/' } }));
    const figure = structuredClone(PRESETS.miru);
    figure.id = 'constructor';
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: URL) => {
      requests.push(String(url));
      return new Response(JSON.stringify(figure), { status: 200 });
    });

    const loaded = await resolveFigure('constructor', 'https://example.test/figures/');
    assert.equal(loaded.id, 'constructor');
    assert.deepEqual(requests, ['https://example.test/figures/constructor.json']);
  });
});
