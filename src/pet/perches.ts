import type { Edge } from './physics.ts';

/**
 * Finding places to stand: the visible top edges of page elements that have
 * a visible edge (a background, border, shadow or a control), with free
 * space above them. Text and controls above an edge are never covered.
 */

export interface Perch extends Edge {
  /** The element whose top edge this is; null for the bottom of the viewport. */
  el: Element | null;
  /** A form field: she may sit or lie on it while it is not in use, never walk. */
  input: boolean;
  /** Marked by the page with data-peetty="perch". */
  preferred: boolean;
  /** The free span relative to the element's left edge, so it follows the element. */
  offset: [number, number];
}

export interface PerchOptions {
  /** Our own overlay, ignored during hit testing. */
  host: Element;
  /** Figure size in CSS pixels. */
  width: number;
  height: number;
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

/** The topmost page element at a point, ignoring the overlay. */
export function topAt(x: number, y: number, host: Element): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host || host.contains(el)) continue;
    return el;
  }
  return null;
}

export function isEditable(el: Element | null): boolean {
  return !!el && el.matches(EDITABLE);
}

/** True when the element is in use: focused, or containing the focus. */
export function inUse(el: Element | null): boolean {
  const active = document.activeElement;
  return !!el && !!active && active !== document.body && (el === active || el.contains(active));
}

function avoided(el: Element): boolean {
  return !!el.closest('[data-peetty="avoid"]');
}

function visibleEdge(el: Element, style: CSSStyleDeclaration): boolean {
  if (SOLID_TAGS.has(el.tagName.toUpperCase())) return true;
  if ((el as HTMLElement).dataset?.peetty === 'perch') return true;
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

/** Text or a control at a point, which she must not cover. */
function occupied(x: number, y: number, host: Element): boolean {
  const el = topAt(x, y, host);
  if (!el) return false;
  if (el.closest(INTERACTIVE)) return true;
  if (MEDIA_TAGS.has(el.tagName.toUpperCase())) return true;
  let checked = 0;
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    if (++checked > 24) break;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) return true;
    }
  }
  return false;
}

/** The free stretch of an edge, or null if too little of it is free. */
function freeSpan(left: number, right: number, y: number, opts: PerchOptions, input: boolean): [number, number] | null {
  const step = 14;
  const heights = input ? [6, opts.height * 0.45] : [6, opts.height * 0.4, opts.height * 0.85];
  let best: [number, number] | null = null;
  let start: number | null = null;
  for (let x = left; x <= right + 0.1; x += step) {
    const free = heights.every((h) => y - h < 0 || !occupied(x, y - h, opts.host));
    if (free && start === null) start = x;
    if ((!free || x + step > right + 0.1) && start !== null) {
      const end = free ? x : x - step;
      if (!best || end - start > best[1] - best[0]) best = [start, end];
      start = null;
    }
  }
  const need = input ? opts.width * 0.5 : opts.width * 0.7;
  return best && best[1] - best[0] >= need ? best : null;
}

/** Checks an element's top edge; returns a perch or null. */
export function perchOf(el: Element, opts: PerchOptions): Perch | null {
  const vw = innerWidth;
  const vh = innerHeight;
  if (el === document.body || el === document.documentElement || avoided(el)) return null;
  if (el === opts.host || opts.host.contains(el)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < opts.width * 0.8 || rect.height < 14) return null;
  if (rect.top < opts.height * 0.6 || rect.top > vh - 8) return null;
  if (rect.right < 20 || rect.left > vw - 20) return null;
  const style = getComputedStyle(el);
  if (style.visibility !== 'visible' || Number(style.opacity) < 0.2) return null;
  if (!visibleEdge(el, style)) return null;

  const input = isEditable(el);
  if (input) {
    if (el instanceof HTMLInputElement && SKIP_INPUTS.has(el.type)) return null;
    if (inUse(el) || (el as HTMLInputElement).disabled) return null;
  }

  const left = Math.max(rect.left, 0) + 6;
  const right = Math.min(rect.right, vw) - 6;
  // The edge must actually be on top at its middle, not covered by something.
  const mid = (left + right) / 2;
  const hit = topAt(mid, rect.top + 2, opts.host);
  if (!hit || (hit !== el && !el.contains(hit))) return null;

  const span = freeSpan(left, right, rect.top, opts, input);
  if (!span) return null;
  return {
    el, left: span[0], right: span[1], y: rect.top, input,
    preferred: (el as HTMLElement).dataset?.peetty === 'perch',
    offset: [span[0] - rect.left, span[1] - rect.left],
  };
}

/** The bottom of the viewport, always available. */
export function floor(): Perch {
  return { el: null, left: 0, right: innerWidth, y: innerHeight, input: false, preferred: false, offset: [0, innerWidth] };
}

/** Scans the visible page for perches. Bounded: about 150 hit tests. */
export function findPerches(opts: PerchOptions): Perch[] {
  const vw = innerWidth;
  const vh = innerHeight;
  const seen = new Set<Element>();
  const candidates: Element[] = [...document.querySelectorAll('[data-peetty="perch"]')];
  const cols = Math.max(4, Math.min(12, Math.round(vw / 110)));
  const rows = Math.max(4, Math.min(10, Math.round(vh / 90)));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = ((i + 0.5) / cols) * vw;
      const y = ((j + 0.5) / rows) * vh;
      let depth = 0;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === opts.host || opts.host.contains(el)) continue;
        if (++depth > 5) break;
        candidates.push(el);
      }
    }
  }
  const perches: Perch[] = [];
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    const perch = perchOf(el, opts);
    if (perch) perches.push(perch);
    if (perches.length >= 40) break;
  }
  return [...perches, floor()];
}

/**
 * Re-reads a perch's live position as the page scrolls or changes; null when
 * it is gone, hidden, out of view, or a field that came into use.
 */
export function refresh(perch: Perch): Perch | null {
  if (!perch.el) return floor();
  const el = perch.el;
  // A field coming into use is handled by the pet (it hops away), not by dropping her.
  if (!el.isConnected || avoided(el)) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.top < 0 || rect.top > innerHeight) return null;
  const left = Math.max(rect.left + perch.offset[0], 0);
  const right = Math.min(rect.left + perch.offset[1], innerWidth);
  if (right - left < 10) return null;
  return { ...perch, left, right, y: rect.top };
}

/** Whether something now covers the edge at x (a menu or dialog opened over it). */
export function covered(perch: Perch, x: number, host: Element): boolean {
  if (!perch.el) return false;
  const hit = topAt(x, perch.y + 2, host);
  return !!hit && hit !== perch.el && !perch.el.contains(hit);
}
