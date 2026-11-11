import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { ChatEntry } from '../../src/chat/types.ts';
import { boundedEntries, type ChatStorage, type StoredChat, type StoredConnection } from '../../src/chat/store.ts';
import { BrowserProfileStore } from '../../src/chat/profiles.ts';
import { applyEntryChanges, entryChanges } from '../../src/chat/history.ts';
import { openStateDatabase, stateTransaction } from '../../src/chat/idb.ts';

export class MemoryChatStorage implements ChatStorage {
  persistenceWarning = false;
  state: StoredChat;
  connections: StoredConnection[] = [];
  histories: ChatEntry[][] = [];
  closed = false;

  constructor(state: StoredChat = { entries: [] }) { this.state = structuredClone(state); }
  async load(): Promise<StoredChat> { return structuredClone(this.state); }
  async saveConnection(connection: StoredConnection): Promise<void> {
    this.state.connection = structuredClone(connection);
    this.connections.push(structuredClone(connection));
  }
  async saveEntries(entries: readonly ChatEntry[]): Promise<void> {
    this.state.entries = structuredClone([...entries]);
    this.histories.push(structuredClone([...entries]));
  }
  async clearEntries(): Promise<void> { this.state.entries = []; this.histories.push([]); }
  close(): void { this.closed = true; }
}

/** Production runtime tests use the actual single profile persistence engine. */
export async function profileStorage(t: TestContext, namespace = 'test-profile', persist = true): Promise<ChatStorage> {
  const manager = new BrowserProfileStore(namespace, persist);
  t.after(() => manager.close());
  await manager.initialize();
  return manager.runtimeStorage(manager.activeProfileId);
}

/** Historical v1 fixture only: raw credentials are put unconditionally; version
 * changes close the connection. It intentionally has none of the removed modern
 * legacy credential state machine, recovery, opt-out or epoch authorization. */
export class LegacyV1ChatFixture {
  private readonly opening: Promise<IDBDatabase | undefined>;
  private queue: Promise<void> = Promise.resolve();
  private state: StoredChat = { entries: [] };
  private snapshot: ChatEntry[] = [];
  private epoch: string | undefined;
  private failed = false;
  private closed = false;
  get persistenceWarning(): boolean { return this.failed; }
  constructor(namespace: string) {
    this.opening = openStateDatabase(`${namespace}:chat`, { isClosed: () => this.closed, onFailure: () => { this.failed = true; } });
  }
  private enqueue<T>(action: (db: IDBDatabase | undefined) => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => action(this.failed ? undefined : await this.opening));
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  load(): Promise<StoredChat> {
    return this.enqueue(async (db) => {
      if (!db) return structuredClone(this.state);
      let epoch = ''; const state: StoredChat = { entries: [] };
      const ok = await stateTransaction(db, false, (store) => {
        const entries = store.get('entries'); entries.onsuccess = () => { state.entries = boundedEntries(entries.result); };
        const connection = store.get('connection'); connection.onsuccess = () => { if (connection.result) state.connection = structuredClone(connection.result) as StoredConnection; };
        const barrier = store.get('entriesEpoch'); barrier.onsuccess = () => { if (typeof barrier.result === 'string') epoch = barrier.result; };
      });
      if (ok) { this.state = state; this.epoch = epoch; this.snapshot = structuredClone(state.entries); }
      else this.failed = true;
      return structuredClone(this.state);
    });
  }
  saveConnection(connection: StoredConnection): Promise<void> {
    return this.enqueue(async (db) => {
      this.state.connection = structuredClone(connection);
      if (db && !await stateTransaction(db, true, (store) => { store.put(connection, 'connection'); })) this.failed = true;
    });
  }
  saveEntries(entries: readonly ChatEntry[], changedIds?: readonly string[], sanitizeText?: (text: string) => string): Promise<void> {
    const copy = boundedEntries(entries, sanitizeText);
    return this.enqueue(async (db) => {
      const changes = entryChanges(this.snapshot, copy, changedIds);
      if (!db) { this.state.entries = copy; return; }
      const ok = await stateTransaction(db, true, (store) => {
        const barrier = store.get('entriesEpoch'); barrier.onsuccess = () => {
          const epoch = typeof barrier.result === 'string' ? barrier.result : '';
          const current = store.get('entries'); current.onsuccess = () => {
            if (this.epoch !== undefined && this.epoch !== epoch) return;
            this.epoch = epoch;
            this.state.entries = boundedEntries(applyEntryChanges(boundedEntries(current.result), changes), sanitizeText);
            store.put(this.state.entries, 'entries');
          };
        };
      });
      if (!ok) this.failed = true;
      this.snapshot = copy;
    });
  }
  close(): void { void this.queue.then(async () => { this.closed = true; (await this.opening)?.close(); }); }
}

/** Version-aware IDB seam: transactions serialize, closed connections reject new
 * work, upgrades wait for old transactions/connections, and upgrade aborts roll back. */
export function installChatIndexedDB(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const databases = new Map<string, Map<string, unknown>>();
  const versions = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const connections = new Map<string, Set<IDBDatabase>>();
  const pendingUpgrades = new Map<string, Set<() => void>>();
  const opened: string[] = [];
  const writes: { database: string; keys: string[] }[] = [];
  let failure: 'none' | 'open' | 'write' | 'put' | 'commit' = 'none';
  const event = (name: string, oldVersion: number, newVersion: number) => {
    const result = new Event(name);
    Object.defineProperties(result, { oldVersion: { value: oldVersion }, newVersion: { value: newVersion } });
    return result as IDBVersionChangeEvent;
  };
  const factory = {
    open(name: string, requested?: number) {
      if (failure === 'open') throw new Error('fixture open failure');
      opened.push(name);
      const request = {} as IDBOpenDBRequest;
      let finished = false; let blocked = false; let running = false;
      const notified = new Set<IDBDatabase>();
      const waiters = pendingUpgrades.get(name) ?? new Set<() => void>();
      pendingUpgrades.set(name, waiters);
      const error = (kind: string) => {
        finished = true; waiters.delete(attempt);
        Object.defineProperty(request, 'error', { configurable: true, value: new DOMException(kind, kind) });
        request.onerror?.call(request, new Event('error'));
      };
      const connect = (version: number, fresh: boolean): IDBDatabase => {
        const records = databases.get(name) ?? new Map<string, unknown>();
        databases.set(name, records);
        const clients = connections.get(name) ?? new Set<IDBDatabase>();
        connections.set(name, clients);
        let closed = false;
        const db = {
          version, objectStoreNames: { contains: () => !fresh }, createObjectStore() {},
          close() {
            if (closed) return;
            closed = true; clients.delete(db);
            for (const retry of waiters) queueMicrotask(retry);
          },
          transaction(_store: string, mode: IDBTransactionMode) {
            if (closed) throw new DOMException('Connection closed', 'InvalidStateError');
            const operations: (() => void)[] = []; const dirty: string[] = [];
            let staged: Map<string, unknown>; let aborted = false;
            const tx = {
              oncomplete: undefined, onerror: undefined, onabort: undefined,
              abort() { aborted = true; tx.onabort?.call(tx, new Event('abort')); },
              objectStore() {
                return {
                  get(key: string) {
                    const request = {} as IDBRequest;
                    operations.push(() => {
                      Object.defineProperty(request, 'result', { value: structuredClone(staged.get(key)) });
                      request.onsuccess?.call(request, new Event('success'));
                    });
                    return request;
                  },
                  put(value: unknown, key: string) {
                    if (failure === 'put') throw new Error('fixture write failure');
                    assert.equal(mode, 'readwrite');
                    const copy = structuredClone(value);
                    operations.push(() => { staged.set(key, copy); dirty.push(key); });
                    return {} as IDBRequest;
                  },
                  delete(key: string) {
                    assert.equal(mode, 'readwrite');
                    operations.push(() => { staged.delete(key); dirty.push(key); });
                    return {} as IDBRequest;
                  },
                };
              },
            } as unknown as IDBTransaction;
            const current = (tails.get(name) ?? Promise.resolve()).then(() => {
              try {
                staged = structuredClone(records);
                if (mode === 'readwrite' && failure === 'write') { tx.onerror?.call(tx, new Event('error')); return; }
                for (const operation of operations) { if (aborted) return; operation(); }
                if (aborted) return;
                if (mode === 'readwrite' && failure === 'commit') { tx.onabort?.call(tx, new Event('abort')); return; }
                if (mode === 'readwrite') {
                  records.clear(); for (const [key, value] of staged) records.set(key, value);
                  writes.push({ database: name, keys: dirty });
                }
                tx.oncomplete?.call(tx, new Event('complete'));
              } catch { tx.onerror?.call(tx, new Event('error')); }
            });
            tails.set(name, current);
            return tx;
          },
        } as unknown as IDBDatabase;
        clients.add(db);
        return db;
      };
      async function attempt() {
        if (finished || running) return;
        running = true;
        try {
          const oldVersion = versions.get(name) ?? (databases.has(name) ? 1 : 0);
          const version = requested ?? (oldVersion || 1);
          if (version < oldVersion) { error('VersionError'); return; }
          if (version > oldVersion) {
            // Drain already-enqueued writes, then ask all open clients to close.
            await (tails.get(name) ?? Promise.resolve());
            for (const client of [...connections.get(name) ?? []]) {
              if (!notified.has(client)) { notified.add(client); client.onversionchange?.call(client, event('versionchange', oldVersion, version)); }
            }
            if (connections.get(name)?.size) {
              waiters.add(attempt);
              if (!blocked) { blocked = true; request.onblocked?.call(request, event('blocked', oldVersion, version)); }
              return;
            }
            await (tails.get(name) ?? Promise.resolve());
          }
          const latest = versions.get(name) ?? (databases.has(name) ? 1 : 0);
          if (version < latest) { error('VersionError'); return; }
          const database = connect(version, latest === 0);
          Object.defineProperty(request, 'result', { configurable: true, value: database });
          if (version > latest) {
            let aborted = false;
            Object.defineProperty(request, 'transaction', { configurable: true, value: { abort() { aborted = true; } } });
            request.onupgradeneeded?.call(request, event('upgradeneeded', latest, version));
            if (aborted) { database.close(); error('AbortError'); return; }
            versions.set(name, version);
          } else versions.set(name, latest || version);
          finished = true; waiters.delete(attempt);
          request.onsuccess?.call(request, new Event('success'));
        } finally { running = false; }
      }
      queueMicrotask(() => { void attempt(); });
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  return {
    opened, databases, versions, writes,
    fail: (value: typeof failure) => { failure = value; },
    failWrites: () => { failure = 'write'; },
  };
}
