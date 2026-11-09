import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { ChatRuntime, fetchModelList, normalizeBaseUrl } from '../src/chat/runtime.ts';
import { boundedEntries, BrowserChatStore } from '../src/chat/store.ts';
import type { ChatEntry, CompanionAction, PeettyModelOptions } from '../src/chat/types.ts';
import { installChatIndexedDB, MemoryChatStorage } from './helpers/chat-storage.ts';

const MODEL: PeettyModelOptions = { id: 'manual-model', baseUrl: 'https://model.example/v1', apiKey: 'secret-user-key' };
const entry = (role: ChatEntry['role'], text: string, n = 0): ChatEntry => ({ id: `entry-${n}`, role, text, createdAt: n });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'expected asynchronous state was reached');
}
function assistant(text = '', stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'openai-completions', provider: 'peetty', model: MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(), stopReason,
  };
}
function finished(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
  else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
  stream.end();
  return stream;
}
function toolCall(actions: string[]): AssistantMessage {
  const message = assistant('', 'toolUse');
  message.content = actions.map((action, i) => ({ type: 'toolCall', id: `call-${i}`, name: 'companion_action', arguments: { action } }));
  return message;
}
function messageText(message: Message): string {
  return 'content' in message && typeof message.content === 'string' ? message.content : JSON.stringify(message);
}
function heldProvider() {
  const calls: { stream: AssistantMessageEventStream; context: TranscriptContext; options: SimpleStreamOptions | undefined }[] = [];
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'start', partial: assistant('', 'pending') });
    calls.push({ stream, context: structuredClone(context), options });
    return stream;
  };
  const partial = (index: number, text: string) => {
    const message = assistant(text, 'pending');
    calls[index]!.stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
  };
  const end = (index: number, text: string, reason: 'stop' | 'error' | 'aborted' = 'stop') => {
    const message = assistant(text, reason);
    if (reason === 'stop') calls[index]!.stream.push({ type: 'done', reason, message });
    else calls[index]!.stream.push({ type: 'error', reason, error: message });
    calls[index]!.stream.end();
  };
  return { calls, streamFn, partial, end };
}

describe('OpenAI-compatible endpoint setup', () => {
  it('normalizes API roots, preserves custom paths, and rejects URLs carrying credentials', () => {
    assert.equal(normalizeBaseUrl(' https://model.example/// '), 'https://model.example');
    assert.equal(normalizeBaseUrl('https://model.example/chat/completions'), 'https://model.example');
    assert.equal(normalizeBaseUrl('https://model.example/models/'), 'https://model.example');
    assert.equal(normalizeBaseUrl('https://model.example/v1/'), 'https://model.example/v1');
    assert.equal(normalizeBaseUrl('http://localhost:8080/api/v2/chat/completions/'), 'http://localhost:8080/api/v2');
    assert.equal(normalizeBaseUrl('https://model.example/v1/models'), 'https://model.example/v1');
    for (const url of ['file:///tmp/api', 'ftp://model.example', 'https://user:secret@model.example', 'https://model.example?key=secret', 'https://model.example/#secret', 'invalid']) {
      assert.throws(() => normalizeBaseUrl(url), (error: Error) => !error.message.includes('secret'));
    }
  });

  it('fetches model IDs explicitly, authenticates, filters, sorts, and deduplicates', async (t) => {
    const requests: [string, RequestInit | undefined][] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
      requests.push([url, options]);
      return Response.json({ data: [{ id: 'z' }, { id: 'a', name: 'Alpha' }, { id: 'z' }, {}, { id: 4 }, { id: '  ' }] });
    });
    assert.deepEqual(await fetchModelList('https://model.example/v1/chat/completions', ' setup-key '), [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'z' }]);
    assert.equal(requests[0]![0], 'https://model.example/v1/models');
    assert.equal(new Headers(requests[0]![1]?.headers).get('Authorization'), 'Bearer setup-key');
    assert.equal(requests[0]![1]?.credentials, 'omit');
    assert.equal(requests[0]![1]?.referrerPolicy, 'no-referrer');
    assert.equal(requests[0]![1]?.redirect, 'error');
    await fetchModelList('https://model.example/v1');
    assert.equal(new Headers(requests[1]![1]?.headers).get('Authorization'), null);
  });

  it('discovers models at the configured root without inserting a version prefix', async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return Response.json({ data: [{ id: 'root-model' }] }); });
    for (const base of ['https://root.example', 'https://root.example/', 'https://root.example/chat/completions', 'https://root.example/models']) {
      assert.deepEqual(await fetchModelList(base), [{ id: 'root-model', name: 'root-model' }]);
    }
    assert.deepEqual(urls, Array(4).fill('https://root.example/models'));
  });

  it('supports empty lists and hides server/network messages, including secrets', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    assert.deepEqual(await fetchModelList(MODEL.baseUrl), []);
    fetch.mock.mockImplementation(async () => Response.json({ error: 'secret-user-key' }, { status: 401 }));
    await assert.rejects(fetchModelList(MODEL.baseUrl, MODEL.apiKey), /rejected access/);
    fetch.mock.mockImplementation(async () => { throw new Error('secret-user-key inside request'); });
    await assert.rejects(fetchModelList(MODEL.baseUrl, MODEL.apiKey), (error: Error) => error.message.includes('Could not load models') && !error.message.includes('secret-user-key'));
    fetch.mock.mockImplementation(async () => Response.json({ error: 'invalid list secret-user-key' }));
    await assert.rejects(fetchModelList(MODEL.baseUrl), /model ID manually/);
  });

  it('aborts discovery promptly even if fetch ignores its signal', async (t) => {
    const gate = deferred<Response>();
    let requested = false;
    t.mock.method(globalThis, 'fetch', () => { requested = true; return gate.promise; });
    const controller = new AbortController();
    const request = fetchModelList(MODEL.baseUrl, MODEL.apiKey, controller.signal);
    assert.ok(requested);
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    gate.resolve(Response.json({ data: [{ id: 'late' }] }));
    await assert.rejects(fetchModelList(MODEL.baseUrl, undefined, controller.signal), { name: 'AbortError' });
  });
});

describe('local persistence and credential ownership', () => {
  it('stores connection and plain history in a namespaced IndexedDB and restores it', async (t) => {
    const idb = installChatIndexedDB(t);
    const first = new BrowserChatStore('test-pet');
    assert.deepEqual(await first.load(), { entries: [] });
    await first.saveConnection({ id: MODEL.id, baseUrl: MODEL.baseUrl, apiKey: MODEL.apiKey! });
    await first.saveEntries([entry('user', 'hello'), entry('assistant', 'hi', 1), entry('action', 'wave', 2)]);
    first.close();
    const second = new BrowserChatStore('test-pet');
    assert.deepEqual(await second.load(), {
      connection: { id: MODEL.id, baseUrl: MODEL.baseUrl, apiKey: MODEL.apiKey },
      entries: [entry('user', 'hello'), entry('assistant', 'hi', 1), entry('action', 'wave', 2)],
    });
    assert.deepEqual(idb.opened, ['test-pet:chat', 'test-pet:chat']);
    assert.equal(second.persistenceWarning, false);
    const other = new BrowserChatStore('other-pet');
    assert.deepEqual(await other.load(), { entries: [] });
    second.close(); other.close();
  });

  it('persists explicit tool preferences, restores them, and keeps SDK replacements ephemeral', async (t) => {
    installChatIndexedDB(t);
    for (const tools of [false, true]) {
      const namespace = `tools-${tools}`;
      const runtime = new ChatRuntime({ _testing: { storage: new BrowserChatStore(namespace) } });
      await runtime.configure({ ...MODEL, tools }, false);
      runtime.destroy();
      const restored = new ChatRuntime({ _testing: { storage: new BrowserChatStore(namespace) } });
      await restored.initialize();
      assert.deepEqual(restored.model, { id: MODEL.id, baseUrl: MODEL.baseUrl, tools });
      await restored.setModel({ ...MODEL, tools: !tools });
      assert.equal(restored.model?.tools, !tools);
      restored.destroy();
      const saved = new BrowserChatStore(namespace);
      assert.deepEqual((await saved.load()).connection, { id: MODEL.id, baseUrl: MODEL.baseUrl, tools });
      saved.close();
    }
  });

  it('rejects malformed restored tool flags rather than enabling tools through coercion', async () => {
    const runtime = new ChatRuntime({ _testing: { storage: new MemoryChatStorage({ connection: { ...MODEL, tools: 'false' as unknown as boolean }, entries: [] }) } });
    await runtime.initialize();
    assert.equal(runtime.model, undefined);
    runtime.destroy();
  });

  it('flushes already queued history before closing IndexedDB', async (t) => {
    installChatIndexedDB(t);
    const store = new BrowserChatStore('closing');
    await store.load();
    const writing = store.saveEntries([entry('assistant', 'partial answer')]);
    store.close();
    await writing;
    const restored = new BrowserChatStore('closing');
    assert.deepEqual((await restored.load()).entries, [entry('assistant', 'partial answer')]);
    restored.close();
  });

  it('falls back to memory when IndexedDB is absent or a write fails', async (t) => {
    const idb = installChatIndexedDB(t);
    const store = new BrowserChatStore('failure');
    await store.load();
    idb.failWrites();
    await store.saveEntries([entry('user', 'kept in memory')]);
    assert.equal(store.persistenceWarning, true);
    assert.deepEqual((await store.load()).entries, [entry('user', 'kept in memory')]);
    store.close();
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    const unavailable = new BrowserChatStore();
    await unavailable.load();
    await unavailable.saveEntries([entry('assistant', 'still works')]);
    assert.equal(unavailable.persistenceWarning, true);
    assert.deepEqual((await unavailable.load()).entries, [entry('assistant', 'still works')]);
    unavailable.close();
    const disabled = new BrowserChatStore('off', false);
    await disabled.load();
    assert.equal(disabled.persistenceWarning, false);
    disabled.close();
  });

  it('validates and bounds restored history', () => {
    const history = boundedEntries([
      null, {}, entry('action', 'not-an-action'), entry('assistant', ''),
      ...Array.from({ length: 250 }, (_, i) => entry('user', 'x'.repeat(2_000), i)),
    ]);
    assert.equal(history.length, 120);
    assert.equal(history[0]!.id, 'entry-130');
    assert.equal(history.at(-1)!.id, 'entry-249');
    assert.ok(boundedEntries([entry('assistant', 'x'.repeat(100_000))])[0]!.text.length <= 16_000);
  });

  it('initializes without fetch or credential resolution and lets injected options fully override stored auth', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    let resolutions = 0;
    const store = new MemoryChatStorage({ connection: { ...MODEL }, entries: [entry('user', 'old hello')] });
    const runtime = new ChatRuntime({
      model: { id: 'injected', baseUrl: 'https://new.example/v1', getApiKey: async () => { resolutions++; return 'ephemeral'; } },
      _testing: { storage: store, streamFn: () => finished(assistant('hello')) },
    });
    await runtime.initialize();
    assert.equal(resolutions, 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(runtime.model?.id, 'injected');
    assert.equal(runtime.model?.apiKey, undefined);
    assert.equal(runtime.entries[0]?.text, 'old hello');
    await runtime.send('new hello');
    assert.equal(resolutions, 1);
    assert.equal(store.connections.length, 0);
    assert.ok(!JSON.stringify(store.histories).includes('ephemeral'));
    runtime.destroy();
  });

  it('only remembers explicitly configured static keys, drops old keys on endpoint changes, and excludes SDK headers', async () => {
    const store = new MemoryChatStorage({ connection: { ...MODEL }, entries: [] });
    const seen: { baseUrl: string; apiKey: string | undefined }[] = [];
    const runtime = new ChatRuntime({ _testing: { storage: store, streamFn: (model, _context, options) => {
      seen.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
      return finished(assistant('ok'));
    } } });
    await runtime.initialize();
    assert.equal(runtime.model?.apiKey, MODEL.apiKey);
    await runtime.configure({ ...MODEL, headers: { Authorization: 'Bearer private-header' } }, true);
    assert.equal(store.state.connection?.apiKey, MODEL.apiKey);
    assert.ok(!JSON.stringify(store.connections).includes('private-header'));
    await runtime.configure({ id: 'local', baseUrl: 'http://localhost:8080/v1' }, false);
    await runtime.send('hi');
    assert.deepEqual(seen, [{ baseUrl: 'http://localhost:8080/v1', apiKey: 'peetty-keyless' }]);
    assert.equal(store.state.connection?.apiKey, undefined);
    await runtime.configure({ ...MODEL, getApiKey: () => 'callback-secret' }, true);
    assert.equal(store.state.connection?.apiKey, undefined);
    runtime.destroy();
  });

  for (const initializing of [false, true]) {
    it(`keeps SDK model replacements ephemeral ${initializing ? 'during initialization' : 'after initialization'}`, async () => {
      const storage = new MemoryChatStorage({ connection: { ...MODEL }, entries: [] });
      const loaded = deferred<{ connection: PeettyModelOptions; entries: ChatEntry[] }>();
      if (initializing) storage.load = () => loaded.promise;
      const seen: { baseUrl: string; apiKey: string | undefined }[] = [];
      const runtime = new ChatRuntime({ _testing: { storage, streamFn: (model, _context, options) => {
        seen.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
        return finished(assistant('ok'));
      } } });
      if (!initializing) await runtime.initialize();
      const injected = { id: 'session-model', baseUrl: 'https://session.example/v1', apiKey: 'fixture-session-key' };
      const changing = runtime.setModel(injected);
      loaded.resolve({ connection: { ...MODEL }, entries: [] });
      await changing;
      assert.deepEqual(runtime.model, injected);
      assert.deepEqual(storage.state.connection, MODEL);
      assert.equal(storage.connections.length, 0);
      await runtime.send('hello');
      assert.deepEqual(seen, [{ baseUrl: injected.baseUrl, apiKey: injected.apiKey }]);
      assert.deepEqual(storage.state.connection, MODEL);
      assert.equal(storage.connections.length, 0);
      runtime.destroy();
    });
  }

  it('rejects invalid replacements without silently changing the active or saved model', async () => {
    const storage = new MemoryChatStorage();
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage } });
    await runtime.initialize();
    for (const replacement of [
      { ...MODEL, id: '' },
      { ...MODEL, id: 'x'.repeat(201) },
      { ...MODEL, baseUrl: 'https://user:private-secret@new.example/' },
      { ...MODEL, baseUrl: 'file:///private-secret' },
      { ...MODEL, headers: { Authorization: 123 } as unknown as Record<string, string> },
      { ...MODEL, headers: { 'x-api-key': null } as unknown as Record<string, string> },
      { ...MODEL, headers: { 'bad header': 'private-secret' } },
      { ...MODEL, headers: { Authorization: 'Bearer private-secret\r\nX-Injected: true' } },
    ]) {
      await assert.rejects(runtime.configure(replacement, true), (error: Error) => {
        assert.match(error.message, /valid API base URL and model ID/);
        assert.ok(!error.message.includes('private-secret'));
        return true;
      });
      assert.deepEqual(runtime.model, MODEL);
      assert.equal(storage.connections.length, 0);
    }
    await runtime.configure({ id: 'root-model', baseUrl: 'https://root.example/' }, false);
    assert.equal(runtime.error, null);
    assert.equal(runtime.model?.baseUrl, 'https://root.example');
    assert.equal(storage.state.connection?.baseUrl, 'https://root.example');
    runtime.destroy();
  });

  it('disables storage writes entirely with persist:false and surfaces graceful storage failures', async () => {
    const store = new MemoryChatStorage();
    const runtime = new ChatRuntime({ chat: { persist: false }, _testing: { storage: store, streamFn: () => finished(assistant('hi')) } });
    await runtime.configure(MODEL, true);
    await runtime.send('hello');
    assert.equal(store.connections.length, 0);
    assert.equal(store.histories.length, 0);
    runtime.destroy();
    const failed = new MemoryChatStorage();
    failed.load = async () => { throw new Error('IndexedDB denied'); };
    failed.saveEntries = async () => { throw new Error('quota'); };
    const fallback = new ChatRuntime({ model: MODEL, _testing: { storage: failed, streamFn: () => finished(assistant('still works')) } });
    await fallback.send('hi');
    assert.equal(fallback.persistenceWarning, true);
    assert.equal(fallback.entries.at(-1)?.text, 'still works');
    fallback.destroy();
  });
});

describe('Pi chat streaming and actions', () => {
  it('streams partial text, signals transitions, rejects overlapping sends, and retains partial text on provider error', async () => {
    const provider = heldProvider();
    const updates: { busy: boolean; last: string | undefined }[] = [];
    const runtime = new ChatRuntime({ model: MODEL, onChange: () => updates.push({ busy: runtime.busy, last: runtime.entries.at(-1)?.text }), _testing: { storage: new MemoryChatStorage(), streamFn: provider.streamFn } });
    const request = runtime.send('hello');
    assert.equal(runtime.busy, true);
    await runtime.send('ignored');
    await until(() => provider.calls.length === 1);
    provider.partial(0, 'A partial answer');
    await until(() => runtime.entries.at(-1)?.text === 'A partial answer');
    const error = assistant('', 'error');
    error.errorMessage = `provider echoed ${MODEL.apiKey}`;
    provider.calls[0]!.stream.push({ type: 'error', reason: 'error', error });
    await request;
    assert.deepEqual(runtime.entries.map((entry) => entry.text), ['hello', 'A partial answer']);
    assert.equal(runtime.busy, false);
    assert.match(runtime.error!, /Could not get a response/);
    assert.ok(!runtime.error!.includes(MODEL.apiKey!));
    assert.ok(updates.some((update) => update.busy && update.last === 'A partial answer'));
    assert.equal(updates.at(-1)?.busy, false);
    runtime.destroy();
  });

  it('executes all six actions through the real agent tool loop and keeps tool transcripts out of persisted history', async () => {
    const actions: CompanionAction[] = [];
    const calls: TranscriptContext[] = [];
    const storage = new MemoryChatStorage();
    let turns = 0;
    const runtime = new ChatRuntime({ model: MODEL, onAction: (action) => { actions.push(action); return `Performed ${action}`; }, _testing: { storage, streamFn: (_model, context) => {
      calls.push(structuredClone(context));
      turns++;
      return finished(turns % 2 ? toolCall(['wave', 'sit', 'lie']) : assistant('Happy to help.'));
    } } });
    await runtime.send('Please wave, sit and lie down.');
    turns = 0;
    const second = new ChatRuntime({ model: MODEL, onAction: (action) => { actions.push(action); }, _testing: { storage, streamFn: (_model, context) => {
      calls.push(structuredClone(context));
      return finished(++turns === 1 ? toolCall(['sleep', 'move', 'idle']) : assistant('Done.'));
    } } });
    await second.send('Now the other actions.');
    assert.deepEqual(actions, ['wave', 'sit', 'lie', 'sleep', 'move', 'idle']);
    assert.deepEqual(runtime.entries.filter((entry) => entry.role === 'action').map((entry) => entry.text), ['wave', 'sit', 'lie']);
    assert.ok(calls[1]!.messages.some((message) => message.role === 'toolResult'));
    assert.ok(!calls[2]!.messages.some((message) => message.role === 'toolResult'));
    assert.ok(!JSON.stringify(storage.histories).includes('toolCall'));
    assert.ok(calls[0]!.messages.some((message) => message.role === 'system' && message.toolsAdded?.some((tool) => tool.name === 'companion_action')));
    assert.equal(runtime.error, null);
    runtime.destroy(); second.destroy();
  });

  it('awaits each physical action before starting the next tool or recording success', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: CompanionAction[] = [];
    let turns = 0;
    const runtime = new ChatRuntime({
      model: MODEL,
      onAction: (action) => { started.push(action); return gates[started.length - 1]!.promise; },
      _testing: { storage: new MemoryChatStorage(), streamFn: () => finished(++turns === 1 ? toolCall(['wave', 'sit', 'lie']) : assistant('All done.')) },
    });
    const sending = runtime.send('Wave, then sit, then lie down.');
    await until(() => started.length === 1);
    assert.deepEqual(started, ['wave']);
    assert.equal(runtime.entries.some((entry) => entry.role === 'action'), false);
    gates[0]!.resolve('Wave finished.');
    await until(() => started.length === 2);
    assert.deepEqual(started, ['wave', 'sit']);
    assert.deepEqual(runtime.entries.filter((entry) => entry.role === 'action').map((entry) => entry.text), ['wave']);
    gates[1]!.resolve('Sitting finished.');
    await until(() => started.length === 3);
    assert.deepEqual(started, ['wave', 'sit', 'lie']);
    gates[2]!.resolve('Lying finished.');
    await sending;
    assert.deepEqual(runtime.entries.filter((entry) => entry.role === 'action').map((entry) => entry.text), ['wave', 'sit', 'lie']);
    runtime.destroy();
  });

  it('aborts an unfinished action without running queued actions or reporting success', async () => {
    const gate = deferred<string>();
    const started: CompanionAction[] = [];
    let signal: AbortSignal | undefined;
    const runtime = new ChatRuntime({
      model: MODEL,
      onAction: (action, currentSignal) => { started.push(action); signal = currentSignal; return gate.promise; },
      _testing: { storage: new MemoryChatStorage(), streamFn: () => finished(toolCall(['wave', 'sit'])) },
    });
    const sending = runtime.send('Wave then sit.');
    await until(() => started.length === 1);
    assert.deepEqual(started, ['wave']);
    runtime.stop();
    await sending;
    assert.equal(signal?.aborted, true);
    gate.resolve('Too late.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['wave']);
    assert.equal(runtime.entries.some((entry) => entry.role === 'action'), false);
    runtime.destroy();
  });

  it('sends bounded recent user/assistant context and personality, without page or action entries', async () => {
    const history = Array.from({ length: 100 }, (_, i) => entry(i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(2_000)}`, i));
    history.push(entry('action', 'wave', 101));
    const storage = new MemoryChatStorage({ entries: history });
    let context!: TranscriptContext;
    const runtime = new ChatRuntime({ model: MODEL, chat: { name: 'Mira', personality: 'Speak like a cheerful librarian.' }, _testing: { storage, streamFn: (_model, value) => { context = value; return finished(assistant('Welcome.')); } } });
    await runtime.send('latest question');
    const conversational = context.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    assert.ok(conversational.length <= 24);
    assert.ok(conversational.map(messageText).join('').length < 27_000);
    assert.match(messageText(context.messages[0]!), /Mira.*cheerful librarian/);
    assert.ok(!JSON.stringify(context).includes('message 0 '));
    assert.match(JSON.stringify(context), /message 99 /);
    assert.equal(conversational[0]?.role, 'user');
    assert.equal(conversational.at(-1)?.role, 'user');
    assert.equal(conversational.filter((message) => messageText(message).includes('latest question')).length, 1);
    assert.ok(!conversational.some((message) => messageText(message) === 'wave'));
    runtime.destroy();
  });

  it('bounds repeated provider requests, actions in one batch, and invalid tools', async () => {
    let requests = 0;
    let actions = 0;
    const runtime = new ChatRuntime({ model: MODEL, onAction: () => { actions++; }, _testing: { storage: new MemoryChatStorage(), streamFn: () => { requests++; return finished(toolCall(['wave'])); } } });
    await runtime.send('Keep waving.');
    assert.equal(requests, 4);
    assert.equal(actions, 4);
    assert.match(runtime.error!, /Action limit/);
    runtime.destroy();
    requests = 0; actions = 0;
    const batch = new ChatRuntime({ model: MODEL, onAction: () => { actions++; }, _testing: { storage: new MemoryChatStorage(), streamFn: () => { requests++; return finished(toolCall(Array.from({ length: 20 }, () => 'wave'))); } } });
    await batch.send('Wave lots.');
    assert.equal(actions, 6);
    assert.equal(requests, 1);
    batch.destroy();
    requests = 0;
    const invalid = new ChatRuntime({ model: MODEL, onAction: () => { throw new Error('must not execute'); }, _testing: { storage: new MemoryChatStorage(), streamFn: () => { requests++; return finished(toolCall(['arbitrary-script'])); } } });
    await invalid.send('Do something.');
    assert.equal(requests, 4);
    assert.equal(invalid.entries.filter((entry) => entry.role === 'action').length, 0);
    invalid.destroy();
  });

  it('redacts known credentials from entries, model context, persisted history, and action feedback', async () => {
    const storage = new MemoryChatStorage();
    const contexts: TranscriptContext[] = [];
    const runtime = new ChatRuntime({ model: MODEL, onAction: () => `Result ${MODEL.apiKey}`, _testing: { storage, streamFn: (_model, context) => {
      contexts.push(structuredClone(context));
      return finished(contexts.length === 1 ? toolCall(['wave']) : assistant(`Hello ${MODEL.apiKey}`));
    } } });
    await runtime.send(`My key is ${MODEL.apiKey}`);
    for (const value of [runtime.entries, contexts, storage.histories]) assert.ok(!JSON.stringify(value).includes(MODEL.apiKey!));
    assert.match(runtime.entries.at(-1)!.text, /\[redacted\]/);
    runtime.destroy();
  });

  it('overrides referrer and redirect policies on preconstructed provider Requests', async (t) => {
    const requests: Request[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response('fixture');
    });
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage: new MemoryChatStorage(), streamFn: async (_model, _context, options) => {
      const request = new Request(`${MODEL.baseUrl}/chat/completions`, {
        method: 'POST', body: '{}', referrer: 'https://host.example/private/page?secret=value', referrerPolicy: 'unsafe-url', redirect: 'follow',
      });
      await options!.fetch!(request, { referrerPolicy: 'unsafe-url', redirect: 'follow' });
      return finished(assistant('Transport succeeded'));
    } } });
    await runtime.send('Test transport');
    assert.equal(runtime.error, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.referrerPolicy, 'no-referrer');
    assert.equal(requests[0]!.redirect, 'error');
    runtime.destroy();
  });

  it('chats through the actual adapter with tools disabled and omits unsupported tool fields', async (t) => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.referrerPolicy, 'no-referrer');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      requests.push(body);
      if ('tools' in body || 'tool_choice' in body) return Response.json({ error: 'Tools unsupported' }, { status: 400 });
      const chunk = { id: 'text-only', object: 'chat.completion.chunk', created: 1, model: MODEL.id, choices: [{ index: 0, delta: { content: 'Text-only reply' }, finish_reason: null }] };
      const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const runtime = new ChatRuntime({ model: { ...MODEL, tools: false }, _testing: { storage: new MemoryChatStorage() } });
    await runtime.send('Hello text-only model');
    assert.equal(runtime.error, null);
    assert.equal(runtime.entries.at(-1)?.text, 'Text-only reply');
    assert.equal(requests.length, 1);
    assert.equal('tools' in requests[0]!, false);
    assert.equal('tool_choice' in requests[0]!, false);
    const system = (requests[0]!.messages as { role: string; content: string }[]).find((message) => message.role === 'system');
    assert.ok(system);
    assert.doesNotMatch(system.content, /companion_action|tool confirms|You may wave/);
    runtime.destroy();
  });

  it('uses the actual lazy OpenAI adapter with explicit auth, no retries, and no keyless Authorization', async (t) => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) as Record<string, unknown> });
      const chunk = { id: 'response', object: 'chat.completion.chunk', created: 1, model: 'manual-model', choices: [{ index: 0, delta: { content: 'Real adapter response' }, finish_reason: null }] };
      const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage: new MemoryChatStorage() } });
    await runtime.send('Hello actual adapter');
    assert.equal(runtime.error, null);
    assert.equal(runtime.entries.at(-1)?.text, 'Real adapter response');
    assert.equal(requests[0]?.url, 'https://model.example/v1/chat/completions');
    assert.equal(requests[0]?.headers.get('Authorization'), `Bearer ${MODEL.apiKey}`);
    assert.equal(requests[0]?.body.model, MODEL.id);
    assert.equal(requests[0]?.body.stream, true);
    assert.ok(Array.isArray(requests[0]?.body.tools));
    await runtime.configure({ id: 'local', baseUrl: 'http://localhost:8080/v1' }, false);
    await runtime.send('Keyless');
    assert.equal(runtime.error, null);
    assert.equal(requests[1]?.headers.get('Authorization'), null);
    await runtime.configure({ id: 'root-model', baseUrl: 'https://root.example/chat/completions', apiKey: 'root-key' }, false);
    await runtime.send('Root-level API');
    assert.equal(runtime.error, null);
    assert.equal(requests[2]?.url, 'https://root.example/chat/completions');
    assert.equal(requests[2]?.headers.get('Authorization'), 'Bearer root-key');
    runtime.destroy();
  });
});

describe('shared history runtime ownership', () => {
  it('keeps concurrent turns from independent module instances and refreshes context on the next turn', async (t) => {
    installChatIndexedDB(t);
    const [tabA, tabB] = await Promise.all([
      import(new URL('../src/chat/runtime.ts?tab=a', import.meta.url).href) as Promise<typeof import('../src/chat/runtime.ts')>,
      import(new URL('../src/chat/runtime.ts?tab=b', import.meta.url).href) as Promise<typeof import('../src/chat/runtime.ts')>,
    ]);
    t.mock.method(Date, 'now', () => 123_456);
    const a = heldProvider();
    const b = heldProvider();
    const first = new tabA.ChatRuntime({ model: MODEL, chat: { storageKey: 'tabs' }, _testing: { streamFn: a.streamFn } });
    const second = new tabB.ChatRuntime({ model: MODEL, chat: { storageKey: 'tabs' }, _testing: { streamFn: b.streamFn } });
    const reader = new BrowserChatStore('tabs');
    t.after(() => { first.destroy(); second.destroy(); reader.close(); });
    await Promise.all([first.initialize(), second.initialize()]);
    const sendingA = first.send('tab-a-question');
    const sendingB = second.send('tab-b-question');
    await until(() => a.calls.length === 1 && b.calls.length === 1);
    b.end(0, 'tab-b-answer');
    await sendingB;
    a.end(0, 'tab-a-answer');
    await sendingA;
    const expected = ['tab-b-question', 'tab-b-answer', 'tab-a-question', 'tab-a-answer'];
    const stored = (await reader.load()).entries;
    assert.deepEqual(stored.map((value) => value.text), expected);
    assert.equal(new Set(stored.map((value) => value.id)).size, 4, 'module counters and identical clocks cannot collide across tabs');
    const next = first.send('tab-a-next');
    await until(() => a.calls.length === 2);
    const context = a.calls[1]!.context.messages.filter((value) => value.role === 'user' || value.role === 'assistant').map(messageText);
    for (const text of [...expected, 'tab-a-next']) assert.equal(context.filter((value) => value.includes(text)).length, 1);
    a.partial(1, 'tab-a-partial');
    await until(() => first.entries.at(-1)?.text === 'tab-a-partial');
    first.stop();
    await next;
    a.end(1, 'ignored');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual((await reader.load()).entries.map((value) => value.text), [...expected, 'tab-a-next', 'tab-a-partial']);
  });

  for (const ending of ['complete', 'stop', 'destroy'] as const) {
    it(`rejects a peer's old turn on ${ending} after clear and accepts subsequent fresh turns`, async (t) => {
      installChatIndexedDB(t);
      const clearingStore = new BrowserChatStore(`runtime-clear-${ending}`);
      const peerStore = new BrowserChatStore(`runtime-clear-${ending}`);
      const reader = new BrowserChatStore(`runtime-clear-${ending}`);
      await clearingStore.saveEntries([entry('user', 'before-clear-question'), entry('assistant', 'before-clear-answer', 1)]);
      const a = heldProvider();
      const b = heldProvider();
      const first = new ChatRuntime({ model: MODEL, _testing: { storage: clearingStore, streamFn: a.streamFn } });
      const second = new ChatRuntime({ model: MODEL, _testing: { storage: peerStore, streamFn: b.streamFn } });
      t.after(() => { first.destroy(); second.destroy(); reader.close(); });
      await Promise.all([first.initialize(), second.initialize()]);
      const sending = second.send('before-clear-inflight');
      await until(() => b.calls.length === 1);
      b.partial(0, 'before-clear-partial');
      await until(() => second.entries.at(-1)?.text === 'before-clear-partial');
      await first.clear();
      if (ending === 'complete') b.end(0, 'before-clear-late');
      else {
        if (ending === 'stop') second.stop();
        else second.destroy();
        b.end(0, 'before-clear-late');
      }
      await sending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual((await reader.load()).entries, []);
      let peer = second;
      if (ending === 'destroy') {
        peer = new ChatRuntime({ model: MODEL, _testing: { storage: new BrowserChatStore(`runtime-clear-${ending}`), streamFn: b.streamFn } });
        t.after(() => peer.destroy());
      }
      const freshB = peer.send('fresh-b-question');
      await until(() => b.calls.length === 2);
      assert.ok(!JSON.stringify(b.calls[1]!.context).includes('before-clear'));
      b.end(1, 'fresh-b-answer');
      await freshB;
      assert.deepEqual((await reader.load()).entries.map((value) => value.text), ['fresh-b-question', 'fresh-b-answer']);
      const freshA = first.send('fresh-a-question');
      await until(() => a.calls.length === 1);
      assert.ok(!JSON.stringify(a.calls[0]!.context).includes('before-clear'));
      assert.match(JSON.stringify(a.calls[0]!.context), /fresh-b-answer/);
      a.end(0, 'fresh-a-answer');
      await freshA;
      const againB = peer.send('fresh-b-next');
      await until(() => b.calls.length === 3);
      assert.ok(!JSON.stringify(b.calls[2]!.context).includes('before-clear'));
      assert.match(JSON.stringify(b.calls[2]!.context), /fresh-a-answer/);
      b.end(2, 'fresh-b-next-answer');
      await againB;
      assert.deepEqual((await reader.load()).entries.map((value) => value.text), [
        'fresh-b-question', 'fresh-b-answer', 'fresh-a-question', 'fresh-a-answer', 'fresh-b-next', 'fresh-b-next-answer',
      ]);
    });
  }

  for (const cancellation of ['stop', 'configure', 'destroy'] as const) {
    it(`does not save the old UI snapshot on ${cancellation} during a history refresh`, async (t) => {
      installChatIndexedDB(t);
      const store = new BrowserChatStore(`refresh-${cancellation}`);
      const peer = new BrowserChatStore(`refresh-${cancellation}`);
      await store.saveEntries([entry('user', 'cleared-old-history')]);
      const contexts: TranscriptContext[] = [];
      const runtime = new ChatRuntime({ model: MODEL, _testing: { storage: store, streamFn: (_model, context) => {
        contexts.push(structuredClone(context));
        return finished(assistant('fresh-response'));
      } } });
      t.after(() => { runtime.destroy(); peer.close(); });
      await runtime.initialize();
      await peer.clearEntries();
      const gate = deferred<void>();
      const originalLoad = store.load.bind(store);
      let refreshing = false;
      let loads = 0;
      store.load = async () => {
        const state = await originalLoad();
        if (++loads === 1) { refreshing = true; await gate.promise; }
        return state;
      };
      const sending = runtime.send('canceled-before-input');
      await until(() => refreshing);
      if (cancellation === 'stop') runtime.stop();
      else if (cancellation === 'configure') await runtime.configure({ id: 'new-model', baseUrl: 'https://new.example' }, false);
      else runtime.destroy();
      await sending;
      assert.equal(contexts.length, 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual((await peer.load()).entries, []);
      if (cancellation !== 'destroy') {
        await runtime.send('new-owned-turn');
        assert.equal(contexts.length, 1);
        assert.ok(!JSON.stringify(contexts).includes('cleared-old-history'));
        assert.ok(!JSON.stringify(contexts).includes('canceled-before-input'));
      }
      gate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual((await peer.load()).entries.map((value) => value.text), cancellation === 'destroy' ? [] : ['new-owned-turn', 'fresh-response']);
      if (cancellation === 'configure') assert.equal(runtime.model?.id, 'new-model');
    });
  }

  it('queues an early clear before an immediate new turn and flushes clear on destruction', async (t) => {
    installChatIndexedDB(t);
    const store = new BrowserChatStore('early-clear');
    const reader = new BrowserChatStore('early-clear');
    await reader.saveEntries([entry('user', 'old-early-history')]);
    const contexts: TranscriptContext[] = [];
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage: store, streamFn: (_model, context) => {
      contexts.push(structuredClone(context));
      return finished(assistant('first-fresh-answer'));
    } } });
    t.after(() => { runtime.destroy(); reader.close(); });
    const initializing = runtime.initialize();
    const clearing = runtime.clear();
    const sending = runtime.send('first-fresh-input');
    await Promise.all([initializing, clearing, sending]);
    assert.ok(!JSON.stringify(contexts).includes('old-early-history'));
    assert.deepEqual((await reader.load()).entries.map((value) => value.text), ['first-fresh-input', 'first-fresh-answer']);
    const clearOnClose = runtime.clear();
    runtime.destroy();
    await clearOnClose;
    assert.deepEqual((await reader.load()).entries, []);
  });

  it('retains local context across turns with persistence disabled', async () => {
    const storage = new MemoryChatStorage();
    const contexts: TranscriptContext[] = [];
    const runtime = new ChatRuntime({ model: MODEL, chat: { persist: false }, _testing: { storage, streamFn: (_model, context) => {
      contexts.push(structuredClone(context));
      return finished(assistant('local-answer'));
    } } });
    await runtime.send('local-first');
    await runtime.send('local-next');
    assert.match(JSON.stringify(contexts[1]), /local-first/);
    assert.equal(storage.histories.length, 0);
    await runtime.clear();
    await runtime.send('local-after-clear');
    assert.ok(!JSON.stringify(contexts[2]).includes('local-first'));
    assert.equal(storage.histories.length, 0);
    runtime.destroy();
  });
});

describe('cancellation and stale session isolation', () => {
  it('stops while credentials resolve and never dispatches the late key to a changed endpoint', async () => {
    const credential = deferred<string>();
    let resolving = false;
    const seen: string[] = [];
    const runtime = new ChatRuntime({ model: { ...MODEL, getApiKey: () => { resolving = true; return credential.promise; } }, _testing: { storage: new MemoryChatStorage(), streamFn: (model) => { seen.push(model.baseUrl); return finished(assistant('new response')); } } });
    const old = runtime.send('old request');
    await until(() => resolving);
    await runtime.configure({ id: 'new-model', baseUrl: 'https://new.example/v1', apiKey: 'new-secret' }, false);
    await old;
    assert.equal(runtime.busy, false);
    await runtime.send('new request');
    credential.resolve('late-old-secret');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['https://new.example/v1']);
    assert.equal(runtime.error, null);
    assert.equal(runtime.entries.at(-1)?.text, 'new response');
    runtime.destroy();
  });

  it('preserves partial text on stop and ignores stale text/actions after a new send', async () => {
    const provider = heldProvider();
    let actions = 0;
    const runtime = new ChatRuntime({ model: MODEL, onAction: () => { actions++; }, _testing: { storage: new MemoryChatStorage(), streamFn: provider.streamFn } });
    const old = runtime.send('first');
    await until(() => provider.calls.length === 1);
    provider.partial(0, 'partial');
    await until(() => runtime.entries.at(-1)?.text === 'partial');
    runtime.stop();
    await old;
    assert.equal(provider.calls[0]?.options?.signal?.aborted, true);
    assert.equal(runtime.entries.at(-1)?.text, 'partial');
    const next = runtime.send('second');
    await until(() => provider.calls.length === 2);
    provider.calls[0]!.stream.push({ type: 'done', reason: 'toolUse', message: toolCall(['wave']) });
    provider.partial(0, 'stale text');
    provider.end(1, 'fresh answer');
    await next;
    assert.equal(actions, 0);
    assert.deepEqual(runtime.entries.map((entry) => entry.text), ['first', 'partial', 'second', 'fresh answer']);
    assert.equal(runtime.error, null);
    runtime.destroy();
  });

  it('clears during streaming without resurrecting history and strips empty assistant entries', async () => {
    const provider = heldProvider();
    const storage = new MemoryChatStorage();
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage, streamFn: provider.streamFn } });
    const request = runtime.send('hello');
    await until(() => provider.calls.length === 1);
    await runtime.clear();
    provider.end(0, 'late response');
    await request;
    assert.equal(runtime.entries.length, 0);
    assert.equal(storage.state.entries.length, 0);
    assert.equal(runtime.busy, false);
    assert.equal(runtime.error, null);
    const second = runtime.send('next');
    await until(() => provider.calls.length === 2);
    runtime.stop();
    provider.end(1, '', 'aborted');
    await second;
    assert.deepEqual(runtime.entries.map((entry) => entry.role), ['user']);
    runtime.destroy();
  });

  it('times out stuck providers and credential callbacks without rejected UI promises', async () => {
    const provider = heldProvider();
    const runtime = new ChatRuntime({ model: MODEL, _testing: { storage: new MemoryChatStorage(), streamFn: provider.streamFn, timeoutMs: 30 } });
    await runtime.send('hello');
    assert.equal(runtime.busy, false);
    assert.match(runtime.error!, /timed out/);
    if (provider.calls.length) provider.end(0, '', 'aborted');
    runtime.destroy();
    const credential = deferred<string>();
    const waiting = new ChatRuntime({ model: { ...MODEL, getApiKey: () => credential.promise }, _testing: { storage: new MemoryChatStorage(), timeoutMs: 10 } });
    await waiting.send('hello');
    assert.match(waiting.error!, /timed out/);
    credential.resolve('late secret');
    waiting.destroy();
  });

  it('handles credential failures and destruction without exposing credentials or late state changes', async () => {
    const storage = new MemoryChatStorage();
    const runtime = new ChatRuntime({ model: { ...MODEL, getApiKey: async () => { throw new Error(`could not get ${MODEL.apiKey}`); } }, _testing: { storage } });
    await runtime.send('hi');
    assert.match(runtime.error!, /Could not access your API key/);
    assert.ok(!runtime.error!.includes(MODEL.apiKey!));
    runtime.destroy();
    const provider = heldProvider();
    let updates = 0;
    const destroyed = new ChatRuntime({ model: MODEL, onChange: () => { updates++; }, _testing: { storage: new MemoryChatStorage(), streamFn: provider.streamFn } });
    const send = destroyed.send('hi');
    await until(() => provider.calls.length === 1);
    destroyed.destroy();
    const count = updates;
    provider.end(0, 'late');
    await send;
    await destroyed.send('ignored');
    await destroyed.configure(MODEL, true);
    assert.equal(updates, count);
    assert.equal(destroyed.busy, false);
    assert.ok(!destroyed.entries.some((entry) => entry.text === 'late'));
  });

  it('does not restore old history or connection over an early clear/configure', async () => {
    const load = deferred<{ connection: PeettyModelOptions; entries: ChatEntry[] }>();
    const storage = new MemoryChatStorage();
    storage.load = () => load.promise;
    const runtime = new ChatRuntime({ _testing: { storage } });
    const initialization = runtime.initialize();
    const clearing = runtime.clear();
    const configuring = runtime.configure({ id: 'chosen', baseUrl: 'https://chosen.example/v1' }, false);
    load.resolve({ connection: MODEL, entries: [entry('user', 'old')] });
    await Promise.all([initialization, clearing, configuring]);
    assert.deepEqual(runtime.entries, []);
    assert.equal(runtime.model?.id, 'chosen');
    assert.equal(runtime.model?.apiKey, undefined);
    runtime.destroy();
  });
});
