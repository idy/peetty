import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { afterEach, describe, it, mock } from 'node:test';
import { build } from 'esbuild';
import { Window as BrowserWindow } from 'happy-dom';
import { Peetty } from '../src/pet/pet.ts';
import { SoundPlayer } from '../src/pet/sound.ts';
import { AUTONOMOUS_ACTIONS, type Figure, type RigFigure } from '../src/figure/types.ts';
import type { FigureView } from '../src/figure/view.ts';
import { PRESETS } from '../src/presets.ts';
import { floor, limits, type Perch, type PerchOptions } from '../src/pet/perches.ts';
import { planJump, weighted } from '../src/pet/physics.ts';
import type { Overlay } from '../src/pet/ui.ts';
import type { CompanionAction, PeettyModelOptions } from '../src/chat/types.ts';
import { createChatPanel } from '../src/chat/panel.ts';
import { BrowserProfileStore, type ProfileRecord } from '../src/chat/profiles.ts';
import { languageOf, strings, type Language } from '../src/pet/i18n.ts';
import { deferred, ElementStub, installPetDOM, pointer } from './helpers/pet-dom.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';
import { stubGlobals } from './helpers/stubs.ts';

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
  walkOver: (target: number) => void;
  chatVisible: boolean;
  chatWorking: boolean;
  chatSpeaking: boolean;
  chatGestureUntil: number;
  performChatAction: (action: CompanionAction, signal?: AbortSignal) => Promise<string>;
  updateChatAction: () => void;
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

/** Use a bubbling shadow DOM for keyboard boundaries; geometry stays in the controller harness. */
async function mountKeyboardPet(t: Parameters<typeof installPetDOM>[0], options: ConstructorParameters<typeof Peetty>[0] = {}) {
  const dom = installPetDOM(t);
  const window = new BrowserWindow({ url: 'https://host.example/' });
  const restore = stubGlobals({ window, document: window.document, Element: window.Element });
  const pet = new Peetty({ greet: false, ...options });
  dom.cleanup(() => { pet.destroy(); window.close(); restore(); });
  const state = controller(pet);
  mock.method(state, 'scan', () => []);
  await pet.mount();
  return { pet, state, window: window as unknown as Window & typeof globalThis };
}

function stand(state: Controller, x = 300) {
  const perch = floor(state.perchOptions);
  assert.ok(perch);
  state.x = x;
  state.land(perch, 0.2);
  return perch;
}

function chatPanelStub(setModel: (model: PeettyModelOptions) => Promise<void> = async () => {}) {
  return {
    isOpen: false,
    language: 'en' as Language,
    open() { this.isOpen = true; },
    close() { this.isOpen = false; },
    setLanguage(language: Language) { this.language = language; },
    setModel,
    destroy() { this.isOpen = false; },
  };
}

function attachChatPanel(pet: Peetty, setModel: (model: PeettyModelOptions) => Promise<void> = async () => {}) {
  const panel = chatPanelStub(setModel);
  const host = pet as unknown as { chatPanel: typeof panel; chatLoading: Promise<typeof panel> };
  host.chatPanel = panel;
  host.chatLoading = Promise.resolve(panel);
  return panel;
}

/** Exercise the real initialization chain with only the lazy chat module replaced. */
async function petWithChatLoader(loadChatPanel: typeof import('../src/chat/load.ts').loadChatPanel): Promise<typeof Peetty> {
  let replaced = false;
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/pet/pet.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{
      name: 'deferred-chat-loader',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]chat[\\/]load\.ts$/ }, () => {
          replaced = true;
          return { contents: 'export const loadChatPanel = () => loadChatPanelForTest();' };
        });
      },
    }],
  });
  assert.equal(replaced, true, 'The lazy chat module must be replaced by the fixture on every platform.');
  const module = { exports: {} as { Peetty: typeof Peetty } };
  runInThisContext(`(function(module, loadChatPanelForTest) { ${result.outputFiles[0]!.text}\n})`)(module, loadChatPanel);
  return module.exports.Peetty;
}

/** Keep the controller's deterministic frame loop while exercising its real lazy panel and storage. */
async function mountProfileChatPet(t: Parameters<typeof installPetDOM>[0], options: ConstructorParameters<typeof Peetty>[0]) {
  const IsolatedPeetty = await petWithChatLoader(async () => ({ createChatPanel }));
  const dom = installPetDOM(t);
  const window = new BrowserWindow({ url: 'https://host.example/', settings: { enableIframePageLoading: true } });
  const restore = stubGlobals({ window, document: window.document, location: window.location, Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, matchMedia: window.matchMedia.bind(window) });
  const pet = new IsolatedPeetty({ greet: false, language: 'en', ...options });
  dom.cleanup(() => { pet.destroy(); window.close(); restore(); });
  const state = controller(pet);
  mock.method(state, 'scan', () => []);
  await pet.mount();
  const root = () => {
    const frame = state.overlay.host.shadowRoot!.querySelector<HTMLIFrameElement>('iframe');
    assert.ok(frame, 'the public chat entry point installed a real panel');
    const result = frame.contentDocument!.body.firstElementChild!.shadowRoot;
    assert.ok(result); return result;
  };
  const query = <T extends HTMLElement>(selector: string): T => {
    const result = root().querySelector<T>(selector); assert.ok(result, `${selector} exists`); return result;
  };
  const click = (text: string) => {
    const result = [...root().querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
    assert.ok(result, `${text} button exists`); result.click();
  };
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 1_000 && !condition(); i++) {
      await settle();
      dom.frame(0); // Advance yielding backup work without advancing gesture/deadline clocks.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(condition(), 'expected asynchronous panel work to finish');
  };
  return { dom, pet, state, window, root, query, click, settle, waitFor };
}

describe('Pet profile figure integration', () => {
  for (const interruption of ['ready', 'superseded', 'destroyed', 'failed'] as const) {
    it(`applies and settles a figure before stalled chat initialization is ${interruption}`, async (t) => {
      const module = deferred<{ createChatPanel: typeof createChatPanel }>();
      const entered = deferred<void>();
      const updates: (string | object)[] = [];
      const panel = { ...chatPanelStub(), async setFigure(figure: string | object) { updates.push(figure); } };
      const IsolatedPeetty = await petWithChatLoader(() => { entered.resolve(); return module.promise; });
      const dom = installPetDOM(t);
      const pet = new IsolatedPeetty({ greet: false }); dom.cleanup(() => pet.destroy());
      await pet.mount();
      const opening = pet.openChat(); await entered.promise;
      const changing = pet.setFigure('elsie');
      for (let i = 0; i < 100 && controller(pet).figure.id !== 'elsie'; i++) await Promise.resolve();
      assert.equal(controller(pet).figure.id, 'elsie', 'loaded artwork is independent of the stalled module');
      const settled = await Promise.race([changing.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
      assert.equal(settled, true, 'setFigure must not retain a chat-loading wait');
      if (interruption === 'superseded') await pet.setFigure('koharu');
      if (interruption === 'destroyed') pet.destroy();
      if (interruption === 'failed') module.reject(new Error('Synthetic chat module failure'));
      else module.resolve({ createChatPanel: async () => panel });
      await opening;
      if (interruption === 'destroyed') {
        assert.deepEqual(updates, []); assert.equal(pet.mounted, false);
      } else if (interruption === 'failed') {
        assert.deepEqual(updates, []); assert.equal(controller(pet).figure.id, 'elsie');
      } else {
        const expected = interruption === 'superseded' ? 'koharu' : 'elsie';
        assert.equal(controller(pet).figure.id, expected);
        assert.deepEqual(updates, [expected], 'only the newest selection reconciles into the panel');
        assert.equal(panel.isOpen, true);
      }
    });
  }
  it('restores skipped saved artwork after an SDK request fails during panel construction', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'sdk-figure-init-failed-restore';
    const seed = new BrowserProfileStore(namespace); await seed.initialize({ name: 'Saved Elsie', figure: 'elsie' }); t.after(() => seed.close());
    const savedId = seed.activeProfileId;
    const mounted = await seed.create({ name: 'Mounted Miru', figure: 'miru' }); await seed.select(savedId);
    const { pet, state, query, settle, window } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    assert.equal(state.view.renderer.figure.id, 'miru');
    const entered = deferred<void>(); const release = deferred<void>(); const response = deferred<Response>();
    const initialize = BrowserProfileStore.prototype.initialize;
    mock.method(BrowserProfileStore.prototype, 'initialize', async function(this: BrowserProfileStore, ...args: Parameters<typeof initialize>) {
      await initialize.apply(this, args); entered.resolve(); await release.promise;
    });
    mock.method(globalThis, 'fetch', () => response.promise);
    const opening = pet.openChat(); await entered.promise;
    const changing = pet.setFigure('/synthetic-failed-sdk.json');
    const failed = assert.rejects(changing, /HTTP 503/);
    release.resolve(); await opening; await settle();
    assert.equal(query('.pc-name').textContent, 'Saved Elsie');
    response.resolve(new Response('', { status: 503 })); await failed; await settle();
    assert.equal(state.view.renderer.figure.id, 'elsie', 'the actual saved figure replaces the old mounted artwork');
    assert.equal(query('.peetty-chat').dataset.color, 'blue');
    assert.equal(seed.activeProfile.figure, 'elsie');
    await pet.configure();
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = mounted.id;
    selector.dispatchEvent(new window.Event('change') as unknown as Event);
    for (let i = 0; i < 1_000 && selector.disabled; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(selector.disabled, false); await settle();
    assert.equal(state.view.renderer.figure.id, 'miru', 'retry updates panel bookkeeping before a later profile switch');
    assert.equal(query('.pc-name').textContent, 'Mounted Miru');
  });

  it('invalidates an SDK load when switching to another profile with the same current figure', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'sdk-figure-initiating-owner';
    const seed = new BrowserProfileStore(namespace); await seed.initialize({ name: 'First owner' }); t.after(() => seed.close());
    const firstId = seed.activeProfileId;
    const second = await seed.create({ name: 'Second owner', figure: 'miru' });
    await seed.select(firstId);
    const { pet, state, query, window, settle } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    await pet.openChat();
    const delayed = deferred<Response>(); let signal: AbortSignal | null | undefined;
    mock.method(globalThis, 'fetch', (_input: unknown, options?: RequestInit) => { signal = options?.signal; return delayed.promise; });
    const changing = pet.setFigure('/synthetic-late-sdk.json'); await turns();
    await pet.configure();
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = second.id;
    selector.dispatchEvent(new window.Event('change') as unknown as Event); await settle();
    assert.equal(query('.pc-name').textContent, 'Second owner');
    assert.equal(signal?.aborted, true, 'switching ownership cancels the obsolete SDK request');
    delayed.resolve(response(PRESETS.elsie)); await changing; await settle();
    assert.equal(state.view.renderer.figure.id, 'miru');
    const inspect = new BrowserProfileStore(namespace); await inspect.initialize(); t.after(() => inspect.close());
    assert.equal(inspect.profileInfo(firstId)?.figure, 'miru');
    assert.equal(inspect.profileInfo(second.id)?.figure, 'miru');
  });

  it('restores the destination artwork when switching while SDK figure persistence is pending', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'sdk-figure-pending-persistence';
    const seed = new BrowserProfileStore(namespace); await seed.initialize({ name: 'First owner' }); t.after(() => seed.close());
    const firstId = seed.activeProfileId;
    const second = await seed.create({ name: 'Second owner', figure: 'miru' }); await seed.select(firstId);
    const { pet, state, query, window, settle } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    await pet.configure();
    const entered = deferred<void>(); const release = deferred<void>();
    const update = BrowserProfileStore.prototype.update;
    mock.method(BrowserProfileStore.prototype, 'update', async function(this: BrowserProfileStore, ...args: Parameters<typeof update>) {
      if (args[0] === firstId && args[1].figure === 'elsie') { entered.resolve(); await release.promise; }
      return update.apply(this, args);
    });
    const changing = pet.setFigure('elsie'); await entered.promise;
    assert.equal(state.view.renderer.figure.id, 'elsie');
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = second.id;
    selector.dispatchEvent(new window.Event('change') as unknown as Event);
    for (let i = 0; i < 1_000 && selector.disabled; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(selector.disabled, false); await settle();
    assert.equal(state.view.renderer.figure.id, 'miru', 'the old panel figure cannot hide a changed SDK view');
    release.resolve(); await changing;
    assert.equal(state.view.renderer.figure.id, 'miru');
    const inspect = new BrowserProfileStore(namespace); await inspect.initialize(); t.after(() => inspect.close());
    assert.equal(inspect.activeProfileId, second.id);
    assert.equal(inspect.profileInfo(second.id)?.figure, 'miru');
  });

  it('reconciles an SDK figure requested during panel construction into the initial owning profile', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'sdk-figure-during-chat-loading';
    const { pet, state, query, settle } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    const entered = deferred<void>(); const release = deferred<void>();
    const initialize = BrowserProfileStore.prototype.initialize;
    mock.method(BrowserProfileStore.prototype, 'initialize', async function(this: BrowserProfileStore, ...args: Parameters<typeof initialize>) {
      await initialize.apply(this, args); entered.resolve(); await release.promise;
    });
    const opening = pet.openChat(); await entered.promise;
    const changing = pet.setFigure('elsie'); await turns();
    release.resolve(); await Promise.all([opening, changing]); await settle();
    assert.equal(state.view.renderer.figure.id, 'elsie');
    assert.equal(query<HTMLElement>('.peetty-chat').dataset.color, 'blue', 'the portrait follows the reconciled selection');
    const inspect = new BrowserProfileStore(namespace); await inspect.initialize(); t.after(() => inspect.close());
    assert.equal(inspect.activeProfile.figure, 'elsie');
  });

  it('shares remote artwork with its portrait and fetches a fresh response on a later selection', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'single-profile-figure-resolution';
    const url = 'https://figures.example.test/synthetic-variable.json';
    const seed = new BrowserProfileStore(namespace); await seed.initialize({ name: 'Bundled owner' }); t.after(() => seed.close());
    const firstId = seed.activeProfileId;
    const remote = await seed.create({ name: 'Remote owner', figure: url }); await seed.select(firstId);
    let requests = 0;
    mock.method(globalThis, 'fetch', async () => response([PRESETS.elsie, PRESETS.amara, PRESETS.riley][requests++]!));
    const { pet, state, query, window, settle } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    await pet.configure();
    const select = async (id: string) => {
      const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = id;
      selector.dispatchEvent(new window.Event('change') as unknown as Event);
      for (let i = 0; i < 1_000 && selector.disabled; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(selector.disabled, false, 'the profile figure operation has completed');
      await settle();
    };
    await select(remote.id);
    assert.equal(requests, 1, 'pet and portrait consume the same resolved figure');
    assert.equal(state.view.renderer.figure.id, 'elsie');
    assert.equal(query<HTMLElement>('.peetty-chat').dataset.color, 'blue');
    await select(firstId); await select(remote.id);
    assert.equal(requests, 2, 'completed loads do not become a stale URL cache');
    assert.equal(state.view.renderer.figure.id, 'amara');
    assert.equal(query<HTMLElement>('.peetty-chat').dataset.color, 'teal');
    await pet.setFigure(url); await settle();
    assert.equal(requests, 3, 'an explicit refresh of the current URL also resolves fresh artwork');
    assert.equal(state.view.renderer.figure.id, 'riley');
    assert.equal(query<HTMLElement>('.peetty-chat').dataset.color, 'green', 'the portrait refreshes even when the persisted URL is unchanged');
  });

  it('restores saved Elsie through default SDK openChat after mounting Miru', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'pet-saved-elsie';
    const saved = new BrowserProfileStore(namespace); await saved.initialize({ name: 'Saved Elsie', figure: 'elsie' }); t.after(() => saved.close());
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    const { pet, state, query } = await mountProfileChatPet(t, { chat: { storageKey: namespace } });
    assert.equal(state.view.renderer.figure.id, 'miru');
    await pet.openChat();
    assert.equal(state.view.renderer.figure.id, 'elsie', 'the saved profile changes the mounted companion');
    assert.equal(query('.pc-name').textContent, 'Saved Elsie');
    assert.equal(query<HTMLElement>('.peetty-chat').hidden, false); assert.equal(state.chatVisible, true);
    assert.equal(network.mock.callCount(), 0);
  });

  for (const source of ['PRESETS.elsie', 'custom inline figure'] as const) {
    it(`keeps ${source} through profile rename, memory toggle and full backup`, async (t) => {
      installChatIndexedDB(t);
      const figure = source === 'PRESETS.elsie' ? PRESETS.elsie : { ...structuredClone(PRESETS.koharu), id: 'inline-custom-pet', name: { en: 'Inline custom pet', zh: '内联角色' } };
      const { pet, state, root, query, click, settle, waitFor, window } = await mountProfileChatPet(t, { figure, chat: { storageKey: `pet-inline-${source}` } });
      await pet.openChat(); assert.deepEqual(state.view.renderer.figure, figure);
      await pet.configure(); query<HTMLButtonElement>('[data-tab="profile"]').click();
      const name = query<HTMLInputElement>('[aria-label="Profile name"]'); name.value = 'Renamed inline companion'; name.form!.requestSubmit(); await settle();
      assert.deepEqual(state.view.renderer.figure, figure, 'saving unrelated settings keeps the inline artwork');
      query<HTMLButtonElement>('[data-tab="memory"]').click();
      const recall = query<HTMLInputElement>('[data-setting="useMemories"]'); recall.checked = false; recall.dispatchEvent(new window.Event('change') as unknown as Event); await settle();
      assert.deepEqual(state.view.renderer.figure, figure, 'memory settings reload the same inline character');
      let downloaded: Blob | undefined;
      mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:pet-inline-backup'; }); mock.method(URL, 'revokeObjectURL', () => {});
      root().addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
      query<HTMLButtonElement>('[data-tab="data"]').click(); click('Download full backup'); await waitFor(() => downloaded !== undefined);
      assert.ok(downloaded); const backup = JSON.parse(await downloaded.text()) as { activeProfileId: string; profiles: ProfileRecord[] };
      const profile = backup.profiles.find((item) => item.id === backup.activeProfileId)!;
      assert.equal(profile.name, 'Renamed inline companion'); assert.equal(profile.useMemories, false); assert.deepEqual(profile.figure, figure);
    });
  }

  it('syncs a public setFigure inline replacement to profile reloads and backup', async (t) => {
    installChatIndexedDB(t);
    const { pet, state, root, query, click, settle, waitFor, window } = await mountProfileChatPet(t, { chat: { storageKey: 'pet-inline-replacement' } });
    await pet.openChat();
    const figure = { ...structuredClone(PRESETS.amara), id: 'replacement-inline-pet', name: 'Replacement inline pet' };
    await pet.setFigure(figure); assert.deepEqual(state.view.renderer.figure, figure);
    await pet.configure(); query<HTMLButtonElement>('[data-tab="profile"]').click();
    const name = query<HTMLInputElement>('[aria-label="Profile name"]'); name.value = 'Replacement saved'; name.form!.requestSubmit(); await settle();
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    const automatic = query<HTMLInputElement>('[data-setting="autoRemember"]'); automatic.checked = true; automatic.dispatchEvent(new window.Event('change') as unknown as Event); await settle();
    assert.deepEqual(state.view.renderer.figure, figure, 'a profile reload cannot revert the SDK replacement');
    let downloaded: Blob | undefined;
    mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:pet-replacement-backup'; }); mock.method(URL, 'revokeObjectURL', () => {});
    root().addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    query<HTMLButtonElement>('[data-tab="data"]').click(); click('Download full backup'); await waitFor(() => downloaded !== undefined);
    assert.ok(downloaded); const backup = JSON.parse(await downloaded.text()) as { profiles: ProfileRecord[] };
    assert.deepEqual(backup.profiles[0]!.figure, figure); assert.equal(backup.profiles[0]!.autoRemember, true);
  });

  it('mounts a supported CDN figure URL longer than 350 characters and opens the real chat', async (t) => {
    installChatIndexedDB(t);
    const url = `https://cdn.example.test/${'character-pack/'.repeat(30)}elsie.json?version=1234567890`;
    assert.ok(url.length > 350);
    const requests: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => { requests.push(String(input)); return response(PRESETS.elsie); });
    const { pet, state, query, root, click, waitFor } = await mountProfileChatPet(t, { figure: url, chat: { storageKey: 'pet-long-cdn' } });
    assert.equal(state.view.renderer.figure.id, 'elsie'); await pet.openChat();
    assert.equal(state.chatVisible, true); assert.equal(query<HTMLElement>('.peetty-chat').hidden, false);
    assert.equal(state.view.renderer.figure.id, 'elsie'); assert.deepEqual(requests, [url]);
    await pet.configure(); query<HTMLButtonElement>('[data-tab="profile"]').click(); assert.equal(query<HTMLSelectElement>('[aria-label="Character"]').value, url);
    let downloaded: Blob | undefined;
    mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:pet-cdn-backup'; }); mock.method(URL, 'revokeObjectURL', () => {});
    root().addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    query<HTMLButtonElement>('[data-tab="data"]').click(); click('Download full backup'); await waitFor(() => downloaded !== undefined);
    assert.ok(downloaded); const backup = JSON.parse(await downloaded.text()) as { profiles: ProfileRecord[] };
    assert.equal(backup.profiles[0]!.figure, url);
  });

  it('keeps the remounted selection when a deferred old panel initialization applies its saved figure', async (t) => {
    const entered = deferred<void>(); const release = deferred<void>();
    const oldPanel = chatPanelStub(); const freshPanel = chatPanelStub(); let created = 0; let accepted: void | boolean = undefined;
    const oldDestroy = mock.method(oldPanel, 'destroy');
    const create: typeof createChatPanel = async (options) => {
      if (++created > 1) return freshPanel;
      entered.resolve(); await release.promise; accepted = await options.onFigure?.('elsie'); return oldPanel;
    };
    const IsolatedPeetty = await petWithChatLoader(async () => ({ createChatPanel: create }));
    const dom = installPetDOM(t); const pet = new IsolatedPeetty({ greet: false }); dom.cleanup(() => pet.destroy());
    const opening = pet.openChat(); await entered.promise;
    pet.destroy(); await pet.setFigure('riley'); await pet.mount(); await pet.openChat();
    assert.equal(controller(pet).view.renderer.figure.id, 'riley'); assert.equal(freshPanel.isOpen, true);
    release.resolve(); await opening;
    assert.equal(accepted, false); assert.equal(controller(pet).view.renderer.figure.id, 'riley');
    assert.equal(freshPanel.isOpen, true); assert.equal(oldPanel.isOpen, false); assert.equal(oldDestroy.mock.callCount(), 1);
    assert.equal(dom.hosts.length, 1); assert.equal(dom.frames.size, 1);
  });

  it('rejects an in-flight profile figure operation after actual destroy and remount', async (t) => {
    let callbacks: Parameters<typeof createChatPanel>[0] | undefined;
    const freshUpdates: (string | object)[] = []; let created = 0;
    const IsolatedPeetty = await petWithChatLoader(async () => ({ createChatPanel: async (options) => {
      if (++created === 1) { callbacks = options; return chatPanelStub(); }
      return { ...chatPanelStub(), async setFigure(figure: string | object) { freshUpdates.push(figure); } };
    } }));
    const dom = installPetDOM(t); const pet = new IsolatedPeetty({ greet: false }); dom.cleanup(() => pet.destroy());
    await pet.openChat(); assert.ok(callbacks?.onFigure);
    const loaded = deferred<Response>(); const requested: string[] = [];
    mock.method(globalThis, 'fetch', (input: string | URL | Request) => { requested.push(String(input)); return loaded.promise; });
    const applying = callbacks.onFigure('/late-profile-figure.json'); await turns(); assert.equal(requested.length, 1);
    pet.destroy(); await pet.setFigure('elsie'); await pet.mount(); await pet.openChat();
    loaded.resolve(response(PRESETS.riley)); assert.equal(await applying, false);
    assert.equal(controller(pet).view.renderer.figure.id, 'elsie'); assert.deepEqual(freshUpdates, []);
    assert.equal(dom.hosts.length, 1); assert.equal(dom.frames.size, 1); assert.equal(controller(pet).chatVisible, true);
  });

  it('accepts only the latest asynchronous profile figure request in the same mounted generation', async (t) => {
    let callbacks: Parameters<typeof createChatPanel>[0] | undefined;
    const updates: (string | object)[] = [];
    const IsolatedPeetty = await petWithChatLoader(async () => ({ createChatPanel: async (options) => {
      callbacks = options; return { ...chatPanelStub(), async setFigure(figure: string | object) { updates.push(figure); } };
    } }));
    const dom = installPetDOM(t); const pet = new IsolatedPeetty({ greet: false }); dom.cleanup(() => pet.destroy());
    await pet.openChat(); assert.ok(callbacks?.onFigure);
    const first = deferred<Response>(); const second = deferred<Response>();
    mock.method(globalThis, 'fetch', (input: string | URL | Request) => String(input).includes('first') ? first.promise : second.promise);
    const old = callbacks.onFigure('/first-profile.json'); const current = callbacks.onFigure('/second-profile.json');
    second.resolve(response(PRESETS.amara)); assert.equal(await current, true);
    first.resolve(response(PRESETS.elsie)); assert.equal(await old, false);
    assert.equal(controller(pet).view.renderer.figure.id, 'amara'); assert.deepEqual(updates, [], 'profile application never feeds back into SDK persistence'); assert.equal(dom.hosts.length, 1);
  });
});

describe('companion action sounds', () => {
  it('starts muted and toggles a localized, keyboard-accessible preview', async (t) => {
    const { pet, state } = await mountPet(t, { language: 'en' });
    stand(state);
    const play = mock.method(SoundPlayer.prototype, 'play', () => {});
    const button = [...state.overlay.menu.children].find((node) => node.getAttribute('data-action') === 'sound')!;
    assert.equal(pet.soundEnabled, false);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    button.dispatchEvent(new Event('click'));
    assert.equal(pet.soundEnabled, true);
    assert.equal(button.textContent, strings('en').soundOn);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(play.mock.calls.map((call) => call.arguments), [['wave']]);
    pet.setLanguage('zh');
    assert.equal(button.textContent, strings('zh').soundOn);
    assert.equal(button.getAttribute('aria-label'), strings('zh').soundLabel);
    button.dispatchEvent(new Event('click'));
    assert.equal(pet.soundEnabled, false);
    assert.equal(button.textContent, strings('zh').sound);
    assert.equal(play.mock.callCount(), 1);
  });

  it('keeps programmatic sound enabling silent until a trusted activation', async (t) => {
    let contexts = 0;
    class AudioContextStub extends EventTarget {
      state: AudioContextState = 'running';
      constructor() { super(); contexts++; }
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
    }
    t.after(stubGlobals({ AudioContext: AudioContextStub }));
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    pet.setSound(true);
    pet.setSound({ volume: 0.5 });
    pet.play('wave');
    assert.equal(pet.soundEnabled, true);
    assert.equal(contexts, 0, 'settings must not create a context even when autoplay would permit it');
    const gesture = new Event('click');
    Object.defineProperty(gesture, 'isTrusted', { value: true });
    dom.window.dispatchEvent(gesture);
    assert.equal(contexts, 1, 'the first trusted activation initializes audio');
  });

  it('emits state-entry, wake, drag and landing events without repeating a pose', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    const play = mock.method(SoundPlayer.prototype, 'play', () => {});
    pet.play('wave'); pet.play('wave'); pet.play('sleep'); pet.play('sit');
    assert.deepEqual(play.mock.calls.map((call) => call.arguments[0]), ['wave', 'sleep', 'wake']);
    state.land(state.perch!, 0.2);
    const element = state.overlay.pet as unknown as ElementStub;
    element.dispatchEvent(pointer('pointerdown', 1, 300, 650));
    dom.window.dispatchEvent(pointer('pointermove', 1, 350, 550));
    assert.deepEqual(play.mock.calls.slice(-2).map((call) => call.arguments[0]), ['land', 'drag']);
  });

  it('preserves normalized optional settings and player ownership across remount', async (t) => {
    const { pet } = await mountPet(t, { sound: { enabled: true, volume: 0.4 } });
    const player = (pet as unknown as { sounds: SoundPlayer }).sounds;
    pet.setSound({ enabled: undefined, volume: undefined } as unknown as Parameters<Peetty['setSound']>[0]);
    assert.equal(pet.soundEnabled, true);
    pet.destroy();
    await pet.mount();
    assert.equal(pet.soundEnabled, true);
    assert.equal((pet as unknown as { sounds: SoundPlayer }).sounds, player, 'outstanding native work retains its owner');
  });

  it('plays an idle entry on landing when no landing cue is configured', async (t) => {
    const figure = { ...PRESETS.miru, sounds: { events: { idle: [{ notes: [440] }] } } };
    const { pet, state } = await mountPet(t, { figure });
    const play = mock.method(SoundPlayer.prototype, 'play', () => {});
    stand(state);
    pet.play('idle');
    assert.deepEqual(play.mock.calls.map((call) => call.arguments[0]), ['idle']);
    pet.play('wave');
    state.land(state.perch!, 0.2);
    assert.equal(play.mock.calls.at(-1)?.arguments[0], 'idle');
  });

  it('observes host keyboard and touch release before bubbling handlers consume them', async (t) => {
    const { window } = await mountKeyboardPet(t, { sound: true });
    const unlock = mock.method(SoundPlayer.prototype, 'unlock', () => {});
    const field = window.document.createElement('input');
    window.document.body.append(field);
    field.addEventListener('keydown', (event) => event.stopPropagation());
    const trusted = (type: string, extra: Record<string, unknown>) => {
      const event = new window.Event(type, { bubbles: true, composed: true });
      Object.defineProperty(event, 'isTrusted', { value: true });
      Object.assign(event, extra);
      return event;
    };
    field.dispatchEvent(trusted('keydown', { key: 'a' }));
    assert.equal(unlock.mock.callCount(), 1);
    field.dispatchEvent(trusted('pointerdown', { pointerType: 'touch', pointerId: 1 }));
    assert.equal(unlock.mock.callCount(), 1, 'touch down precedes user activation');
    field.dispatchEvent(trusted('pointerup', { pointerType: 'touch', pointerId: 1 }));
    assert.equal(unlock.mock.callCount(), 2, 'release can unlock in the activating event');
  });

  it('stops playback on hide, hidden tabs, figure changes and destruction', async (t) => {
    class AudioContextStub extends EventTarget {
      state: AudioContextState = 'running';
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
    }
    t.after(stubGlobals({ AudioContext: AudioContextStub }));
    const { dom, pet, state } = await mountPet(t, { sound: { enabled: true, volume: 0.4 } });
    stand(state);
    (pet as unknown as { sounds: SoundPlayer }).sounds.unlock();
    const stop = mock.method(SoundPlayer.prototype, 'stop');
    pet.hide();
    assert.ok(stop.mock.callCount() >= 1);
    pet.show();
    dom.document.hidden = true;
    const before = stop.mock.callCount();
    dom.document.dispatchEvent(new Event('visibilitychange'));
    assert.ok(stop.mock.callCount() > before);
    dom.document.hidden = false;
    const switchSounds = mock.method(SoundPlayer.prototype, 'setFigure');
    await pet.setFigure('koharu');
    assert.equal(switchSounds.mock.calls.at(-1)?.arguments[0], PRESETS.koharu.sounds);
    pet.setSound(false);
    pet.setSound({ volume: 0.2 });
    assert.equal(pet.soundEnabled, false, 'changing volume preserves mute');
    pet.destroy();
    await pet.mount();
    assert.equal(pet.soundEnabled, false, 'remount preserves the sound preference');
  });
});

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

  for (const request of ['chat', 'think', 'say', 'sleep', 'tool'] as const) {
    it(`preserves the covered-floor evacuation deadline when asked to ${request}`, async (t) => {
      const { dom, pet, state } = await mountPet(t);
      const wall = dom.document.createElement('button');
      wall.rect = { left: 0, top: 0, width: 400, height: 768 };
      dom.document.body.append(wall);
      dom.frame(300);
      state.scanned = -Infinity;
      state.x = 380;
      state.y = 700;
      state.vx = 0;
      state.vy = 400;
      for (let i = 0; state.mode === 'fall' && i < 50; i++) dom.frame(20);
      assert.equal(state.perch?.clear, false);
      const deadline = state.until;
      if (request === 'chat') { attachChatPanel(pet); await pet.openChat(); }
      else if (request === 'say') pet.say('A short reply.');
      else if (request === 'tool') await assert.rejects(state.performChatAction('wave'), /clear ground/);
      else pet.play(request);
      assert.ok(state.until <= deadline, 'chat and stationary poses must not extend the existing exit budget');
      for (let i = 0; !state.perch?.clear && i < 400; i++) dom.frame(20);
      assert.equal(state.perch?.clear, true, 'evacuation still walks all the way to clear floor');
    });
  }

  it('fades out instead of walking or leaping off a covered spot when motion is reduced', async (t) => {
    const { dom, state } = await mountPet(t);
    Object.defineProperty(state.view, 'reducedMotion', { get: () => true });
    const wall = dom.document.createElement('button');
    wall.rect = { left: 0, top: 0, width: 400, height: 768 };
    dom.document.body.append(wall);
    dom.frame(300);
    state.scanned = -Infinity;
    state.x = 380;
    state.y = 700;
    state.vx = 0;
    state.vy = 400;
    for (let i = 0; state.mode === 'fall' && i < 50; i++) dom.frame(20);
    assert.equal(state.perch?.clear, false, 'caught by the viewport bottom over the button');
    // Read through a function: the loop condition would narrow the field inside the loop.
    const mode = () => state.mode;
    let moved = false;
    for (let i = 0; mode() === 'ground' && i < 400; i++) {
      dom.frame(20);
      moved ||= state.action === 'walk' || mode() === 'jump';
    }
    assert.equal(moved, false, 'no walk or leap');
    assert.equal(state.mode, 'paused');
    assert.ok(state.overlay.pet.classList.contains('gone'), 'she fades out where she stands');
  });

  it('takes the last step of a walk that is too short to walk, so a narrow clear spot is reached', async (t) => {
    const { dom, state } = await mountPet(t);
    dom.frame(300);
    stand(state, 300);
    state.walkOver(301);
    assert.equal(state.x, 301, 'a step too short to walk is taken at once');
    state.walkOver(400);
    assert.equal(state.action, 'walk');
    for (let i = 0; state.action === 'walk' && i < 400; i++) dom.frame(20);
    assert.equal(state.x, 400, 'a walk ends exactly where it was going');
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

describe('multiple companions and physical chat actions', () => {
  it('leaves usable page space for another companion instead of avoiding an entire overlay host', async (t) => {
    const { dom, state: first } = await mountPet(t);
    (first.overlay.host as unknown as ElementStub).rect = { left: 0, top: 0, width: 1024, height: 768 };
    (first.overlay.pet as unknown as ElementStub).rect = { left: 450, top: 490, width: 110, height: 180 };
    const second = new Peetty({ greet: false });
    dom.cleanup(() => second.destroy());
    await second.mount();
    assert.notEqual(controller(second).mode, 'paused');
    assert.ok(floor(controller(second).perchOptions));
    // Another companion's actual open panel still excludes the area it occupies.
    const panel = dom.document.createElement('section');
    panel.setAttribute('data-peetty', 'avoid');
    panel.rect = { left: 600, top: 0, width: 424, height: 768 };
    (first.overlay.host as unknown as ElementStub).shadowRoot!.append(panel);
    dom.frame(300);
    const free = floor(controller(second).perchOptions);
    assert.ok(free);
    assert.ok(free.right < 600, 'only the real panel footprint should be excluded');
  });

  it('plays each queued pose on the real animation clock before the next one starts', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    state.chatVisible = true;
    const completed: string[] = [];
    const sequence = (async () => {
      for (const action of ['wave', 'sit', 'lie'] as const) {
        await state.performChatAction(action);
        completed.push(action);
      }
    })();
    const advance = async (milliseconds: number) => {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) { dom.frame(50); await Promise.resolve(); }
    };
    assert.equal(state.view.motion.current, 'wave');
    await advance(1000);
    assert.equal(state.view.motion.current, 'wave');
    assert.deepEqual(completed, []);
    await advance(2600);
    assert.equal(state.view.motion.current, 'sit');
    assert.deepEqual(completed, ['wave']);
    await advance(1000);
    assert.equal(state.view.motion.current, 'sit');
    await advance(2600);
    assert.equal(state.view.motion.current, 'lie');
    assert.deepEqual(completed, ['wave', 'sit']);
    await advance(3600);
    await sequence;
    assert.deepEqual(completed, ['wave', 'sit', 'lie']);
  });

  for (const action of ['wave', 'sleep'] as const) {
    it(`preserves a running ${action} tool when chat is reopened`, async (t) => {
      const { dom, pet, state } = await mountPet(t);
      stand(state);
      attachChatPanel(pet);
      await pet.openChat();
      let completed = false;
      const pending = state.performChatAction(action).then(() => { completed = true; });
      await pet.openChat();
      await pet.configure();
      dom.frame(50);
      await Promise.resolve();
      assert.equal(state.view.motion.current, action);
      assert.equal(completed, false);
      for (let i = 0; i < 500 && !completed; i++) { dom.frame(50); await Promise.resolve(); }
      await pending;
      assert.equal(completed, true);
    });
  }

  for (const action of ['wave', 'idle'] as const) {
    it(`does not schedule a landing greeting over a ${action} tool when chat opened in midair`, async (t) => {
      const { dom, pet, state } = await mountPet(t, { greet: true });
      assert.equal(state.mode, 'fall');
      attachChatPanel(pet);
      await pet.openChat();
      stand(state);
      assert.equal(dom.timers.size, 0);
      let completed = false;
      const pending = state.performChatAction(action).then(() => { completed = true; });
      for (let i = 0; i < 16; i++) { dom.frame(50); await Promise.resolve(); }
      assert.equal(state.view.motion.current, action);
      assert.equal(state.overlay.bubble.textContent, '');
      for (let i = 0; i < 80 && !completed; i++) { dom.frame(50); await Promise.resolve(); }
      await pending;
      assert.equal(completed, true);
    });
  }

  it('cancels an already queued greeting before a chat action begins', async (t) => {
    const { dom, state } = await mountPet(t, { greet: true });
    stand(state);
    assert.equal(dom.timers.size, 1);
    state.chatVisible = true;
    let completed = false;
    const pending = state.performChatAction('idle').then(() => { completed = true; });
    assert.equal(dom.timers.size, 0);
    for (let i = 0; i < 16; i++) { dom.frame(50); await Promise.resolve(); }
    assert.equal(state.view.motion.current, 'idle');
    assert.equal(state.overlay.bubble.textContent, '');
    for (let i = 0; i < 80 && !completed; i++) { dom.frame(50); await Promise.resolve(); }
    await pending;
    assert.equal(completed, true);
  });

  it('keeps an idle tool from being interrupted by the nearby-pointer greeting', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    state.chatVisible = true;
    dom.window.dispatchEvent(pointer('pointermove', 1, state.x, state.y - state.view.height / 2));
    let completed = false;
    const pending = state.performChatAction('idle').then(() => { completed = true; });
    for (let i = 0; i < 20; i++) { dom.frame(50); await Promise.resolve(); }
    assert.equal(state.view.motion.current, 'idle');
    assert.equal(completed, false);
    for (let i = 0; i < 60 && !completed; i++) { dom.frame(50); await Promise.resolve(); }
    await pending;
    assert.equal(completed, true);
    state.chatVisible = false;
    pet.play('idle');
    dom.frame(50);
    assert.equal(state.view.motion.current, 'wave', 'ordinary proximity greetings resume when no tool is pending');
  });

  it('keeps a move pending through a real jump until landing', async (t) => {
    const { dom, state } = await mountPet(t);
    const target = stand(state);
    state.chatVisible = true;
    const from: [number, number] = [state.x, state.y];
    const plan = planJump(from, [500, target.y]);
    assert.ok(plan);
    // Fix target selection for reproducibility; flying(), refresh() and land() remain real.
    t.mock.method(state, 'leap', () => {
      state.mode = 'jump';
      state.perch = null;
      state.jump = { from, plan, t: -0.18, target, targetOrigin: [target.left, target.y], hang: false };
      state.view.motion.play('jump');
      return true;
    });
    let completed = false;
    const moving = state.performChatAction('move').then(() => { completed = true; });
    assert.equal(state.mode, 'jump');
    for (let i = 0; i < 3; i++) { dom.frame(50); await Promise.resolve(); }
    assert.equal(completed, false);
    assert.equal(state.mode, 'jump');
    for (let i = 0; i < 100 && !completed; i++) { dom.frame(50); await Promise.resolve(); }
    await moving;
    assert.equal(state.mode, 'ground');
    assert.ok(Math.abs(state.x - 500) < 1);
    assert.equal(completed, true);
  });

  for (const failure of ['removed', 'covered'] as const) {
    it(`rejects a move when its target is ${failure}, even if the fall reaches covered floor`, async (t) => {
      const { dom, state } = await mountPet(t);
      const ledge = dom.document.createElement('button');
      ledge.rect = { left: 450, top: 700, width: 240, height: 40 };
      dom.document.body.append(ledge);
      dom.frame(300);
      const target = state.scan(true).find((perch) => perch.el === ledge as unknown as Element);
      assert.ok(target);
      stand(state, (target.left + target.right) / 2);
      state.chatVisible = true;
      const from: [number, number] = [state.x, state.y];
      const plan = planJump(from, [(target.left + target.right) / 2, target.y]);
      assert.ok(plan);
      t.mock.method(state, 'leap', () => {
        state.mode = 'jump';
        state.perch = null;
        state.jump = { from, plan, t: -0.18, target, targetOrigin: [target.left, target.y], hang: false };
        state.view.motion.play('jump');
        return true;
      });
      const rejection = assert.rejects(state.performChatAction('move'), /interrupted/);
      for (let i = 0; i < 5; i++) { dom.frame(50); await Promise.resolve(); }
      const mode = () => state.mode;
      assert.equal(mode(), 'jump');
      if (failure === 'removed') ledge.remove();
      const blocker = dom.document.createElement('input');
      blocker.rect = { left: 0, top: 0, width: 1024, height: 768 };
      dom.document.body.append(blocker);
      dom.frame(300);
      for (let i = 0; i < 100 && mode() === 'jump'; i++) { dom.frame(50); await Promise.resolve(); }
      await rejection;
      for (let i = 0; i < 200 && mode() === 'fall'; i++) dom.frame(20);
      assert.equal(state.mode, 'ground');
      assert.equal(state.perch?.clear, false, 'landing on the catch-all is not a successful safe move');
    });
  }

  for (const action of ['sleep', 'wave', 'sit', 'lie', 'idle'] as const) {
    for (const chatVisible of [false, true]) {
      it(`immediately releases an aborted ${action} pose with chat ${chatVisible ? 'open' : 'closed'}`, async (t) => {
        const { state } = await mountPet(t);
        stand(state);
        state.chatVisible = chatVisible;
        const abort = new AbortController();
        const rejected = assert.rejects(state.performChatAction(action, abort.signal), { name: 'AbortError' });
        abort.abort();
        assert.equal(state.action, chatVisible ? 'sit' : 'idle');
        assert.equal(state.view.motion.current, state.action, 'the visible animation changes before another frame');
        assert.equal(state.until, state.clock / 1000 + (chatVisible ? 15 : 2));
        assert.equal(state.chatGestureUntil, state.clock, 'chat gestures no longer wait for the cancelled tool');
        await rejected;
      });
    }
  }

  for (const speaking of [false, true]) {
    it(`restores the active chat ${speaking ? 'talk' : 'think'} pose when sleep is aborted`, async (t) => {
      const { state } = await mountPet(t);
      stand(state);
      state.chatVisible = state.chatWorking = true;
      state.chatSpeaking = speaking;
      const abort = new AbortController();
      const rejected = assert.rejects(state.performChatAction('sleep', abort.signal), { name: 'AbortError' });
      abort.abort();
      assert.equal(state.view.motion.current, speaking ? 'talk' : 'think');
      await rejected;
    });
  }

  for (const action of ['sleep', 'lie'] as const) {
    it(`leaves a safe idle pose when closing chat aborts ${action}`, async (t) => {
      const { pet, state } = await mountPet(t);
      stand(state);
      const panel = attachChatPanel(pet);
      await pet.openChat();
      const abort = new AbortController();
      mock.method(panel, 'close', () => { panel.isOpen = false; abort.abort(); });
      const rejected = assert.rejects(state.performChatAction(action, abort.signal), { name: 'AbortError' });
      pet.closeChat();
      assert.equal(state.chatVisible, false);
      assert.equal(state.view.motion.current, 'idle');
      assert.equal(state.until, state.clock / 1000 + 2);
      await rejected;
    });
  }

  for (const replacement of ['sit', 'nap', 'walk'] as const) {
    it(`does not overwrite a user-selected ${replacement} when the previous sleep tool is aborted`, async (t) => {
      const { pet, state } = await mountPet(t);
      stand(state);
      state.chatVisible = true;
      const abort = new AbortController();
      const rejected = assert.rejects(state.performChatAction('sleep', abort.signal), { name: 'AbortError' });
      if (replacement === 'nap') {
        const nap = [...state.overlay.menu.children].find((button) => button.getAttribute('data-action') === 'nap');
        assert.ok(nap);
        nap.dispatchEvent(new Event('click'));
      } else pet.play(replacement);
      const action = state.action;
      const deadline = state.until;
      const walkTo = state.walkTo;
      abort.abort();
      assert.equal(state.action, action);
      assert.equal(state.view.motion.current, action);
      assert.equal(state.until, deadline, 'even a replacement with the same pose and deadline keeps ownership');
      assert.equal(state.walkTo, walkTo);
      await rejected;
    });
  }

  for (const replacement of ['play', 'nap'] as const) {
    for (const elapsed of [10000, 20000, 20050]) {
      it(`rejects a sleep tool replaced by ${replacement} at ${elapsed}ms without changing the replacement`, async (t) => {
        const { pet, state } = await mountPet(t);
        stand(state);
        const started = state.clock;
        const rejected = assert.rejects(state.performChatAction('sleep'), /interrupted/);
        if (replacement === 'play') {
          state.clock += 10000;
          pet.play('sleep');
        } else {
          const nap = [...state.overlay.menu.children].find((button) => button.getAttribute('data-action') === 'nap');
          assert.ok(nap);
          nap.dispatchEvent(new Event('click'));
          assert.equal(state.until, (started + 20000) / 1000, 'the replacement has the identical pose and deadline');
        }
        const deadline = state.until;
        state.clock = started + elapsed;
        state.updateChatAction();
        await rejected;
        assert.equal(state.action, 'sleep');
        assert.equal(state.view.motion.current, 'sleep');
        assert.equal(state.until, deadline);
      });
    }
  }

  it('completes an owned sleep tool when a frame passes its deadline', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    const pending = state.performChatAction('sleep');
    state.clock += 19990;
    dom.frame(50);
    assert.equal(await pending, 'Finished sleep.');
  });

  for (const replacement of ['drag', 'fall', 'landing'] as const) {
    it(`does not overwrite ${replacement} when an earlier idle tool is aborted`, async (t) => {
      const { dom, state } = await mountPet(t);
      const perch = stand(state);
      state.chatVisible = true;
      const abort = new AbortController();
      const rejected = assert.rejects(state.performChatAction('idle', abort.signal), { name: 'AbortError' });
      if (replacement === 'drag') {
        state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
        dom.window.dispatchEvent(pointer('pointermove', 1, 150, 150));
      } else {
        state.startFall();
        if (replacement === 'landing') state.land(perch, 0.2);
      }
      const mode = state.mode;
      const motion = state.view.motion.current;
      const deadline = state.until;
      const play = mock.method(state.view.motion, 'play');
      abort.abort();
      assert.equal(state.mode, mode);
      assert.equal(state.view.motion.current, motion);
      assert.equal(state.until, deadline);
      assert.equal(play.mock.callCount(), 0, 'physics retains animation ownership');
      await rejected;
    });
  }

  it('keeps an aborted move flying on its original arc through landing', async (t) => {
    const { dom, state } = await mountPet(t);
    const target = stand(state);
    state.chatVisible = true;
    const from: [number, number] = [state.x, state.y];
    const plan = planJump(from, [500, target.y]);
    assert.ok(plan);
    mock.method(state, 'leap', () => {
      state.mode = 'jump';
      state.perch = null;
      state.jump = { from, plan, t: -0.18, target, targetOrigin: [target.left, target.y], hang: false };
      state.view.motion.play('jump');
      return true;
    });
    const abort = new AbortController();
    const rejected = assert.rejects(state.performChatAction('move', abort.signal), { name: 'AbortError' });
    for (let i = 0; i < 5; i++) dom.frame(50);
    const jump = state.jump;
    const position = [state.x, state.y, state.vx, state.vy];
    abort.abort();
    assert.equal(state.mode, 'jump');
    assert.equal(state.jump, jump);
    assert.equal(state.view.motion.current, 'jump');
    assert.deepEqual([state.x, state.y, state.vx, state.vy], position);
    await rejected;
    for (let i = 0; i < 100 && state.mode === 'jump'; i++) dom.frame(50);
    assert.equal(state.mode, 'ground');
    assert.ok(Math.abs(state.x - 500) < 1);
  });

  it('does not extend a covered-floor evacuation deadline when a stationary tool is aborted', async (t) => {
    const { dom, state } = await mountPet(t);
    const perch = stand(state, 380);
    state.chatVisible = true;
    const abort = new AbortController();
    const rejected = assert.rejects(state.performChatAction('sleep', abort.signal), { name: 'AbortError' });
    const wall = dom.document.createElement('button');
    wall.rect = { left: 0, top: 0, width: 400, height: 768 };
    dom.document.body.append(wall);
    state.perch = { ...perch, clear: false };
    const deadline = state.until = state.clock / 1000 + 0.2;
    abort.abort();
    assert.equal(state.action, 'idle', 'a covered surface must not regain a stationary chat pose');
    assert.ok(state.until <= deadline);
    await rejected;
    for (let i = 0; !state.perch?.clear && i < 400; i++) dom.frame(20);
    assert.equal(state.perch?.clear, true, 'she still evacuates all the way to clear floor');
  });

  for (const interruption of ['abort', 'hide', 'destroy'] as const) {
    it(`releases a pending physical action on ${interruption}`, async (t) => {
      const { pet, state } = await mountPet(t);
      stand(state);
      state.chatVisible = true;
      const controller = new AbortController();
      const pending = state.performChatAction('sit', controller.signal);
      const rejected = assert.rejects(pending, interruption === 'abort' ? { name: 'AbortError' } : /interrupted/);
      const motion = state.view.motion;
      if (interruption === 'abort') controller.abort();
      else pet[interruption]();
      await rejected;
      const play = mock.method(motion, 'play');
      controller.abort();
      assert.equal(play.mock.callCount(), 0, 'disposed abort handlers cannot regain pose ownership');
    });
  }
});

describe('in-place interface language', () => {
  it('updates overlay and existing panel without replacing the session or interrupting an action', async (t) => {
    const { dom, pet, state } = await mountPet(t, { language: 'en' });
    stand(state);
    const panel = attachChatPanel(pet);
    await pet.openChat();
    const overlay = state.overlay;
    const view = state.view;
    const figure = state.figure;
    const buttons = [...overlay.menu.children];
    const frames = [...dom.frames.keys()];
    const localize = mock.method(panel, 'setLanguage');
    const model = mock.method(panel, 'setModel');
    const destroyPanel = mock.method(panel, 'destroy');
    const destroyPet = mock.method(pet, 'destroy');
    const mount = mock.method(pet, 'mount');
    pet.say('Keep this reply visible');
    const running = state.performChatAction('wave');
    const deadline = state.until;
    overlay.menu.classList.add('show');
    overlay.measure(overlay.menu);
    const menu = overlay.menu as unknown as ElementStub;
    const dimensions = menu.dimensionReads;

    assert.equal(pet.setLanguage('zh'), undefined, 'language switching is synchronous');
    assert.equal(state.overlay, overlay);
    assert.equal(state.view, view);
    assert.equal(state.figure, figure);
    assert.equal(dom.hosts.length, 1);
    assert.deepEqual([...dom.frames.keys()], frames);
    assert.deepEqual([...overlay.menu.children], buttons);
    assert.equal(overlay.pet.getAttribute('aria-label'), strings('zh').pet);
    assert.equal(overlay.menu.getAttribute('aria-label'), strings('zh').menu);
    for (const button of buttons) {
      const action = button.getAttribute('data-action') as 'chat' | 'greet' | 'move' | 'nap' | 'configure' | 'hide';
      assert.equal(button.textContent, strings('zh')[action]);
    }
    overlay.measure(overlay.menu);
    assert.equal(menu.dimensionReads, dimensions + 2, 'translated menu dimensions must be remeasured');
    assert.equal(overlay.menu.classList.contains('show'), true);
    assert.equal(overlay.pet.getAttribute('aria-expanded'), 'true');
    assert.equal(overlay.bubble.textContent, 'Keep this reply visible');
    assert.equal(overlay.bubble.classList.contains('show'), true);
    assert.equal(panel.isOpen, true);
    assert.equal(panel.language, 'zh');
    assert.deepEqual(localize.mock.calls.map((call) => call.arguments), [['zh']]);
    assert.equal(model.mock.callCount(), 0);
    assert.equal(destroyPanel.mock.callCount(), 0);
    assert.equal(destroyPet.mock.callCount(), 0);
    assert.equal(mount.mock.callCount(), 0);
    assert.equal(state.action, 'wave');
    assert.equal(state.until, deadline);
    for (let i = 0; i < 180; i++) dom.frame(20);
    assert.equal(await running, 'Finished wave.');
    assert.equal((pet as unknown as { options: { language: string } }).options.language, 'zh');
  });

  it('keeps chat:false activation and greetings local in the new language', async (t) => {
    const { dom, pet, state } = await mountPet(t, { chat: false, language: 'en' });
    stand(state);
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    pet.setLanguage('zh');
    assert.equal(state.overlay.pet.getAttribute('aria-label'), strings('zh').greet);
    assert.equal(state.overlay.pet.getAttribute('aria-haspopup'), null);
    assert.equal(state.overlay.pet.getAttribute('aria-expanded'), null);
    for (const button of state.overlay.menu.children) {
      if (['chat', 'configure'].includes(button.getAttribute('data-action') ?? '')) assert.equal((button as HTMLElement).hidden, true);
    }
    state.overlay.pet.dispatchEvent(new Event('click'));
    dom.frame(400);
    assert.ok((strings('zh').hello as readonly string[]).includes(state.overlay.bubble.textContent ?? ''));
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
    assert.equal(network.mock.callCount(), 0);
  });

  it('uses the latest language when a pending figure is first mounted and resolves auto', async (t) => {
    const dom = installPetDOM(t);
    const figure = deferred<Response>();
    mock.method(globalThis, 'fetch', () => figure.promise);
    const pet = new Peetty({ figure: '/pending-language.json', language: 'en', greet: false });
    dom.cleanup(() => pet.destroy());
    const mounting = pet.mount();
    pet.setLanguage('zh');
    figure.resolve(response(PRESETS.miru));
    await mounting;
    const state = controller(pet);
    assert.equal(state.overlay.menu.getAttribute('aria-label'), strings('zh').menu);
    pet.setLanguage('auto');
    assert.equal(state.overlay.menu.getAttribute('aria-label'), strings(languageOf('auto')).menu);
    assert.equal((pet as unknown as { options: { language: string } }).options.language, 'auto');
  });

  it('applies the latest language before publishing and opening a panel initialized asynchronously', async (t) => {
    const module = deferred<Awaited<ReturnType<typeof import('../src/chat/load.ts').loadChatPanel>>>();
    const ready = deferred<ReturnType<typeof chatPanelStub>>();
    const IsolatedPeetty = await petWithChatLoader(() => module.promise);
    const dom = installPetDOM(t);
    const pet = new IsolatedPeetty({ language: 'en', greet: false });
    dom.cleanup(() => pet.destroy());
    const create = mock.fn(async (_options: { language: Language }) => ready.promise);
    const opening = pet.openChat();
    await turns();
    pet.setLanguage('zh');
    module.resolve({ createChatPanel: create });
    await turns();
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0]!.arguments[0].language, 'zh');
    pet.setLanguage('zh');
    pet.setLanguage('en');
    const panel = chatPanelStub();
    const events: string[] = [];
    mock.method(panel, 'setLanguage', (language: Language) => {
      assert.equal((pet as unknown as { chatPanel: unknown }).chatPanel, null);
      panel.language = language;
      events.push(`language:${language}`);
    });
    mock.method(panel, 'open', () => { panel.isOpen = true; events.push('open'); });
    ready.resolve(panel);
    await opening;
    assert.deepEqual(events, ['language:en', 'open']);
    assert.equal(panel.language, 'en');
    assert.equal((pet as unknown as { chatPanel: unknown }).chatPanel, panel);
    assert.equal(controller(pet).overlay.menu.getAttribute('aria-label'), strings('en').menu);
  });

  for (const interruption of ['closeChat', 'destroy'] as const) {
    it(`preserves ${interruption} ownership when language changes during panel initialization`, async (t) => {
      const ready = deferred<ReturnType<typeof chatPanelStub>>();
      const create = mock.fn(async () => ready.promise);
      const IsolatedPeetty = await petWithChatLoader(async () => ({ createChatPanel: create }));
      const dom = installPetDOM(t);
      const pet = new IsolatedPeetty({ language: 'en', greet: false });
      dom.cleanup(() => pet.destroy());
      const opening = pet.openChat();
      await turns();
      assert.equal(create.mock.callCount(), 1);
      pet.setLanguage('zh');
      pet[interruption]();
      const panel = chatPanelStub();
      const localize = mock.method(panel, 'setLanguage');
      const open = mock.method(panel, 'open');
      const destroy = mock.method(panel, 'destroy');
      ready.resolve(panel);
      await opening;
      assert.equal(open.mock.callCount(), 0);
      assert.equal(destroy.mock.callCount(), interruption === 'destroy' ? 1 : 0);
      assert.deepEqual(localize.mock.calls.map((call) => call.arguments), interruption === 'destroy' ? [] : [['zh']]);
    });
  }

  it('retains a concurrent language change when an asynchronous model update finishes', async (t) => {
    const { pet, state } = await mountPet(t, { language: 'en' });
    const applying = deferred<void>();
    const panel = attachChatPanel(pet, () => applying.promise);
    const next = { id: 'new-model', baseUrl: 'https://new.example/v1', apiKey: 'ephemeral-key' };
    const updating = pet.setModel(next);
    pet.setLanguage('zh');
    applying.resolve();
    await updating;
    assert.equal(panel.language, 'zh');
    assert.equal(state.overlay.pet.getAttribute('aria-label'), strings('zh').pet);
    const options = (pet as unknown as { options: { language: string; model: PeettyModelOptions } }).options;
    assert.equal(options.language, 'zh');
    assert.deepEqual(options.model, next);
  });

  it('rejects unsupported values without echoing input or changing the current language', async (t) => {
    const { pet, state } = await mountPet(t, { language: 'en' });
    const panel = attachChatPanel(pet);
    const localize = mock.method(panel, 'setLanguage');
    const invalid = [null, undefined, 1, '', 'fr', 'private-secret', { toString() { throw new Error('must not coerce input'); } }];
    for (const value of invalid) {
      assert.throws(() => pet.setLanguage(value as Language), { name: 'TypeError', message: 'Language must be en, zh, or auto.' });
    }
    assert.equal((pet as unknown as { options: { language: string } }).options.language, 'en');
    assert.equal(state.overlay.pet.getAttribute('aria-label'), strings('en').pet);
    assert.equal(localize.mock.callCount(), 0);
  });
});

describe('chat pose ownership', () => {
  for (const source of ['open', 'think', 'talk', 'reply', 'ground', 'cancel'] as const) {
    for (const manual of [false, true]) {
      it(`closes ${source} with ${manual ? 'an identical caller replacement preserved' : 'the chat pose reset'}`, async (t) => {
        let callbacks: Parameters<typeof import('../src/chat/panel.ts').createChatPanel>[0] | undefined;
        const IsolatedPeetty = await petWithChatLoader(async () => ({
          createChatPanel: async (options) => { callbacks = options; return chatPanelStub(); },
        }));
        const dom = installPetDOM(t);
        const pet = new IsolatedPeetty({ greet: false });
        dom.cleanup(() => pet.destroy());
        await pet.mount();
        const state = controller(pet);
        stand(state);
        await pet.openChat();
        assert.ok(callbacks);
        if (source === 'think' || source === 'talk') callbacks.onState(true, source === 'talk');
        if (source === 'reply') {
          pet.play('idle');
          callbacks.onReply('Short reply');
        }
        if (source === 'ground') {
          state.until = -1;
          dom.frame(16);
        }
        if (source === 'cancel') {
          const abort = new AbortController();
          const pending = state.performChatAction('sit', abort.signal);
          const rejected = assert.rejects(pending, { name: 'AbortError' });
          if (manual) pet.play('sit');
          abort.abort();
          await rejected;
        } else if (manual) pet.play(state.action as Parameters<Peetty['play']>[0]);
        const action = state.action;
        const until = state.until;
        pet.closeChat();
        assert.equal(state.action, manual ? action : 'idle');
        if (manual) assert.equal(state.until, until, 'closing preserves the caller deadline');
      });
    }
  }

  it('preserves a public say deadline when chat closes', async (t) => {
    const { pet, state } = await mountPet(t);
    stand(state);
    attachChatPanel(pet);
    await pet.openChat();
    pet.play('idle');
    pet.say('Caller message', 1.2);
    const until = state.until;
    pet.closeChat();
    assert.equal(state.action, 'talk');
    assert.equal(state.until, until);
  });

  it('keeps a completed sit tool caller-independent when chat closes', async (t) => {
    const { pet, state } = await mountPet(t);
    stand(state);
    attachChatPanel(pet);
    await pet.openChat();
    const pending = state.performChatAction('sit');
    state.clock += 3500;
    state.updateChatAction();
    await pending;
    const until = state.until;
    pet.closeChat();
    assert.equal(state.action, 'sit');
    assert.equal(state.until, until);
  });
});

describe('chat entry points and SDK model injection', () => {
  it('uses the lazy reply renderer for a short bubble and invalidates its measured size', async (t) => {
    let reply: ((text: string, render?: (target: HTMLElement) => void) => void) | undefined;
    const IsolatedPeetty = await petWithChatLoader(async () => ({
      createChatPanel: async (options) => { reply = options.onReply; return chatPanelStub(); },
    }));
    const dom = installPetDOM(t);
    const pet = new IsolatedPeetty({ greet: false });
    dom.cleanup(() => pet.destroy());
    await pet.openChat();
    const state = controller(pet);
    stand(state);
    const bubble = state.overlay.bubble;
    state.overlay.measure(bubble);
    const render = mock.fn((target: HTMLElement) => {
      assert.equal(target, bubble);
      target.textContent = 'cat\n /\\_/\\';
      (target as unknown as ElementStub).rect = { left: 0, top: 0, width: 210, height: 90 };
    });
    assert.ok(reply);
    reply('**cat**\n\n```text\n /\\_/\\\n```', render);
    assert.equal(bubble.textContent, 'cat\n /\\_/\\');
    assert.equal(bubble.classList.contains('show'), true);
    assert.deepEqual(state.overlay.measure(bubble), { width: 210, height: 90 });
    reply('x'.repeat(181), render);
    assert.equal(render.mock.callCount(), 1, 'long replies remain in the chat panel');
    pet.say('plain\nsecond line');
    assert.equal(bubble.textContent, 'plain\nsecond line');
    pet.destroy();
    reply('late', render);
    assert.equal(render.mock.callCount(), 1);
  });

  it('accepts an injected model without loading chat, resolving credentials, or calling the endpoint on mount', async (t) => {
    let keys = 0;
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    const { pet } = await mountPet(t, { model: { baseUrl: 'https://api.example.test/v1', id: 'first', getApiKey: () => { keys++; return 'key'; } } });
    await pet.setModel({ baseUrl: 'https://other.example.test/v1', id: 'second', apiKey: 'another-key' });
    assert.equal(keys, 0);
    assert.equal(network.mock.callCount(), 0);
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
  });

  it('rejects an invalid SDK model replacement before chat has been loaded', async (t) => {
    const original = { baseUrl: 'https://original.example/v1', id: 'original-model', apiKey: 'old-key' };
    const { pet } = await mountPet(t, { model: original });
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    for (const replacement of [
      { ...original, baseUrl: 'https://user:private-secret@new.example/' },
      { ...original, id: '' },
      { ...original, headers: { Authorization: 123 } as unknown as Record<string, string> },
    ]) {
      await assert.rejects(pet.setModel(replacement), (error: Error) => error.message.includes('valid API base URL and model ID') && !error.message.includes('private-secret'));
      assert.deepEqual((pet as unknown as { options: { model: unknown } }).options.model, original);
    }
    await pet.setModel({ id: 'root-model', baseUrl: 'https://root.example/' });
    assert.equal((pet as unknown as { options: { model: { baseUrl: string } } }).options.model.baseUrl, 'https://root.example');
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
    assert.equal(network.mock.callCount(), 0);
  });

  for (const phase of ['loading', 'applying'] as const) {
    it(`discards a model replacement waiting for chat ${phase} after destruction`, async (t) => {
      const { pet } = await mountPet(t);
      const loading = deferred<null>();
      const applying = deferred<void>();
      if (phase === 'loading') (pet as unknown as { chatLoading: Promise<null> }).chatLoading = loading.promise;
      else attachChatPanel(pet, () => applying.promise);
      const old = pet.setModel({ id: 'stale', baseUrl: 'https://stale.example', apiKey: 'stale-key' });
      pet.destroy();
      const fresh = { id: 'fresh', baseUrl: 'https://fresh.example', apiKey: 'fresh-key' };
      await pet.setModel(fresh);
      loading.resolve(null);
      applying.resolve();
      await old;
      await pet.mount();
      assert.deepEqual((pet as unknown as { options: { model: PeettyModelOptions } }).options.model, fresh);
      assert.equal(pet.mounted, true);
    });
  }

  it('keeps the latest model when earlier panel updates finish out of order', async (t) => {
    const { pet } = await mountPet(t);
    const first = deferred<void>();
    const second = deferred<void>();
    attachChatPanel(pet, (model) => model.id === 'first' ? first.promise : second.promise);
    const old = pet.setModel({ id: 'first', baseUrl: 'https://first.example', apiKey: 'first-key' });
    const fresh = pet.setModel({ id: 'second', baseUrl: 'https://second.example', apiKey: 'second-key' });
    second.resolve();
    await fresh;
    first.resolve();
    await old;
    assert.equal((pet as unknown as { options: { model: PeettyModelOptions } }).options.model.id, 'second');
  });

  it('opens chat from a synthesized click with no pointer or keyboard events', async (t) => {
    const { pet, state } = await mountPet(t);
    stand(state);
    const open = mock.method(pet, 'openChat', async () => {});
    const click = new Event('click', { bubbles: true, cancelable: true });
    state.overlay.pet.dispatchEvent(click);
    assert.equal(open.mock.callCount(), 1);
    assert.equal(click.defaultPrevented, true);
    await turns();
    state.overlay.pet.dispatchEvent(Object.assign(new Event('click'), { detail: 0, pointerType: '' }));
    assert.equal(open.mock.callCount(), 2);
  });

  for (const device of ['mouse', 'touch'] as const) {
    it(`ignores ${device} compatibility clicks after handling pointer releases`, async (t) => {
      const { dom, pet, state } = await mountPet(t);
      stand(state);
      const open = mock.method(pet, 'openChat', async () => {});
      for (let i = 0; i < 2; i++) {
        state.overlay.pet.dispatchEvent(Object.assign(pointer('pointerdown', 1), { pointerType: device }));
        dom.window.dispatchEvent(Object.assign(pointer('pointerup', 1), { pointerType: device }));
        state.overlay.pet.dispatchEvent(Object.assign(new Event('click'), { detail: device === 'touch' ? 0 : i + 1, pointerType: device }));
        assert.equal(open.mock.callCount(), i);
        if (!i) dom.frame(100);
      }
    });
  }

  for (const key of ['Enter', ' '] as const) {
    it(`does not duplicate ${JSON.stringify(key)} activation through key repeat or a synthesized click`, async (t) => {
      const { pet, state } = await mountPet(t);
      stand(state);
      const open = mock.method(pet, 'openChat', async () => {});
      state.overlay.pet.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, repeat: false }));
      state.overlay.pet.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, repeat: true }));
      state.overlay.pet.dispatchEvent(Object.assign(new Event('click'), { detail: 0, pointerType: '' }));
      assert.equal(open.mock.callCount(), 1);
    });
  }

  it('keeps synthesized activation local when chat is disabled', async (t) => {
    const { pet, state } = await mountPet(t, { chat: false, language: 'en' });
    stand(state);
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    state.overlay.pet.dispatchEvent(new Event('click'));
    assert.equal(state.action, 'wave');
    assert.equal(state.overlay.pet.getAttribute('aria-label'), 'Say hi');
    assert.equal(state.overlay.pet.getAttribute('aria-haspopup'), null);
    pet.closeChat();
    assert.equal(state.overlay.pet.getAttribute('aria-expanded'), null);
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
    assert.equal(network.mock.callCount(), 0);
  });

  it('greets on both quick pointer clicks without initializing disabled chat', async (t) => {
    const { dom, pet, state } = await mountPet(t, { chat: false });
    stand(state);
    const open = mock.method(pet, 'openChat', async () => {});
    const play = mock.method(state.view.motion, 'play');
    const network = mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    for (let i = 0; i < 2; i++) {
      state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
      dom.window.dispatchEvent(pointer('pointerup', 1));
      assert.equal(state.press, null);
      assert.equal(state.action, 'wave');
      assert.equal(play.mock.calls.filter((call) => call.arguments[0] === 'wave').length, i + 1);
      if (!i) dom.frame(100);
    }
    assert.equal(open.mock.callCount(), 0);
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
    assert.equal(network.mock.callCount(), 0);
  });

  it('greets and preserves the touch menu on every disabled-chat tap', async (t) => {
    const { dom, pet, state } = await mountPet(t, { chat: false });
    stand(state);
    const play = mock.method(state.view.motion, 'play');
    for (let i = 0; i < 3; i++) {
      state.overlay.pet.dispatchEvent(Object.assign(pointer('pointerdown', i), { pointerType: 'touch' }));
      dom.window.dispatchEvent(Object.assign(pointer('pointerup', i), { pointerType: 'touch' }));
      assert.equal(state.overlay.menu.classList.contains('show'), true);
      assert.equal(play.mock.calls.filter((call) => call.arguments[0] === 'wave').length, i + 1);
      dom.frame(50);
    }
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
  });

  it('opens chat once on a double tap and cancels the delayed greeting', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    const open = mock.method(pet, 'openChat', async () => {});
    for (let i = 0; i < 2; i++) {
      state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
      dom.window.dispatchEvent(pointer('pointerup', 1));
      if (!i) dom.frame(100);
    }
    assert.equal(open.mock.callCount(), 1);
    assert.equal(dom.timers.size, 0);
  });

  it('cancels queued hover and tap work when chat opens', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    const panel = attachChatPanel(pet);
    state.overlay.pet.dispatchEvent(new Event('pointerover'));
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointerup', 1));
    dom.frame(100);
    await pet.openChat();
    assert.equal(panel.isOpen, true);
    dom.frame(1000);
    assert.equal(state.overlay.menu.classList.contains('show'), false);
    assert.equal(state.action, 'sit');
    assert.equal(dom.timers.size, 0);
  });

  it('contains companion context menus while preserving host context menus elsewhere', async (t) => {
    const { state, window } = await mountKeyboardPet(t);
    const host = mock.fn();
    window.document.addEventListener('contextmenu', host);
    const event = new window.MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true });
    state.overlay.pet.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(host.mock.callCount(), 0, 'the host custom menu does not receive the companion event');
    state.overlay.pet.dispatchEvent(new window.Event('pointerout'));
    assert.equal(state.overlay.menu.classList.contains('show'), true);
    const outside = new window.MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true });
    window.document.body.dispatchEvent(outside);
    assert.equal(outside.defaultPrevented, false);
    assert.equal(host.mock.callCount(), 1);
  });

  it('restores hover access after dragging dismisses a pinned menu', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    state.overlay.pet.dispatchEvent(new Event('contextmenu', { cancelable: true }));
    assert.equal(state.overlay.menu.classList.contains('show'), true);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointermove', 1, 150, 150));
    assert.equal(state.mode, 'drag');
    assert.equal(state.overlay.menu.classList.contains('show'), false);
    dom.window.dispatchEvent(pointer('pointerup', 1, 150, 150));
    state.overlay.pet.dispatchEvent(new Event('pointerover'));
    dom.frame(300);
    assert.equal(state.overlay.menu.classList.contains('show'), true);
  });

  for (const dismissal of ['park', 'hide'] as const) {
    it(`restores hover access after ${dismissal} dismisses a pinned menu`, async (t) => {
      const { dom, pet, state } = await mountPet(t);
      stand(state);
      state.overlay.pet.dispatchEvent(new Event('contextmenu', { cancelable: true }));
      if (dismissal === 'park') (pet as unknown as { park(): void }).park();
      else pet.hide();
      assert.equal(state.overlay.menu.classList.contains('show'), false);
      if (dismissal === 'hide') pet.show();
      else for (let i = 0; i < 30; i++) dom.frame(50);
      state.overlay.pet.dispatchEvent(new Event('pointerover'));
      dom.frame(300);
      assert.equal(state.overlay.menu.classList.contains('show'), true);
    });
  }

  it('offers the menu on a touch tap and routes the Chat action to the public API', async (t) => {
    const { dom, pet, state } = await mountPet(t);
    stand(state);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(Object.assign(pointer('pointerup', 1), { pointerType: 'touch' }));
    assert.equal(state.overlay.menu.classList.contains('show'), true);
    const open = mock.method(pet, 'openChat', async () => {});
    const button = [...state.overlay.menu.children].find((node) => node.getAttribute('data-action') === 'chat');
    assert.ok(button);
    button.dispatchEvent(new Event('click'));
    assert.equal(open.mock.callCount(), 1);
  });

  it('cancels a pending tap greeting when a drag starts', async (t) => {
    const { dom, state } = await mountPet(t);
    stand(state);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 1));
    dom.window.dispatchEvent(pointer('pointerup', 1));
    assert.equal(dom.timers.size, 1);
    state.overlay.pet.dispatchEvent(pointer('pointerdown', 2));
    dom.window.dispatchEvent(pointer('pointermove', 2, 150, 150));
    assert.equal(state.mode, 'drag');
    assert.equal(dom.timers.size, 0);
  });

  it('can disable chat without affecting local pet interactions', async (t) => {
    const { pet, state } = await mountPet(t, { chat: false });
    await pet.openChat();
    await pet.configure();
    assert.equal((pet as unknown as { chatLoading: unknown }).chatLoading, null);
    for (const button of state.overlay.menu.children) {
      if (['chat', 'configure'].includes(button.getAttribute('data-action') ?? '')) assert.equal((button as HTMLElement).hidden, true);
    }
  });
});

describe('companion and menu keyboard boundaries', () => {
  for (const key of ['ContextMenu', 'F10']) {
    it(`focuses the first visible enabled local action with ${key} when chat is disabled`, async (t) => {
      const { state, window } = await mountKeyboardPet(t, { chat: false });
      const greet = state.overlay.menu.querySelector<HTMLButtonElement>('[data-action="greet"]')!;
      greet.disabled = true;
      state.overlay.pet.focus();
      state.overlay.pet.dispatchEvent(new window.KeyboardEvent('keydown', {
        key, shiftKey: key === 'F10', bubbles: true, composed: true, cancelable: true,
      }));
      assert.equal(state.overlay.host.shadowRoot!.activeElement, state.overlay.menu.querySelector('[data-action="move"]'));
      state.overlay.host.shadowRoot!.activeElement!.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, composed: true, cancelable: true,
      }));
      assert.equal(state.overlay.menu.classList.contains('show'), false);
      assert.equal(state.overlay.host.shadowRoot!.activeElement, state.overlay.pet);
    });
  }

  for (const cleanup of ['release', 'fresh press', 'blur', 'destroy'] as const) {
    it(`contains Hide's Enter after focus leaves and clears ownership on ${cleanup}`, async (t) => {
      const { pet, state, window } = await mountKeyboardPet(t);
      const host = mock.fn();
      for (const type of ['keydown', 'keypress', 'keyup']) window.document.addEventListener(type, host);
      const button = state.overlay.menu.querySelector<HTMLButtonElement>('[data-action="hide"]')!;
      state.overlay.menu.classList.add('show');
      button.focus();
      const down = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
      button.dispatchEvent(down);
      assert.equal(down.defaultPrevented, false, 'Hide retains its native default activation');
      button.click();
      button.blur();
      for (const type of ['keydown', 'keypress']) {
        const event = new window.KeyboardEvent(type, { key: 'Enter', repeat: true, bubbles: true, composed: true, cancelable: true });
        window.document.body.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
      }
      const unrelated = new window.KeyboardEvent('keyup', { key: 'k', bubbles: true, cancelable: true });
      window.document.body.dispatchEvent(unrelated);
      assert.equal(unrelated.defaultPrevented, false);
      assert.equal(host.mock.callCount(), 1);
      if (cleanup === 'release') {
        const up = new window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true });
        window.document.body.dispatchEvent(up);
        assert.equal(up.defaultPrevented, true);
      } else if (cleanup === 'blur') window.dispatchEvent(new window.Event('blur'));
      else if (cleanup === 'destroy') pet.destroy();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const event = new window.KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true });
        window.document.body.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'the next host press remains native');
      }
      assert.equal(host.mock.callCount(), 4);
    });
  }

  for (const focusablePanel of [false, true]) {
    it(`removes a parked pet from tab order and accessibility with ${focusablePanel ? 'focusable' : 'legacy'} chat`, async (t) => {
      const { pet, state } = await mountKeyboardPet(t);
      stand(state);
      const panel = attachChatPanel(pet);
      const focus = mock.fn();
      if (focusablePanel) Object.assign(panel, { focus });
      const open = mock.method(panel, 'open');
      await pet.openChat();
      state.overlay.pet.focus();
      (pet as unknown as { park(): void }).park();
      assert.equal(state.overlay.host.style.visibility, 'visible');
      assert.equal(state.overlay.pet.getAttribute('tabindex'), '-1');
      assert.equal(state.overlay.pet.getAttribute('aria-hidden'), 'true');
      assert.notEqual(state.overlay.host.shadowRoot!.activeElement, state.overlay.pet);
      assert.equal(focus.mock.callCount(), focusablePanel ? 1 : 0);
      assert.equal(open.mock.callCount(), 1, 'parking never reopens the panel or resets setup');
      await pet.openChat();
      assert.equal(state.overlay.pet.getAttribute('aria-hidden'), 'true');
      const perch = floor(state.perchOptions)!;
      mock.method(state, 'scan', () => [perch]);
      (pet as unknown as { enter(): void }).enter();
      assert.equal(state.overlay.pet.getAttribute('tabindex'), '0');
      assert.equal(state.overlay.pet.getAttribute('aria-hidden'), null);
      assert.equal(state.overlay.pet.classList.contains('gone'), false);
    });
  }

  for (const key of ['Enter', ' '] as const) {
    it(`contains every phase of ${JSON.stringify(key)} activation without duplicating chat`, async (t) => {
      const { pet, state, window } = await mountKeyboardPet(t);
      const open = mock.method(pet, 'openChat', async () => {});
      const host = mock.fn();
      for (const type of ['keydown', 'keypress', 'keyup']) window.document.addEventListener(type, host);
      for (const [type, repeat] of [['keydown', false], ['keydown', true], ['keypress', false], ['keyup', false]] as const) {
        const event = new window.KeyboardEvent(type, { key, repeat, bubbles: true, composed: true, cancelable: true });
        state.overlay.pet.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, `${type} is consumed by the companion`);
      }
      state.overlay.pet.dispatchEvent(new window.MouseEvent('click', { detail: 0, bubbles: true, composed: true }));
      assert.equal(open.mock.callCount(), 1);
      assert.equal(host.mock.callCount(), 0);
    });
  }

  for (const key of ['ContextMenu', 'F10'] as const) {
    it(`contains ${key} through the focus transfer to the menu and modifier release`, async (t) => {
      const { state, window } = await mountKeyboardPet(t);
      const host = mock.fn();
      for (const type of ['keydown', 'keypress', 'keyup']) window.document.addEventListener(type, host);
      state.overlay.pet.focus();
      state.overlay.pet.dispatchEvent(new window.KeyboardEvent('keydown', {
        key, shiftKey: key === 'F10', bubbles: true, composed: true, cancelable: true,
      }));
      assert.equal(state.overlay.menu.classList.contains('show'), true);
      const button = state.overlay.menu.querySelector('button')!;
      assert.equal(state.overlay.host.shadowRoot!.activeElement, button);
      for (const type of ['keypress', 'keyup']) {
        const event = new window.KeyboardEvent(type, { key, shiftKey: false, bubbles: true, composed: true, cancelable: true });
        button.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
      }
      assert.equal(host.mock.callCount(), 0);
      if (key === 'F10') {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          const event = new window.KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true });
          state.overlay.pet.dispatchEvent(event);
          assert.equal(event.defaultPrevented, false, 'a new unmodified F10 press belongs to the host');
        }
        assert.equal(host.mock.callCount(), 3);
      }
    });
  }

  it('contains menu Escape through the return of focus, then lets unrelated companion Escape through', async (t) => {
    const { state, window } = await mountKeyboardPet(t);
    const host = mock.fn();
    for (const type of ['keydown', 'keypress', 'keyup']) window.document.addEventListener(type, host);
    state.overlay.menu.classList.add('show');
    const button = state.overlay.menu.querySelector('button')!;
    button.focus();
    const down = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    button.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    assert.equal(state.overlay.menu.classList.contains('show'), false);
    assert.equal(state.overlay.host.shadowRoot!.activeElement, state.overlay.pet);
    const repeat = new window.KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, composed: true, cancelable: true });
    state.overlay.pet.dispatchEvent(repeat);
    assert.equal(repeat.defaultPrevented, true, 'a held Escape remains consumed after focus returns');
    for (const type of ['keypress', 'keyup']) {
      const event = new window.KeyboardEvent(type, { key: 'Escape', bubbles: true, composed: true, cancelable: true });
      state.overlay.pet.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal(host.mock.callCount(), 0);
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new window.KeyboardEvent(type, { key: 'Escape', bubbles: true, composed: true, cancelable: true });
      state.overlay.pet.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(host.mock.callCount(), 3);
  });

  for (const key of ['Enter', ' '] as const) {
    it(`contains native menu-button ${JSON.stringify(key)} without preventing its activation`, async (t) => {
      const { pet, state, window } = await mountKeyboardPet(t);
      const open = mock.method(pet, 'openChat', async () => {});
      const host = mock.fn();
      for (const type of ['keydown', 'keypress', 'keyup', 'click']) window.document.addEventListener(type, host);
      state.overlay.menu.classList.add('show');
      const button = state.overlay.menu.querySelector<HTMLButtonElement>('[data-action="chat"]')!;
      button.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const event = new window.KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true });
        button.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'native buttons retain their default keyboard action');
      }
      // The DOM fixture does not synthesize the browser's default keyboard click.
      button.click();
      assert.equal(open.mock.callCount(), 1);
      assert.equal(host.mock.callCount(), 0);
    });
  }

  for (const target of ['pet', 'menu'] as const) {
    it(`preserves unrelated host shortcuts from the ${target}`, async (t) => {
      const { state, window } = await mountKeyboardPet(t);
      const host = mock.fn();
      for (const type of ['keydown', 'keypress', 'keyup']) window.document.addEventListener(type, host);
      const origin = target === 'pet' ? state.overlay.pet : state.overlay.menu.querySelector('button')!;
      for (const key of ['k', 'Tab', 'ArrowLeft', 'F10']) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          const event = new window.KeyboardEvent(type, { key, ctrlKey: key === 'k', bubbles: true, composed: true, cancelable: true });
          origin.dispatchEvent(event);
          assert.equal(event.defaultPrevented, false);
        }
      }
      assert.equal(host.mock.callCount(), 12);
    });
  }
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
