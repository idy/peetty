import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrowserChatStore } from '../src/chat/store.ts';
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
