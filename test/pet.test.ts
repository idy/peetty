import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Peetty } from '../src/pet/pet.ts';
import { AUTONOMOUS_ACTIONS, type Figure, type RigFigure } from '../src/figure/types.ts';
import type { FigureView } from '../src/figure/view.ts';
import { PRESETS } from '../src/presets.ts';
import { floor, limits, type Perch, type PerchOptions } from '../src/pet/perches.ts';
import { planJump, weighted } from '../src/pet/physics.ts';
import type { Overlay } from '../src/pet/ui.ts';
import { deferred, ElementStub, installPetDOM, pointer } from './helpers/pet-dom.ts';

/** Inspect controller state while driving its public methods, events and frame loop. */
interface Controller {
  view: FigureView;
  overlay: Overlay;
  figure: Figure;
  mode: 'ground' | 'jump' | 'fall' | 'drag' | 'hang' | 'paused';
  action: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  clock: number;
  walkTo: number;
  until: number;
  perch: Perch | null;
  perchOptions: PerchOptions;
  jump: unknown;
  press: { id: number } | null;
  lastKey: number;
  scanned: number;
  calmFall: boolean;
  land: (perch: Perch, strength: number) => void;
  leap: (exclude?: Element | null) => boolean;
  startFall: (calm?: boolean) => void;
  decide: () => void;
  scan: (force?: boolean) => Perch[];
  place: () => void;
  makeRoom: (field: Element) => void;
}
const controller = (pet: Peetty) => pet as unknown as Controller;
const response = (figure: Figure) => ({ ok: true, json: async () => figure }) as Response;
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

afterEach(() => mock.restoreAll());

async function mountPet(t: Parameters<typeof installPetDOM>[0], options: ConstructorParameters<typeof Peetty>[0] = {}) {
  const dom = installPetDOM(t);
  const pet = new Peetty({ greet: false, ...options });
  dom.cleanup(() => pet.destroy());
  await pet.mount();
  return { dom, pet, state: controller(pet) };
}

function stand(state: Controller, x = 300) {
  const perch = floor(state.perchOptions);
  assert.ok(perch);
  state.x = x;
  state.land(perch, 0.2);
  return perch;
}

describe('mount and figure request ownership', () => {
  it('shares one pending mount and tears down every installed resource', async (t) => {
    const dom = installPetDOM(t);
    const pet = new Peetty({ greet: false });
    dom.cleanup(() => pet.destroy());
    const first = pet.mount();
    assert.equal(pet.mount(), first);
    await first;
    assert.equal(dom.hosts.length, 1);
    assert.equal(dom.frames.size, 1);
    assert.equal(dom.observers.size, 1);
    pet.destroy();
    assert.equal(dom.hosts.length, 0);
    assert.equal(dom.frames.size, 0);
    assert.equal(dom.window.listenerCount, 0);
    assert.equal(dom.document.listenerCount, 0);
    assert.equal(dom.observers.size, 0);
  });

  it('does not install a load that finishes after destroy', async (t) => {
    const dom = installPetDOM(t);
    const fetch = deferred<Response>();
    mock.method(globalThis, 'fetch', () => fetch.promise);
    const pet = new Peetty({ figure: '/slow.json', greet: false });
    dom.cleanup(() => pet.destroy());
    const mount = pet.mount();
    pet.destroy();
    await mount;
    fetch.resolve(response(PRESETS.miru));
    await turns();
    assert.equal(pet.mounted, false);
    assert.equal(dom.hosts.length, 0);
    assert.equal(dom.frames.size, 0);
  });

  it('a new mount after destroy is independent of an older pending mount', async (t) => {
    const dom = installPetDOM(t);
    const old = deferred<Response>();
    mock.method(globalThis, 'fetch', () => old.promise);
    const pet = new Peetty({ figure: '/slow.json', greet: false });
    dom.cleanup(() => pet.destroy());
    const first = pet.mount();
    pet.destroy();
    await pet.setFigure('elsie');
    await pet.mount();
    old.resolve(response(PRESETS.miru));
    await first;
    await turns();
    assert.equal(controller(pet).figure.id, 'elsie');
    assert.equal(dom.hosts.length, 1);
    assert.equal(dom.frames.size, 1);
  });

  for (const staleFailure of [false, true]) {
    it(`mounts a newer successful selection before the initial load ${staleFailure ? 'fails' : 'finishes'}`, async (t) => {
      const dom = installPetDOM(t);
      const old = deferred<Response>();
      mock.method(globalThis, 'fetch', () => old.promise);
      const pet = new Peetty({ figure: '/slow.json', greet: false });
      dom.cleanup(() => pet.destroy());
      let mounted = false;
      const mount = pet.mount().then(() => { mounted = true; });
      await pet.setFigure('elsie');
      await turns();
      assert.equal(mounted, true, 'initial request must not block the latest selection');
      assert.equal(controller(pet).view.renderer.figure.id, 'elsie');
      if (staleFailure) old.reject(new Error('stale request failed'));
      else old.resolve(response(PRESETS.miru));
      await mount;
      await turns();
      assert.equal(controller(pet).figure.id, 'elsie');
      assert.equal(dom.hosts.length, 1);
    });
  }

  it('keeps the newest selection when earlier setFigure requests finish or fail', async (t) => {
    const { pet, state } = await mountPet(t);
    const old = deferred<Response>();
    mock.method(globalThis, 'fetch', () => old.promise);
    const first = pet.setFigure('/slow.json');
    await pet.setFigure('elsie');
    old.reject(new Error('stale request failed'));
    await first;
    assert.equal(state.figure.id, 'elsie');
    assert.equal(state.view.renderer.figure.id, 'elsie');
  });

  it('reports the current mount failure and permits a retry', async (t) => {
    const dom = installPetDOM(t);
    let requests = 0;
    mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (requests === 1) throw new Error('load failed');
      return response(PRESETS.miru);
    });
    const pet = new Peetty({ figure: '/retry.json', greet: false });
    dom.cleanup(() => pet.destroy());
    await assert.rejects(pet.mount(), /load failed/);
    await pet.mount();
    assert.equal(dom.hosts.length, 1);
    assert.equal(pet.mounted, true);
  });
});

describe('view replacement and remounting', () => {
  it('preserves facing, animation clocks and physical state', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const old = state.view;
    const target = stand(state);
    old.setFacing(-1);
    old.motion.resume({ state: 'jump', elapsed: 0.5, time: 20, walkPhase: 1.25 });
    state.mode = 'jump';
    state.x = 240;
    state.y = 300;
    state.vx = 23;
    state.vy = -94;
    const jump = { from: [240, 300] as [number, number], plan: planJump([240, 300], [400, target.y])!, t: 0.1, target, targetOrigin: [target.left, target.y] as [number, number], hang: false };
    state.jump = jump;
    state.until = 50;
    await pet.setFigure('elsie');
    assert.notEqual(state.view, old);
    assert.equal(state.view.direction, -1);
    assert.deepEqual(state.view.motion.phase, { state: 'jump', elapsed: 0.5, time: 20, walkPhase: 1.25, soul: 0 });
    assert.deepEqual([state.mode, state.x, state.y, state.vx, state.vy, state.until], ['jump', 240, 300, 23, -94, 50]);
    assert.equal(state.jump, jump);
    assert.equal((old.element as unknown as ElementStub).parentNode, null);
    dom.frame();
    assert.equal(state.mode, 'jump', 'new geometry must not invalidate the active jump target');
  });

  it('remounts a hidden instance visibly with a running frame loop', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    pet.hide();
    pet.destroy();
    await pet.mount();
    assert.equal(state.overlay.host.style.display, 'block');
    assert.equal(state.overlay.host.style.visibility, 'visible');
    const initialY = state.y;
    dom.frame();
    assert.ok(state.y > initialY, 'physics should advance after remount');
    assert.equal(dom.frames.size, 1);
  });

  it('clears scheduled greetings on destroy', async (t) => {
    const { dom, pet, state } = await mountPet(t, { greet: true });
    stand(state);
    assert.ok(dom.timers.size > 0);
    pet.destroy();
    assert.equal(dom.timers.size, 0);
  });
});

describe('safe surfaces and autonomous walking', () => {
  it('parks invisibly and retries at a bounded cadence until a safe anchor exists', async (t) => {
    const dom = installPetDOM(t);
    dom.viewport(40);
    const pet = new Peetty({ greet: false });
    dom.cleanup(() => pet.destroy());
    await pet.mount();
    const state = controller(pet);
    assert.equal(state.mode, 'paused');
    assert.equal(state.overlay.host.style.visibility, 'hidden');
    const scan = mock.method(state, 'scan');
    for (let i = 0; i < 120; i++) dom.frame(20);
    assert.ok(scan.mock.callCount() <= 3, `retried ${scan.mock.callCount()} times over 2.4 seconds`);
    assert.equal(state.mode, 'paused');
    dom.viewport(1024);
    dom.window.dispatchEvent(new Event('resize'));
    dom.frame();
    assert.equal(state.mode, 'fall');
    assert.equal(state.overlay.host.style.visibility, 'visible');
  });

  it('keeps her perch and her jump target through a window resize', async (t) => {
    const { dom, state } = await mountPet(t);
    const shelf = dom.document.createElement('div');
    shelf.setAttribute('data-peetty', 'perch');
    shelf.rect = { left: 100, top: 400, width: 400, height: 40 };
    const ledge = dom.document.createElement('div');
    ledge.setAttribute('data-peetty', 'perch');
    ledge.rect = { left: 600, top: 400, width: 300, height: 40 };
    dom.document.body.append(shelf, ledge);
    dom.frame(300);
    const on = state.scan(true).find((p) => p.el === shelf as unknown as Element);
    assert.ok(on);
    state.x = 300;
    state.land(on, 0.2);
    dom.frame(20); // A full recheck; the next is due in 300 ms.
    dom.viewport(1000);
    dom.window.dispatchEvent(new Event('resize'));
    dom.frame(20);
    assert.equal(state.mode, 'ground', 'still standing after the resize');
    assert.equal(state.perch?.el, shelf as unknown as Element);
    mock.method(Math, 'random', () => 0);
    assert.ok(state.leap());
    assert.equal((state.jump as { target: Perch }).target.el, ledge as unknown as Element);
    for (let i = 0; i < 15; i++) dom.frame(20);
    assert.equal(state.mode, 'jump', 'in the air');
    dom.viewport(980);
    dom.window.dispatchEvent(new Event('resize'));
    let fell = false;
    for (let i = 0; state.mode === 'jump' && i < 100; i++) {
      dom.frame(20);
      fell ||= state.mode === 'fall';
    }
    assert.equal(fell, false, 'the resize does not drop her mid-jump');
    assert.equal(state.mode, 'ground');
    assert.equal(state.perch?.el, ledge as unknown as Element);
  });

  it('catches her at the viewport bottom over a control, then fades out when nothing is clear', async (t) => {
    const { dom, state } = await mountPet(t);
    const blocker = dom.document.createElement('input');
    blocker.rect = { left: 0, top: 0, width: 1024, height: 768 };
    dom.document.body.append(blocker);
    dom.frame(300); // Let the page scan taken at mount expire.
    state.scanned = -Infinity;
    state.y = 700;
    state.vy = 500;
    const bottom = 768 - (state.view.height - state.view.anchor[1]);
    for (let i = 0; state.mode === 'fall' && i < 50; i++) {
      dom.frame(20);
      assert.ok(state.y <= bottom + 1e-6, 'never below the viewport');
    }
    assert.equal(state.mode, 'ground');
    assert.equal(state.perch?.el, null);
    assert.equal(state.y, bottom);
    assert.equal(state.overlay.host.style.visibility, 'visible');
    for (let i = 0; state.mode === 'ground' && i < 150; i++) dom.frame(20);
    assert.equal(state.mode, 'paused');
    assert.ok(state.overlay.pet.classList.contains('gone'), 'fades out where she stands');
    assert.equal(state.overlay.host.style.visibility, 'visible');
    for (let i = 0; i < 80; i++) dom.frame(20);
    assert.equal(state.overlay.host.style.visibility, 'hidden', 'hidden once a retry finds nowhere to stand');
  });

  it('walks from a covered spot on the viewport bottom to clear floor', async (t) => {
    const { dom, state } = await mountPet(t);
    const wall = dom.document.createElement('button');
    wall.rect = { left: 0, top: 0, width: 400, height: 768 };
    dom.document.body.append(wall);
    dom.frame(300); // Let the page scan taken at mount expire.
    state.scanned = -Infinity;
    state.x = 380;
    state.y = 700;
    state.vx = 0;
    state.vy = 400;
    for (let i = 0; state.mode === 'fall' && i < 50; i++) dom.frame(20);
    assert.equal(state.mode, 'ground');
    assert.equal(state.perch?.el, null);
    assert.equal(state.perch?.clear, false, 'caught by the viewport bottom over the button');
    for (let i = 0; !state.perch?.clear && i < 400; i++) dom.frame(20);
    assert.equal(state.perch?.clear, true, 'settled onto clear floor');
    assert.equal(state.perch?.el, null);
    assert.ok(state.x >= state.perch!.left && state.x <= state.perch!.right);
    assert.ok(state.x - state.view.anchor[0] > 400, 'clear of the button');
  });

  it('drops off clear floor that becomes covered under her, and moves on soon after', async (t) => {
    const { dom, state } = await mountPet(t);
    // Read through a function: an assertion would narrow the field for the loop below.
    const clear = () => state.perch?.clear;
    dom.frame(300);
    stand(state, 200);
    assert.equal(clear(), true);
    // A long rest, cut short when the floor under her stops being clear.
    state.until = state.clock / 1000 + 60;
    const wall = dom.document.createElement('button');
    wall.rect = { left: 0, top: 0, width: 400, height: 768 };
    dom.document.body.append(wall);
    let dropped = false;
    for (let i = 0; !(state.mode === 'ground' && clear() === false) && i < 50; i++) {
      dom.frame(20);
      dropped ||= state.mode === 'fall';
    }
    assert.ok(dropped, 'she drops rather than staying put');
    assert.equal(clear(), false, 'caught by the viewport bottom');
    assert.ok(state.until - state.clock / 1000 < 2, 'she does not linger over page content');
  });

  it('stays inside the viewport when thrown upward or dragged past an edge', async (t) => {
    const { dom, state } = await mountPet(t);
    const { anchor, width, height } = state.view;
    state.mode = 'fall';
    state.y = 300;
    state.vy = -2500;
    for (let i = 0; i < 30; i++) {
      dom.frame(20);
      assert.ok(state.y >= anchor[1] - 1e-6, 'her head stays on screen');
    }
    stand(state);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointermove', 1, -200, -300));
    assert.equal(state.mode, 'drag');
    const half = Math.max(anchor[0], width - anchor[0]);
    assert.deepEqual([state.x, state.y], [half, anchor[1]]);
    dom.window.dispatchEvent(pointer('pointermove', 1, 5000, 5000));
    assert.deepEqual([state.x, state.y], [1024 - half, 768 - (height - anchor[1])]);
  });

  it('keeps an off-center figure on screen in either facing, and its perch as she turns', async (t) => {
    const figure = { ...PRESETS.miru, id: 'leaning', anchor: [60, 256] };
    const { dom, state } = await mountPet(t, { figure });
    const { width, anchor } = state.view;
    const [left, right] = [anchor[0], width - anchor[0]];
    assert.ok(right > left + 10, 'her feet are left of center');
    // She turns by mirroring around her feet: at either limit, facing either way, all of her is on screen.
    const fit = limits(state.perchOptions)!;
    for (const x of [fit.left, fit.right]) {
      for (const [before, after] of [[left, right], [right, left]] as const) {
        assert.ok(x - before >= -1e-9 && x + after <= 1024 + 1e-9, `fits at ${x}`);
      }
    }
    dom.frame(300);
    const ground = stand(state, 500);
    state.until = state.clock / 1000 + 60;
    for (const facing of [-1, 1, -1] as const) {
      state.view.setFacing(facing);
      for (let i = 0; i < 20; i++) dom.frame(20);
      assert.equal(state.mode, 'ground', 'turning around does not drop her');
      assert.equal(state.perch?.el, ground.el);
    }
  });

  it('keeps a jump on screen when its target moves partly out of view', async (t) => {
    const { dom, state } = await mountPet(t);
    const shelf = dom.document.createElement('div');
    shelf.setAttribute('data-peetty', 'perch');
    shelf.rect = { left: 600, top: 400, width: 300, height: 40 };
    dom.document.body.append(shelf);
    dom.frame(300);
    const target = state.scan(true).find((p) => p.el === shelf as unknown as Element);
    assert.ok(target);
    const from: [number, number] = [500, 450];
    // Assigned together so the checks below are not narrowed to these values.
    Object.assign(state, {
      jump: { from, plan: planJump(from, [850, 400])!, t: 0, target, targetOrigin: [target.left, target.y], hang: false },
      perch: null,
      mode: 'jump',
    });
    const fit = limits(state.perchOptions)!;
    for (let i = 0; i < 5; i++) dom.frame(20);
    // Scrolled sideways mid-flight, the shelf now runs past the right edge of the viewport.
    shelf.rect = { left: 800, top: 400, width: 300, height: 40 };
    for (let i = 0; state.mode === 'jump' && i < 60; i++) {
      dom.frame(20);
      assert.ok(state.x <= fit.right + 1e-9, `on screen at ${state.x}`);
    }
    assert.equal(state.mode, 'ground');
    assert.equal(state.perch?.el, shelf as unknown as Element);
  });

  it('walks only as far as she can without covering a click area beyond a control', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const shelf = dom.document.createElement('div');
    shelf.setAttribute('data-peetty', 'perch');
    shelf.rect = { left: 100, top: 500, width: 800, height: 40 };
    // A button whose ::after reaches over the right end of the shelf, far beyond its own box.
    const button = dom.document.createElement('button');
    button.rect = { left: 800, top: 300, width: 40, height: 14 };
    button.hitArea = { left: 650, top: 380, width: 300, height: 120 };
    dom.document.body.append(shelf, button);
    dom.frame(300);
    const on = state.scan(true).find((p) => p.el === shelf as unknown as Element);
    assert.ok(on, 'the middle of the shelf is clear');
    state.x = 200;
    state.land(on, 0.2);
    mock.method(Math, 'random', () => 0.999); // toward the far right end
    pet.play('walk');
    assert.equal(state.action, 'walk');
    const half = Math.max(state.view.anchor[0], state.view.width - state.view.anchor[0]);
    for (let i = 0; state.action === 'walk' && i < 600; i++) {
      dom.frame(20);
      assert.ok(state.x + half <= 650, `clear of the click area at ${state.x}`);
    }
    assert.equal(state.mode, 'ground', 'she stops instead of dropping');
    assert.ok(state.x > 300, `she still walked toward it, to ${state.x}`);
  });

  it('does not leap to a spot where she would cover a click area beyond a control', async (t) => {
    const { dom, state } = await mountPet(t);
    const shelf = (left: number, top: number) => {
      const el = dom.document.createElement('div');
      el.setAttribute('data-peetty', 'perch');
      el.rect = { left, top, width: 300, height: 40 };
      dom.document.body.append(el);
      return el as unknown as Element;
    };
    const start = shelf(100, 500);
    const target = shelf(450, 450);
    // A button whose ::after reaches over the left part of the target shelf, but not its middle.
    const button = dom.document.createElement('button');
    button.rect = { left: 450, top: 250, width: 30, height: 14 };
    button.hitArea = { left: 450, top: 340, width: 110, height: 110 };
    dom.document.body.append(button);
    dom.frame(300);
    const perches = state.scan(true);
    const on = perches.find((p) => p.el === start);
    assert.ok(on);
    assert.ok(perches.some((p) => p.el === target), 'the middle of the target shelf is clear');
    state.x = 250;
    state.land(on, 0.2);
    mock.method(Math, 'random', () => 0); // the target shelf first, at its left part
    assert.ok(state.leap());
    assert.notEqual((state.jump as { target: Perch }).target.el, target);
  });

  it('lands on a lower edge crossed in the same frame when the higher one is covered', async (t) => {
    const { dom, state } = await mountPet(t);
    const shelf = (top: number) => {
      const el = dom.document.createElement('div');
      el.setAttribute('data-peetty', 'perch');
      el.rect = { left: 300, top, width: 300, height: 40 };
      dom.document.body.append(el);
      return el as unknown as Element;
    };
    const high = shelf(400);
    const low = shelf(440);
    dom.frame(300);
    const perches = state.scan(true);
    for (const el of [high, low]) assert.ok(perches.some((p) => p.el === el));
    // A menu opens over the higher edge after the scan.
    const menu = dom.document.createElement('div');
    menu.rect = { left: 0, top: 380, width: 1024, height: 40 };
    dom.document.body.append(menu);
    state.startFall();
    state.x = 450;
    state.y = 390;
    state.vy = 2400;
    dom.frame(50); // One frame carries her past both edges.
    assert.equal(state.mode, 'ground');
    assert.equal(state.perch?.el, low);
  });

  it('does not leap to a perch whose arc would leave the top of the viewport', async (t) => {
    const { dom, state } = await mountPet(t);
    const high = dom.document.createElement('button');
    high.setAttribute('data-peetty', 'perch');
    high.rect = { left: 300, top: 140, width: 300, height: 40 };
    const middle = dom.document.createElement('button');
    middle.setAttribute('data-peetty', 'perch');
    middle.rect = { left: 300, top: 400, width: 300, height: 40 };
    dom.document.body.append(high, middle);
    dom.frame(300);
    const perches = state.scan(true);
    assert.ok(perches.some((perch) => perch.el === high as unknown as Element), 'the high edge is a valid perch');
    const start = perches.find((perch) => perch.el === middle as unknown as Element)!;
    state.x = 450;
    state.land(start, 0.2);
    // Without a ceiling the preferred high perch, listed first, would win this draw.
    mock.method(Math, 'random', () => 0);
    assert.ok(state.leap());
    const jump = state.jump as { from: [number, number]; plan: { apex: number }; target: Perch };
    assert.notEqual(jump.target.el, high as unknown as Element);
    assert.ok(Math.min(jump.from[1], jump.target.y) - jump.plan.apex >= state.view.anchor[1] * 1.15 - 1e-6);
  });

  it('drops in calmly, but a long leap down frightens her', async (t) => {
    const { dom, state } = await mountPet(t);
    const motion = () => state.view.motion as unknown as { soul: number };
    assert.equal(state.mode, 'fall');
    assert.equal(state.calmFall, true);
    let calmSoul = 0;
    for (let i = 0; state.mode === 'fall' && i < 100; i++) {
      dom.frame(20);
      calmSoul = Math.max(calmSoul, motion().soul);
    }
    assert.equal(state.mode, 'ground');
    assert.equal(calmSoul, 0, 'dropping in does not frighten her');
    const high = dom.document.createElement('button');
    high.setAttribute('data-peetty', 'perch');
    high.rect = { left: 300, top: 200, width: 300, height: 40 };
    dom.document.body.append(high);
    dom.frame(300);
    const start = state.scan(true).find((perch) => perch.el === high as unknown as Element)!;
    state.x = 450;
    state.land(start, 0.2);
    mock.method(Math, 'random', () => 0);
    assert.ok(state.leap());
    assert.equal(state.mode, 'jump');
    let frightened = false;
    let soul = 0;
    for (let i = 0; state.mode === 'jump' && i < 100; i++) {
      dom.frame(20);
      frightened ||= state.view.motion.current === 'fall';
      soul = Math.max(soul, motion().soul);
    }
    assert.ok(frightened, 'she starts falling once past the top of the arc');
    assert.ok(soul > 0.5, 'her soul leaves on the way down');
    assert.equal(state.mode, 'ground');
  });

  it('initializes a reachable public walking destination and eventually stops', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const perch = stand(state);
    mock.method(Math, 'random', () => 0);
    pet.play('walk');
    assert.equal(state.action, 'walk');
    assert.ok(state.walkTo >= perch.left && state.walkTo <= perch.right);
    for (let i = 0; state.action === 'walk' && i < 500; i++) dom.frame(20);
    assert.equal(state.action, 'idle');
    assert.ok(state.x >= perch.left && state.x <= perch.right);
  });

  it('clamps a walking destination when its perch moves while still supporting her', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const element = dom.document.createElement('button');
    element.rect = { left: 200, top: 400, width: 300, height: 40 };
    element.setAttribute('data-peetty', 'perch');
    dom.document.body.append(element);
    dom.frame(300);
    const perch = state.scan(true).find((perch) => perch.el === element as unknown as Element);
    assert.ok(perch);
    state.x = 250;
    state.land(perch, 0.2);
    mock.method(Math, 'random', () => 0);
    pet.play('walk');
    const original = state.walkTo;
    element.rect.left = 230;
    dom.frame(300);
    assert.ok(state.perch);
    assert.ok(state.walkTo >= state.perch.left && state.walkTo <= state.perch.right);
    assert.notEqual(state.walkTo, original);
  });

  for (const action of ['wave', 'talk'] as const) {
    it(`honors the configured ${action} weight`, async (t) => {
      const { pet, state } = await mountPet(t);
      stand(state);
      const figure = structuredClone(PRESETS.miru) as RigFigure;
      figure.behavior = { weights: Object.fromEntries(AUTONOMOUS_ACTIONS.map((name) => [name, name === action ? 1 : 0])) };
      await pet.setFigure(figure);
      state.decide();
      assert.equal(state.action, action);
      assert.equal(state.view.motion.current, action);
    });
  }

  it('ignores physics and unknown keys even if data is mutated after validation', async (t) => {
    const { state } = await mountPet(t);
    stand(state);
    const weights: Record<string, number> = Object.fromEntries(AUTONOMOUS_ACTIONS.map((name) => [name, 0]));
    Object.assign(weights, { idle: 1, drag: 100, hang: 100, fall: 100, mystery: 100 });
    state.figure = { ...state.figure, behavior: { weights } } as Figure;
    state.decide();
    assert.equal(state.action, 'idle');
    assert.equal(state.mode, 'ground');
  });
});

describe('pointer and shadow event routing', () => {
  it('keeps the initiating pointer when another pointer presses, releases or cancels', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 2));
    assert.equal(state.press?.id, 1);
    dom.window.dispatchEvent(pointer('pointermove', 1, 130, 130));
    assert.equal(state.mode, 'drag');
    dom.window.dispatchEvent(pointer('pointerup', 2));
    dom.window.dispatchEvent(pointer('pointercancel', 2));
    assert.equal(state.press?.id, 1);
    assert.equal(state.mode, 'drag');
    dom.window.dispatchEvent(pointer('pointerup', 1));
    assert.equal(state.press, null);
    assert.equal(state.mode, 'fall');
  });

  it('cancelling the owning pointer ends dragging without greeting or throw velocity', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointercancel', 1));
    assert.equal(state.action, 'idle');
    assert.equal(dom.timers.size, 0);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointermove', 1, 130, 130));
    dom.frame();
    dom.window.dispatchEvent(pointer('pointermove', 1, 180, 180));
    dom.window.dispatchEvent(pointer('pointercancel', 1));
    assert.equal(state.mode, 'fall');
    assert.deepEqual([state.vx, state.vy], [0, 0]);
    assert.equal(dom.timers.size, 0);
  });

  it('keeps flying upward when let go mid-swing, and is frightened only on the way down', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state, 500);
    const motion = () => state.view.motion as unknown as { soul: number };
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1, 500, 700));
    // Swing upward at 1500 px/s and let go while still moving.
    for (let i = 1; i <= 8; i++) {
      dom.frame(10);
      dom.window.dispatchEvent(pointer('pointermove', 1, 500, 700 - 15 * i));
    }
    dom.window.dispatchEvent(pointer('pointerup', 1, 500, 580));
    assert.equal(state.mode, 'fall');
    assert.ok(Math.abs(state.vy + 1500) < 1, `thrown at ${state.vy} px/s`);
    const released = state.y;
    let peak = released;
    let soulRising = 0;
    let soulFalling = 0;
    for (let i = 0; state.mode === 'fall' && i < 150; i++) {
      dom.frame(16);
      peak = Math.min(peak, state.y);
      if (state.vy < 0) soulRising = Math.max(soulRising, motion().soul);
      else soulFalling = Math.max(soulFalling, motion().soul);
    }
    assert.ok(released - peak > 350, `rose ${released - peak}px after release`);
    assert.equal(soulRising, 0, 'calm while still flying up');
    assert.ok(soulFalling > 0.5, 'frightened once she comes down');
    assert.equal(state.mode, 'ground');
  });

  it('throws nothing when the pointer stopped before release, and keeps speed past the viewport edge', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state, 500);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1, 500, 700));
    for (let i = 1; i <= 5; i++) {
      dom.frame(10);
      dom.window.dispatchEvent(pointer('pointermove', 1, 500, 700 - 30 * i));
    }
    dom.frame(200);
    dom.window.dispatchEvent(pointer('pointerup', 1, 500, 550));
    assert.deepEqual([state.vx, state.vy], [0, 0]);
    stand(state, 500);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1, 500, 100));
    // Flung up out of the window: she stays pinned at the top, but the throw keeps its speed.
    for (let i = 1; i <= 5; i++) {
      dom.frame(10);
      dom.window.dispatchEvent(pointer('pointermove', 1, 500, 100 - 20 * i));
    }
    assert.equal(state.y, state.view.anchor[1]);
    dom.window.dispatchEvent(pointer('pointerup', 1, 500, 0));
    assert.ok(state.vy <= -1999, `thrown at ${state.vy} px/s`);
  });

  it('gives the pointer back to the page when hidden mid-drag or mid-press', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const petEl = state.overlay.pet as unknown as ElementStub;
    stand(state, 500);
    petEl.dispatchEvent(pointer('pointerdown', 1, 500, 700));
    dom.window.dispatchEvent(pointer('pointermove', 1, 520, 650));
    assert.equal(state.mode, 'drag');
    assert.ok(petEl.captures.has(1));
    pet.hide();
    assert.equal(petEl.captures.has(1), false, 'released when hidden mid-drag');
    assert.equal(state.press, null);
    pet.show();
    stand(state, 500);
    petEl.dispatchEvent(pointer('pointerdown', 2, 500, 700));
    assert.ok(petEl.captures.has(2));
    pet.hide();
    assert.equal(petEl.captures.has(2), false, 'released when hidden mid-press');
  });

  it('draws pointer movement only on animation frames', async (t) => {
    const { dom, state } = await mountPet(t);
    const step = mock.method(state.view, 'step');
    const place = mock.method(state, 'place');
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    for (let i = 0; i < 10; i++) dom.window.dispatchEvent(pointer('pointermove', 1, 130 + i, 130 + i));
    assert.equal(step.mock.callCount(), 0);
    assert.equal(place.mock.callCount(), 0);
    dom.frame();
    assert.equal(step.mock.callCount(), 1);
    assert.equal(place.mock.callCount(), 1);
  });

  it('makes room when the field she sits on is focused without a focus event reaching her', async (t) => {
    const { dom, state } = await mountPet(t);
    const field = dom.document.createElement('input');
    field.rect = { left: 100, top: 500, width: 300, height: 40 };
    // Within jumping reach of the field.
    const shelf = dom.document.createElement('div');
    shelf.setAttribute('data-peetty', 'perch');
    shelf.rect = { left: 450, top: 400, width: 300, height: 40 };
    dom.document.body.append(field, shelf);
    dom.frame(300);
    const seat = state.scan(true).find((p) => p.el === field as unknown as Element);
    assert.ok(seat);
    state.x = 250;
    state.land(seat, 0.2);
    mock.method(Math, 'random', () => 0.5);
    // Focus set by script: no focusin event reaches her.
    dom.document.activeElement = field;
    dom.frame(20);
    assert.equal(state.mode, 'jump', 'she hops off the field instead of dropping through it');
    assert.notEqual((state.jump as { target: Perch }).target.el, field as unknown as Element);
    assert.ok(state.overlay.bubble.classList.contains('show'), 'and says she moved');
  });

  it('uses the editable element from composedPath for focus and typing', async (t) => {
    const { dom, state } = await mountPet(t);
    const host = dom.document.createElement('custom-editor');
    const input = dom.document.createElement('input');
    host.attachShadow().append(input);
    dom.document.body.append(host);
    const makeRoom = mock.method(state, 'makeRoom', () => {});
    const focus = new Event('focusin');
    Object.defineProperty(focus, 'composedPath', { value: () => [input, host, dom.document] });
    dom.document.dispatchEvent(focus);
    assert.equal(makeRoom.mock.calls[0]?.arguments[0], input);
    stand(state);
    state.action = 'walk';
    dom.frame();
    const key = new Event('keydown');
    Object.defineProperty(key, 'composedPath', { value: () => [input, host, dom.document] });
    dom.document.dispatchEvent(key);
    assert.equal(makeRoom.mock.calls.at(-1)?.arguments[0], input);
    assert.equal(state.lastKey, state.clock);
    assert.equal(state.action, 'idle');
  });
});

describe('overlay geometry and weighted selection', () => {
  it('reuses menu and bubble dimensions until content, resize or observation changes them', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    const menu = state.overlay.menu as unknown as ElementStub;
    const bubble = state.overlay.bubble as unknown as ElementStub;
    menu.classList.add('show');
    pet.say('hello');
    for (let i = 0; i < 20; i++) state.place();
    assert.equal(menu.dimensionReads, 2);
    assert.equal(bubble.dimensionReads, 2);
    pet.say('a different message');
    state.place();
    assert.equal(menu.dimensionReads, 2);
    assert.equal(bubble.dimensionReads, 4);
    dom.window.dispatchEvent(new Event('resize'));
    state.place();
    assert.equal(menu.dimensionReads, 4);
    assert.equal(bubble.dimensionReads, 6);
    dom.resize(menu);
    state.place();
    assert.equal(menu.dimensionReads, 6);
    assert.equal(bubble.dimensionReads, 6);
  });

  it('selects object candidates with the same weighted helper as action keys', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    assert.equal(weighted([[first, 1], [second, 3]] as const, () => 0.1), first);
    assert.equal(weighted([[first, 1], [second, 3]] as const, () => 0.8), second);
    assert.equal(weighted([[first, Infinity], [second, 1]] as const, () => 0), second);
    assert.equal(weighted([]), null);
  });
});
