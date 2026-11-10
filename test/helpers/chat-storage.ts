import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { ChatEntry } from '../../src/chat/types.ts';
import type { ChatStorage, StoredChat, StoredConnection } from '../../src/chat/store.ts';

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
  async clearEntries(): Promise<void> {
    this.state.entries = [];
    this.histories.push([]);
  }
  close(): void { this.closed = true; }
}

/** Serializes transactions across connections, stages writes, and discards aborted writes. */
export function installChatIndexedDB(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const databases = new Map<string, Map<string, unknown>>();
  const tails = new Map<string, Promise<void>>();
  const opened: string[] = [];
  const writes: { database: string; keys: string[] }[] = [];
  let failure: 'none' | 'open' | 'write' | 'put' | 'commit' = 'none';
  const factory = {
    open(name: string) {
      if (failure === 'open') throw new Error('fixture open failure');
      opened.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        const records = databases.get(name) ?? new Map<string, unknown>();
        databases.set(name, records);
        const db = {
          objectStoreNames: { contains: () => !fresh },
          createObjectStore() {}, close() {},
          transaction(_store: string, mode: IDBTransactionMode) {
            const operations: (() => void)[] = [];
            const dirty: string[] = [];
            let staged: Map<string, unknown>;
            let aborted = false;
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
            const previous = tails.get(name) ?? Promise.resolve();
            const current = previous.then(() => {
              staged = structuredClone(records);
              if (mode === 'readwrite' && failure === 'write') {
                tx.onerror?.call(tx, new Event('error'));
                return;
              }
              for (const operation of operations) { if (aborted) return; operation(); }
              if (aborted) return;
              if (mode === 'readwrite' && failure === 'commit') {
                tx.onabort?.call(tx, new Event('abort'));
                return;
              }
              if (mode === 'readwrite') {
                records.clear();
                for (const [key, value] of staged) records.set(key, value);
                writes.push({ database: name, keys: dirty });
              }
              tx.oncomplete?.call(tx, new Event('complete'));
            });
            tails.set(name, current);
            return tx;
          },
        } as unknown as IDBDatabase;
        Object.defineProperty(request, 'result', { value: db });
        if (fresh) request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent);
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  return {
    opened, databases, writes,
    fail: (value: typeof failure) => { failure = value; },
    failWrites: () => { failure = 'write'; },
  };
}
