import { FigureView } from '../figure/view.ts';
import type { Figure, StateName } from '../figure/types.ts';
import { resolveFigure } from '../presets.ts';
import { languageOf, strings, type Language, type Strings } from './i18n.ts';
import { covered, findPerches, floor, inUse, isEditable, refresh, type Perch } from './perches.ts';
import { along, GRAVITY, impact, landing, planJump, weighted, type Jump } from './physics.ts';
import { createOverlay, placeAbove, type MenuAction, type Overlay } from './ui.ts';

export type Activity = 'calm' | 'normal' | 'lively';

export interface PeettyOptions {
  /** A catalog id (`miru`, or any id at peetty.idy.dev/figures/), a URL to a figure JSON file, or figure data. */
  figure?: string | object;
  /** Height in CSS pixels; defaults to the figure's own height. */
  size?: number;
  /** How often she walks and jumps. */
  activity?: Activity;
  /** Palette overrides, e.g. `{ "hair": "#9fd3c7" }`. */
  palette?: Record<string, string>;
  /** Interface language; `auto` follows the browser. */
  language?: Language | 'auto';
  /** Say hello when she first lands. */
  greet?: boolean;
  /** Overlay stacking order. */
  zIndex?: number;
}

type Mode = 'ground' | 'jump' | 'fall' | 'drag' | 'hang' | 'paused';
type Action = 'idle' | 'walk' | 'sit' | 'lie' | 'sleep' | 'think' | 'wave' | 'talk';

const BASE: Record<string, number> = { idle: 3, walk: 3, jump: 2, sit: 2, lie: 1, sleep: 0.6, think: 0.4 };
const ACTIVITY: Record<Activity, Record<string, number>> = {
  calm: { walk: 0.5, jump: 0.35, sit: 1.6, lie: 1.3, sleep: 1.6 },
  normal: {},
  lively: { walk: 1.4, jump: 1.9, sit: 0.7, sleep: 0.5 },
};
const DURATION: Record<string, [number, number]> = {
  idle: [2.5, 6], sit: [8, 18], lie: [8, 16], sleep: [12, 25], think: [3, 5], wave: [1.7, 1.7],
};
const TYPING_QUIET = 4000;

/**
 * A companion living on the page: she stands on the top edges of visible
 * elements, walks and jumps between them, follows them as the page scrolls,
 * falls when one disappears, and keeps clear of the fields you are using.
 */
export class Peetty {
  private options: PeettyOptions;
  private text: Strings;
  private overlay: Overlay | null = null;
  private view: FigureView | null = null;
  private figure: Figure | null = null;
  private raf = 0;
  private last = 0;
  /** Frame time in ms; every timing decision uses this clock. */
  private clock = 0;
  private mode: Mode = 'paused';
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private perch: Perch | null = null;
  private perches: Perch[] = [];
  private scanned = -Infinity;
  private action: Action = 'idle';
  private until = 0;
  private walkTo = 0;
  private jump: { from: [number, number]; plan: Jump; t: number; target: Perch; hang: boolean } | null = null;
  private hangUntil = 0;
  private coverCheck = 0;
  private lastKey = -Infinity;
  private lastGreet = -Infinity;
  private pointer: [number, number] | null = null;
  private press: { x: number; y: number; id: number } | null = null;
  private dragTrail: [number, number, number][] = [];
  private menuTimer = 0;
  private bubbleTimer = 0;
  private hovering = false;
  private hidden = false;
  private readonly reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor(options: PeettyOptions = {}) {
    this.options = options;
    this.text = strings(languageOf(options.language));
  }

  /** True once mounted and drawn. */
  get mounted(): boolean {
    return !!this.view;
  }

  /** Adds her to the page. Resolves when the figure is loaded. */
  async mount(): Promise<void> {
    if (this.overlay) return;
    this.figure = await resolveFigure(this.options.figure);
    this.overlay = createOverlay(this.text, this.options.zIndex ?? 2147483000, (action) => this.onMenu(action));
    document.documentElement.append(this.overlay.host);
    this.attachView();
    this.bind();
    this.enter();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Removes her and every listener. */
  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unbind();
    this.view?.destroy();
    this.overlay?.host.remove();
    this.view = null;
    this.overlay = null;
    this.mode = 'paused';
  }

  /** Switches to another figure where she stands. */
  async setFigure(figure: string | object): Promise<void> {
    this.figure = await resolveFigure(figure);
    this.options = { ...this.options, figure };
    if (!this.overlay) return;
    this.view?.destroy();
    this.attachView();
    this.view!.motion.land(0.3);
  }

  /** Shows a speech bubble; she talks while it is up. */
  say(text: string, seconds = Math.min(6, 1.8 + text.length * 0.08)): void {
    if (!this.overlay || !this.view) return;
    const { bubble } = this.overlay;
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), seconds * 1000);
    if (this.mode === 'ground' && this.action !== 'lie' && this.action !== 'sit') {
      this.setAction('talk', Math.min(seconds, 2.6));
    }
  }

  /** Plays an animation state once, as if she chose it. */
  play(state: Extract<StateName, Action>): void {
    if (this.mode === 'ground') this.setAction(state as Action, DURATION[state]?.[0] ?? 3);
  }

  hide(): void {
    if (!this.overlay) return;
    this.hidden = true;
    this.overlay.host.style.display = 'none';
  }

  show(): void {
    if (!this.overlay || !this.hidden) return;
    this.hidden = false;
    this.overlay.host.style.display = 'block';
    this.last = performance.now();
    this.enter();
  }

  // ---------------------------------------------------------------- setup

  private attachView() {
    const figure = this.figure!;
    const size = this.options.size ?? figure.height;
    this.view = new FigureView(figure, {
      scale: size / figure.height,
      manual: true,
      ...(this.options.palette ? { palette: this.options.palette } : {}),
    });
    this.overlay!.pet.replaceChildren(this.view.element);
  }

  /** Drops in from the top of the viewport above a good perch. */
  private enter() {
    const perches = this.scan(true);
    const choices = perches.filter((p) => p.el);
    const preferred = choices.filter((p) => p.preferred);
    const pool = preferred.length ? preferred : choices.length ? choices : perches;
    const target = pool[Math.floor(Math.random() * pool.length)]!;
    const half = this.view!.width / 2;
    this.x = clamp(target.left + Math.random() * (target.right - target.left), half, innerWidth - half);
    this.y = Math.min(target.y - 40, this.view!.height * 0.6);
    this.vx = 0;
    this.vy = 0;
    this.startFall();
  }

  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  private bind() {
    const on = (target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push([target, type, fn as EventListener, opts]);
    };
    const pet = this.overlay!.pet;
    const menu = this.overlay!.menu;
    on(pet, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(window, 'pointermove', (e: PointerEvent) => this.onMove(e), { passive: true });
    on(window, 'pointerup', (e: PointerEvent) => this.onUp(e));
    on(window, 'pointercancel', () => this.onUp(null));
    on(pet, 'pointerover', () => this.hover(true));
    on(pet, 'pointerout', () => this.hover(false));
    on(menu, 'pointerover', () => this.hover(true));
    on(menu, 'pointerout', () => this.hover(false));
    on(document, 'focusin', (e: FocusEvent) => this.onFocus(e.target as Element), { capture: true });
    on(document, 'keydown', (e: KeyboardEvent) => this.onKey(e), { capture: true });
    on(window, 'resize', () => { this.scanned = -Infinity; });
  }

  private unbind() {
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    clearTimeout(this.menuTimer);
    clearTimeout(this.bubbleTimer);
  }

  // ------------------------------------------------------------ the loop

  private readonly tick = (frame: number) => {
    let now = frame;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.clock += dt * 1000;
    now = this.clock;
    if (this.hidden || !this.view) return;
    switch (this.mode) {
      case 'ground': this.ground(now, dt); break;
      case 'jump': this.flying(dt); break;
      case 'fall': this.falling(dt); break;
      case 'hang': this.hanging(now); break;
      case 'drag': break;
      case 'paused': return;
    }
    this.view.step(dt);
    this.place();
  };

  private ground(now: number, dt: number) {
    const live = this.perch && refresh(this.perch);
    if (!live) return this.startFall();
    if (now > this.coverCheck) {
      this.coverCheck = now + 300;
      if (covered(live, this.x, this.overlay!.host)) return this.startFall();
    }
    this.perch = live;
    this.y = live.y;
    // Backstop for focus events that do not reach us (e.g. focus set by script).
    if (live.input && inUse(live.el)) return this.makeRoom(live.el!);
    const half = live.el ? 0 : this.view!.width / 2;
    this.x = clamp(this.x, live.left + half, live.right - half);

    if (this.action === 'walk') {
      const speed = 52 * (this.figure!.behavior?.walkSpeed ?? 1);
      const dx = this.walkTo - this.x;
      this.view!.motion.setWalkSpeed(speed * this.view!.unitsPerPixel);
      if (Math.abs(dx) < 2) this.setAction('idle', rand(0.8, 2));
      else {
        this.face(Math.sign(dx));
        this.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
      }
    } else if (now / 1000 > this.until) this.decide();

    // A friendly wave when the pointer comes close, now and then.
    if (this.pointer && this.action === 'idle' && now - this.lastGreet > 25000 && !this.reducedMotion) {
      const dx = this.pointer[0] - this.x;
      const dy = this.pointer[1] - (this.y - this.view!.height / 2);
      if (dx * dx + dy * dy < 150 * 150) {
        this.lastGreet = now;
        this.face(Math.sign(dx) || 1);
        this.setAction('wave', DURATION.wave![0]);
      }
    }
  }

  private flying(dt: number) {
    const jump = this.jump!;
    jump.t += dt;
    // t starts negative: she crouches in place before take-off.
    if (jump.t < 0) return;
    const target = refresh(jump.target);
    const [x, y] = along(jump.from, jump.plan, Math.min(jump.t, jump.plan.duration));
    // Follow a target that moves during the flight (scrolling).
    const drift = target ? (target.y - jump.target.y) * Math.min(1, jump.t / jump.plan.duration) : 0;
    this.x = x;
    this.y = y + drift;
    if (!target) {
      this.vx = jump.plan.vx;
      this.vy = jump.plan.vy + GRAVITY * jump.t;
      return this.startFall();
    }
    if (jump.t >= jump.plan.duration) {
      this.y = target.y;
      if (jump.hang) {
        this.perch = target;
        this.mode = 'hang';
        this.hangUntil = this.clock + 1500;
        this.view!.motion.play('hang');
      } else this.land(target, impact(jump.plan.vy + GRAVITY * jump.t) * 0.7);
    }
  }

  private falling(dt: number) {
    const fromY = this.y;
    // An open umbrella brakes quickly to a gentle float.
    const cap = this.figure!.behavior?.fallProp === 'umbrella' ? 300 : 2400;
    this.vy = this.vy > cap ? Math.max(cap, this.vy - 3000 * dt) : Math.min(this.vy + GRAVITY * dt, cap);
    this.vx *= Math.exp(-dt * 1.5);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const half = this.view!.width / 2;
    if (this.x < half || this.x > innerWidth - half) {
      this.x = clamp(this.x, half, innerWidth - half);
      this.vx = -this.vx * 0.4;
    }
    const live = this.perches.map((p) => refresh(p)).filter((p): p is Perch => !!p);
    const hit = landing(live, this.x, fromY, this.y) as Perch | null;
    if (hit) return this.land(hit, impact(this.vy));
    if (this.y >= innerHeight) this.land(floor(), impact(this.vy));
  }

  private hanging(now: number) {
    const live = this.perch && refresh(this.perch);
    if (!live) return this.startFall();
    this.perch = live;
    this.y = live.y;
    if (now > this.hangUntil) this.land(live, 0.25);
  }

  private place() {
    const view = this.view!;
    const { pet, bubbleBox, bubble, menuBox, menu } = this.overlay!;
    pet.style.transform = `translate3d(${(this.x - view.anchor[0]).toFixed(1)}px, ${(this.y - view.anchor[1]).toFixed(1)}px, 0)`;
    const low = this.mode === 'ground' && (this.action === 'sit' || this.action === 'lie');
    const head = this.y - view.height * (low ? 0.62 : 0.98);
    const menuUp = menu.classList.contains('show');
    if (menuUp) placeAbove(menuBox, this.x, head - 4, menu);
    if (bubble.classList.contains('show')) placeAbove(bubbleBox, this.x, head - (menuUp ? menu.offsetHeight + 10 : 8), bubble);
  }

  // ------------------------------------------------------------ decisions

  private get reducedMotion(): boolean {
    return !!this.reduced?.matches;
  }

  private decide() {
    const perch = this.perch!;
    const typing = this.clock - this.lastKey < TYPING_QUIET;
    const weights: Record<string, number> = { ...BASE };
    for (const [key, w] of Object.entries(this.figure!.behavior?.weights ?? {})) if (typeof w === 'number') weights[key] = w;
    for (const [key, k] of Object.entries(ACTIVITY[this.options.activity ?? 'normal'])) {
      if (key in weights) weights[key] = weights[key]! * k;
    }
    delete weights.wave;
    delete weights.talk;
    if (this.reducedMotion || typing) {
      delete weights.walk;
      delete weights.jump;
    }
    if (perch.input) {
      // A field is for sitting or lying on, never for walking along.
      for (const key of ['idle', 'walk', 'think', 'sleep']) delete weights[key];
    }
    if (perch.right - perch.left < this.view!.width) delete weights.walk;
    const choice = weighted(weights) ?? 'idle';
    if (choice === 'jump') {
      if (!this.leap()) this.setAction('idle', rand(1.5, 3));
      return;
    }
    if (choice === 'walk') {
      const half = this.view!.width / 2;
      const lo = perch.left + (perch.el ? 0 : half);
      const hi = perch.right - (perch.el ? 0 : half);
      this.walkTo = lo + Math.random() * Math.max(0, hi - lo);
      if (Math.abs(this.walkTo - this.x) < 20) return this.setAction('idle', rand(1.5, 3));
      this.action = 'walk';
      this.view!.motion.play('walk');
      return;
    }
    const [min, max] = DURATION[choice] ?? [3, 6];
    this.setAction(choice as Action, rand(min, max));
  }

  private setAction(action: Action, seconds: number) {
    this.action = action;
    this.until = this.clock / 1000 + seconds;
    this.view!.motion.play(action);
  }

  /** Jumps to another perch in reach; false if there is none. */
  private leap(exclude: Element | null = null, away = false): boolean {
    const perches = this.scan();
    const from: [number, number] = [this.x, this.y];
    const power = this.figure!.behavior?.jumpPower ?? 1;
    const options: { perch: Perch; to: [number, number]; plan: Jump; weight: number }[] = [];
    for (const perch of perches) {
      if (perch.el === this.perch?.el || (exclude && perch.el === exclude)) continue;
      const span = perch.right - perch.left;
      const to: [number, number] = [perch.left + span * (0.2 + Math.random() * 0.6), perch.y];
      if (!perch.el) to[0] = clamp(to[0], this.view!.width / 2, innerWidth - this.view!.width / 2);
      if (away && exclude) {
        const r = exclude.getBoundingClientRect();
        if (to[0] > r.left - 40 && to[0] < r.right + 40 && Math.abs(to[1] - r.top) < 80) continue;
      }
      const plan = planJump(from, to, power);
      if (!plan) continue;
      const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const weight = (perch.preferred ? 3 : 1) * (perch.el ? 1 : 0.35) * (1 / (1 + distance / 260));
      options.push({ perch, to, plan, weight });
    }
    if (!options.length) return false;
    let r = Math.random() * options.reduce((s, o) => s + o.weight, 0);
    const pick = options.find((o) => (r -= o.weight) <= 0) ?? options[0]!;
    // Upward jumps that are a little too far end hanging from the edge.
    const rise = from[1] - pick.to[1];
    const hang = rise > 110 && !pick.perch.input && Math.random() < 0.25;
    this.face(Math.sign(pick.to[0] - from[0]) || 1);
    this.jump = { from, plan: pick.plan, t: -0.18, target: pick.perch, hang };
    this.mode = 'jump';
    this.perch = null;
    this.view!.motion.play('jump');
    return true;
  }

  private startFall() {
    this.mode = 'fall';
    this.perch = null;
    this.jump = null;
    this.scan();
    this.view!.motion.play('fall');
  }

  private land(perch: Perch, strength: number) {
    this.perch = perch;
    this.mode = 'ground';
    this.y = perch.y;
    this.vx = 0;
    this.vy = 0;
    this.jump = null;
    const half = perch.el ? 0 : this.view!.width / 2;
    this.x = clamp(this.x, perch.left + half, perch.right - half);
    this.view!.motion.land(strength);
    this.action = 'idle';
    this.until = this.clock / 1000 + (strength > 0.85 ? 1.8 : rand(0.6, 1.4));
    if (perch.input) this.until = this.clock / 1000 + 0.5;
    if (this.options.greet !== false && this.lastGreet === -Infinity && this.figure) {
      this.lastGreet = this.clock;
      window.setTimeout(() => this.say(pickOne(this.text.hello)), 700);
    }
  }

  private scan(force = false): Perch[] {
    const now = this.clock;
    if (force || now - this.scanned > 1200) {
      this.perches = findPerches({ host: this.overlay!.host, width: this.view!.width, height: this.view!.height });
      this.scanned = now;
    }
    return this.perches;
  }

  private face(direction: number) {
    if (direction) this.view!.setFacing(direction < 0 ? -1 : 1);
  }

  // --------------------------------------------------------- interaction

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.view) return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.preventDefault();
  }

  private onMove(e: PointerEvent) {
    this.pointer = [e.clientX, e.clientY];
    if (!this.press || e.pointerId !== this.press.id) return;
    if (this.mode !== 'drag') {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < 5) return;
      this.mode = 'drag';
      this.perch = null;
      this.jump = null;
      this.overlay!.pet.classList.add('dragging');
      this.overlay!.menu.classList.remove('show');
      this.view!.motion.play('drag');
      this.dragTrail = [];
    }
    // Held by the top of the head.
    this.x = e.clientX;
    this.y = e.clientY + this.view!.height * 0.8;
    this.dragTrail.push([performance.now(), this.x, this.y]); // real time: pointer speed
    if (this.dragTrail.length > 6) this.dragTrail.shift();
    this.view!.step(0);
    this.place();
  }

  private onUp(e: PointerEvent | null) {
    const press = this.press;
    this.press = null;
    if (!press || (e && e.pointerId !== press.id)) return;
    if (this.mode === 'drag') {
      this.overlay!.pet.classList.remove('dragging');
      const first = this.dragTrail[0];
      const last = this.dragTrail[this.dragTrail.length - 1];
      const span = first && last ? (last[0] - first[0]) / 1000 : 0;
      this.vx = span > 0.01 ? clamp((last![1] - first![1]) / span, -900, 900) : 0;
      this.vy = span > 0.01 ? clamp((last![2] - first![2]) / span, -900, 900) : 0;
      this.startFall();
    } else if (e) this.greet();
  }

  private hover(on: boolean) {
    this.hovering = on;
    clearTimeout(this.menuTimer);
    const menu = this.overlay?.menu;
    if (!menu) return;
    this.menuTimer = window.setTimeout(() => {
      if (this.hovering && this.mode !== 'drag') menu.classList.add('show');
      else if (!this.hovering) menu.classList.remove('show');
    }, on ? 280 : 650);
  }

  private onMenu(action: MenuAction) {
    this.overlay!.menu.classList.remove('show');
    if (action === 'greet') this.greet();
    else if (action === 'move') {
      if (this.mode === 'ground' && !this.leap()) this.say(pickOne(this.text.hello));
    } else if (action === 'nap') {
      if (this.mode === 'ground') this.setAction(this.perch?.input ? 'lie' : 'sleep', 20);
    } else if (action === 'hide') this.hide();
  }

  private greet() {
    if (this.mode !== 'ground') return;
    this.lastGreet = this.clock;
    if (this.pointer) this.face(Math.sign(this.pointer[0] - this.x) || 1);
    this.setAction('wave', DURATION.wave![0]);
    window.setTimeout(() => this.say(pickOne(this.text.hello)), 350);
  }

  private onFocus(target: Element | null) {
    if (!target || !isEditable(target) || !this.view) return;
    this.makeRoom(target);
  }

  private onKey(e: KeyboardEvent) {
    const target = e.target as Element | null;
    if (!target || !isEditable(target)) return;
    this.lastKey = this.clock;
    if (this.mode === 'ground' && (this.action === 'walk')) this.setAction('idle', 2);
    this.makeRoom(target);
  }

  /** Moves out of the way of a field that is being used. */
  private makeRoom(field: Element) {
    if (this.mode !== 'ground' && this.mode !== 'hang') return;
    const onIt = this.perch?.el === field || (this.perch?.el ? field.contains(this.perch.el) : false);
    const r = field.getBoundingClientRect();
    const box = this.overlay!.pet.firstElementChild?.getBoundingClientRect();
    const pad = 10;
    const overlaps = !!box && box.right > r.left - pad && box.left < r.right + pad && box.bottom > r.top - pad && box.top < r.bottom + pad;
    if (!onIt && !overlaps) return;
    this.view!.motion.exclaim();
    if (inUse(field)) this.say(pickOne(this.text.moved), 1.6);
    // Hop to another element; fall only when nothing is in reach.
    this.mode = 'ground';
    if (!this.leap(field, true)) this.startFall();
  }
}

function clamp(v: number, min: number, max: number) {
  return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, v));
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pickOne<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Creates a companion. Call `mount()` to add her to the page. */
export function createPeetty(options: PeettyOptions = {}): Peetty {
  return new Peetty(options);
}
