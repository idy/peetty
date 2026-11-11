import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { BrowserProfileStore, PROFILE_LIMITS } from '../src/chat/profiles.ts';
import type { MemoryEntry, ProfileRecord } from '../src/chat/profiles.ts';
import { ChatRuntime } from '../src/chat/runtime.ts';
import type { ChatRuntimeOptions } from '../src/chat/runtime.ts';
import { SecretRegistry } from '../src/chat/secrets.ts';
import type { StoredConnection, StoredSessionConnection } from '../src/chat/store.ts';
import { ChatStorageError } from '../src/chat/store.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB, LegacyV1ChatFixture, MemoryChatStorage } from './helpers/chat-storage.ts';
import { deferred } from './helpers/pet-dom.ts';

const MODEL: StoredConnection = {
  id: 'scripted-model', baseUrl: 'https://model.example/v1', apiKey: 'fixture-current-key', tools: false,
};
const entry = (id: string, text: string): ChatEntry => ({ id, role: 'user', text, createdAt: 1 });
const memory = (id: string, text: string): MemoryEntry => ({ id, text, createdAt: 1, updatedAt: 1, manual: true });

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'openai-completions', provider: 'peetty', model: MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 1, stopReason,
  };
}
function rememberFact(...texts: string[]): AssistantMessage {
  const message = assistant('', 'toolUse');
  message.content = texts.map((text, i) => ({ type: 'toolCall', id: `remember-scripted-${i}`, name: 'remember_fact', arguments: { text } }));
  return message;
}
function scripted(...steps: { message: AssistantMessage; partial?: string; before?: () => Promise<void> }[]) {
  const calls: { context: TranscriptContext; options: SimpleStreamOptions | undefined }[] = [];
  const streamFn: StreamFn = async (_model, context, options) => {
    const step = steps[calls.length];
    calls.push({ context: structuredClone(context), options });
    assert.ok(step, 'unexpected provider request');
    await step.before?.();
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'start', partial: assistant('', 'pending') });
    if (step.partial) stream.push({ type: 'text_delta', contentIndex: 0, delta: step.partial, partial: assistant(step.partial, 'pending') });
    const message = step.message;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
    else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end();
    return stream;
  };
  return { calls, streamFn };
}
function installRuntimeFixture(t: TestContext): void {
  installChatIndexedDB(t);
  const network = t.mock.method(globalThis, 'fetch', () => { assert.fail('scripted runtime tests must not access the network'); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
}
async function profileStore(t: TestContext, namespace: string): Promise<BrowserProfileStore> {
  const manager = new BrowserProfileStore(namespace);
  t.after(() => manager.close());
  await manager.initialize();
  return manager;
}
async function restoreProfile(manager: BrowserProfileStore, overrides: Partial<Pick<ProfileRecord, 'entries' | 'memories' | 'connection' | 'autoRemember'>>, session?: StoredSessionConnection): Promise<ProfileRecord> {
  const profile: ProfileRecord = {
    id: 'archive-profile', name: 'Restored companion', figure: 'miru', personality: '',
    useMemories: true, autoRemember: false, entries: [], memories: [], createdAt: 1, updatedAt: 1, ...overrides,
  };
  await manager.restore(JSON.stringify({
    format: 'peetty-backup', version: session ? 2 : 1, createdAt: 1, activeProfileId: profile.id, profiles: [profile],
    ...(session ? { sessions: [{ profileId: profile.id, ...session }] } : {}),
  }));
  return manager.activeProfile;
}
function createRuntime(t: TestContext, options: ChatRuntimeOptions): ChatRuntime {
  const runtime = new ChatRuntime(options);
  t.after(() => runtime.destroy());
  return runtime;
}

describe('runtime archive and credential regressions', () => {
  for (const ending of ['success', 'provider error'] as const) {
    it(`preserves restored archive text clipped by entry and total budgets after runtime.send ${ending}`, async (t) => {
      installRuntimeFixture(t);
      const namespace = `runtime-archive-${ending}`;
      const manager = await profileStore(t, namespace);
      const restored = await restoreProfile(manager, { connection: MODEL, entries: [
        entry('budget-only', 'B'.repeat(10_000)),
        entry('long-archive', 'L'.repeat(20_000)),
        ...Array.from({ length: 13 }, (_, i) => entry(`recent-${i}`, 'F'.repeat(16_000))),
        entry('recent-tail', 'T'.repeat(10_000)),
      ] });
      const error = assistant('', 'error');
      error.errorMessage = 'Scripted provider failure.';
      const reply = ending === 'success' ? 'Completed reply.' : 'Partial before failure.';
      const provider = scripted(ending === 'success'
        ? { message: assistant(reply) }
        : { message: error, partial: reply });
      const runtime = createRuntime(t, { storage: manager.storage(restored.id), _testing: { streamFn: provider.streamFn } });
      await runtime.initialize();
      // Both entries are present in the runtime view; the first is below the per-entry limit.
      assert.equal(runtime.entries.find((value) => value.id === restored.entries[0]!.id)!.text.length, 6_000);
      assert.equal(runtime.entries.find((value) => value.id === restored.entries[1]!.id)!.text.length, 16_000);
      await runtime.send('A new turn must not edit the archive.');
      assert.equal(provider.calls.length, 1);
      assert.equal(runtime.busy, false);
      if (ending === 'success') assert.equal(runtime.error, null);
      else assert.match(runtime.error!, /Could not get a response/);
      assert.equal(runtime.entries.at(-1)!.text, reply);
      const reopened = await profileStore(t, namespace);
      const archive = reopened.activeProfile.entries;
      assert.deepEqual(archive.slice(0, restored.entries.length), restored.entries);
      assert.deepEqual(archive.slice(-2).map((value) => value.text), ['A new turn must not edit the archive.', reply]);
      assert.equal(reopened.persistenceWarning, false);
    });
  }

  it('redacts stored Authorization and x-api-key tokens from history and enabled memory under an SDK override', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-stored-secrets');
    const apiKey = 'fixture-stored-api-key';
    const bearer = 'fixture-stored-bearer-token';
    const headerKey = 'fixture-stored-header-key';
    const secrets = `${apiKey} ${bearer} ${headerKey}`;
    const restored = await restoreProfile(manager, {
      connection: { ...MODEL, apiKey, headers: { Authorization: `Bearer ${bearer}`, 'x-api-key': headerKey } },
      entries: [entry('stored-history', `History echoes ${secrets}`)],
      memories: [memory('stored-memory', `Saved preference echoes ${secrets}`)],
    });
    const provider = scripted({ message: assistant(`Reply echoes ${secrets}`) });
    const sdk = { ...MODEL, id: 'sdk-override', baseUrl: 'https://sdk.example/v1', apiKey: 'fixture-sdk-key' };
    const runtime = createRuntime(t, {
      model: sdk, storage: manager.storage(restored.id),
      memory: { get entries() { return manager.memoryTexts(restored.id); }, get enabled() { return manager.memoryEnabled(restored.id); } },
      _testing: { streamFn: provider.streamFn },
    });
    await runtime.initialize();
    assert.equal(runtime.rememberKey, false);
    assert.deepEqual(runtime.sessionOverride, { model: sdk, rememberKey: false });
    assert.equal(runtime.model!.baseUrl, sdk.baseUrl);
    assert.equal(runtime.entries[0]!.text, 'History echoes [redacted] [redacted] [redacted]');
    await runtime.send(`User echoes ${secrets}`);
    assert.equal(runtime.error, null);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]!.options!.apiKey, sdk.apiKey);
    const context = JSON.stringify(provider.calls[0]!.context);
    assert.match(context, /History echoes/);
    assert.match(context, /Saved preference echoes/);
    for (const value of [apiKey, bearer, headerKey]) {
      assert.equal(context.includes(value), false);
      assert.equal(JSON.stringify(runtime.entries).includes(value), false);
    }
    assert.deepEqual(manager.activeProfile.entries.slice(-2).map((value) => value.text), [
      'User echoes [redacted] [redacted] [redacted]', 'Reply echoes [redacted] [redacted] [redacted]',
    ]);
  });

  it('redacts a whole memory credential before clipping the 6,000-character recall budget', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-memory-boundary');
    const id = manager.activeProfile.id;
    const key = 'boundary-fixture-secret-0123456789';
    await manager.saveMemory(id, { text: `${'m'.repeat(5_990)}${key} suffix outside recall` });
    const provider = scripted({ message: assistant('Recalled safely.') });
    const runtime = createRuntime(t, {
      model: { ...MODEL, apiKey: key }, storage: manager.storage(id),
      memory: { get entries() { return manager.memoryTexts(id); }, get enabled() { return manager.memoryEnabled(id); } },
      _testing: { streamFn: provider.streamFn },
    });
    await runtime.send('Recall my saved fact.');
    assert.equal(runtime.error, null);
    assert.equal(provider.calls.length, 1);
    const context = JSON.stringify(provider.calls[0]!.context);
    assert.ok(context.includes(`${'m'.repeat(5_990)}[redacted]`));
    assert.equal(context.includes(key.slice(0, 10)), false, 'a clipped credential prefix must not escape redaction');
    assert.equal(context.includes('suffix outside recall'), false);
  });

  it('removes restored authentication on opt-out while preserving non-authentication project routing in a fresh runtime', async (t) => {
    installRuntimeFixture(t);
    const namespace = 'runtime-restored-opt-out';
    const manager = await profileStore(t, namespace);
    const project = 'fixture-project-opt-out';
    const restored = await restoreProfile(manager, { entries: [entry('subscription-echo', 'Echo synthetic-subscription-secret')] }, { connection: {
      ...MODEL, apiKey: 'fixture-opt-out-api-key', headers: {
        Authorization: 'Bearer fixture-opt-out-bearer', 'x-api-key': 'fixture-opt-out-header-key',
        'Ocp-Apim-Subscription-Key': 'synthetic-subscription-secret', 'OpenAI-Project': project,
        'X-Auth': 'synthetic-x-auth', 'X-Access-Key': 'synthetic-access-key', 'Gateway-Pass': 'synthetic-unknown-secret',
      },
    }, rememberKey: true });
    const initial = createRuntime(t, { storage: manager.storage(restored.id) });
    await initial.initialize();
    assert.equal(initial.rememberKey, true);
    assert.equal(initial.sessionOverride, undefined, 'restored RAM sessions remain owned by the profile store');
    assert.ok(initial.model!.headers!.authorization);
    assert.equal(initial.entries[0]!.text, 'Echo [redacted]');
    const live = initial.model!;
    await initial.configure(live, false);
    assert.deepEqual(initial.sessionOverride, { model: live, rememberKey: false }, 'stripped authentication must remain usable for the current visit');
    assert.equal(initial.model!.headers!['gateway-pass'], 'synthetic-unknown-secret');
    initial.destroy();
    const reopened = await profileStore(t, namespace);
    assert.deepEqual(reopened.activeProfile.connection, { id: MODEL.id, baseUrl: MODEL.baseUrl, tools: false, headers: { 'openai-project': project } });
    const provider = scripted({ message: assistant('Project routing remains usable.') });
    const fresh = createRuntime(t, { storage: reopened.storage(restored.id), _testing: { streamFn: provider.streamFn } });
    await fresh.initialize();
    assert.equal(fresh.model!.apiKey, undefined);
    assert.deepEqual(fresh.model!.headers, { 'openai-project': project });
    await fresh.send('A keyless request with project routing.');
    assert.equal(fresh.error, null);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]!.options!.apiKey, 'peetty-keyless');
    assert.deepEqual(provider.calls[0]!.options!.headers, { 'openai-project': project, Authorization: null });
    assert.equal(fresh.reply!.text, 'Project routing remains usable.');
  });

  it('keeps a retained header subset through key rotation and trailing-slash normalization after reopening', async (t) => {
    installRuntimeFixture(t);
    const namespace = 'runtime-retained-header-rotation';
    const manager = await profileStore(t, namespace);
    const project = 'fixture-project-rotation';
    const restored = await restoreProfile(manager, { connection: {
      ...MODEL, apiKey: 'fixture-key-before-rotation', headers: {
        Authorization: 'Bearer fixture-auth-before-rotation', 'x-api-key': 'fixture-header-before-rotation',
        'OpenAI-Project': project, 'OpenAI-Organization': 'fixture-old-organization',
      },
    } });
    const initial = createRuntime(t, { storage: manager.storage(restored.id) });
    await initial.initialize();
    const rotated = 'fixture-key-after-rotation';
    await initial.configure({ ...initial.model!, baseUrl: `${MODEL.baseUrl}///`, apiKey: rotated, headers: { 'OpenAI-Project': project } }, true);
    initial.destroy();
    const reopened = await profileStore(t, namespace);
    const provider = scripted({ message: assistant('Rotated credentials work.') });
    const fresh = createRuntime(t, { storage: reopened.storage(restored.id), _testing: { streamFn: provider.streamFn } });
    await fresh.initialize();
    assert.equal(fresh.model!.baseUrl, MODEL.baseUrl);
    assert.equal(fresh.model!.apiKey, rotated);
    assert.deepEqual(fresh.model!.headers, { 'openai-project': project });
    await fresh.send('Use the rotated connection.');
    assert.equal(fresh.error, null);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]!.options!.apiKey, rotated);
    assert.deepEqual(provider.calls[0]!.options!.headers, { 'openai-project': project });
    assert.equal(fresh.reply!.text, 'Rotated credentials work.');
  });

  it('rejects a real remember_fact tool after a peer disables automatic memory while still allowing manual edits', async (t) => {
    installRuntimeFixture(t);
    const namespace = 'runtime-peer-memory-permission';
    const manager = await profileStore(t, namespace);
    const id = manager.activeProfile.id;
    await manager.update(id, { autoRemember: true });
    await manager.saveMemory(id, { text: 'A manually curated preference.' });
    const manual = manager.activeProfile.memories[0]!;
    const peer = await profileStore(t, namespace);
    let attempts = 0;
    let runtime!: ChatRuntime;
    const save = async (text: string, sourceEntryId: string) => {
      attempts++;
      const source = runtime.entries.find((value) => value.id === sourceEntryId);
      assert.ok(source);
      await manager.saveMemory(id, { text, sourceEntryId, sourceText: source.text, manual: false });
    };
    const provider = scripted(
      { message: rememberFact('Likes jasmine tea.'), before: async () => { await peer.update(id, { autoRemember: false }); } },
      { message: assistant('Automatic memory is disabled.') },
    );
    runtime = createRuntime(t, {
      model: { ...MODEL, tools: true }, storage: manager.storage(id),
      memory: {
        get entries() { return manager.memoryTexts(id); },
        get enabled() { return manager.memoryEnabled(id); },
        get remember() { return manager.autoRememberEnabled(id) ? save : undefined; },
      },
      _testing: { streamFn: provider.streamFn },
    });
    await runtime.send('Remember that I like jasmine tea.');
    assert.equal(runtime.error, null);
    assert.equal(provider.calls.length, 2);
    assert.equal(attempts, 1, 'the agent must execute the tool against current storage permission');
    const result = provider.calls[1]!.context.messages.find((message) => message.role === 'toolResult');
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Memory was not saved/);
    assert.deepEqual(manager.activeProfile.memories, [manual]);
    assert.equal(manager.autoRememberEnabled(id), false);
    await manager.saveMemory(id, { id: manual.id, text: 'Edited manually with automatic memory disabled.', manual: true });
    const reopened = await profileStore(t, namespace);
    assert.equal(reopened.activeProfile.autoRemember, false);
    assert.deepEqual(reopened.activeProfile.memories.map((value) => ({ id: value.id, text: value.text, manual: value.manual })), [
      { id: manual.id, text: 'Edited manually with automatic memory disabled.', manual: true },
    ]);
  });

  it('retains retired K1 and K2 redaction through replacement runtimes sharing the profile registry', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-retired-secrets');
    const id = manager.activeProfile.id;
    const registry = new SecretRegistry();
    t.after(() => registry.clear());
    const k1 = 'fixture-retired-K1';
    const k2 = 'fixture-retired-K2';
    const k3 = 'fixture-active-K3';
    const first = createRuntime(t, { model: { ...MODEL, apiKey: k1 }, storage: manager.storage(id), secrets: registry });
    await first.configure({ ...MODEL, apiKey: k2 }, true);
    first.destroy();
    const second = createRuntime(t, { storage: manager.storage(id), secrets: registry });
    await second.initialize();
    assert.equal(second.model!.apiKey, k2);
    await second.configure({ ...MODEL, apiKey: k3 }, true);
    second.destroy();
    assert.equal(manager.activeProfile.connection!.apiKey, k3);
    const provider = scripted({ message: assistant(`Reply ${k1} ${k2} ${k3}`) });
    const third = createRuntime(t, { storage: manager.storage(id), secrets: registry, _testing: { streamFn: provider.streamFn } });
    await third.send(`User ${k1} ${k2} ${k3}`);
    assert.equal(third.error, null);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]!.options!.apiKey, k3);
    assert.deepEqual(third.entries.map((value) => value.text), [
      'User [redacted] [redacted] [redacted]', 'Reply [redacted] [redacted] [redacted]',
    ]);
    assert.deepEqual(manager.activeProfile.entries, third.entries);
    const context = JSON.stringify(provider.calls[0]!.context);
    for (const key of [k1, k2, k3]) assert.equal(context.includes(key), false);
  });
});

describe('session handoff and memory flush boundaries', () => {
  for (const consent of [false, true]) {
    it(`carries session consent ${consent} through runtime replacement independently of a saved key`, async (t) => {
      installRuntimeFixture(t);
      const manager = await profileStore(t, `session-handoff-${consent}`);
      const id = manager.activeProfileId;
      await manager.storage(id).saveConnection({ ...MODEL, id: 'saved-model', apiKey: 'fixture-unrelated-saved-key' });
      const model = { ...MODEL, id: 'session-model', apiKey: 'fixture-session-key' };
      const first = createRuntime(t, { model, storage: manager.runtimeStorage(id) });
      await first.initialize();
      assert.equal(first.rememberKey, false, 'SDK injection never inherits consent from the saved key');
      const session = { ...first.sessionOverride!, rememberKey: consent };
      const replacement = createRuntime(t, { session, storage: manager.runtimeStorage(id) });
      await replacement.initialize();
      assert.equal(replacement.rememberKey, consent);
      assert.deepEqual(replacement.sessionOverride, session);
      assert.equal(manager.storedConnection(id)!.id, 'saved-model');
      await replacement.configure(model, consent);
      assert.equal(replacement.rememberKey, consent);
      assert.equal(replacement.sessionOverride === undefined, consent, 'only a genuine credential override is cached');
    });
  }

  it('flushes a batch of facts once, then flushes actual assistant/action changes before later facts', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-batch-flush');
    const id = manager.activeProfileId;
    await manager.update(id, { autoRemember: true });
    const storage = manager.runtimeStorage(id);
    const saves = t.mock.method(storage, 'saveEntries');
    const first = rememberFact('Likes tea.', 'Likes quiet walks.');
    first.content.unshift({ type: 'text', text: 'I will remember those preferences.' });
    const next = rememberFact('Likes a friendly wave.');
    next.content.unshift({ type: 'text', text: 'I can wave too.' }, { type: 'toolCall', id: 'wave-scripted', name: 'companion_action', arguments: { action: 'wave' } });
    const provider = scripted({ message: first }, { message: next }, { message: assistant('Preferences saved.') },
      { message: rememberFact('Likes tea.') }, { message: assistant('Remembered again.') });
    const savesBeforeMemory: number[] = [];
    const runtime = createRuntime(t, {
      model: { ...MODEL, tools: true }, storage, onAction: () => 'Wave complete.',
      memory: { entries: [], enabled: true, remember: async (text, sourceEntryId) => {
        savesBeforeMemory.push(saves.mock.callCount());
        const sourceText = manager.sourceText(id, sourceEntryId);
        assert.ok(sourceText, 'the source is committed before memory writes');
        await manager.saveMemory(id, { text, sourceEntryId, sourceText, manual: false });
      } },
      _testing: { streamFn: provider.streamFn },
    });
    await runtime.send('I like tea, quiet walks and friendly waves.');
    assert.equal(runtime.error, null);
    assert.deepEqual(savesBeforeMemory, [1, 1, 2]);
    assert.equal(saves.mock.callCount(), 3, 'the final assistant text is a new mutation');
    assert.deepEqual(manager.historyPage(id, '', 10).entries.map((value) => value.text).reverse(), [
      'I like tea, quiet walks and friendly waves.', 'I will remember those preferences.', 'I can wave too.', 'wave', 'Preferences saved.',
    ]);
    assert.deepEqual(manager.memoryTexts(id).map((value) => value.text), ['Likes tea.', 'Likes quiet walks.', 'Likes a friendly wave.']);
    await runtime.send('Remember that I like tea.');
    assert.equal(runtime.error, null);
    assert.deepEqual(savesBeforeMemory, [1, 1, 2, 4], 'a new source requires a new flush');
    assert.equal(saves.mock.callCount(), 5);
  });

  it('retries an unchanged source after a failed flush before the next real memory tool', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-failed-flush');
    const id = manager.activeProfileId;
    await manager.update(id, { autoRemember: true });
    const storage = manager.runtimeStorage(id);
    const save = storage.saveEntries;
    let attempts = 0;
    t.mock.method(storage, 'saveEntries', (entries: readonly ChatEntry[], changedIds?: readonly string[]) => {
      if (++attempts === 1) return Promise.reject(new Error('Scripted storage rejection.'));
      return save(entries, changedIds);
    });
    const provider = scripted({ message: rememberFact('Likes tea.', 'Likes quiet walks.') }, { message: assistant('One preference was saved.') });
    const runtime = createRuntime(t, {
      model: { ...MODEL, tools: true }, storage,
      memory: { entries: [], enabled: true, remember: (text, sourceEntryId) => manager.saveMemory(id, {
        text, sourceEntryId, sourceText: 'I like tea and quiet walks.', manual: false,
      }) },
      _testing: { streamFn: provider.streamFn },
    });
    await runtime.send('I like tea and quiet walks.');
    assert.equal(attempts, 3, 'the rejected source flush is retried and the final reply is saved');
    assert.equal(runtime.persistenceWarning, true);
    assert.deepEqual(manager.memoryTexts(id).map((value) => value.text), ['Likes quiet walks.']);
    const results = provider.calls[1]!.context.messages.filter((message) => message.role === 'toolResult');
    assert.equal(results.length, 2);
    assert.equal(results[0]!.isError, true);
    assert.equal(results[1]!.isError, false);
  });

  it('reuses an in-flight source flush when clear stops a memory batch and never saves its facts afterward', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'runtime-pending-memory-flush');
    const id = manager.activeProfileId;
    await manager.update(id, { autoRemember: true });
    const storage = manager.runtimeStorage(id);
    const started = deferred<void>(); const release = deferred<void>();
    t.after(() => release.resolve());
    const save = storage.saveEntries;
    let saves = 0;
    t.mock.method(storage, 'saveEntries', (entries: readonly ChatEntry[], changedIds?: readonly string[]) => {
      saves++;
      const writing = save(entries, changedIds);
      started.resolve();
      return Promise.all([writing, release.promise]).then(() => {});
    });
    const provider = scripted({ message: rememberFact('Likes tea.', 'Likes quiet walks.') });
    let memories = 0;
    const runtime = createRuntime(t, {
      model: { ...MODEL, tools: true }, storage,
      memory: { entries: [], enabled: true, remember: async () => { memories++; } },
      _testing: { streamFn: provider.streamFn },
    });
    const sending = runtime.send('I like tea and quiet walks.');
    await started.promise;
    const clearing = runtime.clear();
    assert.equal(saves, 1, 'stop reuses the pending write for the unchanged transcript');
    await clearing;
    release.resolve();
    await sending;
    assert.equal(memories, 0);
    assert.deepEqual((await manager.storage(id).load()).entries, []);
    assert.equal(provider.calls.length, 1);
  });

  for (const ending of ['clear', 'configure', 'destroy'] as const) {
    it(`enqueues a partial reply save synchronously before ${ending} while its completion is pending`, async (t) => {
      installRuntimeFixture(t);
      const manager = await profileStore(t, `runtime-synchronous-flush-${ending}`);
      const id = manager.activeProfileId;
      const storage = manager.runtimeStorage(id);
      const release = deferred<void>(); const interrupted = deferred<void>();
      t.after(() => release.resolve());
      const order: string[] = [];
      const save = storage.saveEntries;
      t.mock.method(storage, 'saveEntries', (entries: readonly ChatEntry[], changedIds?: readonly string[]) => {
        order.push('save');
        const writing = save(entries, changedIds);
        return Promise.all([writing, release.promise]).then(() => {});
      });
      for (const [method, label] of [['clearEntries', 'clear'], ['saveConnection', 'configure'], ['close', 'destroy']] as const) {
        const original = storage[method];
        t.mock.method(storage, method, (...args: never[]) => { order.push(label); return Reflect.apply(original, storage, args); });
      }
      const provider = scripted({ message: assistant('A late reply.'), partial: 'Partial before interruption.' });
      let acted = false; let transition = Promise.resolve();
      const runtime = createRuntime(t, {
        model: MODEL, storage, _testing: { streamFn: provider.streamFn },
        onChange() {
          if (acted || runtime.entries.at(-1)?.text !== 'Partial before interruption.') return;
          acted = true;
          if (ending === 'clear') transition = runtime.clear();
          else if (ending === 'configure') transition = runtime.configure({ ...MODEL, id: 'replacement' }, false);
          else runtime.destroy();
          interrupted.resolve();
        },
      });
      const sending = runtime.send('Interrupt the streamed reply.');
      await interrupted.promise;
      assert.equal(order[0], 'save', 'saveEntries must be invoked before the later operation can enqueue');
      await transition;
      assert.deepEqual(order, ['save', ending]);
      release.resolve();
      await sending;
      const archived = (await manager.storage(id).load()).entries.map((value) => value.text);
      assert.deepEqual(archived, ending === 'clear' ? [] : ['Interrupt the streamed reply.', 'Partial before interruption.']);
    });
  }
});

describe('core verified fix regressions', () => {
  for (const bounded of [false, true]) {
    it(`redacts before entry and total clipping and sanitizes the full archive with bounded adapter ${bounded}`, async (t) => {
      installRuntimeFixture(t);
      const namespace = `redact-full-before-clip-${bounded}`;
      const manager = await profileStore(t, namespace);
      const secret = 'synthetic-boundary-credential-0123456789-ABCDEFGHIJKLMNOPQ';
      const total = `${'t'.repeat(5_990)}${secret} total suffix`;
      const long = `${'l'.repeat(15_990)}${secret} full suffix beyond entry clip`;
      const archive = [entry('out-of-window', `Old ${secret}`),
        ...Array.from({ length: 240 }, (_, i) => entry(`older-${i}`, `Archived ${i} ${secret}`)),
        entry('total-boundary', total),
        ...Array.from({ length: 14 }, (_, i) => entry(`recent-${i}`, i === 13 ? long : 'r'.repeat(16_000))),
        entry('tail', 'a'.repeat(10_000))];
      const restored = await restoreProfile(manager, { entries: archive, connection: { ...MODEL, apiKey: secret } });
      const provider = scripted({ message: assistant('Safe reply.') });
      const storage = bounded ? manager.runtimeStorage(restored.id) : manager.storage(restored.id);
      const runtime = createRuntime(t, { model: { ...MODEL, baseUrl: 'https://sdk.example/v1' }, storage, _testing: { streamFn: provider.streamFn } });
      await runtime.initialize();
      const shown = JSON.stringify(runtime.entries);
      assert.equal(shown.includes(secret.slice(0, 9)), false);
      assert.equal(runtime.entries.find((value) => value.id === restored.entries[241]!.id)!.text.length, 6_000);
      await runtime.configure({ ...MODEL, apiKey: 'synthetic-replacement-key' }, true);
      // A peer edit must be sanitized at its current complete value, never replaced by the old projection.
      const peer = await profileStore(t, namespace);
      const editedId = restored.entries[0]!.id;
      await peer.editEntry(restored.id, editedId, `Peer correction ${secret} preserved`);
      await runtime.send('Continue safely.');
      assert.equal(runtime.error, null);
      assert.equal(JSON.stringify(provider.calls[0]!.context).includes(secret.slice(0, 9)), false);
      const reopened = await profileStore(t, namespace);
      const saved = (await reopened.storage(restored.id).load()).entries;
      assert.equal(saved[0]!.text, 'Peer correction [redacted] preserved');
      assert.equal(saved.length, archive.length + 2);
      assert.equal(saved.find((value) => value.id === restored.entries.at(-2)!.id)!.text, long.replace(secret, '[redacted]'));
      assert.equal(saved.find((value) => value.id === restored.entries[241]!.id)!.text, total.replace(secret, '[redacted]'));
      assert.equal(JSON.stringify(saved).includes(secret), false);
      assert.equal(reopened.persistenceWarning, false);
    });
  }

  it('keeps the newer SDK connection ownership when an earlier saved connection finishes later', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'post-save-revision');
    const storage = manager.runtimeStorage(manager.activeProfileId);
    const started = deferred<void>(); const release = deferred<void>();
    t.after(() => release.resolve());
    const original = storage.saveConnection;
    t.mock.method(storage, 'saveConnection', async (...args: Parameters<typeof original>) => {
      const committed = await original(...args);
      started.resolve();
      await release.promise;
      return committed;
    });
    const runtime = createRuntime(t, { storage });
    const first = runtime.configure({ ...MODEL, id: 'saved-A' }, true);
    await started.promise;
    const latest = { ...MODEL, id: 'SDK-B', apiKey: 'synthetic-session-B' };
    await runtime.setModel(latest);
    release.resolve(); await first;
    assert.deepEqual(runtime.sessionOverride, { model: latest, rememberKey: false });
    assert.equal(runtime.rememberKey, false);
    assert.equal(manager.storedConnection(manager.activeProfileId)!.id, 'saved-A');
  });

  it('keeps a live header override when authoritative storage strips a peer-removed header', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'normalized-save-result');
    const restored = await restoreProfile(manager, { connection: { ...MODEL, headers: { 'openai-project': 'synthetic-route' } } });
    const runtime = createRuntime(t, { storage: manager.runtimeStorage(restored.id) });
    await runtime.initialize();
    const live = runtime.model!;
    const peer = await profileStore(t, 'normalized-save-result');
    await peer.storage(restored.id).saveConnection(MODEL);
    await runtime.configure(live, true);
    assert.equal(manager.storedConnection(restored.id)!.headers, undefined);
    assert.deepEqual(runtime.sessionOverride, { model: live, rememberKey: true });
  });

  it('blocks deleted-profile sends while a real IndexedDB outage still uses RAM history', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await profileStore(t, 'deleted-profile-send');
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries([entry('cached', 'Cached private history')]);
    await manager.create({ name: 'Keep' });
    const provider = scripted({ message: assistant('RAM reply.') });
    const runtime = createRuntime(t, { model: MODEL, storage: manager.runtimeStorage(id), _testing: { streamFn: provider.streamFn } });
    await runtime.initialize();
    const peer = await profileStore(t, 'deleted-profile-send');
    await peer.remove(id);
    await runtime.send('Must not send stale context.');
    assert.equal(provider.calls.length, 0);
    assert.match(runtime.error!, /no longer exists/);
    assert.equal(runtime.entries.length, 1);
    assert.equal(runtime.persistenceWarning, false);
    const fallback = createRuntime(t, { model: MODEL, storage: manager.runtimeStorage(manager.activeProfileId), _testing: { streamFn: provider.streamFn } });
    await fallback.initialize();
    idb.fail('open');
    // A failed write switches the healthy cached store to RAM for subsequent turns.
    idb.fail('write');
    await manager.update(manager.activeProfileId, { name: 'RAM profile' });
    await fallback.send('RAM remains usable.');
    assert.equal(provider.calls.length, 1);
    assert.equal(fallback.reply!.text, 'RAM reply.');
    assert.equal(fallback.persistenceWarning, true);
  });

  it('fails a full archive before appending a turn or resolving credentials, preserving all entries', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'full-archive-preflight');
    const id = manager.activeProfileId;
    const archive = Array.from({ length: PROFILE_LIMITS.entries }, (_, i) => entry(`full-${i}`, `Complete ${i}`));
    await manager.storage(id).saveEntries(archive);
    let credentials = 0;
    const provider = scripted({ message: assistant('Retained visit reply.'), before: async () => {
      await manager.storage(id).saveEntries([entry('peer-capacity-one', 'Peer one'), entry('peer-capacity-two', 'Peer two')]);
    } });
    const runtime = createRuntime(t, { model: { ...MODEL, getApiKey: () => { credentials++; return MODEL.apiKey!; } }, storage: manager.runtimeStorage(id), _testing: { streamFn: provider.streamFn } });
    await runtime.send('No capacity.');
    assert.match(runtime.error!, /archive is full/);
    assert.equal(runtime.entries.some((value) => value.text === 'No capacity.'), false);
    assert.equal(credentials, 0);
    assert.equal(provider.calls.length, 0);
    assert.equal(runtime.persistenceWarning, false);
    assert.deepEqual((await manager.storage(id).load()).entries, archive);
    await runtime.send('Still full.');
    assert.equal(provider.calls.length, 0);
    await manager.removeEntry(id, archive.at(-1)!.id);
    await manager.removeEntry(id, archive.at(-2)!.id);
    await runtime.send('A peer fills the remaining space during this turn.');
    assert.equal(provider.calls.length, 1);
    assert.match(runtime.error!, /archive is full/);
    assert.equal(runtime.persistenceWarning, false);
    const retained = structuredClone(runtime.entries);
    assert.deepEqual(retained.slice(-2).map((value) => value.text), ['A peer fills the remaining space during this turn.', 'Retained visit reply.']);
    await runtime.send('Must not erase the rejected turn on refresh.');
    assert.deepEqual(runtime.entries, retained);
    assert.match(runtime.error!, /could not be archived/);
    assert.equal(provider.calls.length, 1);
    assert.equal(manager.profileInfo(id)!.entryCount, PROFILE_LIMITS.entries);
    assert.equal(manager.sourceText(id, 'peer-capacity-two'), 'Peer two');
    await runtime.clear();
    assert.equal(manager.profileInfo(id)!.entryCount, 0);
  });

  it('passes the turn signal into a queued automatic memory write and cancels it before mutation', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'cancel-queued-memory');
    const id = manager.activeProfileId;
    await manager.update(id, { autoRemember: true });
    const provider = scripted({ message: rememberFact('Likes tea.') });
    const queued = deferred<void>(); const release = deferred<void>();
    t.after(() => release.resolve());
    let block = false;
    const opening = (manager as unknown as { open: () => Promise<IDBDatabase | undefined> }).open.bind(manager);
    t.mock.method(manager as unknown as { open: () => Promise<IDBDatabase | undefined> }, 'open', async () => {
      if (block) { block = false; queued.resolve(); await release.promise; }
      return opening();
    });
    let observed: AbortSignal | undefined;
    const runtime = createRuntime(t, { model: { ...MODEL, tools: true }, storage: manager.runtimeStorage(id),
      memory: { enabled: true, entries: [], remember: (text, sourceEntryId, signal) => {
        observed = signal;
        block = true;
        return manager.saveMemory(id, { text, sourceEntryId, sourceText: manager.sourceText(id, sourceEntryId)!, manual: false }, signal);
      } }, _testing: { streamFn: provider.streamFn },
    });
    const sending = runtime.send('I like tea.');
    await queued.promise;
    assert.ok(observed);
    runtime.stop();
    assert.equal(observed.aborted, true);
    release.resolve(); await sending;
    await manager.exportMemories(id); // Wait behind the canceled transaction.
    assert.equal(manager.memoryTexts(id).length, 0);
    assert.equal(manager.persistenceWarning, false);
    assert.equal(provider.calls.length, 1);
  });
});

describe('input acceptance after preflight', () => {
  it('does not accept before credentials resolve and supplies a detached redacted entry only after append', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'input-accepted');
    const key = deferred<string>(); const resolving = deferred<void>();
    const accepted: ChatEntry[] = [];
    const provider = scripted({ message: assistant('Accepted reply.') });
    const runtime = createRuntime(t, { storage: manager.runtimeStorage(manager.activeProfileId),
      model: { ...MODEL, getApiKey: () => { resolving.resolve(); return key.promise; } },
      onInputAccepted(entry) {
        assert.ok(runtime.entries.some((value) => value.id === entry.id));
        accepted.push({ ...entry });
        entry.text = 'Host mutation must not affect history';
        throw new Error('Host callback failure must be isolated.');
      }, _testing: { streamFn: provider.streamFn },
    });
    const sending = runtime.send('Use synthetic-preflight-key');
    await resolving.promise;
    assert.equal(accepted.length, 0);
    assert.equal(runtime.entries.length, 0);
    key.resolve('synthetic-preflight-key');
    await sending;
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.role, 'user');
    assert.equal(accepted[0]!.text, 'Use [redacted]');
    assert.equal(runtime.entries[0]!.text, 'Use [redacted]');
    assert.equal(runtime.reply!.text, 'Accepted reply.');
    assert.equal(runtime.error, null);
    assert.equal(runtime.busy, false);
    assert.equal(manager.profileInfo(manager.activeProfileId)!.entryCount, 2);
  });

  for (const failure of ['capacity', 'credentials', 'stop', 'missing model', 'oversized input'] as const) {
    it(`does not notify acceptance after ${failure} preflight rejection`, async (t) => {
      installRuntimeFixture(t);
      const manager = await profileStore(t, `input-rejected-${failure}`);
      const storage = manager.runtimeStorage(manager.activeProfileId);
      const pending = deferred<string>(); const resolving = deferred<void>();
      if (failure === 'capacity') storage.ensureCapacity = () => Promise.reject(new Error('Capacity unavailable.'));
      let accepted = 0;
      const provider = scripted({ message: assistant('Never reached.') });
      const runtime = createRuntime(t, { storage,
        ...(failure === 'missing model' ? {} : { model: { ...MODEL, getApiKey: () => {
          if (failure === 'credentials') throw new Error('Secret lookup failed.');
          if (failure === 'stop') { resolving.resolve(); return pending.promise; }
          return MODEL.apiKey!;
        } } }),
        onInputAccepted: () => { accepted++; }, _testing: { streamFn: provider.streamFn },
      });
      const sending = runtime.send(failure === 'oversized input' ? 'x'.repeat(8_001) : 'Keep this draft');
      if (failure === 'stop') { await resolving.promise; runtime.stop(); pending.resolve(MODEL.apiKey!); }
      await sending;
      assert.equal(accepted, 0);
      assert.equal(runtime.entries.length, 0);
      assert.equal(provider.calls.length, 0);
      assert.equal(runtime.busy, false);
    });
  }

  it('handles reentrant cancellation from the acceptance callback and archives the accepted input', async (t) => {
    installRuntimeFixture(t);
    const manager = await profileStore(t, 'input-accepted-stop');
    const provider = scripted({ message: assistant('Never reached.') });
    const runtime = createRuntime(t, { model: MODEL, storage: manager.runtimeStorage(manager.activeProfileId),
      onInputAccepted: () => runtime.stop(), _testing: { streamFn: provider.streamFn },
    });
    await runtime.send('Accepted before stopping.');
    await manager.backup(); // Wait for the synchronous stop flush.
    assert.equal(provider.calls.length, 0);
    assert.equal(runtime.busy, false);
    assert.equal(manager.historyPage(manager.activeProfileId, '', 1).entries[0]!.text, 'Accepted before stopping.');
  });
});

describe('owned clear failure recovery', () => {
  for (const initialized of [false, true]) {
    it(`restores real history after failed legacy CAS with runtime initialized ${initialized} and permits retry`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `runtime-clear-cas-${initialized}`;
      const manager = await profileStore(t, namespace); const id = manager.activeProfileId;
      const copied = entry('copied', 'Existing authoritative history');
      await manager.storage(id).saveEntries([copied]);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('entries', [copied, entry('uncopied', 'Old independent turn')]);
      const old = new LegacyV1ChatFixture(namespace); t.after(() => old.close());
      const oldView = (await old.load()).entries;
      const seam = manager as unknown as { retireLegacy: (...args: unknown[]) => Promise<void> };
      const retire = seam.retireLegacy.bind(manager); let race = true;
      t.mock.method(seam, 'retireLegacy', async (...args: unknown[]) => {
        if (race && args[2] === 'history') { race = false; await old.saveEntries([...oldView, entry('racer', 'Concurrent legacy append')]); }
        return retire(...args);
      });
      let changes = 0;
      const provider = scripted({ message: assistant('Reply after retry.') });
      const runtime = createRuntime(t, { model: MODEL, storage: manager.runtimeStorage(id), onChange: () => { changes++; }, _testing: { streamFn: provider.streamFn } });
      let expected = [copied];
      if (initialized) {
        await runtime.initialize();
        const internal = runtime as unknown as { append(role: ChatEntry['role'], text: string): ChatEntry; pendingHistory: Map<string, ChatEntry> };
        const pending = internal.append('user', 'Locally retained unarchived input');
        internal.pendingHistory.set(pending.id, pending);
        expected = [...expected, pending];
      }
      await runtime.clear(); // Handled rejection must not escape to the panel.
      assert.deepEqual(runtime.entries, expected);
      assert.equal(runtime.error, 'Could not clear conversation. Close other tabs and try again.');
      assert.ok(changes > 0);
      assert.deepEqual(manager.historyPage(id, '', 10).entries, [copied]);
      if (initialized) {
        await runtime.send('The retained unarchived input still blocks sending.');
        assert.match(runtime.error!, /could not be archived/u);
        assert.equal(provider.calls.length, 0);
      }
      await runtime.clear();
      assert.deepEqual(runtime.entries, []);
      assert.equal(runtime.error, null);
      assert.equal(manager.profileInfo(id)!.entryCount, 0);
      await runtime.send('New turn after successful retry.');
      assert.equal(runtime.error, null);
      assert.equal(runtime.reply!.text, 'Reply after retry.');
      assert.equal(provider.calls.length, 1);
    });
  }

  it('does not restore erased history when an overlapping earlier clear succeeded before a later failure', async (t) => {
    const storage = new MemoryChatStorage({ entries: [entry('saved', 'History that was actually cleared')] });
    const first = deferred<void>(); const second = deferred<void>(); let calls = 0;
    t.mock.method(storage, 'clearEntries', async () => {
      const current = calls++ === 0 ? first : second;
      await current.promise; storage.state.entries = [];
    });
    const runtime = createRuntime(t, { model: MODEL, storage });
    await runtime.initialize();
    const a = runtime.clear(); const b = runtime.clear();
    first.resolve(); await a;
    second.reject(new ChatStorageError('legacy-cleanup', 'Fixed failure.')); await b;
    assert.deepEqual(runtime.entries, []);
    assert.deepEqual(storage.state.entries, []);
    assert.equal(runtime.error, 'Could not clear conversation. Close other tabs and try again.');
  });
});

it('matches secret metacharacters literally and never recursively redacts inserted markers', () => {
  const registry = new SecretRegistry();
  const literal = 'key[1].*+?^${}()|\\';
  registry.add('key[1]');
  registry.add(literal);
  registry.add('redact');
  const input = `Public key11 stays; ${literal}; redact.`;
  const expected = 'Public key11 stays; [redacted]; [redacted].';
  assert.equal(registry.redact(input), expected);
  assert.equal(registry.redact(input), expected);
});
