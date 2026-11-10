import { imageColorOf, type ImageColor } from './image-color.ts';
import { RigRenderer, type RigOptions } from './rig.ts';
import { unitOf, type Figure } from './types.ts';

export type PortraitMood = 'calm' | 'happy' | 'think' | 'talk';

/** Head crop in the units of a 260-unit-tall figure: square side, and how far its top sits above the neck. */
const CROP_SIDE = 124;
const CROP_RISE = 112;
const TICK = 170;
/** One blink every few seconds. */
const BLINK_EVERY = 24;
const TALK = ['talk', 'smile', 'open', 'smile'] as const;
const SVG = 'http://www.w3.org/2000/svg';
let faces = 0;

export interface Portrait {
  /** Her face, drawn from her own rig; square, sized by its container. */
  readonly element: SVGSVGElement;
  readonly color: ImageColor;
  /**
   * A still of her calm face for avatars that need no life. It reuses this portrait's drawing,
   * so it shows only while {@link element} is rendered in the same document or shadow tree.
   */
  stamp: () => SVGSVGElement;
  setMood: (mood: PortraitMood) => void;
  /** Blinks and talks only while live, so a hidden portrait runs no timer. */
  setLive: (live: boolean) => void;
  destroy: () => void;
}

/** A head-and-shoulders portrait of a rig figure, or null for figures without a rig. */
export function createPortrait(figure: Figure, options: RigOptions = {}): Portrait | null {
  if (figure.renderer !== 'rig') return null;
  const renderer = new RigRenderer(figure, options);
  const svg = renderer.svg;
  const unit = unitOf(figure.viewBox);
  const [x, y] = figure.skeleton.head.pivot;
  const side = CROP_SIDE * unit;
  svg.setAttribute('viewBox', [x - side / 2, y - CROP_RISE * unit, side, side].map((v) => +v.toFixed(2)).join(' '));
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('overflow', 'hidden');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.overflow = 'hidden';
  svg.style.display = 'block';

  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let mood: PortraitMood = 'calm';
  let live = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tick = 0;
  let looking = false;

  function draw() {
    const blink = live && mood !== 'happy' && tick % BLINK_EVERY === BLINK_EVERY - 1;
    renderer.setSlots({
      eyes: blink ? 'closed' : mood === 'happy' ? 'happy' : 'open',
      mouth: mood === 'talk' ? TALK[tick % TALK.length]! : mood === 'happy' ? 'open' : mood === 'think' ? 'flat' : 'smile',
      brows: 'calm',
    });
    // Thinking, she looks up and away. Only a change of gaze needs the parts redrawn.
    const away = mood === 'think';
    if (away !== looking) {
      looking = away;
      renderer.setLook(away ? -0.7 : 0, away ? -1 : 0);
      renderer.frame({}, 0);
    }
  }
  function sync() {
    const run = live && !document.hidden && !reduced?.matches;
    if (run && timer === undefined) {
      timer = setInterval(() => { tick += 1; draw(); }, TICK);
      // Under Node, a portrait must not keep the process alive.
      (timer as { unref?: () => void }).unref?.();
    } else if (!run && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      tick = 0;
    }
    draw();
  }
  document.addEventListener('visibilitychange', sync);
  reduced?.addEventListener('change', sync);
  draw();
  // Her calm face, kept once as a symbol; each stamp is a single reference to it.
  const id = `peetty-face-${++faces}`;
  const symbol = document.createElementNS(SVG, 'symbol');
  symbol.id = id;
  symbol.setAttribute('viewBox', svg.getAttribute('viewBox')!);
  const defs = svg.firstChild!;
  for (const child of [...svg.childNodes]) if (child !== defs) symbol.append(child.cloneNode(true));
  defs.appendChild(symbol);
  return {
    element: svg,
    color: imageColorOf(figure),
    stamp() {
      const face = document.createElementNS(SVG, 'svg');
      for (const [key, value] of [['width', '100%'], ['height', '100%'], ['aria-hidden', 'true']] as const) face.setAttribute(key, value);
      face.style.display = 'block';
      const use = document.createElementNS(SVG, 'use');
      for (const [key, value] of [['href', `#${id}`], ['width', '100%'], ['height', '100%']] as const) use.setAttribute(key, value);
      face.append(use);
      return face;
    },
    setMood(next) { if (next !== mood) { mood = next; draw(); } },
    setLive(next) { if (next !== live) { live = next; sync(); } },
    destroy() {
      live = false; sync(); renderer.destroy();
      document.removeEventListener('visibilitychange', sync);
      reduced?.removeEventListener('change', sync);
    },
  };
}
