import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { pageColor } from '../src/chat/page-color.ts';
import { imageColorById, imageColorOf } from '../src/figure/image-color.ts';
import { PRESETS } from '../src/presets.ts';
import { validateFigure } from '../src/figure/validate.ts';
import { createPortrait } from '../src/figure/portrait.ts';
import { parseCssColor } from '../src/figure/color.ts';
import { stubGlobals } from './helpers/stubs.ts';

function fixture(t: TestContext) {
  const window = new Window({ url: 'https://host.example/' });
  t.after(() => window.close());
  const document = window.document as unknown as Document;
  function control(tag: 'button' | 'a', fill: string, text = '#333333') {
    const node = document.createElement(tag);
    if (tag === 'a') node.setAttribute('href', '/');
    Object.assign(node.style, { backgroundColor: fill, color: text, visibility: 'visible', opacity: '1' });
    // This fixture supplies layout and visibility; HappyDOM has no rendering engine.
    node.checkVisibility = () => true;
    node.getBoundingClientRect = () => ({ x: 20, y: 20, top: 20, left: 20, right: 140, bottom: 60, width: 120, height: 40, toJSON() {} });
    document.body.append(node);
    return node;
  }
  return { document, window, control };
}

describe('shared page and character colour parsing', () => {
  for (const value of ['#0c0', '#0c0f', '#00cc00', '#00cc00ff', 'rgb(0, 204, 0)', 'rgb(0% 80% 0% / 100%)', 'rgba(0, 204, 0, 1)', 'hsl(120, 100%, 40%)', 'hsl(-240 100% 40% / 100%)', 'hsla(480, 100%, 40%, 1)']) {
    it(`maps ${value} to the same palette on the page and the figure`, (t) => {
      const { document } = fixture(t);
      document.documentElement.style.setProperty('--accent', value);
      const figure = structuredClone(PRESETS.miru);
      figure.id = 'synthetic-color-figure';
      figure.palette.iris = value;
      assert.doesNotThrow(() => validateFigure(figure), 'the figure accepts this palette syntax');
      assert.equal(imageColorOf(figure), 'green');
      assert.equal(pageColor(document), 'green');
    });
  }
  it('preserves the hue of translucent figure palettes while ignoring faint page controls', (t) => {
    const { document } = fixture(t);
    for (const iris of ['#0c08', '#00cc0080', 'rgba(0, 204, 0, .5)', 'hsla(120, 100%, 40%, .5)']) {
      assert.equal(imageColorOf({ id: 'synthetic-translucent-figure', palette: { iris } }), 'green');
      document.documentElement.style.setProperty('--accent', iris);
      assert.equal(pageColor(document), undefined);
    }
  });
  it('keeps neutral, transparent and missing palette fallbacks', () => {
    const id = 'synthetic-neutral-figure';
    assert.equal(imageColorOf({ id, palette: { iris: 'hsl(120 0% 50%)', hair: 'rgb(0 204 0)' } }), 'green');
    assert.equal(imageColorOf({ id, palette: { iris: '#00cc0000', hair: '#888888', ribbon: 'rgba(0, 204, 0, 0)' } }), imageColorById(id));
    assert.equal(imageColorOf({ id, palette: {} }), imageColorById(id));
  });
});

describe('portrait colour and cleanup', () => {
  function portraitDOM(t: TestContext) {
    const { document, window } = fixture(t);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    t.after(stubGlobals({ document, matchMedia: () => media }));
    return { document, media };
  }

  it('falls back from valid figures with overflowing HSL channels and releases portrait listeners', (t) => {
    const { document, media } = portraitDOM(t);
    const addDocument = t.mock.method(document, 'addEventListener');
    const removeDocument = t.mock.method(document, 'removeEventListener');
    const addMedia = t.mock.method(media, 'addEventListener');
    const removeMedia = t.mock.method(media, 'removeEventListener');
    const figure = structuredClone(PRESETS.miru); figure.id = 'giant-hue-portrait';
    figure.palette.iris = `hsl(${'9'.repeat(400)} 100% 50%)`; figure.palette.hair = '#00cc00';
    const valid = validateFigure(figure);
    assert.equal(parseCssColor(figure.palette.iris), undefined);
    const portrait = createPortrait(valid)!;
    assert.equal(portrait.color, 'green'); portrait.setLive(true); portrait.destroy();
    const documentCallbacks = (calls: typeof addDocument.mock.calls) => calls.filter(call => call.arguments[0] === 'visibilitychange').map(call => call.arguments[1]);
    assert.deepEqual(documentCallbacks(removeDocument.mock.calls), documentCallbacks(addDocument.mock.calls));
    assert.equal(addMedia.mock.callCount(), 1); assert.equal(removeMedia.mock.callCount(), 1);
    assert.equal(removeMedia.mock.calls[0]!.arguments[1], addMedia.mock.calls[0]!.arguments[1]);
    for (const value of [`rgb(${'9'.repeat(400)} 0 0)`, `hsl(120 ${'9'.repeat(400)}% 50%)`, `hsl(120 100% 50% / ${'9'.repeat(400)})`]) {
      assert.equal(parseCssColor(value), undefined, 'all non-finite channels fall back safely');
    }
  });

  it('uses exactly the valid effective renderer palette and retains bundled colours without overrides', (t) => {
    portraitDOM(t);
    const custom = structuredClone(PRESETS.miru); custom.id = 'overridden-portrait'; custom.palette.iris = '#cc0000';
    const green = createPortrait(custom, { palette: { iris: '#00cc00', hair: '#0000cc', added: '#cc00cc' } })!;
    assert.equal(green.color, 'green');
    assert.ok(green.element.querySelector('[fill="#00cc00"], stop[stop-color="#00cc00"]'), 'the portrait renders the same overridden iris colour');
    green.destroy();
    const invalid = createPortrait(custom, { palette: { iris: 'url(https://invalid.test/color)' } })!;
    assert.equal(invalid.color, 'red'); invalid.destroy();
    const bundled = createPortrait(PRESETS.xiaoxiao)!; assert.equal(bundled.color, 'red'); bundled.destroy();
    const unchanged = createPortrait(PRESETS.xiaoxiao, { palette: { unknown: '#00cc00', iris: 'invalid' } })!;
    assert.equal(unchanged.color, 'red'); unchanged.destroy();
    const overridden = createPortrait(PRESETS.xiaoxiao, { palette: { iris: '#00cc00' } })!;
    assert.equal(overridden.color, 'green'); overridden.destroy();
  });
});

describe('host page colour selection', () => {
  it('prefers an explicit theme token over incidental button colours', (t) => {
    const { document, control } = fixture(t);
    control('button', '#d43545');
    document.documentElement.style.setProperty('--accent', '#23894b');
    assert.equal(pageColor(document), 'green');
    document.documentElement.style.setProperty('--accent', 'rgb(28 105 221)');
    assert.equal(pageColor(document), 'blue');
  });
  it('ignores neutral tokens and respects theme-color media conditions', (t) => {
    const { document, window } = fixture(t);
    document.documentElement.style.setProperty('--primary', '#ffffff');
    for (const [media, content] of [['(prefers-color-scheme: dark)', '#d43545'], ['', '#16858e']]) {
      const meta = document.createElement('meta'); meta.name = 'theme-color'; meta.media = media!; meta.content = content!; document.head.append(meta);
    }
    t.mock.method(window, 'matchMedia', () => ({ matches: false }) as ReturnType<typeof window.matchMedia>);
    assert.equal(pageColor(document), 'teal');
  });
  it('uses repeated filled controls before link text, excluding hidden and pet controls', (t) => {
    const { document, control } = fixture(t);
    control('button', '#2375d8'); control('button', '#2672cf');
    control('button', '#d43545'); control('a', 'transparent', '#d43545');
    for (let i = 0; i < 4; i++) control('button', '#d43545').setAttribute('data-peetty', 'avoid');
    for (let i = 0; i < 4; i++) control('button', '#d43545').hidden = true;
    assert.equal(pageColor(document), 'blue');
  });
  it('returns no page colour for a neutral page and default browser links', (t) => {
    const { document, control } = fixture(t);
    document.body.style.backgroundColor = '#222222';
    control('button', '#888888'); control('a', 'transparent', 'rgb(0, 0, 238)');
    control('a', 'transparent', 'rgb(85, 26, 139)');
    assert.equal(pageColor(document), undefined);
  });
  it('ignores low-opacity fills and offscreen controls', (t) => {
    const { document, control } = fixture(t);
    control('button', 'rgba(255, 0, 0, .1)');
    control('button', '#d43545').checkVisibility = () => false;
    const offscreen = control('button', '#d43545');
    offscreen.getBoundingClientRect = () => ({ x: 0, y: -50, top: -50, left: 0, right: 20, bottom: -20, width: 20, height: 30, toJSON() {} });
    assert.equal(pageColor(document), undefined);
  });
  it('bounds style reads on pages with many controls', (t) => {
    const { document, window, control } = fixture(t);
    for (let i = 0; i < 60; i++) control('button', i < 24 ? '#777777' : '#d43545');
    const original = window.getComputedStyle.bind(window);
    const reads = t.mock.method(window, 'getComputedStyle', original);
    assert.equal(pageColor(document), undefined);
    assert.ok(reads.mock.callCount() <= 28);
  });
});
