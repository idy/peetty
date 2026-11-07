import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESETS, resolveFigure } from '../src/presets.ts';
import { stubGlobals } from './helpers/stubs.ts';

describe('figure resolution', () => {
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
