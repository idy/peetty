import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { BrowserProfileStore } from '../src/chat/profiles.ts';
import type { MemoryEntry, ProfileRecord } from '../src/chat/profiles.ts';
import { BrowserChatStore } from '../src/chat/store.ts';
import type { StoredConnection } from '../src/chat/store.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB as indexedDBFixture } from './helpers/chat-storage.ts';

const entry = (id: string, text = id, createdAt = 1): ChatEntry => ({ id, role: 'user', text, createdAt });
const memory = (id: string, text = id, manual = true): MemoryEntry => ({ id, text, createdAt: 1, updatedAt: 2, manual });
const connection: StoredConnection = { id: 'example-model', baseUrl: 'https://example.test/v1', apiKey: 'test-secret-not-a-real-key', provider: 'openai-compatible', tools: false, effort: 'high' };
const decode = (text: string) => JSON.parse(text) as { format: string; version: number; activeProfileId: string; profiles: ProfileRecord[] };

async function store(t: TestContext, namespace = 'profiles', persist = true) {
  const result = new BrowserProfileStore(namespace, persist);
  t.after(() => result.close());
  await result.initialize();
  return result;
}
async function rejects(operation: () => unknown) {
  await assert.rejects(async () => { await operation(); }, /Invalid or unsupported profile data\.|Profile storage limit reached\.|no longer exists|last profile|already exists/);
}

describe('browser profile persistence', () => {
  it('migrates legacy history and keys once without applying runtime history bounds', async (t) => {
    const idb = indexedDBFixture(t);
    const legacy = new BrowserChatStore('migration');
    await legacy.saveConnection(connection);
    await legacy.saveEntries([entry('legacy')]);
    legacy.close();
    const history = Array.from({ length: 230 }, (_, i) => entry(`old-${i}`));
    idb.databases.get('migration:chat')!.set('entries', history);
    const first = new BrowserProfileStore('migration');
    t.after(() => first.close());
    await first.initialize({ name: 'Legacy pet', figure: 'koharu', personality: 'Be curious.' });
    assert.equal(first.profiles.length, 1);
    assert.equal(first.activeProfile.name, 'Legacy pet');
    assert.equal(first.activeProfile.figure, 'koharu');
    assert.equal(first.activeProfile.personality, 'Be curious.');
    assert.deepEqual(first.activeProfile.entries, history);
    assert.deepEqual(first.activeProfile.connection, connection);
    const second = await store(t, 'migration');
    assert.equal(second.activeProfile.id, first.activeProfile.id);
    assert.equal(second.profiles.length, 1);
    assert.equal(decode(await second.backup()).profiles[0]!.entries.length, 230);
    assert.deepEqual(idb.databases.get('migration:chat')!.get('entries'), history);
    assert.ok(idb.opened.includes('migration:profiles'));
  });

  it('initializes concurrently without duplicating migration or overwriting defaults', async (t) => {
    indexedDBFixture(t);
    const a = new BrowserProfileStore('first-open');
    const b = new BrowserProfileStore('first-open');
    t.after(() => { a.close(); b.close(); });
    await Promise.all([a.initialize({ name: 'First' }), b.initialize({ name: 'Second' })]);
    assert.equal(a.profiles.length, 1);
    assert.equal(b.profiles.length, 1);
    assert.equal(a.activeProfile.id, b.activeProfile.id);
    await a.initialize({ name: 'Ignored later defaults' });
    assert.equal(a.activeProfile.name, b.activeProfile.name);
  });

  it('isolates profile settings, histories, memories, and connections with cloned snapshots', async (t) => {
    const idb = indexedDBFixture(t);
    const manager = await store(t);
    const first = manager.activeProfile.id;
    await manager.storage(first).saveConnection(connection);
    await manager.storage(first).saveEntries([entry('first')]);
    await manager.saveMemory(first, { text: 'My favorite tea is green.' });
    const created = await manager.create({ name: '  Second  ', figure: 'elsie', personality: 'Gentle.' });
    assert.equal(manager.activeProfile.id, created.id);
    assert.equal(created.name, 'Second');
    created.name = 'outside mutation';
    const adapter = manager.storage(manager.activeProfile.id);
    await adapter.saveConnection({ id: 'another', baseUrl: 'http://localhost:9000', apiKey: 'another-test-secret' });
    const saving = adapter.saveEntries([entry('second')]);
    adapter.close();
    await saving;
    await manager.update(manager.activeProfile.id, { name: 'Renamed', useMemories: false, autoRemember: true });
    const snapshots = manager.profiles;
    snapshots[0]!.memories[0]!.text = 'outside mutation';
    await manager.select(first);
    assert.deepEqual(manager.activeProfile.entries, [entry('first')]);
    assert.equal(manager.activeProfile.memories[0]!.text, 'My favorite tea is green.');
    assert.deepEqual(manager.activeProfile.connection, connection);
    const second = manager.profiles.find((profile) => profile.id !== first)!;
    assert.equal(second.name, 'Renamed');
    assert.equal(second.useMemories, false);
    assert.equal(second.autoRemember, true);
    assert.deepEqual(second.entries, [entry('second')]);
    assert.equal(second.memories.length, 0);
    await manager.remove(first);
    assert.equal(manager.activeProfile.id, second.id);
    assert.equal(manager.persistenceWarning, false);
    assert.equal(idb.databases.get('profiles:profiles')!.has(`profile:${first}`), false);
    await rejects(() => manager.remove(second.id));
    await rejects(() => manager.storage(first).saveEntries([entry('resurrect')]));
    const reopened = await store(t);
    assert.deepEqual(reopened.profiles.map((profile) => profile.id), [second.id]);
  });

  it('persists each changed record without overwriting peer directory or settings changes', async (t) => {
    const idb = indexedDBFixture(t);
    const a = await store(t, 'records');
    const b = await store(t, 'records');
    const id = a.activeProfile.id;
    const [newA, newB] = await Promise.all([a.create({ name: 'A' }), b.create({ name: 'B' })]);
    await Promise.all([a.update(id, { personality: 'Updated personality' }), b.update(id, { name: 'Peer name' })]);
    const reader = await store(t, 'records');
    assert.equal(reader.profiles.length, 3);
    assert.ok(reader.profiles.some((profile) => profile.id === newA.id));
    assert.ok(reader.profiles.some((profile) => profile.id === newB.id));
    const profile = reader.profiles.find((profile) => profile.id === id)!;
    assert.equal(profile.name, 'Peer name');
    assert.equal(profile.personality, 'Updated personality');
    const writes = idb.writes.filter((write) => write.database === 'records:profiles').slice(-2);
    assert.deepEqual(writes.map((write) => write.keys.filter((key) => key.startsWith('profile:'))), [[`profile:${id}`], [`profile:${id}`]]);
    assert.ok(writes.every((write) => write.keys.every((key) => key === `profile:${id}` || key === 'directory')));
  });

  it('merges multiple runtime snapshots, partial replies, and omissions in committed order', async (t) => {
    indexedDBFixture(t);
    const a = await store(t, 'history');
    const b = await store(t, 'history');
    const id = a.activeProfile.id;
    const first = a.storage(id);
    const second = b.storage(id);
    await Promise.all([first.load(), second.load()]);
    const early = [entry('a', 'first', 100), { ...entry('reply', 'partial', 101), role: 'assistant' as const }];
    const late = [entry('b', 'second', 1)];
    await Promise.all([first.saveEntries(early), second.saveEntries(late)]);
    await first.saveEntries([early[0]!, { ...early[1]!, text: 'finished' }]);
    await second.saveEntries(late);
    await first.saveEntries([]);
    assert.deepEqual((await second.load()).entries.map((value) => value.text), ['first', 'finished', 'second']);
    // Snapshot entries unchanged by this client do not overwrite a peer's partial update.
    const peerSnapshot = (await first.load()).entries;
    await second.saveEntries((await second.load()).entries.map((value) => value.id === 'reply' ? { ...value, text: 'peer edit' } : value));
    await first.saveEntries([...peerSnapshot, entry('c')]);
    assert.deepEqual((await second.load()).entries.map((value) => value.text), ['first', 'peer edit', 'second', 'c']);
  });

  for (const operation of ['edit', 'remove', 'clear'] as const) {
    it(operation === 'clear' ? 'blocks all stale writes after a whole-history clear' : `preserves unrelated new entries after history ${operation} without undoing it`, async (t) => {
      indexedDBFixture(t);
      const manager = await store(t, `epoch-${operation}`);
      const peer = await store(t, `epoch-${operation}`);
      const id = manager.activeProfile.id;
      const first = manager.storage(id);
      const stale = peer.storage(id);
      const old = [entry('old'), { ...entry('reply', 'partial'), role: 'assistant' as const }];
      await first.saveEntries(old);
      await stale.load();
      await manager.update(id, { autoRemember: true });
      await manager.saveMemory(id, { text: 'A sourced memory', sourceEntryId: 'old', sourceText: 'old', manual: false });
      if (operation === 'edit') await manager.editEntry(id, 'old', 'corrected');
      else if (operation === 'remove') await manager.removeEntry(id, 'old');
      else await first.clearEntries();
      await stale.saveEntries([...old, entry('late-reply')]);
      const pending = stale.saveEntries([old[0]!, { ...old[1]!, text: 'late update' }]);
      stale.close();
      await pending;
      const updatedReply = { ...old[1]!, text: 'late update' };
      const expected = operation === 'edit' ? [{ ...old[0]!, text: 'corrected' }, updatedReply, entry('late-reply')]
        : operation === 'remove' ? [updatedReply, entry('late-reply')] : [];
      const fresh = peer.storage(id);
      assert.deepEqual((await fresh.load()).entries, expected);
      await fresh.saveEntries([...expected, entry('new-turn')]);
      assert.deepEqual((await first.load()).entries, [...expected, entry('new-turn')]);
      if (operation !== 'edit') {
        const savedMemory = manager.profiles.find((profile) => profile.id === id)!.memories[0]!;
        assert.equal(savedMemory.sourceEntryId, undefined);
        assert.equal(savedMemory.sourceText, 'old');
      }
    });
  }

  it('supports nonpersistent operation without opening IndexedDB or warning', async (t) => {
    const idb = indexedDBFixture(t);
    const first = await store(t, 'private', false);
    const id = first.activeProfile.id;
    await first.storage(id).saveEntries([entry('private')]);
    await first.storage(id).saveConnection(connection);
    await first.saveMemory(id, { text: 'Private memory' });
    const saved = await first.backup();
    const other = await store(t, 'private', false);
    await other.restore(saved);
    assert.equal(other.activeProfile.entries[0]!.text, 'private');
    assert.equal(other.activeProfile.connection!.apiKey, connection.apiKey);
    assert.equal(first.persistenceWarning, false);
    assert.equal(other.persistenceWarning, false);
    assert.deepEqual(idb.opened, []);
  });

  for (const failure of ['open', 'write', 'put', 'commit'] as const) {
    it(`falls back to memory after IndexedDB ${failure} failure, retaining the pending mutation`, async (t) => {
      const idb = indexedDBFixture(t);
      if (failure === 'open') idb.fail(failure);
      const manager = await store(t, `failed-${failure}`);
      const id = manager.activeProfile.id;
      const adapter = manager.storage(id);
      await adapter.load();
      const persistedBefore = structuredClone(idb.databases.get(`failed-${failure}:profiles`));
      const writesBefore = idb.writes.length;
      if (failure !== 'open') idb.fail(failure);
      await adapter.saveEntries([entry('kept')]);
      await adapter.saveConnection(connection);
      await manager.saveMemory(id, { text: 'Kept in memory' });
      assert.equal(manager.persistenceWarning, true);
      assert.equal(adapter.persistenceWarning, true);
      assert.deepEqual((await adapter.load()).entries, [entry('kept')]);
      assert.equal(decode(await manager.backup()).profiles[0]!.connection!.apiKey, connection.apiKey);
      assert.deepEqual(idb.databases.get(`failed-${failure}:profiles`), persistedBefore);
      assert.equal(idb.writes.length, writesBefore);
    });
  }
});

describe('profile selection and restored connection ownership', () => {
  it('keeps each open instance on its selected profile when another instance switches', async (t) => {
    indexedDBFixture(t);
    const first = new BrowserProfileStore('selected-tabs'); await first.initialize();
    const original = first.activeProfile.id;
    const second = new BrowserProfileStore('selected-tabs'); await second.initialize();
    t.after(() => { first.close(); second.close(); });
    const other = await second.create({ name: 'Other tab' });
    await first.storage(original).load();
    assert.equal(first.activeProfile.id, original);
    assert.equal(second.activeProfile.id, other.id);
    assert.equal(decode(await first.backup()).activeProfileId, original);
    assert.equal(decode(await second.backup()).activeProfileId, other.id);
  });
  it('retains restored auth headers when saving matching settings, and drops them on explicit removal', async () => {
    const store = new BrowserProfileStore('restored-header-save', false); await store.initialize();
    const original = store.activeProfile.id;
    const restoredConnection = { ...connection, headers: { 'x-api-key': 'fixture-header-secret' } };
    await store.restore(await store.backup({ sessions: [{ profileId: original, connection: restoredConnection, rememberKey: true }] }));
    const adapter = store.storage(store.activeProfile.id); await adapter.load();
    await adapter.saveConnection({ ...restoredConnection, effort: 'low' });
    assert.deepEqual((await adapter.load()).connection?.headers, restoredConnection.headers);
    await adapter.saveConnection({ ...connection, effort: 'low' });
    assert.equal((await adapter.load()).connection?.headers, undefined);
    store.close();
  });
});

describe('profile backup and memory portability', () => {
  it('roundtrips keys and every profile, remapping IDs and source refs without overwriting originals', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'backup');
    const firstId = manager.activeProfile.id;
    await manager.storage(firstId).saveConnection(connection);
    const entries = Array.from({ length: 240 }, (_, i) => entry(`entry-${i}`, `message ${i}`));
    await manager.storage(firstId).saveEntries(entries);
    await manager.update(firstId, { autoRemember: true });
    await manager.saveMemory(firstId, { text: 'Remembered fact', sourceEntryId: entries[0]!.id, sourceText: entries[0]!.text, manual: false });
    const second = await manager.create({ name: 'Another', figure: 'elsie', personality: 'Reserved' });
    await manager.storage(second.id).saveConnection({ id: 'model-b', baseUrl: 'https://second.test', apiKey: 'second-test-secret' });
    await manager.saveMemory(second.id, { text: 'Manual fact' });
    const text = await manager.backup();
    const saved = decode(text);
    assert.equal(saved.format, 'peetty-backup');
    assert.equal(saved.version, 2);
    assert.equal(saved.activeProfileId, second.id);
    assert.equal(saved.profiles[0]!.entries.length, 240);
    assert.equal(saved.profiles[0]!.connection!.apiKey, connection.apiKey);
    await manager.restore(text);
    assert.equal(manager.profiles.length, 4);
    assert.notEqual(manager.activeProfile.id, second.id);
    assert.equal(manager.activeProfile.name, 'Another');
    const originals = manager.profiles.slice(0, 2);
    assert.deepEqual(originals, saved.profiles);
    const restored = manager.profiles[2]!;
    assert.notEqual(restored.id, firstId);
    assert.deepEqual(restored.connection, connection);
    assert.deepEqual(restored.entries.map((value) => value.text), entries.map((value) => value.text));
    assert.ok(restored.entries.every((value) => !entries.some((old) => old.id === value.id)));
    assert.notEqual(restored.memories[0]!.id, originals[0]!.memories[0]!.id);
    assert.equal(restored.memories[0]!.sourceEntryId, restored.entries[0]!.id);
    assert.equal(restored.memories[0]!.sourceText, entries[0]!.text);
    await manager.restore(text);
    assert.equal(new Set(manager.profiles.map((profile) => profile.id)).size, 6);
    const reader = await store(t, 'backup');
    assert.deepEqual(reader.profiles, manager.profiles);
    assert.equal(reader.activeProfile.id, manager.activeProfile.id);
  });

  it('backs up explicit session keys and headers without automatically persisting SDK headers', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'override');
    const id = manager.activeProfile.id;
    await manager.storage(id).saveConnection({ ...connection, headers: { Authorization: 'do-not-persist' }, getApiKey: () => 'do-not-call' } as StoredConnection);
    assert.equal((manager.activeProfile.connection as StoredConnection & { headers?: unknown }).headers, undefined);
    const override = { ...connection, apiKey: 'session-only-test-secret', headers: { authorization: 'Bearer explicit-backup-test-secret', 'x-api-key': 'explicit-header-test-key' } };
    const backup = await manager.backup({ sessions: [{ profileId: id, connection: override, rememberKey: false }] });
    const saved = decode(backup);
    assert.deepEqual(saved.profiles[0]!.connection, connection);
    assert.equal(manager.activeProfile.connection!.apiKey, connection.apiKey);
    assert.equal(manager.activeProfile.connection!.headers, undefined);
    assert.deepEqual(decode(await manager.backup()).profiles[0]!.connection, connection);
    await manager.restore(backup);
    const loaded = await manager.storage(manager.activeProfile.id).load();
    assert.deepEqual(loaded.connection, connection);
    assert.deepEqual(loaded.sessionConnections, [{ connection: override, rememberKey: false }]);
    const reader = await store(t, 'override');
    assert.deepEqual(reader.activeProfile.connection, connection);
    assert.equal((await reader.storage(reader.activeProfile.id).load()).sessionConnections, undefined);
    assert.deepEqual(decode(await reader.backup()).profiles[1]!.connection, connection);
  });

  it('finishes queued adapter writes before backup and refreshes full manager state on load', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'queue');
    const peer = await store(t, 'queue');
    const id = manager.activeProfile.id;
    const adapter = manager.storage(id);
    const pending = adapter.saveEntries([entry('queued')]);
    const savingConnection = adapter.saveConnection(connection);
    adapter.close();
    const backup = decode(await manager.backup());
    await Promise.all([pending, savingConnection]);
    assert.deepEqual(backup.profiles[0]!.entries, [entry('queued')]);
    assert.deepEqual(backup.profiles[0]!.connection, connection);
    await peer.saveMemory(id, { text: 'Peer memory' });
    await peer.update(id, { name: 'Peer name' });
    await manager.storage(id).load();
    assert.equal(manager.activeProfile.name, 'Peer name');
    assert.equal(manager.activeProfile.memories[0]!.text, 'Peer memory');
    assert.deepEqual(manager.activeProfile.entries, [entry('queued')]);
  });

  it('preserves the source snapshot before editing an imported source entry', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'source-edit');
    const backup = decode(await manager.backup());
    backup.profiles[0]!.entries = [entry('source', 'Original source')];
    backup.profiles[0]!.memories = [{ ...memory('fact', 'A sourced fact', false), sourceEntryId: 'source' }];
    await manager.restore(JSON.stringify(backup));
    const id = manager.activeProfile.id;
    const sourceId = manager.activeProfile.entries[0]!.id;
    await manager.editEntry(id, sourceId, 'Corrected source');
    assert.equal(manager.activeProfile.memories[0]!.sourceText, 'Original source');
    await manager.removeEntry(id, sourceId);
    assert.equal(manager.activeProfile.memories[0]!.sourceEntryId, undefined);
    assert.equal(manager.activeProfile.memories[0]!.sourceText, 'Original source');
  });

  it('backs up the latest committed peer history rather than a cached snapshot', async (t) => {
    indexedDBFixture(t);
    const first = await store(t, 'fresh-backup');
    const second = await store(t, 'fresh-backup');
    await second.storage(second.activeProfile.id).saveEntries([entry('peer-only')]);
    assert.deepEqual(first.activeProfile.entries, []);
    const saved = decode(await first.backup());
    assert.deepEqual(saved.profiles[0]!.entries, [entry('peer-only')]);
  });

  it('rejects malformed or unsupported backups atomically with sanitized errors', async (t) => {
    const idb = indexedDBFixture(t);
    const manager = await store(t, 'invalid');
    const id = manager.activeProfile.id;
    await manager.storage(id).saveConnection(connection);
    await manager.storage(id).saveEntries([entry('saved')]);
    const valid = decode(await manager.backup());
    const before = manager.profiles;
    const beforeActive = manager.activeProfile.id;
    const invalid = [
      '{invalid test-secret-not-a-real-key',
      JSON.stringify({ ...valid, version: 3 }),
      JSON.stringify({ ...valid, format: 'other' }),
      JSON.stringify({ ...valid, activeProfileId: 'absent' }),
      JSON.stringify({ ...valid, profiles: [] }),
      JSON.stringify({ ...valid, profiles: [...valid.profiles, valid.profiles[0]] }),
      JSON.stringify({ ...valid, profiles: [valid.profiles[0], { ...valid.profiles[0], id: 'bad', name: null }] }),
      JSON.stringify({ ...valid, createdAt: null }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], entries: [entry('same'), entry('same')] }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], entries: [{ ...entry('bad'), role: 'system' }] }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], entries: [{ ...entry('bad'), role: 'action', text: 'execute' }] }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], entries: [{ ...entry('bad'), createdAt: null }] }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], connection: { ...connection, baseUrl: 'javascript:secret' } }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], connection: { ...connection, headers: { Authorization: `${connection.apiKey}\r\nInjected: bad` } } }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], connection: { ...connection, headers: { 'bad header name': connection.apiKey } } }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], connection: { ...connection, headers: { Authorization: 123 } } }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], memories: [memory('a'), { ...memory('b'), manual: 'false' }] }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], personality: 'x'.repeat(16_001) }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], memories: Array.from({ length: 1_001 }, (_, i) => memory(`m-${i}`)) }] }),
      ' '.repeat(50 * 1024 * 1024 + 1),
    ];
    const writesBefore = idb.writes.length;
    for (const text of invalid) {
      await assert.rejects(async () => manager.restore(text), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Invalid or unsupported profile data.');
        assert.equal(error.message.includes(connection.apiKey!), false);
        return true;
      });
      assert.deepEqual(manager.profiles, before);
      assert.equal(manager.activeProfile.id, beforeActive);
    }
    assert.equal(idb.writes.length, writesBefore);
    const reader = await store(t, 'invalid');
    assert.deepEqual(reader.profiles, before);
  });

  it('rejects profile capacity overflow without a partial restore', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'capacity');
    await manager.markBootstrapUsed();
    const saved = decode(await manager.backup());
    const oversized = { ...saved, profiles: Array.from({ length: 100 }, (_, i) => ({ ...saved.profiles[0]!, id: `profile-${i}` })), activeProfileId: 'profile-0' };
    await rejects(() => manager.restore(JSON.stringify(oversized)));
    assert.equal(manager.profiles.length, 1);
  });

  it('deduplicates normalized memories and protects manual facts from automatic updates', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'memories');
    const id = manager.activeProfile.id;
    await manager.update(id, { autoRemember: true });
    await manager.saveMemory(id, { text: '  I Like TEA.  ', manual: true });
    const original = manager.activeProfile.memories[0]!;
    await manager.saveMemory(id, { text: 'i like  tea.', manual: false, sourceText: 'automatic replacement' });
    await manager.saveMemory(id, { id: original.id, text: 'Coffee instead', manual: false });
    assert.deepEqual(manager.activeProfile.memories, [original]);
    await manager.saveMemory(id, { text: 'I like biscuits.', manual: false });
    const automatic = manager.activeProfile.memories[1]!;
    await manager.saveMemory(id, { id: automatic.id, text: 'I like cookies.', manual: true });
    assert.equal(manager.activeProfile.memories[1]!.manual, true);
    assert.equal(manager.activeProfile.memories[1]!.text, 'I like cookies.');
    await rejects(() => manager.saveMemory(id, { id: automatic.id, text: 'i like tea.' }));
    await rejects(() => manager.saveMemory(id, { text: 'x'.repeat(8_001) }));
    await manager.removeMemory(id, original.id);
    assert.equal(manager.activeProfile.memories.length, 1);
    await manager.saveMemory(id, { text: 'Ｉ LIKE COOKIES.', manual: false });
    assert.equal(manager.activeProfile.memories.length, 1);
  });

  it('merges concurrent memory changes and history writes without losing either', async (t) => {
    indexedDBFixture(t);
    const first = await store(t, 'memory-peers');
    const second = await store(t, 'memory-peers');
    const id = first.activeProfile.id;
    await Promise.all([
      first.saveMemory(id, { text: 'First memory' }), second.saveMemory(id, { text: 'Second memory' }),
      first.storage(id).saveEntries([entry('turn')]), second.storage(id).saveConnection(connection),
    ]);
    const saved = decode(await first.backup()).profiles[0]!;
    assert.deepEqual(saved.memories.map((memory) => memory.text).sort(), ['First memory', 'Second memory']);
    assert.deepEqual(saved.entries, [entry('turn')]);
    assert.deepEqual(saved.connection, connection);
  });

  it('exports portable source text, imports with fresh IDs, deduplicates, and ignores foreign source IDs', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'memory-export');
    const source = manager.activeProfile.id;
    await manager.storage(source).saveEntries([entry('source-message', 'I love jasmine tea.')]);
    await manager.update(source, { autoRemember: true });
    await manager.saveMemory(source, { text: 'Likes jasmine tea', sourceEntryId: 'source-message', sourceText: 'I love jasmine tea.', manual: false });
    const original = manager.activeProfile.memories[0]!;
    const exported = await manager.exportMemories(source);
    const document = JSON.parse(exported) as { format: string; version: number; memories: MemoryEntry[] };
    assert.equal(document.format, 'peetty-memories');
    assert.equal(document.version, 1);
    assert.equal(document.memories[0]!.sourceText, 'I love jasmine tea.');
    assert.equal(document.memories[0]!.sourceEntryId, undefined);
    const destination = await manager.create({ name: 'Destination' });
    // Even a coincidentally matching local entry ID cannot claim the imported source.
    await manager.storage(destination.id).saveEntries([entry('source-message', 'unrelated local text')]);
    document.memories[0]!.sourceEntryId = 'source-message';
    await manager.importMemories(destination.id, JSON.stringify(document));
    await manager.importMemories(destination.id, exported);
    const imported = manager.activeProfile.memories;
    assert.equal(imported.length, 1);
    assert.notEqual(imported[0]!.id, original.id);
    assert.equal(imported[0]!.sourceEntryId, undefined);
    assert.equal(imported[0]!.sourceText, 'I love jasmine tea.');
    assert.equal(imported[0]!.manual, false);
    assert.deepEqual(manager.profiles.find((profile) => profile.id === source)!.memories, [original]);
    await manager.importMemories(destination.id, JSON.stringify({ ...document, memories: [{ ...memory('manual', 'LIKES JASMINE TEA'), sourceText: 'manual source' }] }));
    assert.equal(manager.activeProfile.memories[0]!.manual, true);
    assert.equal(manager.activeProfile.memories[0]!.sourceText, 'manual source');
  });

  it('rejects malformed memory documents and merged count overflow atomically', async (t) => {
    indexedDBFixture(t);
    const manager = await store(t, 'memory-validation');
    const id = manager.activeProfile.id;
    await manager.saveMemory(id, { text: 'Existing manual memory' });
    const before = manager.activeProfile.memories;
    const valid = { format: 'peetty-memories', version: 1, memories: [memory('new')] };
    for (const document of [
      { ...valid, version: 2 }, { ...valid, format: 'peetty-backup' },
      { ...valid, memories: [memory('new'), { ...memory('bad'), text: '' }] },
      { ...valid, memories: [memory('same'), memory('same')] },
      { ...valid, memories: [memory('new'), { ...memory('bad'), updatedAt: null }] },
      { ...valid, memories: Array.from({ length: 1_000 }, (_, i) => memory(`new-${i}`)) },
    ]) {
      await rejects(() => manager.importMemories(id, JSON.stringify(document)));
      assert.deepEqual(manager.activeProfile.memories, before);
    }
    const reader = await store(t, 'memory-validation');
    assert.deepEqual(reader.activeProfile.memories, before);
  });
});
