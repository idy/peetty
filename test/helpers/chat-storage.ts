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

/** Minimal transactional IDB fixture: exercises production open/get/put/commit handling. */
export function installChatIndexedDB(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const databases = new Map<string, Map<string, unknown>>();
  const opened: string[] = [];
  let failWrites = false;
  const factory = {
    open(name: string) {
      opened.push(name);
      const request = { result: undefined, onupgradeneeded: undefined, onsuccess: undefined } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        const records = databases.get(name) ?? new Map<string, unknown>();
        databases.set(name, records);
        const db = {
          objectStoreNames: { contains: () => !fresh },
          createObjectStore() {},
          close() {},
          transaction(_name: string, mode: IDBTransactionMode) {
            const operations: (() => void)[] = [];
            const tx = {
              oncomplete: undefined, onabort: undefined, onerror: undefined,
              abort() { tx.onabort?.(new Event('abort')); },
              objectStore() {
                return {
                  get(key: string) {
                    const get = {} as IDBRequest;
                    operations.push(() => {
                      Object.defineProperty(get, 'result', { value: structuredClone(records.get(key)) });
                      get.onsuccess?.call(get, new Event('success'));
                    });
                    return get;
                  },
                  put(value: unknown, key: string) {
                    operations.push(() => { records.set(key, structuredClone(value)); });
                    return {} as IDBRequest;
                  },
                };
              },
            } as unknown as IDBTransaction;
            queueMicrotask(() => {
              if (mode === 'readwrite' && failWrites) { tx.onerror?.call(tx, new Event('error')); return; }
              for (const operation of operations) operation();
              tx.oncomplete?.call(tx, new Event('complete'));
            });
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
  return { opened, databases, failWrites: () => { failWrites = true; } };
}
