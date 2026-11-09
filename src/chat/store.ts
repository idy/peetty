import type { ChatEntry, PeettyReasoningEffort } from './types.ts';
import { isReasoningEffort } from './connections.ts';

/** Only an explicitly remembered setup key may be written here. Never store SDK headers. */
export interface StoredConnection {
  id: string;
  baseUrl: string;
  apiKey?: string;
  tools?: boolean;
  effort?: PeettyReasoningEffort;
}

export interface StoredChat {
  connection?: StoredConnection;
  entries: ChatEntry[];
}

/** Small storage seam for hosts and network-free tests. */
export interface ChatStorage {
  readonly persistenceWarning: boolean;
  load(): Promise<StoredChat>;
  saveConnection(connection: StoredConnection): Promise<void>;
  /** Merge changes since this client's last load/save; omission does not delete entries. */
  saveEntries(entries: readonly ChatEntry[]): Promise<void>;
  /** Clear history and invalidate writes from clients that have not loaded the new history. */
  clearEntries(): Promise<void>;
  close(): void;
}

const MAX_ENTRIES = 200;
const MAX_HISTORY_CHARS = 240_000;
const MAX_ENTRY_CHARS = 16_000;
const ACTIONS = new Set(['wave', 'sit', 'lie', 'sleep', 'move', 'idle']);

/** Validate restored data and put a ceiling on local history, independent of model context. */
export function boundedEntries(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ChatEntry[] = [];
  let remaining = MAX_HISTORY_CHARS;
  for (let i = value.length - 1; i >= 0 && entries.length < MAX_ENTRIES && remaining > 0; i--) {
    const entry = value[i] as Partial<ChatEntry> | null;
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
      typeof entry.text !== 'string' || !Number.isFinite(entry.createdAt) ||
      (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'action')) continue;
    if (entry.role === 'action' && !ACTIONS.has(entry.text)) continue;
    const text = entry.text.slice(0, Math.min(MAX_ENTRY_CHARS, remaining));
    if (!text.trim()) continue;
    entries.push({ id: entry.id.slice(0, 200), role: entry.role, text, createdAt: entry.createdAt! });
    remaining -= text.length;
  }
  return entries.reverse();
}

function connectionFrom(value: unknown): StoredConnection | undefined {
  if (!value || typeof value !== 'object') return;
  const connection = value as Partial<StoredConnection>;
  if (typeof connection.id !== 'string' || !connection.id.trim() || typeof connection.baseUrl !== 'string') return;
  if (connection.tools !== undefined && typeof connection.tools !== 'boolean') return;
  if (connection.effort !== undefined && !isReasoningEffort(connection.effort)) return;
  return {
    id: connection.id.slice(0, 200), baseUrl: connection.baseUrl,
    ...(typeof connection.apiKey === 'string' && connection.apiKey ? { apiKey: connection.apiKey } : {}),
    ...(connection.tools !== undefined ? { tools: connection.tools } : {}),
    ...(connection.effort !== undefined ? { effort: connection.effort } : {}),
  };
}

interface EntryChange { entry: ChatEntry; added: boolean }

function entryChanges(previous: readonly ChatEntry[], next: readonly ChatEntry[]): EntryChange[] {
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  return next.flatMap((entry) => {
    const old = known.get(entry.id);
    return old && old.role === entry.role && old.text === entry.text && old.createdAt === entry.createdAt
      ? [] : [{ entry, added: !old }];
  });
}

function mergeEntries(current: readonly ChatEntry[], changes: readonly EntryChange[]): ChatEntry[] {
  const pending = new Map(changes.map((change) => [change.entry.id, change]));
  const merged = current.map((entry) => {
    const change = pending.get(entry.id);
    pending.delete(entry.id);
    return change?.entry ?? entry;
  });
  // Keep committed order, update entries in place, and append new entries in their local order.
  // An edit to an entry already evicted by the bounds must not reinsert it at the end.
  for (const { entry, added } of pending.values()) if (added) merged.push(entry);
  return boundedEntries(merged);
}

/** IndexedDB failures switch this instance to memory; no localStorage key fallback. */
export class BrowserChatStore implements ChatStorage {
  private state: StoredChat = { entries: [] };
  private snapshot: ChatEntry[] = [];
  private epoch: string | undefined;
  private db: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase | undefined> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private failed = false;
  private closing = false;
  private closed = false;

  constructor(privateNamespace = 'peetty', persist = true) {
    this.namespace = privateNamespace;
    this.persist = persist;
  }

  private readonly namespace: string;
  private readonly persist: boolean;

  get persistenceWarning(): boolean { return this.failed; }

  private fail(): void {
    this.failed = true;
    this.db?.close();
    this.db = undefined;
  }

  private open(): Promise<IDBDatabase | undefined> {
    if (!this.persist || this.failed || this.closed) return Promise.resolve(undefined);
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve) => {
      let settled = false;
      const finish = (db?: IDBDatabase) => {
        if (settled) { db?.close(); return; }
        settled = true;
        clearTimeout(timer);
        if (this.closed) { db?.close(); resolve(undefined); return; }
        if (!db) this.fail();
        else this.db = db;
        resolve(db);
      };
      const timer = setTimeout(() => finish(), 2_000);
      try {
        const request = globalThis.indexedDB.open(`${this.namespace}:chat`, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.fail(); };
          finish(db);
        };
        request.onerror = () => finish();
        request.onblocked = () => finish();
      } catch { finish(); }
    });
    return this.opening;
  }

  private async transact(write: boolean, action: (store: IDBObjectStore) => void): Promise<boolean> {
    const db = await this.open();
    if (!db || this.closed) return false;
    return new Promise((resolve) => {
      let settled = false;
      let transaction: IDBTransaction | undefined;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok && !this.closed) this.fail();
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { transaction?.abort(); } catch { /* Already finished. */ }
        finish(false);
      }, 2_000);
      try {
        transaction = db.transaction('state', write ? 'readwrite' : 'readonly');
        transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
        action(transaction.objectStore('state'));
      } catch { finish(false); }
    });
  }

  load(): Promise<StoredChat> {
    if (this.closing) return Promise.resolve(structuredClone(this.state));
    return this.enqueue(async () => {
      const restored: StoredChat = { entries: [] };
      let epoch = '';
      const ok = await this.transact(false, (store) => {
        const connection = store.get('connection');
        connection.onsuccess = () => {
          const value = connectionFrom(connection.result);
          if (value) restored.connection = value;
        };
        const entries = store.get('entries');
        entries.onsuccess = () => { restored.entries = boundedEntries(entries.result); };
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => { if (typeof barrier.result === 'string') epoch = barrier.result; };
      });
      if (ok) { this.state = restored; this.epoch = epoch; }
      this.snapshot = structuredClone(this.state.entries);
      return structuredClone(this.state);
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(action);
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  saveConnection(connection: StoredConnection): Promise<void> {
    const copy = connectionFrom(connection);
    if (!copy || this.closing) return Promise.resolve();
    return this.enqueue(async () => {
      this.state.connection = copy;
      await this.transact(true, (store) => { store.put(copy, 'connection'); });
    });
  }

  saveEntries(entries: readonly ChatEntry[]): Promise<void> {
    if (this.closing) return Promise.resolve();
    const copy = boundedEntries(entries);
    return this.enqueue(async () => {
      const changes = entryChanges(this.snapshot, copy);
      this.snapshot = copy;
      let merged = mergeEntries(this.state.entries, changes);
      let epoch = this.epoch;
      const ok = await this.transact(true, (store) => {
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => {
          const currentEpoch = typeof barrier.result === 'string' ? barrier.result : '';
          const entries = store.get('entries');
          entries.onsuccess = () => {
            const current = boundedEntries(entries.result);
            if (epoch === undefined || epoch === currentEpoch) {
              epoch = currentEpoch;
              merged = mergeEntries(current, changes);
              store.put(merged, 'entries');
            } else {
              // Keep the old epoch until load(): late replies and repeated stale saves
              // cannot adopt the clear barrier and write their old snapshot back.
              merged = current;
            }
          };
        };
      });
      if (ok) this.epoch = epoch;
      this.state.entries = merged;
    });
  }

  clearEntries(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.enqueue(async () => {
      // A separate record keeps the barrier even when the bounded history is empty.
      const epoch = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-');
      this.epoch = epoch;
      this.snapshot = [];
      this.state.entries = [];
      await this.transact(true, (store) => {
        store.put([], 'entries');
        store.put(epoch, 'entriesEpoch');
      });
    });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    // stop()/destroy() may just have queued a final partial-history save.
    void this.writes.then(() => {
      this.closed = true;
      this.db?.close();
      this.db = undefined;
    });
  }
}
