import type { TestContext } from 'node:test';
import { BONES, type RigFigure } from '../../src/figure/types.ts';
import { ListenerTarget, stubGlobals } from './stubs.ts';

/** Minimal DOM and frame scheduler for renderer lifecycle tests. */
export class TestElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: TestElement[] = [];
  readonly writes: string[] = [];
  parentElement: TestElement | null = null;
  className = '';
  textContent = '';
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.writes.push(name);
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.writes.push(name);
    this.attributes.delete(name);
  }

  append(...elements: TestElement[]): void {
    for (const element of elements) {
      element.remove();
      element.parentElement = this;
      this.children.push(element);
    }
  }

  remove(): void {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }

  getBoundingClientRect() {
    const width = Number(this.getAttribute('width'));
    const height = Number(this.getAttribute('height'));
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 };
  }
}

export function installDOM(t: TestContext, options: { intersectionObserver?: boolean } = {}) {
  const document = new ListenerTarget();
  const browser = new ListenerTarget();
  const page = Object.assign(document, {
    hidden: false,
    createElement: (tag: string) => new TestElement(tag),
    createElementNS: (_namespace: string, tag: string) => new TestElement(tag),
  });
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const observers: TestObserver[] = [];

  class TestObserver {
    readonly targets = new Set<Element>();
    disconnected = false;
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target: Element): void {
      this.targets.add(target);
    }

    disconnect(): void {
      this.disconnected = true;
      this.targets.clear();
    }

    /** Delivers one notification holding a record per state, oldest first. */
    notify(target: Element, ...states: boolean[]): void {
      const records = states.map((isIntersecting) => ({ target, isIntersecting }) as IntersectionObserverEntry);
      this.callback(records, this as unknown as IntersectionObserver);
    }
  }

  t.after(stubGlobals({
    document: page,
    addEventListener: browser.addEventListener.bind(browser),
    removeEventListener: browser.removeEventListener.bind(browser),
    matchMedia: () => ({ matches: false }),
    performance: { now: () => now },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IntersectionObserver: options.intersectionObserver === false ? undefined : TestObserver,
  }));

  return {
    document: page, browser, frames, observers,
    visibility(hidden: boolean) {
      page.hidden = hidden;
      page.dispatchEvent(new Event('visibilitychange'));
    },
    frame(milliseconds = 1000 / 60) {
      now += milliseconds;
      const scheduled = [...frames.values()];
      frames.clear();
      for (const callback of scheduled) callback(now);
    },
  };
}

export function element(node: Element): TestElement {
  return node as unknown as TestElement;
}

export function part(svg: SVGSVGElement, id: string): TestElement {
  const found = element(svg).children.find((child) => child.dataset.part === id);
  if (!found) throw new Error(`Missing part ${id}`);
  return found;
}

export function fixture(unit = 1, origin: [number, number] = [0, 0]): RigFigure {
  const [x, y] = origin;
  return {
    format: 'peetty.figure', version: 1, id: 'test', name: 'Test', renderer: 'rig',
    viewBox: [x, y, 200 * unit, 260 * unit], height: 130, anchor: [x + 70 * unit, y + 256 * unit],
    palette: { ink: '#123456' },
    skeleton: Object.fromEntries(BONES.map((bone) => [bone, { pivot: [x, y] }])) as RigFigure['skeleton'],
    parts: [{
      id: 'hair', bone: 'head', z: 0, pivot: [x, y],
      spring: { stiffness: 0.1, damping: 0.86, gain: 0.9, limit: 25, hang: 0.6 },
      shapes: [{ type: 'ellipse', cx: x, cy: y, rx: 4 * unit, ry: 8 * unit, fill: 'ink' }],
    }],
  };
}
