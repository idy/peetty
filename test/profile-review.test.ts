import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Figure } from '../src/figure/types.ts';
import { BrowserProfileStore, PROFILE_LIMITS } from '../src/chat/profiles.ts';
import type { BackupSession, MemoryEntry, ProfileRecord } from '../src/chat/profiles.ts';
import { BrowserChatStore, boundedEntries } from '../src/chat/store.ts';
import { openStateDatabase } from '../src/chat/idb.ts';
import type { StoredConnection } from '../src/chat/store.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';

const entry = (id: string, text = id, createdAt = 1): ChatEntry => ({ id, role: 'user', text, createdAt });
const fact = (id: string, text = id): MemoryEntry => ({ id, text, createdAt: 1, updatedAt: 2, manual: true });
const connection: StoredConnection = { id: 'example-model', baseUrl: 'https://example.test/v1', apiKey: 'saved-fixture-key' };
const profile = (id: string, patch: Partial<ProfileRecord> = {}): ProfileRecord => ({
  id, name: id, figure: 'miru', personality: '', useMemories: true, autoRemember: false, memories: [], entries: [], createdAt: 1, updatedAt: 1, ...patch,
});
interface Backup { version: number; activeProfileId: string; profiles: ProfileRecord[]; sessions?: BackupSession[] }
const decode = (value: string): Backup => JSON.parse(value) as Backup;
const document = (profiles: ProfileRecord[], sessions?: BackupSession[]): string => JSON.stringify({
  format: 'peetty-backup', version: sessions ? 2 : 1, createdAt: 1, activeProfileId: profiles.at(-1)!.id, profiles, ...(sessions ? { sessions } : {}),
});
async function store(t: TestContext, namespace = 'regressions', persist = true): Promise<BrowserProfileStore> {
  const result = new BrowserProfileStore(namespace, persist);
  t.after(() => result.close());
  await result.initialize();
  return result;
}
const fullBackup = (): string => document(Array.from({ length: PROFILE_LIMITS.profiles }, (_, i) => profile(`import-${i}`)));


describe('archive mutation regressions', () => {
  it('applies only marked mutations from a runtime view and preserves complete archived text', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t);
    const id = manager.activeProfileId;
    const archive = Array.from({ length: 250 }, (_, i) => entry(`archive-${i}`, i === 249 ? 'long '.repeat(6_000) : `Full entry ${i}`));
    await manager.storage(id).saveEntries(archive);
    const runtime = manager.storage(id);
    const loaded = (await runtime.load()).entries;
    const view = boundedEntries(loaded);
    assert.equal(view.length, 200);
    assert.ok(view.at(-1)!.text.length < archive.at(-1)!.text.length);
    const user = entry('new-user');
    const reply = { ...entry('new-reply', 'partial'), role: 'assistant' as const };
    await runtime.saveEntries([...view, user, reply], [user.id, reply.id]);
    await runtime.saveEntries(boundedEntries([...view, user, { ...reply, text: 'complete' }]), [reply.id]);
    assert.deepEqual((await manager.storage(id).load()).entries, [...archive, user, { ...reply, text: 'complete' }]);
    assert.equal(decode(await manager.backup()).profiles[0]!.entries.at(-3)!.text, archive.at(-1)!.text);
  });

  it('protects stale edits and deleted IDs without rejecting unrelated appends or streams', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t);
    const peer = await store(t);
    const id = manager.activeProfileId;
    const old = [entry('edited'), entry('deleted'), entry('stream', 'partial')];
    await manager.storage(id).saveEntries(old);
    const stale = peer.storage(id);
    await stale.load();
    await manager.editEntry(id, 'edited', 'User correction');
    await manager.removeEntry(id, 'deleted');
    await stale.saveEntries([{ ...old[0]!, text: 'stale correction' }, { ...old[1]!, text: 'stale deletion' }, { ...old[2]!, text: 'completed' }, entry('new')], ['edited', 'deleted', 'stream', 'new']);
    await stale.saveEntries([{ ...old[0]!, text: 'another stale correction' }, { ...old[1]!, text: 'another stale deletion' }, entry('unrelated')], ['edited', 'deleted', 'unrelated']);
    assert.deepEqual((await manager.storage(id).load()).entries, [entry('edited', 'User correction'), entry('stream', 'completed'), entry('new'), entry('unrelated')]);
    // Omitted records remain archived for callers that do not use a mask.
    await stale.saveEntries([entry('new', 'direct edit')]);
    await stale.saveEntries([]);
    assert.deepEqual((await manager.storage(id).load()).entries, [entry('edited', 'User correction'), entry('stream', 'completed'), entry('new', 'direct edit'), entry('unrelated')]);
  });

  it('keeps the whole-clear barrier against repeated late writes, then accepts a refreshed client', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t);
    const peer = await store(t);
    const id = manager.activeProfileId;
    const writer = manager.storage(id);
    await writer.saveEntries([entry('old')]);
    const stale = peer.storage(id); await stale.load();
    await writer.clearEntries();
    await stale.saveEntries([entry('old', 'late edit'), entry('late-new')], ['old', 'late-new']);
    await stale.saveEntries([entry('late-new', 'late update'), entry('another-late')], ['late-new', 'another-late']);
    assert.deepEqual((await writer.load()).entries, []);
    await stale.load();
    await stale.saveEntries([entry('fresh')], ['fresh']);
    assert.deepEqual((await writer.load()).entries, [entry('fresh')]);
  });

  it('shares masked merges with the legacy store while retaining direct merge and history bounds', async (t) => {
    installChatIndexedDB(t);
    const legacy = new BrowserChatStore('legacy-mask'); t.after(() => legacy.close());
    await legacy.saveEntries([entry('kept')]); await legacy.load();
    await legacy.saveEntries([entry('kept', 'unmarked edit'), entry('new')], ['new']);
    assert.deepEqual((await legacy.load()).entries, [entry('kept'), entry('new')]);
    await legacy.saveEntries([entry('kept', 'direct edit')]);
    assert.deepEqual((await legacy.load()).entries, [entry('kept', 'direct edit'), entry('new')]);
    await legacy.saveEntries(Array.from({ length: 250 }, (_, i) => entry(`bounded-${i}`)));
    assert.equal((await legacy.load()).entries.length, 200);
  });
});

describe('saved and ephemeral connection regressions', () => {
  it('canonicalizes restored URLs and retains only headers owned by the latest restored session', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t);
    const saved = { ...connection, baseUrl: 'https://EXAMPLE.test/v1/chat/completions/', headers: { 'x-api-key': 'saved-header', 'x-version': '1' } };
    const session = { ...connection, baseUrl: 'https://example.test/v1/models', apiKey: 'ephemeral-key', headers: { Authorization: 'Bearer ephemeral-header', 'X-Version': '2' } };
    await manager.restore(document([profile('original', { connection: saved })], [{ profileId: 'original', connection: session, rememberKey: false }]));
    const id = manager.activeProfileId;
    const adapter = manager.storage(id);
    const loaded = await adapter.load();
    assert.equal(loaded.connection!.baseUrl, connection.baseUrl);
    assert.equal(loaded.sessionConnections![0]!.connection.baseUrl, connection.baseUrl);
    await adapter.saveConnection({ ...connection, headers: { authorization: 'Bearer ephemeral-header', 'x-version': '2', 'x-fresh': 'SDK-only' } });
    const accepted = await adapter.load();
    assert.deepEqual(accepted.connection!.headers, { authorization: 'Bearer ephemeral-header', 'x-version': '2' });
    assert.equal(accepted.sessionConnections, undefined);
    await adapter.saveConnection({ ...connection, headers: { 'x-version': '2' }, effort: 'low' }, { rememberCredentials: true });
    assert.deepEqual((await adapter.load()).connection!.headers, { 'x-version': '2' });
    await adapter.saveConnection({ ...connection, headers: { 'x-version': '2', authorization: 'new SDK credential' } }, { rememberCredentials: false });
    assert.equal((await adapter.load()).connection!.apiKey, undefined);
    assert.deepEqual((await adapter.load()).connection!.headers, { 'x-version': '2' });
  });

  it('honors explicit credential removal for both stores and never persists fresh SDK headers', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t);
    const id = manager.activeProfileId;
    await manager.storage(id).saveConnection({ ...connection, headers: { authorization: 'fresh SDK header' } }, { rememberCredentials: true });
    assert.equal(manager.storedConnection(id)!.headers, undefined);
    await manager.restore(document([profile('auth', { connection: { ...connection, headers: { authorization: 'Bearer restored', 'x-version': '1' } } })]));
    const restoredId = manager.activeProfileId;
    await manager.storage(restoredId).saveConnection({ ...connection, headers: { authorization: 'Bearer restored', 'x-version': '1' } }, { rememberCredentials: false });
    assert.deepEqual(manager.storedConnection(restoredId), { id: connection.id, baseUrl: connection.baseUrl, headers: { 'x-version': '1' } });
    idb.databases.set('legacy-credentials:chat', new Map([['connection', { ...connection, baseUrl: 'https://example.test/v1/models', headers: { authorization: 'Bearer restored', 'x-version': '1' } }]]));
    const legacy = new BrowserChatStore('legacy-credentials'); t.after(() => legacy.close());
    await legacy.load();
    await legacy.saveConnection({ ...connection, headers: { authorization: 'Bearer restored', 'x-version': '1' } }, { rememberCredentials: false });
    assert.deepEqual((await legacy.load()).connection, { id: connection.id, baseUrl: connection.baseUrl, headers: { 'x-version': '1' } });
  });

  it('preserves saved connections and every distinct RAM session through successive complete backups', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'session-source');
    const id = manager.activeProfileId;
    await manager.storage(id).saveConnection(connection);
    const first = { ...connection, apiKey: 'session-one', headers: { authorization: 'Bearer one' } };
    const second = { ...connection, apiKey: 'session-two', headers: { 'x-api-key': 'two' } };
    const backup = await manager.backup({ sessions: [{ profileId: id, connection: first, rememberKey: false }, { profileId: id, connection: second, rememberKey: true }] });
    assert.equal(decode(backup).version, 2);
    assert.deepEqual(decode(backup).profiles[0]!.connection, connection);
    const restored = await store(t, 'session-restored');
    await restored.restore(backup);
    const restoredId = restored.activeProfileId;
    const loaded = await restored.storage(restoredId).load();
    assert.deepEqual(loaded.connection, connection);
    assert.deepEqual(loaded.sessionConnections, [{ connection: first, rememberKey: false }, { connection: second, rememberKey: true }]);
    loaded.sessionConnections![0]!.connection.apiKey = 'external mutation';
    assert.equal((await restored.storage(restoredId).load()).sessionConnections![0]!.connection.apiKey, 'session-one');
    assert.equal(JSON.stringify([...idb.databases.get('session-restored:profiles')!]).includes('session-one'), false);
    assert.equal(JSON.stringify([...idb.databases.get('session-restored:profiles')!]).includes('session-two'), false);
    const reopened = await store(t, 'session-restored');
    assert.deepEqual((await reopened.storage(restoredId).load()).connection, connection);
    assert.equal((await reopened.storage(restoredId).load()).sessionConnections, undefined);
    const third = { ...connection, apiKey: 'session-three' };
    const next = decode(await restored.backup({ sessions: [
      { profileId: restoredId, connection: third, rememberKey: false },
      { profileId: restoredId, connection: { ...first, baseUrl: 'https://EXAMPLE.test/v1/chat/completions/', headers: { Authorization: 'Bearer one' }, tools: true }, rememberKey: false },
    ] }));
    assert.equal(next.sessions!.length, 3);
    assert.deepEqual(next.sessions!.map((session) => session.connection.apiKey), ['session-two', 'session-three', 'session-one']);
    assert.equal(next.sessions!.at(-1)!.rememberKey, false);
    assert.deepEqual(next.profiles.find((value) => value.id === restoredId)!.connection, connection);
    const final = await store(t, 'session-final');
    await final.restore(JSON.stringify({ format: 'peetty-backup', createdAt: 1, ...next }));
    assert.equal((await final.storage(final.activeProfileId).load()).sessionConnections!.length, 3);
    assert.deepEqual(final.storedConnection(final.activeProfileId), connection);
  });

  it('prunes restored and SDK sessions for profiles deleted while a backup was being prepared', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'deleted-session');
    await manager.restore(document([profile('ephemeral')], [{ profileId: 'ephemeral', connection: { ...connection, apiKey: 'deleted-ephemeral' }, rememberKey: false }]));
    const deleted = manager.activeProfileId;
    const peer = await store(t, 'deleted-session');
    await peer.remove(deleted);
    const saved = decode(await manager.backup({ sessions: [{ profileId: deleted, connection, rememberKey: false }] }));
    assert.equal(saved.profiles.some((value) => value.id === deleted), false);
    assert.equal(saved.sessions?.some((value) => value.profileId === deleted) ?? false, false);
    assert.equal((await manager.backup()).includes('deleted-ephemeral'), false);
  });

  it('roundtrips model-valid long credentials and rejects malformed session tails atomically', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'long-session');
    const id = manager.activeProfileId;
    const long = { ...connection, apiKey: 'k'.repeat(16_500), headers: { 'x-api-key': 'h'.repeat(17_000) } };
    const saved = await manager.backup({ sessions: [{ profileId: id, connection: long, rememberKey: false }] });
    const destination = await store(t, 'long-destination');
    await destination.restore(saved);
    assert.deepEqual((await destination.storage(destination.activeProfileId).load()).sessionConnections![0]!.connection, long);
    const before = decode(await destination.backup());
    const writes = idb.writes.length;
    const valid = decode(saved);
    for (const invalid of [
      { profileId: id, connection: long, rememberKey: 'false' },
      { profileId: 'foreign-profile', connection: long, rememberKey: false },
      { profileId: id, connection: { ...long, headers: { authorization: 'private\r\nInjected: bad' } }, rememberKey: false },
    ]) {
      await assert.rejects(destination.restore(JSON.stringify({ format: 'peetty-backup', createdAt: 1, ...valid, sessions: [...valid.sessions!, invalid] })), { message: 'Invalid or unsupported profile data.' });
      const after = decode(await destination.backup());
      assert.deepEqual(after.profiles, before.profiles);
      assert.deepEqual(after.sessions, before.sessions);
      assert.equal(after.activeProfileId, before.activeProfileId);
    }
    assert.equal(idb.writes.length, writes);
  });
});

describe('figures, memories, and authoritative exports', () => {
  it('retains detached inline figures and long HTTP and relative references', async (t) => {
    installChatIndexedDB(t);
    const figure = JSON.parse(await readFile(new URL('../figures/miru.json', import.meta.url), 'utf8')) as Figure;
    const expected = structuredClone(figure);
    const manager = new BrowserProfileStore('figures'); t.after(() => manager.close());
    await manager.initialize({ figure });
    figure.palette.hair = '#000';
    assert.deepEqual(manager.profileInfo(manager.activeProfileId)!.figure, expected);
    const info = manager.profileInfo(manager.activeProfileId)!;
    (info.figure as Figure).palette.hair = '#fff';
    assert.deepEqual(manager.profileInfo(manager.activeProfileId)!.figure, expected);
    const remote = `https://figures.example.test/pet.json?signature=${'x'.repeat(351)}`;
    const created = await manager.create({ name: 'Custom', figure: remote });
    assert.equal(created.figure, remote);
    const relative = `./figures/pet.json?signature=${'x'.repeat(351)}`;
    await manager.update(created.id, { figure: relative });
    assert.equal(manager.profileInfo(created.id)!.figure, relative);
    await manager.restore(await manager.backup());
    assert.deepEqual(manager.profiles.find((value) => value.id !== manager.listProfiles()[0]!.id && typeof value.figure === 'object')!.figure, expected);
    const before = manager.listProfiles();
    await assert.rejects(manager.create({ name: 'Invalid', figure: { ...expected, palette: { hair: 'private-secret-invalid-color' } } }), { message: 'Invalid or unsupported profile data.' });
    assert.deepEqual(manager.listProfiles(), before);
  });

  it('checks the latest automatic-memory setting and exact source inside its write transaction', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'automatic');
    const id = manager.activeProfileId;
    await manager.update(id, { autoRemember: true });
    const adapter = manager.storage(id);
    await adapter.saveEntries([entry('source', 'I like tea.')]);
    const peer = await store(t, 'automatic');
    await peer.update(id, { autoRemember: false });
    assert.equal(manager.autoRememberEnabled(id), true);
    await assert.rejects(manager.saveMemory(id, { text: 'Likes tea', sourceEntryId: 'source', sourceText: 'I like tea.', manual: false }), { message: 'Automatic memory is disabled.' });
    await manager.saveMemory(id, { text: 'Manual while disabled' });
    await manager.importMemories(id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: [{ ...fact('imported', 'Imported while disabled'), manual: false }] }));
    await peer.update(id, { autoRemember: true });
    await peer.editEntry(id, 'source', 'I like coffee.');
    await assert.rejects(manager.saveMemory(id, { text: 'Stale tea', sourceEntryId: 'source', sourceText: 'I like tea.', manual: false }), { message: 'The source message no longer matches.' });
    await assert.rejects(manager.saveMemory(id, { text: 'Missing snapshot', sourceEntryId: 'source', manual: false }), { message: 'The source message no longer matches.' });
    await manager.saveMemory(id, { text: 'Likes coffee', sourceEntryId: 'source', sourceText: 'I like coffee.', manual: false });
    await peer.storage(id).clearEntries();
    await assert.rejects(manager.saveMemory(id, { text: 'Cleared coffee', sourceEntryId: 'source', sourceText: 'I like coffee.', manual: false }), { message: 'The source message no longer matches.' });
    assert.deepEqual(manager.memoryTexts(id).map((memory) => memory.text), ['Manual while disabled', 'Imported while disabled', 'Likes coffee']);
  });

  it('exports queued writes and latest peer changes with portable source metadata in JSON and Markdown', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'fresh-memory-export');
    await manager.restore(document([profile('sourced', { entries: [entry('source', 'Original\nsource')], memories: [{ ...fact('memory', 'A sourced fact'), sourceEntryId: 'source' }] })]));
    const id = manager.activeProfileId;
    const peer = await store(t, 'fresh-memory-export');
    const pending = manager.saveMemory(id, { text: 'Queued memory' });
    const exported = manager.exportMemories(id);
    await pending;
    assert.equal((JSON.parse(await exported) as { memories: MemoryEntry[] }).memories.length, 2);
    await peer.saveMemory(id, { text: 'Peer memory' });
    await peer.update(id, { name: 'Fresh name' });
    const fresh = JSON.parse(await manager.exportMemories(id)) as { memories: MemoryEntry[] };
    assert.deepEqual(fresh.memories.map((memory) => memory.text), ['A sourced fact', 'Queued memory', 'Peer memory']);
    assert.equal(fresh.memories[0]!.sourceText, 'Original\nsource');
    assert.equal(fresh.memories[0]!.sourceEntryId, undefined);
    assert.equal(fresh.memories[0]!.createdAt, 1);
    const markdown = await manager.exportMemoryMarkdown(id);
    assert.match(markdown, /^# Fresh name memories/u);
    assert.ok(markdown.includes('A sourced fact'));
    assert.ok(markdown.includes('> Original\n> source'));
    assert.ok(markdown.includes('Peer memory'));
    const destination = await manager.create({ name: 'Destination' });
    await manager.importMemories(destination.id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: fresh.memories }));
    await manager.importMemories(destination.id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: [{ ...fact('duplicate', 'Ａ SOURCED FACT'), sourceText: 'Do not replace manual source' }] }));
    assert.equal(manager.memoryPage(destination.id, '', 10).entries.length, 3);
    assert.equal(manager.memoryPage(destination.id, '', 10).entries[0]!.sourceText, 'Original\nsource');
    await peer.remove(id);
    await assert.rejects(manager.exportMemories(id), /no longer exists/u);
    await assert.rejects(manager.exportMemoryMarkdown(id), /no longer exists/u);
  });
});

describe('narrow reads and copy-on-write storage', () => {
  it('provides live detached metadata, memory pages and reverse committed history pages', async (t) => {
    const manager = await store(t, 'narrow', false);
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries([entry('first', 'Match first', 500), entry('second', 'unrelated', 1), entry('third', 'MATCH third', 100)]);
    await manager.storage(id).saveConnection(connection);
    for (const text of ['First memory', 'Second memory', 'Third memory']) await manager.saveMemory(id, { text });
    const info = manager.profileInfo(id)!;
    assert.equal(info.entryCount, 3); assert.equal(info.memoryCount, 3);
    assert.equal('entries' in info, false); assert.equal('memories' in info, false); assert.equal('connection' in info, false);
    info.name = 'external';
    const list = manager.listProfiles(); list[0]!.name = 'external';
    assert.equal(manager.profileInfo(id)!.name, 'Miru');
    const saved = manager.storedConnection(id)!; saved.apiKey = 'external';
    assert.equal(manager.storedConnection(id)!.apiKey, connection.apiKey);
    assert.deepEqual(manager.historyPage(id, '', 2), { entries: [entry('third', 'MATCH third', 100), entry('second', 'unrelated', 1)], hasMore: true });
    assert.deepEqual(manager.historyPage(id, 'match', 1), { entries: [entry('third', 'MATCH third', 100)], hasMore: true });
    const memories = manager.memoryPage(id, 'memory', 2);
    assert.deepEqual(memories.entries.map((memory) => memory.text), ['First memory', 'Second memory']);
    assert.equal(memories.hasMore, true);
    memories.entries[0]!.text = 'external';
    const texts = manager.memoryTexts(id); texts[0]!.text = 'external';
    assert.equal(manager.memoryTexts(id)[0]!.text, 'First memory');
    assert.equal(manager.sourceText(id, 'first'), 'Match first');
    await manager.editEntry(id, 'first', 'New source');
    assert.equal(manager.sourceText(id, 'first'), 'New source');
    await manager.update(id, { autoRemember: true, useMemories: false });
    assert.equal(manager.autoRememberEnabled(id), true); assert.equal(manager.memoryEnabled(id), false);
    await manager.create({ name: 'Keep' }); await manager.remove(id);
    assert.equal(manager.profileInfo(id), undefined); assert.equal(manager.storedConnection(id), undefined);
    assert.equal(manager.sourceText(id, 'first'), undefined); assert.equal(manager.autoRememberEnabled(id), false); assert.equal(manager.memoryEnabled(id), false);
    assert.deepEqual(manager.memoryTexts(id), []); assert.deepEqual(manager.memoryPage(id, '', 2), { entries: [], hasMore: false });
    assert.deepEqual(manager.historyPage(id, '', 2), { entries: [], hasMore: false });
  });

  it('stops page search after one lookahead and avoids lowercasing for empty searches', async (t) => {
    const manager = await store(t, 'page-cost', false);
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries(Array.from({ length: 100 }, (_, i) => entry(`item-${i}`, `match ${i}`)));
    const lower = t.mock.method(String.prototype, 'toLocaleLowerCase');
    const copy = t.mock.method(globalThis, 'structuredClone');
    assert.equal(manager.historyPage(id, '', 2).entries.length, 2);
    assert.equal(lower.mock.callCount(), 0);
    assert.equal(copy.mock.callCount(), 2);
    copy.mock.resetCalls();
    assert.equal(manager.historyPage(id, 'MATCH', 2).entries.length, 2);
    assert.equal(lower.mock.callCount(), 4); // Query, two returned matches, one lookahead.
    assert.equal(copy.mock.callCount(), 2);
  });

  it('does not deep-clone histories on metadata reads or in-memory settings and memory writes', async (t) => {
    const manager = await store(t, 'copy-cost', false);
    const first = manager.activeProfileId;
    await manager.storage(first).saveEntries([entry('first')]);
    const second = (await manager.create({ name: 'Untouched' })).id;
    await manager.storage(second).saveEntries([entry('unrelated-marker')]);
    const copied: unknown[] = [];
    const original = globalThis.structuredClone;
    t.mock.method(globalThis, 'structuredClone', <T>(value: T): T => { copied.push(value); return original(value); });
    await manager.backup(); await manager.exportMemories(first); await manager.exportMemoryMarkdown(first); await manager.select(first);
    assert.equal(copied.length, 0);
    await manager.update(first, { name: 'Changed' });
    assert.equal(copied.length, 0);
    assert.equal(manager.profileInfo(first)!.name, 'Changed');
    assert.equal(manager.profileInfo(second)!.name, 'Untouched');
    await manager.saveMemory(first, { text: 'Existing memory' });
    const memoryId = manager.memoryPage(first, '', 1).entries[0]!.id;
    copied.length = 0;
    await manager.saveMemory(first, { id: memoryId, text: 'Changed memory' });
    assert.equal(copied.length, 0);
    const before = manager.profiles;
    await assert.rejects(manager.importMemories(first, JSON.stringify({ format: 'peetty-memories', version: 1, memories: Array.from({ length: 1_000 }, (_, i) => fact(`f-${i}`)) })), /limit/u);
    assert.deepEqual(manager.profiles, before);
    // A failing mutation after touching a record must leave the previous state intact.
    await assert.rejects(manager.editEntry(first, 'missing', 'rejected'), /no longer exists/u);
    assert.deepEqual(manager.profiles, before);
  });

  for (const failure of ['write', 'put', 'commit'] as const) {
    it(`retains a queued mutation in isolated fallback memory after ${failure} failure`, async (t) => {
      const idb = installChatIndexedDB(t);
      const manager = await store(t, `fallback-${failure}`);
      const first = manager.activeProfileId;
      const other = (await manager.create({ name: 'Other' })).id;
      await manager.storage(first).saveEntries([entry('before')]);
      const storedBefore = structuredClone(idb.databases.get(`fallback-${failure}:profiles`)!.get(`profile:${first}`));
      idb.fail(failure);
      const adapter = manager.storage(first);
      const pending = adapter.saveEntries([entry('before'), entry('pending')], ['pending']);
      adapter.close(); await pending;
      assert.equal(manager.persistenceWarning, true);
      assert.deepEqual(manager.historyPage(first, '', 3).entries, [entry('pending'), entry('before')]);
      assert.equal(manager.profileInfo(other)!.entryCount, 0);
      assert.deepEqual(idb.databases.get(`fallback-${failure}:profiles`)!.get(`profile:${first}`), storedBefore);
      await manager.saveMemory(first, { text: 'Fallback fact' });
      assert.equal(manager.profileInfo(first)!.memoryCount, 1);
    });
  }
});

describe('bounded runtime storage and shared archive branches', () => {
  for (const persist of [false, true]) {
    it(`bounds runtime loads without cloning or truncating a 20,000-entry archive with persistence ${persist}`, async (t) => {
      if (persist) installChatIndexedDB(t);
      const manager = await store(t, `runtime-window-${persist}`, persist);
      const id = manager.activeProfileId;
      const archive = Array.from({ length: 20_000 }, (_, i) => entry(`archive-${i}`, `Original message ${i}`));
      archive[archive.length - 1] = entry('long-source', 'L'.repeat(20_000));
      await manager.storage(id).saveEntries(archive);
      const runtime = manager.runtimeStorage(id);
      const originalClone = globalThis.structuredClone;
      const clonedArrays: number[] = [];
      t.mock.method(globalThis, 'structuredClone', <T>(value: T): T => {
        if (Array.isArray(value)) clonedArrays.push(value.length);
        return originalClone(value);
      });
      const view = (await runtime.load()).entries;
      assert.equal(view.length, 200);
      assert.ok(view.reduce((size, value) => size + value.text.length, 0) <= 240_000);
      assert.equal(view.at(-1)!.text.length, 16_000);
      assert.ok(clonedArrays.every((length) => length <= 200), 'runtime load must not deep-clone the archive array');
      const user = entry('new-user'); const reply = { ...entry('new-reply', 'partial'), role: 'assistant' as const };
      await runtime.saveEntries([...view, user, reply], [user.id, reply.id]);
      await runtime.saveEntries(boundedEntries([...view, user, { ...reply, text: 'finished' }]), [reply.id]);
      const full = (await manager.storage(id).load()).entries;
      assert.deepEqual(full.slice(0, archive.length), archive);
      assert.deepEqual(full.slice(-2), [user, { ...reply, text: 'finished' }]);
      // Explicit edits compare against the ORIGINAL 20k-character source, not its clipped runtime text.
      await runtime.saveEntries([entry('long-source', 'intentional correction')], ['long-source']);
      assert.equal(manager.sourceText(id, 'long-source'), 'intentional correction');
      await manager.editEntry(id, 'long-source', 'newer peer correction');
      await runtime.saveEntries([entry('long-source', 'stale correction')], ['long-source']);
      assert.equal(manager.sourceText(id, 'long-source'), 'newer peer correction');
      await manager.removeEntry(id, 'long-source');
      await runtime.saveEntries([entry('long-source', 'late deleted edit')], ['long-source']);
      assert.equal(manager.sourceText(id, 'long-source'), undefined);
      assert.equal(decode(await manager.backup()).profiles[0]!.entries.length, archive.length + 1);
      await manager.storage(id).clearEntries();
      await runtime.saveEntries([entry('late-after-clear')], ['late-after-clear']);
      assert.equal(manager.profileInfo(id)!.entryCount, 0);
      await runtime.load();
      await runtime.saveEntries([entry('fresh-after-clear')], ['fresh-after-clear']);
      assert.equal(manager.sourceText(id, 'fresh-after-clear'), 'fresh-after-clear');
    });
  }

  it('rolls back memory promotion and source changes when a merged import exceeds capacity', async (t) => {
    const manager = await store(t, 'shared-memory-rollback', false);
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries([entry('source', 'Original source')]);
    await manager.update(id, { autoRemember: true });
    await manager.saveMemory(id, { text: 'Automatic fact', sourceEntryId: 'source', sourceText: 'Original source', manual: false });
    await manager.saveMemory(id, { text: 'Unrelated manual fact' });
    const before = manager.activeProfile;
    await assert.rejects(manager.importMemories(id, JSON.stringify({
      format: 'peetty-memories', version: 1,
      memories: [fact('promote', 'Automatic fact'), ...Array.from({ length: 999 }, (_, i) => fact(`incoming-${i}`))],
    })), /limit/u);
    assert.deepEqual(manager.activeProfile, before);
    assert.equal(manager.memoryPage(id, '', 1).entries[0]!.manual, false);
    assert.equal(manager.memoryPage(id, '', 1).entries[0]!.sourceEntryId, 'source');
    assert.equal(manager.sourceText(id, 'source'), 'Original source');
  });

  it('replaces edited history entries without changing stale adapter baselines or source indexes', async (t) => {
    const manager = await store(t, 'shared-history-sources', false);
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries([entry('source', 'Original source'), entry('unrelated')]);
    await manager.saveMemory(id, { text: 'Linked fact', sourceEntryId: 'source' });
    const runtime = manager.runtimeStorage(id);
    const baseline = (await runtime.load()).entries;
    assert.equal(manager.sourceText(id, 'source'), 'Original source'); // Build the original array's index.
    await manager.update(id, { name: 'Settings share history' });
    await manager.editEntry(id, 'source', 'Corrected source');
    assert.equal(manager.sourceText(id, 'source'), 'Corrected source');
    assert.equal(manager.sourceText(id, 'unrelated'), 'unrelated');
    assert.equal(manager.memoryPage(id, '', 1).entries[0]!.sourceText, 'Original source');
    await runtime.saveEntries([{ ...baseline[0]!, text: 'Stale edit' }], ['source']);
    assert.equal(manager.sourceText(id, 'source'), 'Corrected source');
    await manager.removeEntry(id, 'source');
    const memory = manager.memoryPage(id, '', 1).entries[0]!;
    assert.equal(memory.sourceEntryId, undefined);
    assert.equal(memory.sourceText, 'Original source');
    assert.equal(manager.sourceText(id, 'source'), undefined);
    await manager.storage(id).clearEntries();
    assert.equal(manager.sourceText(id, 'unrelated'), undefined);
  });
});

describe('shared state database opening', () => {
  function requestFixture(t: TestContext) {
    installChatIndexedDB(t);
    let closes = 0;
    const created: string[] = [];
    const database = { objectStoreNames: { contains: () => false }, createObjectStore(name: string) { created.push(name); }, close() { closes++; } } as unknown as IDBDatabase;
    const request = { result: database } as IDBOpenDBRequest;
    t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
      assert.equal(name, 'shared-open'); assert.equal(version, 1); return request;
    });
    const event = (key: 'onupgradeneeded' | 'onsuccess' | 'onerror' | 'onblocked') => {
      (request[key] as ((event: Event) => void) | null)?.call(request, new Event(key.slice(2)));
    };
    return { database, created, event, get closes() { return closes; } };
  }

  it('upgrades once, publishes the owner cache before resolving, and closes on version changes', async (t) => {
    const fixture = requestFixture(t);
    let failures = 0; let ready: IDBDatabase | undefined;
    const opening = openStateDatabase('shared-open', { isClosed: () => false, onFailure: () => { failures++; }, onReady: (db) => { ready = db; } });
    fixture.event('onupgradeneeded');
    assert.deepEqual(fixture.created, ['state']);
    fixture.event('onsuccess');
    assert.equal(ready, fixture.database);
    assert.equal(await opening, fixture.database);
    fixture.database.onversionchange?.call(fixture.database, new Event('versionchange') as IDBVersionChangeEvent);
    assert.equal(fixture.closes, 1); assert.equal(failures, 1);
  });

  for (const ending of ['timeout', 'blocked', 'error'] as const) {
    it(`settles ${ending} once and closes a late successful connection`, async (t) => {
      const fixture = requestFixture(t);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let failures = 0; let ready = false;
      const opening = openStateDatabase('shared-open', { isClosed: () => false, onFailure: () => { failures++; }, onReady: () => { ready = true; } });
      if (ending === 'timeout') t.mock.timers.tick(2_000);
      else fixture.event(ending === 'blocked' ? 'onblocked' : 'onerror');
      assert.equal(await opening, undefined);
      fixture.event('onsuccess');
      assert.equal(fixture.closes, 1); assert.equal(failures, 1); assert.equal(ready, false);
    });
  }

  it('closes an arriving connection without warning or cache publication after its owner closes', async (t) => {
    const fixture = requestFixture(t);
    let closed = false; let failures = 0; let ready = false;
    const opening = openStateDatabase('shared-open', { isClosed: () => closed, onFailure: () => { failures++; }, onReady: () => { ready = true; } });
    closed = true; fixture.event('onsuccess');
    assert.equal(await opening, undefined);
    assert.equal(fixture.closes, 1); assert.equal(failures, 0); assert.equal(ready, false);
  });
});

describe('full-archive sanitation and tolerant legacy migration', () => {
  it('sanitizes current full text despite mutation masks without overwriting peer edits or crossing a clear barrier', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'sanitize-current-archive');
    const id = manager.activeProfileId;
    const secret = 'synthetic-retired-archive-secret';
    const redact = (text: string) => text.replaceAll(secret, '[redacted]');
    const long = `${'L'.repeat(20_000)} ${secret} complete suffix`;
    await manager.storage(id).saveEntries([entry('old', `Old ${secret}`), entry('long', long)]);
    const runtime = manager.runtimeStorage(id);
    const view = (await runtime.load({ sanitizeText: redact })).entries;
    const peer = await store(t, 'sanitize-current-archive');
    await peer.editEntry(id, 'old', `Peer edited ${secret} and retained this`);
    await runtime.saveEntries([...view, entry('new')], ['new'], redact);
    assert.deepEqual((await manager.storage(id).load()).entries, [entry('old', 'Peer edited [redacted] and retained this'), entry('long', redact(long)), entry('new')]);
    await runtime.saveEntries([entry('old', 'stale explicit correction')], ['old'], redact);
    assert.equal(manager.sourceText(id, 'old'), 'Peer edited [redacted] and retained this');
    await peer.storage(id).clearEntries();
    await peer.storage(id).saveEntries([entry('fresh', `New epoch ${secret}`)]);
    await runtime.saveEntries([...view, entry('late')], ['late'], redact);
    assert.deepEqual((await manager.storage(id).load()).entries, [entry('fresh', 'New epoch [redacted]')]);
    assert.equal(manager.persistenceWarning, false);
  });

  for (const malformed of ['connection', 'history', 'individual entries'] as const) {
    it(`salvages valid legacy records independently of malformed ${malformed} without disabling persistence`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `legacy-salvage-${malformed}`;
      const history: unknown = malformed === 'history' ? { invalid: true } : malformed === 'individual entries'
        ? [entry('first'), { ...entry('negative'), createdAt: -1 }, null, entry('second'), entry('first', 'duplicate')]
        : [entry('first'), entry('second')];
      const legacy = new Map<string, unknown>([['entries', history], ['connection', malformed === 'connection' ? { ...connection, baseUrl: 'invalid' } : connection]]);
      const untouched = structuredClone(legacy);
      idb.databases.set(`${namespace}:chat`, legacy);
      const manager = await store(t, namespace);
      const id = manager.activeProfileId;
      assert.deepEqual(manager.activeProfile.entries, malformed === 'history' ? [] : [entry('first'), entry('second')]);
      assert.deepEqual(manager.activeProfile.connection, malformed === 'connection' ? undefined : connection);
      assert.equal(manager.persistenceWarning, false);
      await manager.storage(id).saveEntries([entry('new')], ['new']);
      const reopened = await store(t, namespace);
      assert.equal(reopened.sourceText(id, 'new'), 'new');
      assert.equal(reopened.persistenceWarning, false);
      assert.deepEqual(legacy, untouched, 'migration must leave all original records intact');
    });
  }
});

describe('verified pristine bootstrap capacity', () => {
  it('atomically replaces an untouched bootstrap when restoring a valid 100-profile file', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'full-restore');
    const bootstrap = manager.activeProfileId;
    await manager.storage(bootstrap).load(); await manager.backup();
    await manager.restore(fullBackup());
    assert.equal(manager.listProfiles().length, 100);
    assert.equal(manager.profileInfo(bootstrap), undefined);
    assert.equal(manager.profileInfo(manager.activeProfileId)!.name, 'import-99');
    assert.equal(idb.databases.get('full-restore:profiles')!.has(`profile:${bootstrap}`), false);
    const keys = idb.writes.at(-1)!.keys;
    assert.ok(keys.includes(`profile:${bootstrap}`));
    assert.ok(keys.includes('directory'));
    assert.equal(keys.length, 102);
    const reopened = await store(t, 'full-restore');
    assert.equal(reopened.listProfiles().length, 100);
    assert.equal(reopened.activeProfileId, manager.activeProfileId);
  });

  it('protects profiles used for settings, history, memories, connections, and injected SDK configuration', async (t) => {
    installChatIndexedDB(t);
    const mutations = [
      async (manager: BrowserProfileStore, id: string) => { await manager.update(id, { personality: 'Custom' }); await manager.update(id, { personality: '' }); },
      async (manager: BrowserProfileStore, id: string) => { await manager.storage(id).saveEntries([entry('used')]); await manager.storage(id).clearEntries(); },
      async (manager: BrowserProfileStore, id: string) => { await manager.saveMemory(id, { text: 'Used' }); await manager.removeMemory(id, manager.memoryPage(id, '', 1).entries[0]!.id); },
      async (manager: BrowserProfileStore, id: string) => { await manager.storage(id).saveConnection(connection); },
      async (manager: BrowserProfileStore, id: string) => { await manager.markBootstrapUsed(id); },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const manager = await store(t, `used-${index}`);
      const id = manager.activeProfileId;
      await mutate(manager, id);
      const before = manager.profiles;
      await assert.rejects(manager.restore(fullBackup()), { message: 'Profile storage limit reached.' });
      assert.deepEqual(manager.profiles, before);
      assert.equal(manager.activeProfileId, id);
    }
  });

  it('uses authoritative bootstrap consent and protects empty imported and legacy profiles', async (t) => {
    const idb = installChatIndexedDB(t);
    const first = await store(t, 'peer-bootstrap');
    const peer = await store(t, 'peer-bootstrap');
    await peer.markBootstrapUsed();
    await assert.rejects(first.restore(fullBackup()), { message: 'Profile storage limit reached.' });
    idb.databases.set('legacy-empty:chat', new Map([['entries', []]]));
    const legacy = await store(t, 'legacy-empty');
    await assert.rejects(legacy.restore(fullBackup()), { message: 'Profile storage limit reached.' });
    const imported = await store(t, 'imported-empty');
    const shell = imported.activeProfileId;
    await imported.restore(document([profile('empty-real-profile')]));
    await imported.remove(shell);
    const existing = imported.activeProfileId;
    await assert.rejects(imported.restore(fullBackup()), { message: 'Profile storage limit reached.' });
    assert.equal(imported.activeProfileId, existing);
    assert.equal(imported.profileInfo(existing)!.name, 'empty-real-profile');
  });
});
