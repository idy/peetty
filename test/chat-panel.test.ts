import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { Window } from 'happy-dom';
import { createChatPanel, type ChatPanel } from '../src/chat/panel.ts';
import type { PeettyModelOptions } from '../src/chat/types.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const MODEL = { id: 'model', baseUrl: 'https://models.example/v1' };

async function mountPanel(t: TestContext, model: PeettyModelOptions) {
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
    root, language: 'en', model, chat: { persist: false },
    onAction() {}, onReply() {}, onState() {}, onClose() {},
  });
  panel.open(true);
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { panel, root, window, query };
}

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
