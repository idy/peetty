import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJSONChunks, parseJSONChunksAsync } from '../src/chat/bounded-json.ts';
import { BrowserProfileStore } from '../src/chat/profiles.ts';
import { LIMITS, validateFigure } from '../src/figure/validate.ts';
import { PRESETS } from '../src/presets.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const profile = (figure: unknown) => ({ id: 'fixture', name: 'Fixture', figure, personality: '', useMemories: true, autoRemember: false, entries: [], memories: [], createdAt: 1, updatedAt: 1 });
const archive = (figure: unknown) => JSON.stringify({ format: 'peetty-backup', version: 2, createdAt: 1, activeProfileId: 'fixture', profiles: [profile(figure)] });
const table = Uint32Array.from({ length: 256 }, (_, i) => { let crc = i; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
function parts(chunks: string[]) {
  let crc = 0xffffffff; let length = 0;
  for (const text of chunks) { length += text.length; for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); crc = table[(crc ^ code) & 255]! ^ (crc >>> 8); crc = table[(crc ^ (code >>> 8)) & 255]! ^ (crc >>> 8); } }
  const digest = `crc32:${((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}:${length}`;
  return chunks.map((text, index) => JSON.stringify({ format: 'peetty-backup-part', version: 1, backupId: 'figure-bound-fixture', count: chunks.length, index, digest, text }));
}
const files = (texts: string[]) => texts.map(text => ({ size: Buffer.byteLength(text), text: async () => text }));

describe('figure subtree byte accounting', () => {
  it('matches canonical UTF-8 size for nested values, escapes and split surrogate pairs', async () => {
    const figure = { text: '雪🙂\n\u0000"\\', values: [{ flag: true }, null, 1.25, -0, 'end'], empty: {}, array: [] };
    const source = JSON.stringify({ figure });
    const chunks = source.split(''); // Split UTF-16 surrogate pairs across transport pieces.
    const options = { maxBytes: (path: readonly string[]) => path.join('.') === 'figure' ? bytes(figure) : undefined };
    assert.deepEqual(parseJSONChunks(chunks, 10_000, undefined, options), JSON.parse(source));
    async function* input() { yield* chunks; }
    assert.deepEqual(await parseJSONChunksAsync(input(), 10_000, undefined, options), JSON.parse(source));
    const smaller = { maxBytes: (path: readonly string[]) => path.join('.') === 'figure' ? bytes(figure) - 1 : undefined };
    assert.throws(() => parseJSONChunks(chunks, 10_000, undefined, smaller), /Invalid/u);
    await assert.rejects(parseJSONChunksAsync(input(), 10_000, undefined, smaller), /Invalid/u);
  });

  it('accounts replacement properties once and preserves owned prototype-named keys', () => {
    for (const source of ['{"figure":{"x":"a","x":"b"}}', '{"figure":{"__proto__":1,"__proto__":2,"constructor":3}}']) {
      const expected = JSON.parse(source) as { figure: unknown };
      assert.deepEqual(parseJSONChunks(Array.from(source), 1_000, undefined, { maxBytes: path => path.join('.') === 'figure' ? bytes(expected.figure) : undefined }), expected);
    }
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it('rejects cumulative nested collection growth before requesting the tail', async () => {
    let tailRead = false; let closed = false;
    async function* source() { try { yield '{"figure":{"extension":{"nested":[' + 'null,'.repeat(100); tailRead = true; yield 'null]}}}'; } finally { closed = true; } }
    await assert.rejects(parseJSONChunksAsync(source(), 1_000, undefined, { maxBytes: path => path.join('.') === 'figure' ? 100 : undefined }), /Invalid/u);
    assert.equal(tailRead, false); assert.equal(closed, true);
  });
});

describe('figure bounds in multipart restores', () => {
  it('rejects one oversized figure while decoding the first payload and keeps the target unchanged', async (t) => {
    const target = new BrowserProfileStore('oversized-figure', false); await target.initialize(); t.after(() => target.close());
    const figure = { ...structuredClone(PRESETS.miru), extension: { nested: Array.from({ length: LIMITS.maxBytes / 2 }, () => 0) } };
    assert.ok(bytes(figure) > LIMITS.maxBytes);
    const source = archive(figure);
    const encoded = parts([source.slice(0, -10), source.slice(-10)]);
    const reads = [0, 0]; const before = target.profiles;
    await assert.rejects(target.restoreFileSelection(encoded.map((text, i) => ({ size: Buffer.byteLength(text), text: async () => { reads[i] = reads[i]! + 1; return text; } }))), /Invalid/u);
    assert.deepEqual(reads, [2, 1]); assert.deepEqual(target.profiles, before);
    await assert.rejects(target.restoreFiles(encoded), /Invalid/u);
    assert.deepEqual(target.profiles, before);
  });

  it('round-trips a valid figure at its full byte ceiling', async (t) => {
    const base = { ...structuredClone(PRESETS.miru), padding: '' };
    const figure = { ...base, padding: 'a'.repeat(LIMITS.maxBytes - bytes(base)) };
    assert.equal(bytes(figure), LIMITS.maxBytes); validateFigure(figure);
    const source = new BrowserProfileStore('max-figure-source', false); await source.initialize(); t.after(() => source.close());
    await source.update(source.activeProfileId, { figure });
    const output = await source.backupDownload({ _testing: { fileBytes: 131_072 } });
    assert.notEqual(typeof output, 'string');
    const encoded: string[] = [];
    if (typeof output !== 'string') for await (const part of output) encoded.push(part.text);
    const target = new BrowserProfileStore('max-figure-target', false); await target.initialize(); t.after(() => target.close());
    await target.restoreFileSelection(files(encoded));
    assert.deepEqual(target.activeProfile.figure, figure);
  });

  it('uses full schema paths for dynamic clip keys instead of matching their final names', async (t) => {
    const figure = structuredClone(PRESETS.miru);
    assert.ok(figure.renderer === 'rig');
    const shapes = Array.from({ length: LIMITS.maxShapesPerPart }, () => ({ type: 'ellipse' as const, cx: 1, cy: 2, rx: 1, ry: 1 }));
    const names = ['center', 'focus', 'from', 'to', 'pivot', 'look', 'anchor', 'viewBox', 'parts', 'shapes', 'frames', 'stops', 'notes', 'palette', 'gradients'];
    figure.clips = { ...figure.clips, ...Object.fromEntries(names.map(name => [name, shapes])) };
    figure.parts[0]!.clip = 'center';
    validateFigure(figure);
    const source = new BrowserProfileStore('dynamic-clips-source', false); await source.initialize(); t.after(() => source.close());
    await source.update(source.activeProfileId, { figure });
    const output = await source.backupDownload({ _testing: { fileBytes: 16_384 } });
    assert.notEqual(typeof output, 'string');
    const encoded: string[] = [];
    if (typeof output !== 'string') for await (const part of output) encoded.push(part.text);
    for (const method of ['files', 'strings'] as const) {
      const target = new BrowserProfileStore(`dynamic-clips-${method}`, false); await target.initialize(); t.after(() => target.close());
      if (method === 'files') await target.restoreFileSelection(files(encoded)); else await target.restoreFiles(encoded);
      assert.deepEqual(target.activeProfile.figure, figure);
    }
  });
});
