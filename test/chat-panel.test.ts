import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { createChatPanel, type ChatPanel } from '../src/chat/panel.ts';
import type { PeettyChatOptions, PeettyModelOptions } from '../src/chat/types.ts';
import { BrowserChatStore } from '../src/chat/store.ts';
import { ChatRuntime } from '../src/chat/runtime.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const MODEL = { id: 'model', baseUrl: 'https://models.example/v1' };

async function mountPanel(t: TestContext, model: PeettyModelOptions | undefined, options: {
  chat?: PeettyChatOptions;
  onReply?: (text: string) => void;
  onState?: (busy: boolean, speaking: boolean) => void;
  rejectHTML?: boolean;
} = {}) {
  const window = new Window({ url: 'https://host.example/' });
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
    for (const start of [window.HTMLElement.prototype, window.SVGElement.prototype]) {
      let prototype: object | null = start;
      while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'innerHTML')?.set) prototype = Object.getPrototypeOf(prototype) as object | null;
      assert.ok(prototype, 'the DOM fixture exposes the HTML setter');
      if (patched.has(prototype)) continue;
      patched.add(prototype);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML')!;
      const target = prototype;
      Object.defineProperty(target, 'innerHTML', { ...descriptor, set() { htmlWrites++; throw new TypeError('TrustedHTML required.'); } });
      restoreSinks.push(() => Object.defineProperty(target, 'innerHTML', descriptor));
    }
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  panel = await createChatPanel({
    root, language: 'en', ...(model ? { model } : {}), chat: options.chat ?? { persist: false },
    onAction() {}, onReply: options.onReply ?? (() => {}), onState: options.onState ?? (() => {}), onClose() {},
  });
  panel.open(true);
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { panel, root, window, query, htmlWrites: () => htmlWrites };
}

describe('chat panel credential ownership', () => {
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
      await flush();
      assert.equal(query('.pc-setup').hidden, true);
      const saved = storage.databases.get('injected-consent:chat')?.get('connection') as PeettyModelOptions;
      assert.equal(saved.id, 'another-model');
      assert.equal(saved.apiKey, consent ? injected.apiKey : undefined);
      panel.open(true);
      assert.equal(remember.checked, consent);
      await panel.setModel({ ...injected, id: 'sdk-replacement', apiKey: 'fixture-replacement-key' });
      panel.open(true);
      assert.equal(remember.checked, false, 'a new SDK connection needs fresh consent');
      assert.deepEqual(storage.databases.get('injected-consent:chat')?.get('connection'), saved);
    });
  }

  for (const loaded of [false, true]) {
    it(`preserves the saved endpoint and key when the SDK injects a model ${loaded ? 'after' : 'before'} loading chat`, async (t) => {
      const storage = installChatIndexedDB(t);
      const saved = { id: 'saved-model', baseUrl: 'https://saved.example/v1', apiKey: 'fixture-saved-key' };
      const seed = new BrowserChatStore('saved-connection');
      await seed.saveConnection(saved);
      seed.close();
      const saves = t.mock.method(BrowserChatStore.prototype, 'saveConnection');
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
      assert.deepEqual(storage.databases.get('saved-connection:chat')?.get('connection'), saved);
      panel.destroy();
      const restored = new ChatRuntime({ chat: { storageKey: 'saved-connection', persist: true } });
      t.after(() => restored.destroy());
      await restored.initialize();
      assert.deepEqual(restored.model, saved);
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

  it('contains keydown, keypress and keyup without disabling ordinary host shortcuts', async (t) => {
    const { panel, query, window } = await mountPanel(t, MODEL);
    const hostEvents: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      window.document.addEventListener(type, () => hostEvents.push(type));
      window.addEventListener(type, () => hostEvents.push(type));
    }
    const dispatch = (target: HTMLElement) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const event = new window.KeyboardEvent(type, { key: 'j', code: 'KeyJ', bubbles: true, composed: true, cancelable: true });
        target.dispatchEvent(event as unknown as Event);
        assert.equal(event.defaultPrevented, false, 'ordinary editing keeps its default behavior');
      }
    };
    dispatch(query<HTMLInputElement>('[name="url"]'));
    dispatch(query<HTMLInputElement>('[name="key"]'));
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
      const saves = t.mock.method(BrowserChatStore.prototype, 'saveConnection');
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
      await flush();
      assert.equal(query('.pc-setup').hidden, true);
      assert.equal(saves.mock.callCount(), 1);
      assert.equal(query('.pc-storage').hidden, available);
      const savedConnection = () => storage?.databases.get('language-session:chat')?.get('connection') as { apiKey?: string } | undefined;
      if (available) { assert.ok(savedConnection()); assert.equal(savedConnection()?.apiKey, undefined); }
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
      if (available) assert.equal(savedConnection()?.apiKey, undefined);
    });
  }
});

describe('chat panel turn ownership', () => {
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
    const peer = new BrowserChatStore('shared-panel');
    t.after(() => peer.close());
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
    const peer = new ChatRuntime({ model: MODEL, chat: { storageKey: 'shared-order', persist: true } });
    t.after(() => peer.destroy());
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
