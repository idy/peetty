import { geometryOf, Motion, type Emote, type Mood } from './motion.ts';
import { RigRenderer, type RigOptions } from './rig.ts';
import type { StateName } from './types.ts';
import { validateFigure } from './validate.ts';

const EMOTES: Record<Emote, string> = { note: '♪', sweat: '💧', alert: '!', sleep: 'z', heart: '♡', dizzy: '✦', flash: '✧' };

export interface FigureViewOptions extends RigOptions {
  /** Display scale relative to the figure's own height. */
  scale?: number;
  /** Follow the pointer with the eyes. */
  track?: boolean;
  /** Seeded randomness for tests. */
  random?: () => number;
  /** Do not run an own frame loop; the host calls {@link FigureView.step}. */
  manual?: boolean;
}

/**
 * A live, animated figure: renderer, animator and its frame loop.
 * Pauses offscreen or while the document is hidden and honours reduced motion.
 */
export class FigureView {
  readonly element: HTMLDivElement;
  readonly renderer: RigRenderer;
  readonly motion: Motion;
  private readonly emote: HTMLSpanElement;
  private shownEmote: Emote | null = null;
  private raf = 0;
  private last = 0;
  private facing: 1 | -1 = 1;
  private readonly cutInset: string;
  private cut = false;
  private readonly reduced: MediaQueryList | null;
  private pointer: [number, number] | null = null;
  private readonly onPointer = (e: PointerEvent) => {
    this.pointer = [e.clientX, e.clientY];
  };
  private readonly onVisibility = () => this.syncPlayback();
  private readonly manual: boolean;
  private observer: IntersectionObserver | null = null;
  private intersecting = true;
  private destroyed = false;
  /** Rendered size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The anchor (feet) in CSS pixels from the element's top-left corner. */
  readonly anchor: [number, number];
  /** viewBox units per CSS pixel. */
  readonly unitsPerPixel: number;

  constructor(figure: unknown, options: FigureViewOptions = {}) {
    const valid = validateFigure(figure);
    if (valid.renderer !== 'rig') throw new Error('Sprite figures are not supported yet.');
    this.renderer = new RigRenderer(valid, options);
    this.motion = new Motion(valid.behavior, options.random, geometryOf(valid));
    const [vx, vy, vw, vh] = valid.viewBox;
    this.cutInset = `${(((vy + vh - valid.anchor[1]) / vh) * 100).toFixed(3)}%`;

    this.element = document.createElement('div');
    this.element.className = 'peetty-figure';
    Object.assign(this.element.style, { position: 'relative', display: 'inline-block', lineHeight: '0' });
    const scale = options.scale ?? 1;
    const svg = this.renderer.svg;
    svg.setAttribute('width', String(Number(svg.getAttribute('width')) * scale));
    svg.setAttribute('height', String(Number(svg.getAttribute('height')) * scale));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', name(valid.name));
    this.width = Number(svg.getAttribute('width'));
    this.height = Number(svg.getAttribute('height'));
    this.unitsPerPixel = vw / this.width;
    this.anchor = [(valid.anchor[0] - vx) / this.unitsPerPixel, (valid.anchor[1] - vy) / this.unitsPerPixel];
    svg.style.transformBox = 'border-box';
    svg.style.transformOrigin = `${this.anchor[0]}px ${this.anchor[1]}px`;
    this.element.append(svg);

    this.emote = document.createElement('span');
    this.emote.setAttribute('aria-hidden', 'true');
    Object.assign(this.emote.style, {
      position: 'absolute', right: '8%', top: '-2%', font: `600 ${Math.round(18 * scale)}px/1 system-ui, sans-serif`,
      color: 'var(--peetty-emote, #7a6ee0)', opacity: '0', transition: 'opacity .25s', pointerEvents: 'none',
    });
    this.element.append(this.emote);

    this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (options.track !== false) addEventListener('pointermove', this.onPointer, { passive: true });
    this.manual = options.manual ?? false;
    if (!this.manual) {
      document.addEventListener('visibilitychange', this.onVisibility);
      if (typeof IntersectionObserver === 'function') {
        this.observer = new IntersectionObserver((entries) => {
          if (this.destroyed) return;
          // Records arrive oldest first, and one notification may hold several for her.
          let latest: IntersectionObserverEntry | null = null;
          for (const entry of entries) if (entry.target === this.element) latest = entry;
          if (!latest) return;
          this.intersecting = latest.isIntersecting;
          this.syncPlayback();
        });
        this.observer.observe(this.element);
      }
      this.syncPlayback();
    }
  }

  /** Display name in the page language. */
  get name(): string {
    return name(this.renderer.figure.name);
  }

  /** Whether the user prefers reduced motion; the view then slows its animation. */
  get reducedMotion(): boolean {
    return this.reduced?.matches ?? false;
  }

  play(state: StateName): void {
    this.motion.play(state);
  }

  setMood(mood: Mood): void {
    this.motion.setMood(mood);
  }

  /** Current facing direction, for hosts replacing the figure view. */
  get direction(): 1 | -1 {
    return this.facing;
  }

  setFacing(direction: 1 | -1): void {
    if (direction === this.facing) return;
    this.facing = direction;
    this.renderer.svg.style.transform = direction === -1 ? 'scaleX(-1)' : '';
  }

  /** Turns the eyes toward a point in client coordinates. */
  lookAt(x: number, y: number): void {
    const box = this.renderer.svg.getBoundingClientRect();
    if (!box.width) return;
    const dx = (x - (box.left + box.width / 2)) / (box.width * 2.5);
    const dy = (y - (box.top + box.height * 0.4)) / (box.height * 2);
    this.renderer.setLook(dx * this.facing, dy);
    this.motion.setGaze(dx * this.facing, dy);
  }

  /** Advances the animation by `dt` seconds. Called each frame; public for tests and previews. */
  step(dt: number): void {
    // Reduced motion: keep the pose readable but drop continuous movement.
    const frame = this.motion.update(this.reducedMotion ? dt * 0.25 : dt);
    // Measure the gaze before this step writes to the DOM, so reading the box does not force a layout.
    if (frame.look) this.renderer.setLook(frame.look[0], frame.look[1]);
    else if (this.pointer) this.lookAt(this.pointer[0], this.pointer[1]);
    this.renderer.setSlots(frame.slots);
    this.renderer.setSoul(frame.soul);
    this.renderer.frame(frame.pose, dt, frame.push);
    if (frame.cut !== this.cut) {
      this.cut = frame.cut;
      // Hide what lies below the perch edge, as if she were behind it.
      this.renderer.svg.style.clipPath = frame.cut ? `inset(-100% -100% ${this.cutInset} -100%)` : '';
    }
    if (frame.emote !== this.shownEmote) {
      this.shownEmote = frame.emote;
      this.emote.textContent = frame.emote ? EMOTES[frame.emote] : '';
      this.emote.style.opacity = frame.emote ? '1' : '0';
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.observer?.disconnect();
    removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.element.remove();
  }

  private canAnimate(): boolean {
    return !this.manual && !this.destroyed && !document.hidden && this.intersecting;
  }

  private syncPlayback(): void {
    if (this.canAnimate()) this.start();
    else this.stop();
  }

  private start() {
    if (this.raf || !this.canAnimate()) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = 0;
      if (!this.canAnimate()) return;
      this.step(Math.min((now - this.last) / 1000, 0.1));
      this.last = now;
      if (this.canAnimate()) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

function name(text: string | Record<string, string>): string {
  if (typeof text === 'string') return text;
  const lang = (globalThis.navigator?.language ?? 'en').slice(0, 2);
  return text[lang] ?? text.en ?? Object.values(text)[0] ?? 'Peetty';
}
