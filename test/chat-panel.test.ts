import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { createChatPanel, type ChatPanel } from '../src/chat/panel.ts';
import type { PeettyChatOptions, PeettyModelOptions } from '../src/chat/types.ts';
import { BrowserChatStore } from '../src/chat/store.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const MODEL = { id: 'model', baseUrl: 'https://models.example/v1' };

async function mountPanel(t: TestContext, model: PeettyModelOptions, options: {
  chat?: PeettyChatOptions;
  onReply?: (text: string) => void;
  onState?: (busy: boolean, speaking: boolean) => void;
} = {}) {
  const window = new Window({ url: 'https://host.example/' });
  const document = window.document as unknown as Document;
  const restore = stubGlobals({ window, document, location: window.location, HTMLElement: window.HTMLElement });
  let panel: ChatPanel | undefined;
  t.after(async () => {
    panel?.destroy();
    await window.happyDOM.abort();
    window.close();
    restore();
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  panel = await createChatPanel({
    root, language: 'en', model, chat: options.chat ?? { persist: false },
    onAction() {}, onReply: options.onReply ?? (() => {}), onState: options.onState ?? (() => {}), onClose() {},
  });
  panel.open(true);
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { panel, root, window, query };
}

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
