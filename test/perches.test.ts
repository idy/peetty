import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { bottom, crossing, findPerches, floor, inUse, limits, perchOf, refresh, support, type Perch, type PerchOptions } from '../src/pet/perches.ts';
import { landing } from '../src/pet/physics.ts';
import { stubGlobals } from './helpers/stubs.ts';

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height });
const empty = () => rect(0, 0, 0, 0);

class TestNode {
  nodeType = 1;
  parentNode: TestNode | TestDocument | null = null;
  nextSibling: TestNode | null = null;
  childNodes: TestNode[] = [];
  textContent = '';
  get parentElement(): TestElement | null { return this.parentNode instanceof TestElement ? this.parentNode : null; }
  get firstChild(): TestNode | null { return this.childNodes[0] ?? null; }
  append(...nodes: TestNode[]) {
    for (const node of nodes) {
      const last = this.childNodes.at(-1);
      if (last) last.nextSibling = node;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  getRootNode(): TestNode | TestDocument {
    return this.parentNode ? this.parentNode instanceof TestDocument ? this.parentNode : this.parentNode.getRootNode() : this;
  }
}

class TestText extends TestNode {
  override nodeType = 3;
  rectangles: Rect[];
  constructor(text: string, rectangles: Rect[]) { super(); this.textContent = text; this.rectangles = rectangles; }
}

class TestShadow extends TestNode {
  override nodeType = 11;
  activeElement: TestElement | null = null;
  readonly host: TestElement;
  constructor(host: TestElement) { super(); this.host = host; }
  elementsFromPoint(x: number, y: number): TestElement[] { return hits(this, x, y); }
}

class TestElement extends TestNode {
  attributes = new Map<string, string>();
  shadowRoot: TestShadow | null = null;
  disabled = false;
  type = 'text';
  style: Record<string, string> = {
    visibility: 'visible', opacity: '1', display: 'block', contentVisibility: 'visible',
    backgroundImage: 'none', boxShadow: 'none', borderTopWidth: '0', borderTopStyle: 'none', borderTopColor: 'transparent',
    backgroundColor: 'transparent', overflowX: 'visible', overflowY: 'visible', contain: 'none',
  };
  readonly tagName: string;
  bounds: Rect;
  constructor(tagName: string, bounds: Rect) { super(); this.tagName = tagName; this.bounds = bounds; }
  get isConnected(): boolean {
    const root = this.getRootNode();
    return root instanceof TestDocument || (root instanceof TestShadow && root.host.isConnected);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getBoundingClientRect(): Rect { fixture.geometryReads++; return this.bounds; }
  contains(node: TestElement): boolean {
    let current: TestNode | TestDocument | null = node;
    while (current instanceof TestNode) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  matches(selector: string): boolean {
    // Exercise root-relative focus resolution independently of :focus-within.
    if (selector === ':focus-within') return false;
    if (selector === ':disabled') {
      let current: TestElement | null = this;
      while (current) {
        if (current.disabled) return true;
        current = current.parentElement;
      }
      return false;
    }
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || (this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false');
    if (selector.startsWith('input,')) return editable;
    return editable || ['BUTTON', 'LABEL', 'SUMMARY', 'VIDEO', 'AUDIO', 'IFRAME'].includes(this.tagName)
      || (this.tagName === 'A' && this.attributes.has('href')) || this.attributes.has('role') || this.attributes.has('tabindex');
  }
}

function children(root: TestNode): TestElement[] {
  const result: TestElement[] = [];
  for (const child of root.childNodes) {
    if (!(child instanceof TestElement) || child.style.display === 'none') continue;
    result.push(child, ...children(child));
  }
  return result;
}

function hits(root: TestNode, x: number, y: number): TestElement[] {
  return children(root).filter((el) => el.style.visibility === 'visible' && x >= el.bounds.left && x < el.bounds.right && y >= el.bounds.top && y < el.bounds.bottom).reverse();
}

class TestDocument {
  documentElement = new TestElement('HTML', rect(0, 0, 800, 700));
  body = new TestElement('BODY', rect(0, 0, 800, 700));
  activeElement: TestElement | null = this.body;
  constructor() { this.documentElement.parentNode = this; this.documentElement.append(this.body); }
  elementsFromPoint(x: number, y: number): TestElement[] { fixture.hitTests++; return hits(this.documentElement, x, y); }
  createRange() {
    fixture.ranges++;
    let text: TestText;
    return {
      selectNodeContents(node: TestText) { fixture.measured++; text = node; },
      getBoundingClientRect() {
        if (!text.rectangles.length) return empty();
        const left = Math.min(...text.rectangles.map((r) => r.left));
        const right = Math.max(...text.rectangles.map((r) => r.right));
        const top = Math.min(...text.rectangles.map((r) => r.top));
        const bottom = Math.max(...text.rectangles.map((r) => r.bottom));
        return rect(left, top, right - left, bottom - top);
      },
      getClientRects() { return text.rectangles; },
    };
  }
}

interface Fixture {
  document: TestDocument;
  host: TestElement;
  opts: PerchOptions;
  now: number;
  ranges: number;
  measured: number;
  geometryReads: number;
  styleReads: number;
  styled: Set<TestElement>;
  hitTests: number;
}
let fixture: Fixture;
let restore = () => {};
function element(tag: string, bounds: Rect, parent = fixture.document.body): TestElement {
  const el = new TestElement(tag.toUpperCase(), bounds);
  parent.append(el);
  return el;
}
function perch(bounds = rect(0, 400, 400, 40), parent = fixture.document.body): TestElement {
  const el = element('div', bounds, parent);
  el.setAttribute('data-peetty', 'perch');
  return el;
}
function text(parent: TestElement, bounds: Rect, value = 'Content'): TestText {
  const node = new TestText(value, [bounds]);
  parent.append(node);
  return node;
}
function asElement(el: TestElement): Element { return el as unknown as Element; }
function resize(width: number, height = 700) { Object.assign(globalThis, { innerWidth: width, innerHeight: height }); }
/** Where a perch puts her. */
function where(p: Perch | null) { return p && { el: p.el, left: p.left, right: p.right, y: p.y, clear: p.clear }; }

beforeEach(() => {
  const document = new TestDocument();
  const host = new TestElement('PEETTY-COMPANION', rect(0, 0, 800, 700));
  document.body.append(host);
  fixture = {
    document, host, opts: { host: asElement(host), width: 100, height: 120 }, now: 1000,
    ranges: 0, measured: 0, geometryReads: 0, styleReads: 0, styled: new Set(), hitTests: 0,
  };
  restore = stubGlobals({
    document,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    innerWidth: 800,
    innerHeight: 700,
    performance: { now: () => fixture.now },
    getComputedStyle: (el: TestElement) => { fixture.styleReads++; fixture.styled.add(el); return el.style; },
  });
});

afterEach(() => restore());

describe('whole-footprint perch clearance', () => {
  it('erodes a free point span before treating it as an anchor interval', () => {
    const edge = perch();
    const content = element('div', rect(0, 340, 100, 20));
    text(content, content.bounds);
    const found = perchOf(asElement(edge), fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 150, `left ${found.left} must clear text ending at 100 plus half-width`);
    assert.ok(found.right <= 750);
    assert.ok(found.left - 50 > 100);
  });

  it('finds a thin control between the old three sampled rows', () => {
    const edge = perch();
    const button = element('button', rect(170, 320, 60, 14));
    const found = perchOf(asElement(edge), fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 280 || found.right < 120);
    assert.equal(perchOf(asElement(button), fixture.opts), null, 'the narrow button cannot intercept the fall as a perch');
  });

  it('uses asymmetric horizontal extents and the footprint below the anchor', () => {
    const edge = perch(rect(200, 400, 400, 40));
    element('button', rect(250, 405, 20, 10));
    const opts: PerchOptions = { ...fixture.opts, anchor: [20, 110] };
    const found = perchOf(asElement(edge), opts);
    assert.ok(found);
    assert.ok(found.left >= 293, `left ${found.left} includes the 20px left extent`);
    const ground = floor(opts);
    assert.ok(ground);
    assert.equal(ground.y, 690);
    assert.ok(ground.left >= 20 && ground.right <= 720);
  });

  it('does not ignore text belonging to the supporting element', () => {
    const edge = perch();
    text(edge, rect(0, 320, 400, 14));
    assert.equal(perchOf(asElement(edge), fixture.opts), null);
  });

  it('permits the intended supporting control without covering content above it', () => {
    const field = element('input', rect(100, 400, 240, 30));
    assert.ok(perchOf(asElement(field), fixture.opts));
  });

  it('constrains every anchor to the viewport even when a support extends offscreen', () => {
    const edge = perch(rect(700, 400, 300, 40));
    const found = perchOf(asElement(edge), fixture.opts);
    assert.ok(found);
    assert.ok(found.left >= 50 && found.right <= 750);
    edge.bounds = rect(780, 400, 200, 40);
    assert.equal(refresh(found, fixture.opts), null);
  });

  it('finds obstacles inside open shadow trees', () => {
    const edge = perch();
    const host = element('section', rect(100, 300, 200, 50));
    host.shadowRoot = new TestShadow(host);
    host.shadowRoot.append(new TestElement('BUTTON', rect(170, 320, 60, 14)));
    const found = perchOf(asElement(edge), fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 280 || found.right < 120);
  });
});

describe('safe viewport floor', () => {
  it('returns null rather than forcing a floor over a footer control', () => {
    element('button', rect(0, 650, 800, 50));
    assert.equal(floor(fixture.opts), null);
    assert.ok(findPerches(fixture.opts).every((p) => p.el !== null));
  });

  it('honors avoid regions on the floor and excludes their supporting edges', () => {
    const avoid = perch(rect(0, 640, 800, 60));
    avoid.setAttribute('data-peetty', 'avoid');
    assert.deepEqual(findPerches(fixture.opts), []);
    assert.equal(floor(fixture.opts), null);
  });

  it('keeps the floor available beside a partial avoid region', () => {
    const avoid = element('section', rect(0, 640, 250, 60));
    avoid.setAttribute('data-peetty', 'avoid');
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 300 && found.right <= 750);
  });

  it('does not invent a safe surface when an avoid area covers the viewport', () => {
    const avoid = element('section', rect(0, 0, 800, 700));
    avoid.setAttribute('data-peetty', 'avoid');
    assert.deepEqual(findPerches(fixture.opts), []);
  });
});

describe('the viewport bottom', () => {
  const catchAll = { el: null, left: 50, right: 750, y: 700, input: false, preferred: false, clear: false, offset: [50, 750] };

  it('limits her anchor to positions that keep the whole figure on screen', () => {
    assert.deepEqual(limits(fixture.opts), { left: 50, right: 750, top: 120, bottom: 700 });
    assert.deepEqual(limits({ ...fixture.opts, anchor: [20, 110] }), { left: 20, right: 720, top: 110, bottom: 690 });
    assert.equal(limits({ ...fixture.opts, width: 801 }), null);
    assert.equal(limits({ ...fixture.opts, height: 701 }), null);
  });

  it('always catches her while she fits on screen, clear of page content or not', () => {
    element('button', rect(0, 650, 800, 50));
    assert.equal(floor(fixture.opts), null);
    assert.deepEqual(bottom(fixture.opts, 300), catchAll);
    for (let i = 0; i < 6100; i++) element('div', empty());
    fixture.now += 300;
    assert.deepEqual(bottom(fixture.opts, 300), catchAll, 'an incomplete scan still leaves the catch-all');
    resize(90);
    assert.equal(bottom(fixture.opts, 45), null, 'null only when limits() is');
  });

  it('is the clear floor wherever she is on it', () => {
    const avoid = element('section', rect(0, 640, 250, 60));
    avoid.setAttribute('data-peetty', 'avoid');
    assert.deepEqual(bottom(fixture.opts, 400), floor(fixture.opts));
    assert.equal(bottom(fixture.opts, 400)?.clear, true);
    assert.deepEqual(bottom(fixture.opts, 100), catchAll);
  });
});

describe('support', () => {
  it('is the cheap refresh between rechecks, whatever x is', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    edge.bounds = rect(150, 380, 400, 40);
    const before = fixture.hitTests;
    assert.deepEqual(support(found, 10_000, fixture.opts), refresh(found, fixture.opts));
    assert.equal(fixture.hitTests, before);
    edge.style.visibility = 'hidden';
    assert.equal(support(found, 300, fixture.opts), null);
  });

  it('rechecks clearance and the edge under her feet in one pass', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    // A menu covers the edge left of x = 220, but not the middle of its span.
    element('div', rect(100, 400, 120, 40));
    fixture.now += 300;
    const before = fixture.hitTests;
    assert.deepEqual(where(support(found, 300, fixture.opts, true)), where(found));
    assert.equal(fixture.hitTests - before, 2, 'one hit test for the span, one under her feet');
    assert.equal(support(found, 150, fixture.opts, true), null, 'covered under her feet');
    assert.equal(support(found, 60, fixture.opts, true), null, 'off the span');
  });

  it('keeps the catch-all holding her and moves her between it and clear floor on recheck', () => {
    const avoid = element('section', rect(0, 640, 250, 60));
    avoid.setAttribute('data-peetty', 'avoid');
    const held = bottom(fixture.opts, 100)!;
    assert.equal(held.clear, false);
    assert.deepEqual(support(held, 100, fixture.opts), held);
    assert.deepEqual(support(held, 100, fixture.opts, true), held, 'still over the avoid area');
    const ground = support(held, 400, fixture.opts, true);
    assert.ok(ground);
    assert.equal(ground.clear, true, 'standing on clear floor, she settles onto it');
    assert.deepEqual(support(ground, 100, fixture.opts), ground, 'between rechecks x is unused');
    assert.equal(support(ground, 100, fixture.opts, true), null, 'off clear floor she drops');
    assert.deepEqual(bottom(fixture.opts, 100), held, 'and the catch-all catches her');
    avoid.attributes.delete('data-peetty');
    fixture.now += 300;
    const cleared = support(held, 100, fixture.opts, true);
    assert.equal(cleared?.clear, true, 'the bottom under her became clear');
    assert.deepEqual(cleared, floor(fixture.opts));
  });

  it('re-fits the catch-all to the viewport between rechecks', () => {
    element('button', rect(0, 650, 800, 50));
    const held = bottom(fixture.opts, 300)!;
    resize(600, 500);
    assert.equal(refresh(held, fixture.opts), null, 'refresh() leaves resizes to rechecks, as for the floor');
    assert.deepEqual(support(held, 300, fixture.opts), { el: null, left: 50, right: 550, y: 500, input: false, preferred: false, clear: false, offset: [50, 550] });
    resize(90, 500);
    assert.equal(support(held, 45, fixture.opts), null, 'nowhere to hold her once she no longer fits');
  });
});

describe('crossing', () => {
  it('lands where landing() over every refreshed perch would, including ties and the viewport bottom', () => {
    const high = perch(rect(100, 300, 300, 30));
    perch(rect(100, 450, 400, 30));
    const tie = perch(rect(400, 450, 400, 30));
    perch(rect(0, 550, 800, 30));
    // The clear floor and the catch-all tie at the viewport bottom.
    const perches = [...findPerches(fixture.opts), bottom(fixture.opts, 10)!];
    assert.equal(perches.length, 6);
    const check = () => {
      for (const list of [perches, [...perches].reverse()]) {
        for (const x of [60, 200, 450, 700, 760]) {
          for (const [fromY, toY] of [[0, 299], [0, 300], [300, 460], [449, 451], [450, 600], [560, 700], [0, 700]] as const) {
            const refreshed = list.map((p) => refresh(p, fixture.opts)).filter((p): p is Perch => !!p);
            const expected = landing(refreshed, x, fromY, toY) as Perch | null;
            assert.deepEqual(where(crossing(list, x, fromY, toY, fixture.opts)), where(expected), `x ${x} from ${fromY} to ${toY}`);
          }
        }
      }
    };
    check();
    // Moved and hidden perches: the live geometry selects, refresh() decides.
    high.bounds = rect(150, 280, 300, 30);
    tie.style.visibility = 'hidden';
    check();
  });

  it('refreshes only crossed perches, highest first, until one holds her', () => {
    const high = perch(rect(100, 300, 300, 30));
    const middle = perch(rect(100, 350, 300, 30));
    const beside = perch(rect(450, 320, 300, 30));
    const low = perch(rect(0, 550, 800, 30));
    const perches = findPerches(fixture.opts);
    assert.equal(perches.length, 5);
    fixture.styled.clear();
    const before = fixture.geometryReads;
    assert.equal(crossing(perches, 200, 290, 400, fixture.opts)?.el, asElement(high));
    assert.equal(fixture.geometryReads - before, 5, 'one read per element perch, plus her landing refresh');
    assert.ok(fixture.styled.has(high));
    for (const el of [middle, beside, low]) assert.ok(!fixture.styled.has(el), 'not refreshed');
    high.style.visibility = 'hidden';
    fixture.styled.clear();
    assert.equal(crossing(perches, 200, 290, 400, fixture.opts)?.el, asElement(middle));
    for (const el of [beside, low]) assert.ok(!fixture.styled.has(el), 'not refreshed');
  });
});

describe('live eligibility and geometry', () => {
  it('rejects a support hidden by effective ancestor opacity', () => {
    const parent = element('section', rect(0, 200, 500, 300));
    const edge = perch(undefined, parent);
    const found = perchOf(asElement(edge), fixture.opts)!;
    assert.ok(found);
    parent.style.opacity = '0.1';
    assert.equal(refresh(found, fixture.opts), null);
  });

  it('rejects hidden, removed, avoided and disabled supports without scanning text', () => {
    const field = element('input', rect(100, 400, 240, 30));
    const found = perchOf(asElement(field), fixture.opts)!;
    assert.ok(found);
    field.style.visibility = 'hidden';
    assert.equal(refresh(found, fixture.opts), null);
    field.style.visibility = 'visible';
    field.setAttribute('data-peetty', 'avoid');
    assert.equal(refresh(found, fixture.opts), null);
    field.attributes.delete('data-peetty');
    field.disabled = true;
    assert.equal(refresh(found, fixture.opts), null);
    field.disabled = false;
    fixture.document.activeElement = field;
    assert.equal(refresh(found, fixture.opts), null);
    fixture.document.activeElement = fixture.document.body;
    field.parentNode = null;
    assert.equal(refresh(found, fixture.opts), null);
  });

  it('requires new clearance for resized spans and rechecks within the resized support', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    assert.ok(found);
    edge.bounds = rect(100, 400, 80, 40);
    assert.equal(refresh(found, fixture.opts), null);
    fixture.now += 300;
    const resized = refresh(found, fixture.opts, true);
    assert.ok(resized);
    assert.ok(resized.left >= 106 && resized.right <= 174);
  });

  it('follows translated supports and clamps their anchors to the viewport', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    edge.bounds = rect(700, 400, 400, 40);
    const translated = refresh(found, fixture.opts);
    assert.ok(translated);
    assert.ok(translated.left >= 706 && translated.right <= 750);
  });

  it('rejects a changed figure footprint until it is fully rechecked', () => {
    const edge = perch();
    const found = perchOf(asElement(edge), fixture.opts)!;
    const opts = { ...fixture.opts, width: 200 };
    assert.equal(refresh(found, opts), null);
    assert.ok(refresh(found, opts, true));
  });

  it('detects a newly occupied footprint on the recheck cadence', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    element('button', rect(250, 320, 100, 14));
    fixture.now += 300;
    assert.equal(support(found, 300, fixture.opts, true), null);
  });

  it('detects an overlay covering the supporting edge', () => {
    const edge = perch(rect(100, 400, 400, 40));
    const found = perchOf(asElement(edge), fixture.opts)!;
    element('div', rect(100, 400, 400, 40));
    fixture.now += 300;
    assert.equal(refresh(found, fixture.opts, true), null);
  });

  it('resolves focused inputs and contenteditable elements in their own shadow root', () => {
    const host = element('section', rect(0, 0, 400, 500));
    const root = new TestShadow(host);
    host.shadowRoot = root;
    const field = new TestElement('INPUT', rect(100, 400, 240, 30));
    const editable = new TestElement('DIV', rect(100, 300, 240, 30));
    editable.setAttribute('contenteditable', 'true');
    root.append(field, editable);
    fixture.document.activeElement = host;
    root.activeElement = field;
    assert.equal(inUse(asElement(field)), true);
    assert.equal(inUse(asElement(host)), true);
    assert.equal(perchOf(asElement(field), fixture.opts), null);
    root.activeElement = editable;
    assert.equal(inUse(asElement(editable)), true);
    assert.equal(inUse(asElement(field)), false);
  });
});

describe('bounded discovery and shared rechecks', () => {
  it('rejects an incomplete traversal instead of accepting an unchecked floor', () => {
    for (let i = 0; i < 6100; i++) element('div', empty());
    assert.deepEqual(findPerches(fixture.opts), []);
    assert.equal(floor(fixture.opts), null);
    assert.ok(fixture.styleReads <= 6000);
  });

  it('prunes paint-contained offscreen bulk without exhausting the scan', () => {
    const offscreen = element('section', rect(0, 1200, 800, 200));
    offscreen.style.contain = 'paint';
    for (let i = 0; i < 6100; i++) text(offscreen, rect(0, 1200 + i * 10, 100, 10));
    assert.ok(floor(fixture.opts));
    assert.ok(fixture.styleReads < 10);
    assert.equal(fixture.ranges, 0);
  });

  it('does not prune an offscreen parent whose visible overflow reaches the floor', () => {
    const offscreen = element('section', rect(0, 1200, 800, 200));
    element('button', rect(0, 650, 800, 50), offscreen);
    assert.equal(floor(fixture.opts), null);
  });

  it('keeps fixed descendants that escape an ordinary offscreen overflow clip', () => {
    const offscreen = element('section', rect(0, 1200, 800, 200));
    offscreen.style.overflowX = 'hidden';
    offscreen.style.overflowY = 'hidden';
    const fixed = element('button', rect(0, 650, 800, 50), offscreen);
    fixed.style.position = 'fixed';
    assert.equal(floor(fixture.opts), null);
  });

  it('shares text measurement across candidates, floor and rechecks', () => {
    const edge = perch();
    const content = element('p', rect(600, 10, 100, 14));
    text(content, content.bounds);
    const found = findPerches(fixture.opts).find((p) => p.el === asElement(edge));
    assert.ok(found);
    assert.equal(fixture.ranges, 1);
    assert.ok(floor(fixture.opts));
    assert.ok(refresh(found, fixture.opts, true));
    assert.equal(fixture.ranges, 1);
    for (let i = 0; i < 100; i++) assert.ok(refresh(found, fixture.opts));
    assert.equal(fixture.ranges, 1, 'ordinary RAF refreshes do not measure page text');
    fixture.now += 300;
    assert.ok(refresh(found, fixture.opts, true));
    assert.equal(fixture.ranges, 2);
  });

  it('gives every lookup on a cached scan its own work budget', () => {
    const edge = perch();
    // Blocked candidates, each checked against every obstacle: discovery spends its whole budget.
    for (let i = 0; i < 150; i++) element('div', rect(420, 300, 300, 20)).style.backgroundColor = 'rgb(200, 200, 200)';
    for (let i = 0; i < 200; i++) element('button', rect(380 + i * 2, 200, 1, 1));
    const found = findPerches(fixture.opts).find((p) => p.el === asElement(edge));
    assert.ok(found, 'the preferred edge is evaluated first');
    // Still within the scan's cache lifetime.
    assert.ok(refresh(found, fixture.opts, true), 'a recheck has budget of its own');
    assert.ok(support(found, 200, fixture.opts, true), 'so has the recheck under her feet');
    const next = findPerches(fixture.opts);
    assert.ok(next.some((p) => p.el === asElement(edge)), 'and the next discovery');
  });

  it('measures every text node of a scan with one range', () => {
    for (let i = 0; i < 5; i++) {
      const content = element('p', rect(0, 10 + i * 20, 100, 14));
      text(content, content.bounds);
    }
    assert.ok(floor(fixture.opts));
    assert.equal(fixture.measured, 5);
    assert.equal(fixture.ranges, 1);
  });

  it('rejects excessive text or obstacle geometry conservatively', () => {
    const content = element('p', rect(0, 0, 800, 700));
    text(content, content.bounds, 'x'.repeat(20_000));
    assert.equal(floor(fixture.opts), null);
  });

  it('bounds obstacle collection even when thousands of tiny controls are visible', () => {
    for (let i = 0; i < 2100; i++) element('button', rect(i % 800, 20, 1, 1));
    assert.equal(floor(fixture.opts), null);
    assert.ok(fixture.styleReads < 2100);
  });

  it('does not scale hit testing with the width of a candidate edge', () => {
    Object.defineProperty(globalThis, 'innerWidth', { value: 1_000_000, configurable: true, writable: true });
    const edge = perch(rect(0, 400, 1_000_000, 40));
    assert.ok(perchOf(asElement(edge), fixture.opts));
    assert.ok(fixture.hitTests <= 2);
  });
});
