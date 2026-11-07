import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FigureView } from '../src/figure/view.ts';
import { element, fixture, installDOM, TestElement } from './helpers/dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

/** Counts assignments to a plain property while keeping its value. */
function countWrites(target: object, key: string): { count: number } {
  const counter = { count: 0 };
  let value: unknown = Reflect.get(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => value,
    set: (next: unknown) => {
      counter.count++;
      value = next;
    },
  });
  return counter;
}

describe('figure view facing', () => {
  it('mirrors around an asymmetric anchor in CSS pixels', (t) => {
    installDOM(t);
    const figure = fixture(2, [10, 20]);
    const view = new FigureView(figure, { manual: true, scale: 2, track: false });
    assert.deepEqual(view.anchor, [70, 256]);
    assert.equal(view.direction, 1);
    assert.equal(view.renderer.svg.style.transformBox, 'border-box');
    assert.equal(view.renderer.svg.style.transformOrigin, '70px 256px');
    view.setFacing(-1);
    assert.equal(view.direction, -1);
    assert.equal(view.renderer.svg.style.transform, 'scaleX(-1)');
    assert.notEqual(view.anchor[0], view.width / 2, 'fixture must exercise a noncentral anchor');
    view.setFacing(1);
    assert.equal(view.direction, 1);
    assert.equal(view.renderer.svg.style.transform, '');
    view.destroy();
  });

  it('writes the mirror transform only when the direction changes', (t) => {
    installDOM(t);
    const view = new FigureView(fixture(), { manual: true, track: false });
    const transform = countWrites(view.renderer.svg.style, 'transform');
    view.setFacing(1);
    assert.equal(transform.count, 0, 'already facing right');
    view.setFacing(-1);
    view.setFacing(-1);
    assert.equal(transform.count, 1);
    view.setFacing(1);
    assert.equal(transform.count, 2);
    assert.equal(view.renderer.svg.style.transform, '');
    view.destroy();
  });
});

describe('figure view steps', () => {
  it('writes the emote only when it changes', (t) => {
    installDOM(t);
    const view = new FigureView(fixture(), { manual: true, track: false });
    const emote = element(view.element).children[1]!;
    const text = countWrites(emote, 'textContent');
    const opacity = countWrites(emote.style, 'opacity');
    view.step(1 / 60);
    assert.deepEqual([text.count, opacity.count], [0, 0], 'starts hidden');
    view.play('sleep');
    for (let i = 0; i < 10; i++) view.step(1 / 60);
    assert.deepEqual([emote.textContent, emote.style.opacity], ['z', '1']);
    assert.deepEqual([text.count, opacity.count], [1, 1]);
    view.play('idle');
    for (let i = 0; i < 10; i++) view.step(1 / 60);
    assert.deepEqual([emote.textContent, emote.style.opacity], ['', '0']);
    assert.deepEqual([text.count, opacity.count], [2, 2]);
    view.destroy();
  });

  it('measures the gaze before the step writes to the DOM', (t) => {
    const dom = installDOM(t);
    const view = new FigureView(fixture(), { manual: true });
    dom.browser.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 500, clientY: 40 }));
    const calls: string[] = [];
    const svg = element(view.renderer.svg);
    const measure = svg.getBoundingClientRect.bind(svg);
    svg.getBoundingClientRect = () => {
      calls.push('measure');
      return measure();
    };
    const renderer = view.renderer as unknown as Record<string, (...args: unknown[]) => void>;
    for (const name of ['setSlots', 'setSoul', 'frame']) {
      const original = renderer[name]!.bind(view.renderer);
      renderer[name] = (...args) => {
        calls.push(name);
        original(...args);
      };
    }
    view.step(1 / 60);
    assert.deepEqual(calls, ['measure', 'setSlots', 'setSoul', 'frame']);
    view.destroy();
  });

  it('reports reduced motion and slows the animation for it', (t) => {
    installDOM(t);
    const media = { matches: false };
    const restore = stubGlobals({ matchMedia: () => media });
    const view = new FigureView(fixture(), { manual: true, track: false });
    restore();
    assert.equal(view.reducedMotion, false);
    media.matches = true;
    assert.equal(view.reducedMotion, true);
    const update = t.mock.method(view.motion, 'update');
    view.step(0.1);
    assert.equal(update.mock.calls[0]!.arguments[0], 0.025);
    view.destroy();
  });
});

describe('figure view frame lifecycle', () => {
  it('pauses offscreen and resumes without simulating the paused time', (t) => {
    const dom = installDOM(t);
    const view = new FigureView(fixture(), { track: false });
    const step = t.mock.method(view, 'step');
    const observer = dom.observers[0]!;
    assert.ok(observer.targets.has(view.renderer.svg), 'it watches the drawing, which turning moves around her feet');
    assert.equal(observer.targets.has(view.element), false);
    assert.equal(dom.frames.size, 1);
    dom.frame();
    assert.equal(step.mock.callCount(), 1);
    observer.notify(view.renderer.svg, false);
    assert.equal(dom.frames.size, 0);
    dom.frame(5000);
    assert.equal(step.mock.callCount(), 1);
    observer.notify(view.renderer.svg, true);
    assert.equal(dom.frames.size, 1);
    dom.frame();
    assert.equal(step.mock.callCount(), 2);
    assert.ok(Math.abs(step.mock.calls[1]!.arguments[0] - 1 / 60) < 1e-9);
    view.destroy();
  });

  it('requires both viewport and document visibility before restarting', (t) => {
    const dom = installDOM(t);
    const view = new FigureView(fixture(), { track: false });
    const observer = dom.observers[0]!;
    observer.notify(view.renderer.svg, false);
    dom.visibility(true);
    dom.visibility(false);
    assert.equal(dom.frames.size, 0, 'document visibility must not override an offscreen pause');
    dom.visibility(true);
    observer.notify(view.renderer.svg, true);
    assert.equal(dom.frames.size, 0, 'intersection must not override a hidden document');
    dom.visibility(false);
    assert.equal(dom.frames.size, 1);
    dom.visibility(false);
    observer.notify(view.renderer.svg, true);
    assert.equal(dom.frames.size, 1, 'repeated visibility events must not add frame loops');
    view.destroy();
  });

  it('follows the newest record when one notification holds several', (t) => {
    const dom = installDOM(t);
    const view = new FigureView(fixture(), { track: false });
    const observer = dom.observers[0]!;
    observer.notify(view.renderer.svg, false, true);
    assert.equal(dom.frames.size, 1, 'back on screen by the end of the batch');
    observer.notify(view.renderer.svg, true, false);
    assert.equal(dom.frames.size, 0, 'offscreen by the end of the batch');
    view.destroy();
  });

  it('does not schedule an initial frame while the document is hidden', (t) => {
    const dom = installDOM(t);
    dom.visibility(true);
    const view = new FigureView(fixture(), { track: false });
    assert.equal(dom.frames.size, 0);
    dom.visibility(false);
    assert.equal(dom.frames.size, 1);
    view.destroy();
  });

  it('leaves manual views under host control without visibility observers', (t) => {
    const dom = installDOM(t);
    dom.visibility(true);
    const view = new FigureView(fixture(), { manual: true, track: false });
    assert.equal(dom.frames.size, 0);
    assert.equal(dom.observers.length, 0);
    assert.equal(dom.document.listeners.get('visibilitychange')?.size ?? 0, 0);
    const frame = t.mock.method(view.renderer, 'frame');
    view.step(1 / 60);
    assert.equal(frame.mock.callCount(), 1, 'manual stepping still works in a hidden document');
    dom.visibility(false);
    assert.equal(dom.frames.size, 0);
    view.destroy();
  });

  it('retains document visibility gating without IntersectionObserver support', (t) => {
    const dom = installDOM(t, { intersectionObserver: false });
    const view = new FigureView(fixture(), { track: false });
    assert.equal(dom.observers.length, 0);
    assert.equal(dom.frames.size, 1);
    dom.visibility(true);
    assert.equal(dom.frames.size, 0);
    dom.visibility(false);
    assert.equal(dom.frames.size, 1);
    view.destroy();
  });

  it('disconnects and cannot restart from queued callbacks after destruction', (t) => {
    const dom = installDOM(t);
    const view = new FigureView(fixture());
    const parent = new TestElement('div');
    parent.append(element(view.element));
    const observer = dom.observers[0]!;
    const queuedFrame = [...dom.frames.values()][0]!;
    assert.equal(dom.browser.listeners.get('pointermove')?.size, 1);
    assert.equal(dom.document.listeners.get('visibilitychange')?.size, 1);
    const step = t.mock.method(view, 'step');
    view.destroy();
    assert.equal(parent.children.length, 0);
    assert.equal(dom.frames.size, 0);
    assert.equal(observer.disconnected, true);
    assert.equal(dom.browser.listeners.get('pointermove')?.size, 0);
    assert.equal(dom.document.listeners.get('visibilitychange')?.size, 0);
    observer.notify(view.renderer.svg, true);
    queuedFrame(1000);
    dom.visibility(false);
    assert.equal(step.mock.callCount(), 0);
    assert.equal(dom.frames.size, 0);
  });

  it('keeps frame loops independent across multiple figures', (t) => {
    const dom = installDOM(t);
    const first = new FigureView(fixture(), { track: false });
    const second = new FigureView(fixture(), { track: false });
    assert.equal(dom.frames.size, 2);
    dom.observers[0]!.notify(first.renderer.svg, false);
    assert.equal(dom.frames.size, 1);
    first.destroy();
    dom.frame();
    assert.equal(dom.frames.size, 1);
    second.destroy();
    assert.equal(dom.frames.size, 0);
  });
});
