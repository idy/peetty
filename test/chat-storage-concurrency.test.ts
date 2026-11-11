import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatStorageError } from '../src/chat/store.ts';
import type { StoredConnection } from '../src/chat/store.ts';
import { BrowserProfileStore } from '../src/chat/profiles.ts';
import { ChatRuntime } from '../src/chat/runtime.ts';
import { jsonFingerprint } from '../src/chat/bounded-json.ts';
import { fenceLegacyDatabase, IDB_OPEN_TIMEOUT_MS, openStateDatabase, stateTransaction } from '../src/chat/idb.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB, profileStorage } from './helpers/chat-storage.ts';

const entry = (id: string, text = id, createdAt = 1): ChatEntry => ({ id, role: 'user', text, createdAt });

describe('concurrent browser history storage', () => {
  it('transactionally merges appends, partial updates, and repeated stale snapshots without reordering', async (t) => {
    installChatIndexedDB(t);
    const first = await profileStorage(t, 'shared');
    const second = await profileStorage(t, 'shared');
    t.after(() => { first.close(); second.close(); });
    await Promise.all([first.load(), second.load()]);
    const a = [entry('a-user', 'first', 100), { ...entry('a-reply', 'partial', 101), role: 'assistant' as const }];
    // Clock skew must not sort the second client's turn ahead of an already committed turn.
    const b = [entry('b-user', 'second', 1), { ...entry('b-reply', 'peer reply', 2), role: 'assistant' as const }];
    await Promise.all([first.saveEntries(a), second.saveEntries(b)]);
    const updated = [a[0]!, { ...a[1]!, text: 'finished' }];
    await first.saveEntries(updated);
    await second.saveEntries(b);
    const reader = await profileStorage(t, 'shared');
    t.after(() => reader.close());
    assert.deepEqual((await reader.load()).entries, [...updated, ...b]);
    // Omitting an entry, including an empty save, is not an implicit clear.
    await first.saveEntries([updated[1]!]);
    await second.saveEntries([]);
    assert.deepEqual((await reader.load()).entries, [...updated, ...b]);
  });

  it('does not overwrite a peer edit to an unchanged entry in a loaded snapshot', async (t) => {
    installChatIndexedDB(t);
    const first = await profileStorage(t, 'edits');
    const second = await profileStorage(t, 'edits');
    t.after(() => { first.close(); second.close(); });
    const original = entry('original');
    await first.saveEntries([original]);
    const snapshot = (await second.load()).entries;
    const updated = { ...original, text: 'edited by first' };
    await first.saveEntries([updated]);
    await second.saveEntries([...snapshot, entry('new')]);
    assert.deepEqual((await first.load()).entries, [updated, entry('new')]);
  });

  it('keeps a persistent clear barrier against late additions, edits, re-saves, and queued close writes', async (t) => {
    const idb = installChatIndexedDB(t);
    const first = await profileStorage(t, 'clear');
    const stale = await profileStorage(t, 'clear');
    const old = [entry('old-user'), { ...entry('old-reply', 'partial'), role: 'assistant' as const }];
    await first.saveEntries(old);
    await stale.load();
    await first.clearEntries();
    first.close();
    // Even a completely new assistant ID belongs to the stale client's old epoch.
    await stale.saveEntries([...old, { ...entry('late-reply'), role: 'assistant' }]);
    const writing = stale.saveEntries([old[0]!, { ...old[1]!, text: 'late update' }]);
    stale.close();
    await writing;
    const restored = await profileStorage(t, 'clear');
    t.after(() => restored.close());
    assert.deepEqual((await restored.load()).entries, []);
    const profile = [...idb.databases.get('clear:profiles')!.values()].find((value) => value && typeof value === 'object' && 'profile' in value) as { epoch: string; profile: { entries: ChatEntry[] } };
    assert.equal(typeof profile.epoch, 'string');
    assert.deepEqual(profile.profile.entries, []);
  });

  it('accepts the first new turn after clear, then never reintroduces old snapshot IDs', async (t) => {
    installChatIndexedDB(t);
    const first = await profileStorage(t, 'new-epoch');
    const second = await profileStorage(t, 'new-epoch');
    t.after(() => { first.close(); second.close(); });
    const old = entry('old');
    await first.saveEntries([old]);
    await second.load();
    const clearing = first.clearEntries();
    const a = entry('fresh-first');
    const saving = first.saveEntries([a]);
    await Promise.all([clearing, saving]);
    await second.saveEntries([old, entry('late-old-turn')]);
    const fresh = (await second.load()).entries;
    assert.deepEqual(fresh, [a]);
    const b = entry('fresh-second');
    await second.saveEntries([...fresh, b]);
    await first.saveEntries([a]);
    await second.saveEntries([...fresh, b, entry('next-second')]);
    assert.deepEqual((await first.load()).entries, [a, b, entry('next-second')]);
  });

  it('serializes overlapping clears and appends without allowing a cleared epoch to return', async (t) => {
    installChatIndexedDB(t);
    const first = await profileStorage(t, 'overlapping-clear');
    const second = await profileStorage(t, 'overlapping-clear');
    const reader = await profileStorage(t, 'overlapping-clear');
    t.after(() => { first.close(); second.close(); reader.close(); });
    await first.saveEntries([entry('old')]);
    await second.load();
    await Promise.all([first.clearEntries(), second.saveEntries([entry('old'), entry('in-flight')])]);
    assert.deepEqual((await reader.load()).entries, []);
    await Promise.all([first.clearEntries(), second.clearEntries()]);
    const a = (await first.load()).entries;
    const b = (await second.load()).entries;
    await Promise.all([first.saveEntries([...a, entry('new-a')]), second.saveEntries([...b, entry('new-b')])]);
    assert.deepEqual((await reader.load()).entries, [entry('new-a'), entry('new-b')]);
  });

  it('bounds the runtime view while preserving full archived entries', async (t) => {
    installChatIndexedDB(t);
    const first = await profileStorage(t, 'bounded');
    const second = await profileStorage(t, 'bounded');
    t.after(() => { first.close(); second.close(); });
    await Promise.all([first.load(), second.load()]);
    const a = Array.from({ length: 150 }, (_, i) => entry(`a-${i}`));
    const b = Array.from({ length: 150 }, (_, i) => entry(`b-${i}`));
    await Promise.all([first.saveEntries(a), second.saveEntries(b)]);
    await first.saveEntries(a.map((value, i) => i === 0 ? { ...value, text: 'late edit' } : value));
    const entries = (await second.load()).entries;
    assert.equal(entries.length, 200);
    assert.deepEqual(entries.map((value) => value.id), [...a.slice(100), ...b].map((value) => value.id));
    const large = Array.from({ length: 150 }, (_, i) => entry(`large-${i}`, 'x'.repeat(2_000)));
    await second.saveEntries([...entries, ...large]);
    const bounded = (await first.load()).entries;
    assert.equal(bounded.length, 120);
    assert.equal(bounded.reduce((sum, value) => sum + value.text.length, 0), 240_000);
    assert.deepEqual(bounded.map((value) => value.id), large.slice(30).map((value) => value.id));
  });
});

describe('version fencing of deployed legacy v1 writers', () => {
  const connection: StoredConnection = { id: 'old-model', baseUrl: 'https://old.example/v1', apiKey: 'old-compiled-fixture-key' };
  // Deliberately mirrors the deployed v1 policy: unconditional credential puts,
  // fixed version-one opens, close+RAM fallback on versionchange, no epoch reads.
  async function oldV1(namespace: string, cooperative = true) {
    let failed = false;
    const db = await openStateDatabase(`${namespace}:chat`, { isClosed: () => false, onFailure: () => { failed = true; } });
    assert.ok(db);
    if (!cooperative) db.onversionchange = () => {};
    return { db, get failed() { return failed; }, close: () => db.close(),
      async save(value: StoredConnection) {
        if (failed) return false;
        const ok = await stateTransaction(db, true, (store) => { store.put(value, 'connection'); });
        if (!ok) failed = true;
        return ok;
      },
    };
  }

  for (const cleanup of ['opt-out', 'explicit'] as const) {
    it(`fences an actual old-v1-style writer before ${cleanup} succeeds and preserves unknown data`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `old-v1-${cleanup}`;
      const manager = new BrowserProfileStore(namespace); t.after(() => manager.close());
      await manager.initialize();
      await manager.storage(manager.activeProfileId).saveConnection(connection);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('connection', connection);
      legacy.set('entries', [entry('unknown', 'Not copied to current profiles')]);
      legacy.set('unrelated', 'keep');
      const old = await oldV1(namespace); t.after(() => old.close());
      const pending = old.save(connection); // Its already-enqueued v1 transaction must drain first.
      if (cleanup === 'opt-out') await manager.storage(manager.activeProfileId).saveConnection(connection, { rememberCredentials: false });
      else if (cleanup === 'explicit') await manager.clearLegacyData();
      assert.equal(await pending, true);
      assert.equal(old.failed, true, 'old compiled adapter must be fenced through its existing versionchange handler');
      assert.equal(idb.versions.get(`${namespace}:chat`), 2);
      assert.equal(idb.versions.get(`${namespace}:profiles`), 1);
      const saved = legacy.get('connection') as StoredConnection | undefined;
      assert.equal(saved?.apiKey, undefined);
      assert.equal(await old.save(connection), false);
      assert.equal((legacy.get('connection') as StoredConnection | undefined)?.apiKey, undefined);
      if (cleanup !== 'explicit') assert.deepEqual(legacy.get('entries'), [entry('unknown', 'Not copied to current profiles')]);
      assert.equal(legacy.get('unrelated'), 'keep');
      let errorName = '';
      const obsolete = await openStateDatabase(`${namespace}:chat`, { isClosed: () => false, onFailure: () => {}, onOpenError: (error) => { errorName = error?.name ?? ''; } });
      assert.equal(obsolete, undefined);
      assert.equal(errorName, 'VersionError', 'future fixed-v1 opens cannot restart the erased credential writer');
      const current = await profileStorage(t, namespace); t.after(() => current.close());
      await current.load();
      await current.saveConnection({ ...connection, apiKey: 'new-updated-client-key' });
      assert.equal(idb.versions.get(`${namespace}:chat`), 2, 'normal operations must not repeatedly upgrade');
    });
  }

  it('fences an old tab pending first setup even when the profile only has an unremembered SDK key', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'pending-first-sdk';
    const manager = new BrowserProfileStore(namespace); t.after(() => manager.close());
    await manager.initialize();
    assert.equal(manager.activeProfile.connection, undefined);
    const old = await oldV1(namespace); t.after(() => old.close());
    const runtime = new ChatRuntime({ model: { ...connection, id: 'sdk-model' }, storage: manager.storage(manager.activeProfileId) });
    t.after(() => runtime.destroy()); await runtime.initialize();
    const pending = old.save(connection);
    await runtime.configure(runtime.model!, false);
    assert.equal(await pending, true);
    assert.equal(old.failed, true);
    assert.equal(idb.versions.get(`${namespace}:chat`), 2);
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    assert.equal((legacy.get('connection') as StoredConnection | undefined)?.apiKey, undefined);
    assert.equal(await old.save(connection), false);
    assert.equal(manager.activeProfile.connection!.apiKey, undefined);
    assert.equal(runtime.model!.apiKey, connection.apiKey, 'the active session remains usable');
    assert.equal(runtime.rememberKey, false);
  });

  it('fences pending first setup for callback authentication without resolving the callback', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'callback-first-setup';
    const manager = new BrowserProfileStore(namespace); t.after(() => manager.close());
    await manager.initialize();
    const old = await oldV1(namespace); t.after(() => old.close());
    let resolved = 0;
    const getApiKey = () => { resolved++; return connection.apiKey!; };
    const runtime = new ChatRuntime({ model: { id: connection.id, baseUrl: connection.baseUrl, getApiKey }, storage: manager.storage(manager.activeProfileId) });
    t.after(() => runtime.destroy());
    await runtime.initialize();
    await runtime.configure(runtime.model!, false);
    assert.equal(resolved, 0);
    assert.equal(old.failed, true);
    assert.equal(await old.save(connection), false, 'the old pending first setup cannot begin its credential write after fencing');
    assert.equal(idb.versions.get(`${namespace}:chat`), 2);
    assert.equal(idb.databases.get(`${namespace}:chat`)!.has('connection'), false);
    assert.equal(runtime.model!.getApiKey, getApiKey);
  });

  it('does not claim callback-only cleanup when an unidentified old key already reached disk', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'callback-unknown-key';
    const manager = new BrowserProfileStore(namespace); t.after(() => manager.close());
    await manager.initialize();
    const old = await oldV1(namespace); t.after(() => old.close());
    await old.save(connection);
    let resolved = 0;
    const runtime = new ChatRuntime({ model: { id: connection.id, baseUrl: connection.baseUrl, getApiKey: () => { resolved++; return connection.apiKey!; } }, storage: manager.storage(manager.activeProfileId) });
    t.after(() => runtime.destroy());
    await runtime.initialize();
    await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
    assert.equal(resolved, 0);
    assert.equal(manager.activeProfile.connection, undefined);
  });

  it('rejects a real runtime opt-out blocked by an uncooperative v1 connection without late cleanup', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'blocked-old-v1';
    const manager = new BrowserProfileStore(namespace); t.after(() => manager.close());
    await manager.initialize();
    await manager.storage(manager.activeProfileId).saveConnection(connection);
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', connection); legacy.set('entries', [entry('uncopied')]);
    const proof = { version: 1, entries: [], connections: [jsonFingerprint(connection)] };
    idb.databases.get(`${namespace}:profiles`)!.set('legacyMigration', proof);
    const blocker = await oldV1(namespace, false); t.after(() => blocker.close());
    const runtime = new ChatRuntime({ storage: manager.storage(manager.activeProfileId) }); t.after(() => runtime.destroy());
    await runtime.initialize();
    const before = manager.profiles;
    await assert.rejects(runtime.configure(runtime.model!, false), (error: unknown) => error instanceof ChatStorageError && error.code === 'legacy-cleanup');
    assert.deepEqual(manager.profiles, before);
    assert.deepEqual(legacy.get('connection'), connection);
    assert.deepEqual(idb.databases.get(`${namespace}:profiles`)!.get('legacyMigration'), proof);
    assert.equal(runtime.persistenceWarning, false, 'a blocked destructive operation is not a successful RAM save');
    assert.equal(idb.versions.get(`${namespace}:chat`), 1);
    blocker.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(idb.versions.get(`${namespace}:chat`), 1, 'the rejected upgrade must abort if it becomes unblocked later');
    assert.deepEqual(legacy.get('connection'), connection);
    assert.deepEqual(idb.databases.get(`${namespace}:profiles`)!.get('legacyMigration'), proof);
    await runtime.configure(runtime.model!, false);
    assert.equal(idb.versions.get(`${namespace}:chat`), 2);
    assert.equal(manager.activeProfile.connection!.apiKey, undefined);
    assert.equal(legacy.has('connection'), false);
    assert.deepEqual(legacy.get('entries'), [entry('uncopied')]);
  });

  it('aborts a late timed-out upgrade transaction and closes its late result', async (t) => {
    installChatIndexedDB(t);
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let aborts = 0; let closes = 0;
    const database = { version: 2, objectStoreNames: { contains: () => true }, close() { closes++; } } as unknown as IDBDatabase;
    const request = { result: database, transaction: { abort() { aborts++; } } } as unknown as IDBOpenDBRequest;
    t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
      if (version !== 2) return open(name, version);
      started(); return request;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fence = fenceLegacyDatabase('late-upgrade:chat', () => false);
    await waiting;
    t.mock.timers.tick(IDB_OPEN_TIMEOUT_MS);
    assert.equal(await fence, undefined);
    request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent);
    assert.equal(aborts, 1);
    request.onsuccess?.call(request, new Event('success'));
    assert.ok(closes >= 1);
  });

  it('rediscovers the latest version when a racing fence overtakes the requested upgrade', async (t) => {
    const idb = installChatIndexedDB(t);
    idb.databases.set('race-fence:chat', new Map());
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    let raced = false;
    t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
      if (version !== 2 || raced) return open(name, version);
      raced = true;
      const request = { error: new DOMException('Version changed', 'VersionError') } as IDBOpenDBRequest;
      const other = open(name, 3);
      other.onsuccess = () => { other.result.close(); request.onerror?.call(request, new Event('error')); };
      return request;
    });
    const fenced = await fenceLegacyDatabase('race-fence:chat', () => false);
    assert.equal(fenced?.version, 3);
    fenced?.close();
  });
});
