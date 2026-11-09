import { FigureView } from '../figure/view.ts';
import { AUTONOMOUS_ACTIONS, type AutonomousAction, type Figure } from '../figure/types.ts';
import { clamp } from '../math.ts';
import { resolveFigure } from '../presets.ts';
import { languageOf, strings, type Language, type Strings } from './i18n.ts';
import { bottom, clearAt, crossing, findPerches, floor, inUse, isEditable, limits, reach, refresh, support, type Perch, type PerchOptions } from './perches.ts';
import { along, GRAVITY, impact, planJump, weighted, type Jump } from './physics.ts';
import { createOverlay, placeAbove, type MenuAction, type Overlay } from './ui.ts';
import type { ChatPanel } from '../chat/panel.ts';
import { loadChatPanel } from '../chat/load.ts';
import { normalizeModelOptions } from '../chat/connections.ts';
import type { CompanionAction, PeettyChatOptions, PeettyModelOptions } from '../chat/types.ts';

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
  /** An OpenAI-compatible connection. Injected credentials are not saved automatically. */
  model?: PeettyModelOptions;
  /** Chat storage and personality; false disables all chat entry points. */
  chat?: PeettyChatOptions | false;
}

type Mode = 'ground' | 'jump' | 'fall' | 'drag' | 'hang' | 'paused';
type Action = Exclude<AutonomousAction, 'jump'>;
type FigureResult = { figure: Figure } | { error: unknown };
interface FigureRequest {
  load: Promise<FigureResult>;
  superseded: Promise<null>;
  supersede: () => void;
  failed: boolean;
}
interface ActionCompletion {
  action: CompanionAction;
  actionVersion: number;
  until: number;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

const BASE: Partial<Record<AutonomousAction, number>> = { idle: 3, walk: 3, jump: 2, sit: 2, lie: 1, sleep: 0.6, think: 0.4 };
const ACTIVITY: Record<Activity, Partial<Record<AutonomousAction, number>>> = {
  calm: { walk: 0.5, jump: 0.35, sit: 1.6, lie: 1.3, sleep: 1.6 },
  normal: {},
  lively: { walk: 1.4, jump: 1.9, sit: 0.7, sleep: 0.5 },
};
const DURATION: Partial<Record<Action, [number, number]>> = {
  idle: [2.5, 6], sit: [8, 18], lie: [8, 16], sleep: [12, 25], think: [3, 5], wave: [1.7, 1.7],
};
const TYPING_QUIET = 4000;
const SCAN_INTERVAL = 1200;
/** A throw takes the pointer's speed over this many ms before release, up to THROW_MAX px/s. */
const THROW_WINDOW = 100;
const THROW_MAX = 2000;

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
  private figureRequest: FigureRequest | null = null;
  private mounting: Promise<void> | null = null;
  private generation = 0;
  private raf = 0;
  private last = 0;
  /** Frame time in ms; every timing decision uses this clock. */
  private clock = 0;
  private mode: Mode = 'paused';
  private retryAt = 0;
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private perch: Perch | null = null;
  private perches: Perch[] = [];
  private scanned = -Infinity;
  private action: Action = 'idle';
  private actionVersion = 0;
  private until = 0;
  private walkTo = 0;
  private jump: { from: [number, number]; plan: Jump; t: number; target: Perch; targetOrigin: [number, number]; hang: boolean; fright?: boolean } | null = null;
  /** The current fall is planned (dropping in), so it does not frighten her. */
  private calmFall = false;
  private hangUntil = 0;
  private coverCheck = 0;
  private lastKey = -Infinity;
  private lastGreet = -Infinity;
  private pointer: [number, number] | null = null;
  private press: { x: number; y: number; id: number } | null = null;
  /** Recent pointer samples while dragging: [ms, x, y], unclamped, so throws keep their speed at the edges. */
  private dragTrail: [number, number, number][] = [];
  private menuTimer = 0;
  private bubbleTimer = 0;
  private greetTimer = 0;
  private hidden = false;
  private chatPanel: ChatPanel | null = null;
  private chatLoading: Promise<ChatPanel | null> | null = null;
  private chatOperation = 0;
  private modelOperation = 0;
  private chatVisible = false;
  private chatWorking = false;
  private chatSpeaking = false;
  private chatGestureUntil = 0;
  private actionCompletion: ActionCompletion | null = null;
  private menuPinned = false;
  private lastTap: { at: number; x: number; y: number } | null = null;
  private tapTimer = 0;

  constructor(options: PeettyOptions = {}) {
    this.options = { ...options, ...(options.model ? { model: normalizeModelOptions(options.model) } : {}) };
    this.text = strings(languageOf(options.language));
  }

  /** True once mounted, including while waiting for a safe place to stand. */
  get mounted(): boolean {
    return !!this.view;
  }

  /** Adds her to the page. Resolves when the latest selected figure is loaded. */
  mount(): Promise<void> {
    if (this.overlay) return Promise.resolve();
    if (this.mounting) return this.mounting;
    if (!this.figureRequest || this.figureRequest.failed) this.requestFigure(this.options.figure);
    const pending = this.mountLatest(this.generation);
    this.mounting = pending;
    const clear = () => { if (this.mounting === pending) this.mounting = null; };
    void pending.then(clear, clear);
    return pending;
  }

  /** Removes her and every listener, and invalidates unfinished loads. */
  destroy(): void {
    this.finishChatAction(new Error('Companion action interrupted by removal.'));
    this.chatOperation++;
    this.modelOperation++;
    this.chatPanel?.destroy();
    this.chatPanel = null;
    this.chatLoading = null;
    this.chatVisible = this.chatWorking = this.chatSpeaking = false;
    this.chatGestureUntil = 0;
    this.menuPinned = false;
    this.lastTap = null;
    this.generation++;
    this.figureRequest?.supersede();
    this.figureRequest = null;
    this.mounting = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unbind();
    this.view?.destroy();
    this.overlay?.destroy();
    this.view = null;
    this.overlay = null;
    this.figure = null;
    this.mode = 'paused';
    this.hidden = false;
    this.press = null;
    this.pointer = null;
    this.dragTrail = [];
    this.perch = null;
    this.perches = [];
    this.jump = null;
    this.scanned = -Infinity;
    this.clock = 0;
    this.coverCheck = 0;
    this.lastKey = -Infinity;
    this.lastGreet = -Infinity;
  }

  /** Switches to another figure without restarting her current action. */
  async setFigure(figure: string | object): Promise<void> {
    const generation = this.generation;
    const request = this.requestFigure(figure);
    const loaded = await this.loadCurrent(request, generation);
    if (!loaded) return;
    if (this.overlay && this.view) {
      // Prepare the replacement before disposing the working view.
      const previous = this.view;
      const next = this.createView(loaded);
      next.setFacing(previous.direction);
      next.motion.resume(previous.motion.phase);
      this.overlay.pet.replaceChildren(next.element);
      this.view = next;
      previous.destroy();
      this.geometryChanged();
      next.step(0);
      this.place();
    }
    this.figure = loaded;
    this.options = { ...this.options, figure };
  }

  /** Shows a speech bubble; she talks while it is up. */
  say(text: string, seconds = Math.min(6, 1.8 + text.length * 0.08)): void {
    // Not while she is out of view, waiting for somewhere to stand.
    if (!this.overlay || !this.view || this.mode === 'paused') return;
    const { bubble } = this.overlay;
    bubble.textContent = text;
    this.overlay.invalidate(bubble);
    bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), seconds * 1000);
    if (this.mode === 'ground' && this.perch?.clear && this.action !== 'lie' && this.action !== 'sit' && this.action !== 'sleep') {
      this.setAction('talk', Math.min(seconds, 2.6));
    }
  }

  /** Plays an action once, as if she chose it. */
  play(state: Action): void {
    if (this.mode !== 'ground') return;
    if (state === 'walk') this.startWalk();
    else this.setAction(state, DURATION[state]?.[0] ?? 3);
  }

  /** Opens chat, or connection setup on the first visit. Chat code loads only here. */
  openChat(): Promise<void> { return this.openPanel(false); }

  /** Opens the connection settings without discarding conversation history. */
  configure(): Promise<void> { return this.openPanel(true); }

  closeChat(): void {
    this.chatOperation++;
    this.chatPanel?.close();
    this.chatClosed();
  }

  /** Changes interface language in place. Unsupported values throw without changing the session. */
  setLanguage(language: Language | 'auto'): void {
    if (language !== 'en' && language !== 'zh' && language !== 'auto') {
      throw new TypeError('Language must be en, zh, or auto.');
    }
    const resolved = languageOf(language);
    this.options = { ...this.options, language };
    this.text = strings(resolved);
    const overlay = this.overlay;
    if (overlay) {
      overlay.pet.setAttribute('aria-label', this.options.chat === false ? this.text.greet : this.text.pet);
      overlay.menu.setAttribute('aria-label', this.text.menu);
      for (const button of overlay.menu.children) {
        const action = button.getAttribute('data-action') as MenuAction;
        button.textContent = this.text[action];
      }
      overlay.invalidate(overlay.menu);
    }
    this.chatPanel?.setLanguage(resolved);
  }

  /** Replaces the injected model and aborts an unfinished reply. Credentials stay in memory. */
  async setModel(model: PeettyModelOptions): Promise<void> {
    const next = normalizeModelOptions(model);
    const generation = this.generation;
    const operation = ++this.modelOperation;
    const current = () => generation === this.generation && operation === this.modelOperation;
    const panel = this.chatPanel ?? (this.chatLoading ? await this.chatLoading : null);
    if (!current()) return;
    await panel?.setModel(next);
    if (!current()) return;
    this.options = { ...this.options, model: next };
  }

  private async openPanel(settings: boolean): Promise<void> {
    if (this.options.chat === false) return;
    const generation = this.generation;
    const operation = ++this.chatOperation;
    await this.mount();
    if (generation !== this.generation || operation !== this.chatOperation || !this.overlay) return;
    this.show();
    if (!this.chatLoading) {
      const root = this.overlay.host.shadowRoot!;
      const pending = loadChatPanel().then(({ createChatPanel }) => {
        if (generation !== this.generation) return null;
        return createChatPanel({
          root, language: languageOf(this.options.language),
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.chat ? { chat: this.options.chat } : {}),
          onAction: (action, signal) => {
            if (generation !== this.generation) throw new Error('Companion no longer available.');
            return this.performChatAction(action, signal);
          },
          onReply: (text) => { if (generation === this.generation && text.length <= 180) this.say(text, 6); },
          onState: (busy, speaking) => {
            if (generation !== this.generation) return;
            this.chatWorking = busy;
            this.chatSpeaking = speaking;
            if (this.chatVisible && busy && this.mode === 'ground' && this.perch?.clear && this.clock >= this.chatGestureUntil) {
              const action = speaking ? 'talk' : 'think';
              if (this.action !== action) this.setAction(action, 15);
            }
          },
          onClose: () => this.chatClosed(),
        });
      }).then((panel) => {
        if (generation !== this.generation) { panel?.destroy(); return null; }
        panel?.setLanguage(languageOf(this.options.language));
        this.chatPanel = panel;
        return panel;
      }).catch(() => {
        if (generation === this.generation) { this.chatLoading = null; this.say(this.text.chatFailed); }
        return null;
      });
      this.chatLoading = pending;
    }
    const panel = await this.chatLoading;
    if (!panel || generation !== this.generation || operation !== this.chatOperation) return;
    const opening = !this.chatVisible;
    this.chatVisible = true;
    this.menuPinned = false;
    clearTimeout(this.menuTimer);
    clearTimeout(this.tapTimer);
    this.lastTap = null;
    clearTimeout(this.greetTimer);
    this.overlay?.menu.classList.remove('show');
    this.overlay?.bubble.classList.remove('show');
    this.overlay?.pet.setAttribute('aria-expanded', 'true');
    if (this.overlay) {
      this.overlay.host.style.visibility = 'visible';
      if (this.mode === 'paused') this.overlay.pet.classList.add('gone');
    }
    if (opening && this.mode === 'ground' && this.perch?.clear && !this.actionCompletion) this.setAction('sit', 30);
    panel.open(settings);
  }

  private chatClosed(): void {
    this.chatVisible = this.chatWorking = this.chatSpeaking = false;
    if (this.options.chat === false) this.overlay?.pet.removeAttribute('aria-expanded');
    else this.overlay?.pet.setAttribute('aria-expanded', 'false');
    if (this.mode === 'ground' && (this.action === 'think' || this.action === 'talk' || this.action === 'sit')) this.setAction('idle', 2);
  }

  private async performChatAction(action: CompanionAction, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException('Action stopped.', 'AbortError');
    if (this.hidden || this.mode === 'paused') throw new Error('The companion is not currently visible.');
    if (this.mode !== 'ground' || this.actionCompletion) throw new Error('The companion is moving; try again once she lands.');
    if (action !== 'move' && !this.perch?.clear) throw new Error('The companion must reach clear ground before playing a pose.');
    clearTimeout(this.greetTimer);
    const duration = action === 'sleep' ? 20000 : 3500;
    if (action === 'move') {
      if (!this.leap()) throw new Error('No other safe spot is available.');
      this.chatGestureUntil = Infinity;
    } else {
      this.chatGestureUntil = this.clock + duration;
      this.setAction(action, duration / 1000);
    }
    return new Promise<string>((resolve, reject) => {
      const stop = () => {
        if (this.actionCompletion !== pending) return;
        this.finishChatAction(new DOMException('Action stopped.', 'AbortError'));
        // Only the tool's own stationary pose is ours to replace. Moves and later
        // user actions (even another identical pose) keep their animation ownership.
        if (action !== 'move' && !this.hidden && this.mode === 'ground' && this.actionVersion === pending.actionVersion) {
          const chat = this.chatVisible && this.perch?.clear;
          this.setAction(chat ? this.chatWorking ? this.chatSpeaking ? 'talk' : 'think' : 'sit' : 'idle', chat ? 15 : 2);
        }
      };
      const pending: ActionCompletion = {
        action, actionVersion: this.actionVersion, until: this.clock + duration, resolve, reject,
        dispose: () => signal?.removeEventListener('abort', stop),
      };
      this.actionCompletion = pending;
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }

  private finishChatAction(error?: Error): void {
    const pending = this.actionCompletion;
    if (!pending) return;
    this.actionCompletion = null;
    pending.dispose();
    this.chatGestureUntil = this.clock;
    if (error) pending.reject(error);
    else pending.resolve(pending.action === 'move' ? 'Arrived at another safe spot.' : `Finished ${pending.action}.`);
  }

  /** A tool completes on the animation clock, or on landing, rather than when the pose is selected. */
  private updateChatAction(): void {
    const pending = this.actionCompletion;
    if (!pending) return;
    if (this.hidden || this.mode === 'paused' || this.mode === 'drag') {
      this.finishChatAction(new Error('Companion action interrupted.'));
    } else if (pending.action === 'move') {
      if (this.mode === 'ground') {
        if (this.perch?.clear) this.finishChatAction();
        else this.finishChatAction(new Error('Companion move interrupted without a clear landing.'));
      }
    } else if (this.mode !== 'ground' || this.actionVersion !== pending.actionVersion || this.action !== pending.action) {
      this.finishChatAction(new Error('Companion action interrupted.'));
    } else if (this.clock >= pending.until) {
      this.finishChatAction();
    }
  }

  /** Takes her off the page until `show()`; her frame loop stops meanwhile. */
  hide(): void {
    if (!this.overlay) return;
    this.hidden = true;
    this.finishChatAction(new Error('Companion action interrupted by hiding.'));
    this.closeChat();
    this.menuPinned = false;
    this.overlay.menu.classList.remove('show');
    clearTimeout(this.menuTimer);
    clearTimeout(this.tapTimer);
    this.lastTap = null;
    this.releasePress();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.overlay.pet.classList.remove('dragging');
    this.overlay.host.style.display = 'none';
  }

  show(): void {
    if (!this.overlay || !this.hidden) return;
    this.hidden = false;
    this.overlay.host.style.display = 'block';
    this.enter();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------- setup

  private requestFigure(input: string | object | undefined): FigureRequest {
    this.figureRequest?.supersede();
    let supersede!: () => void;
    const superseded = new Promise<null>((resolve) => { supersede = () => resolve(null); });
    const request: FigureRequest = {
      load: resolveFigure(input).then(
        (figure) => ({ figure }),
        (error: unknown) => { request.failed = true; return { error }; },
      ),
      superseded,
      supersede,
      failed: false,
    };
    this.figureRequest = request;
    return request;
  }

  private async loadCurrent(request: FigureRequest, generation: number): Promise<Figure | null> {
    const result = await Promise.race([request.load, request.superseded]);
    if (generation !== this.generation || this.figureRequest !== request || !result) return null;
    if ('error' in result) throw result.error;
    return result.figure;
  }

  private async mountLatest(generation: number): Promise<void> {
    while (generation === this.generation) {
      const request = this.figureRequest!;
      const figure = await this.loadCurrent(request, generation);
      if (generation !== this.generation) return;
      if (!figure) continue;
      const view = this.createView(figure);
      const overlay = createOverlay(this.text, this.options.zIndex ?? 2147483000, (action) => this.onMenu(action));
      this.figure = figure;
      this.view = view;
      this.overlay = overlay;
      overlay.pet.append(view.element);
      document.documentElement.append(overlay.host);
      this.bind();
      this.enter();
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
  }

  private createView(figure: Figure): FigureView {
    const size = this.options.size ?? figure.height;
    return new FigureView(figure, {
      scale: size / figure.height,
      manual: true,
      ...(this.options.palette ? { palette: this.options.palette } : {}),
    });
  }

  /**
   * How far she reaches to either side of her feet. She turns by mirroring
   * around them, which swaps the two sides of an off-center figure, so this
   * covers both facings.
   */
  private get halfWidth(): number {
    const { width, anchor } = this.view!;
    return Math.max(anchor[0], width - anchor[0]);
  }

  /** Her footprint in either facing, so it, and every placement remembered for it, holds as she turns. */
  private get perchOptions(): PerchOptions {
    const half = this.halfWidth;
    return { host: this.overlay!.host, width: 2 * half, height: this.view!.height, anchor: [half, this.view!.anchor[1]] };
  }

  /** Drops in from the top of the viewport above a good perch. */
  private enter() {
    const perches = this.scan(true);
    const choices = perches.filter((p) => p.el);
    const preferred = choices.filter((p) => p.preferred);
    const pool = preferred.length ? preferred : choices.length ? choices : perches;
    if (!pool.length) return this.park();
    const target = pickOne(pool);
    this.overlay!.host.style.visibility = 'visible';
    this.overlay!.pet.classList.remove('gone');
    this.x = rand(target.left, target.right);
    this.y = Math.min(target.y - 40, this.view!.height * 0.6);
    this.vx = 0;
    this.vy = 0;
    // Dropping in is planned, so it does not frighten her.
    this.startFall(true);
  }

  /** No usable anchor: step out of view (fading when she is on screen) and rescan at a bounded interval. */
  private park(fade = false) {
    this.finishChatAction(new Error('Companion action interrupted because no safe surface is available.'));
    this.mode = 'paused';
    this.perch = null;
    this.jump = null;
    this.menuPinned = false;
    clearTimeout(this.menuTimer);
    this.releasePress();
    this.vx = this.vy = 0;
    const { pet, host, menu, bubble } = this.overlay!;
    pet.classList.remove('dragging');
    menu.classList.remove('show');
    bubble.classList.remove('show');
    // A faded figure takes no pointer events; the next retry hides the overlay if she cannot come back.
    if (fade || this.chatVisible) pet.classList.add('gone');
    host.style.visibility = this.chatVisible || fade ? 'visible' : 'hidden';
    this.retryAt = this.clock + SCAN_INTERVAL;
  }

  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  private bind() {
    const on = (target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push([target, type, fn as EventListener, opts]);
    };
    const pet = this.overlay!.pet;
    const menu = this.overlay!.menu;
    let activatingChat = false;
    const activateCompanion = () => {
      if (activatingChat) return;
      activatingChat = true;
      const finished = () => { activatingChat = false; };
      const action = this.options.chat === false ? Promise.resolve(this.greet()) : this.openChat();
      void action.then(finished, finished);
    };
    on(pet, 'click', (e: MouseEvent) => {
      // Pointer taps are handled on release; assistive/programmatic clicks have no pointer source.
      if (e.detail || (e as PointerEvent).pointerType) return;
      e.preventDefault();
      e.stopPropagation();
      activateCompanion();
    });
    on(pet, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(pet, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(this.menuTimer);
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.menuPinned = true;
      menu.classList.add('show');
      this.place();
    });
    const activationKey = (key: string) => key === 'Enter' || key === ' ';
    const contextKey = (e: KeyboardEvent) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
    // Focus can move between pet and menu before release, and Shift can be
    // released before F10. Keep the consumed key contained for the whole press.
    const consumedKeys = new Set<string>();
    const containKey = (e: KeyboardEvent, nativeButton = false) => {
      e.stopPropagation();
      if (!nativeButton) e.preventDefault();
      if (e.type === 'keydown') consumedKeys.add(e.key);
      else if (e.type === 'keyup') consumedKeys.delete(e.key);
    };
    for (const target of [pet, menu]) {
      on(target, 'keydown', (e: KeyboardEvent) => {
        const activation = activationKey(e.key);
        const context = contextKey(e);
        const escape = target === menu && e.key === 'Escape';
        const repeated = e.repeat && consumedKeys.has(e.key);
        consumedKeys.delete(e.key);
        if (!activation && !context && !escape && !repeated) return;
        containKey(e, target === menu && activation);
        if (e.repeat) return;
        if (target === pet && activation) activateCompanion();
        else if (context) {
          this.menuPinned = true; menu.classList.add('show');
          menu.querySelector<HTMLButtonElement>('button')?.focus();
        } else if (escape) {
          this.menuPinned = false; menu.classList.remove('show'); pet.focus();
        }
      });
      for (const type of ['keypress', 'keyup']) {
        on(target, type, (e: KeyboardEvent) => {
          if (consumedKeys.has(e.key) || activationKey(e.key) || contextKey(e) || (target === menu && e.key === 'Escape')) {
            containKey(e, target === menu && activationKey(e.key));
          }
        });
      }
    }
    on(window, 'pointerdown', (e: PointerEvent) => {
      const path = e.composedPath();
      if (!path.includes(pet) && !path.includes(menu)) { this.menuPinned = false; menu.classList.remove('show'); }
    });
    if (this.options.chat === false) {
      pet.setAttribute('aria-label', this.text.greet);
      pet.removeAttribute('aria-haspopup');
      for (const button of menu.children) {
        if (['chat', 'configure'].includes(button.getAttribute('data-action') ?? '')) (button as HTMLElement).hidden = true;
      }
    }
    on(window, 'pointermove', (e: PointerEvent) => this.onMove(e), { passive: true });
    on(window, 'pointerup', (e: PointerEvent) => this.onUp(e));
    on(window, 'pointercancel', (e: PointerEvent) => this.onUp(e, true));
    on(pet, 'lostpointercapture', (e: PointerEvent) => this.onUp(e, true));
    on(pet, 'pointerover', () => this.hover(true));
    on(pet, 'pointerout', () => this.hover(false));
    on(menu, 'pointerover', () => this.hover(true));
    on(menu, 'pointerout', () => this.hover(false));
    on(document, 'focusin', (e: FocusEvent) => this.onFocus(e), { capture: true });
    on(document, 'keydown', (e: KeyboardEvent) => this.onKey(e), { capture: true });
    on(window, 'resize', () => {
      this.geometryChanged();
      this.overlay?.invalidate();
    });
  }

  /**
   * Her size or the viewport changed, so remembered perch geometry no longer
   * matches: recheck the jump target now, the perch she is on next frame, and rescan.
   */
  private geometryChanged() {
    if (this.jump) {
      const target = refresh(this.jump.target, this.perchOptions, true);
      if (target) this.jump.target = target;
    }
    this.scanned = -Infinity;
    this.retryAt = this.clock;
    this.coverCheck = 0;
  }

  private unbind() {
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    clearTimeout(this.menuTimer);
    clearTimeout(this.bubbleTimer);
    clearTimeout(this.greetTimer);
    clearTimeout(this.tapTimer);
  }

  // ------------------------------------------------------------ the loop

  private readonly tick = (frame: number) => {
    if (!this.view || !this.overlay) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = clamp((frame - this.last) / 1000, 0, 0.05);
    this.last = frame;
    this.clock += dt * 1000;
    const now = this.clock;
    switch (this.mode) {
      case 'paused':
        if (now < this.retryAt) return;
        this.enter();
        break;
      case 'ground': this.ground(now, dt); break;
      case 'jump': this.flying(dt); break;
      case 'fall': this.falling(dt); break;
      case 'hang': this.hanging(now); break;
      case 'drag': break;
    }
    if (this.mode === 'paused') return;
    this.view.step(dt);
    this.place();
    this.updateChatAction();
  };

  private ground(now: number, dt: number) {
    const opts = this.perchOptions;
    const recheck = now >= this.coverCheck;
    if (recheck) this.coverCheck = now + 300;
    // Backstop for focus events that do not reach us (e.g. focus set by script). It comes
    // first: a field in use no longer holds her, and she should hop off it, not drop through.
    const field = this.perch?.input ? this.perch.el : null;
    if (field && inUse(field)) return this.makeRoom(field);
    // Over page content on the viewport bottom, she settles onto clear floor once she stands on it.
    const live = this.perch && support(this.perch, this.x, opts, recheck);
    if (!live) return this.startFall();
    this.perch = live;
    this.y = live.y;
    this.x = clamp(this.x, live.left, live.right);

    if (this.action === 'walk') {
      this.walkTo = clamp(this.walkTo, live.left, live.right);
      const dx = this.walkTo - this.x;
      this.view!.motion.setWalkSpeed(this.pace * this.view!.unitsPerPixel);
      if (Math.abs(dx) < 2 || now / 1000 >= this.until) {
        // A last step too short to walk is taken at once, so even a narrow clear spot is reached.
        if (Math.abs(dx) < 2) this.x = this.walkTo;
        this.setAction('idle', rand(0.8, 2));
      }
      else {
        this.face(Math.sign(dx));
        this.x += Math.sign(dx) * Math.min(Math.abs(dx), this.pace * dt);
      }
    } else if (now / 1000 > this.until) {
      // Let the frame's completion check finish an owned pose before choosing another.
      if (live.clear && this.actionCompletion?.action !== 'move' && this.actionCompletion?.actionVersion === this.actionVersion) return;
      if (!live.clear) this.leaveEdge();
      else if (this.chatVisible) this.setAction(this.chatWorking ? this.chatSpeaking ? 'talk' : 'think' : 'sit', 15);
      else this.decide();
    }

    // A friendly wave when the pointer comes close, now and then.
    if (this.pointer && this.action === 'idle' && !this.actionCompletion && now - this.lastGreet > 25000 && !this.view!.reducedMotion) {
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
    const opts = this.perchOptions;
    const arrived = jump.t >= jump.plan.duration;
    const target = refresh(jump.target, opts, arrived);
    const progress = Math.min(1, jump.t / jump.plan.duration);
    const [x, y] = along(jump.from, jump.plan, Math.min(jump.t, jump.plan.duration));
    // Follow a target that moves during the flight (scrolling), toward a spot still on it:
    // one moving partly out of view narrows its span, which keeps her on screen.
    const to = jump.from[0] + jump.plan.vx * jump.plan.duration;
    const dest = target ? clamp(to + target.left - jump.targetOrigin[0], target.left, target.right) : to;
    this.x = x + (dest - to) * progress;
    this.y = y + (target ? (target.y - jump.targetOrigin[1]) * progress : 0);
    if (!target || (arrived && !support(target, this.x, opts, true))) {
      this.vx = jump.plan.vx;
      this.vy = jump.plan.vy + GRAVITY * jump.t;
      return this.startFall();
    }
    // Over the top of a long drop she looks down, and her soul leaves her.
    if (jump.fright && jump.t > -jump.plan.vy / GRAVITY) this.view!.motion.play('fall');
    jump.target = target;
    if (arrived) {
      this.x = clamp(this.x, target.left, target.right);
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
    const opts = this.perchOptions;
    const fit = limits(opts);
    // The viewport is smaller than she is: there is nowhere on screen to be.
    if (!fit) return this.park();
    if (this.x < fit.left || this.x > fit.right) {
      this.x = clamp(this.x, fit.left, fit.right);
      this.vx = -this.vx * 0.4;
    }
    // Thrown upward, she bumps against the top of the viewport instead of leaving it.
    if (this.vy < 0 && this.y < fit.top) {
      this.y = fit.top;
      this.vy = -this.vy * 0.2;
    }
    // A fall frightens her once she is on the way down; a throw carries her up calmly first.
    this.view!.motion.setFright(!this.calmFall && this.vy >= 0);
    // She lands on the highest edge crossed this frame that still holds her. One that
    // no longer does sends her on to the next edge down and makes the last scan stale.
    let stale = false;
    const hit = crossing(this.scan(), this.x, fromY, this.y, opts, (perch) => {
      const safe = support(perch, this.x, opts, true);
      if (!safe) stale = true;
      return safe;
    });
    if (stale) this.scanned = -Infinity;
    if (hit) return this.land(hit, impact(this.vy));
    // The viewport bottom always catches her; over page content she only stays briefly.
    const ground = this.y >= fit.bottom && bottom(opts, this.x);
    if (ground) this.land(ground, impact(this.vy));
  }

  /**
   * Off the uncleared viewport bottom: walk to clear floor nearby, else hop to a
   * perch, else step out of view. With reduced motion she only fades out of view,
   * and comes back the usual way.
   */
  private leaveEdge() {
    if (this.view!.reducedMotion) return this.park(true);
    const clear = floor(this.perchOptions);
    if (clear) {
      const margin = Math.min(12, (clear.right - clear.left) / 2);
      const target = clamp(this.x, clear.left + margin, clear.right - margin);
      if (Math.abs(target - this.x) < 240 || !this.leap()) this.walkOver(target);
    } else if (!this.leap()) this.park(true);
  }

  private hanging(now: number) {
    const opts = this.perchOptions;
    const recheck = now >= this.coverCheck;
    if (recheck) this.coverCheck = now + 300;
    const live = this.perch && support(this.perch, this.x, opts, recheck);
    if (!live) return this.startFall();
    this.perch = live;
    this.x = clamp(this.x, live.left, live.right);
    this.y = live.y;
    if (now > this.hangUntil) this.land(live, 0.25);
  }

  private place() {
    const view = this.view!;
    const overlay = this.overlay!;
    const { pet, bubbleBox, bubble, menuBox, menu } = overlay;
    const menuUp = menu.classList.contains('show');
    const bubbleUp = bubble.classList.contains('show');
    // Measure only when content or layout changes, before writing transforms.
    const menuSize = menuUp ? overlay.measure(menu) : null;
    const bubbleSize = bubbleUp ? overlay.measure(bubble) : null;
    pet.style.transform = `translate3d(${(this.x - view.anchor[0]).toFixed(1)}px, ${(this.y - view.anchor[1]).toFixed(1)}px, 0)`;
    const low = this.mode === 'ground' && (this.action === 'sit' || this.action === 'lie');
    const head = this.y - view.height * (low ? 0.62 : 0.98);
    if (menuSize) placeAbove(menuBox, this.x, head - 4, menu, menuSize);
    if (bubbleSize) placeAbove(bubbleBox, this.x, head - (menuSize ? menuSize.height + 10 : 8), bubble, bubbleSize);
  }

  // ------------------------------------------------------------ decisions

  private decide() {
    const perch = this.perch!;
    const typing = this.clock - this.lastKey < TYPING_QUIET;
    const weights = { ...BASE };
    const configured = this.figure!.behavior?.weights;
    const activity = ACTIVITY[this.options.activity ?? 'normal'];
    for (const key of AUTONOMOUS_ACTIONS) {
      const value = configured?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) weights[key] = value;
      if (weights[key] !== undefined) weights[key] = weights[key]! * (activity[key] ?? 1);
      if (perch.input && key !== 'sit' && key !== 'lie' && key !== 'jump') delete weights[key];
    }
    if (this.view!.reducedMotion || typing) {
      delete weights.walk;
      delete weights.jump;
    }
    if (perch.right - perch.left < 20) delete weights.walk;
    const choice = weighted(weights) ?? 'idle';
    if (choice === 'jump') {
      if (!this.leap()) this.setAction('idle', rand(1.5, 3));
    } else if (choice === 'walk') this.startWalk();
    else {
      const [min, max] = DURATION[choice] ?? [3, 6];
      this.setAction(choice, rand(min, max));
    }
  }

  private startWalk() {
    if (this.perch && !this.perch.clear) return this.leaveEdge();
    const perch = this.perch && refresh(this.perch, this.perchOptions, true);
    if (!perch) return this.startFall();
    this.perch = perch;
    if (perch.input || perch.right - perch.left < 2) return this.setAction(perch.input ? 'sit' : 'idle', rand(1.5, 3));
    this.x = clamp(this.x, perch.left, perch.right);
    let target = rand(perch.left, perch.right);
    if (Math.abs(target - this.x) < 20) target = this.x - perch.left > perch.right - this.x ? perch.left : perch.right;
    this.walkOver(target);
  }

  /** Walking speed in CSS pixels per second. */
  private get pace(): number {
    return 52 * (this.figure!.behavior?.walkSpeed ?? 1);
  }

  /** Walks along her current perch toward `target`, stopping short of anything clickable on the way. */
  private walkOver(target: number) {
    const end = this.perch ? reach(this.perch, this.x, target, this.perchOptions) : target;
    if (Math.abs(end - this.x) < 2) {
      // Too short to walk: the step is taken at once, so even a narrow clear spot is reached.
      this.x = end;
      return this.setAction('idle', rand(1.5, 3));
    }
    this.walkTo = end;
    this.setAction('walk', Math.abs(end - this.x) / this.pace + 0.5);
  }

  private setAction(action: Action, seconds: number) {
    this.actionVersion++;
    this.action = action;
    const deadline = this.clock / 1000 + seconds;
    // A stationary pose must not extend the exit budget over covered floor.
    // Walking keeps its own deadline so evacuation can reach a clear spot.
    this.until = this.mode === 'ground' && this.perch?.clear === false && action !== 'walk'
      ? Math.min(this.until, deadline) : deadline;
    this.view!.motion.play(action);
  }

  /** Jumps to another perch in reach, landing well clear of `exclude` if given; false if there is none. */
  private leap(exclude: Element | null = null): boolean {
    const perches = this.scan();
    const view = this.view!;
    const from: [number, number] = [this.x, this.y];
    const power = this.figure!.behavior?.jumpPower ?? 1;
    // Keep the whole arc on screen, with room for her take-off stretch (up to 1.1x) at the top.
    const ceiling = view.anchor[1] * 1.15;
    const avoid = exclude?.getBoundingClientRect();
    const options: { perch: Perch; to: [number, number]; plan: Jump; weight: number }[] = [];
    for (const perch of perches) {
      if (perch.el === this.perch?.el || (exclude && perch.el === exclude)) continue;
      const span = perch.right - perch.left;
      const to: [number, number] = [rand(perch.left + span * 0.2, perch.right - span * 0.2), perch.y];
      if (avoid && to[0] > avoid.left - 40 && to[0] < avoid.right + 40 && Math.abs(to[1] - avoid.top) < 80) continue;
      const plan = planJump(from, to, power, ceiling);
      if (!plan) continue;
      const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const weight = (perch.preferred ? 3 : 1) * (perch.el ? 1 : 0.35) * (1 / (1 + distance / 260));
      options.push({ perch, to, plan, weight });
    }
    // Land only where she covers nothing clickable that rect clearance cannot see; a few draws find one.
    const opts = this.perchOptions;
    let pick: (typeof options)[number] | null = null;
    for (let draws = 0; !pick && draws < 3; draws++) {
      const option = weighted(options.map((candidate) => [candidate, candidate.weight] as const));
      if (!option) break;
      if (clearAt(option.perch, option.to[0], opts)) pick = option;
      else options.splice(options.indexOf(option), 1);
    }
    if (!pick) return false;
    // Upward jumps that are a little too far end hanging from the edge.
    const rise = from[1] - pick.to[1];
    const hang = rise > 110 && !pick.perch.input && Math.random() < 0.25;
    // A long way down frightens her once she passes the top of the arc; an umbrella keeps her calm.
    const drop = pick.to[1] - (Math.min(from[1], pick.to[1]) - pick.plan.apex);
    const fright = drop > view.height * 2.2 && this.figure!.behavior?.fallProp !== 'umbrella';
    this.face(Math.sign(pick.to[0] - from[0]) || 1);
    this.jump = { from, plan: pick.plan, t: -0.18, target: pick.perch, targetOrigin: [pick.perch.left, pick.perch.y], hang, fright };
    this.mode = 'jump';
    this.perch = null;
    view.motion.play('jump');
    return true;
  }

  /** Lets go; the viewport bottom catches her if nothing else does. A calm fall never frightens her. */
  private startFall(calm = false) {
    if (this.actionCompletion?.action === 'move') this.finishChatAction(new Error('Companion move interrupted before landing.'));
    this.perch = null;
    this.jump = null;
    this.mode = 'fall';
    this.calmFall = calm;
    this.view!.motion.play('fall');
  }

  private land(perch: Perch, strength: number) {
    this.perch = perch;
    this.mode = 'ground';
    this.y = perch.y;
    this.vx = 0;
    this.vy = 0;
    this.jump = null;
    this.x = clamp(this.x, perch.left, perch.right);
    this.view!.motion.land(strength);
    this.actionVersion++;
    this.action = 'idle';
    this.until = this.clock / 1000 + (strength > 0.85 ? 1.8 : rand(0.6, 1.4));
    if (perch.input) this.until = this.clock / 1000 + 0.5;
    if (this.options.greet !== false && !this.chatVisible && !this.actionCompletion && this.lastGreet === -Infinity && this.figure) {
      this.lastGreet = this.clock;
      this.scheduleGreeting(700);
    }
  }

  private scan(force = false): Perch[] {
    const now = this.clock;
    if (force || now - this.scanned >= SCAN_INTERVAL) {
      this.perches = findPerches(this.perchOptions);
      this.scanned = now;
    }
    return this.perches;
  }

  private face(direction: number) {
    if (direction) this.view!.setFacing(direction < 0 ? -1 : 1);
  }

  // --------------------------------------------------------- interaction

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || e.isPrimary === false || this.press || !this.view || this.hidden) return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { this.overlay!.pet.setPointerCapture(e.pointerId); } catch { /* Synthetic events may not have an active pointer. */ }
    e.preventDefault();
  }

  private onMove(e: PointerEvent) {
    this.pointer = [e.clientX, e.clientY];
    if (!this.press || e.pointerId !== this.press.id || this.hidden) return;
    if (this.mode !== 'drag') {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < 5) return;
      clearTimeout(this.tapTimer);
      clearTimeout(this.menuTimer);
      this.lastTap = null;
      this.menuPinned = false;
      this.mode = 'drag';
      this.perch = null;
      this.jump = null;
      this.overlay!.pet.classList.add('dragging');
      this.overlay!.menu.classList.remove('show');
      this.view!.motion.play('drag');
      this.dragTrail = [];
    }
    // Held by the top of the head, inside the viewport if she fits; the frame loop draws the latest position.
    const fit = limits(this.perchOptions);
    const y = e.clientY + this.view!.height * 0.8;
    this.x = fit ? clamp(e.clientX, fit.left, fit.right) : e.clientX;
    this.y = fit ? clamp(y, fit.top, fit.bottom) : y;
    const now = performance.now(); // real time: pointer speed
    while (this.dragTrail.length && now - this.dragTrail[0]![0] > THROW_WINDOW) this.dragTrail.shift();
    this.dragTrail.push([now, e.clientX, e.clientY]);
  }

  /** The pointer's velocity just before release; a pointer held still throws nothing. */
  private throwVelocity(e: PointerEvent): [number, number] {
    const now = performance.now();
    const trail: [number, number, number][] = [...this.dragTrail, [now, e.clientX, e.clientY]];
    const recent = trail.filter(([t]) => now - t <= THROW_WINDOW);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const span = (last[0] - first[0]) / 1000;
    if (span < 0.01) return [0, 0];
    return [
      clamp((last[1] - first[1]) / span, -THROW_MAX, THROW_MAX),
      clamp((last[2] - first[2]) / span, -THROW_MAX, THROW_MAX),
    ];
  }

  /** Ends the current press, giving the pointer back to the page; hiding or parking her mid-press ends it too. */
  private releasePress() {
    const press = this.press;
    if (!press) return;
    this.press = null;
    try { this.overlay?.pet.releasePointerCapture(press.id); } catch { /* Capture may already have been released. */ }
  }

  private onUp(e: PointerEvent, cancelled = false) {
    if (!this.press || e.pointerId !== this.press.id) return;
    this.releasePress();
    if (this.mode === 'drag') {
      this.overlay!.pet.classList.remove('dragging');
      [this.vx, this.vy] = cancelled ? [0, 0] : this.throwVelocity(e);
      this.dragTrail = [];
      // Let go mid-swing, she keeps flying the way she was thrown; calm until she starts coming down.
      this.startFall();
    } else if (!cancelled) {
      if (this.options.chat === false) {
        if (e.pointerType === 'touch') { this.menuPinned = true; this.overlay!.menu.classList.add('show'); }
        else this.greet();
        return;
      }
      const now = performance.now();
      const previous = this.lastTap;
      if (previous && now - previous.at < 420 && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 24) {
        this.lastTap = null;
        clearTimeout(this.tapTimer);
        if (this.chatPanel?.isOpen) this.closeChat();
        else void this.openChat();
      } else {
        this.lastTap = { at: now, x: e.clientX, y: e.clientY };
        clearTimeout(this.tapTimer);
        if (e.pointerType === 'touch') { this.menuPinned = true; this.overlay!.menu.classList.add('show'); }
        else this.tapTimer = window.setTimeout(() => { this.lastTap = null; this.greet(); }, 420);
      }
    }
  }

  private hover(on: boolean) {
    if (this.menuPinned || this.chatVisible) return;
    clearTimeout(this.menuTimer);
    const menu = this.overlay?.menu;
    if (!menu) return;
    this.menuTimer = window.setTimeout(() => {
      if (on && this.mode !== 'drag') menu.classList.add('show');
      else if (!on) menu.classList.remove('show');
    }, on ? 280 : 650);
  }

  private onMenu(action: MenuAction) {
    this.menuPinned = false;
    this.overlay!.menu.classList.remove('show');
    if (action === 'chat') void this.openChat();
    else if (action === 'configure') void this.configure();
    else if (action === 'greet') this.greet();
    else if (action === 'move') {
      if (this.mode === 'ground' && !this.leap()) this.say(pickOne(this.text.hello));
    } else if (action === 'nap') {
      if (this.mode === 'ground') this.setAction(this.perch?.input ? 'lie' : 'sleep', 20);
    } else if (action === 'hide') this.hide();
  }

  private scheduleGreeting(delay: number) {
    clearTimeout(this.greetTimer);
    this.greetTimer = window.setTimeout(() => this.say(pickOne(this.text.hello)), delay);
  }

  private greet() {
    if (this.mode !== 'ground') return;
    this.lastGreet = this.clock;
    if (this.pointer) this.face(Math.sign(this.pointer[0] - this.x) || 1);
    this.setAction('wave', DURATION.wave![0]);
    this.scheduleGreeting(350);
  }

  private onFocus(e: FocusEvent) {
    const target = editableTarget(e);
    if (target && this.view) this.makeRoom(target);
  }

  private onKey(e: KeyboardEvent) {
    const target = editableTarget(e);
    if (!target) return;
    this.lastKey = this.clock;
    if (this.mode === 'ground' && this.action === 'walk') this.setAction('idle', 2);
    this.makeRoom(target);
  }

  /** Moves out of the way of a field that is being used. */
  private makeRoom(field: Element) {
    if (this.mode !== 'ground' && this.mode !== 'hang') return;
    const onIt = this.perch?.el === field || (this.perch?.el ? field.contains(this.perch.el) : false);
    const r = field.getBoundingClientRect();
    // Her box in either facing, as perch clearance sees it.
    const half = this.halfWidth;
    const top = this.y - this.view!.anchor[1];
    const pad = 10;
    const overlaps = this.x + half > r.left - pad && this.x - half < r.right + pad && top + this.view!.height > r.top - pad && top < r.bottom + pad;
    if (!onIt && !overlaps) return;
    this.view!.motion.exclaim();
    if (inUse(field)) this.say(pickOne(this.text.moved), 1.6);
    // Hop to another element; fall only when nothing is in reach, and step out of view if already at the bottom.
    this.mode = 'ground';
    if (this.leap(field)) return;
    if (this.perch && !this.perch.clear) this.park(true);
    else this.startFall();
  }
}

function editableTarget(event: Event): Element | null {
  const path = event.composedPath();
  for (const target of path.length ? path : [event.target]) {
    if (target instanceof Element && isEditable(target)) return target;
  }
  return null;
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
