import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RigRenderer } from '../src/figure/rig.ts';
import type { Pose } from '../src/figure/types.ts';
import { element, fixture, installDOM, part } from './helpers/dom.ts';

function angle(renderer: RigRenderer, id = 'hair'): number {
  const transform = part(renderer.svg, id).children[0]!.getAttribute('transform');
  const match = /rotate\(([-\d.]+)/.exec(transform ?? '');
  assert.ok(match, `Expected a spring rotation, got ${transform}`);
  return Number(match[1]);
}

describe('rig springs', () => {
  it('advances the same fixed timeline at common refresh rates', (t) => {
    installDOM(t);
    const results = [60, 90, 120, 144, 240].map((fps) => {
      const renderer = new RigRenderer(fixture());
      for (let frame = 0; frame < fps / 6; frame++) {
        renderer.frame({ head: { rotate: 10 } }, 1 / fps, [160, 0]);
      }
      return angle(renderer);
    });
    assert.ok(Math.abs(results[0]!) > 1, 'exercise a displaced spring');
    assert.deepEqual(results, results.map(() => results[0]));
  });

  it('carries fractional ticks across irregular display frames', (t) => {
    installDOM(t);
    const regular = new RigRenderer(fixture());
    for (let frame = 0; frame < 20; frame++) regular.frame({ head: { rotate: 10 } }, 1 / 120, [160, 0]);
    const irregular = new RigRenderer(fixture());
    const intervals = [1 / 240, 1 / 75, 1 / 165, 1 / 40];
    let elapsed = 0;
    let frame = 0;
    while (elapsed < 1 / 6 - 1e-10) {
      const dt = Math.min(intervals[frame++ % intervals.length]!, 1 / 6 - elapsed);
      irregular.frame({ head: { rotate: 10 } }, dt, [160, 0]);
      elapsed += dt;
    }
    assert.equal(angle(irregular), angle(regular));
  });

  it('retains force from a display frame too short to advance a tick', (t) => {
    installDOM(t);
    const fast = new RigRenderer(fixture());
    fast.frame({}, 1 / 240, [320, 0]);
    assert.equal(angle(fast), 0);
    fast.frame({}, 1 / 240, [0, 0]);
    const fixed = new RigRenderer(fixture());
    fixed.frame({}, 1 / 120, [160, 0]);
    assert.notEqual(angle(fast), 0);
    assert.equal(angle(fast), angle(fixed));
  });

  it('keeps the original 60 Hz force tuning at every refresh rate', (t) => {
    installDOM(t);
    for (const fps of [30, 60, 90, 120, 144, 240]) {
      const renderer = new RigRenderer(fixture());
      for (let frame = 0; frame < fps * 2; frame++) renderer.frame({}, 1 / fps, [160, 0]);
      // At rest, stiffness * 0.5 * angle balances half the acceleration input.
      assert.equal(angle(renderer), -1.296, `${fps} Hz`);
    }
  });

  it('normalizes both pivot acceleration and push to the drawing size', (t) => {
    installDOM(t);
    const units = [0.5, 1, 2.5];
    const renderers = units.map((unit) => new RigRenderer(fixture(unit, [17, -23])));
    for (let frame = 1; frame <= 90; frame++) {
      const time = frame / 90;
      for (const [index, unit] of units.entries()) {
        renderers[index]!.frame({ root: { x: Math.sin(time * 4) * 2 * unit, y: Math.cos(time * 3) * unit } }, 1 / 90, [160 * unit, -80 * unit]);
      }
      assert.equal(angle(renderers[0]!), angle(renderers[1]!));
      assert.equal(angle(renderers[2]!), angle(renderers[1]!));
    }
  });
});

describe('rig rendering', () => {
  it('keeps gradient and clip references distinct, including across renderer instances', (t) => {
    installDOM(t);
    const figure = fixture();
    figure.gradients = { shared: { type: 'linear', from: [0, 0], to: [20, 0], stops: [{ offset: 0, color: 'ink' }] } };
    figure.clips = { shared: [{ type: 'ellipse', cx: 0, cy: 0, rx: 4, ry: 8 }] };
    figure.parts[0]!.clip = 'shared';
    figure.parts[0]!.shapes[0]!.fill = 'shared';
    const ids = new Set<string>();
    for (let instance = 0; instance < 2; instance++) {
      const renderer = new RigRenderer(figure);
      const definitions = element(renderer.svg).children[0]!.children;
      const gradient = definitions.find((node) => node.tagName === 'linearGradient')!;
      const clip = definitions.find((node) => node.tagName === 'clipPath')!;
      const gradientId = gradient.getAttribute('id')!;
      const clipId = clip.getAttribute('id')!;
      ids.add(gradientId);
      ids.add(clipId);
      const clipped = part(renderer.svg, 'hair').children[0]!;
      assert.equal(clipped.getAttribute('clip-path'), `url(#${clipId})`);
      assert.equal(clipped.children[0]!.children[0]!.getAttribute('fill'), `url(#${gradientId})`);
    }
    assert.equal(ids.size, 4);
  });

  it('resolves owned prototype-named palette keys without inventing gradients', (t) => {
    installDOM(t);
    const figure = fixture();
    figure.palette = { constructor: '#123456' };
    figure.gradients = {};
    figure.parts[0]!.shapes[0]!.fill = 'constructor';
    const renderer = new RigRenderer(figure, { palette: { constructor: '#654321' } });
    assert.equal(part(renderer.svg, 'hair').children[0]!.children[0]!.getAttribute('fill'), '#654321');
  });

  it('ignores palette overrides for inherited object properties', (t) => {
    installDOM(t);
    const figure = fixture();
    // Direct renderer construction also must not turn inherited names into overrides.
    figure.parts[0]!.shapes[0]!.fill = 'constructor';
    const renderer = new RigRenderer(figure, { palette: { constructor: '#654321' } });
    assert.equal(part(renderer.svg, 'hair').children[0]!.children[0]!.getAttribute('fill'), 'constructor');
  });

  it('sorts parts stably without mutating the figure', (t) => {
    installDOM(t);
    const figure = fixture();
    const template = figure.parts[0]!;
    figure.parts = [
      { ...template, id: 'frontA', z: 3 },
      { ...template, id: 'back', z: -2 },
      { ...template, id: 'frontB', z: 3 },
      { ...template, id: 'middle', z: 0 },
    ];
    Object.freeze(figure.parts);
    const renderer = new RigRenderer(figure);
    assert.deepEqual(element(renderer.svg).children.filter((node) => node.dataset.part).map((node) => node.dataset.part), ['back', 'middle', 'frontA', 'frontB']);
    assert.deepEqual(figure.parts.map((entry) => entry.id), ['frontA', 'back', 'frontB', 'middle']);
  });

  it('skips hidden DOM writes while preserving motion and renders a revealed slot immediately', (t) => {
    installDOM(t);
    const figure = fixture();
    const template = figure.parts[0]!;
    figure.parts = [
      { ...template, id: 'visible', look: [2, 3] },
      { ...template, id: 'hidden', slot: 'armL:up', look: [2, 3] },
    ];
    const renderer = new RigRenderer(figure);
    const hidden = part(renderer.svg, 'hidden');
    const hiddenInner = hidden.children[0]!;
    const visible = part(renderer.svg, 'visible');
    const initialOuterWrites = hidden.writes.length;
    const initialInnerWrites = hiddenInner.writes.length;
    assert.equal(hidden.style.display, 'none');
    for (let frame = 1; frame <= 20; frame++) {
      const pose: Pose = { root: { x: Math.sin(frame * 0.2) * 2 }, head: { rotate: frame * 0.3 } };
      renderer.setLook(frame / 20, 0.4);
      renderer.frame(pose, 1 / 90, [160, 0]);
    }
    assert.equal(hidden.writes.length, initialOuterWrites);
    assert.equal(hiddenInner.writes.length, initialInnerWrites);
    renderer.setSlot('armL', 'up');
    assert.equal(hidden.style.display, '');
    assert.equal(hidden.getAttribute('transform'), visible.getAttribute('transform'));
    assert.equal(hiddenInner.getAttribute('transform'), visible.children[0]!.getAttribute('transform'));
    assert.notEqual(angle(renderer, 'hidden'), 0);
    renderer.frame({ root: { x: 5 }, head: { rotate: 7 } }, 1 / 90, [160, 0]);
    assert.equal(hiddenInner.getAttribute('transform'), visible.children[0]!.getAttribute('transform'));
  });

  it('renders a part revealed between frames with the current pose of its bone', (t) => {
    installDOM(t);
    const figure = fixture();
    const template = figure.parts[0]!;
    figure.parts = [{ ...template, id: 'head' }, { ...template, id: 'arm', bone: 'armL', slot: 'armL:up' }];
    const renderer = new RigRenderer(figure);
    const arm = part(renderer.svg, 'arm');
    renderer.frame({ armL: { rotate: 90 } }, 1 / 60);
    renderer.setSlot('armL', 'up');
    assert.equal(arm.getAttribute('transform'), 'matrix(0 1 -1 0 0 0)');
    renderer.frame({ armL: { rotate: -90 } }, 1 / 60);
    assert.equal(arm.getAttribute('transform'), 'matrix(0 -1 1 0 0 0)');
  });

  it('switches several slots with a single visibility refresh', (t) => {
    installDOM(t);
    const figure = fixture();
    const template = figure.parts[0]!;
    const ids = ['eyes:open', 'eyes:closed', 'mouth:smile', 'mouth:o'];
    figure.parts = ids.map((slot) => ({ ...template, id: slot, slot }));
    const renderer = new RigRenderer(figure);
    const refresh = t.mock.method(renderer as unknown as { refreshSlots(): void }, 'refreshSlots');
    const shown = () => ids.filter((id) => part(renderer.svg, id).style.display !== 'none');
    renderer.setSlots({ eyes: 'closed', mouth: 'o' });
    assert.equal(refresh.mock.callCount(), 1);
    assert.deepEqual(shown(), ['eyes:closed', 'mouth:o']);
    renderer.setSlots({ eyes: 'closed', mouth: 'o' });
    assert.equal(refresh.mock.callCount(), 1, 'unchanged slots do not refresh');
    renderer.setSlot('eyes', 'open');
    assert.equal(refresh.mock.callCount(), 2);
    assert.deepEqual(shown(), ['eyes:open', 'mouth:o']);
  });

  it('leaves the inner group alone for a part that never moves within its bone', (t) => {
    installDOM(t);
    const figure = fixture();
    figure.parts = [{ id: 'still', bone: 'head', z: 0, shapes: figure.parts[0]!.shapes }];
    const renderer = new RigRenderer(figure);
    for (let frame = 0; frame < 5; frame++) renderer.frame({ head: { rotate: frame } }, 1 / 60);
    const inner = part(renderer.svg, 'still').children[0]!;
    assert.equal(inner.getAttribute('transform'), null);
    assert.deepEqual(inner.writes, []);
  });

  it('draws her soul from her mouth above every part and blanks the irises while it is out', (t) => {
    installDOM(t);
    const figure = fixture();
    const template = figure.parts[0]!;
    figure.parts = [
      { ...template, id: 'iris', slot: 'eyes:open', look: [2, 1] },
      { ...template, id: 'white', slot: 'eyes:open' },
    ];
    const renderer = new RigRenderer(figure);
    const children = element(renderer.svg).children;
    const soul = children.find((node) => node.dataset.effect === 'soul')!;
    assert.equal(children.at(-1), soul, 'drawn in front of every part');
    assert.equal(soul.style.display, 'none');
    assert.equal(soul.style.pointerEvents, 'none');
    renderer.setSoul({ out: 1, drift: [0, 0] });
    renderer.frame({ head: { rotate: 10 } }, 1 / 60);
    assert.equal(soul.style.display, '');
    assert.equal(part(renderer.svg, 'iris').style.display, 'none');
    assert.notEqual(part(renderer.svg, 'white').style.display, 'none', 'the eye whites stay');
    const outline = soul.children[0]!.getAttribute('d')!;
    assert.match(outline, /^M[-\d. ]+A[-\d. ]+Q[-\d. ]+Q[-\d. ]+Z$/);
    // The tail ends at her mouth, 9 units above the head pivot, turning with her head.
    assert.ok(outline.includes(' 1.56 -8.86Q'), outline);
    renderer.setSoul(null);
    assert.equal(soul.style.display, 'none');
    assert.equal(part(renderer.svg, 'iris').style.display, '');
  });

  it('scales her soul and its drift, given in animation units, with the drawing', (t) => {
    installDOM(t);
    const face = (unit: number) => {
      const renderer = new RigRenderer(fixture(unit));
      renderer.setSoul({ out: 1, drift: [4, -3] });
      renderer.frame({}, 0);
      const soul = element(renderer.svg).children.find((node) => node.dataset.effect === 'soul')!;
      return soul.children[1]!.getAttribute('transform');
    };
    assert.equal(face(1), 'translate(62 -108) scale(22)');
    assert.equal(face(2.5), 'translate(155 -270) scale(55)');
  });
});
