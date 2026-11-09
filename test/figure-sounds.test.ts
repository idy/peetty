import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { SOUND_EVENTS, type SoundCue } from '../src/figure/types.ts';
import { FigureError, validateFigure } from '../src/figure/validate.ts';
import { soundSource } from '../src/figure/sources.ts';
import { PRESETS, resolveFigure } from '../src/presets.ts';
import { stubGlobals } from './helpers/stubs.ts';

const withCue = (cue: unknown) => ({ ...PRESETS.miru, sounds: { events: { wave: [cue] } } });

describe('figure sound configuration', () => {
  it('keeps older figures valid and accepts file and synthesized variants', () => {
    const legacy = { ...PRESETS.miru };
    delete legacy.sounds;
    assert.equal(validateFigure(legacy), legacy);
    for (const cue of [
      { notes: [440, 660], duration: 0.1, waveform: 'triangle' },
      { src: './sounds/hello.ogg', playbackRate: 1.2, volume: 0.5 },
      { src: 'https://cdn.example/hello.mp3' },
    ]) assert.doesNotThrow(() => validateFigure(withCue(cue)));
  });

  it('rejects unsafe sources, unbounded sequences and ambiguous cues', () => {
    for (const cue of [
      {}, { src: 'javascript:alert(1)' }, { src: '//untrusted.example/sfx.ogg' },
      { src: 'ftp://example.com/sound.ogg' }, { src: 'data:audio/ogg;base64,AAAA' },
      { src: 'https://user:secret@example.com/sound.ogg' }, { src: 'bad\\path.ogg' },
      { src: 'https://example.com/a.ogg', notes: [440] },
      { notes: [] }, { notes: [10] }, { notes: [Infinity] }, { notes: Array(9).fill(440) },
      { notes: Array(8).fill(440), duration: 1 }, { notes: [440], waveform: 'sawtooth' },
      { notes: [440], volume: 1.5 }, { notes: [440], playbackRate: 1 },
      { src: './a.mp3', duration: 0.1 }, { src: './a.mp3', playbackRate: 4 },
    ]) assert.throws(() => validateFigure(withCue(cue)), FigureError, JSON.stringify(cue));
  });

  it('validates event names, gains, cooldown and variant limits', () => {
    for (const sounds of [
      null, {}, { events: [] }, { events: { unknown: [{ notes: [440] }] } },
      { events: { wave: [] } }, { events: { wave: Array(9).fill({ notes: [440] }) } },
      { volume: -1, events: {} }, { cooldown: 61, events: {} },
      { volume: NaN, events: {} }, { events: {}, surprise: true },
    ]) assert.throws(() => validateFigure({ ...PRESETS.miru, sounds }), FigureError);
    const events = Object.fromEntries(SOUND_EVENTS.map((event) => [event, [{ notes: [440] }]]));
    assert.doesNotThrow(() => validateFigure({ ...PRESETS.miru, sounds: { events } }));
  });

  it('ships distinct offline cues for every catalog character', async () => {
    const figures = await Promise.all([...Object.keys(PRESETS), 'shiori'].map(async (id) =>
      validateFigure(JSON.parse(await readFile(new URL(`../figures/${id}.json`, import.meta.url), 'utf8')))));
    const greetings = new Set<string>();
    for (const figure of figures) {
      assert.ok(figure.sounds?.events.wave?.length, `${figure.id} has a preview`);
      greetings.add(JSON.stringify(figure.sounds.events.wave));
      for (const event of ['jump', 'land', 'drag', 'sleep', 'wake', 'talk'] as const) {
        assert.ok(figure.sounds.events[event]?.length, `${figure.id} has ${event}`);
      }
      for (const cues of Object.values(figure.sounds.events)) {
        for (const cue of cues) assert.ok(cue.notes && !cue.src, 'presets work without downloads');
      }
    }
    assert.equal(greetings.size, figures.length);
  });

  it('resolves relative file URLs against the final figure URL', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'https://host.example/page/' } }));
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true, url: 'https://assets.example/pets/mimi/figure.json',
      json: async () => withCue({ src: './sounds/hi.ogg' }),
    }) as Response);
    const figure = await resolveFigure('/pets/mimi.json');
    assert.equal(figure.sounds!.events.wave![0]!.src, './sounds/hi.ogg');
    assert.equal(soundSource(figure.sounds!, figure.sounds!.events.wave![0]!.src!), 'https://assets.example/pets/mimi/sounds/hi.ogg');
    assert.doesNotThrow(() => validateFigure(figure));
  });

  it('keeps local audio paths valid after resolving them for the renderer', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'http://localhost:4181/site/' } }));
    const figure = await resolveFigure(withCue({ src: '../sounds/hi.wav' }));
    assert.equal(soundSource(figure.sounds!, figure.sounds!.events.wave![0]!.src!), 'http://localhost:4181/sounds/hi.wav');
    assert.doesNotThrow(() => validateFigure(figure), 'FigureView validates the resolved figure again');
  });

  it('keeps valid packs renderable after quoted-base and Unicode URL resolution', async (t) => {
    t.after(stubGlobals({ document: { baseURI: "https://host.example/people/o'brien/" } }));
    for (const src of ['./hello.ogg', './' + 'x'.repeat(2040), 'https://assets.example/' + 'é'.repeat(400) + '.ogg']) {
      const input = withCue({ src });
      assert.doesNotThrow(() => validateFigure(input));
      const result = await resolveFigure(input);
      assert.equal(result.sounds!.events.wave![0]!.src, src, 'asset metadata does not rewrite the JSON');
      assert.doesNotThrow(() => validateFigure(result), 'renderer revalidation retains the same limits');
      assert.equal(soundSource(result.sounds!, src), new URL(src, document.baseURI).href);
      const again = await resolveFigure(result);
      assert.equal(soundSource(again.sounds!, src), new URL(src, document.baseURI).href);
    }
  });

  it('keeps independent figure bases and drops inherited document credentials', async (t) => {
    const document = { baseURI: 'https://user:secret@host.example/one/' };
    t.after(stubGlobals({ document }));
    const input = withCue({ src: './hi.wav' });
    const first = await resolveFigure(input);
    document.baseURI = 'https://host.example/two/';
    const second = await resolveFigure(input);
    assert.equal(soundSource(first.sounds!, './hi.wav'), 'https://host.example/one/hi.wav');
    assert.equal(soundSource(second.sounds!, './hi.wav'), 'https://host.example/two/hi.wav');
    assert.equal(soundSource(first.sounds!, 'data:audio/wav;base64,AQID'), undefined);
  });

  it('resolves inline file paths without mutating supplied figure data', async (t) => {
    t.after(stubGlobals({ document: { baseURI: 'https://host.example/embed/' } }));
    const cue: SoundCue = { src: './sfx/hi.ogg' };
    const input = withCue(cue);
    const result = await resolveFigure(input);
    assert.equal(result.sounds!.events.wave![0]!.src, './sfx/hi.ogg');
    assert.equal(soundSource(result.sounds!, cue.src!), 'https://host.example/embed/sfx/hi.ogg');
    assert.equal(cue.src, './sfx/hi.ogg');
  });
});
