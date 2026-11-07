import type { TestContext } from 'node:test';
import { ListenerTarget, stubGlobals } from './stubs.ts';

/* Minimal DOM geometry/event harness for the controller; no browser implementation. */

type Rect = { left: number; top: number; width: number; height: number };

export class ElementStub extends ListenerTarget {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> & { setProperty: (key: string, value: string) => void } = {
    setProperty(key: string, value: string) { this[key] = value; },
  };
  readonly children: ElementStub[] = [];
  readonly classList: { add: (...values: string[]) => void; remove: (...values: string[]) => void; contains: (value: string) => boolean };
  readonly captures = new Set<number>();
  parentNode: ElementStub | DocumentStub | null = null;
  shadowRoot: ElementStub | null = null;
  host?: ElementStub;
  activeElement: ElementStub | null = null;
  rect: Rect | null = null;
  /** Where hit tests find the element when it differs from its box, like a stretched link's ::after. */
  hitArea: Rect | null = null;
  className = '';
  textContent = '';
  disabled = false;
  type = 'text';
  dimensionReads = 0;
  boundsReads = 0;

  readonly ownerDocument: DocumentStub;

  constructor(tag: string, ownerDocument: DocumentStub) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tag.toUpperCase();
    const names = new Set<string>();
    this.classList = { add: (...values) => values.forEach((value) => names.add(value)), remove: (...values) => values.forEach((value) => names.delete(value)), contains: (value) => names.has(value) };
  }

  get parentElement(): ElementStub | null { return this.parentNode instanceof ElementStub && !this.parentNode.host ? this.parentNode : null; }
  get firstChild(): ElementStub | null { return this.children[0] ?? null; }
  get firstElementChild(): ElementStub | null { return this.firstChild; }
  get childNodes(): ElementStub[] { return this.children; }
  get nextSibling(): ElementStub | null {
    if (!(this.parentNode instanceof ElementStub)) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean { return !!this.parentNode && (this.parentNode instanceof DocumentStub || this.parentNode.isConnected || !!this.parentNode.host?.isConnected); }
  get offsetWidth(): number { this.dimensionReads++; return this.rect?.width ?? 160; }
  get offsetHeight(): number { this.dimensionReads++; return this.rect?.height ?? 32; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, String(value)); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string): void { this.attrs.delete(key); }
  append(...nodes: ElementStub[]): void {
    for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); }
  }
  replaceChildren(...nodes: ElementStub[]): void {
    for (const node of this.children) node.parentNode = null;
    this.children.length = 0;
    this.append(...nodes);
  }
  remove(): void {
    if (this.parentNode instanceof ElementStub) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
    }
    this.parentNode = null;
  }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  attachShadow(): ElementStub {
    // A shadow root is a document fragment.
    const root = Object.assign(new ElementStub('shadow-root', this.ownerDocument), { nodeType: 11 });
    root.host = this;
    this.shadowRoot = root;
    return root;
  }
  getRootNode(): ElementStub | DocumentStub { return this.parentNode?.getRootNode() ?? this; }
  getBoundingClientRect(): DOMRect {
    this.boundsReads++;
    const { left, top, width, height } = this.rect ?? { left: 0, top: 0, width: Number(this.getAttribute('width') ?? 100), height: Number(this.getAttribute('height') ?? 100) };
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return {}; } };
  }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled;
    if (selector === ':focus-within') return this.contains((this.getRootNode() as DocumentStub).activeElement);
    if (selector.includes('input') && this.tagName === 'INPUT') return true;
    if (selector.includes('textarea') && this.tagName === 'TEXTAREA') return true;
    if (selector.includes('select') && this.tagName === 'SELECT') return true;
    if (selector.includes('[contenteditable]') && this.attrs.has('contenteditable') && this.getAttribute('contenteditable') !== 'false') return true;
    return selector.includes('button') && this.tagName === 'BUTTON';
  }
  closest(selector: string): ElementStub | null {
    for (let current: ElementStub | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  setPointerCapture(id: number): void { this.captures.add(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
  elementsFromPoint(x: number, y: number): ElementStub[] {
    const elements: ElementStub[] = [];
    const visit = (node: ElementStub) => {
      if (node.tagName === 'PEETTY-COMPANION') return;
      const area = node.hitArea;
      const rect = area ? { left: area.left, top: area.top, right: area.left + area.width, bottom: area.top + area.height } : node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) elements.unshift(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return elements;
  }
}

class DocumentStub extends ListenerTarget {
  readonly documentElement = new ElementStub('html', this);
  readonly body = new ElementStub('body', this);
  readonly baseURI = 'https://example.test/';
  activeElement: ElementStub | null = null;
  hidden = false;

  constructor() {
    super();
    this.documentElement.parentNode = this;
    this.documentElement.append(this.body);
  }
  getRootNode(): DocumentStub { return this; }
  createElement(tag: string): ElementStub { return new ElementStub(tag, this); }
  createElementNS(_namespace: string, tag: string): ElementStub { return this.createElement(tag); }
  elementsFromPoint(x: number, y: number): ElementStub[] { return this.documentElement.elementsFromPoint(x, y); }
}

export function installPetDOM(t: TestContext) {
  const document = new DocumentStub();
  const window = new ListenerTarget();
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; at: number }>();
  const observers = new Set<ResizeObserverStub>();
  let now = 0;
  let next = 0;
  class ResizeObserverStub {
    readonly targets = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.add(this); }
    observe(target: Element): void { this.targets.add(target); }
    disconnect(): void { this.targets.clear(); observers.delete(this); }
  }
  const setTimer = (callback: () => void, delay = 0) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; };
  Object.assign(window, { setTimeout: setTimer });
  const values: Record<string, unknown> = {
    document, window,
    Element: ElementStub,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    performance: { now: () => now },
    innerWidth: 1024, innerHeight: 768,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id),
    ResizeObserver: ResizeObserverStub,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: (element: ElementStub) => ({
      display: 'block', contentVisibility: 'visible', opacity: '1', visibility: 'visible',
      backgroundImage: 'none', backgroundColor: 'transparent', boxShadow: 'none',
      borderTopWidth: '0', borderTopStyle: 'none', borderTopColor: 'transparent',
      overflowX: 'visible', overflowY: 'visible', contain: 'none', ...element.style,
    }),
  };
  const restore = stubGlobals(values);
  const cleanups: (() => void)[] = [];
  t.after(() => {
    try { for (const cleanup of cleanups) cleanup(); }
    finally { restore(); }
  });
  const viewport = (width: number, height = 768) => {
    Object.assign(globalThis, { innerWidth: width, innerHeight: height });
    document.documentElement.rect = document.body.rect = { left: 0, top: 0, width, height };
  };
  viewport(1024);
  const frame = (milliseconds = 20) => {
    now += milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  };
  return {
    document, window, frames, timers, observers, viewport, frame,
    cleanup(callback: () => void) { cleanups.push(callback); },
    get now() { return now; },
    resize(target: ElementStub) {
      for (const observer of observers) if (observer.targets.has(target as unknown as Element)) {
        observer.callback([{ target } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    },
    get hosts() { return document.documentElement.children.filter((node) => node.tagName === 'PEETTY-COMPANION'); },
  };
}

export function pointer(type: string, id: number, x = 100, y = 100): PointerEvent {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId: id, button: 0, isPrimary: true, clientX: x, clientY: y }) as PointerEvent;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
