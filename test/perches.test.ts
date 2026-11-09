import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { bottom, clearAt, crossing, findPerches, floor, inUse, limits, perchOf, reach, refresh, support, type Perch, type PerchOptions } from '../src/pet/perches.ts';
import { landing } from '../src/pet/physics.ts';
import { LIMITS } from '../src/figure/validate.ts';
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
    // Selectors match whatever the case of the tag name, as in XHTML documents.
    const tag = this.tagName.toUpperCase();
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false');
    if (selector.startsWith('input,')) return editable;
    return editable || ['BUTTON', 'LABEL', 'SUMMARY', 'VIDEO', 'AUDIO', 'IFRAME'].includes(tag)
      || (tag === 'A' && this.attributes.has('href')) || this.attributes.has('role') || this.attributes.has('tabindex');
  }
  closest(selector: string): TestElement | null {
    for (let current: TestElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  /** Where hit tests find the element when it differs from its box, like a stretched link's ::after. */
  hitArea: Rect | null = null;
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
  return children(root).filter((el) => {
    const area = el.hitArea ?? el.bounds;
    return el.style.visibility === 'visible' && x >= area.left && x < area.right && y >= area.top && y < area.bottom;
  }).reverse();
}

class TestDocument {
  readonly nodeType = 9;
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

  it('accepts a component host whose open shadow root paints its top edge', () => {
    const card = perch(rect(0, 400, 400, 40));
    card.shadowRoot = new TestShadow(card);
    card.shadowRoot.append(new TestElement('DIV', rect(0, 400, 400, 40)));
    const found = perchOf(asElement(card), fixture.opts);
    assert.ok(found, 'the hit test finds its shadow content, which belongs to the host');
    assert.ok(support(found, 200, fixture.opts, true));
  });

  it('stops walking up at the document, whatever a page names "host"', () => {
    const edge = perch(rect(0, 400, 400, 40));
    // <form name="host"> makes document.host that form; two such forms make it a collection.
    const form = element('form', rect(0, 0, 800, 100));
    for (const host of [form, { length: 2 }]) {
      Object.assign(fixture.document, { host });
      fixture.now += 300;
      assert.ok(perchOf(asElement(edge), fixture.opts), 'the walk ends at the document instead of looping or throwing');
    }
    // A menu over the edge does not become part of it through a form named "host" inside the edge.
    Object.assign(fixture.document, { host: element('form', rect(0, 420, 100, 10), edge) });
    element('div', rect(0, 395, 800, 20));
    fixture.now += 300;
    assert.equal(perchOf(asElement(edge), fixture.opts), null);
  });

  it('keeps clear of a stretched link whose click area covers the card above a lower edge', () => {
    const card = element('article', rect(100, 200, 400, 300));
    card.style.backgroundColor = 'rgb(255, 255, 255)';
    const footer = perch(rect(100, 420, 400, 80), card);
    const link = element('a', rect(120, 460, 80, 16), footer);
    link.setAttribute('href', '#');
    // .stretched-link::after { position: absolute; inset: 0 } against the card.
    link.hitArea = card.bounds;
    assert.equal(perchOf(asElement(footer), fixture.opts), null, 'she would cover the card where it is a link');
    assert.ok(perchOf(asElement(card), fixture.opts), 'on the card itself she stands above the link');
    // A click area that covers only the upper part of her, ending well above her feet.
    link.hitArea = rect(100, 200, 400, 150);
    fixture.now += 300;
    assert.equal(perchOf(asElement(footer), fixture.opts), null, 'her head would cover it');
    link.hitArea = rect(100, 200, 400, 60);
    fixture.now += 300;
    assert.ok(perchOf(asElement(footer), fixture.opts), 'above her head it is out of her way');
  });

  it('finds click areas across her footprint and along a walk, not only in her middle column', () => {
    const edge = perch(rect(0, 400, 800, 40));
    // A button whose ::after reaches over the right end of the edge, far beyond its own box.
    const button = element('button', rect(700, 200, 40, 14));
    button.hitArea = rect(560, 300, 240, 100);
    const found = perchOf(asElement(edge), fixture.opts)!;
    assert.ok(found, 'the middle of the edge is clear');
    assert.ok(clearAt(found, 200, fixture.opts));
    assert.equal(clearAt(found, 650, fixture.opts), false, 'under it');
    assert.equal(clearAt(found, 530, fixture.opts), false, 'under her right side only');
    fixture.now += 300;
    assert.equal(support(found, 530, fixture.opts, true), null, 'a recheck looks across her too');
    const end = reach(found, 200, 750, fixture.opts);
    assert.ok(end > 400 && end + 50 <= 560, `walking right she stops at ${end}, short of it`);
    assert.equal(reach(found, 450, 100, fixture.opts), 100, 'walking away she goes all the way');
    assert.equal(reach(found, 500, 750, fixture.opts), 500, 'right beside it she does not step closer');
  });

  it('checks every column of a wide footprint, each hit test with a budget of its own', () => {
    // A figure so wide that one shared budget would run out before her far side was checked.
    const opts: PerchOptions = { ...fixture.opts, width: 760 };
    const edge = perch(rect(0, 400, 800, 40));
    const button = element('button', rect(700, 200, 40, 14));
    button.hitArea = rect(760, 300, 40, 100);
    const found = perchOf(asElement(edge), opts)!;
    assert.ok(found, 'the middle of the edge is clear');
    assert.equal(clearAt(found, 400, opts), false, 'her far right side would cover it');
    fixture.now += 300;
    assert.equal(support(found, 400, opts, true), null);
  });

  it('keeps the box of an element whose contents are hidden, but not its contents', () => {
    const area = element('section', rect(0, 600, 800, 100));
    area.setAttribute('data-peetty', 'avoid');
    area.style.contentVisibility = 'hidden';
    assert.equal(floor(fixture.opts), null, 'the avoid area itself still blocks the floor');
    const card = perch(rect(0, 300, 400, 40));
    card.style.contentVisibility = 'hidden';
    element('button', rect(100, 250, 60, 20), card);
    fixture.now += 300;
    assert.ok(perchOf(asElement(card), fixture.opts), 'its own edge still carries her, and its skipped button does not block it');
  });

  it('filters input types whatever the case of the tag name, as in XHTML', () => {
    const field = (type: string, bounds: Rect) => {
      const el = new TestElement('input', bounds);
      el.type = type;
      fixture.document.body.append(el);
      return el;
    };
    const password = field('password', rect(0, 300, 300, 40));
    const file = field('file', rect(400, 300, 300, 40));
    const plain = field('text', rect(0, 600, 300, 40));
    assert.equal(perchOf(asElement(password), fixture.opts), null);
    assert.equal(perchOf(asElement(file), fixture.opts), null);
    assert.ok(perchOf(asElement(plain), fixture.opts), 'a text field still carries her');
  });

  it('stands on a linked or responsive image whose wrapper shares its box', () => {
    const link = element('a', rect(0, 400, 300, 120));
    link.setAttribute('href', '#');
    const linked = element('img', rect(0, 400, 300, 120), link);
    const picture = element('picture', rect(400, 300, 300, 120));
    const responsive = element('img', rect(400, 300, 300, 120), picture);
    for (const el of [linked, picture, responsive]) assert.ok(perchOf(asElement(el), fixture.opts), el.tagName);
    // A control beside the image, not part of it, still blocks the span next to it.
    element('button', rect(0, 395, 60, 10));
    fixture.now += 300;
    const found = perchOf(asElement(linked), fixture.opts);
    assert.ok(found && found.left > 60, `left ${found?.left}`);
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

describe('bounded companion graphics', () => {
  function figure(bounds: Rect, shape = { x: 0, y: 0, width: bounds.width, height: bounds.height }, flip = false) {
    // The real host is pointer-transparent outside its painted figure.
    const host = element('peetty-companion', empty());
    const shadow = new TestShadow(host); host.shadowRoot = shadow;
    const pet = new TestElement('DIV', bounds); pet.setAttribute('data-peetty', 'avoid'); shadow.append(pet);
    const svg = element('svg', bounds, pet);
    Object.assign(svg, {
      getBBox: () => shape,
      getScreenCTM: () => ({ a: flip ? -1 : 1, b: 0, c: 0, d: 1, e: flip ? bounds.right : bounds.left, f: bounds.top }),
    });
    return { svg, pet };
  }

  function part(svg: TestElement, bounds: Rect, id = 'body') {
    // RigRenderer: per-bone part -> optional clip group -> look/spring group -> shapes.
    const outer = element('g', bounds, svg); outer.setAttribute('data-part', id);
    const clipped = element('g', bounds, outer); clipped.setAttribute('clip-path', 'url(#clip)');
    return element('g', bounds, clipped);
  }

  it('keeps clear space usable beside several figures with thousands of visible parts', () => {
    for (let n = 0; n < 3; n++) {
      const { svg } = figure(rect(n * 130, 580, 100, 120));
      for (let i = 0; i < 2500; i++) element('path', svg.bounds, svg);
    }
    const found = floor(fixture.opts);
    assert.ok(found, 'one graphic must not exhaust the shared rectangle or traversal budget');
    assert.ok(found.left > 410 && found.right <= 750);
    assert.ok(fixture.styleReads < 50, `bounded style reads: ${fixture.styleReads}`);
    assert.ok(fixture.geometryReads < 50, `bounded geometry reads: ${fixture.geometryReads}`);
  });

  it('includes overflow-visible SVG geometry outside the declared viewport', () => {
    const { svg } = figure(rect(0, 580, 100, 120), { x: 0, y: 0, width: 230, height: 120 });
    element('path', rect(0, 580, 230, 120), svg);
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 280, `painted geometry extends the blocked span: ${found.left}`);
  });

  it('transforms the whole geometry when the figure is mirrored', () => {
    const { svg } = figure(rect(500, 580, 100, 120), { x: 0, y: 0, width: 200, height: 120 }, true);
    element('path', rect(400, 580, 200, 120), svg);
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.right < 350, `mirrored overflow stays blocked: ${found.right}`);
  });

  it('does not fill the gap to disconnected offscreen geometry', () => {
    const body = rect(650, 580, 100, 120);
    const { svg } = figure(body, { x: -10_650, y: 0, width: 10_750, height: 120 });
    const main = part(svg, body);
    for (let i = 0; i < 2500; i++) element('path', body, main);
    const distant = part(svg, rect(-10_000, 600, 10, 10), 'distant');
    for (let i = 0; i < 2500; i++) element('ellipse', distant.bounds, distant);
    const found = floor(fixture.opts);
    assert.ok(found, 'the space between the offscreen part and the body remains clear');
    assert.equal(found.left, 50);
    assert.ok(found.right > 590 && found.right < 600, `only the body blocks the floor: ${found.right}`);
    assert.ok(fixture.geometryReads < 30, `covered/offscreen groups are pruned: ${fixture.geometryReads}`);
    assert.ok(fixture.styleReads < 30, `covered/offscreen groups need no descendant styles: ${fixture.styleReads}`);
  });

  it('prunes a part whose two offscreen ellipses bracket the whole viewport', () => {
    // The native-browser repro: both ellipses paint below the page, at x = +/-2000,
    // but unioning their part with the SVG viewport would block every floor anchor.
    const body = rect(650, 580, 100, 120);
    const { svg } = figure(body, { x: -2005, y: 0, width: 4010, height: 2005 });
    element('path', body, part(svg, body));
    const distant = part(svg, rect(-1355, 2575, 4010, 10), 'head');
    element('ellipse', rect(-1355, 2575, 10, 10), distant);
    element('ellipse', rect(2645, 2575, 10, 10), distant);
    const found = floor(fixture.opts);
    assert.ok(found, 'the disconnected part cannot park another companion');
    assert.equal(found.left, 50);
    assert.ok(found.right > 590 && found.right < 600);
    assert.ok(fixture.geometryReads < 20, 'the offscreen part can be pruned without reading its shapes');
  });

  for (const flip of [false, true]) {
    it(`preserves an onscreen gap between distant shapes within one ${flip ? 'mirrored ' : ''}grouped part`, () => {
      const body = rect(flip ? 50 : 650, 580, 100, 120);
      const island = rect(flip ? 630 : 150, 610, 20, 40);
      const { svg } = figure(body, { x: -500, y: 0, width: 600, height: 120 }, flip);
      const group = part(svg, rect(Math.min(body.left, island.left), 580, 600, 120));
      // Native screen rectangles already include the nested look/spring/shape transforms.
      group.setAttribute('transform', 'translate(20 0) rotate(15 0 0)');
      element('path', body, group);
      const shape = element('ellipse', island, group);
      shape.setAttribute('transform', 'rotate(30 0 0)');
      const found = floor(fixture.opts);
      assert.ok(found);
      if (flip) {
        assert.ok(found.left > 200 && found.left < 210, `the mirrored body remains protected: ${found.left}`);
        assert.ok(found.right > 570 && found.right < 580, `the mirrored island remains protected: ${found.right}`);
      } else {
        assert.ok(found.left > 220 && found.left < 230, `the island remains protected: ${found.left}`);
        assert.ok(found.right > 590 && found.right < 600, `the body remains protected: ${found.right}`);
      }
      assert.ok(found.right - found.left > 360, 'part/group unions must not block the gap');
    });
  }

  it('protects the soul effect while ignoring nonpainting defs', () => {
    const { svg } = figure(rect(650, 580, 100, 120), { x: -500, y: -40, width: 600, height: 160 });
    const defs = element('defs', rect(0, 0, 800, 700), svg);
    const clip = element('clipPath', defs.bounds, defs);
    for (let i = 0; i < 2500; i++) element('path', defs.bounds, clip);
    element('path', svg.bounds, part(svg, svg.bounds));
    const soul = element('g', rect(150, 540, 20, 80), svg); soul.setAttribute('data-effect', 'soul');
    element('path', soul.bounds, soul);
    const face = element('g', rect(153, 550, 14, 12), soul);
    for (let i = 0; i < 3; i++) element('ellipse', face.bounds, face);
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 220 && found.left < 230, `the soul outside the viewport stays protected: ${found.left}`);
    assert.ok(found.right > 590 && found.right < 600);
    assert.ok(fixture.geometryReads < 30, `defs and covered soul details are pruned: ${fixture.geometryReads}`);
  });

  it('handles maximum-size parts with repeated disconnected shapes without consuming the rectangle budget', () => {
    const body = rect(650, 580, 100, 120);
    const island = rect(150, 610, 20, 40);
    const { svg } = figure(body, { x: -500, y: 0, width: 600, height: 120 });
    for (let i = 0; i < LIMITS.maxParts; i++) {
      const group = part(svg, rect(150, 580, 600, 120), `part${i}`);
      for (let j = 0; j < LIMITS.maxShapesPerPart; j++) element(j % 2 ? 'path' : 'ellipse', j % 2 ? body : island, group);
    }
    const found = floor(fixture.opts);
    assert.ok(found, '200 parts x 64 mixed shapes fit within the shared collection budget');
    assert.ok(found.left > 220 && found.left < 230);
    assert.ok(found.right > 590 && found.right < 600);
    assert.ok(fixture.styleReads < 650, `styles are needed only for overflowing groups: ${fixture.styleReads}`);
    assert.ok(fixture.geometryReads < 13_450, `one native screen read per visited group/shape: ${fixture.geometryReads}`);
  });

  for (const direction of ['horizontal', 'vertical'] as const) {
    it(`protects a ${direction} stroked path when all paint geometry has zero area`, () => {
      const horizontal = direction === 'horizontal';
      const { svg } = figure(rect(650, 580, 100, 120), { x: -500, y: 30, width: horizontal ? 20 : 0, height: horizontal ? 0 : 20 });
      const bounds = rect(150, 610, horizontal ? 20 : 0, horizontal ? 0 : 20);
      const path = element('path', bounds, part(svg, bounds));
      path.setAttribute('stroke', '#6753b8'); path.setAttribute('stroke-width', '50'); path.setAttribute('stroke-linejoin', 'round');
      Object.assign(path, { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 650, f: 580 }) });
      const found = floor(fixture.opts);
      assert.ok(found, 'clear floor remains beside the painted stroke');
      assert.ok(found.left > (horizontal ? 245 : 225), `the full stroke must block the anchor span: ${found.left}`);
      assert.ok(found.right > 590 && found.right < 600);
    });
  }

  it('includes the screen-space stroke width of a mirrored, scaled path', () => {
    const { svg } = figure(rect(650, 580, 100, 120), { x: -500, y: 30, width: 0, height: 20 });
    const bounds = rect(150, 610, 0, 20);
    const path = element('path', bounds, part(svg, bounds));
    path.setAttribute('stroke', '#6753b8'); path.setAttribute('stroke-width', '50'); path.setAttribute('stroke-linejoin', 'miter');
    Object.assign(path, { getScreenCTM: () => ({ a: -2, b: 0, c: 0, d: 0.5, e: 150, f: 600 }) });
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 400, `transformed miter extents remain blocked: ${found.left}`);
  });

  it('leaves usable floor beside 300 distinct overflow shapes without quadratic collection work', () => {
    const { svg } = figure(rect(650, 580, 100, 120), { x: -550, y: 0, width: 650, height: 120 });
    for (let i = 0; i < 300; i++) element('ellipse', rect(100 + i, 610, 0.1, 0.1), svg);
    const found = floor(fixture.opts);
    assert.ok(found, 'a modest number of distinct shapes must not exhaust collection');
    assert.ok(found.left > 450 && found.right > 590);
    assert.ok(fixture.geometryReads < 400, `collection visits each shape once: ${fixture.geometryReads}`);
  });

  it('bounds extra collection work when a companion has too many disconnected overflow shapes', () => {
    const { svg } = figure(rect(0, 580, 100, 120), { x: 0, y: 0, width: 800, height: 120 });
    for (let i = 0; i < 10_000; i++) element('path', rect(110 + (i % 600), 600 + Math.floor(i / 600), 0.1, 0.1), svg);
    assert.equal(floor(fixture.opts), null, 'an incomplete overflow collection cannot certify clear floor');
    assert.ok(fixture.geometryReads < 2100, `the rectangle cap bounds linear collection: ${fixture.geometryReads}`);
  });

  it('falls back to normal descendant scanning if native SVG bounds fail', () => {
    const { svg } = figure(rect(0, 580, 100, 120));
    Object.assign(svg, { getBBox() { throw new Error('No native geometry'); } });
    element('path', rect(0, 580, 230, 120), svg);
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 280);
  });

  it('does not prune arbitrary avoided page SVG content as a companion graphic', () => {
    const avoid = element('section', rect(0, 580, 100, 120)); avoid.setAttribute('data-peetty', 'avoid');
    const svg = element('svg', rect(0, 580, 100, 120), avoid);
    Object.assign(svg, { getBBox: () => ({ x: 0, y: 0, width: 100, height: 120 }), getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 580 }) });
    element('button', rect(0, 580, 250, 120), svg);
    const found = floor(fixture.opts);
    assert.ok(found);
    assert.ok(found.left > 300);
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
    assert.equal(fixture.hitTests - before, 14, 'the edge and three heights in one column for the span, and in three columns across her');
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

  it('moves on to the next crossed edge down when one does not hold her', () => {
    const high = perch(rect(100, 300, 300, 30));
    const middle = perch(rect(100, 350, 300, 30));
    perch(rect(0, 550, 800, 30));
    const perches = findPerches(fixture.opts);
    const tried: (Element | null)[] = [];
    const landed = crossing(perches, 200, 290, 400, fixture.opts, (p) => {
      tried.push(p.el);
      return p.el === asElement(high) ? null : p;
    });
    assert.equal(landed?.el, asElement(middle));
    assert.deepEqual(tried, [asElement(high), asElement(middle)]);
    assert.equal(crossing(perches, 200, 290, 400, fixture.opts, () => null), null, 'nothing crossed holds her');
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

  it('ignores text and controls an ordinary overflow container clips away', () => {
    // A scroller showing 100px of a long text; its hidden lines and controls sit over the floor.
    const scroller = element('div', rect(0, 100, 800, 100));
    scroller.style.overflowX = 'hidden';
    scroller.style.overflowY = 'auto';
    const content = element('p', rect(0, 100, 800, 700), scroller);
    text(content, rect(0, 600, 800, 100));
    element('button', rect(0, 640, 800, 40), scroller);
    assert.ok(floor(fixture.opts), 'nothing visible covers the floor');
    // A fixed control escapes the clip.
    element('button', rect(0, 640, 800, 40), scroller).style.position = 'fixed';
    fixture.now += 300;
    assert.equal(floor(fixture.opts), null);
  });

  it('clips absolutely positioned content by overflow at or above its containing block', () => {
    const scroller = element('div', rect(0, 100, 800, 100));
    scroller.style.overflowX = 'hidden';
    scroller.style.overflowY = 'hidden';
    element('button', rect(0, 640, 800, 40), scroller).style.position = 'absolute';
    assert.equal(floor(fixture.opts), null, 'positioned against the page, it escapes the scroller');
    scroller.style.position = 'relative';
    fixture.now += 300;
    assert.ok(floor(fixture.opts), 'positioned against the scroller, it is clipped');
  });

  it('clips positioned content by an unpositioned wrapper that is still its containing block', () => {
    const wrapper = element('div', rect(0, 100, 800, 100));
    wrapper.style.overflowX = 'hidden';
    wrapper.style.overflowY = 'hidden';
    element('button', rect(0, 640, 800, 40), wrapper).style.position = 'absolute';
    element('button', rect(0, 600, 800, 40), wrapper).style.position = 'fixed';
    assert.equal(floor(fixture.opts), null, 'both escape a plain wrapper');
    // A transform, filter or containment makes it hold absolute and fixed content, so its overflow clips them.
    const plain = { ...wrapper.style };
    const holders = [['transform', 'translateZ(0)'], ['translate', '0px 0px'], ['filter', 'blur(0px)'], ['willChange', 'transform'], ['contain', 'layout'], ['containerType', 'inline-size']] as const;
    for (const [property, value] of holders) {
      wrapper.style = { ...plain, [property]: value };
      fixture.now += 300;
      assert.ok(floor(fixture.opts), `clipped with ${property}: ${value}`);
    }
    wrapper.style = { ...plain, position: 'relative' };
    fixture.now += 300;
    assert.equal(floor(fixture.opts), null, 'positioned, it holds the absolute button but not the fixed one');
  });

  it('ignores paint containment on a wrapper with no box of its own', () => {
    const wrapper = element('div', empty());
    Object.assign(wrapper.style, { display: 'contents', contain: 'paint' });
    const edge = perch(rect(0, 400, 400, 40), wrapper);
    const content = element('p', rect(0, 620, 800, 20), wrapper);
    text(content, content.bounds);
    assert.ok(findPerches(fixture.opts).some((found) => found.el === asElement(edge)), 'its children are still perches');
    assert.equal(floor(fixture.opts), null, 'and their text still blocks the floor');
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
    assert.ok(fixture.hitTests <= 4, 'the edge and three heights above it, at one x');
  });
});
