import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { createChatPanel, type ChatPanel } from '../src/chat/panel.ts';
import type { PeettyChatOptions, PeettyModelOptions } from '../src/chat/types.ts';
import { BrowserChatStore, ChatStorageError, type StoredConnection } from '../src/chat/store.ts';
import { ChatRuntime } from '../src/chat/runtime.ts';
import { BrowserProfileStore, type ProfileRecord } from '../src/chat/profiles.ts';
import type { Portrait } from '../src/figure/portrait.ts';
import { FIGURE_LOAD_TIMEOUT, PRESETS, resolveFigure } from '../src/presets.ts';

function savedConnection(storage: ReturnType<typeof installChatIndexedDB> | undefined, namespace: string) {
  const records = storage?.databases.get(`${namespace}:profiles`);
  const directory = records?.get('directory') as { activeProfileId: string } | undefined;
  return (records?.get(`profile:${directory?.activeProfileId}`) as { profile: ProfileRecord } | undefined)?.profile.connection;
}
import { installChatIndexedDB } from './helpers/chat-storage.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
async function eventually(condition: () => boolean) {
  for (let i = 0; i < 1_000 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'expected UI operation completed');
}
const MODEL = { id: 'model', baseUrl: 'https://models.example/v1' };

async function mountPanel(t: TestContext, model: PeettyModelOptions | undefined, options: {
  chat?: PeettyChatOptions;
  figure?: string | object;
  portrait?: (figure: string | object) => Promise<Portrait | null>;
  onFigure?: (figure: string | object) => Promise<void | boolean>;
  onReply?: (text: string, render?: (target: HTMLElement) => void) => void;
  onState?: (busy: boolean, speaking: boolean) => void;
  onGesture?: () => void;
  rejectHTML?: boolean;
  beforeMount?: (window: Window) => void;
} = {}) {
  const window = new Window({ url: 'https://host.example/', settings: { enableIframePageLoading: true } });
  const document = window.document as unknown as Document;
  const restore = stubGlobals({ window, document, location: window.location, HTMLElement: window.HTMLElement });
  let panel: ChatPanel | undefined;
  let htmlWrites = 0;
  const restoreSinks: (() => void)[] = [];
  t.after(async () => {
    panel?.destroy();
    for (const restoreSink of restoreSinks.reverse()) restoreSink();
    await window.happyDOM.abort();
    window.close();
    restore();
  });
  if (options.rejectHTML) {
    const patched = new Set<object>();
    const reject = () => { htmlWrites++; throw new TypeError('TrustedHTML required.'); };
    const patch = (start: object, name: string, setter = false) => {
      let prototype: object | null = start;
      while (prototype && !Object.getOwnPropertyDescriptor(prototype, name)) prototype = Object.getPrototypeOf(prototype) as object | null;
      assert.ok(prototype, `the DOM fixture exposes ${name}`);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
      const target = prototype;
      if (patched.has(target) && name === 'innerHTML') return;
      if (name === 'innerHTML') patched.add(target);
      Object.defineProperty(target, name, setter ? { ...descriptor, set: reject } : { ...descriptor, value: reject });
      restoreSinks.push(() => Object.defineProperty(target, name, descriptor));
    };
    const protect = (doc: Document) => {
      patch(doc.createElement('div'), 'innerHTML', true);
      patch(doc.createElementNS('http://www.w3.org/2000/svg', 'svg'), 'innerHTML', true);
      patch(doc.createElement('iframe'), 'srcdoc', true);
      patch(doc, 'write');
      if ('writeln' in doc) patch(doc, 'writeln');
    };
    protect(document);
    // Intercept the first child-document access, before the panel constructs its UI.
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLIFrameElement.prototype, 'contentDocument')!;
    const protectedDocuments = new Set<Document>();
    Object.defineProperty(window.HTMLIFrameElement.prototype, 'contentDocument', { ...descriptor, get() {
      const doc = descriptor.get!.call(this) as Document | null;
      if (doc && !protectedDocuments.has(doc)) { protectedDocuments.add(doc); protect(doc); }
      return doc;
    } });
    restoreSinks.push(() => Object.defineProperty(window.HTMLIFrameElement.prototype, 'contentDocument', descriptor));
  }
  options.beforeMount?.(window);
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  panel = await createChatPanel(Object.freeze({
    root, language: 'en', ...(model ? { model } : {}), chat: options.chat ?? { persist: false },
    ...(options.figure !== undefined ? { figure: options.figure } : {}), ...(options.onFigure ? { onFigure: options.onFigure } : {}),
    ...(options.portrait ? { portrait: options.portrait } : {}),
    onAction() {}, onReply: options.onReply ?? (() => {}), onState: options.onState ?? (() => {}), onClose() {},
    ...(options.onGesture ? { onGesture: options.onGesture } : {}),
  }));
  panel.open(true);
  const frame = root.querySelector('iframe')!;
  const uiRoot = frame.contentDocument!.body.firstElementChild!.shadowRoot!;
  const query = <T extends HTMLElement>(selector: string) => uiRoot.querySelector<T>(selector)!;
  return { panel, root: uiRoot, parentRoot: root, frame, window, query, htmlWrites: () => htmlWrites };
}

describe('composer acceptance ownership', () => {
  for (const failure of ['archive', 'credential'] as const) {
    it(`keeps the draft when ${failure} preflight rejects before input acceptance`, async (t) => {
      if (failure === 'archive') {
        const storage = BrowserProfileStore.prototype.runtimeStorage;
        t.mock.method(BrowserProfileStore.prototype, 'runtimeStorage', function(this: BrowserProfileStore, id: string) {
          return { ...storage.call(this, id), ensureCapacity: async () => { throw new Error('Archive capacity reached.'); } };
        });
      }
      const { panel, query, window } = await mountPanel(t, { ...MODEL, ...(failure === 'credential' ? { getApiKey: async () => { throw new Error('Unavailable fixture credential'); } } : {}) });
      panel.open(false);
      const input = query<HTMLTextAreaElement>('[name="message"]'); input.value = '  Keep this unsent draft  ';
      input.dispatchEvent(new window.Event('input') as unknown as Event); input.form!.requestSubmit();
      await eventually(() => !query('.pc-error').hidden);
      assert.equal(input.value, '  Keep this unsent draft  ');
      assert.equal(query('.pc-messages').children.length, 0);
      assert.equal(query<HTMLButtonElement>('.pc-submit').disabled, false);
    });
  }

  for (const change of ['unchanged', 'edited', 'retyped', 'canceled'] as const) {
    it(`clears only the accepted input revision after credential preflight (${change})`, async (t) => {
      const credential = deferred<string>();
      const { panel, query, window } = await mountPanel(t, { ...MODEL, getApiKey: () => credential.promise }); panel.open(false);
      const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Fixture network unavailable'); });
      const input = query<HTMLTextAreaElement>('[name="message"]');
      const edit = (value: string) => { input.value = value; input.dispatchEvent(new window.Event('input') as unknown as Event); };
      edit('Original draft'); input.form!.requestSubmit(); await flush();
      assert.equal(input.value, 'Original draft', 'pending credentials retain the draft');
      if (change === 'edited') edit('New draft typed while waiting');
      if (change === 'retyped') { edit(''); edit('Original draft'); }
      if (change === 'canceled') { input.form!.requestSubmit(); await flush(); }
      credential.resolve('fixture-acceptance-key');
      if (change === 'canceled') { await flush(); assert.equal(network.mock.callCount(), 0); }
      else await eventually(() => query('.pc-messages').children.length > 0);
      assert.equal(input.value, change === 'unchanged' ? '' : change === 'edited' ? 'New draft typed while waiting' : 'Original draft');
      assert.equal(query('.pc-messages').children.length > 0, change !== 'canceled');
    });
  }
});

describe('explicit nonsecret setup headers', () => {
  for (const source of ['saved', 'session'] as const) {
    it(`does not trust an imported ${source} Gateway-Pass classification when authentication is opted out`, async (t) => {
      const idb = installChatIndexedDB(t); const namespace = `untrusted-classification-${source}`;
      const seed = new BrowserProfileStore(namespace); await seed.initialize(); t.after(() => seed.close());
      const archive = JSON.parse(await seed.backup()); archive.version = 2;
      const connection = { ...MODEL, headers: { 'Gateway-Pass': 'fixture-imported-private-pass' }, nonCredentialHeaders: ['Gateway-Pass'] };
      if (source === 'saved') archive.profiles[0].connection = connection;
      else archive.sessions = [{ profileId: archive.activeProfileId, connection, rememberKey: false }];
      const { query, window } = await mountPanel(t, undefined, { chat: { storageKey: namespace } });
      const before = query<HTMLSelectElement>('.pc-profile-select').value;
      query<HTMLButtonElement>('[data-tab="data"]').click();
      const restore = query<HTMLInputElement>('input[type="file"][multiple]');
      Object.defineProperty(restore, 'files', { configurable: true, value: [new window.File([JSON.stringify(archive)], 'fixture-untrusted-backup.json')] });
      restore.dispatchEvent(new window.Event('change') as unknown as Event);
      await eventually(() => query<HTMLSelectElement>('.pc-profile-select').value !== before && !query<HTMLSelectElement>('.pc-profile-select').disabled);
      query<HTMLButtonElement>('[data-tab="connection"]').click();
      assert.equal(query<HTMLInputElement>('[name="model"]').value, MODEL.id, 'restored connection is active before opting out');
      const remember = query<HTMLInputElement>('[name="remember"]'); remember.checked = false;
      query<HTMLFormElement>('.pc-setup').requestSubmit(); await eventually(() => query('.peetty-chat').dataset.mode === 'chat');
      const saved = savedConnection(idb, namespace)!;
      assert.equal(saved.nonCredentialHeaders, undefined); assert.equal(saved.headers?.['gateway-pass'], undefined); assert.equal(saved.apiKey, undefined);
      const inspect = new BrowserProfileStore(namespace); await inspect.initialize(); t.after(() => inspect.close());
      const persisted = JSON.parse(await inspect.backup()).profiles.find((profile: ProfileRecord) => profile.id === inspect.activeProfileId);
      assert.equal(persisted.connection.headers?.['gateway-pass'], undefined, 'a backup cannot launder file declarations into persistent consent');
    });
  }

  it('persists a newly classified route without API key consent and retains it through reload and key replacement', async (t) => {
    const idb = installChatIndexedDB(t); const namespace = 'explicit-route-setup';
    const { panel, query } = await mountPanel(t, { ...MODEL, apiKey: 'fixture-route-api-key',
      headers: { 'X-Route': 'fixture-route', 'X-Undeclared': 'fixture-private-header', 'X-Auth': 'fixture-auth-header' }, nonCredentialHeaders: ['X-Route'],
    }, { chat: { storageKey: namespace } });
    assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => !!savedConnection(idb, namespace));
    const saved = savedConnection(idb, namespace)!;
    assert.equal(saved.apiKey, undefined); assert.deepEqual(saved.headers, { 'x-route': 'fixture-route' }); assert.deepEqual(saved.nonCredentialHeaders, ['x-route']);
    panel.destroy();
    const next = await mountPanel(t, undefined, { chat: { storageKey: namespace } });
    assert.equal(next.query<HTMLInputElement>('[name="key"]').value, '');
    assert.equal(next.query<HTMLInputElement>('[name="remember"]').checked, false, 'nonsecret metadata does not imply authentication consent');
    const requests: Headers[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Headers(init?.headers)); return Response.json({ data: [{ id: MODEL.id }] }); });
    const key = next.query<HTMLInputElement>('[name="key"]'); key.value = 'fixture-replacement-key'; key.dispatchEvent(new next.window.Event('input') as unknown as Event);
    next.query<HTMLButtonElement>('.pc-load').click(); await eventually(() => requests.length === 1 && !next.query<HTMLButtonElement>('.pc-load').disabled);
    assert.equal(requests[0]!.get('x-route'), 'fixture-route'); assert.equal(requests[0]!.get('authorization'), 'Bearer fixture-replacement-key');
    assert.equal(requests[0]!.get('x-undeclared'), null); assert.equal(requests[0]!.get('x-auth'), null);
    next.query<HTMLFormElement>('.pc-setup').requestSubmit(); await eventually(() => next.query<HTMLElement>('.peetty-chat').dataset.mode === 'chat');
    assert.equal(savedConnection(idb, namespace)!.apiKey, undefined);
    assert.deepEqual(savedConnection(idb, namespace)!.headers, { 'x-route': 'fixture-route' });
    assert.deepEqual(savedConnection(idb, namespace)!.nonCredentialHeaders, ['x-route']);
  });

  it('exports trusted classifications but strips their consent when a backup is restored', async (t) => {
    const idb = installChatIndexedDB(t); const namespace = 'explicit-route-backup';
    const headers = { 'X-Route': 'fixture-backup-route', 'X-Author': 'fixture-author', 'X-Key-Version': 'fixture-version', 'X-Subscription-Plan': 'fixture-plan', 'X-ContextTokens': '2048', 'X-RemainingTokens': '1024' };
    const model = { ...MODEL, apiKey: 'fixture-route-backup-key', headers, nonCredentialHeaders: Object.keys(headers) };
    const declared = ['x-author', 'x-contexttokens', 'x-key-version', 'x-remainingtokens', 'x-route', 'x-subscription-plan'];
    const { panel, query, root } = await mountPanel(t, model, { chat: { storageKey: namespace } });
    query<HTMLFormElement>('.pc-setup').requestSubmit(); await eventually(() => !!savedConnection(idb, namespace)); panel.open(true);
    let blob: Blob | undefined; t.mock.method(URL, 'createObjectURL', (value: Blob) => { blob = value; return 'blob:explicit-route-backup'; }); t.mock.method(URL, 'revokeObjectURL', () => {});
    root.addEventListener('click', event => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click(); await eventually(() => !!blob);
    const text = await blob!.text(); const archive = JSON.parse(text);
    assert.deepEqual(archive.profiles[0].connection.nonCredentialHeaders, declared);
    assert.equal(archive.profiles[0].connection.apiKey, undefined);
    assert.deepEqual(archive.sessions[0].connection.nonCredentialHeaders, declared);
    const target = new BrowserProfileStore('explicit-route-backup-target'); await target.initialize(); t.after(() => target.close()); await target.restore(text);
    assert.equal(target.storedConnection(target.activeProfileId)!.nonCredentialHeaders, undefined, 'file declarations cannot grant persistence consent');
    assert.deepEqual(target.storedConnection(target.activeProfileId)!.headers, Object.fromEntries(new Headers(headers)));
    const runtime = new ChatRuntime({ storage: target.runtimeStorage(target.activeProfileId) }); t.after(() => runtime.destroy()); await runtime.initialize();
    assert.equal(runtime.model!.nonCredentialHeaders, undefined); assert.equal(runtime.model!.apiKey, model.apiKey);
  });
});

describe('backup preflight and producer lifetime', () => {
  it('aborts the actual backup preflight on cancel and preserves the unsent draft', async (t) => {
    let scan: AbortSignal | undefined; let running = false;
    t.mock.method(BrowserProfileStore.prototype, 'backupDownload', async function(options?: Parameters<BrowserProfileStore['backupDownload']>[0]) {
      scan = options?.signal; assert.ok(scan); running = true;
      return await new Promise<string>((_resolve, reject) => {
        const stop = () => { running = false; reject(new DOMException('Fixture scan stopped.', 'AbortError')); };
        scan!.addEventListener('abort', stop, { once: true }); if (scan!.aborted) stop();
      });
    });
    const { query, window } = await mountPanel(t, MODEL);
    const draft = query<HTMLTextAreaElement>('[name="message"]'); draft.value = 'Keep this unsent draft'; draft.dispatchEvent(new window.Event('input') as unknown as Event);
    const urls = t.mock.method(URL, 'createObjectURL', () => 'blob:unexpected-preflight');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    await eventually(() => running);
    query<HTMLButtonElement>('[data-cancel-download]').click();
    await eventually(() => !query<HTMLButtonElement>('.pc-backup').disabled);
    assert.equal(scan!.aborted, true); assert.equal(running, false); assert.equal(urls.mock.callCount(), 0);
    assert.equal(draft.value, 'Keep this unsent draft');
    assert.match(query('.pc-manage-status').textContent!, /canceled.*incomplete/);
  });

  it('bounds unresolved credentials without starting archive serialization', async (t) => {
    let requested = false;
    const { query } = await mountPanel(t, { ...MODEL, getApiKey: () => { requested = true; return new Promise<string>(() => {}); } });
    const snapshot = t.mock.method(BrowserProfileStore.prototype, 'backupDownload');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    await eventually(() => requested);
    t.mock.timers.tick(20_000);
    await eventually(() => !query<HTMLButtonElement>('.pc-backup').disabled);
    assert.equal(snapshot.mock.callCount(), 0);
    assert.equal(query('.pc-manage-status').hasAttribute('data-error'), true);
  });

  it('allows serialization beyond the credential deadline after credentials resolve', async (t) => {
    const gate = deferred<string>(); let scan: AbortSignal | undefined;
    const { query, root } = await mountPanel(t, { ...MODEL, getApiKey: async () => 'synthetic-resolved-backup-key' });
    t.mock.method(BrowserProfileStore.prototype, 'backupDownload', async function(options?: Parameters<BrowserProfileStore['backupDownload']>[0]) {
      scan = options?.signal; return gate.promise;
    });
    root.addEventListener('click', event => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    const urls = t.mock.method(URL, 'createObjectURL', () => 'blob:slow-valid-backup');
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    await eventually(() => scan !== undefined);
    t.mock.timers.tick(120_000);
    assert.equal(scan!.aborted, false, 'archive throughput is not subject to the credential timeout');
    assert.equal(query<HTMLButtonElement>('.pc-backup').disabled, true);
    gate.resolve('{}');
    await eventually(() => !query<HTMLButtonElement>('.pc-backup').disabled);
    assert.equal(urls.mock.callCount(), 1);
    assert.match(query('.pc-manage-status').textContent!, /ready/);
  });

  for (const ending of ['final', 'error', 'before first next'] as const) {
    it(`releases the backup signal lifecycle on ${ending} without aborting successful preflight`, async (t) => {
      let signal: AbortSignal | undefined; let nextCalls = 0; let returned = 0;
      let query: Awaited<ReturnType<typeof mountPanel>>['query'];
      t.mock.method(BrowserProfileStore.prototype, 'backupDownload', async function(options?: Parameters<BrowserProfileStore['backupDownload']>[0]) {
        signal = options?.signal; assert.ok(signal); assert.equal(signal.aborted, false);
        return {
          [Symbol.asyncIterator]() {
            if (ending === 'before first next') query<HTMLButtonElement>('[data-cancel-download]').click();
            return {
              async next() {
                nextCalls++; assert.equal(signal!.aborted, false, 'returning a producer must not abort its lifetime signal');
                if (ending === 'error') throw new Error('Fixture producer failed');
                return { done: false as const, value: { name: `part-${nextCalls}.json`, text: '{}', ...(nextCalls === 2 ? { final: true } : {}) } };
              },
              async return() { returned++; return { done: true as const, value: undefined }; },
            };
          },
        };
      });
      const abort = t.mock.method(AbortController.prototype, 'abort');
      const added = t.mock.method(AbortSignal.prototype, 'addEventListener');
      const removed = t.mock.method(AbortSignal.prototype, 'removeEventListener');
      const ui = await mountPanel(t, MODEL); query = ui.query;
      ui.root.addEventListener('click', event => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
      let created = 0; const revoked: string[] = [];
      t.mock.method(URL, 'createObjectURL', () => `blob:producer-lifetime-${++created}`); t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
      await eventually(() => !query<HTMLButtonElement>('.pc-backup').disabled);
      assert.ok(signal); assert.equal(signal.aborted, true, 'completion, return and errors all release the producer controller'); assert.equal(returned, 1);
      assert.equal(nextCalls, ending === 'before first next' ? 0 : ending === 'error' ? 1 : 2);
      if (ending === 'final') assert.match(query('.pc-manage-status').textContent!, /All backup parts are ready/);
      else if (ending === 'before first next') assert.match(query('.pc-manage-status').textContent!, /canceled/);
      else assert.equal(query('.pc-manage-status').hasAttribute('data-error'), true);
      const aborts = () => abort.mock.calls.filter(call => (call.this as AbortController).signal === signal).length;
      const beforeDestroy = aborts(); ui.panel.destroy(); assert.equal(aborts(), beforeDestroy, 'released controllers are removed from panel-owned backups');
      const cancellations = added.mock.calls.filter(call => call.arguments[0] === 'abort' && typeof call.arguments[1] === 'function' && call.arguments[1].name === 'cancel');
      assert.ok(cancellations.length > 0);
      for (const call of cancellations) assert.ok(removed.mock.calls.some(removal => removal.this === call.this && removal.arguments[0] === 'abort' && removal.arguments[1] === call.arguments[1]), 'caller cancellation listeners are removed');
      t.mock.timers.tick(59_999); assert.deepEqual(revoked, []); t.mock.timers.tick(1); assert.equal(revoked.length, created);
    });
  }
});

describe('panel surface fallbacks', () => {
  it('keeps literal light and dark surfaces outside color-mix support blocks', async (t) => {
    const { root, window } = await mountPanel(t, MODEL);
    const sheet = new window.CSSStyleSheet(); sheet.replaceSync(root.querySelector('style')!.textContent!);
    const styles = [...sheet.cssRules];
    const base = styles.find(rule => rule.cssText.startsWith('.peetty-chat {')) as unknown as CSSStyleRule;
    for (const key of ['--pc-bg', '--pc-input', '--pc-accent', '--pc-soft', '--pc-line', '--pc-line-strong', '--pc-error-bg']) assert.match(base.style.getPropertyValue(key).trim(), /^#[a-f0-9]{3,8}$/i);
    const dark = styles.find(rule => rule.cssText.startsWith('@media (prefers-color-scheme: dark)')) as unknown as CSSMediaRule;
    assert.match((dark.cssRules[0] as CSSStyleRule).style.getPropertyValue('--pc-bg'), /^#[a-f0-9]{6}$/i);
    for (const rule of styles) {
      if (rule.cssText.includes('color-mix(')) assert.ok(rule.cssText.startsWith('@supports (color: color-mix('), 'mixed surfaces and hover enhancements require support');
    }
    assert.ok(styles.some(rule => rule.cssText.includes('background: linear-gradient(120deg, var(--pc-color), var(--pc-color-end))')), 'adaptive header gradient remains available');
  });
});

describe('character portrait ownership', () => {
  function face(color: Portrait['color']) {
    let live = false;
    let destroyed = 0;
    const value: Portrait = {
      element: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), color,
      stamp: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      setMood() {}, setLive(next) { live = next; }, destroy() { destroyed++; live = false; },
    };
    return { value, get live() { return live; }, get destroyed() { return destroyed; } };
  }
  it('discards late portraits after a character change and stops the current face on close', async (t) => {
    const old = deferred<Portrait | null>();
    const next = deferred<Portrait | null>();
    const requested: (string | object)[] = [];
    const { panel, query } = await mountPanel(t, MODEL, { portrait: (figure) => {
      requested.push(figure); return figure === 'miru' ? old.promise : next.promise;
    } });
    const first = face('violet'); const second = face('blue');
    await panel.setFigure!('elsie');
    next.resolve(second.value); await flush();
    assert.equal(query('.peetty-chat').dataset.color, 'blue');
    assert.equal(second.live, true);
    old.resolve(first.value); await flush();
    assert.equal(first.destroyed, 1);
    assert.equal(query('.pc-avatar').firstChild, second.value.element);
    assert.deepEqual(requested, ['miru', 'elsie']);
    panel.close(); assert.equal(second.live, false);
    panel.open(); assert.equal(second.live, true);
    panel.destroy(); assert.equal(second.destroyed, 1);
  });
  it('does not copy custom figure metadata on composer updates', async (t) => {
    const reads = t.mock.method(BrowserProfileStore.prototype, 'profileInfo');
    const { panel, query, window } = await mountPanel(t, MODEL, { figure: structuredClone(PRESETS.miru) });
    panel.open(false); await flush();
    const before = reads.mock.callCount();
    const beforeColor = query('.peetty-chat').dataset.color;
    const input = query<HTMLTextAreaElement>('[name="message"]');
    for (let i = 0; i < 20; i++) {
      input.value += 'x'; input.dispatchEvent(new window.Event('input') as unknown as Event);
    }
    assert.equal(reads.mock.callCount(), before, 'unchanged figure identity avoids cloning and serializing the rig');
    await panel.setFigure!(structuredClone(PRESETS.elsie));
    assert.equal(query('.peetty-chat').dataset.color, beforeColor, 'object fallback remains based on the profile when no portrait factory is provided');
    assert.ok(reads.mock.callCount() > before, 'a changed figure still refreshes metadata');
  });
  it('keeps the page palette when a portrait arrives and tracks host theme changes', async (t) => {
    const pending = deferred<Portrait | null>();
    const { panel, query, window } = await mountPanel(t, MODEL, {
      beforeMount(window) { window.document.documentElement.style.setProperty('--accent', '#148049'); },
      portrait: () => pending.promise,
    });
    assert.equal(query('.peetty-chat').dataset.color, 'green');
    const character = face('violet'); pending.resolve(character.value); await flush();
    assert.equal(query('.peetty-chat').dataset.color, 'green', 'a late portrait must not override host colours');
    window.document.documentElement.style.setProperty('--accent', '#2d6bd8');
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(query('.peetty-chat').dataset.color, 'blue');
    window.document.documentElement.style.removeProperty('--accent');
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(query('.peetty-chat').dataset.color, 'violet', 'neutral pages restore the character palette');
    panel.close();
    window.document.documentElement.style.setProperty('--accent', '#d43545');
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(query('.peetty-chat').dataset.color, 'violet', 'closed panels do not resample');
    panel.open(); assert.equal(query('.peetty-chat').dataset.color, 'red');
  });
  it('disposes a portrait that resolves after the panel is destroyed', async (t) => {
    const pending = deferred<Portrait | null>();
    const { panel } = await mountPanel(t, MODEL, { portrait: () => pending.promise });
    const late = face('violet');
    panel.destroy(); pending.resolve(late.value); await flush();
    assert.equal(late.destroyed, 1);
    assert.equal(late.live, false);
  });
});

describe('profile management and migration UI', () => {
  const click = (root: ShadowRoot, text: string) => {
    const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
    assert.ok(button, `button ${text} exists`); button.click();
  };
  it('creates independent profiles, keeps their memories separate, and retains them after switching', async (t) => {
    installChatIndexedDB(t);
    const { query, root, window } = await mountPanel(t, MODEL, { chat: { storageKey: 'profile-ui' } });
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]').value = 'I prefer concise answers.';
    query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]').form!.requestSubmit();
    await flush();
    assert.match(query('.pc-record-list').textContent!, /concise answers/);
    query<HTMLButtonElement>('[data-tab="profile"]').click();
    query<HTMLInputElement>('[aria-label="New profile name"]').value = 'Work companion';
    query<HTMLFormElement>('.pc-new-profile').requestSubmit(); await flush();
    const select = query<HTMLSelectElement>('.pc-profile-select');
    assert.equal(select.options.length, 2);
    assert.equal(select.selectedOptions[0]?.textContent, 'Work companion');
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    assert.doesNotMatch(query('.pc-record-list').textContent!, /concise answers/);
    select.value = select.options[0]!.value;
    select.dispatchEvent(new window.Event('change') as unknown as Event); await flush();
    assert.match(query('.pc-record-list').textContent!, /concise answers/);
  });

  it('edits and deletes history while retaining a reviewable source snapshot on its memory', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('history-ui'); await seed.initialize();
    t.after(() => seed.close());
    const profile = seed.activeProfile;
    const storage = seed.storage(profile.id); await storage.load();
    await storage.saveEntries([{ id: 'source', role: 'user', text: 'I drink green tea.', createdAt: 1 }]);
    await seed.update(profile.id, { autoRemember: true });
    await seed.saveMemory(profile.id, { text: 'Likes green tea', sourceEntryId: 'source', sourceText: 'I drink green tea.', manual: false });
    const { query, root, window } = await mountPanel(t, MODEL, { chat: { storageKey: 'history-ui' } });
    query<HTMLButtonElement>('[data-tab="history"]').click(); click(root, 'Edit');
    query<HTMLTextAreaElement>('[aria-label="Edit"]').value = 'I now prefer black tea.';
    query<HTMLTextAreaElement>('[aria-label="Edit"]').form!.requestSubmit();
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled);
    assert.match(query('.pc-record-list').textContent!, /black tea/);
    click(root, 'Delete'); click(root, 'Confirm deletion');
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled);
    assert.equal(root.querySelector('[data-entry-id]'), null);
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    assert.match(query('.pc-record-list').textContent!, /Likes green tea/);
    const source = query<HTMLDetailsElement>('details'); source.open = true;
    source.dispatchEvent(new window.Event('toggle') as unknown as Event);
    assert.match(query('.pc-record-list').textContent!, /I drink green tea/);
    assert.match(query('.pc-record-list').textContent!, /no longer in history/);
  });

  it('downloads a complete backup with session credentials and provider headers, then restores usable profiles', async (t) => {
    installChatIndexedDB(t);
    let downloaded: Blob | undefined;
    t.mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:fixture'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    const model = { ...MODEL, provider: 'Fixture provider', apiKey: 'fixture-transfer-key', headers: { 'x-api-key': 'fixture-header-key' } };
    const { query, root } = await mountPanel(t, model, { chat: { storageKey: 'backup-ui' } });
    root.addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    query<HTMLButtonElement>('[data-tab="data"]').click(); click(root, 'Download full backup');
    await eventually(() => downloaded !== undefined);
    assert.ok(downloaded, 'backup was downloaded');
    const text = await downloaded.text();
    const backup = JSON.parse(text) as { profiles: ProfileRecord[]; sessions: { profileId: string; connection: StoredConnection; rememberKey: boolean }[] };
    assert.equal(backup.profiles[0]?.connection, undefined, 'the SDK connection does not replace saved setup data');
    assert.equal(backup.sessions[0]?.profileId, backup.profiles[0]?.id);
    assert.equal(backup.sessions[0]?.connection.apiKey, model.apiKey);
    assert.equal(backup.sessions[0]?.connection.provider, model.provider);
    assert.equal(backup.sessions[0]?.connection.headers?.['x-api-key'], 'fixture-header-key');
    assert.equal(backup.sessions[0]?.rememberKey, false);
    const target = new BrowserProfileStore('backup-ui-target'); await target.initialize(); t.after(() => target.close());
    await target.restore(text);
    const restored = target.activeProfile;
    assert.notEqual(restored.id, backup.profiles[0]?.id);
    const runtime = new ChatRuntime({ storage: target.storage(restored.id) }); await runtime.initialize();
    assert.equal(runtime.model?.apiKey, model.apiKey);
    assert.equal(runtime.model?.headers?.['x-api-key'], 'fixture-header-key'); runtime.destroy();
  });

  it('retains keyboard focus through settings navigation, editing, deletion, pagination and profile switching', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('keyboard-management'); await seed.initialize(); t.after(() => seed.close());
    const first = seed.activeProfile.id;
    for (let i = 0; i < 32; i++) await seed.saveMemory(first, { text: `Saved fact ${i}`, manual: true });
    await seed.create({ name: 'Second keyboard profile' }); await seed.select(first);
    const { query, root, window } = await mountPanel(t, MODEL, { chat: { storageKey: 'keyboard-management' } });
    const memoryTab = query<HTMLButtonElement>('[data-tab="memory"]'); memoryTab.focus(); memoryTab.click();
    assert.equal(root.activeElement, memoryTab, 'navigation retains its focused node');
    const firstRecord = query<HTMLElement>('[data-memory-id]');
    const edit = firstRecord.querySelector<HTMLButtonElement>('button')!; edit.focus(); edit.click();
    const editor = query<HTMLTextAreaElement>('[aria-label="Edit"]');
    assert.equal(root.activeElement, editor);
    editor.value = 'Updated saved fact'; editor.form!.requestSubmit(); await flush();
    assert.ok(root.activeElement?.closest('[data-memory-id]'), 'save returns focus to the updated record');
    assert.ok(root.activeElement?.classList.contains('pc-restored-focus'), 'restored focus has an explicit visible indicator');
    const activeRecord = root.activeElement!.closest<HTMLElement>('[data-memory-id]')!;
    const editAgain = activeRecord.querySelector<HTMLButtonElement>('button')!; editAgain.focus(); editAgain.click();
    const cancel = [...activeRecord.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel')!;
    cancel.focus(); cancel.click();
    assert.ok(root.activeElement?.closest('[data-memory-id]'), 'cancel returns focus to the record');
    const remove = [...root.activeElement!.closest('[data-memory-id]')!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Delete')!;
    remove.focus(); remove.click();
    const confirm = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Confirm deletion')!;
    assert.equal(root.activeElement, confirm); confirm.click(); await flush();
    assert.ok(root.activeElement?.closest('[data-memory-id]'), 'deletion returns focus to a surviving record');
    const more = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Show more')!;
    more.focus(); more.click();
    assert.ok(root.activeElement?.closest('[data-memory-id]'), 'pagination focuses the first revealed record');
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.focus(); selector.value = selector.options[1]!.value;
    selector.dispatchEvent(new window.Event('change') as unknown as Event); await flush();
    assert.equal(root.activeElement, selector, 'profile selection retains focus');
  });

  it('switches profiles during credential resolution without carrying input or a late request into the new profile', async (t) => {
    installChatIndexedDB(t);
    const pending = deferred<string>(); let requested = false;
    t.mock.method(globalThis, 'fetch', async () => { requested = true; return textReply('Unexpected'); });
    const { panel, query, window } = await mountPanel(t, { ...MODEL, getApiKey: () => pending.promise }, { chat: { storageKey: 'switch-ui' } });
    panel.open(false);
    const input = query<HTMLTextAreaElement>('[name="message"]'); input.value = 'Private to the original profile';
    input.dispatchEvent(new window.Event('input') as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit(); await flush();
    panel.open(true); query<HTMLButtonElement>('[data-tab="profile"]').click();
    query<HTMLInputElement>('[aria-label="New profile name"]').value = 'Separate';
    query<HTMLFormElement>('.pc-new-profile').requestSubmit(); await flush();
    pending.resolve('fixture-late-key'); await flush();
    assert.equal(requested, false);
    assert.equal(query('.pc-messages').textContent, '');
    query<HTMLButtonElement>('[data-tab="connection"]').click();
    assert.equal(query<HTMLInputElement>('[name="key"]').value, '');
    assert.equal(query<HTMLInputElement>('[name="model"]').value, '');
  });
});

describe('chat frame sound activation', () => {
  it('forwards trusted frame gestures synchronously without exposing them to the host', async (t) => {
    let activations = 0;
    const { panel, frame, query, window } = await mountPanel(t, undefined, { onGesture: () => { activations++; } });
    const field = query<HTMLInputElement>('[name="url"]');
    let hostEvents = 0;
    window.addEventListener('keydown', () => { hostEvents++; });
    const child = frame.contentWindow! as unknown as typeof globalThis;
    const trusted = (type: string, extra: Record<string, unknown> = {}) => {
      const event = new child.Event(type, { bubbles: true, composed: true });
      Object.defineProperty(event, 'isTrusted', { value: true });
      Object.assign(event, extra);
      return event;
    };
    field.dispatchEvent(new child.Event('click', { bubbles: true, composed: true }));
    assert.equal(activations, 0, 'synthetic clicks cannot unlock sound');
    field.dispatchEvent(trusted('keydown', { key: 'a' }));
    assert.equal(activations, 1, 'callback runs during the keyboard event');
    assert.equal(hostEvents, 0, 'frame typing remains isolated');
    field.dispatchEvent(trusted('pointerdown', { pointerType: 'touch' }));
    assert.equal(activations, 1);
    field.dispatchEvent(trusted('pointerup', { pointerType: 'touch' }));
    assert.equal(activations, 2);
    panel.destroy();
    field.dispatchEvent(trusted('keydown', { key: 'b' }));
    assert.equal(activations, 2, 'removed panels no longer forward gestures');
  });
});

describe('chat panel clear recovery', () => {
  it('restores the transcript and permits retry after a failed legacy history deletion', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'panel-clear-legacy-race';
    const seed = new BrowserProfileStore(namespace); await seed.initialize(); t.after(() => seed.close());
    await seed.storage(seed.activeProfileId).saveEntries([{ id: 'before-clear', role: 'user', text: 'Synthetic history must survive failed deletion', createdAt: 1 }]);
    const original = BrowserProfileStore.prototype.runtimeStorage;
    let rejectClear = true;
    t.mock.method(BrowserProfileStore.prototype, 'runtimeStorage', function(this: BrowserProfileStore, profileId: string) {
      const adapter = original.call(this, profileId);
      const clear = adapter.clearEntries;
      adapter.clearEntries = async () => {
        if (rejectClear) throw new ChatStorageError('legacy-cleanup', 'Legacy history changed. Close other tabs and try again.');
        await clear();
      };
      return adapter;
    });
    const { panel, query } = await mountPanel(t, MODEL, { chat: { storageKey: namespace } });
    panel.open(false);
    query<HTMLButtonElement>('.pc-clear').click(); query<HTMLButtonElement>('.pc-clear-now').click();
    await eventually(() => !query('.pc-error').hidden);
    assert.match(query('.pc-messages').textContent!, /Synthetic history must survive failed deletion/);
    assert.match(query('.pc-error').textContent!, /Could not clear conversation/);
    assert.doesNotMatch(query('.pc-error').textContent!, /CORS|API URL/);
    panel.setLanguage('zh');
    assert.match(query('.pc-error').textContent!, /当前消息已保留/);
    assert.doesNotMatch(query('.pc-error').textContent!, /CORS|key 和模型/);
    rejectClear = false;
    query<HTMLButtonElement>('.pc-clear').click(); query<HTMLButtonElement>('.pc-clear-now').click();
    await eventually(() => query('.pc-messages').hidden === true);
    assert.equal(query('.pc-messages').textContent, '');
    assert.equal(query('.pc-error').hidden, true);
  });
});

describe('chat panel credential ownership', () => {
  it('keeps setup open and explains blocked legacy credential cleanup in both languages', async (t) => {
    const { panel, query } = await mountPanel(t, MODEL);
    t.mock.method(ChatRuntime.prototype, 'configure', async () => {
      throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
    });
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => !query('.pc-error').hidden);
    assert.equal(query('.pc-setup').hidden, false);
    assert.match(query('.pc-error').textContent!, /Close other Peetty tabs/);
    assert.doesNotMatch(query('.pc-error').textContent!, /API URL and a model ID/);
    assert.match(query('.pc-setup').textContent!, /preserve pending work and upgrade pages running older Peetty releases/);
    assert.match(query('.pc-setup').textContent!, /reloading an old pinned version will not restore saving/);
    panel.setLanguage('zh');
    assert.match(query('.pc-error').textContent!, /关闭其他 Peetty 标签页/);
  });
  for (const consent of [false, true]) {
    it(`${consent ? 'remembers' : 'does not remember'} an injected key ${consent ? 'after explicit opt-in' : 'when saving another setting'}`, async (t) => {
      const storage = installChatIndexedDB(t);
      const injected = { ...MODEL, apiKey: 'fixture-injected-key' };
      const { panel, query } = await mountPanel(t, injected, { chat: { storageKey: 'injected-consent', persist: true } });
      const remember = query<HTMLInputElement>('[name="remember"]');
      assert.equal(remember.checked, false);
      query<HTMLInputElement>('[name="model"]').value = 'another-model';
      if (consent) remember.click();
      query<HTMLFormElement>('.pc-setup').requestSubmit();
      await eventually(() => query('.pc-setup').hidden === true);
      assert.equal(query('.pc-setup').hidden, true);
      const saved = savedConnection(storage, 'injected-consent')!;
      assert.equal(saved.id, 'another-model');
      assert.equal(saved.apiKey, consent ? injected.apiKey : undefined);
      panel.open(true);
      assert.equal(remember.checked, consent);
      await panel.setModel({ ...injected, id: 'sdk-replacement', apiKey: 'fixture-replacement-key' });
      panel.open(true);
      assert.equal(remember.checked, false, 'a new SDK connection needs fresh consent');
      assert.deepEqual(savedConnection(storage, 'injected-consent'), saved);
    });
  }

  for (const loaded of [false, true]) {
    it(`preserves the saved endpoint and key when the SDK injects a model ${loaded ? 'after' : 'before'} loading chat`, async (t) => {
      const storage = installChatIndexedDB(t);
      const saved = { id: 'saved-model', baseUrl: 'https://saved.example/v1', apiKey: 'fixture-saved-key' };
      const seed = new BrowserChatStore('saved-connection');
      await seed.saveConnection(saved);
      seed.close();
      const saves = t.mock.method(ChatRuntime.prototype, 'configure');
      const injected = { id: 'injected-model', baseUrl: 'https://injected.example/v1', apiKey: 'fixture-session-key' };
      const { panel, query } = await mountPanel(t, loaded ? undefined : injected, { chat: { storageKey: 'saved-connection', persist: true } });
      if (loaded) {
        assert.equal(query<HTMLInputElement>('[name="key"]').value, saved.apiKey);
        assert.equal(query<HTMLInputElement>('[name="remember"]').checked, true);
        await panel.setModel(injected);
      }
      panel.open(true);
      assert.equal(query<HTMLInputElement>('[name="key"]').value, injected.apiKey);
      assert.equal(query<HTMLInputElement>('[name="model"]').value, injected.id);
      assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
      assert.equal(saves.mock.callCount(), 0);
      assert.deepEqual(savedConnection(storage, 'saved-connection'), saved);
      assert.equal(storage.databases.get('saved-connection:chat')?.get('connection'), undefined, 'migration retires the legacy credential');
      panel.destroy();
      const profiles = new BrowserProfileStore('saved-connection'); await profiles.initialize(); t.after(() => profiles.close());
      const restored = new ChatRuntime({ storage: profiles.runtimeStorage(profiles.activeProfileId) });
      t.after(() => restored.destroy());
      await restored.initialize();
      assert.deepEqual(restored.model, saved);
    });
  }
});

function textReply(text: string): Response {
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('effort and formatted replies', () => {
  it('saves effort, preserves its selection during translation, and sends the chosen value', { timeout: 10000 }, async (t) => {
    const storage = installChatIndexedDB(t);
    const replies = [deferred<void>(), deferred<void>()];
    let turn = 0;
    const { panel, query, window } = await mountPanel(t, { ...MODEL, effort: 'low' }, {
      chat: { storageKey: 'effort-panel' }, onReply: () => replies[turn++]!.resolve(),
    });
    const effort = query<HTMLSelectElement>('[name="effort"]');
    assert.equal(effort.value, 'low');
    assert.deepEqual([...effort.options].map(option => option.value), ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    effort.value = 'max';
    panel.setLanguage('zh'); panel.open(true);
    assert.equal(effort.value, 'max');
    const sent: (string | undefined)[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { reasoning_effort?: string };
      sent.push(body.reasoning_effort);
      return textReply('Effort configured');
    });
    const send = () => {
      const input = query<HTMLTextAreaElement>('[name="message"]');
      input.value = 'hello'; input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      query<HTMLFormElement>('.pc-composer').requestSubmit();
    };
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => query('.pc-setup').hidden === true);
    const saved = () => savedConnection(storage, 'effort-panel')!;
    assert.equal(saved().effort, 'max');
    send(); await replies[0]!.promise;
    panel.open(true);
    assert.equal(effort.value, 'max');
    effort.value = '';
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => query('.pc-setup').hidden === true);
    assert.equal(saved().effort, undefined);
    send(); await replies[1]!.promise;
    assert.deepEqual(sent, ['max', undefined]);
    assert.equal(query('.pc-error').hidden, true);
  });

  it('renders assistant Markdown and a bubble preview while keeping user input literal', { timeout: 10000 }, async (t) => {
    const completed = deferred<void>();
    let bubble: HTMLElement;
    let announced = 0;
    const { panel, query, parentRoot: root, window } = await mountPanel(t, MODEL, {
      rejectHTML: true,
      onReply: (_text, render) => { assert.ok(render); render(bubble); announced++; completed.resolve(); },
    });
    bubble = window.document.createElement('div') as unknown as HTMLElement;
    root.append(bubble);
    const cat = ' /\\_/\\\n( o.o )\n > ^ <';
    const reply = `**小猫**\n\n\`\`\`text\n${cat}\n\`\`\``;
    t.mock.method(globalThis, 'fetch', async () => textReply(reply));
    panel.open(false);
    const input = query<HTMLTextAreaElement>('[name="message"]');
    input.value = '**画猫**\n保留格式'; input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit(); await completed.promise;
    const assistant = query('.pc-message[data-role="assistant"]');
    const code = assistant.querySelector('pre code');
    assert.equal(code?.textContent, cat);
    assert.equal(assistant.querySelector('strong')?.textContent, '小猫');
    assert.equal(bubble.querySelector('pre code')?.textContent, cat);
    assert.equal(query('.pc-message[data-role="user"] .pc-text').textContent, '**画猫**\n保留格式');
    assert.equal(root.querySelector('.pc-message[data-role="user"] strong'), null);
    panel.setLanguage('zh');
    assert.equal(assistant.querySelector('pre code'), code, 'unchanged messages keep their rendered DOM');
    assert.equal(announced, 1);
  });
});

describe('setup drafts and credential replacement', () => {
  it('retains a first-time form and discovered selection when opened repeatedly', async (t) => {
    const { panel, query, window, root } = await mountPanel(t, undefined);
    const url = query<HTMLInputElement>('[name="url"]');
    const key = query<HTMLInputElement>('[name="key"]');
    const model = query<HTMLInputElement>('[name="model"]');
    url.value = 'https://draft.example/v1';
    url.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    key.value = 'fixture-draft-key';
    model.value = 'draft-model';
    query<HTMLInputElement>('[name="tools"]').checked = false;
    query<HTMLInputElement>('[name="remember"]').checked = false;
    query<HTMLButtonElement>('.pc-show-key').click();
    key.focus(); key.setSelectionRange(1, 5);
    panel.open(); panel.open(true);
    assert.equal(root.activeElement, key);
    assert.deepEqual([key.selectionStart, key.selectionEnd], [1, 5]);
    query<HTMLButtonElement>('.pc-settings').click();
    assert.equal(url.value, 'https://draft.example/v1');
    assert.equal(key.value, 'fixture-draft-key');
    assert.equal(key.type, 'text');
    assert.equal(model.value, 'draft-model');
    assert.equal(query<HTMLInputElement>('[name="tools"]').checked, false);
    assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'one' }, { id: 'two' }] }));
    query<HTMLButtonElement>('.pc-load').click(); await flush();
    const models = query<HTMLSelectElement>('.pc-models');
    models.value = 'two';
    models.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    panel.open(); query<HTMLButtonElement>('.pc-settings').click();
    assert.equal(models.hidden, false);
    assert.equal(model.hidden, true);
    assert.equal(models.value, 'two');
    assert.equal(model.value, 'two');
    assert.equal(key.value, 'fixture-draft-key');
  });

  it('uses a typed replacement key for both discovery and saved chat instead of injected auth headers', { timeout: 10000 }, async (t) => {
    const reply = deferred<void>();
    let lookups = 0;
    const { query, window } = await mountPanel(t, {
      ...MODEL, apiKey: 'fixture-original-key', getApiKey: () => { lookups++; return 'fixture-callback-key'; },
      headers: { Authorization: 'Bearer fixture-expired', 'x-api-key': 'fixture-expired', 'api-key': 'fixture-expired', 'Cf-Aig-Authorization': 'Bearer fixture-expired', 'X-Route': 'retained' }, nonCredentialHeaders: ['X-Route'],
    }, { onReply: () => reply.resolve() });
    const requests: Request[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request);
      return request.method === 'GET' ? Response.json({ data: [{ id: MODEL.id }] }) : textReply('Repaired connection');
    });
    const key = query<HTMLInputElement>('[name="key"]');
    key.value = 'fixture-new-key';
    key.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLButtonElement>('.pc-load').click(); await flush();
    query<HTMLFormElement>('.pc-setup').requestSubmit(); await flush();
    const input = query<HTMLTextAreaElement>('[name="message"]');
    input.value = 'hello'; input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit(); await reply.promise;
    assert.deepEqual(requests.map(request => request.method), ['GET', 'POST']);
    for (const request of requests) {
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-new-key');
      assert.equal(request.headers.get('x-api-key'), null);
      assert.equal(request.headers.get('api-key'), null);
      assert.equal(request.headers.get('cf-aig-authorization'), null);
      assert.equal(request.headers.get('x-route'), 'retained');
    }
    assert.equal(lookups, 0);
  });

  it('does not revive SDK auth or its callback after the user explicitly clears the key', async (t) => {
    let lookups = 0;
    const { query, window } = await mountPanel(t, {
      ...MODEL, getApiKey: () => { lookups++; return 'fixture-callback'; }, headers: { Authorization: 'Bearer fixture-expired', 'cf-aig-authorization': 'Bearer fixture-expired' },
    });
    const keys: (string | null)[] = [];
    const configure = t.mock.method(ChatRuntime.prototype, 'configure');
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ data: [{ id: MODEL.id }] });
    });
    const key = query<HTMLInputElement>('[name="key"]');
    key.value = '';
    key.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLButtonElement>('.pc-load').click(); await flush();
    query<HTMLFormElement>('.pc-setup').requestSubmit(); await flush();
    assert.deepEqual(keys, [null]);
    assert.equal(lookups, 0);
    const saved = configure.mock.calls[0]!.arguments[0];
    assert.equal(saved.getApiKey, undefined);
    assert.equal(saved.headers?.authorization, undefined);
    assert.equal(saved.headers?.['cf-aig-authorization'], undefined);
  });

  it('prefers an untouched SDK callback during discovery and preserves it when saving other settings', async (t) => {
    let lookups = 0;
    const getApiKey = function(this: PeettyModelOptions) {
      assert.equal(this.apiKey, 'fixture-fallback', 'discovery keeps the model callback context');
      lookups++; return 'fixture-fresh-key';
    };
    const { query } = await mountPanel(t, { ...MODEL, apiKey: 'fixture-fallback', getApiKey });
    const configure = t.mock.method(ChatRuntime.prototype, 'configure');
    const auth: (string | null)[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ data: [{ id: MODEL.id }] });
    });
    query<HTMLButtonElement>('.pc-load').click(); await flush();
    assert.deepEqual(auth, ['Bearer fixture-fresh-key']);
    query<HTMLSelectElement>('[name="effort"]').value = 'high';
    query<HTMLFormElement>('.pc-setup').requestSubmit(); await flush();
    const saved = configure.mock.calls[0]!.arguments[0];
    assert.equal(saved.getApiKey, getApiKey);
    assert.equal(saved.apiKey, 'fixture-fallback');
    assert.equal(saved.effort, 'high');
    assert.equal(lookups, 1);
  });

  it('saves the plain-text option and chats with an endpoint rejecting tools', { timeout: 10000 }, async (t) => {
    const storage = installChatIndexedDB(t);
    const reply = deferred<void>();
    const { panel, query, window } = await mountPanel(t, MODEL, { chat: { storageKey: 'plain-text-panel' }, onReply: () => reply.resolve() });
    const tools = query<HTMLInputElement>('[name="tools"]');
    assert.equal(tools.checked, true);
    tools.click();
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => query('.pc-setup').hidden === true);
    const connection = savedConnection(storage, 'plain-text-panel')!;
    assert.equal(connection.tools, false);
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json() as { tools?: unknown; tool_choice?: unknown };
      if (body.tools || body.tool_choice) return Response.json({ error: 'tools unsupported' }, { status: 400 });
      return textReply('Plain text works');
    });
    const input = query<HTMLTextAreaElement>('[name="message"]');
    input.value = 'hello'; input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit(); await reply.promise;
    assert.match(query('.pc-messages').textContent ?? '', /Plain text works/);
    panel.open(true);
    assert.equal(tools.checked, false);
    assert.equal(query('.pc-error').hidden, true);
  });
});

describe('Escape focus lifecycle', () => {
  for (const target of ['host form', 'same shadow root'] as const) {
    it(`preserves ${target} focus when destroying an unfocused open chat`, async (t) => {
      const { panel, frame, window, parentRoot } = await mountPanel(t, MODEL);
      panel.close();
      const opener = window.document.createElement('button');
      window.document.body.append(opener); opener.focus();
      panel.open(false);
      const input = parentRoot.ownerDocument.createElement('input');
      (target === 'host form' ? parentRoot.ownerDocument.body : parentRoot).append(input);
      input.value = 'keep this selection'; input.focus(); input.setSelectionRange(2, 8);
      assert.equal(panel.isOpen, true);
      assert.ok(parentRoot.activeElement !== frame, 'the chat has relinquished focus');
      panel.destroy();
      const active = target === 'host form' ? parentRoot.ownerDocument.activeElement : parentRoot.activeElement;
      assert.ok(active === input, 'destroy must leave the focused host input in place');
      assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 8]);
    });
  }

  it('restores the opener when the destroyed chat still has focus', async (t) => {
    const { panel, query, window, parentRoot, frame } = await mountPanel(t, MODEL);
    panel.close();
    const opener = window.document.createElement('button');
    window.document.body.append(opener); opener.focus();
    panel.open(false);
    query('[name="message"]').focus();
    assert.equal(parentRoot.activeElement, frame);
    panel.destroy();
    assert.equal(window.document.activeElement, opener);
  });

  for (const ending of ['release', 'destroy', 'blur', 'fresh press', 'normal close', 'reopen']) {
    it(`retains child focus until ${ending} without leaving host key guards`, async (t) => {
      const events: string[] = [];
      const { panel, query, frame, window } = await mountPanel(t, MODEL, { beforeMount(window) {
        for (const target of [window, window.document]) for (const type of ['keydown', 'keypress', 'keyup']) {
          target.addEventListener(type, () => events.push(type), true);
        }
      } });
      panel.close();
      const button = window.document.createElement('button'); window.document.body.append(button); button.focus();
      panel.open(false);
      const input = query('[name="message"]');
      const child = input.ownerDocument.defaultView!;
      const fire = (type: string, key = 'Escape', repeat = false) => {
        const event = new child.KeyboardEvent(type, { key, repeat, bubbles: true, composed: true, cancelable: true });
        input.dispatchEvent(event); return event;
      };
      assert.equal(fire('keydown').defaultPrevented, true);
      assert.equal(panel.isOpen, false);
      assert.equal(frame.hidden, false, 'the browsing context remains rendered until release');
      assert.notEqual(window.document.activeElement, button);
      assert.equal(fire('keydown', 'Escape', true).defaultPrevented, true);
      fire('keypress');
      assert.equal(fire('keyup', 'j').defaultPrevented, false);
      assert.deepEqual(events, []);
      if (ending === 'destroy') panel.destroy();
      else if (ending === 'blur') child.dispatchEvent(new child.Event('blur'));
      else if (ending === 'fresh press') fire('keydown', 'j');
      else if (ending === 'normal close') panel.close();
      else if (ending === 'reopen') { panel.open(false); fire('keyup'); assert.equal(panel.isOpen, true); panel.close(); }
      else assert.equal(fire('keyup').defaultPrevented, true);
      if (ending !== 'destroy') assert.equal(frame.hidden, true);
      assert.equal(window.document.activeElement, button);
      button.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true, composed: true }));
      assert.deepEqual(events, ['keyup', 'keyup']);
    });
  }
});

describe('chat panel DOM and keyboard boundaries', () => {
  it('renders setup, icons, actions and replies with HTML string sinks blocked', { timeout: 10000 }, async (t) => {
    const completed = deferred<void>();
    let busySeen = false;
    const { panel, query, root, htmlWrites, window } = await mountPanel(t, MODEL, {
      rejectHTML: true,
      onState: (busy) => { if (busy) busySeen = true; else if (busySeen) completed.resolve(); },
    });
    let chatRequests = 0;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return Response.json({ data: [{ id: MODEL.id }] });
      chatRequests++;
      const body = await request.json() as { messages: { role: string }[] };
      const afterTool = body.messages.some((message) => message.role === 'tool');
      const delta = afterTool ? { role: 'assistant', content: 'A safe reply.' } : {
        role: 'assistant', tool_calls: [{ index: 0, id: 'wave', type: 'function', function: { name: 'companion_action', arguments: JSON.stringify({ action: 'wave' }) } }],
      };
      const chunk = { id: 'safe', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta, finish_reason: null }] };
      const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    query<HTMLButtonElement>('.pc-show-key').click();
    assert.equal(query<HTMLInputElement>('[name="key"]').type, 'text');
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    assert.equal(query<HTMLSelectElement>('.pc-models').value, MODEL.id);
    query<HTMLButtonElement>('.pc-settings').click();
    panel.setLanguage('zh');
    const input = query<HTMLTextAreaElement>('[name="message"]');
    input.value = '挥手';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit();
    await completed.promise;
    assert.equal(chatRequests, 2);
    assert.match(query('.pc-messages').textContent ?? '', /A safe reply/);
    assert.equal(root.querySelector('.pc-message[data-role="action"] svg')?.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(query('.pc-submit').getAttribute('aria-label'), '发送消息');
    assert.equal(query('.pc-error').hidden, true);
    query<HTMLButtonElement>('.pc-close').click();
    assert.equal(panel.isOpen, false);
    assert.equal(htmlWrites(), 0);
  });

  it('applies mobile form styling from the parent viewport and cleans up the frame on destroy', async (t) => {
    const { panel, query, frame, window, parentRoot } = await mountPanel(t, MODEL);
    window.happyDOM.setWindowSize({ width: 1000, height: 800 });
    assert.equal(query('.peetty-chat').classList.contains('pc-mobile'), false);
    window.happyDOM.setWindowSize({ width: 375, height: 812 });
    assert.equal(query('.peetty-chat').classList.contains('pc-mobile'), true);
    window.happyDOM.setWindowSize({ width: 1000, height: 800 });
    assert.equal(query('.peetty-chat').classList.contains('pc-mobile'), false);
    panel.destroy();
    assert.equal(frame.isConnected, false);
    assert.equal(parentRoot.querySelector('style'), null);
    window.happyDOM.setWindowSize({ width: 375, height: 812 });
  });

  it('focuses the current form without resetting drafts or reopening, and localizes the frame title', async (t) => {
    const { panel, query, root, frame, window } = await mountPanel(t, MODEL);
    assert.equal(frame.hasAttribute('src'), false);
    assert.equal(frame.hasAttribute('srcdoc'), false);
    assert.equal(frame.contentDocument?.URL, 'about:blank');
    assert.equal(frame.title, 'Chat with Peetty');
    const key = query<HTMLInputElement>('[name="key"]');
    key.value = 'draft'; key.focus(); key.setSelectionRange(1, 3);
    const button = window.document.createElement('button'); window.document.body.append(button); button.focus();
    panel.focus?.();
    assert.equal(root.activeElement, key);
    assert.deepEqual([key.selectionStart, key.selectionEnd], [1, 3]);
    panel.setLanguage('zh');
    assert.equal(frame.title, '和 Peetty 聊天');
    panel.close(); button.focus(); panel.focus?.();
    assert.equal(panel.isOpen, false);
    assert.equal(window.document.activeElement, button);
    panel.open(true);
    assert.equal(root.activeElement, key);
    assert.equal(key.value, 'draft');
  });

  it('contains keydown, keypress and keyup without disabling ordinary host shortcuts', async (t) => {
    const hostEvents: string[] = [];
    const { panel, query, window } = await mountPanel(t, MODEL, { beforeMount(window) {
      for (const type of ['keydown', 'keypress', 'keyup', 'pointerdown', 'pointerup', 'click']) {
        for (const target of [window.document, window]) {
          target.addEventListener(type, () => hostEvents.push(type), true);
          target.addEventListener(type, () => hostEvents.push(type));
        }
      }
    } });
    const dispatch = (target: HTMLElement) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const event = new window.KeyboardEvent(type, { key: 'j', code: 'KeyJ', bubbles: true, composed: true, cancelable: true });
        target.dispatchEvent(event as unknown as Event);
        assert.equal(event.defaultPrevented, false, 'ordinary editing keeps its default behavior');
      }
    };
    dispatch(query<HTMLInputElement>('[name="url"]'));
    dispatch(query<HTMLInputElement>('[name="key"]'));
    for (const type of ['pointerdown', 'pointerup', 'click']) query('[name="key"]').dispatchEvent(new window.MouseEvent(type, { bubbles: true, composed: true }) as unknown as Event);
    panel.open(false);
    dispatch(query<HTMLTextAreaElement>('[name="message"]'));
    assert.deepEqual(hostEvents, []);
    window.document.body.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'j', bubbles: true, composed: true }));
    assert.ok(hostEvents.length > 0);
  });
});

describe('chat panel live language changes', () => {
  for (const available of [true, false]) {
    it(`preserves the active turn, draft and unsaved credentials with storage ${available ? 'available' : 'unavailable'}`, { timeout: 10000 }, async (t) => {
      const storage = available ? installChatIndexedDB(t) : undefined;
      if (!available) t.after(stubGlobals({ indexedDB: undefined }));
      const saves = t.mock.method(ChatRuntime.prototype, 'configure');
      const streaming = deferred<void>();
      const completed = [deferred<void>(), deferred<void>()];
      let busySeen = false;
      let turns = 0;
      const { panel, query, root, window } = await mountPanel(t, { ...MODEL, apiKey: 'fixture-ephemeral-key' }, {
        chat: { persist: true, storageKey: 'language-session' },
        onState(busy, speaking) {
          if (busy) { busySeen = true; if (speaking) streaming.resolve(); }
          else if (busySeen) { busySeen = false; completed[turns++]?.resolve(); }
        },
      });
      const remember = query<HTMLInputElement>('[name="remember"]');
      remember.checked = false;
      query<HTMLFormElement>('.pc-setup').requestSubmit();
      await eventually(() => query('.pc-setup').hidden === true);
      assert.equal(query('.pc-setup').hidden, true);
      assert.equal(saves.mock.callCount(), 1);
      assert.equal(query('.pc-storage').hidden, available);
      const savedProfileConnection = () => savedConnection(storage, 'language-session');
      if (available) { assert.ok(savedProfileConnection()); assert.equal(savedProfileConnection()?.apiKey, undefined); }
      const authorization: (string | null)[] = [];
      const contexts: string[][] = [];
      let finishFirst: () => void = () => { throw new Error('The first stream has not started.'); };
      let activeSignal: AbortSignal | undefined;
      t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(url, init);
        authorization.push(request.headers.get('authorization'));
        const body = await request.json() as { messages: { role: string; content: string | { text?: string }[] }[] };
        contexts.push(body.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')));
        const answer = authorization.length === 1 ? 'First answer' : 'Second answer';
        const chunk = { id: 'language', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] };
        const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        return new Response(new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          const finish = () => { controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`)); controller.close(); };
          if (authorization.length === 1) { finishFirst = finish; activeSignal = request.signal; }
          else finish();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const input = query<HTMLTextAreaElement>('[name="message"]');
      const edit = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        element.value = value;
        element.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      };
      edit(input, 'Before language switch');
      query<HTMLFormElement>('.pc-composer').requestSubmit();
      await streaming.promise;
      const messageNodes = [...root.querySelectorAll('.pc-message')];
      edit(input, 'An unsent draft');
      input.focus();
      input.setSelectionRange(2, 8);
      panel.setLanguage('zh');
      assert.equal(panel.isOpen, true);
      assert.equal(query('.pc-composer').hidden, false);
      assert.equal(query('.peetty-chat').getAttribute('lang'), 'zh');
      assert.equal(query('.peetty-chat').getAttribute('aria-label'), '和 Peetty 聊天');
      assert.equal(query('.pc-submit').getAttribute('aria-label'), '停止回复');
      assert.equal(input.value, 'An unsent draft');
      assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 8]);
      assert.equal(root.activeElement, input);
      assert.deepEqual([...root.querySelectorAll('.pc-message')], messageNodes);
      assert.equal(activeSignal?.aborted, false);
      assert.equal(saves.mock.callCount(), 1);
      finishFirst();
      await completed[0]!.promise;
      assert.match(query('.pc-messages').textContent ?? '', /First answer/);
      query<HTMLButtonElement>('.pc-settings').click();
      const url = query<HTMLInputElement>('[name="url"]');
      const key = query<HTMLInputElement>('[name="key"]');
      assert.equal(key.value, 'fixture-ephemeral-key');
      edit(url, 'https://draft.example/v1');
      edit(key, 'fixture-unsaved-key');
      query<HTMLInputElement>('[name="model"]').value = 'draft-model';
      query<HTMLButtonElement>('.pc-show-key').click();
      key.focus();
      key.setSelectionRange(1, 5);
      panel.setLanguage('en');
      assert.equal(query('.pc-setup').hidden, false);
      assert.equal(url.value, 'https://draft.example/v1');
      assert.equal(key.value, 'fixture-unsaved-key');
      assert.equal(key.type, 'text');
      assert.deepEqual([key.selectionStart, key.selectionEnd], [1, 5]);
      assert.equal(query<HTMLInputElement>('[name="model"]').value, 'draft-model');
      assert.equal(remember.checked, false);
      assert.equal(saves.mock.callCount(), 1);
      query<HTMLButtonElement>('.pc-settings').click();
      assert.equal(input.value, 'An unsent draft');
      edit(input, 'After language switch');
      query<HTMLFormElement>('.pc-composer').requestSubmit();
      await completed[1]!.promise;
      assert.deepEqual(authorization, ['Bearer fixture-ephemeral-key', 'Bearer fixture-ephemeral-key']);
      assert.deepEqual(contexts[1], ['Before language switch', 'First answer', 'After language switch']);
      assert.match(query('.pc-messages').textContent ?? '', /Second answer/);
      assert.equal(query('.pc-error').hidden, true);
      if (available) assert.equal(savedProfileConnection()?.apiKey, undefined);
    });
  }
});

describe('chat panel turn ownership', () => {
  for (const interruption of ['stop', 'close', 'setModel', 'configure', 'destroy']) {
    it(`keeps partial transcript without announcing after ${interruption}, then permits a successful turn`, { timeout: 10000 }, async (t) => {
      const partial = deferred<void>();
      const complete = deferred<void>();
      const spoken: string[] = [];
      const { panel, query, window } = await mountPanel(t, MODEL, {
        onReply(text) { spoken.push(text); complete.resolve(); },
        onState(busy, speaking) { if (busy && speaking) partial.resolve(); },
      });
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (++calls > 1) return textReply('A complete reply');
        const chunk = { id: 'partial', object: 'chat.completion.chunk', created: 1, model: MODEL.id,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'A partial reply' }, finish_reason: null }] };
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const send = () => {
        const input = query<HTMLTextAreaElement>('[name="message"]');
        input.value = 'hello'; input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
        query<HTMLFormElement>('.pc-composer').requestSubmit();
      };
      panel.open(false); send(); await partial.promise;
      const announcement = query('.pc-announcement');
      const transcript = query('.pc-messages');
      if (interruption === 'stop') query<HTMLButtonElement>('.pc-submit').click();
      else if (interruption === 'close') panel.close();
      else if (interruption === 'setModel') await panel.setModel({ ...MODEL, id: 'replacement' });
      else if (interruption === 'configure') { panel.open(true); query<HTMLFormElement>('.pc-setup').requestSubmit(); }
      else panel.destroy();
      await flush();
      assert.deepEqual(spoken, []);
      assert.equal(announcement.textContent, '');
      if (interruption === 'destroy') return;
      assert.match(transcript.textContent ?? '', /A partial reply/);
      panel.open(false); send(); await complete.promise;
      assert.deepEqual(spoken, ['A complete reply']);
      assert.equal(query('.pc-announcement').textContent, 'A complete reply');
    });
  }

  it('does not announce a peer reply refreshed during a silent turn', { timeout: 10000 }, async (t) => {
    installChatIndexedDB(t);
    const spoken: string[] = [];
    const completed = deferred<void>();
    let busySeen = false;
    const { panel, query, window } = await mountPanel(t, MODEL, {
      chat: { storageKey: 'shared-panel', persist: true },
      onReply: (text) => spoken.push(text),
      onState: (busy) => { if (busy) busySeen = true; else if (busySeen) completed.resolve(); },
    });
    const profiles = new BrowserProfileStore('shared-panel');
    await profiles.initialize();
    const peer = profiles.storage(profiles.activeProfile.id);
    t.after(() => { peer.close(); profiles.close(); });
    await peer.saveEntries([
      { id: 'peer-user', role: 'user', text: 'Peer input', createdAt: 1 },
      { id: 'peer-answer', role: 'assistant', text: 'Only the peer said this.', createdAt: 2 },
    ]);
    t.mock.method(globalThis, 'fetch', async () => {
      const chunk = { id: 'silent', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    panel.open(false);
    const input = query<HTMLTextAreaElement>('[name="message"]');
    input.value = 'A new silent turn';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLFormElement>('.pc-composer').requestSubmit();
    await completed.promise;
    assert.match(query('.pc-messages').textContent ?? '', /Only the peer said this/);
    assert.deepEqual(spoken, []);
    assert.equal(query('.pc-announcement').textContent, '');
    assert.equal(query('.pc-error').hidden, true);
  });
});

describe('chat panel shared-history order', () => {
  it('reorders existing message nodes to match the refreshed model context', { timeout: 10000 }, async (t) => {
    installChatIndexedDB(t);
    const visible = deferred<void>();
    const completed = [deferred<void>(), deferred<void>()];
    let busySeen = false;
    let completedTurns = 0;
    let currentRoot: ShadowRoot | undefined;
    const { panel, query, root, window } = await mountPanel(t, MODEL, {
      chat: { storageKey: 'shared-order', persist: true },
      onState: (busy) => {
        if (busy) {
          busySeen = true;
          if (currentRoot?.textContent?.includes('local answer')) visible.resolve();
        } else if (busySeen) {
          busySeen = false;
          completed[completedTurns++]?.resolve();
        }
      },
    });
    currentRoot = root;
    const profiles = new BrowserProfileStore('shared-order');
    await profiles.initialize();
    const peer = new ChatRuntime({ model: MODEL, storage: profiles.storage(profiles.activeProfile.id) });
    t.after(() => { peer.destroy(); profiles.close(); });
    const held: { finish: () => void } = { finish() { throw new Error('Local response has not started.'); } };
    let nextContext: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json() as { messages: { role: string; content: string | { text?: string }[] }[] };
      const textOf = (message: (typeof body.messages)[number]) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join('');
      const inputText = textOf(body.messages.filter((message) => message.role === 'user').at(-1)!);
      if (inputText === 'next input') nextContext = body.messages.filter((message) => message.role === 'user' || message.role === 'assistant').map(textOf);
      const answer = inputText === 'local input' ? 'local answer' : inputText === 'peer input' ? 'peer answer' : 'next answer';
      const chunk = { id: 'order', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] };
      const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const finish = () => { controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`)); controller.close(); };
        if (inputText === 'local input') {
          held.finish = finish;
          request.signal.addEventListener('abort', () => { try { controller.close(); } catch { /* Already closed. */ } }, { once: true });
        } else finish();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    panel.open(false);
    const send = (text: string) => {
      const input = query<HTMLTextAreaElement>('[name="message"]');
      input.value = text;
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      query<HTMLFormElement>('.pc-composer').requestSubmit();
    };
    send('local input');
    await visible.promise;
    const localNode = query('.pc-message');
    await peer.send('peer input');
    assert.equal(peer.error, null);
    held.finish();
    await completed[0]!.promise;
    send('next input');
    await completed[1]!.promise;
    assert.deepEqual(nextContext, ['peer input', 'peer answer', 'local input', 'local answer', 'next input']);
    const displayed = [...root.querySelectorAll<HTMLElement>('.pc-message .pc-text')].map((node) => node.textContent);
    assert.deepEqual(displayed, [...nextContext, 'next answer']);
    assert.equal([...root.querySelectorAll('.pc-message')][2], localNode, 'reconciliation retains the existing keyed node');
    assert.equal(query('.pc-error').hidden, true);
  });
});

describe('reviewed profile ownership and recovery', () => {
  it('keeps a late SDK model owner when a full-capacity backup cannot fit', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'late-model-bootstrap-owner';
    const { panel, query } = await mountPanel(t, undefined, { chat: { storageKey: namespace } });
    const inspect = new BrowserProfileStore(namespace); await inspect.initialize(); t.after(() => inspect.close());
    const originalId = inspect.activeProfileId;
    const backup = JSON.parse(await inspect.backup()) as { activeProfileId: string; profiles: ProfileRecord[] };
    const template = backup.profiles[0]!;
    backup.profiles = Array.from({ length: 100 }, (_, index) => ({ ...template, id: `synthetic-import-${index}`, name: `Imported ${index}` }));
    backup.activeProfileId = backup.profiles[0]!.id;
    await panel.setModel({ ...MODEL, id: 'late-injected-model', apiKey: 'fixture-late-bootstrap-key' });
    await assert.rejects(inspect.restore(JSON.stringify(backup)), /Profile storage limit reached/);
    assert.equal(inspect.activeProfileId, originalId);
    assert.equal(inspect.listProfiles().length, 1);
    assert.equal(savedConnection(idb, namespace), undefined, 'marking the owner used never persists SDK credentials');
    panel.open(true);
    assert.equal(query<HTMLInputElement>('[name="model"]').value, 'late-injected-model');
    assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
  });

  it('downloads and restores all backup parts through the real panel with callback credentials', async (t) => {
    installChatIndexedDB(t);
    const download = BrowserProfileStore.prototype.backupDownload;
    t.mock.method(BrowserProfileStore.prototype, 'backupDownload', function(this: BrowserProfileStore, options?: Parameters<typeof download>[0]) {
      return download.call(this, { ...options, _testing: { fileBytes: 1_024 } });
    });
    const fixtureKey = `fixture-multipart-key-${'x'.repeat(1_100)}`;
    let lookups = 0;
    const { query, root, window } = await mountPanel(t, { ...MODEL, getApiKey: () => { lookups++; return fixtureKey; } }, { chat: { storageKey: 'multipart-panel-ui' } });
    const blobs: Blob[] = []; const names: string[] = [];
    t.mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return `blob:multipart-panel-${blobs.length}`; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    root.addEventListener('click', event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[download]');
      if (link) { event.preventDefault(); names.push(link.download); }
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    const advanceScan = async () => { t.mock.timers.tick(0); await new Promise<void>(resolve => setImmediate(resolve)); };
    for (let i = 0; i < 1_000 && blobs.length < 2 && !query('.pc-manage-status').hasAttribute('data-error'); i++) await advanceScan();
    assert.equal(query('.pc-manage-status').hasAttribute('data-error'), false, query('.pc-manage-status').textContent!);
    assert.equal(blobs.length, 2);
    for (let i = 0; i < 100 && !query('.pc-manage-status').textContent!.includes('All backup parts are ready'); i++) {
      t.mock.timers.tick(60_000);
      for (let turn = 0; turn < 20; turn++) await advanceScan();
    }
    assert.match(query('.pc-manage-status').textContent!, /All backup parts are ready/);
    assert.ok(blobs.length > 1); assert.equal(lookups, 1); assert.equal(names.length, blobs.length);
    const texts = await Promise.all(blobs.map(blob => blob.text()));
    const restored = JSON.parse(texts.map(text => JSON.parse(text).text as string).join(''));
    assert.equal(restored.sessions[0].connection.apiKey, fixtureKey);
    const before = query<HTMLSelectElement>('.pc-profile-select').value;
    const input = query<HTMLInputElement>('input[type="file"][multiple]');
    Object.defineProperty(input, 'files', { configurable: true, value: texts.map((text, i) => new window.File([text], names[i]!)) });
    input.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => query<HTMLSelectElement>('.pc-profile-select').options.length === 2 && !query<HTMLSelectElement>('.pc-profile-select').disabled);
    assert.notEqual(query<HTMLSelectElement>('.pc-profile-select').value, before);
    assert.equal(query<HTMLInputElement>('[name="key"]').value, fixtureKey, 'restored multipart session credentials reach the active connection');
    assert.match(query('.pc-manage-status').textContent!, /Import complete/);
  });

  it('registers a backup-resolved callback key for later message and memory redaction', async (t) => {
    const idb = installChatIndexedDB(t);
    const firstKey = 'fixture-backup-only-retired-key'; const secondKey = 'fixture-backup-current-key';
    let currentKey = firstKey;
    let downloaded: Blob | undefined;
    let completed = 0;
    const contexts: string[] = [];
    t.mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:synthetic-key-backup'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get('authorization'), `Bearer ${secondKey}`);
      contexts.push(JSON.stringify(await request.json())); return textReply('Done.');
    });
    const { panel, query, root } = await mountPanel(t, { ...MODEL, getApiKey: () => currentKey }, {
      chat: { storageKey: 'backup-resolved-secret-registry' }, onReply() { completed++; },
    });
    root.addEventListener('click', event => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    await eventually(() => !!downloaded);
    assert.equal(JSON.parse(await downloaded!.text()).sessions[0].connection.apiKey, firstKey);
    currentKey = secondKey;
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    const memory = query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]');
    memory.value = `Synthetic note containing ${firstKey}`; memory.form!.requestSubmit();
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled);
    panel.open(false);
    const message = query<HTMLTextAreaElement>('[name="message"]');
    message.value = `Please redact ${firstKey}`; message.form!.requestSubmit();
    await eventually(() => completed === 1);
    assert.equal(query('.pc-messages').textContent!.includes(firstKey), false);
    assert.equal(contexts[0]!.includes(firstKey), false);
    assert.match(contexts[0]!, /\[redacted\]/);
    assert.equal(savedConnection(idb, 'backup-resolved-secret-registry'), undefined);
  });

  for (const stage of ['fetch', 'body'] as const) {
    it(`unlocks recovery after a remote figure ${stage} exceeds its deadline`, async (t) => {
      installChatIndexedDB(t);
      const namespace = `figure-deadline-recovery-${stage}`;
      const seed = new BrowserProfileStore(namespace); await seed.initialize({ name: 'Working companion' }); t.after(() => seed.close());
      const working = seed.activeProfileId;
      const stalled = await seed.create({ name: 'Stalled companion', figure: './synthetic-stalled.json' });
      const schedule = globalThis.setTimeout;
      t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        schedule(callback, delay === FIGURE_LOAD_TIMEOUT ? 1 : delay, ...args)) as typeof setTimeout);
      const signals: AbortSignal[] = [];
      t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
        signals.push(init!.signal!);
        if (stage === 'fetch') return new Promise<Response>(() => {});
        return { ok: true, json: () => new Promise(() => {}) } as Response;
      });
      const { query, window } = await mountPanel(t, MODEL, {
        chat: { storageKey: namespace }, onFigure: async figure => { await resolveFigure(figure); },
        portrait: async figure => { await resolveFigure(figure); return null; },
      });
      assert.equal(query('.pc-error').hidden, false);
      assert.equal(signals[0]?.aborted, true);
      assert.equal(signals.length, 1, 'a failed artwork load does not start a detached portrait retry');
      const select = query<HTMLSelectElement>('.pc-profile-select');
      select.value = working; select.dispatchEvent(new window.Event('change') as unknown as Event);
      await eventually(() => !select.disabled && query('.pc-name').textContent === 'Working companion');
      select.value = stalled.id; select.dispatchEvent(new window.Event('change') as unknown as Event);
      await eventually(() => !select.disabled && signals.length === 2 && query('.pc-error').hidden === false);
      assert.equal(signals[1]?.aborted, true);
      query<HTMLButtonElement>('[data-tab="memory"]').click();
      assert.equal(query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]').disabled, false);
    });
  }

  it('keeps injected-key consent unchecked through a same-profile reload', async (t) => {
    const idb = installChatIndexedDB(t);
    const seed = new BrowserProfileStore('consent-review'); await seed.initialize(); t.after(() => seed.close());
    await seed.storage(seed.activeProfileId).saveConnection({ ...MODEL, id: 'saved', apiKey: 'fixture-saved-A' });
    const { query } = await mountPanel(t, { ...MODEL, id: 'sdk', apiKey: 'fixture-sdk-B' }, { chat: { storageKey: 'consent-review' } });
    assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    query<HTMLInputElement>('[data-setting="useMemories"]').click();
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled);
    query<HTMLButtonElement>('[data-tab="connection"]').click();
    assert.equal(query<HTMLInputElement>('[name="remember"]').checked, false);
    query<HTMLInputElement>('[name="model"]').value = 'sdk-updated';
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await eventually(() => query('.pc-setup').hidden === true);
    assert.equal(savedConnection(idb, 'consent-review')?.id, 'sdk-updated');
    assert.equal(savedConnection(idb, 'consent-review')?.apiKey, undefined);
  });

  it('blocks the old connection form until a destination profile has initialized', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('form-owner-review'); await seed.initialize(); t.after(() => seed.close());
    const first = seed.activeProfileId;
    const connectionA = { ...MODEL, id: 'model-A', baseUrl: 'https://a.example/v1', apiKey: 'fixture-key-A' };
    const connectionB = { ...MODEL, id: 'model-B', baseUrl: 'https://b.example/v1', apiKey: 'fixture-key-B' };
    await seed.storage(first).saveConnection(connectionA);
    const second = await seed.create({ name: 'B' }); await seed.storage(second.id).saveConnection(connectionB); await seed.select(first);
    const started = deferred<void>(); const release = deferred<void>();
    const original = BrowserProfileStore.prototype.runtimeStorage;
    t.mock.method(BrowserProfileStore.prototype, 'runtimeStorage', function (this: BrowserProfileStore, id: string) {
      const adapter = original.call(this, id);
      if (id === second.id) { const load = adapter.load; adapter.load = async () => { started.resolve(); await release.promise; return load(); }; }
      return adapter;
    });
    const configure = t.mock.method(ChatRuntime.prototype, 'configure');
    const { query, window } = await mountPanel(t, undefined, { chat: { storageKey: 'form-owner-review' } });
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = second.id;
    selector.dispatchEvent(new window.Event('change') as unknown as Event); await started.promise;
    assert.equal(query<HTMLInputElement>('[name="key"]').value, connectionA.apiKey);
    assert.equal(query<HTMLFormElement>('.pc-setup').inert, true);
    assert.equal(query<HTMLButtonElement>('.pc-setup [type="submit"]').disabled, true);
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    assert.equal(configure.mock.callCount(), 0);
    release.resolve();
    await eventually(() => !selector.disabled && query<HTMLInputElement>('[name="model"]').value === connectionB.id);
    const reader = new BrowserProfileStore('form-owner-review'); await reader.initialize(); t.after(() => reader.close());
    assert.deepEqual(reader.storedConnection(second.id), connectionB);
  });

  it('keeps recovery settings and destination editors available when a character fails', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('figure-recovery-review'); await seed.initialize(); t.after(() => seed.close());
    const first = seed.activeProfileId; await seed.saveMemory(first, { text: 'A only' });
    const second = await seed.create({ name: 'B', figure: './missing.json' }); await seed.saveMemory(second.id, { text: 'B only' });
    const onFigure = async () => { throw new Error('fixture unavailable character'); };
    const { query, window } = await mountPanel(t, MODEL, { chat: { storageKey: 'figure-recovery-review' }, figure: 'miru', onFigure });
    assert.equal(query('.pc-error').hidden, false, 'an unavailable initial saved figure is recoverable');
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    const selector = query<HTMLSelectElement>('.pc-profile-select');
    selector.value = first; selector.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => !selector.disabled && query('.pc-record-list').textContent!.includes('A only'));
    selector.value = second.id; selector.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => !selector.disabled && query('.pc-record-list').textContent!.includes('B only'));
    assert.doesNotMatch(query('.pc-record-list').textContent!, /A only/);
    const input = query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]'); input.value = 'For B'; input.form!.requestSubmit();
    await eventually(() => !selector.disabled && query('.pc-record-list').textContent!.includes('For B'));
    const profiles = JSON.parse(await seed.backup()).profiles as ProfileRecord[];
    assert.deepEqual(profiles.find((profile) => profile.id === first)!.memories.map((memory) => memory.text), ['A only']);
    assert.deepEqual(profiles.find((profile) => profile.id === second.id)!.memories.map((memory) => memory.text), ['B only', 'For B']);
  });

  it('retains retired secret redaction after key rotation and a profile rename', async (t) => {
    installChatIndexedDB(t);
    const firstKey = 'fixture-review-retired-K1'; const secondKey = 'fixture-review-current-K2';
    let completed = 0;
    const contexts: string[] = []; const auth: (string | null)[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); auth.push(request.headers.get('authorization'));
      contexts.push(JSON.stringify(await request.json())); return textReply('Done.');
    });
    const { panel, query, window } = await mountPanel(t, { ...MODEL, apiKey: firstKey }, { chat: { storageKey: 'retired-review' }, onReply() { completed++; } });
    query<HTMLButtonElement>('[data-tab="memory"]').click();
    const memory = query<HTMLTextAreaElement>('[aria-label="What should your companion remember?"]'); memory.value = `Private note: ${firstKey} and ${secondKey}.`; memory.form!.requestSubmit();
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled);
    query<HTMLButtonElement>('[data-tab="connection"]').click();
    const key = query<HTMLInputElement>('[name="key"]'); key.value = secondKey;
    key.dispatchEvent(new window.Event('input') as unknown as Event); query<HTMLInputElement>('[name="remember"]').checked = true;
    query<HTMLFormElement>('.pc-setup').requestSubmit(); await eventually(() => query('.pc-setup').hidden === true);
    const send = () => { panel.open(false); const input = query<HTMLTextAreaElement>('[name="message"]'); input.value = 'Hello'; input.dispatchEvent(new window.Event('input') as unknown as Event); input.form!.requestSubmit(); };
    send(); await eventually(() => completed === 1);
    panel.open(true); query<HTMLButtonElement>('[data-tab="profile"]').click();
    const name = query<HTMLInputElement>('[aria-label="Profile name"]'); name.value = 'Renamed'; name.form!.requestSubmit();
    await eventually(() => !query<HTMLSelectElement>('.pc-profile-select').disabled && query('.pc-name').textContent === 'Renamed');
    send(); await eventually(() => completed === 2);
    assert.deepEqual(auth, [`Bearer ${secondKey}`, `Bearer ${secondKey}`]);
    for (const context of contexts) { assert.equal(context.includes(firstKey), false); assert.equal(context.includes(secondKey), false); assert.match(context, /\[redacted\]/); }
  });

  it('backs up saved and session connections once while resolving independent credentials together', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('session-backup-review'); await seed.initialize(); t.after(() => seed.close());
    const first = seed.activeProfileId;
    const saved = { ...MODEL, id: 'saved-model', baseUrl: 'https://saved.example/v1', provider: 'Saved provider', apiKey: 'fixture-saved-key' };
    await seed.storage(first).saveConnection(saved);
    const second = await seed.create({ name: 'Second' }); await seed.select(first);
    const keyA = deferred<string>(); const keyB = deferred<string>(); let callsA = 0; let callsB = 0;
    const modelA: PeettyModelOptions = { ...MODEL, id: 'session-A', getApiKey() { assert.equal(this.id, 'session-A'); callsA++; return keyA.promise; } };
    const modelB: PeettyModelOptions = { ...MODEL, id: 'session-B', headers: { 'x-api-key': 'fixture-session-header' }, getApiKey() { assert.equal(this.id, 'session-B'); callsB++; return keyB.promise; } };
    let blob: Blob | undefined;
    t.mock.method(URL, 'createObjectURL', (value: Blob) => { blob = value; return 'blob:fixture'; }); t.mock.method(URL, 'revokeObjectURL', () => {});
    const { panel, query, root, window } = await mountPanel(t, modelA, { chat: { storageKey: 'session-backup-review' } });
    root.addEventListener('click', (event) => { if ((event.target as Element).closest('a[download]')) event.preventDefault(); });
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = second.id; selector.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => !selector.disabled); await panel.setModel(modelB); panel.open(true);
    query<HTMLButtonElement>('[data-tab="data"]').click(); query<HTMLButtonElement>('.pc-backup').click();
    await eventually(() => callsA === 1 && callsB === 1);
    const longKey = 'k'.repeat(16_385); keyB.resolve('fixture-session-B-key'); keyA.resolve(longKey);
    await eventually(() => !!blob);
    const text = await blob!.text(); const backup = JSON.parse(text) as { version: number; profiles: ProfileRecord[]; sessions: { profileId: string; connection: StoredConnection; rememberKey: boolean }[] };
    assert.equal(backup.version, 2);
    assert.deepEqual(backup.profiles.find((profile) => profile.id === first)!.connection, saved);
    assert.ok(backup.sessions.find((session) => session.profileId === first)!.connection.apiKey === longKey);
    assert.equal(backup.sessions.find((session) => session.profileId === second.id)!.connection.apiKey, 'fixture-session-B-key');
    const target = new BrowserProfileStore('session-backup-review-target'); await target.initialize(); t.after(() => target.close());
    await target.restore(text);
    const restoredA = target.profiles.find((profile) => profile.connection?.id === saved.id)!;
    assert.notEqual(restoredA.id, first);
    assert.deepEqual(target.storedConnection(restoredA.id), saved);
    const sessions = (await target.storage(restoredA.id).load()).sessionConnections!;
    assert.ok(sessions.at(-1)!.connection.apiKey === longKey);
    const nextVisit = new BrowserProfileStore('session-backup-review-target'); await nextVisit.initialize(); t.after(() => nextVisit.close());
    assert.deepEqual((await nextVisit.storage(restoredA.id).load()).connection, saved);
    assert.equal((await nextVisit.storage(restoredA.id).load()).sessionConnections, undefined, 'ephemeral keys retain their original lifetime');
  });

  it('adopts a peer-updated saved connection instead of caching it as an SDK override', async (t) => {
    installChatIndexedDB(t);
    const seed = new BrowserProfileStore('saved-owner-review'); await seed.initialize(); t.after(() => seed.close());
    const first = seed.activeProfileId;
    await seed.storage(first).saveConnection({ ...MODEL, id: 'old', apiKey: 'fixture-old-key' });
    const second = await seed.create({ name: 'Second' }); await seed.select(first);
    const { query, window } = await mountPanel(t, undefined, { chat: { storageKey: 'saved-owner-review' } });
    const selector = query<HTMLSelectElement>('.pc-profile-select'); selector.value = second.id; selector.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => !selector.disabled);
    const updated = { ...MODEL, id: 'peer-updated', apiKey: 'fixture-peer-key', baseUrl: 'https://peer.example/v1' };
    await seed.storage(first).saveConnection(updated);
    selector.value = first; selector.dispatchEvent(new window.Event('change') as unknown as Event);
    await eventually(() => !selector.disabled && query<HTMLInputElement>('[name="model"]').value === updated.id);
    assert.equal(query<HTMLInputElement>('[name="key"]').value, updated.apiKey);
    assert.equal(query<HTMLInputElement>('[name="url"]').value, updated.baseUrl);
  });

  for (const change of ['forget', 'rotate'] as const) {
    it(`${change === 'forget' ? 'forgets restored authentication' : 'rotates the restored key'} without losing provider routing headers`, async (t) => {
      installChatIndexedDB(t);
      const namespace = `header-policy-${change}`;
      const seed = new BrowserProfileStore(namespace); await seed.initialize(); t.after(() => seed.close());
      const data = JSON.parse(await seed.backup()) as { profiles: ProfileRecord[] };
      data.profiles[0]!.connection = { ...MODEL, baseUrl: `${MODEL.baseUrl}/`, headers: { Authorization: 'Bearer fixture-restored-auth', 'OpenAI-Project': 'project-review' } };
      await seed.restore(JSON.stringify(data));
      const id = seed.activeProfileId;
      const { query, window } = await mountPanel(t, undefined, { chat: { storageKey: namespace } });
      const remember = query<HTMLInputElement>('[name="remember"]');
      assert.equal(remember.checked, true);
      assert.match(remember.parentElement!.textContent!, /authentication/);
      if (change === 'forget') remember.checked = false;
      else {
        const key = query<HTMLInputElement>('[name="key"]'); key.value = 'fixture-replacement-key'; key.dispatchEvent(new window.Event('input') as unknown as Event);
      }
      query<HTMLFormElement>('.pc-setup').requestSubmit(); await eventually(() => query('.pc-setup').hidden === true);
      const reader = new BrowserProfileStore(namespace); await reader.initialize(); t.after(() => reader.close());
      const saved = reader.storedConnection(id)!;
      assert.equal(saved.baseUrl, MODEL.baseUrl);
      assert.equal(saved.headers?.['openai-project'], 'project-review');
      assert.equal(saved.headers?.authorization, undefined);
      assert.equal(saved.apiKey, change === 'rotate' ? 'fixture-replacement-key' : undefined);
    });
  }

  it('releases construction resources when profile initialization rejects', async (t) => {
    let createdWindow: Window | undefined; let mediaListeners = 0;
    await assert.rejects(() => mountPanel(t, MODEL, { figure: { format: 'invalid' }, beforeMount(window) {
      createdWindow = window; const original = window.matchMedia.bind(window);
      t.mock.method(window, 'matchMedia', (query: string) => {
        const result = original(query); const add = result.addEventListener; const remove = result.removeEventListener;
        Object.defineProperty(result, 'addEventListener', { value: (...args: unknown[]) => { if (args[0] === 'change') mediaListeners++; return Reflect.apply(add, result, args); } });
        Object.defineProperty(result, 'removeEventListener', { value: (...args: unknown[]) => { if (args[0] === 'change') mediaListeners--; return Reflect.apply(remove, result, args); } });
        return result;
      });
    } }), /Invalid or unsupported profile data/);
    const document = createdWindow!.document as unknown as Document;
    const root = document.body.firstElementChild!.shadowRoot!;
    assert.equal(root.querySelectorAll('iframe,style').length, 0); assert.equal(mediaListeners, 0);
    await assert.rejects(() => createChatPanel({ root, language: 'en', figure: { format: 'invalid' }, chat: { persist: false }, onAction() {}, onReply() {}, onState() {}, onClose() {} }), /Invalid or unsupported profile data/);
    assert.equal(root.querySelectorAll('iframe,style').length, 0); assert.equal(mediaListeners, 0);
  });
});

describe('chat panel model discovery', () => {
  it('releases the loading state when an unresolved credential callback times out', async (t) => {
    const credential = deferred<string>();
    let lookups = 0;
    const { query } = await mountPanel(t, { ...MODEL, getApiKey: () => { lookups++; return credential.promise; } });
    const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const load = query<HTMLButtonElement>('.pc-load');
    load.click();
    await flush();
    assert.equal(load.disabled, true);
    assert.equal(lookups, 1);
    assert.equal(network.mock.callCount(), 0);
    t.mock.timers.tick(20_001);
    await flush();
    assert.equal(load.disabled, false);
    assert.equal(load.textContent, 'Load models');
    assert.equal(query('.pc-error').hidden, false);
    assert.equal(query<HTMLInputElement>('[name="model"]').hidden, false);
    credential.resolve('late-secret');
    await flush();
    assert.equal(network.mock.callCount(), 0, 'an expired lookup must not dispatch its late credential');
  });

  it('cancels a stalled lookup when chat closes without a late request or stale error', async (t) => {
    const credential = deferred<string>();
    const { panel, query } = await mountPanel(t, { ...MODEL, getApiKey: () => credential.promise });
    const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    panel.close();
    credential.resolve('late-secret');
    await flush();
    assert.equal(network.mock.callCount(), 0);
    assert.equal(query<HTMLButtonElement>('.pc-load').disabled, false);
    assert.equal(query('.pc-error').hidden, true);
  });

  it('reports Magpie gateway authentication failures separately from CORS', async (t) => {
    const { query } = await mountPanel(t, { id: 'model', baseUrl: 'http://127.0.0.1:3425/v1' });
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'server-secret' } }, { status: 401 }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    const text = query('.pc-error').textContent ?? '';
    assert.match(text, /Magpie.*gateway authentication/);
    assert.match(text, /Gateway page/);
    assert.ok(!text.includes('CORS'));
    assert.ok(!text.includes('server-secret'));
    assert.equal(query<HTMLButtonElement>('.pc-load').disabled, false);
  });

  it('reports ordinary API permission failures without claiming CORS failed', async (t) => {
    const { query } = await mountPanel(t, { ...MODEL, apiKey: 'test-key' });
    t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 403 }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    assert.match(query('.pc-error').textContent ?? '', /API key and its permissions/);
    assert.ok(!query('.pc-error').textContent?.includes('CORS'));
  });

  it('forwards header-based SDK auth only to the normalized configured endpoint', async (t) => {
    const { query, window } = await mountPanel(t, {
      ...MODEL, apiKey: 'fallback-key', headers: { 'x-api-key': 'header-secret', authorization: 'Bearer explicit-key' },
    });
    const requests: { url: string; headers: Headers }[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ data: [{ id: 'one-model' }] });
    });
    const url = query<HTMLInputElement>('[name="url"]');
    // A trailing slash still identifies the same normalized endpoint.
    url.value = `${MODEL.baseUrl}/`;
    url.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `${MODEL.baseUrl}/models`);
    assert.equal(requests[0]!.headers.get('x-api-key'), 'header-secret');
    assert.equal(requests[0]!.headers.get('authorization'), 'Bearer explicit-key');
    assert.equal(query<HTMLSelectElement>('.pc-models').value, 'one-model');
    url.value = 'https://new.example/v1';
    url.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.url, 'https://new.example/v1/models');
    assert.equal(requests[1]!.headers.get('x-api-key'), null);
    assert.equal(requests[1]!.headers.get('authorization'), null);
  });

  it('cancels lookup when a manually entered model is saved', async (t) => {
    const credential = deferred<string>();
    const { query } = await mountPanel(t, { ...MODEL, getApiKey: () => credential.promise });
    const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    query<HTMLFormElement>('.pc-setup').requestSubmit();
    await flush();
    credential.resolve('old-secret');
    await flush();
    assert.equal(network.mock.callCount(), 0);
    assert.equal(query<HTMLButtonElement>('.pc-load').disabled, false);
    assert.equal(query('.pc-setup').hidden, true);
    assert.equal(query('.pc-error').hidden, true);
  });

  it('never sends a pending callback key after the URL field changes', async (t) => {
    const credential = deferred<string>();
    const { query, window } = await mountPanel(t, { ...MODEL, getApiKey: () => credential.promise });
    const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    const url = query<HTMLInputElement>('[name="url"]');
    url.value = 'https://new.example/';
    url.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    credential.resolve('old-secret');
    await flush();
    assert.equal(network.mock.callCount(), 0);
    assert.equal(query<HTMLButtonElement>('.pc-load').disabled, false);
    assert.equal(query('.pc-error').hidden, true);
  });

  it('rejects an invalid SDK replacement and retains the configured connection', async (t) => {
    const { panel, query } = await mountPanel(t, MODEL);
    await assert.rejects(panel.setModel({ id: 'new-model', baseUrl: 'https://user:secret@new.example/v1' }), (error: Error) => {
      assert.match(error.message, /valid API base URL and model ID/);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
    assert.equal(query<HTMLInputElement>('[name="url"]').value, MODEL.baseUrl);
    assert.equal(query<HTMLInputElement>('[name="model"]').value, MODEL.id);
    assert.equal(query('.pc-setup').hidden, false);
    await panel.setModel({ id: 'root-model', baseUrl: 'https://root.example/' });
    assert.equal(query('.pc-status').textContent, 'root-model');
    assert.equal(query('.pc-error').hidden, true);
  });

  it('aborts old discovery when the SDK replaces the model', async (t) => {
    const credential = deferred<string>();
    const { panel, query } = await mountPanel(t, { ...MODEL, getApiKey: () => credential.promise, headers: { 'x-api-key': 'old-secret' } });
    const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    query<HTMLButtonElement>('.pc-load').click();
    await flush();
    await panel.setModel({ id: 'new-model', baseUrl: 'https://new.example/v1', apiKey: 'new-secret' });
    credential.resolve('old-secret');
    await flush();
    assert.equal(network.mock.callCount(), 0);
    assert.equal(query<HTMLButtonElement>('.pc-load').disabled, false);
    assert.equal(query('.pc-error').hidden, true);
  });
});
