import type { Edge } from './physics.ts';

/**
 * Places to stand: the visible top edges of page elements, and the viewport
 * bottom, wherever her whole figure fits without covering text, controls or
 * areas the page asks her to avoid.
 */

/** A place to stand; left and right bound her anchor (feet) on it. */
export interface Perch extends Edge {
  /** The supporting element; null for the bottom of the viewport. */
  el: Element | null;
  /** A form field: she may sit or lie on it while it is not in use, never walk. */
  input: boolean;
  /** Marked by the page with data-peetty="perch". */
  preferred: boolean;
  /** False only for the catch-all viewport bottom over page content: it holds her, but is not a place to stay. */
  clear: boolean;
  /** The anchor span relative to the element's left edge, so it follows the element. */
  offset: [number, number];
}

export interface PerchOptions {
  /** Our own overlay, ignored during hit testing. */
  host: Element;
  /** Figure size in CSS pixels, including transparent margins. */
  width: number;
  height: number;
  /** Feet from the figure's top-left corner; defaults to bottom center. */
  anchor?: [number, number];
}

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'video', 'audio', 'iframe',
  '[contenteditable]:not([contenteditable="false"])', '[role="button"]', '[role="link"]', '[role="textbox"]',
  '[role="slider"]', '[role="tab"]', '[role="menuitem"]', '[tabindex]:not([tabindex="-1"])',
].join(',');
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SOLID_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'HR', 'PICTURE']);
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'PICTURE', 'IFRAME']);
const SKIP_INPUTS = new Set(['password', 'hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image']);
const CACHE_MS = 250;
const MAX_NODES = 6000;
const MAX_WORK = 40_000;
const MAX_RECTS = 2048;
const MAX_TEXT = 16_384;
const MAX_ANCESTORS = 64;
const MAX_CANDIDATES = 160;
const MAX_PERCHES = 40;
const HIT_BUDGET = 128;
/** Open shadow roots a hit test descends through. */
const SHADOW_DEPTH = 16;
/** Node.DOCUMENT_FRAGMENT_NODE: the node type of a shadow root, and never of a document. */
const FRAGMENT = 11;
/** How far inside her outline hit tests look for a click area she would cover: above her feet, below her head, in from her sides. */
const INSET = 6;
/** Hit-test columns over ground she would cover are at most this far apart, so a click area at least this wide is found. */
const COLUMN = 48;
/** The most steps a walk is checked in; a longer walk is checked more coarsely. */
const MAX_STEPS = 24;
/** Below this effective opacity, or this height, an element cannot carry her. */
const MIN_OPACITY = 0.2;
const MIN_HEIGHT = 14;
const PAD = 3;
const EPSILON = 0.5;

type Box = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
interface Budget { left: number }
/** The figure's extents around its anchor; key identifies it for remembered placements. */
interface Footprint { left: number; right: number; above: number; below: number; key: string }
/** Something she must not cover; owner is the element whose own box it is, null for text. */
interface Obstacle { box: Box; owner: Element | null; avoid: boolean }
interface Scan {
  time: number;
  vw: number;
  vh: number;
  complete: boolean;
  /** Work left once collection finished; every lookup on the snapshot starts with this much. */
  allowance: number;
  /** The current lookup's own work budget. */
  budget: Budget;
  obstacles: Obstacle[];
  candidates: Element[];
  spans: Map<Element | null, { key: string; span: [number, number] | null }>;
}
interface Metrics { rect: DOMRect; input: boolean; preferred: boolean }
interface Placement { key: string; width: number; height: number; vw: number; vh: number }
/**
 * What is visible inside the current element: `clip` after paint containment,
 * which clips everything; `flow` after overflow clips too, for text and in-flow
 * content; `absolute` and `fixed` for positioned content, which escapes the
 * overflow clips below its containing block.
 */
interface Context { opacity: number; avoid: boolean; clip: Box; flow: Box; absolute: Box; fixed: Box; visible: boolean }
const scans = new WeakMap<Element, Scan>();
const placements = new WeakMap<Perch, Placement>();

function spend(budget: Budget, amount = 1): boolean {
  budget.left -= amount;
  return budget.left >= 0;
}

function footprint(opts: PerchOptions): Footprint | null {
  const [left, above] = opts.anchor ?? [opts.width / 2, opts.height];
  if (![opts.width, opts.height, left, above].every(Number.isFinite) || opts.width <= 0 || opts.height <= 0) return null;
  return { left, right: opts.width - left, above, below: opts.height - above, key: `${opts.width}:${opts.height}:${left}:${above}` };
}

function limitsOf(body: Footprint) {
  const fit = { left: body.left, right: innerWidth - body.right, top: body.above, bottom: innerHeight - Math.max(0, body.below) };
  return fit.left <= fit.right && fit.top <= fit.bottom ? fit : null;
}

function parentOf(el: Element): Element | null {
  return el.parentElement ?? hostOf(el);
}

/**
 * The element hosting the shadow tree node is in, or null outside one. Only a
 * shadow root has a host: a document's `host` is whatever form or image the
 * page names "host", or a collection of them.
 */
function hostOf(node: Node): Element | null {
  const root = node.getRootNode();
  return root.nodeType === FRAGMENT ? (root as ShadowRoot).host ?? null : null;
}

/** Native paint bounds, including overflow and the figure's screen transform. */
function figureBounds(el: Element): Box | null {
  const svg = el as SVGGraphicsElement;
  if (typeof svg.getBBox !== 'function' || typeof svg.getScreenCTM !== 'function') return null;
  try {
    const shape = svg.getBBox();
    const matrix = svg.getScreenCTM();
    if (!matrix || ![shape.x, shape.y, shape.width, shape.height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite) || shape.width < 0 || shape.height < 0) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const x of [shape.x, shape.x + shape.width]) for (const y of [shape.y, shape.y + shape.height]) {
      const px = matrix.a * x + matrix.c * y + matrix.e;
      const py = matrix.b * x + matrix.d * y + matrix.f;
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
      left = Math.min(left, px); right = Math.max(right, px);
      top = Math.min(top, py); bottom = Math.max(bottom, py);
    }
    return box(left, top, right, bottom);
  } catch { return null; }
}

type PaintPadding = [number, number];

/** getBoundingClientRect excludes SVG stroke, including all paint on a straight path. */
function strokePadding(el: Element): PaintPadding | null {
  const stroke = el.getAttribute('stroke');
  const width = Number(el.getAttribute('stroke-width') ?? 1);
  if (!stroke || stroke === 'none' || width <= 0) return [0, 0];
  try {
    const matrix = (el as SVGGraphicsElement).getScreenCTM();
    if (!Number.isFinite(width) || !matrix || ![matrix.a, matrix.b, matrix.c, matrix.d].every(Number.isFinite)) return null;
    // The renderer uses round joins by default; SVG's default miter limit is four.
    // A local square also covers square caps, and transforms conservatively under shear.
    const join = el.getAttribute('stroke-linejoin');
    const radius = width / 2 * (join === null || join === 'miter' ? 4 : 1);
    const x = radius * (Math.abs(matrix.a) + Math.abs(matrix.c));
    const y = radius * (Math.abs(matrix.b) + Math.abs(matrix.d));
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  } catch { return null; }
}

/** Reserve each node's enter/exit bookkeeping; native matrix reads cost another unit. */
function descendantStrokePadding(root: Element, data: Scan): WeakMap<Element, PaintPadding> | null {
  const padding = new WeakMap<Element, PaintPadding>();
  const ordered: Element[] = [];
  const pending: Node[] = [root];
  while (pending.length) {
    if (!spend(data.budget)) { data.complete = false; return null; }
    const node = pending.pop()!;
    if (node !== root && node.nextSibling) pending.push(node.nextSibling);
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (el.tagName.toUpperCase() === 'DEFS') continue;
    ordered.push(el);
    if (el.getAttribute('stroke')) {
      if (!spend(data.budget)) { data.complete = false; return null; }
      const own = strokePadding(el);
      if (!own) { data.complete = false; return null; }
      if (own[0] || own[1]) padding.set(el, own);
    }
    if (el.firstChild) pending.push(el.firstChild);
  }
  // Screen-space extents aggregate without reapplying a parent's transform.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const el = ordered[i]!, own = padding.get(el), parent = el.parentElement;
    if (!own || el === root || !parent) continue;
    const previous = padding.get(parent) ?? [0, 0];
    padding.set(parent, [Math.max(previous[0], own[0]), Math.max(previous[1], own[1])]);
  }
  return padding;
}

function paddedBounds(bounds: Box, padding: PaintPadding | undefined): Box {
  const [x, y] = padding ?? [0, 0];
  return box(bounds.left - x, bounds.top - y, bounds.right + x, bounds.bottom + y);
}

/**
 * Sweep left edges and track the furthest painted right edge along y. A range
 * minimum query detects coverage by earlier boxes, including nested boxes, in
 * O(log n) work without filling the gaps between disconnected shapes.
 */
function coalesceFigureBoxes(bounds: Box[], data: Scan): Box[] {
  if (bounds.length < 2) return bounds;
  const compare = (a: number, b: number) => {
    if (!spend(data.budget)) data.complete = false;
    return a - b;
  };
  bounds.sort((a, b) => compare(a.left, b.left) || b.right - a.right || a.top - b.top || b.bottom - a.bottom);
  const ys = [...new Set(bounds.flatMap((r) => [r.top, r.bottom]))].sort(compare);
  if (!data.complete) return [];
  const indices = new Map(ys.map((y, i) => [y, i]));
  const size = ys.length - 1;
  const minimum = new Array<number>(size * 4).fill(-Infinity);
  const lazy = new Array<number>(size * 4).fill(-Infinity);
  const apply = (node: number, right: number) => {
    minimum[node] = Math.max(minimum[node]!, right);
    lazy[node] = Math.max(lazy[node]!, right);
  };
  const push = (node: number) => {
    apply(node * 2, lazy[node]!); apply(node * 2 + 1, lazy[node]!);
    lazy[node] = -Infinity;
  };
  const visit = () => {
    if (spend(data.budget)) return true;
    data.complete = false; return false;
  };
  const covered = (node: number, left: number, right: number, from: number, to: number, edge: number): boolean => {
    if (!visit()) return false;
    if (minimum[node]! >= edge) return true;
    if (from <= left && right <= to) return false;
    const mid = (left + right) >>> 1;
    push(node);
    return (from >= mid || covered(node * 2, left, mid, from, to, edge)) &&
      (to <= mid || covered(node * 2 + 1, mid, right, from, to, edge));
  };
  const paint = (node: number, left: number, right: number, from: number, to: number, edge: number): void => {
    if (!visit()) return;
    if (from <= left && right <= to) { apply(node, edge); return; }
    const mid = (left + right) >>> 1;
    push(node);
    if (from < mid) paint(node * 2, left, mid, from, to, edge);
    if (to > mid && data.complete) paint(node * 2 + 1, mid, right, from, to, edge);
    minimum[node] = Math.min(minimum[node * 2]!, minimum[node * 2 + 1]!);
  };
  const result: Box[] = [];
  for (const rect of bounds) {
    const from = indices.get(rect.top)!, to = indices.get(rect.bottom)!;
    if (!covered(1, 0, size, from, to, rect.right)) {
      if (!data.complete) break;
      if (data.obstacles.length + result.length + 1 >= MAX_RECTS) { data.complete = false; break; }
      result.push(rect);
      paint(1, 0, size, from, to, rect.right);
    }
    if (!data.complete) break;
  }
  return result;
}

/**
 * Keep a validated companion's viewport and disconnected overflow separate.
 * A bounded stroke metadata pass makes group pruning paint-aware. Native group
 * bounds then avoid covered/offscreen geometry reads. Mixed groups are refined
 * to leaves, whose screen rectangles include bone, spring and mirror transforms.
 */
function figureBoxes(el: Element, rect: Box, clip: Box, data: Scan): Box[] | null {
  if (el.tagName.toUpperCase() !== 'SVG' || hostOf(el)?.tagName.toUpperCase() !== 'PEETTY-COMPANION' || !finiteBox(rect)) return null;
  if (!spend(data.budget, 2)) { data.complete = false; return null; }
  const geometry = figureBounds(el);
  if (!geometry) return null;
  const padding = descendantStrokePadding(el, data);
  if (!padding) return null;
  const bounds = paddedBounds(geometry, padding.get(el));
  const overflow: Box[] = [];
  const known = new Set<string>();
  const keyOf = (bounds: Box) => `${bounds.left}:${bounds.top}:${bounds.right}:${bounds.bottom}`;
  const covers = (outer: Box, inner: Box) => outer.left <= inner.left && outer.right >= inner.right && outer.top <= inner.top && outer.bottom >= inner.bottom;
  const uncovered = (bounds: Box): Box | null => {
    const visible = intersection(bounds, clip);
    if (empty(visible) || covers(rect, visible)) return null;
    if (!spend(data.budget)) { data.complete = false; return null; }
    // Exact duplicates are common across parts. A hash lookup keeps distinct
    // overflow shapes linear instead of comparing each with every prior box.
    return known.has(keyOf(visible)) ? null : visible;
  };
  // A zero-area geometry box can still have a visible stroke. Refine it before pruning.
  if (!empty(bounds) && !uncovered(bounds)) return overflow;
  const pending: Node[] = el.firstChild ? [el.firstChild] : [];
  try {
    while (pending.length && data.complete) {
      // Metadata traversal was charged above; charge this native geometry read
      // separately. Queue siblings lazily, including huge child lists.
      if (!spend(data.budget)) { data.complete = false; break; }
      const node = pending.pop()!;
      if (node.nextSibling) pending.push(node.nextSibling);
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      // Clip paths and gradients in the renderer's defs do not paint by themselves.
      if (child.tagName.toUpperCase() === 'DEFS') continue;
      const geometry = child.getBoundingClientRect();
      if (!finiteBox(geometry)) return null;
      const bounds = paddedBounds(geometry, padding.get(child));
      if (!finiteBox(bounds)) { data.complete = false; break; }
      const visible = uncovered(bounds);
      if (!visible || !data.complete) continue;
      if (child.firstChild) {
        if (!spend(data.budget)) { data.complete = false; break; }
        const style = getComputedStyle(child);
        if (style.display !== 'none' && Number(style.opacity) !== 0 && style.contentVisibility !== 'hidden') pending.push(child.firstChild);
      } else {
        // Collection remains work-bounded; apply the rectangle cap after containment
        // coalescing so differently sized nested paint does not consume every slot.
        overflow.push(visible);
        known.add(keyOf(visible));
      }
    }
  } catch { return null; }
  return data.complete ? coalesceFigureBoxes(overflow, data) : overflow;
}

/** The topmost page element at a point, including open shadow trees. */
export function topAt(x: number, y: number, host: Element): Element | null {
  return hitAt(x, y, host, { left: HIT_BUDGET });
}

function hitAt(x: number, y: number, host: Element, budget: Budget): Element | null {
  let root: Document | ShadowRoot = document;
  let last: Element | null = null;
  for (let depth = 0; depth < SHADOW_DEPTH; depth++) {
    if (!spend(budget) || typeof root.elementsFromPoint !== 'function') return last;
    const hits: Element[] = root.elementsFromPoint(x, y);
    let hit: Element | null = null;
    for (let i = 0; i < Math.min(hits.length, 64); i++) {
      if (!spend(budget)) return null;
      const el: Element = hits[i]!;
      if (el === host || host.contains(el)) continue;
      hit = el;
      break;
    }
    if (!hit || hit === last) return last ?? hit;
    last = hit;
    if (!hit.shadowRoot || typeof hit.shadowRoot.elementsFromPoint !== 'function') return hit;
    root = hit.shadowRoot;
  }
  return null;
}

/**
 * Whether el's top edge at y is on top at x, not covered by a menu or dialog,
 * with nothing clickable where she would stand on it: in her column at x, or,
 * when `wide`, in columns across her whole footprint. Rect clearance cannot see
 * a click area that reaches past its control's box, such as a stretched link's
 * ::after across a card, so hit tests look for one. Without a shared budget each
 * hit test has its own, and one that cannot finish fails the check.
 */
function exposed(el: Element, x: number, y: number, body: Footprint, host: Element, budget?: Budget, wide = false): boolean {
  const hit = probe(x, y + 2, host, budget);
  if (!hit || !encloses(el, hit)) return false;
  const across = wide ? columns(x - body.left + INSET, x + body.right - INSET) : [x];
  return !across.some((column) => clickableAbove(column, y, body, host, budget));
}

/** The element on top at a point, or undefined when the hit test ran out of budget and could not tell. */
function probe(x: number, y: number, host: Element, budget: Budget = { left: HIT_BUDGET }): Element | null | undefined {
  const hit = hitAt(x, y, host, budget);
  return budget.left < 0 ? undefined : hit;
}

/** Evenly spaced columns from `from` to `to`, at most COLUMN apart. */
function columns(from: number, to: number): number[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / COLUMN));
  return Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);
}

/**
 * Whether something clickable stands in her height at x when she stands on an
 * edge at y: just above her feet, at her middle, or just below the top of her head.
 */
function clickableAbove(x: number, y: number, body: Footprint, host: Element, budget?: Budget): boolean {
  for (const h of [INSET, body.above / 2, body.above - INSET]) {
    if (h < INSET || y - h < 0) continue;
    const hit = probe(x, y - h, host, budget);
    // A hit test that cannot finish counts as finding something: what it missed might be clickable.
    if (hit === undefined || (hit && clickable(hit))) return true;
  }
  return false;
}

/** Whether a click on node reaches a control, including from inside open shadow roots. */
function clickable(node: Element): boolean {
  let current: Element | null = node;
  for (let depth = 0; current && depth <= SHADOW_DEPTH; depth++) {
    if (current.closest(INTERACTIVE)) return true;
    current = hostOf(current);
  }
  return false;
}

/**
 * Whether node is el or inside it, including inside open shadow roots: a hit
 * test returns the innermost element, and contains() stops at a shadow root.
 */
function encloses(el: Element, node: Element): boolean {
  let current: Element | null = node;
  for (let depth = 0; current && depth <= SHADOW_DEPTH; depth++) {
    if (el.contains(current)) return true;
    current = hostOf(current);
  }
  return false;
}

export function isEditable(el: Element | null): boolean {
  return !!el && el.matches(EDITABLE);
}

/** Resolve focus in the element's own tree, including focus inside open shadows. */
export function inUse(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches(':focus-within')) return true;
  const root = el.getRootNode() as Document | ShadowRoot;
  let active = root.activeElement;
  for (let depth = 0; active && depth < MAX_ANCESTORS; depth++) {
    if (active !== document.body && (active === el || el.contains(active))) return true;
    active = active.shadowRoot?.activeElement ?? null;
  }
  return false;
}

function visibleEdge(el: Element, style: CSSStyleDeclaration): boolean {
  if (SOLID_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.getAttribute('data-peetty') === 'perch') return true;
  if (style.backgroundImage !== 'none') return true;
  if (style.boxShadow !== 'none') return true;
  if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' && !transparent(style.borderTopColor)) return true;
  return !transparent(style.backgroundColor);
}

function transparent(color: string): boolean {
  if (!color || color === 'transparent') return true;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length === 4 && parseFloat(parts[3]!) < 0.08;
}

/** Whether an element's own box can carry her: visible, with a visible edge, and tall enough. */
function carries(el: Element, style: CSSStyleDeclaration, rect: Box): boolean {
  return style.visibility === 'visible' && rect.height >= MIN_HEIGHT && visibleEdge(el, style);
}

/** Cheap, bounded eligibility checks also used between full clearance checks. */
function metrics(el: Element, opts: PerchOptions, body: Footprint): Metrics | null {
  if (!el.isConnected || el === document.body || el === document.documentElement || el === opts.host || opts.host.contains(el)) return null;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  if (!finiteBox(rect) || !carries(el, style, rect) || rect.width < opts.width * 0.8) return null;
  if (rect.top - body.above < 0 || rect.top + body.below > innerHeight - 1 || rect.right <= 0 || rect.left >= innerWidth) return null;
  let opacity = 1;
  let ancestor: Element | null = el;
  for (let depth = 0; ancestor; depth++) {
    if (depth >= MAX_ANCESTORS) return null;
    const appearance = ancestor === el ? style : getComputedStyle(ancestor);
    if (ancestor.getAttribute('data-peetty') === 'avoid' || appearance.display === 'none') return null;
    // Hidden contents leave the element's own box painted: they only hide what is inside.
    if (ancestor !== el && appearance.contentVisibility === 'hidden') return null;
    opacity *= Number(appearance.opacity);
    if (opacity < MIN_OPACITY) return null;
    ancestor = parentOf(ancestor);
  }
  const input = isEditable(el);
  // Tag names are lowercase in XHTML documents.
  if (input && ((el.tagName.toUpperCase() === 'INPUT' && SKIP_INPUTS.has((el as HTMLInputElement).type)) || inUse(el) || el.matches(':disabled') || (el as HTMLInputElement).disabled)) return null;
  return { rect, input, preferred: el.getAttribute('data-peetty') === 'perch' };
}

function finiteBox(rect: Box): boolean {
  return [rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height].every(Number.isFinite);
}

function box(left: number, top: number, right: number, bottom: number): Box {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function intersection(a: Box, b: Box): Box {
  return box(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
}

/** The clip for in-flow content of an element that clips its overflow on either axis. */
function overflowClip(el: Element, style: CSSStyleDeclaration, rect: Box, clip: Box): Box {
  // The root's and body's overflow applies to the viewport; inline and contents boxes never clip.
  if (el === document.documentElement || el === document.body || style.display === 'inline' || style.display === 'contents') return clip;
  const x = style.overflowX !== 'visible';
  const y = style.overflowY !== 'visible';
  if (!x && !y) return clip;
  return box(
    x ? Math.max(clip.left, rect.left) : clip.left, y ? Math.max(clip.top, rect.top) : clip.top,
    x ? Math.min(clip.right, rect.right) : clip.right, y ? Math.min(clip.bottom, rect.bottom) : clip.bottom,
  );
}

/**
 * Which positioned descendants an element is the containing block of: `fixed`
 * ones, and absolutely positioned ones too, when a transform, filter or
 * containment makes it one, positioned or not; `absolute` ones when it is only
 * positioned; none when they escape it. Its overflow clips the ones it holds.
 */
function holds(style: CSSStyleDeclaration): 'fixed' | 'absolute' | null {
  // A contents box is no box at all, and inline boxes are neither transformed nor contained.
  if (style.display === 'contents') return null;
  const set = (value: string | undefined) => !!value && value !== 'none';
  if (style.display !== 'inline' && (
    set(style.transform) || set(style.translate) || set(style.rotate) || set(style.scale)
    || set(style.perspective) || set(style.filter) || set(style.backdropFilter)
    || /\b(transform|translate|rotate|scale|perspective|filter|contain)\b/.test(style.willChange ?? '')
    || /\b(layout|paint|strict|content)\b/.test(style.contain ?? '')
    || (!!style.containerType && style.containerType !== 'normal')
  )) return 'fixed';
  return style.position && style.position !== 'static' ? 'absolute' : null;
}

function empty(rect: Box): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

/**
 * A snapshot is shared by all candidates, the floor and cadence-based rechecks.
 * Each call is one lookup: it reuses the snapshot but gets its own work budget,
 * so a discovery that spends its budget cannot fail the rechecks that follow it.
 */
function scan(opts: PerchOptions): Scan {
  const time = performance.now();
  const previous = scans.get(opts.host);
  if (previous && time - previous.time < CACHE_MS && previous.vw === innerWidth && previous.vh === innerHeight) {
    return { ...previous, budget: { left: previous.allowance } };
  }
  const result: Scan = {
    time, vw: innerWidth, vh: innerHeight, complete: true, allowance: 0, budget: { left: MAX_WORK },
    obstacles: [], candidates: [], spans: new Map(),
  };
  const preferred: Element[] = [];
  const ordinary: Element[] = [];
  const viewport = box(0, 0, innerWidth, innerHeight);
  const pending: { node: Node; context: Context }[] = [
    { node: document.documentElement, context: { opacity: 1, avoid: false, clip: viewport, flow: viewport, absolute: viewport, fixed: viewport, visible: true } },
  ];
  let visited = 0;
  // Created on the first text node, one range measures all text of this scan.
  let range: Range | undefined;
  const addObstacle = (rect: Box, owner: Element | null, avoid: boolean, clip: Box) => {
    if (!finiteBox(rect) || empty(rect)) return;
    const clipped = intersection(rect, clip);
    if (empty(clipped)) return;
    if (result.obstacles.length >= MAX_RECTS || !spend(result.budget)) { result.complete = false; return; }
    result.obstacles.push({ box: box(clipped.left - PAD, clipped.top - PAD, clipped.right + PAD, clipped.bottom + PAD), owner, avoid });
  };
  while (pending.length && result.complete) {
    const { node, context } = pending.pop()!;
    if (++visited > MAX_NODES || !spend(result.budget)) { result.complete = false; break; }
    // Queue siblings lazily; a huge child list cannot bypass the node budget.
    if (node.nextSibling) pending.push({ node: node.nextSibling, context });
    if (node.nodeType === Node.TEXT_NODE) {
      if (!context.visible || !context.opacity) continue;
      const text = node.textContent ?? '';
      if (text.length > MAX_TEXT || !spend(result.budget, Math.ceil(text.length / 64))) { result.complete = false; break; }
      if (!text.trim()) continue;
      range ??= document.createRange();
      range.selectNodeContents(node);
      if (empty(intersection(range.getBoundingClientRect(), context.flow))) continue;
      const rects = range.getClientRects();
      if (rects.length > MAX_RECTS - result.obstacles.length) { result.complete = false; break; }
      for (const rect of rects) addObstacle(rect, null, false, context.flow);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (el === opts.host || opts.host.contains(el)) continue;
    if (!spend(result.budget, 2)) { result.complete = false; break; }
    const style = getComputedStyle(el);
    const opacity = context.opacity * Number(style.opacity);
    if (style.display === 'none' || opacity === 0) continue;
    const rect = el.getBoundingClientRect();
    const visible = style.visibility === 'visible';
    const avoid = context.avoid || el.getAttribute('data-peetty') === 'avoid';
    // Paint containment keeps every descendant inside, so offscreen bulk can be skipped. It needs a
    // box of its own: contents and inline boxes contain nothing, and their rects may be empty.
    const contained = style.display !== 'contents' && style.display !== 'inline' && /\b(paint|strict|content)\b/.test(style.contain);
    const clip = contained ? intersection(context.clip, rect) : context.clip;
    if (empty(clip)) continue;
    // Overflow clips in-flow content; positioned content escapes the overflow clips
    // below its containing block. A contents box is never positioned.
    const position = style.display === 'contents' ? 'static' : style.position;
    const own = position === 'fixed' ? context.fixed : position === 'absolute' ? context.absolute : context.flow;
    const graphic = visible && avoid && style.overflowX === 'visible' && style.overflowY === 'visible' ? figureBoxes(el, rect, own, result) : null;
    if (!result.complete) break;
    if (visible && (avoid || el.matches(INTERACTIVE) || MEDIA_TAGS.has(el.tagName.toUpperCase()))) addObstacle(rect, el, avoid, own);
    if (graphic) {
      for (const bounds of graphic) addObstacle(bounds, el, avoid, own);
      continue;
    }
    if (!avoid && opacity >= MIN_OPACITY && rect.width > 0 && rect.top >= own.top && rect.top < own.bottom && carries(el, style, rect)) {
      const list = el.getAttribute('data-peetty') === 'perch' ? preferred : ordinary;
      if (list.length < MAX_CANDIDATES) list.push(el);
    }
    // content-visibility: hidden skips the contents; the element's own box above still counts.
    if (style.contentVisibility === 'hidden') continue;
    const flow = overflowClip(el, style, rect, intersection(own, clip));
    const held = holds(style);
    const childContext = {
      opacity, avoid, clip, flow,
      absolute: held ? flow : intersection(context.absolute, clip),
      fixed: held === 'fixed' ? flow : intersection(context.fixed, clip),
      visible,
    };
    if (el.firstChild) pending.push({ node: el.firstChild, context: childContext });
    if (el.shadowRoot?.firstChild) pending.push({ node: el.shadowRoot.firstChild, context: childContext });
  }
  result.candidates = [...preferred, ...ordinary].slice(0, MAX_CANDIDATES);
  result.allowance = result.budget.left;
  // Start the cache lifetime after collection.
  result.time = performance.now();
  scans.set(opts.host, result);
  return { ...result, budget: { left: result.allowance } };
}

function anchorBounds(rect: Box, body: Footprint): [number, number] {
  return [Math.max(rect.left + 6, body.left), Math.min(rect.right - 6, innerWidth - body.right)];
}

/**
 * Whether an obstacle is part of the surface el offers at y, which she stands on
 * rather than covers: el itself, or an element around it or inside it whose box
 * starts at that edge, such as a <picture> or link the size of its <img>.
 */
function surface(el: Element, owner: Element, top: number, y: number): boolean {
  return owner === el || (top >= y - EPSILON && (encloses(owner, el) || encloses(el, owner)));
}

/** Subtract whole rectangles expanded by the asymmetric anchor-relative footprint. */
function freeSpan(left: number, right: number, y: number, body: Footprint, data: Scan, el: Element | null): [number, number] | null {
  if (!data.complete || left > right || y - body.above < 0 || y + body.below > innerHeight) return null;
  const key = `${body.key}:${left}:${right}:${y}`;
  const cached = data.spans.get(el);
  if (cached?.key === key) return cached.span;
  const blocked: [number, number][] = [];
  for (const obstacle of data.obstacles) {
    if (!spend(data.budget)) return null;
    const r = obstacle.box;
    if (r.bottom <= y - body.above || r.top >= y + body.below) continue;
    const lo = r.left - body.right;
    const hi = r.right + body.left;
    if (hi < left || lo > right) continue;
    // Standing on this control or media edge is intended; avoid areas never qualify.
    if (el && obstacle.owner && !obstacle.avoid && surface(el, obstacle.owner, r.top + PAD, y)) continue;
    blocked.push([lo, hi]);
  }
  blocked.sort((a, b) => a[0] - b[0]);
  let start = left;
  let best: [number, number] | null = null;
  for (const [lo, hi] of blocked) {
    const end = Math.min(right, lo - EPSILON);
    if (end >= start && (!best || end - start > best[1] - best[0])) best = [start, end];
    start = Math.max(start, hi + EPSILON);
    if (start > right) break;
  }
  if (start <= right && (!best || right - start > best[1] - best[0])) best = [start, right];
  data.spans.set(el, { key, span: best });
  return best;
}

function remember(perch: Perch, body: Footprint, rect?: Box): Perch {
  placements.set(perch, { key: body.key, width: rect?.width ?? innerWidth, height: rect?.height ?? innerHeight, vw: innerWidth, vh: innerHeight });
  return perch;
}

function perchWith(el: Element, opts: PerchOptions, body: Footprint, data: Scan): Perch | null {
  if (!data.complete) return null;
  const live = metrics(el, opts, body);
  if (!live || !spend(data.budget, MAX_ANCESTORS)) return null;
  const [left, right] = anchorBounds(live.rect, body);
  const span = freeSpan(left, right, live.rect.top, body, data, el);
  // The edge must be on top in the middle of its span.
  if (!span || !exposed(el, (span[0] + span[1]) / 2, live.rect.top, body, opts.host, data.budget) || data.budget.left < 0) return null;
  return remember({
    el, left: span[0], right: span[1], y: live.rect.top, input: live.input, preferred: live.preferred, clear: true,
    offset: [span[0] - live.rect.left, span[1] - live.rect.left],
  }, body, live.rect);
}

/** The perch on el's top edge, or null when it cannot carry her or has no clear room. */
export function perchOf(el: Element, opts: PerchOptions): Perch | null {
  const body = footprint(opts);
  return body ? perchWith(el, opts, body, scan(opts)) : null;
}

function floorWith(body: Footprint, data: Scan): Perch | null {
  const fit = limitsOf(body);
  const span = fit && freeSpan(fit.left, fit.right, fit.bottom, body, data, null);
  if (!fit || !span) return null;
  return remember({ el: null, left: span[0], right: span[1], y: fit.bottom, input: false, preferred: false, clear: true, offset: [...span] }, body);
}

/** The whole viewport bottom: it holds her over page content, but is not a place to stay. */
function catchAll(opts: PerchOptions): Perch | null {
  const body = footprint(opts);
  const fit = body && limitsOf(body);
  if (!body || !fit) return null;
  return remember({ el: null, left: fit.left, right: fit.right, y: fit.bottom, input: false, preferred: false, clear: false, offset: [fit.left, fit.right] }, body);
}

/**
 * Anchor positions keeping the whole figure in the viewport; null when the
 * viewport is smaller than the figure.
 */
export function limits(opts: PerchOptions): { left: number; right: number; top: number; bottom: number } | null {
  const body = footprint(opts);
  return body && limitsOf(body);
}

/** The viewport bottom where the whole footprint is clear, or null when none is. */
export function floor(opts: PerchOptions): Perch | null {
  const body = footprint(opts);
  return body ? floorWith(body, scan(opts)) : null;
}

/**
 * The viewport bottom under x: the clear floor when x lies on it, else the
 * catch-all spanning limits() at its bottom. Null only when limits() is.
 */
export function bottom(opts: PerchOptions, x: number): Perch | null {
  const ground = floor(opts);
  return ground && under(ground, x) ? ground : catchAll(opts);
}

/** Discovery and clearance share fixed node, geometry, obstacle and candidate limits. */
export function findPerches(opts: PerchOptions): Perch[] {
  const body = footprint(opts);
  if (!body) return [];
  const data = scan(opts);
  if (!data.complete) return [];
  // Reserve a safe floor before candidate evaluation can consume the work budget.
  const ground = floorWith(body, data);
  const perches: Perch[] = [];
  for (const el of data.candidates) {
    if (data.budget.left <= MAX_ANCESTORS) break;
    const perch = perchWith(el, opts, body, data);
    if (perch) perches.push(perch);
    if (perches.length >= MAX_PERCHES) break;
  }
  if (ground) perches.push(ground);
  return perches;
}

/** Cheap live eligibility/geometry refresh; full clearance runs only on recheck. */
export function refresh(perch: Perch, opts: PerchOptions, recheck = false): Perch | null {
  const body = footprint(opts);
  if (!body) return null;
  if (recheck) return perch.el ? perchWith(perch.el, opts, body, scan(opts)) : floorWith(body, scan(opts));
  const previous = placements.get(perch);
  if (!previous || previous.key !== body.key || previous.vw !== innerWidth || previous.vh !== innerHeight) return null;
  if (!perch.el) return remember({ ...perch }, body);
  const live = metrics(perch.el, opts, body);
  if (!live || live.input !== perch.input || live.rect.width !== previous.width || live.rect.height !== previous.height) return null;
  const [lo, hi] = anchorBounds(live.rect, body);
  const left = Math.max(live.rect.left + perch.offset[0], lo);
  const right = Math.min(live.rect.left + perch.offset[1], hi);
  if (left > right) return null;
  return remember({ ...perch, left, right, y: live.rect.top, input: live.input, preferred: live.preferred }, body, live.rect);
}

/**
 * The perch as it is now if it still holds her at x, else null. Between
 * rechecks this is refresh(), x unused, with the catch-all re-fitted to the
 * current limits. A recheck runs the full clearance and then the hit test
 * under her feet in one pass. The catch-all always holds her and hands her
 * over to clear floor once she stands on it, as bottom(opts, x) does; clear
 * floor that is no longer under her lets her drop onto the catch-all.
 */
export function support(perch: Perch, x: number, opts: PerchOptions, recheck = false): Perch | null {
  if (!perch.clear) return recheck ? bottom(opts, x) : catchAll(opts);
  if (!recheck) return refresh(perch, opts);
  const live = refresh(perch, opts, true);
  // A live recheck means her footprint is valid.
  return live && under(live, x) && (!perch.el || exposed(perch.el, x, live.y, footprint(opts)!, opts.host, undefined, true)) ? live : null;
}

/**
 * Whether she can stand on the perch at x as it is: its edge is on top under
 * her feet, and nothing clickable that rect clearance cannot see stands anywhere
 * in her footprint. The perch's own clearance is not rechecked. Always true on
 * the viewport bottom.
 */
export function clearAt(perch: Perch, x: number, opts: PerchOptions): boolean {
  const body = footprint(opts);
  if (!perch.el) return true;
  return !!body && exposed(perch.el, x, perch.y, body, opts.host, undefined, true);
}

/**
 * How far she can walk along the perch from x toward `to` without covering
 * anything clickable that rect clearance cannot see. Her leading side sweeps
 * the ground she would newly cover in steps at most COLUMN long, at most
 * MAX_STEPS of them, and she stops at the last step that is clear; x when even
 * her first step is not. The viewport bottom has nothing to check.
 */
export function reach(perch: Perch, x: number, to: number, opts: PerchOptions): number {
  const body = footprint(opts);
  if (!perch.el) return to;
  if (!body) return x;
  const lead = to > x ? body.right - INSET : INSET - body.left;
  const steps = Math.min(MAX_STEPS, Math.ceil(Math.abs(to - x) / COLUMN));
  let end = x;
  for (let i = 1; i <= steps; i++) {
    const next = x + ((to - x) * i) / steps;
    if (clickableAbove(next + lead, perch.y, body, opts.host)) break;
    end = next;
  }
  return end;
}

/** Whether the edge is under x, tested as physics.landing() tests it. */
function under(edge: Edge, x: number): boolean {
  return !(x < edge.left || x > edge.right);
}

/** Whether a body falling at x from fromY to toY crosses the edge, as in physics.landing(). */
function crosses(edge: Edge, x: number, fromY: number, toY: number): boolean {
  return under(edge, x) && !(edge.y <= fromY || edge.y > toY);
}

/**
 * Where a body falling at x from fromY to toY lands this frame: the highest
 * crossed edge under x that `holds` accepts, ties in input order. By default it
 * accepts every edge, which picks the perch physics.landing() picks among all
 * refreshed perches; a caller that rechecks each edge returns null to move on to
 * the next one down. One geometry read per element finds the crossed edges;
 * only those are refreshed, highest first, until one holds.
 */
export function crossing(
  perches: readonly Perch[], x: number, fromY: number, toY: number, opts: PerchOptions,
  holds: (perch: Perch) => Perch | null = (perch) => perch,
): Perch | null {
  const crossed: { perch: Perch; y: number }[] = [];
  for (const perch of perches) {
    // A refresh keeps the edge's y and can only narrow this span.
    const rect = perch.el?.getBoundingClientRect();
    const edge: Edge = rect ? { left: rect.left + perch.offset[0], right: rect.left + perch.offset[1], y: rect.top } : perch;
    if (crosses(edge, x, fromY, toY)) crossed.push({ perch, y: edge.y });
  }
  // The sort is stable, so equal edges keep their input order.
  crossed.sort((a, b) => a.y - b.y);
  for (const { perch } of crossed) {
    const live = refresh(perch, opts);
    const landed = live && crosses(live, x, fromY, toY) ? holds(live) : null;
    if (landed) return landed;
  }
  return null;
}
