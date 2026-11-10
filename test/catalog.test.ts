import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { validateFigure } from '../src/figure/validate.ts';
import { PRESET_IDS, FIGURE_CATALOG } from '../src/presets.ts';

const dir = new URL('../figures/', import.meta.url);

describe('figure catalog', async () => {
  const index = JSON.parse(await readFile(new URL('index.json', dir), 'utf8'));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();

  it('lists every figure file exactly once', () => {
    assert.equal(index.format, 'peetty.catalog');
    assert.deepEqual(index.figures.map((e: { id: string }) => `${e.id}.json`).sort(), files);
  });

  it('preserves the historical package catalog origin', () => {
    assert.equal(FIGURE_CATALOG, 'https://peetty.idy.dev/figures/');
  });

  it('marks the bundled presets and keeps URLs portable across CDN hosts and tags', () => {
    for (const entry of index.figures) {
      assert.equal(entry.bundled, (PRESET_IDS as string[]).includes(entry.id));
      assert.equal(entry.url, `${entry.id}.json`);
      assert.ok(entry.author && entry.license, `${entry.id} has author and license`);
    }
  });

  for (const file of files) {
    it(`${file} is a valid figure named after its id`, async () => {
      const figure = validateFigure(JSON.parse(await readFile(new URL(file, dir), 'utf8')));
      assert.equal(`${figure.id}.json`, file);
    });
  }
});
