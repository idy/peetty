import type { Strings } from './i18n.ts';

/**
 * The overlay: one fixed, click-through host element with a shadow root, so
 * page styles cannot reach in and ours cannot leak out. Only the figure's
 * painted shapes, the menu and the bubble take pointer events.
 */

const STYLE = `
:host { all: initial; }
.stage { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
.pet { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; transition: opacity .35s ease; }
.pet.gone { opacity: 0; }
.pet.gone svg * { pointer-events: none; }
.pet svg { display: block; touch-action: none; user-select: none; -webkit-user-select: none; }
.pet svg * { pointer-events: visiblePainted; cursor: grab; }
.pet.dragging svg * { cursor: grabbing; }
.pet:focus-visible { outline: 2px solid var(--peetty-accent, #7a6ee0); outline-offset: 3px; border-radius: 12px; }
.float { position: absolute; left: 0; top: 0; pointer-events: none; transform-origin: 50% 100%; }
.bubble {
  position: relative;
  max-width: 220px; padding: 8px 12px; border-radius: 14px; box-sizing: border-box;
  font: 500 13px/1.45 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--peetty-ink, #2b2840); background: var(--peetty-surface, #ffffff);
  border: 1px solid var(--peetty-line, #e2deef); box-shadow: 0 6px 18px rgba(40, 30, 80, .14);
  overflow-wrap: anywhere; opacity: 0; transform: translateY(6px) scale(.96);
  transition: opacity .18s ease, transform .18s ease;
}
.bubble.show { opacity: 1; transform: none; }
.bubble::after {
  content: ""; position: absolute; left: var(--tail, 50%); bottom: -6px; width: 10px; height: 10px;
  margin-left: -5px; transform: rotate(45deg); background: inherit;
  border-right: 1px solid var(--peetty-line, #e2deef); border-bottom: 1px solid var(--peetty-line, #e2deef);
}
.menu {
  display: flex; flex-wrap: wrap; justify-content: center; width: max-content; max-width: calc(100vw - 12px); gap: 4px; padding: 4px; border-radius: 16px;
  background: var(--peetty-surface, #ffffff); border: 1px solid var(--peetty-line, #e2deef);
  box-shadow: 0 6px 18px rgba(40, 30, 80, .14); opacity: 0; transform: translateY(4px);
  transition: opacity .15s ease, transform .15s ease; visibility: hidden;
}
.menu.show { opacity: 1; transform: none; visibility: visible; pointer-events: auto; }
.menu button {
  all: unset; box-sizing: border-box; padding: 5px 10px; border-radius: 999px; cursor: pointer; white-space: nowrap;
  font: 600 12px/1.2 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--peetty-ink, #2b2840);
}
.menu button[hidden] { display: none !important; }
.menu button:hover { background: var(--peetty-hover, #f1eefa); }
.menu button:focus-visible { outline: 2px solid var(--peetty-accent, #7a6ee0); outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
  .bubble, .menu { --peetty-ink: #eeeaf8; --peetty-surface: #2a2738; --peetty-line: #3d3952; --peetty-hover: #38344b; }
}
@media (prefers-reduced-motion: reduce) {
  .bubble, .menu, .pet { transition: none; }
}
`;

export type MenuAction = 'chat' | 'greet' | 'move' | 'nap' | 'configure' | 'hide';

export interface BoxSize {
  width: number;
  height: number;
}

export interface Overlay {
  host: HTMLElement;
  pet: HTMLDivElement;
  bubble: HTMLDivElement;
  bubbleBox: HTMLDivElement;
  menu: HTMLDivElement;
  menuBox: HTMLDivElement;
  measure: (inner: HTMLElement) => BoxSize;
  invalidate: (inner?: HTMLElement) => void;
  destroy: () => void;
}

export function createOverlay(text: Strings, zIndex: number, onAction: (action: MenuAction) => void): Overlay {
  const host = document.createElement('peetty-companion');
  Object.assign(host.style, {
    position: 'fixed', inset: '0', display: 'block', pointerEvents: 'none', zIndex: String(zIndex),
    margin: '0', padding: '0', border: '0', background: 'none', contain: 'layout style',
  });
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const stage = document.createElement('div');
  stage.className = 'stage';

  const pet = document.createElement('div');
  pet.className = 'pet';
  pet.setAttribute('data-peetty', 'avoid');
  pet.setAttribute('role', 'button');
  pet.setAttribute('tabindex', '0');
  pet.setAttribute('aria-label', text.pet);
  pet.setAttribute('aria-haspopup', 'dialog');

  const bubbleBox = document.createElement('div');
  bubbleBox.className = 'float';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.setAttribute('role', 'status');
  bubbleBox.append(bubble);

  const menuBox = document.createElement('div');
  menuBox.className = 'float';
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', text.menu);
  for (const action of ['chat', 'greet', 'move', 'nap', 'configure', 'hide'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-action', action);
    button.textContent = text[action];
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onAction(action);
    });
    menu.append(button);
  }
  menuBox.append(menu);

  stage.append(pet, menuBox, bubbleBox);
  root.append(style, stage);
  const sizes = new Map<HTMLElement, BoxSize>();
  const invalidate = (inner?: HTMLElement) => { if (inner) sizes.delete(inner); else sizes.clear(); };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const entry of entries) invalidate(entry.target as HTMLElement);
  }) : null;
  observer?.observe(menu);
  observer?.observe(bubble);
  const measure = (inner: HTMLElement): BoxSize => {
    let size = sizes.get(inner);
    if (!size) {
      size = { width: inner.offsetWidth, height: inner.offsetHeight };
      sizes.set(inner, size);
    }
    return size;
  };
  const destroy = () => {
    observer?.disconnect();
    sizes.clear();
    host.remove();
  };
  return { host, pet, bubble, bubbleBox, menu, menuBox, measure, invalidate, destroy };
}

/** Places a floating box centred above a point, kept inside the viewport. */
export function placeAbove(box: HTMLElement, x: number, y: number, inner: HTMLElement, { width, height }: BoxSize) {
  const left = Math.max(6, Math.min(innerWidth - width - 6, x - width / 2));
  const top = Math.max(6, y - height);
  box.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
  inner.style.setProperty('--tail', `${Math.max(14, Math.min(width - 14, x - left)).toFixed(1)}px`);
}
