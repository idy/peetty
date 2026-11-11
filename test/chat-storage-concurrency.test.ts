import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrowserChatStore, ChatStorageError } from '../src/chat/store.ts';
import type { StoredConnection } from '../src/chat/store.ts';
import { BrowserProfileStore } from '../src/chat/profiles.ts';
import type { ChatEntry } from '../src/chat/types.ts';
import { installChatIndexedDB } from './helpers/chat-storage.ts';

const entry = (id: string, text = id, createdAt = 1): ChatEntry => ({ id, role: 'user', text, createdAt });

describe('concurrent browser history storage', () => {
  it('transactionally merges appends, partial updates, and repeated stale snapshots without reordering', async (t) => {
    installChatIndexedDB(t);
    const first = new BrowserChatStore('shared');
    const second = new BrowserChatStore('shared');
    t.after(() => { first.close(); second.close(); });
    await Promise.all([first.load(), second.load()]);
    const a = [entry('a-user', 'first', 100), { ...entry('a-reply', 'partial', 101), role: 'assistant' as const }];
    // Clock skew must not sort the second client's turn ahead of an already committed turn.
    const b = [entry('b-user', 'second', 1), { ...entry('b-reply', 'peer reply', 2), role: 'assistant' as const }];
    await Promise.all([first.saveEntries(a), second.saveEntries(b)]);
    const updated = [a[0]!, { ...a[1]!, text: 'finished' }];
    await first.saveEntries(updated);
    await second.saveEntries(b);
    const reader = new BrowserChatStore('shared');
    t.after(() => reader.close());
    assert.deepEqual((await reader.load()).entries, [...updated, ...b]);
    // Omitting an entry, including an empty save, is not an implicit clear.
    await first.saveEntries([updated[1]!]);
    await second.saveEntries([]);
    assert.deepEqual((await reader.load()).entries, [...updated, ...b]);
  });

  it('does not overwrite a peer edit to an unchanged entry in a loaded snapshot', async (t) => {
    installChatIndexedDB(t);
    const first = new BrowserChatStore('edits');
    const second = new BrowserChatStore('edits');
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
    const first = new BrowserChatStore('clear');
    const stale = new BrowserChatStore('clear');
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
    const restored = new BrowserChatStore('clear');
    t.after(() => restored.close());
    assert.deepEqual((await restored.load()).entries, []);
    assert.equal(typeof idb.databases.get('clear:chat')?.get('entriesEpoch'), 'string');
    assert.deepEqual(idb.databases.get('clear:chat')?.get('entries'), []);
  });

  it('accepts the first new turn after clear, then never reintroduces old snapshot IDs', async (t) => {
    installChatIndexedDB(t);
    const first = new BrowserChatStore('new-epoch');
    const second = new BrowserChatStore('new-epoch');
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
    const first = new BrowserChatStore('overlapping-clear');
    const second = new BrowserChatStore('overlapping-clear');
    const reader = new BrowserChatStore('overlapping-clear');
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

  it('bounds merged records and does not reinsert an evicted entry on a later partial update', async (t) => {
    installChatIndexedDB(t);
    const first = new BrowserChatStore('bounded');
    const second = new BrowserChatStore('bounded');
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

describe('independent legacy credential invalidation', () => {
  const connection: StoredConnection = { id: 'fixture-model', baseUrl: 'https://fixture.example/v1', apiKey: 'erased-fixture-key' };
  for (const originalEpoch of [undefined, 'existing-credential-epoch']) {
    for (const invalidation of ['explicit', 'automatic', 'profile-opt-out'] as const) {
      it(`rejects a delayed old setup save after ${invalidation} with original epoch ${originalEpoch ?? 'absent'}`, async (t) => {
        const idb = installChatIndexedDB(t);
        const namespace = `credential-barrier-${invalidation}-${originalEpoch ?? 'none'}`;
        let manager: BrowserProfileStore;
        if (invalidation === 'profile-opt-out') {
          manager = new BrowserProfileStore(namespace); await manager.initialize();
          await manager.storage(manager.activeProfileId).saveConnection(connection);
        } else manager = new BrowserProfileStore(namespace, invalidation !== 'explicit');
        t.after(() => manager.close());
        const legacy = new Map<string, unknown>([['entries', [entry('active-user')]], ['connection', connection]]);
        if (originalEpoch) { legacy.set('entriesEpoch', originalEpoch); legacy.set('connectionEpoch', originalEpoch); }
        idb.databases.set(`${namespace}:chat`, legacy);
        const old = new BrowserChatStore(namespace); t.after(() => old.close());
        const loaded = await old.load();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        t.after(() => release());
        (old as unknown as { writes: Promise<void> }).writes = gate;
        const saving = old.saveConnection(loaded.connection!);
        if (invalidation === 'explicit') { await manager.initialize(); await manager.clearLegacyData(); }
        else if (invalidation === 'automatic') await manager.initialize();
        else await manager.storage(manager.activeProfileId).saveConnection(connection, { rememberCredentials: false });
        const barrier = legacy.get('connectionEpoch');
        assert.equal(typeof barrier, 'string'); assert.notEqual(barrier, originalEpoch);
        release();
        await assert.rejects(saving, (error: unknown) => error instanceof ChatStorageError && error.code === 'stale-connection');
        assert.equal(legacy.has('connection'), false);
        assert.equal(old.persistenceWarning, false);
        await assert.rejects(old.saveConnection(connection), /Reload before saving/u);
        assert.equal(legacy.has('connection'), false, 'a rejection cannot silently adopt the new epoch');
        if (invalidation === 'profile-opt-out') {
          assert.equal(legacy.get('entriesEpoch'), originalEpoch, 'credential invalidation must not cancel active history');
          await old.saveEntries([...loaded.entries, { ...entry('finished-reply'), role: 'assistant' }]);
          assert.equal((legacy.get('entries') as ChatEntry[]).at(-1)!.id, 'finished-reply');
        }
        // A deliberate reload refreshes the barrier; a later explicit setup save
        // is new intent rather than completion of the erased pending operation.
        await old.load();
        const replacement = { ...connection, apiKey: 'fresh-authorized-key' };
        await old.saveConnection(replacement);
        assert.deepEqual(legacy.get('connection'), replacement);
        assert.equal(legacy.get('connectionEpoch'), barrier);
      });
    }
  }

  for (const source of ['history-only', 'connection-only'] as const) {
    for (const invalidation of ['explicit', 'automatic'] as const) {
      it(`blocks pending setup after ${invalidation} retirement of ${source} with absent original barriers`, async (t) => {
        const idb = installChatIndexedDB(t);
        const namespace = `single-record-${source}-${invalidation}`;
        const legacy = new Map<string, unknown>(source === 'history-only' ? [['entries', [entry('old')]]] : [['connection', connection]]);
        idb.databases.set(`${namespace}:chat`, legacy);
        const pending = new BrowserChatStore(namespace); t.after(() => pending.close());
        await pending.load();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        t.after(() => release());
        (pending as unknown as { writes: Promise<void> }).writes = gate;
        const saving = pending.saveConnection(connection);
        const manager = new BrowserProfileStore(namespace, invalidation !== 'explicit'); t.after(() => manager.close());
        await manager.initialize();
        if (invalidation === 'explicit') await manager.clearLegacyData();
        assert.equal(typeof legacy.get('connectionEpoch'), 'string');
        if (source === 'connection-only' && invalidation === 'automatic') assert.equal(legacy.get('entriesEpoch'), undefined);
        release();
        await assert.rejects(saving, /Reload before saving/u);
        assert.equal(legacy.has('connection'), false);
        assert.equal(legacy.has('entries'), false);
      });
    }
  }

  it('allows a deliberate first setup save without load on a fresh database without an invalidation marker', async (t) => {
    const idb = installChatIndexedDB(t);
    const writer = new BrowserChatStore('fresh-setup'); t.after(() => writer.close());
    await writer.saveConnection(connection);
    assert.deepEqual(idb.databases.get('fresh-setup:chat')!.get('connection'), connection);
    assert.equal(writer.persistenceWarning, false);
  });

  it('requires uninitialized writers to load an existing credential barrier before saving', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['connectionEpoch', 'invalidated']]);
    idb.databases.set('uninitialized-credentials:chat', legacy);
    const writer = new BrowserChatStore('uninitialized-credentials'); t.after(() => writer.close());
    await assert.rejects(writer.saveConnection(connection), /Reload before saving/u);
    assert.equal(legacy.has('connection'), false);
    await writer.load();
    await writer.saveConnection(connection);
    assert.deepEqual(legacy.get('connection'), connection);
  });

  it('allows ordinary same-epoch rotations and makes direct opt-out invalidate peers independently of history', async (t) => {
    const idb = installChatIndexedDB(t);
    const legacy = new Map<string, unknown>([['entries', [entry('active')]], ['entriesEpoch', 'history'], ['connectionEpoch', 'credentials']]);
    idb.databases.set('credential-rotations:chat', legacy);
    const first = new BrowserChatStore('credential-rotations'); const peer = new BrowserChatStore('credential-rotations');
    t.after(() => { first.close(); peer.close(); });
    await Promise.all([first.load(), peer.load()]);
    await first.saveConnection(connection);
    const rotated = { ...connection, apiKey: 'rotated-fixture-key' };
    await peer.saveConnection(rotated);
    assert.deepEqual(legacy.get('connection'), rotated);
    assert.equal(legacy.get('connectionEpoch'), 'credentials');
    await first.saveConnection(rotated, { rememberCredentials: false });
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, undefined);
    assert.notEqual(legacy.get('connectionEpoch'), 'credentials');
    await assert.rejects(peer.saveConnection(rotated), /Reload before saving/u);
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, undefined);
    assert.equal(legacy.get('entriesEpoch'), 'history');
    await first.saveConnection({ ...connection, apiKey: 'new-same-writer-key' });
    assert.equal((legacy.get('connection') as StoredConnection).apiKey, 'new-same-writer-key');
  });

  it('keeps nonpersistent and failed-IDB setup saves in memory', async (t) => {
    const idb = installChatIndexedDB(t);
    const memory = new BrowserChatStore('memory-credentials', false); t.after(() => memory.close());
    await memory.saveConnection(connection);
    assert.deepEqual((await memory.load()).connection, connection);
    assert.equal(memory.persistenceWarning, false);
    assert.equal(idb.databases.has('memory-credentials:chat'), false);
    const persisted = new BrowserChatStore('fallback-credentials'); t.after(() => persisted.close());
    await persisted.load();
    idb.fail('write');
    await persisted.saveConnection(connection);
    assert.deepEqual((await persisted.load()).connection, connection);
    assert.equal(persisted.persistenceWarning, true);
    assert.equal(idb.databases.get('fallback-credentials:chat')!.has('connection'), false);
  });
});
