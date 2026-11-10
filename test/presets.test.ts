import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIGURE_LOAD_TIMEOUT, PRESETS, resolveFigure, listFigures, FIGURE_CATALOG } from '../src/presets.ts';
import { setFigureScriptSource } from '../src/catalog.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

describe('figure resolution', () => {
  for (const stage of ['fetch', 'body'] as const) {
    it(`aborts a stalled ${stage} at the deadline and allows a fresh retry`, async (t) => {
      t.after(stubGlobals({ document: { baseURI: 'https://example.test/page/' } }));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const headers = deferred<Response>();
      const body = deferred<unknown>();
      let signal: AbortSignal | null | undefined;
      let bodyReads = 0;
      let retry = false;
      t.mock.method(globalThis, 'fetch', async (_url: URL, options?: RequestInit) => {
        signal = options?.signal;
        if (retry) return new Response(JSON.stringify(PRESETS.elsie));
        if (stage === 'fetch') return headers.promise;
        return { ok: true, json() { bodyReads++; return body.promise; } } as Response;
      });
      const loading = resolveFigure('/stalled.json');
      const rejected = assert.rejects(loading, { name: 'TimeoutError' });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.ok(signal && !signal.aborted);
      t.mock.timers.tick(FIGURE_LOAD_TIMEOUT);
      await rejected;
      assert.equal(signal.aborted, true, 'the deadline cancels the underlying request and body');
      headers.resolve({ ok: true, async json() { bodyReads++; return PRESETS.miru; } } as Response);
      body.resolve(PRESETS.miru);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(bodyReads, stage === 'fetch' ? 0 : 1, 'late headers cannot start abandoned body work');
      retry = true;
      assert.equal((await resolveFigure('/stalled.json')).id, 'elsie');
    });
  }

  it('aborts body loading when its initiating selection is superseded', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'https://example.test/' } }));
    const body = deferred<unknown>();
    let requestSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: URL, options?: RequestInit) => {
      requestSignal = options?.signal;
      return { ok: true, json: () => body.promise } as Response;
    });
    const owner = new AbortController();
    const loading = resolveFigure('/old-selection.json', undefined, owner.signal);
    const rejected = assert.rejects(loading, { name: 'AbortError' });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    owner.abort(); await rejected;
    assert.equal(requestSignal?.aborted, true);
    body.resolve(PRESETS.miru);
  });

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
        { id: 'empty', url: '' },
        { id: 'whitespace', url: String.fromCharCode(32, 9, 10) },
        { id: 'fragment', url: '#shiori' },
        { id: 'spaced-fragment', url: '  #miru' },
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
