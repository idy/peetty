import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { jsonChunks, jsonFingerprint, parseJSONChunks } from '../src/chat/bounded-json.ts';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Figure } from '../src/figure/types.ts';
import { BrowserProfileStore, PROFILE_LIMITS } from '../src/chat/profiles.ts';
import type { BackupDownloadFile, BackupSession, MemoryEntry, ProfileRecord } from '../src/chat/profiles.ts';
import { boundedEntries, ChatStorageError } from '../src/chat/store.ts';
import { ChatRuntime } from '../src/chat/runtime.ts';
import { IDB_OPEN_TIMEOUT_MS, IDB_TRANSACTION_TIMEOUT_MS, openStateDatabase, stateTransaction } from '../src/chat/idb.ts';
import type { StoredConnection } from '../src/chat/store.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB, LegacyV1ChatFixture } from './helpers/chat-storage.ts';

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
function assertLegacyRetired(legacy: Map<string, unknown>): void {
  assert.equal(legacy.has('entries'), false);
  assert.equal(legacy.has('connection'), false);
  assert.equal(typeof legacy.get('entriesEpoch'), 'string');
}
// Tests collect deliberately small fixtures; production consumes the lazy iterator.
async function downloadFiles(manager: BrowserProfileStore, options?: Parameters<BrowserProfileStore['backupDownload']>[0]): Promise<BackupDownloadFile[]> {
  const output = await manager.backupDownload(options);
  assert.notEqual(typeof output, 'string');
  const files: BackupDownloadFile[] = [];
  for await (const file of output as AsyncIterable<BackupDownloadFile>) files.push(file);
  assert.equal(files.at(-1)!.final, true);
  assert.ok(files.slice(0, -1).every((file) => file.final === undefined));
  assert.ok(files.every((file) => !('final' in JSON.parse(file.text))));
  return files;
}


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


});

describe('saved and ephemeral connection regressions', () => {
  it('canonicalizes restored URLs and retains only headers owned by the latest restored session', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t);
    const saved = { ...connection, baseUrl: 'https://EXAMPLE.test/v1/chat/completions/', headers: { 'x-api-key': 'saved-header', 'openai-project': '1' } };
    const session = { ...connection, baseUrl: 'https://example.test/v1/models', apiKey: 'ephemeral-key', headers: { Authorization: 'Bearer ephemeral-header', 'OpenAI-Project': '2' } };
    await manager.restore(document([profile('original', { connection: saved })], [{ profileId: 'original', connection: session, rememberKey: false }]));
    const id = manager.activeProfileId;
    const adapter = manager.storage(id);
    const loaded = await adapter.load();
    assert.equal(loaded.connection!.baseUrl, connection.baseUrl);
    assert.equal(loaded.sessionConnections![0]!.connection.baseUrl, connection.baseUrl);
    await adapter.saveConnection({ ...connection, headers: { authorization: 'Bearer ephemeral-header', 'openai-project': '2', 'x-fresh': 'SDK-only' } });
    const accepted = await adapter.load();
    assert.deepEqual(accepted.connection!.headers, { authorization: 'Bearer ephemeral-header', 'openai-project': '2' });
    assert.equal(accepted.sessionConnections, undefined);
    await adapter.saveConnection({ ...connection, headers: { 'openai-project': '2' }, effort: 'low' }, { rememberCredentials: true });
    assert.deepEqual((await adapter.load()).connection!.headers, { 'openai-project': '2' });
    await adapter.saveConnection({ ...connection, headers: { 'openai-project': '2', authorization: 'new SDK credential' } }, { rememberCredentials: false });
    assert.equal((await adapter.load()).connection!.apiKey, undefined);
    assert.deepEqual((await adapter.load()).connection!.headers, { 'openai-project': '2' });
  });

  it('honors explicit profile credential removal and never persists fresh SDK headers', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t);
    const id = manager.activeProfileId;
    await manager.storage(id).saveConnection({ ...connection, headers: { authorization: 'fresh SDK header' } }, { rememberCredentials: true });
    assert.equal(manager.storedConnection(id)!.headers, undefined);
    await manager.restore(document([profile('auth', { connection: { ...connection, headers: { authorization: 'Bearer restored', 'openai-project': '1' } } })]));
    const restoredId = manager.activeProfileId;
    await manager.storage(restoredId).saveConnection({ ...connection, headers: { authorization: 'Bearer restored', 'openai-project': '1' } }, { rememberCredentials: false });
    assert.deepEqual(manager.storedConnection(restoredId), { id: connection.id, baseUrl: connection.baseUrl, headers: { 'openai-project': '1' } });

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

  it('exports queued writes and latest peer memories without source messages in JSON and Markdown', async (t) => {
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
    assert.equal(fresh.memories[0]!.sourceText, undefined);
    assert.equal(fresh.memories[0]!.sourceEntryId, undefined);
    assert.equal(fresh.memories[0]!.createdAt, 1);
    const markdown = await manager.exportMemoryMarkdown(id);
    assert.match(markdown, /^# Fresh name memories/u);
    assert.ok(markdown.includes('A sourced fact'));
    assert.equal(markdown.includes('Original'), false);
    assert.equal(markdown.includes('sourceEntryId'), false);
    assert.equal(markdown.includes('Source:'), false);
    assert.ok(markdown.includes('Peer memory'));
    const destination = await manager.create({ name: 'Destination' });
    await manager.importMemories(destination.id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: fresh.memories }));
    await manager.importMemories(destination.id, JSON.stringify({ format: 'peetty-memories', version: 1, memories: [{ ...fact('duplicate', 'Ａ SOURCED FACT'), sourceText: 'Do not replace manual source' }] }));
    assert.equal(manager.memoryPage(destination.id, '', 10).entries.length, 3);
    assert.equal(manager.memoryPage(destination.id, '', 10).entries[0]!.sourceText, undefined);
    assert.equal(manager.memoryPage(id, '', 10).entries[0]!.sourceEntryId, manager.historyPage(id, '', 1).entries[0]!.id);
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
      if (ending === 'timeout') t.mock.timers.tick(IDB_OPEN_TIMEOUT_MS);
      else fixture.event(ending === 'blocked' ? 'onblocked' : 'onerror');
      assert.equal(await opening, undefined);
      fixture.event('onsuccess');
      assert.equal(fixture.closes, 1); assert.equal(failures, 1); assert.equal(ready, false);
    });
  }

  it('allows a slow successful open beyond the former two-second deadline', async (t) => {
    const fixture = requestFixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let failures = 0;
    const opening = openStateDatabase('shared-open', { isClosed: () => false, onFailure: () => { failures++; } });
    t.mock.timers.tick(5_000);
    fixture.event('onsuccess');
    assert.equal(await opening, fixture.database);
    t.mock.timers.tick(IDB_OPEN_TIMEOUT_MS);
    assert.equal(fixture.closes, 0); assert.equal(failures, 0);
  });

  it('closes an arriving connection without warning or cache publication after its owner closes', async (t) => {
    const fixture = requestFixture(t);
    let closed = false; let failures = 0; let ready = false;
    const opening = openStateDatabase('shared-open', { isClosed: () => closed, onFailure: () => { failures++; }, onReady: () => { ready = true; } });
    closed = true; fixture.event('onsuccess');
    assert.equal(await opening, undefined);
    assert.equal(fixture.closes, 1); assert.equal(failures, 0); assert.equal(ready, false);
  });
});

describe('bounded archive transactions', () => {
  function transactionFixture() {
    let aborts = 0;
    let saved: unknown;
    const request = {} as IDBRequest;
    const store = { get: () => request, put: (value: unknown) => { saved = structuredClone(value); } } as unknown as IDBObjectStore;
    const transaction = { objectStore: () => store, abort() { aborts++; transaction.onabort?.call(transaction, new Event('abort')); } } as unknown as IDBTransaction;
    const database = { transaction: () => transaction } as unknown as IDBDatabase;
    return { database, transaction, request, get aborts() { return aborts; }, get saved() { return saved; } };
  }

  it('reads and commits a 100,000-entry record beyond two seconds without truncation or abort', async (t) => {
    const fixture = transactionFixture();
    const record = { profile: profile('large', { entries: Array.from({ length: 100_000 }, (_, i) => entry(`large-${i}`, 'x'.repeat(400))) }), epoch: 'large-epoch' };
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    assert.ok(bytes > 40 * 1024 * 1024 && bytes < PROFILE_LIMITS.fileBytes);
    Object.defineProperty(fixture.request, 'result', { value: structuredClone(record) });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result: boolean | undefined;
    const operation = stateTransaction(fixture.database, true, (store) => {
      const request = store.get('profile:large');
      request.onsuccess = () => { store.put(request.result, 'profile:large'); };
    }).then((success) => { result = success; return success; });
    t.mock.timers.tick(5_000);
    assert.equal(result, undefined); assert.equal(fixture.aborts, 0);
    fixture.request.onsuccess?.call(fixture.request, new Event('success'));
    t.mock.timers.tick(5_000);
    fixture.transaction.oncomplete?.call(fixture.transaction, new Event('complete'));
    assert.equal(await operation, true);
    t.mock.timers.tick(IDB_TRANSACTION_TIMEOUT_MS);
    assert.equal(fixture.aborts, 0);
    assert.deepEqual(fixture.saved, record);
  });

  for (const ending of ['timeout', 'setup failure'] as const) {
    it(`aborts and settles a transaction once after ${ending}`, async (t) => {
      const fixture = transactionFixture();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let settlements = 0;
      const operation = stateTransaction(fixture.database, false, () => {
        if (ending === 'setup failure') throw new Error('synthetic setup failure');
      }).then((success) => { settlements++; return success; });
      t.mock.timers.tick(IDB_TRANSACTION_TIMEOUT_MS);
      assert.equal(await operation, false);
      fixture.transaction.oncomplete?.call(fixture.transaction, new Event('complete'));
      t.mock.timers.tick(IDB_TRANSACTION_TIMEOUT_MS);
      assert.equal(fixture.aborts, 1); assert.equal(settlements, 1);
    });
  }
});

describe('full-archive sanitation and tolerant legacy migration', () => {
  for (const failure of ['throw', 'blocked', 'timeout', 'read error', 'read timeout'] as const) {
    for (const peerCommitted of [false, true]) {
      it(`isolates legacy ${failure} with a peer initialization ${peerCommitted}`, async (t) => {
        const idb = installChatIndexedDB(t);
        const namespace = `legacy-failure-${failure}-${peerCommitted}`;
        const legacy = new Map<string, unknown>([['entries', [entry('preserved-legacy')]]]);
        idb.databases.set(`${namespace}:chat`, legacy);
        const peer = profile('peer', { name: 'Existing peer', entries: [entry('peer-entry')], memories: [fact('peer-memory')] });
        const records = new Map<string, unknown>([
          ['directory', { version: 1, ids: [peer.id], activeProfileId: peer.id }],
          [`profile:${peer.id}`, { profile: peer, epoch: 'peer-epoch' }],
        ]);
        let closes = 0;
        const transaction = { objectStore: () => ({ get: () => ({} as IDBRequest) }), abort() { transaction.onabort?.call(transaction, new Event('abort')); } } as unknown as IDBTransaction;
        const database = {
          transaction: () => {
            queueMicrotask(() => {
              if (failure === 'read timeout') t.mock.timers.tick(IDB_TRANSACTION_TIMEOUT_MS);
              else transaction.onerror?.call(transaction, new Event('error'));
            });
            return transaction;
          },
          close: () => { closes++; },
        } as unknown as IDBDatabase;
        const request = { result: database } as IDBOpenDBRequest;
        const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let legacyAttempts = 0;
        t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
          if (name !== `${namespace}:chat`) return open(name, version);
          legacyAttempts++;
          // A peer commits once after the initial empty-directory read; retries must not replay that commit.
          if (peerCommitted && legacyAttempts === 1) for (const [key, value] of records) idb.databases.get(`${namespace}:profiles`)!.set(key, structuredClone(value));
          if (failure === 'throw') throw new Error('synthetic legacy open failure');
          queueMicrotask(() => {
            if (failure === 'timeout') t.mock.timers.tick(IDB_OPEN_TIMEOUT_MS);
            else if (failure === 'blocked') request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
            else request.onsuccess?.call(request, new Event('success'));
          });
          return request;
        });
        const manager = await store(t, namespace);
        assert.equal(manager.persistenceWarning, false);
        if (peerCommitted) assert.deepEqual(manager.profiles, [peer]);
        else {
          assert.equal(manager.listProfiles().length, 1);
          assert.equal(manager.activeProfile.name, 'Miru');
          await assert.rejects(manager.restore(fullBackup()), /storage limit/u, 'unknown legacy contents must not authorize bootstrap replacement');
        }
        const id = manager.activeProfileId;
        await manager.update(id, { name: 'Persisted after migration failure' });
        await manager.storage(id).saveEntries([entry('new-after-failure')], ['new-after-failure']);
        const reopened = await store(t, namespace);
        assert.equal(reopened.activeProfileId, id);
        assert.equal(reopened.profileInfo(id)!.name, 'Persisted after migration failure');
        assert.equal(reopened.sourceText(id, 'new-after-failure'), 'new-after-failure');
        if (peerCommitted) {
          assert.equal(reopened.sourceText(id, 'peer-entry'), 'peer-entry');
          assert.deepEqual(reopened.activeProfile.memories, peer.memories);
        }
        assert.equal(reopened.persistenceWarning, false);
        assert.deepEqual(legacy.get('entries'), [entry('preserved-legacy')]);
        if (failure === 'blocked' || failure === 'timeout') {
          request.onsuccess?.call(request, new Event('success'));
          assert.equal(closes, 1, 'close a late legacy connection');
        } else if (failure.startsWith('read')) assert.equal(closes, legacyAttempts, 'close every failed legacy read connection');
        assert.equal(manager.persistenceWarning, false);
      });
    }
  }

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
  for (const persist of [false, true]) {
    it(`keeps empty and unchanged saves pristine for the full first restore with persistence ${persist}`, async (t) => {
      const idb = installChatIndexedDB(t);
      const figure = JSON.parse(await readFile(new URL('../figures/miru.json', import.meta.url), 'utf8')) as Figure;
      const namespace = `no-op-save-${persist}`;
      const manager = new BrowserProfileStore(namespace, persist); t.after(() => manager.close());
      await manager.initialize({ figure });
      const bootstrap = manager.activeProfileId;
      const before = manager.activeProfile;
      const persisted = structuredClone(idb.databases.get(`${namespace}:profiles`));
      t.mock.method(Date, 'now', () => before.updatedAt + 1_000);
      for (const patch of [
        {},
        { name: ` ${before.name} `, personality: ' ', useMemories: true, autoRemember: false },
        { figure: structuredClone(figure) },
      ]) {
        await manager.update(bootstrap, patch);
        assert.deepEqual(manager.activeProfile, before);
        assert.deepEqual(idb.databases.get(`${namespace}:profiles`), persisted);
        if (persist) assert.deepEqual(idb.writes.at(-1)!.keys, []);
      }
      await manager.restore(fullBackup());
      assert.equal(manager.listProfiles().length, PROFILE_LIMITS.profiles);
      assert.equal(manager.profileInfo(bootstrap), undefined);
      assert.equal(manager.persistenceWarning, false);
    });
  }

  it('validates no-op owners and compares unchanged values against the current peer record', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'no-op-owner');
    const id = manager.activeProfileId;
    const peer = await store(t, 'no-op-owner');
    await peer.update(id, { name: 'Peer edit' });
    await manager.update(id, { name: 'Miru' });
    assert.equal((await store(t, 'no-op-owner')).profileInfo(id)!.name, 'Miru');
    await peer.create({ name: 'Retained' }); await peer.remove(id);
    await assert.rejects(manager.update(id, {}), /no longer exists/u);
    await assert.rejects(manager.update(id, { name: 'Miru' }), /no longer exists/u);
    assert.equal(manager.persistenceWarning, false);
  });

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

describe('complete multipart backup downloads', () => {
  it('keeps ordinary downloads as plain version 2 JSON and accepts a single normal file', async (t) => {
    const manager = await store(t, 'ordinary-download', false);
    const output = await manager.backupDownload();
    assert.equal(typeof output, 'string');
    assert.equal(decode(output as string).version, 2);
    await manager.restoreFiles([output as string]);
    assert.equal(manager.listProfiles().length, 2);
  });

  it('validates every part before any writes, preserves evidence, keys and all sessions, and accepts unordered files', async (t) => {
    const idb = installChatIndexedDB(t);
    const source = await store(t, 'multipart-source');
    const id = source.activeProfileId;
    const body = '雪😀 "quoted" \\ slash\n'.repeat(300);
    await source.storage(id).saveEntries([entry('source', body)]);
    await source.saveMemory(id, { text: 'A portable fact', sourceEntryId: 'source', sourceText: body });
    await source.storage(id).saveConnection(connection);
    const sessions = [{ profileId: id, connection: { ...connection, apiKey: 'session-key', headers: { 'x-auth': 'session-header' } }, rememberKey: false },
      { profileId: id, connection: { ...connection, apiKey: 'second-session' }, rememberKey: true }];
    const files = await downloadFiles(source, { sessions, _testing: { fileBytes: 2_048 } });
    assert.ok(Array.isArray(files) && files.length > 2);
    assert.equal(new Set(files.map((file) => file.name)).size, files.length);
    assert.ok(files.every((file) => new TextEncoder().encode(file.text).length <= 2_048));
    const texts = files.map((file) => file.text);
    const target = await store(t, 'multipart-target');
    const before = target.profiles;
    const writes = idb.writes.length;
    const mutate = (index: number, patch: Record<string, unknown>): string[] => texts.map((text, i) => i === index ? JSON.stringify({ ...JSON.parse(text), ...patch }) : text);
    const other = await downloadFiles(source, { sessions, _testing: { fileBytes: 2_048 } });
    assert.ok(Array.isArray(other));
    for (const invalid of [
      [], texts.slice(1), [texts[0]!], [...texts, texts[0]!], [texts[0]!, texts[0]!, ...texts.slice(2)],
      mutate(0, { backupId: 'other-backup' }), mutate(0, { count: files.length + 1 }), mutate(0, { index: files.length }),
      mutate(0, { index: 0.5 }), mutate(0, { version: 2 }), mutate(0, { unexpected: true }),
      mutate(0, { text: `${JSON.parse(texts[0]!).text}altered` }), mutate(0, { digest: 'crc32:00000000:1' }),
      [other[0]!.text, ...texts.slice(1)], [await source.backup(), ...texts.slice(1)],
    ]) {
      await assert.rejects(target.restoreFiles(invalid), { message: 'Invalid or unsupported profile data.' });
      assert.deepEqual(target.profiles, before);
      assert.equal(idb.writes.filter((write) => write.database === 'multipart-target:profiles').length, 1);
    }
    assert.ok(idb.writes.length >= writes);
    await target.restoreFiles([...texts].reverse());
    const restored = target.activeProfile;
    assert.equal(restored.entries[0]!.text, body);
    assert.notEqual(restored.entries[0]!.id, 'source');
    assert.equal(restored.memories[0]!.sourceEntryId, restored.entries[0]!.id);
    assert.equal(restored.memories[0]!.sourceText, body);
    assert.deepEqual(restored.connection, connection);
    assert.deepEqual((await target.storage(restored.id).load()).sessionConnections, sessions.map(({ profileId: _id, ...session }) => session));
    const reopened = await store(t, 'multipart-target');
    assert.deepEqual(reopened.activeProfile, restored);
    assert.equal((await reopened.storage(restored.id).load()).sessionConnections, undefined);
  });

  it('validates the reconstructed backup schema even when every envelope and integrity check is consistent', async (t) => {
    const idb = installChatIndexedDB(t);
    const source = await store(t, 'multipart-invalid-source', false);
    await source.storage(source.activeProfileId).saveEntries([entry('body', 'x'.repeat(3_000))]);
    // Simulate internal archive corruption so the exporter supplies consistent
    // envelopes for a document that the full schema must still reject.
    const internal = source as unknown as { state: { records: Map<string, { profile: ProfileRecord }> } };
    internal.state.records.get(source.activeProfileId)!.profile.name = '';
    const files = await downloadFiles(source, { _testing: { fileBytes: 1_024 } });
    assert.ok(Array.isArray(files));
    const target = await store(t, 'multipart-invalid-target');
    const before = target.profiles;
    const writes = idb.writes.length;
    await assert.rejects(target.restoreFiles(files.map((file) => file.text)), { message: 'Invalid or unsupported profile data.' });
    assert.equal(idb.writes.length, writes);
    assert.deepEqual(target.profiles, before);
  });

  it('downloads and atomically restores an actual archive larger than 50 MiB without deleting history', async (t) => {
    const source = await store(t, 'large-download', false);
    const id = source.activeProfileId;
    const body = 'long archive '.repeat(40_000);
    const entries = Array.from({ length: 110 }, (_, i) => entry(`large-${i}`, body));
    await source.storage(id).saveEntries(entries);
    await assert.rejects(source.backup(), /storage limit/u);
    const files = await downloadFiles(source);
    assert.ok(Array.isArray(files) && files.length > 1);
    assert.ok(files.every((file) => new TextEncoder().encode(file.text).length <= PROFILE_LIMITS.fileBytes));
    assert.equal(source.profileInfo(id)!.entryCount, entries.length);
    const target = await store(t, 'large-restore', false);
    await assert.rejects(target.restoreFiles(files.slice(1).map((file) => file.text)), /Invalid/u);
    assert.equal(target.profileInfo(target.activeProfileId)!.entryCount, 0);
    await target.restoreFiles(files.map((file) => file.text));
    assert.equal(target.profileInfo(target.activeProfileId)!.entryCount, entries.length);
    assert.equal(target.sourceText(target.activeProfileId, target.historyPage(target.activeProfileId, '', 1).entries[0]!.id), body);
  });
});

describe('bounded JSON compatibility and retryable migration', () => {
  it('streams native JSON values across escape/surrogate boundaries without prototype mutation', () => {
    const source = { text: '雪😀\\\"\n\t\u0000\ud800'.repeat(5_000), absent: undefined, array: [null, 1, true, false] };
    const chunks = [...jsonChunks(source, 83)];
    assert.ok(chunks.every((part) => part.length <= 83));
    assert.deepEqual(parseJSONChunks(chunks, PROFILE_LIMITS.fileBytes * 6), JSON.parse(JSON.stringify(source)));
    const literal = '{"same":1,"same":2,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"escaped":"\\uD83D\\uDE00\\n\\\\\\\""}';
    const parsed = parseJSONChunks(Array.from(literal), 10_000) as Record<string, unknown>;
    assert.deepEqual(parsed, JSON.parse(literal));
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    for (const invalid of ['{} trailing', '{"a":1,}', '[1,]', '[', '{"a":"\\uXYZ1"}', '01', 'true false', '{"a":"line\nfeed"}']) {
      assert.throws(() => parseJSONChunks(Array.from(invalid), 10_000), /Invalid/u);
    }
  });

  it('computes portable SHA-256 proofs without subtle crypto and without plaintext checkpoints', async (t) => {
    const value = { text: '😀'.repeat(20_000), nested: [1, false, 'proof'] };
    const serialized = [...jsonChunks(value, 16_384)].join('');
    const bytes = Buffer.alloc(serialized.length * 2);
    for (let i = 0; i < serialized.length; i++) bytes.writeUInt16BE(serialized.charCodeAt(i), i * 2);
    assert.equal(jsonFingerprint(value), createHash('sha256').update(bytes).digest('hex'));
    const idb = installChatIndexedDB(t);
    const crypto = globalThis.crypto;
    t.mock.getter(globalThis, 'crypto', () => ({ getRandomValues: crypto.getRandomValues.bind(crypto) }) as Crypto);
    idb.databases.set('no-subtle:chat', new Map<string, unknown>([['entries', [entry('old', 'Private old message')]], ['connection', connection]]));
    const manager = await store(t, 'no-subtle');
    await manager.storage(manager.activeProfileId).clearEntries();
    await manager.storage(manager.activeProfileId).saveConnection(connection, { rememberCredentials: false });
    const proof = JSON.stringify(idb.databases.get('no-subtle:profiles')!.get('legacyMigration'));
    assert.equal(proof.includes('Private old message'), false);
    assert.equal(proof.includes(connection.apiKey!), false);
    assert.equal(manager.persistenceWarning, false);
  });

  it('reconciles older markerless migrated stores by correspondence while preserving uncopied records', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'old-migration');
    const id = manager.activeProfileId;
    await manager.storage(id).saveEntries([entry('copied')]);
    await manager.storage(id).saveConnection(connection);
    manager.close();
    const legacy = new Map<string, unknown>([['entries', [entry('copied'), entry('uncopied')]], ['connection', connection], ['entriesEpoch', 'old']]);
    idb.databases.set('old-migration:chat', legacy);
    const reopened = await store(t, 'old-migration');
    assert.deepEqual(legacy.get('entries'), [entry('copied'), entry('uncopied')]);
    assert.equal(legacy.has('connection'), false);
    assert.deepEqual(reopened.activeProfile.entries, [entry('copied')]);
    await reopened.storage(id).clearEntries();
    await reopened.storage(id).saveConnection(connection, { rememberCredentials: false });
    assert.deepEqual(legacy.get('entries'), [entry('uncopied')]);
    assert.equal(legacy.has('connection'), false);
  });

  it('retries failed cleanup after restart and a later clear/key opt-out without retaining plaintext proof', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('old', 'Raw private history')]], ['connection', connection]]);
    idb.databases.set('retry-cleanup:chat', legacy);
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    let attempts = 0; let blocked = true;
    t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
      if (name === 'retry-cleanup:chat' && ++attempts > 1 && blocked) throw new Error('Cleanup temporarily unavailable');
      return open(name, version);
    });
    const first = await store(t, 'retry-cleanup');
    const id = first.activeProfileId;
    assert.ok(legacy.has('entries'));
    await assert.rejects(first.storage(id).clearEntries(), { code: 'legacy-cleanup' });
    await assert.rejects(first.storage(id).saveConnection(connection, { rememberCredentials: false }), { code: 'legacy-cleanup' });
    assert.equal(first.persistenceWarning, false);
    const persistedProof = JSON.stringify(idb.databases.get('retry-cleanup:profiles')!.get('legacyMigration'));
    assert.equal(persistedProof.includes('Raw private history'), false);
    assert.equal(persistedProof.includes(connection.apiKey!), false);
    blocked = false;
    const reopened = await store(t, 'retry-cleanup');
    assertLegacyRetired(legacy);
    assert.deepEqual(reopened.activeProfile.entries, [entry('old', 'Raw private history')], 'failed clear must preserve current profile data');
    await reopened.storage(id).clearEntries();
    assert.deepEqual(reopened.activeProfile.entries, []);
    assert.equal(reopened.activeProfile.connection!.apiKey, connection.apiKey, 'failed opt-out cannot report a forgotten key');
    await reopened.storage(id).saveConnection(connection, { rememberCredentials: false });
    assert.equal(reopened.activeProfile.connection!.apiKey, undefined);
  });

  it('retries a concurrent legacy write safely and only retires newly copied values after correspondence', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('copied')]], ['connection', connection], ['entriesEpoch', 'old']]);
    idb.databases.set('retry-concurrent:chat', legacy);
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB); let attempts = 0;
    t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
      if (name === 'retry-concurrent:chat' && ++attempts === 2) legacy.set('entries', [entry('copied'), entry('new-legacy')]);
      return open(name, version);
    });
    const manager = await store(t, 'retry-concurrent');
    assert.deepEqual(legacy.get('entries'), [entry('copied'), entry('new-legacy')]);
    await manager.storage(manager.activeProfileId).clearEntries();
    assert.deepEqual(legacy.get('entries'), [entry('new-legacy')]);
    await manager.storage(manager.activeProfileId).saveEntries([entry('new-legacy')]);
    await manager.storage(manager.activeProfileId).clearEntries();
    assertLegacyRetired(legacy);
    assert.equal(manager.profileInfo(manager.activeProfileId)!.entryCount, 0);
  });

  it('serializes a supported 70,000 by 8,000-character archive beyond the engine string limit in bounded pieces', () => {
    const body = 'x'.repeat(8_000);
    const archive = { profiles: [profile('huge', { entries: Array.from({ length: 70_000 }, (_, i) => entry(`huge-${i}`, body)) })] };
    let characters = 0; let largest = 0;
    for (const chunk of jsonChunks(archive, 262_144)) { characters += chunk.length; largest = Math.max(largest, chunk.length); }
    assert.ok(characters > bufferConstants.MAX_STRING_LENGTH);
    assert.ok(largest <= 262_144);
    assert.equal(archive.profiles[0]!.entries.length, 70_000);
  });

  it('exports/restores many entries with strict intermediate stringify and join ceilings', async (t) => {
    const manager = await store(t, 'bounded-many', false);
    const body = 'snow 雪😀\\\"\n'.repeat(100);
    await manager.storage(manager.activeProfileId).saveEntries(Array.from({ length: 5_000 }, (_, i) => entry(`many-${i}`, body)));
    const stringify = JSON.stringify;
    const join = Array.prototype.join;
    t.mock.method(JSON, 'stringify', ((value: unknown, ...args: unknown[]) => {
      if (typeof value === 'object' && value) {
        assert.equal('profiles' in value, false, 'must not stringify a backup');
        assert.equal('entries' in value, false, 'must not stringify a profile archive');
      }
      const result = Reflect.apply(stringify, JSON, [value, ...args]) as string | undefined;
      assert.ok(!result || result.length < 32_768, 'bounded serialization only');
      return result;
    }) as typeof JSON.stringify);
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'join')!;
    Object.defineProperty(Array.prototype, 'join', { ...descriptor, value: function(this: unknown[], separator?: string) {
      if (this.every((item) => typeof item === 'string')) assert.ok(this.reduce((count: number, item) => count + (item as string).length, 0) < 32_768, 'never join the whole archive');
      return Reflect.apply(join, this, [separator]);
    } });
    t.after(() => Object.defineProperty(Array.prototype, 'join', descriptor));
    const files = await downloadFiles(manager, { _testing: { fileBytes: 16_384 } });
    assert.ok(Array.isArray(files) && files.length > 100);
    const destination = await store(t, 'bounded-many-target', false);
    await destination.restoreFiles(files.map((file) => file.text));
    assert.equal(destination.profileInfo(destination.activeProfileId)!.entryCount, 5_000);
    assert.equal(destination.historyPage(destination.activeProfileId, '', 1).entries[0]!.text, body);
  });
});

describe('lazy downloads, explicit recovery, and bounded escaped strings', () => {
  it('only serializes multipart envelopes on demand and stops generation after early return', async (t) => {
    const manager = await store(t, 'lazy-download', false);
    await manager.storage(manager.activeProfileId).saveEntries(Array.from({ length: 100 }, (_, i) => entry(`lazy-${i}`, 'x'.repeat(1_000))));
    const stringify = JSON.stringify; let envelopes = 0;
    t.mock.method(JSON, 'stringify', ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'format' in value && value.format === 'peetty-backup-part') envelopes++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify);
    const output = await manager.backupDownload({ _testing: { fileBytes: 2_048 } });
    assert.notEqual(typeof output, 'string');
    assert.equal(Array.isArray(output), false);
    assert.equal(envelopes, 0, 'first pass must not serialize or retain multipart envelopes');
    const iterator = (output as AsyncIterable<BackupDownloadFile>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(envelopes, 1);
    await iterator.return?.();
    assert.equal((await iterator.next()).done, true);
    assert.equal(envelopes, 1, 'canceled generator must not resume generation');
    const canceled = await manager.backupDownload({ _testing: { fileBytes: 2_048 } });
    const notStarted = (canceled as AsyncIterable<BackupDownloadFile>)[Symbol.asyncIterator]();
    await notStarted.return?.();
    assert.equal((await notStarted.next()).done, true);
    assert.equal(envelopes, 1, 'canceling before first next releases the unstarted snapshot');
  });

  it('keeps both multipart passes on a stable snapshot while later writes change source history and memories', async (t) => {
    const manager = await store(t, 'lazy-snapshot', false);
    const id = manager.activeProfileId;
    const original = 'Old evidence '.repeat(1_000);
    await manager.storage(id).saveEntries([entry('source', original)]);
    await manager.saveMemory(id, { text: 'Old fact', sourceEntryId: 'source', sourceText: original });
    const output = await manager.backupDownload({ _testing: { fileBytes: 2_048 } });
    assert.notEqual(typeof output, 'string');
    await manager.editEntry(id, 'source', 'New history');
    await manager.saveMemory(id, { id: manager.memoryPage(id, '', 1).entries[0]!.id, text: 'New fact' });
    const files: string[] = [];
    for await (const file of output as AsyncIterable<BackupDownloadFile>) files.push(file.text);
    const target = await store(t, 'lazy-snapshot-target', false);
    await target.restoreFiles(files);
    assert.equal(target.historyPage(target.activeProfileId, '', 1).entries[0]!.text, original);
    assert.equal(target.memoryPage(target.activeProfileId, '', 1).entries[0]!.text, 'Old fact');
  });

  it('coalesces escape-heavy tokens in bounded decoded buffers and rejects decoded overflow early', () => {
    const count = 1_000_000;
    const raw = `"${'\\u0061'.repeat(count)}"`;
    const chunks = Array.from({ length: Math.ceil(raw.length / 65_536) }, (_, i) => raw.slice(i * 65_536, (i + 1) * 65_536));
    let maximumBuffers = 0; let observations = 0;
    const output = parseJSONChunks(chunks, count, { onStringBuffers(buffers, pending, decoded) {
      maximumBuffers = Math.max(maximumBuffers, buffers); observations++;
      assert.ok(buffers <= Math.floor(decoded / 16_384));
      assert.ok(pending < 16_384);
    } });
    assert.equal((output as string).length, count);
    assert.equal(maximumBuffers, Math.floor(count / 16_384));
    assert.ok(observations <= count, 'no retained empty fragment per escape');
    let largest = 0;
    assert.throws(() => parseJSONChunks([`"${'\\n'.repeat(10_000)}"`], 8_000, { onStringBuffers(_buffers, _pending, decoded) { largest = decoded; } }), /Invalid/u);
    assert.equal(largest, 8_000, 'decoded schema ceiling applies before assembling a longer string');
  });

  it('rejects escaped multipart strings exceeding their schema bound before any profile writes', async (t) => {
    const idb = installChatIndexedDB(t);
    const source = await store(t, 'overlong-token-source', false);
    const internals = source as unknown as { state: { records: Map<string, { profile: ProfileRecord }> } };
    internals.state.records.get(source.activeProfileId)!.profile.entries = [entry('oversized', '\n'.repeat(PROFILE_LIMITS.entryText + 1))];
    const files = await downloadFiles(source, { _testing: { fileBytes: 64 * 1_024 } });
    const target = await store(t, 'overlong-token-target');
    const before = target.profiles; const writes = idb.writes.length;
    await assert.rejects(target.restoreFiles(files.map((file) => file.text)), /Invalid/u);
    assert.deepEqual(target.profiles, before);
    assert.equal(idb.writes.length, writes);
  });

  it('explicitly removes unprovable old data and proof while preserving current profiles and unrelated records', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'explicit-legacy');
    await manager.storage(manager.activeProfileId).saveEntries([entry('current')]);
    await manager.storage(manager.activeProfileId).saveConnection(connection);
    const before = manager.profiles;
    const legacy = new Map<string, unknown>([['entries', [entry('forgotten', 'Already cleared old message')]], ['connection', { ...connection, apiKey: 'Forgotten old key' }], ['entriesEpoch', 'old'], ['unrelated', 'preserve']]);
    idb.databases.set('explicit-legacy:chat', legacy);
    const profiles = idb.databases.get('explicit-legacy:profiles')!;
    profiles.set('legacyMigration', { version: 1, entries: [jsonFingerprint(entry('irrelevant'))], connections: [] });
    await manager.clearLegacyData();
    assertLegacyRetired(legacy);
    assert.equal(legacy.get('unrelated'), 'preserve');
    assert.equal(profiles.has('legacyMigration'), false);
    assert.deepEqual(manager.profiles, before);
    assert.deepEqual((await store(t, 'explicit-legacy')).profiles, before);
  });

  for (const failure of ['open', 'write', 'commit'] as const) {
    it(`reports explicit recovery ${failure} failures and allows a later retry`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `explicit-failure-${failure}`;
      const manager = await store(t, namespace);
      const before = manager.profiles;
      const legacy = new Map<string, unknown>([['entries', [entry('unknown')]], ['connection', connection]]);
      idb.databases.set(`${namespace}:chat`, legacy);
      idb.fail(failure);
      await assert.rejects(manager.clearLegacyData(), { code: 'legacy-cleanup' });
      assert.deepEqual(legacy.get('entries'), [entry('unknown')]);
      assert.deepEqual(manager.profiles, before);
      assert.equal(manager.persistenceWarning, false);
      idb.fail('none');
      await manager.clearLegacyData();
      assertLegacyRetired(legacy);
      assert.deepEqual(manager.profiles, before);
    });
  }

  it('does not reconcile or read/hash legacy records on ordinary history/settings/memory writes', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('old')]], ['connection', connection]]);
    idb.databases.set('reconcile-cost:chat', legacy);
    const manager = await store(t, 'reconcile-cost');
    legacy.set('entries', [entry('unknown', 'Retain this unprovable old archive')]);
    const before = idb.opened.filter((name) => name === 'reconcile-cost:chat').length;
    const id = manager.activeProfileId; const storage = manager.runtimeStorage(id);
    await storage.load();
    for (let i = 0; i < 25; i++) {
      await storage.saveEntries([entry('stream', `Partial reply ${i}`)], ['stream']);
      await manager.update(id, { personality: `Updated ${i}` });
    }
    await manager.saveMemory(id, { text: 'No legacy scan' });
    assert.equal(idb.opened.filter((name) => name === 'reconcile-cost:chat').length, before);
    await storage.clearEntries();
    assert.ok(idb.opened.filter((name) => name === 'reconcile-cost:chat').length > before);
    assert.deepEqual(legacy.get('entries'), [entry('unknown', 'Retain this unprovable old archive')]);
    await storage.saveEntries([entry('unknown', 'Retain this unprovable old archive')]);
    await storage.clearEntries();
    assertLegacyRetired(legacy);
  });
});

describe('fresh legacy privacy barriers and abortable download preflight', () => {
  for (const mutation of ['clear', 'opt-out', 'replace', 'delete-entry', 'delete-profile'] as const) {
    it(`refreshes a cached empty legacy database before ${mutation} without a local revision change`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `fresh-legacy-${mutation}`;
      const manager = await store(t, namespace);
      const id = manager.activeProfileId;
      const saved = entry('same', 'Copied in an older tab');
      await manager.storage(id).saveEntries([saved]);
      await manager.storage(id).saveConnection(connection);
      if (mutation === 'delete-profile') await manager.create({ name: 'Keep' });
      // Prime an empty check at precisely the current local revision. The older
      // tab then writes matching legacy data without touching this store at all.
      await (manager as unknown as { reconcileLegacy(force: boolean): Promise<void> }).reconcileLegacy(true);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('entries', [saved]); legacy.set('connection', connection);
      if (mutation === 'clear') await manager.storage(id).clearEntries();
      else if (mutation === 'opt-out') await manager.storage(id).saveConnection(connection, { rememberCredentials: false });
      else if (mutation === 'replace') await manager.storage(id).saveConnection({ ...connection, apiKey: 'replacement-fixture-key' });
      else if (mutation === 'delete-entry') await manager.removeEntry(id, saved.id);
      else await manager.remove(id);
      assertLegacyRetired(legacy);
      assert.equal(manager.persistenceWarning, false);
    });
  }

  for (const initialEpoch of [undefined, 'existing-barrier']) {
    for (const removal of ['explicit', 'automatic'] as const) {
      it(`${removal} legacy deletion blocks a stale writer with original epoch ${initialEpoch ?? 'absent'}`, async (t) => {
        const idb = installChatIndexedDB(t);
        const namespace = `stale-legacy-${removal}-${initialEpoch ?? 'none'}`;
        const legacy = new Map<string, unknown>([['entries', [entry('old')]], ['connection', connection]]);
        if (initialEpoch) legacy.set('entriesEpoch', initialEpoch);
        idb.databases.set(`${namespace}:chat`, legacy);
        const stale = new LegacyV1ChatFixture(namespace); t.after(() => stale.close());
        const snapshot = (await stale.load()).entries;
        const manager = await store(t, namespace);
        if (removal === 'explicit') await manager.clearLegacyData();
        const barrier = legacy.get('entriesEpoch');
        assert.equal(typeof barrier, 'string');
        assert.notEqual(barrier, initialEpoch);
        await stale.saveEntries([...snapshot, entry('late')]);
        await stale.saveEntries([entry('old', 'late edit'), entry('another-late')]);
        assertLegacyRetired(legacy);
        assert.equal(legacy.get('entriesEpoch'), barrier);
      });
    }
  }

  it('explicitly cleans persistent legacy data from a memory-only host without changing its RAM profile', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('old')]], ['connection', connection], ['entriesEpoch', 'old']]);
    idb.databases.set('memory-host:chat', legacy);
    const persisted = new Map<string, unknown>([['unrelated', 'keep'], ['legacyMigration', { version: 1, entries: [], connections: [] }]]);
    idb.databases.set('memory-host:profiles', persisted);
    const manager = await store(t, 'memory-host', false);
    await manager.storage(manager.activeProfileId).saveEntries([entry('ram')]);
    await manager.storage(manager.activeProfileId).saveConnection(connection);
    const before = manager.profiles;
    await manager.clearLegacyData();
    assertLegacyRetired(legacy);
    assert.notEqual(legacy.get('entriesEpoch'), 'old');
    assert.deepEqual([...persisted], [['unrelated', 'keep']]);
    assert.deepEqual(manager.profiles, before);
  });

  it('allows a timer to abort a supported large archive during measurement before returning any iterator', async (t) => {
    const manager = await store(t, 'abort-measurement', false);
    const controller = new AbortController();
    let inspected = 0; let timerRan = false; let envelopes = 0;
    const body = 'x'.repeat(8_000);
    const entries = Array.from({ length: 70_000 }, (_, i) => {
      const value = entry(`large-abort-${i}`, body);
      Object.defineProperty(value, 'text', { enumerable: true, get() {
        inspected++;
        if (inspected === 1) setTimeout(() => { timerRan = true; controller.abort(); }, 0);
        return body;
      } });
      return value;
    });
    const internal = manager as unknown as { state: { records: Map<string, { profile: ProfileRecord }> } };
    internal.state.records.get(manager.activeProfileId)!.profile.entries = entries;
    const stringify = JSON.stringify;
    t.mock.method(JSON, 'stringify', ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'format' in value && value.format === 'peetty-backup-part') envelopes++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify);
    await assert.rejects(manager.backupDownload({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(timerRan, true);
    assert.ok(inspected > 0 && inspected < 1_000, `cancellation should stop a bounded measurement batch, saw ${inspected}`);
    const stopped = inspected;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(inspected, stopped);
    assert.equal(envelopes, 0);
  });

  it('rejects already aborted backups and propagates iterator abort without producing more files', async (t) => {
    const manager = await store(t, 'abort-iterator', false);
    await manager.storage(manager.activeProfileId).saveEntries([entry('long', 'x'.repeat(10_000))]);
    const canceled = new AbortController(); canceled.abort();
    await assert.rejects(manager.backupDownload({ signal: canceled.signal }), { name: 'AbortError' });
    const active = new AbortController();
    const output = await manager.backupDownload({ signal: active.signal, _testing: { fileBytes: 2_048 } });
    assert.notEqual(typeof output, 'string');
    const iterator = (output as AsyncIterable<BackupDownloadFile>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false); assert.equal(first.value!.final, undefined);
    active.abort();
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    await iterator.return?.();
  });
});

describe('legacy active-work and empty-sentinel lifecycle', () => {
  for (const epoch of [undefined, 'old-live-epoch']) {
    it(`preserves a real old-tab pending reply during partial automatic retirement with epoch ${epoch ?? 'absent'}`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `partial-live-${epoch ?? 'none'}`;
      const manager = await store(t, namespace);
      const id = manager.activeProfileId;
      await manager.storage(id).saveEntries([entry('copied')]);
      await manager.storage(id).saveConnection(connection);
      const original = [entry('copied'), entry('active-user', 'A user turn not copied to profiles')];
      const legacy = new Map<string, unknown>([['entries', original], ['connection', connection]]);
      if (epoch) legacy.set('entriesEpoch', epoch);
      idb.databases.set(`${namespace}:chat`, legacy);
      const active = new LegacyV1ChatFixture(namespace); t.after(() => active.close());
      const snapshot = (await active.load()).entries;
      const reopened = await store(t, namespace);
      assert.deepEqual(legacy.get('entries'), original, 'partial automatic retirement must keep the full source history');
      assert.equal(legacy.get('entriesEpoch'), epoch, 'active history barrier must not change');
      assert.equal(legacy.has('connection'), false, 'copied credentials can retire independently');
      assert.equal(typeof legacy.get('connectionEpoch'), 'string');
      const reply = { ...entry('pending-reply', 'The delayed response completed'), role: 'assistant' as const };
      await active.saveEntries([...snapshot, reply]);
      assert.deepEqual(legacy.get('entries'), [...original, reply]);
      // Once all work has actually been copied, ordinary privacy cleanup can
      // retire it completely and use the history barrier again.
      await reopened.storage(id).saveEntries([...original, reply]);
      await reopened.storage(id).clearEntries();
      assertLegacyRetired(legacy);
      assert.notEqual(legacy.get('entriesEpoch'), epoch);
    });
  }

  it('treats barrier-only legacy state after a memory-only cleanup as pristine for a maximum restore', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('erased')]], ['connection', connection]]);
    idb.databases.set('sentinel-bootstrap:chat', legacy);
    const memoryOnly = await store(t, 'sentinel-bootstrap', false);
    await memoryOnly.clearLegacyData();
    assertLegacyRetired(legacy);
    assert.equal(typeof legacy.get('connectionEpoch'), 'string');
    const fresh = await store(t, 'sentinel-bootstrap');
    assert.deepEqual(fresh.activeProfile.entries, []);
    assert.equal(fresh.activeProfile.connection, undefined);
    await fresh.restore(fullBackup());
    assert.equal(fresh.listProfiles().length, PROFILE_LIMITS.profiles);
    assert.equal(fresh.profileInfo(fresh.activeProfileId)!.name, 'import-99');
    assertLegacyRetired(legacy);
    assert.equal(JSON.stringify([...idb.databases.get('sentinel-bootstrap:profiles')!]).includes(connection.apiKey!), false);
  });
});

describe('explicit privacy cleanup of partially migrated history', () => {
  for (const operation of ['clear', 'delete-entry', 'delete-profile'] as const) {
    it(`removes proven legacy copies during explicit ${operation} while preserving uncopied history`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `mixed-privacy-${operation}`;
      const first = await store(t, namespace);
      const id = first.activeProfileId;
      const copied = entry('copied', 'A copied message the user will remove');
      const uncopied = entry('uncopied', 'An independent old-tab message');
      await first.storage(id).saveEntries([copied]);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('entries', [copied, uncopied]); legacy.set('entriesEpoch', 'active-history');
      const old = new LegacyV1ChatFixture(namespace); t.after(() => old.close());
      const snapshot = (await old.load()).entries;
      const manager = await store(t, namespace);
      assert.deepEqual(legacy.get('entries'), [copied, uncopied]);
      assert.equal(legacy.get('entriesEpoch'), 'active-history');
      assert.equal(idb.versions.get(`${namespace}:chat`), 1, 'automatic partial migration must not fence active legacy work');
      const reply = { ...entry('reply', 'The old tab completed its pending reply'), role: 'assistant' as const };
      await old.saveEntries([...snapshot, reply]);
      if (operation === 'clear') await manager.storage(id).clearEntries();
      else if (operation === 'delete-entry') await manager.removeEntry(id, copied.id);
      else { await manager.create({ name: 'Keep' }); await manager.remove(id); }
      assert.deepEqual(legacy.get('entries'), [uncopied, reply]);
      assert.notEqual(legacy.get('entriesEpoch'), 'active-history');
      assert.equal(JSON.stringify([...legacy]).includes(copied.text), false);
    });
  }
});

describe('destructive cleanup races and credential-value provenance', () => {
  for (const operation of ['clear', 'delete-entry', 'delete-profile'] as const) {
    it(`rejects explicit ${operation} before changing profiles when an old tab appends between read and CAS`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `privacy-cas-${operation}`;
      const manager = await store(t, namespace);
      const id = manager.activeProfileId;
      const copied = entry('copied'); const uncopied = entry('uncopied'); const concurrent = entry('concurrent');
      await manager.storage(id).saveEntries([copied]);
      if (operation === 'delete-profile') await manager.create({ name: 'Keep' });
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('entries', [copied, uncopied]); legacy.set('entriesEpoch', 'old');
      const old = new LegacyV1ChatFixture(namespace); t.after(() => old.close());
      const snapshot = (await old.load()).entries;
      const seam = manager as unknown as { retireLegacy: (...args: unknown[]) => Promise<void> };
      const retire = seam.retireLegacy.bind(manager); let inject = true;
      t.mock.method(seam, 'retireLegacy', async (...args: unknown[]) => {
        if (inject && args[2] !== 'automatic') {
          inject = false;
          if (operation === 'delete-profile') {
            // The v1 adapter was correctly fenced already. Model a concurrent
            // latest-version source writer without inventing a production one.
            const writer = await openStateDatabase(`${namespace}:chat`, { isClosed: () => false, onFailure: () => {} }, 'latest');
            assert.ok(writer);
            try { assert.equal(await stateTransaction(writer, true, (store) => { store.put([...snapshot, concurrent], 'entries'); }), true); }
            finally { writer.close(); }
          } else await old.saveEntries([...snapshot, concurrent]);
        }
        return retire(...args);
      });
      const perform = () => operation === 'clear' ? manager.storage(id).clearEntries()
        : operation === 'delete-entry' ? manager.removeEntry(id, copied.id) : manager.remove(id);
      const before = manager.profiles;
      await assert.rejects(perform(), { code: 'legacy-cleanup' });
      assert.deepEqual(manager.profiles, before);
      assert.deepEqual(legacy.get('entries'), [copied, uncopied, concurrent]);
      await perform();
      assert.deepEqual(legacy.get('entries'), [uncopied, concurrent]);
      if (operation === 'delete-profile') assert.equal(manager.profileInfo(id), undefined);
      else assert.equal(manager.profileInfo(id)!.entryCount, 0);
    });
  }

  it('rejects a legacy history transaction abort before clearing the current profile', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'privacy-tx-abort');
    const id = manager.activeProfileId; const copied = entry('copied');
    await manager.storage(id).saveEntries([copied]);
    const legacy = idb.databases.get('privacy-tx-abort:chat')!;
    legacy.set('entries', [copied]);
    const seam = manager as unknown as { retireLegacy: (...args: unknown[]) => Promise<void> };
    const retire = seam.retireLegacy.bind(manager); let inject = true;
    t.mock.method(seam, 'retireLegacy', async (...args: unknown[]) => {
      if (inject && args[2] === 'history') { inject = false; idb.fail('commit'); }
      return retire(...args);
    });
    const before = manager.profiles;
    await assert.rejects(manager.storage(id).clearEntries(), { code: 'legacy-cleanup' });
    assert.deepEqual(manager.profiles, before);
    assert.deepEqual(legacy.get('entries'), [copied]);
    idb.fail('none'); await manager.storage(id).clearEntries();
    assertLegacyRetired(legacy);
    assert.equal(manager.profileInfo(id)!.entryCount, 0);
  });

  for (const rotated of [false, true]) {
    it(`forgets credential values independently of legacy metadata while preserving ${rotated ? 'an unrelated newer key' : 'new routing and a second credential'}`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `credential-values-${rotated}`;
      const manager = await store(t, namespace);
      const id = manager.activeProfileId;
      const saved = { ...connection, headers: { authorization: `Bearer ${connection.apiKey}`, 'openai-project': 'old-project' } };
      await manager.storage(id).saveConnection(saved);
      const runtime = new ChatRuntime({ storage: manager.storage(id) }); t.after(() => runtime.destroy());
      await runtime.initialize();
      const newer: StoredConnection = { ...connection, id: 'newer-model', tools: true, effort: 'high', provider: 'newer-provider',
        apiKey: rotated ? 'unrelated-new-key' : connection.apiKey!, headers: {
          authorization: rotated ? 'Bearer unrelated-new-key' : `Bearer ${connection.apiKey}`,
          'openai-project': 'new-project', 'x-other-auth': 'independent-new-credential',
        } };
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('connection', newer); legacy.set('entries', [entry('independent')]);
      await runtime.configure(runtime.model!, false);
      const current = legacy.get('connection') as StoredConnection;
      assert.equal(current.id, newer.id); assert.equal(current.provider, newer.provider);
      assert.equal(current.tools, true); assert.equal(current.effort, 'high');
      assert.equal(current.headers!['openai-project'], 'new-project');
      assert.equal(current.headers!['x-other-auth'], 'independent-new-credential');
      assert.equal(current.apiKey, rotated ? 'unrelated-new-key' : undefined);
      assert.equal(current.headers!.authorization, rotated ? 'Bearer unrelated-new-key' : undefined);
      assert.equal(JSON.stringify(current).includes(connection.apiKey!), false);
      assert.equal(manager.storedConnection(id)!.apiKey, undefined);
      assert.equal(runtime.rememberKey, false);
      assert.equal(JSON.stringify([...idb.databases.get(`${namespace}:profiles`)!]).includes('credentialsToForget'), false);
    });
  }

  it('retains committed profile credentials and cleanup debt across repeated failed profile commits', async (t) => {
    const idb = installChatIndexedDB(t);
    const manager = await store(t, 'profile-cleanup-debt'); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection(connection);
    const runtime = new ChatRuntime({ storage: manager.storage(id) }); t.after(() => runtime.destroy());
    await runtime.initialize();
    const seam = manager as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
    const reconcile = seam.reconcileLegacy.bind(manager); let abort = true;
    t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
      await reconcile(...args);
      if (abort && args[1] === 'credentials') idb.fail('commit');
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      idb.fail('none');
      await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
      assert.equal(manager.storedConnection(id)!.apiKey, connection.apiKey);
      const persisted = idb.databases.get('profile-cleanup-debt:profiles')!.get(`profile:${id}`) as { profile: ProfileRecord };
      assert.equal(persisted.profile.connection!.apiKey, connection.apiKey);
      const fresh = await store(t, 'profile-cleanup-debt');
      assert.equal(fresh.storedConnection(id)!.apiKey, connection.apiKey);
    }
    abort = false; idb.fail('none');
    await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
    assert.equal(manager.storedConnection(id)!.apiKey, connection.apiKey);
    assert.equal(manager.persistenceWarning, true, 'sticky RAM fallback requires reload, never a hidden warning reset');
    const reloaded = await store(t, 'profile-cleanup-debt');
    const replacement = new ChatRuntime({ storage: reloaded.runtimeStorage(id) }); t.after(() => replacement.destroy());
    await replacement.initialize(); await replacement.configure(replacement.model!, false);
    assert.equal(reloaded.storedConnection(id)!.apiKey, undefined);
    assert.equal((idb.databases.get('profile-cleanup-debt:profiles')!.get(`profile:${id}`) as { profile: ProfileRecord }).profile.connection!.apiKey, undefined);
    assert.equal(replacement.rememberKey, false);
  });
});

describe('single production persistence boundary and durable privacy operations', () => {
  for (const failure of ['write', 'put', 'commit'] as const) {
    it(`rejects profile deletion after a ${failure} failure and preserves committed profile, selection and session`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `durable-remove-${failure}`;
      const manager = await store(t, namespace);
      await manager.restore(document([profile('target', { connection, entries: [entry('saved')] })], [
        { profileId: 'target', connection: { ...connection, apiKey: 'session-key' }, rememberKey: false },
      ]));
      const id = manager.activeProfileId; const before = manager.profiles;
      const sessions = (await manager.storage(id).load()).sessionConnections;
      const seam = manager as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
      const reconcile = seam.reconcileLegacy.bind(manager);
      t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
        await reconcile(...args); if (args[1] === 'profile') idb.fail(failure);
      });
      await assert.rejects(manager.remove(id), { code: 'profile-delete' });
      assert.deepEqual(manager.profiles, before);
      assert.equal(manager.activeProfileId, id);
      assert.deepEqual((await manager.storage(id).load()).sessionConnections, sessions);
      idb.fail('none');
      const reopened = await store(t, namespace);
      assert.deepEqual(reopened.profiles, before);
      assert.equal(reopened.storedConnection(id)!.apiKey, connection.apiKey);
    });
  }

  it('permits explicit memory-only profile removal without implying a persistent deletion', async (t) => {
    const manager = await store(t, 'ram-remove', false);
    const target = await manager.create({ name: 'RAM target' });
    await manager.storage(target.id).saveConnection(connection);
    await manager.remove(target.id);
    assert.equal(manager.profileInfo(target.id), undefined);
    assert.equal(manager.listProfiles().length, 1);
    assert.equal(manager.persistenceWarning, false);
  });

  it('rejects credential saves after an unknown persistent read while preserving session-only configuration', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'unknown-persistent-connection';
    const committed = await store(t, namespace);
    const committedId = committed.activeProfileId;
    await committed.storage(committedId).saveConnection(connection);
    const before = structuredClone(idb.databases.get(`${namespace}:profiles`));
    idb.fail('open');
    const unknown = await store(t, namespace);
    const runtime = new ChatRuntime({ model: { ...connection, apiKey: 'session-only-new-key' }, storage: unknown.runtimeStorage(unknown.activeProfileId) });
    t.after(() => runtime.destroy());
    await runtime.initialize();
    await runtime.setModel({ ...connection, id: 'session-remains-usable', apiKey: 'session-only-new-key' });
    assert.equal(runtime.model!.id, 'session-remains-usable');
    await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
    assert.equal(unknown.activeProfile.connection, undefined);
    assert.deepEqual(idb.databases.get(`${namespace}:profiles`), before);
    assert.equal(runtime.model!.apiKey, 'session-only-new-key');
    idb.fail('none');
    await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
    assert.deepEqual(idb.databases.get(`${namespace}:profiles`), before);
    const reopened = await store(t, namespace);
    assert.equal(reopened.storedConnection(committedId)!.apiKey, connection.apiKey);
  });

  it('retains unsaved RAM history and its warning across failed credential saves and retries', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'sticky-ram-history';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection(connection);
    idb.fail('write');
    const unsaved = entry('unsaved-turn', 'An important turn not yet on disk');
    await manager.storage(id).saveEntries([unsaved]);
    assert.equal(manager.persistenceWarning, true);
    assert.deepEqual(manager.historyPage(id, '', 10).entries, [unsaved]);
    idb.fail('none');
    const runtime = new ChatRuntime({ storage: manager.runtimeStorage(id) }); t.after(() => runtime.destroy());
    await runtime.initialize();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
      assert.deepEqual(runtime.entries, [unsaved]);
      assert.deepEqual(manager.historyPage(id, '', 10).entries, [unsaved]);
      assert.equal(manager.persistenceWarning, true);
    }
    const disk = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { profile: ProfileRecord };
    assert.deepEqual(disk.profile.entries, []);
    assert.equal(disk.profile.connection!.apiKey, connection.apiKey);
    assert.deepEqual(decode(await manager.backup()).profiles[0]!.entries, [unsaved], 'unsaved turns remain exportable');
  });

  it('does not mistake unrelated known C for identification of an unresolved callback legacy key K', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'unresolved-callback-residue';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection({ ...connection, apiKey: 'known-C' });
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, id: 'independent-legacy-model', apiKey: 'unresolved-K' });
    let resolved = 0;
    const runtime = new ChatRuntime({ model: { id: connection.id, baseUrl: connection.baseUrl, getApiKey: () => { resolved++; return 'unresolved-K'; } }, storage: manager.runtimeStorage(id) });
    t.after(() => runtime.destroy()); await runtime.initialize();
    await assert.rejects(runtime.configure(runtime.model!, false), { code: 'legacy-cleanup' });
    assert.equal(resolved, 0);
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'unresolved-K');
    assert.equal(manager.storedConnection(id)!.apiKey, 'known-C');
    await manager.clearLegacyData();
    await runtime.configure(runtime.model!, false);
    assert.equal(resolved, 0);
    assert.equal(manager.storedConnection(id)!.apiKey, undefined);
    assert.equal(legacy.has('connection'), false);
  });
});

describe('profile authentication generation and complete cleanup debt', () => {
  function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve: () => resolve() };
  }

  for (const endpointChanged of [false, true]) {
    for (const oldRecord of [false, true]) {
      it(`rejects a remembered save resumed after peer opt-out with endpoint change ${endpointChanged} and pre-generation record ${oldRecord}`, async (t) => {
        const idb = installChatIndexedDB(t);
        const namespace = `auth-generation-${endpointChanged}-${oldRecord}`;
        const first = await store(t, namespace); const id = first.activeProfileId;
        await first.storage(id).saveConnection(connection, { rememberCredentials: true });
        if (oldRecord) {
          const raw = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { connectionEpoch?: string };
          delete raw.connectionEpoch;
          await first.storage(id).load();
        }
        const peer = await store(t, namespace);
        const paused = latch(); const release = latch(); t.after(() => release.resolve());
        const seam = first as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
        const reconcile = seam.reconcileLegacy.bind(first);
        t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
          await reconcile(...args); paused.resolve(); await release.promise;
        });
        const stale = { ...connection, baseUrl: 'https://pending-save.example/v1', effort: 'high' as const };
        const saving = first.storage(id).saveConnection(stale, { rememberCredentials: true });
        const rejected = assert.rejects(saving, { code: 'stale-connection' });
        await paused.promise;
        const peerChoice = { ...connection, ...(endpointChanged ? { baseUrl: 'https://peer-choice.example/v1' } : {}) };
        await peer.storage(id).load();
        await peer.storage(id).saveConnection(peerChoice, { rememberCredentials: false });
        const committed = peer.storedConnection(id);
        release.resolve(); await rejected;
        assert.equal(first.persistenceWarning, false);
        assert.equal(peer.storedConnection(id)!.apiKey, undefined);
        const reopened = await store(t, namespace);
        assert.deepEqual(reopened.storedConnection(id), committed);
        assert.equal(reopened.storedConnection(id)!.baseUrl, peerChoice.baseUrl);
        assert.equal(reopened.storedConnection(id)!.apiKey, undefined);
        assert.deepEqual(first.storedConnection(id), committed, 'rejection must refresh the cache for one fresh explicit retry');
        const debt = first as unknown as { cleanupDebt: Map<string, unknown> };
        assert.equal(debt.cleanupDebt.has(id), true, 'stale rejection must not discard pending cleanup');
        const retry = { ...stale, apiKey: 'fresh-reconfirmed-key' };
        await first.storage(id).saveConnection(retry, { rememberCredentials: true });
        assert.deepEqual(first.storedConnection(id), retry);
        assert.equal(debt.cleanupDebt.has(id), false);
      });
    }
  }

  it('allows metadata/history writes and other-profile opt-outs without invalidating a connection save', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'auth-generation-metadata';
    const first = await store(t, namespace); const id = first.activeProfileId;
    await first.storage(id).saveConnection(connection, { rememberCredentials: true });
    const generation = (idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { connectionEpoch: string }).connectionEpoch;
    const peer = await store(t, namespace);
    const paused = latch(); const release = latch(); t.after(() => release.resolve());
    const seam = first as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
    const reconcile = seam.reconcileLegacy.bind(first);
    t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
      await reconcile(...args); paused.resolve(); await release.promise;
    });
    const desired = { ...connection, id: 'desired-model', effort: 'high' as const };
    const saving = first.storage(id).saveConnection(desired, { rememberCredentials: true });
    await paused.promise;
    await peer.update(id, { name: 'Peer name', personality: 'Peer personality' });
    await peer.storage(id).saveEntries([entry('peer-entry')]);
    await peer.saveMemory(id, { text: 'Peer fact' });
    await peer.storage(id).saveConnection({ ...connection, id: 'peer-model', effort: 'low', tools: false, provider: 'peer-provider' }, { rememberCredentials: true });
    const other = await peer.create({ name: 'Other' });
    await peer.storage(other.id).saveConnection({ ...connection, apiKey: 'other-key' });
    await peer.storage(other.id).saveConnection(connection, { rememberCredentials: false });
    assert.equal((idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { connectionEpoch: string }).connectionEpoch, generation);
    release.resolve(); await saving;
    const reopened = await store(t, namespace);
    assert.deepEqual(reopened.storedConnection(id), desired);
    assert.equal(reopened.profileInfo(id)!.name, 'Peer name');
    assert.equal(reopened.profileInfo(id)!.personality, 'Peer personality');
    assert.deepEqual(reopened.historyPage(id, '', 10).entries, [entry('peer-entry')]);
    assert.deepEqual(reopened.memoryTexts(id), [{ text: 'Peer fact' }]);
    assert.equal(reopened.storedConnection(other.id)!.apiKey, undefined);
    assert.equal((idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { connectionEpoch: string }).connectionEpoch, generation);
  });

  for (const recovery of ['explicit', 'identified'] as const) {
    it(`retains unresolved authentication across ordinary retries until ${recovery} cleanup actually removes it`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `unresolved-debt-${recovery}`;
      const manager = await store(t, namespace); const id = manager.activeProfileId;
      const known = { ...connection, apiKey: 'known-C' };
      await manager.storage(id).saveConnection(known);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('connection', { ...connection, id: 'legacy-model', apiKey: 'unknown-K' });
      const adapter = manager.storage(id);
      const keyless = { id: connection.id, baseUrl: connection.baseUrl };
      await assert.rejects(adapter.saveConnection(keyless, {
        rememberCredentials: false, credentialsToForget: [known], authenticationIntent: true, unresolvedAuthentication: true,
      }), { code: 'legacy-cleanup' });
      for (const rememberCredentials of [false, true, false]) {
        await assert.rejects(adapter.saveConnection(keyless, { rememberCredentials }), { code: 'legacy-cleanup' });
        assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'unknown-K');
        assert.equal(manager.storedConnection(id)!.apiKey, 'known-C');
        assert.equal(manager.persistenceWarning, false);
      }
      const debt = manager as unknown as { cleanupDebt: Map<string, { credentials: readonly StoredConnection[]; unresolvedAuthentication: boolean }> };
      assert.equal(debt.cleanupDebt.get(id)!.unresolvedAuthentication, true);
      if (recovery === 'explicit') {
        await manager.clearLegacyData();
        assert.equal(debt.cleanupDebt.has(id), false);
        await adapter.saveConnection(keyless, { rememberCredentials: false });
      } else {
        await adapter.saveConnection(keyless, { rememberCredentials: false, credentialsToForget: [{ ...connection, apiKey: 'unknown-K' }] });
      }
      assert.equal((legacy.get('connection') as StoredConnection | undefined)?.apiKey, undefined);
      assert.equal(manager.storedConnection(id)!.apiKey, undefined);
      assert.equal(debt.cleanupDebt.has(id), false);
      assert.equal(JSON.stringify(idb.databases.get(`${namespace}:profiles`)!.get('legacyMigration') ?? {}).includes('unknown-K'), false);
    });
  }

  it('rejects profile deletion while unresolved cleanup debt remains and permits it after explicit recovery', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'delete-unresolved-debt';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    const known = { ...connection, apiKey: 'known-C' };
    await manager.storage(id).saveConnection(known);
    await manager.create({ name: 'Keep' });
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, id: 'legacy-model', apiKey: 'unknown-K' });
    const keyless = { id: connection.id, baseUrl: connection.baseUrl };
    await assert.rejects(manager.storage(id).saveConnection(keyless, {
      rememberCredentials: false, credentialsToForget: [known], authenticationIntent: true, unresolvedAuthentication: true,
    }), { code: 'legacy-cleanup' });
    const before = manager.profiles;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(manager.remove(id), { code: 'legacy-cleanup' });
      assert.deepEqual(manager.profiles, before);
      assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'unknown-K');
    }
    await assert.rejects(manager.storage(id).saveConnection(keyless, { rememberCredentials: false }), { code: 'legacy-cleanup' });
    await assert.rejects(manager.remove(id), { code: 'legacy-cleanup' });
    await manager.clearLegacyData();
    await manager.remove(id);
    assert.equal(manager.profileInfo(id), undefined);
    assert.equal(legacy.has('connection'), false);
    const reopened = await store(t, namespace);
    assert.equal(reopened.profileInfo(id), undefined);
    assert.equal(reopened.listProfiles().length, 1);
  });

  it('uses pending known credential sources during profile deletion even when the profile never stored that key', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'delete-known-debt';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    await manager.create({ name: 'Keep' });
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, id: 'independent-legacy-metadata', apiKey: 'pending-K' });
    const seam = manager as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
    const reconcile = seam.reconcileLegacy.bind(manager); let block = true;
    t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
      if (block && args[1] === 'credentials') { block = false; throw new ChatStorageError('legacy-cleanup', 'Fixed cleanup failure.'); }
      return reconcile(...args);
    });
    await assert.rejects(manager.storage(id).saveConnection({ id: connection.id, baseUrl: connection.baseUrl }, {
      rememberCredentials: false, credentialsToForget: [{ ...connection, apiKey: 'pending-K' }], authenticationIntent: true,
    }), { code: 'legacy-cleanup' });
    assert.equal(manager.storedConnection(id), undefined);
    await manager.remove(id);
    assert.equal(manager.profileInfo(id), undefined);
    assert.equal((legacy.get('connection') as StoredConnection | undefined)?.apiKey, undefined);
    assert.equal((legacy.get('connection') as StoredConnection).id, 'independent-legacy-metadata');
  });
});

describe('request-time saves and durable unresolved intent', () => {
  function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve: () => resolve() };
  }

  for (const queuedBehind of ['update', 'initialize'] as const) {
    for (const differentEndpoint of [false, true]) {
      it(`rejects an old key submitted behind ${queuedBehind} when a peer opts out at a different endpoint ${differentEndpoint}`, async (t) => {
        installChatIndexedDB(t);
        const namespace = `request-queue-${queuedBehind}-${differentEndpoint}`;
        const seeded = await store(t, namespace); const id = seeded.activeProfileId;
        await seeded.storage(id).saveConnection(connection, { rememberCredentials: true });
        const first = queuedBehind === 'update' ? seeded : new BrowserProfileStore(namespace);
        if (first !== seeded) t.after(() => first.close());
        const peer = await store(t, namespace);
        const blocked = latch(); const release = latch(); t.after(() => release.resolve());
        const seam = first as unknown as { open: () => Promise<IDBDatabase | undefined> };
        const open = seam.open.bind(first); let once = true;
        t.mock.method(seam, 'open', async () => {
          if (once) { once = false; blocked.resolve(); await release.promise; }
          return open();
        });
        const earlier = queuedBehind === 'update' ? first.update(id, { name: 'Queued metadata' }) : first.initialize();
        await blocked.promise;
        const stale = { ...connection, id: 'submitted-old-key' };
        const saving = first.storage(id).saveConnection(stale, { rememberCredentials: true });
        const rejected = assert.rejects(saving, { code: 'stale-connection' });
        const alsoQueued = first.storage(id).saveConnection({ ...stale, id: 'another-old-submission' }, { rememberCredentials: true });
        const alsoRejected = assert.rejects(alsoQueued, { code: 'stale-connection' });
        const peerChoice = { ...connection, ...(differentEndpoint ? { baseUrl: 'https://peer-changed.example/v1' } : {}) };
        await peer.storage(id).saveConnection(peerChoice, { rememberCredentials: false });
        const committed = peer.storedConnection(id);
        release.resolve(); await earlier; await Promise.all([rejected, alsoRejected]);
        assert.deepEqual(first.storedConnection(id), committed);
        assert.equal(first.storedConnection(id)!.apiKey, undefined);
        assert.equal(first.persistenceWarning, false);
        // A new user submission may reconfirm once, without a reload and without
        // ever automatically replaying the already-rejected old request.
        const retry = { ...connection, id: 'fresh-confirmation', apiKey: 'newly-confirmed-key' };
        await first.storage(id).saveConnection(retry, { rememberCredentials: true });
        assert.deepEqual(first.storedConnection(id), retry);
      });
    }
  }

  it('preserves metadata independence while a connection save waits behind another manager operation', async (t) => {
    installChatIndexedDB(t);
    const namespace = 'request-queue-metadata';
    const first = await store(t, namespace); const id = first.activeProfileId;
    await first.storage(id).saveConnection(connection);
    const peer = await store(t, namespace);
    const blocked = latch(); const release = latch(); t.after(() => release.resolve());
    const seam = first as unknown as { open: () => Promise<IDBDatabase | undefined> };
    const open = seam.open.bind(first); let once = true;
    t.mock.method(seam, 'open', async () => { if (once) { once = false; blocked.resolve(); await release.promise; } return open(); });
    const earlier = first.update(id, { name: 'Queued name' }); await blocked.promise;
    const desired = { ...connection, id: 'new-model-metadata' };
    const saving = first.storage(id).saveConnection(desired, { rememberCredentials: true });
    await peer.update(id, { personality: 'Peer personality' });
    await peer.storage(id).saveEntries([entry('peer-history')]);
    await peer.storage(id).saveConnection({ ...connection, effort: 'high' }, { rememberCredentials: true });
    release.resolve(); await earlier; await saving;
    assert.deepEqual(first.storedConnection(id), desired);
    assert.equal(first.profileInfo(id)!.name, 'Queued name');
    assert.equal(first.profileInfo(id)!.personality, 'Peer personality');
    assert.deepEqual(first.historyPage(id, '', 10).entries, [entry('peer-history')]);
  });

  it('allows a deliberate new save queued after this manager own committed opt-out', async (t) => {
    installChatIndexedDB(t);
    const manager = await store(t, 'request-own-write'); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection(connection);
    const forgetting = manager.storage(id).saveConnection(connection, { rememberCredentials: false });
    const fresh = { ...connection, apiKey: 'new-user-confirmed-key' };
    const saving = manager.storage(id).saveConnection(fresh, { rememberCredentials: true });
    await Promise.all([forgetting, saving]);
    assert.deepEqual(manager.storedConnection(id), fresh);
  });

  for (const recovery of ['explicit', 'identified'] as const) {
    it(`preserves unresolved callback intent across reopen, unrelated retry and deletion until ${recovery} recovery`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `durable-intent-${recovery}`;
      const creator = await store(t, namespace); const id = creator.activeProfileId;
      const known = { ...connection, apiKey: 'known-C' };
      await creator.storage(id).saveConnection(known);
      await creator.create({ name: 'Keep' });
      const preloaded = await store(t, namespace);
      const legacy = idb.databases.get(`${namespace}:chat`)!;
      legacy.set('connection', { ...connection, id: 'unknown-legacy-model', apiKey: 'unresolved-K' });
      const keyless = { id: connection.id, baseUrl: connection.baseUrl };
      await assert.rejects(creator.storage(id).saveConnection(keyless, {
        rememberCredentials: false, credentialsToForget: [known], authenticationIntent: true, unresolvedAuthentication: true,
      }), { code: 'legacy-cleanup' });
      const raw = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { profile: ProfileRecord; unresolvedCleanup?: string; connectionEpoch?: string };
      const marker = raw.unresolvedCleanup;
      assert.equal(typeof marker, 'string');
      assert.equal(raw.profile.connection!.apiKey, 'known-C');
      assert.equal(JSON.stringify([...idb.databases.get(`${namespace}:profiles`)!]).includes('unresolved-K'), false);
      assert.equal(JSON.stringify({ unresolvedCleanup: marker, connectionEpoch: raw.connectionEpoch }).includes('known-C'), false);
      // An already-open manager first gets a stale rejection, then sees durable
      // intent on a fresh request instead of downgrading it to known C alone.
      await assert.rejects(preloaded.storage(id).saveConnection(keyless, { rememberCredentials: false }), { code: 'stale-connection' });
      await assert.rejects(preloaded.storage(id).saveConnection(keyless, { rememberCredentials: false }), { code: 'legacy-cleanup' });
      creator.close();
      const reopened = await store(t, namespace);
      const before = reopened.profiles;
      await assert.rejects(reopened.storage(id).saveConnection(keyless, { rememberCredentials: false, credentialsToForget: [known] }), { code: 'legacy-cleanup' });
      await assert.rejects(reopened.storage(id).saveConnection(known, { rememberCredentials: true }), { code: 'legacy-cleanup' });
      await assert.rejects(reopened.remove(id), { code: 'legacy-cleanup' });
      assert.deepEqual(reopened.profiles, before);
      assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'unresolved-K');
      const currentIntent = (idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string }).unresolvedCleanup;
      assert.equal(typeof currentIntent, 'string', 'new submissions may rotate intent, never erase the unresolved obligation');
      const currentDebt = reopened as unknown as { cleanupDebt: Map<string, { intent?: string; unresolvedAuthentication: boolean }> };
      assert.equal(currentDebt.cleanupDebt.get(id)!.intent, currentIntent);
      assert.equal(currentDebt.cleanupDebt.get(id)!.unresolvedAuthentication, true);
      if (recovery === 'explicit') {
        await reopened.clearLegacyData();
        assert.equal((idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string }).unresolvedCleanup, undefined);
        await reopened.remove(id);
        assert.equal((await store(t, namespace)).profileInfo(id), undefined);
      } else {
        await reopened.storage(id).saveConnection(keyless, { rememberCredentials: false, credentialsToForget: [{ ...connection, apiKey: 'unresolved-K' }] });
        const committed = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { profile: ProfileRecord; unresolvedCleanup?: string };
        assert.equal(committed.unresolvedCleanup, undefined);
        assert.equal(committed.profile.connection!.apiKey, undefined);
        assert.equal((legacy.get('connection') as StoredConnection).apiKey, undefined);
        const verified = await store(t, namespace);
        await verified.remove(id);
        assert.equal(verified.profileInfo(id), undefined);
      }
    });
  }

  it('preserves a lost known-source cleanup obligation after reopen instead of accepting unrelated D', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'durable-known-source';
    const creator = await store(t, namespace); const id = creator.activeProfileId;
    const known = { ...connection, apiKey: 'stored-C' };
    await creator.storage(id).saveConnection(known); await creator.create({ name: 'Keep' });
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, id: 'old-session-model', apiKey: 'session-K' });
    const seam = creator as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
    const reconcile = seam.reconcileLegacy.bind(creator); let fail = true;
    t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
      if (fail && args[1] === 'credentials') { fail = false; throw new ChatStorageError('legacy-cleanup', 'Fixed cleanup failure.'); }
      return reconcile(...args);
    });
    const keyless = { id: connection.id, baseUrl: connection.baseUrl };
    await assert.rejects(creator.storage(id).saveConnection(keyless, {
      rememberCredentials: false, credentialsToForget: [{ ...connection, apiKey: 'session-K' }], authenticationIntent: true,
    }), { code: 'legacy-cleanup' });
    const raw = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string };
    assert.equal(typeof raw.unresolvedCleanup, 'string');
    assert.equal(JSON.stringify([...idb.databases.get(`${namespace}:profiles`)!]).includes('session-K'), false);
    creator.close();
    const reopened = await store(t, namespace);
    await assert.rejects(reopened.storage(id).saveConnection({ ...connection, apiKey: 'unrelated-D' }, { rememberCredentials: false }), { code: 'legacy-cleanup' });
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'session-K');
    assert.equal(reopened.storedConnection(id)!.apiKey, 'stored-C');
    await assert.rejects(reopened.remove(id), { code: 'legacy-cleanup' });
    const again = await store(t, namespace);
    await assert.rejects(again.storage(id).saveConnection(keyless, { rememberCredentials: false }), { code: 'legacy-cleanup' });
    await again.clearLegacyData(); await again.remove(id);
    assert.equal(again.profileInfo(id), undefined);
    assert.equal(legacy.has('connection'), false);
  });

  it('keeps same-manager known sources tied to their durable intent without blocking independent legacy J', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'durable-known-owner';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection({ ...connection, apiKey: 'stored-C' });
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, id: 'old-session-model', apiKey: 'session-K', headers: { 'x-other-auth': 'independent-J' } });
    const seam = manager as unknown as { reconcileLegacy: (...args: unknown[]) => Promise<void> };
    const reconcile = seam.reconcileLegacy.bind(manager); let fail = true;
    t.mock.method(seam, 'reconcileLegacy', async (...args: unknown[]) => {
      if (fail && args[1] === 'credentials') { fail = false; throw new ChatStorageError('legacy-cleanup', 'Fixed cleanup failure.'); }
      return reconcile(...args);
    });
    const keyless = { id: connection.id, baseUrl: connection.baseUrl };
    await assert.rejects(manager.storage(id).saveConnection(keyless, {
      rememberCredentials: false, credentialsToForget: [{ ...connection, apiKey: 'session-K' }], authenticationIntent: true,
    }), { code: 'legacy-cleanup' });
    const raw = idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string };
    const debt = manager as unknown as { cleanupDebt: Map<string, { intent?: string; unresolvedAuthentication: boolean }> };
    assert.equal(debt.cleanupDebt.get(id)!.intent, raw.unresolvedCleanup);
    assert.equal(debt.cleanupDebt.get(id)!.unresolvedAuthentication, false);
    await manager.storage(id).saveConnection(keyless, { rememberCredentials: false });
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, undefined);
    assert.equal((legacy.get('connection') as StoredConnection).headers!['x-other-auth'], 'independent-J');
    assert.equal((idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string }).unresolvedCleanup, undefined);
    assert.equal(manager.storedConnection(id)!.apiKey, undefined);
  });

  it('does not begin unsafe cleanup if its durable unresolved intent cannot commit', async (t) => {
    const idb = installChatIndexedDB(t);
    const namespace = 'durable-intent-abort';
    const manager = await store(t, namespace); const id = manager.activeProfileId;
    await manager.storage(id).saveConnection(connection);
    const legacy = idb.databases.get(`${namespace}:chat`)!;
    legacy.set('connection', { ...connection, apiKey: 'unresolved-K' });
    const seam = manager as unknown as { fenceLegacyAuthentication: () => Promise<void> };
    const fencing = t.mock.method(seam, 'fenceLegacyAuthentication');
    idb.fail('commit');
    await assert.rejects(manager.storage(id).saveConnection({ id: connection.id, baseUrl: connection.baseUrl }, {
      rememberCredentials: false, authenticationIntent: true, unresolvedAuthentication: true,
    }), { code: 'legacy-cleanup' });
    assert.equal(fencing.mock.callCount(), 0);
    assert.equal((idb.databases.get(`${namespace}:profiles`)!.get(`profile:${id}`) as { unresolvedCleanup?: string }).unresolvedCleanup, undefined);
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'unresolved-K');
    assert.equal(manager.persistenceWarning, true);
  });

  it('keeps explicit recovery compatible with absent directories and rejects malformed existing directories', async (t) => {
    const idb = installChatIndexedDB(t);
    for (const malformed of [false, true]) {
      const namespace = `recovery-directory-${malformed}`;
      const legacy = new Map<string, unknown>([['connection', connection]]);
      idb.databases.set(`${namespace}:chat`, legacy);
      const records = new Map<string, unknown>([['unrelated', 'keep']]);
      if (malformed) records.set('directory', { version: 99, ids: [] });
      idb.databases.set(`${namespace}:profiles`, records);
      const manager = await store(t, namespace, false); const id = manager.activeProfileId;
      await manager.storage(id).saveEntries([entry('ram-only')]);
      if (malformed) await assert.rejects(manager.clearLegacyData(), /Could not remove legacy data/u);
      else await manager.clearLegacyData();
      assert.deepEqual(manager.historyPage(id, '', 10).entries, [entry('ram-only')]);
      assert.equal(records.get('unrelated'), 'keep');
      assert.equal(manager.persistenceWarning, false);
      assert.equal(legacy.has('connection'), false);
    }
  });
});

describe('safe legacy retirement after authoritative migration', () => {
  it('removes copied legacy state so clear and credential opt-out leave no raw duplicates', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('old', 'Private old conversation')]], ['connection', connection], ['entriesEpoch', 'old-epoch'], ['unrelated', 'retain']]);
    idb.databases.set('retirement:chat', legacy);
    const manager = await store(t, 'retirement');
    assert.deepEqual(manager.activeProfile.entries, [entry('old', 'Private old conversation')]);
    assert.deepEqual(manager.activeProfile.connection, connection);
    assertLegacyRetired(legacy);
    assert.equal(legacy.get('unrelated'), 'retain');
    const adapter = manager.storage(manager.activeProfileId);
    await adapter.clearEntries();
    await adapter.saveConnection(connection, { rememberCredentials: false });
    assert.equal(JSON.stringify([...idb.databases.values()].map((records) => [...records])).includes(connection.apiKey!), false);
    assert.equal(JSON.stringify([...idb.databases.values()].map((records) => [...records])).includes('Private old conversation'), false);
  });

  for (const failure of ['write', 'put', 'commit'] as const) {
    it(`preserves every legacy record when authoritative migration has a ${failure} failure`, async (t) => {
      const idb = installChatIndexedDB(t);
      const legacy = new Map<string, unknown>([['entries', [entry('old')]], ['connection', connection], ['entriesEpoch', 'old-epoch']]);
      idb.databases.set(`retirement-${failure}:chat`, legacy);
      const before = structuredClone(legacy);
      idb.fail(failure);
      const manager = await store(t, `retirement-${failure}`);
      assert.equal(manager.persistenceWarning, true);
      assert.deepEqual(manager.activeProfile.entries, [entry('old')]);
      assert.deepEqual(legacy, before);
      idb.fail('none');
      const reopened = await store(t, `retirement-${failure}`);
      assert.deepEqual(reopened.activeProfile.entries, [entry('old')]);
      assertLegacyRetired(legacy);
    });
  }

  for (const changed of ['entries', 'connection', 'entriesEpoch'] as const) {
    it(`preserves concurrently changed legacy ${changed} after committing the copied snapshot`, async (t) => {
      const idb = installChatIndexedDB(t);
      const namespace = `retirement-concurrent-${changed}`;
      const legacy = new Map<string, unknown>([['entries', [entry('old')]], ['connection', connection], ['entriesEpoch', 'old-epoch']]);
      idb.databases.set(`${namespace}:chat`, legacy);
      const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
      let legacyOpens = 0;
      t.mock.method(globalThis.indexedDB, 'open', (name: string, version?: number) => {
        if (name === `${namespace}:chat` && ++legacyOpens === 2) {
          legacy.set(changed, changed === 'entries' ? [entry('old'), entry('concurrent')] : changed === 'connection' ? { ...connection, apiKey: 'new-secret' } : 'new-epoch');
        }
        return open(name, version);
      });
      const manager = await store(t, namespace);
      assert.deepEqual(manager.activeProfile.entries, [entry('old')]);
      assert.deepEqual(manager.activeProfile.connection, connection);
      assert.equal(legacy.size, 3);
      assert.equal(manager.persistenceWarning, false);
    });
  }

  it('preserves a partially copied oversized legacy archive in full', async (t) => {
    const idb = installChatIndexedDB(t);
    const entries = Array.from({ length: PROFILE_LIMITS.entries + 1 }, (_, i) => entry(`old-${i}`));
    const legacy = new Map<string, unknown>([['entries', entries], ['connection', connection]]);
    idb.databases.set('retirement-partial:chat', legacy);
    const manager = await store(t, 'retirement-partial');
    assert.equal(manager.profileInfo(manager.activeProfileId)!.entryCount, PROFILE_LIMITS.entries);
    assert.equal((legacy.get('entries') as ChatEntry[]).length, PROFILE_LIMITS.entries + 1);
    assert.deepEqual(legacy.get('connection'), connection);
  });
});
