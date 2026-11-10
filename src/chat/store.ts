import { COMPANION_ACTIONS, type ChatEntry, type PeettyReasoningEffort } from './types.ts';
import { normalizeModelOptions, prepareSavedConnection } from './connections.ts';
import { applyEntryChanges, entryChanges } from './history.ts';
import { openStateDatabase, stateTransaction } from './idb.ts';

/** Setup saves only opted-in keys. Explicit complete backups may also restore provider headers. */
export interface StoredConnection {
  id: string;
  baseUrl: string;
  provider?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  tools?: boolean;
  effort?: PeettyReasoningEffort;
}

export interface StoredSessionConnection {
  connection: StoredConnection;
  rememberKey: boolean;
}

export interface StoredChat {
  connection?: StoredConnection;
  /** Restored ephemeral connections remain in this visit's memory; the last one is active. */
  sessionConnections?: StoredSessionConnection[];
  entries: ChatEntry[];
}

/** Domain failures must not be mistaken for unavailable browser persistence. */
export class ChatStorageError extends Error {
  readonly code: 'missing-profile' | 'capacity';
  constructor(code: 'missing-profile' | 'capacity', message: string) { super(message); this.code = code; this.name = 'ChatStorageError'; }
}

export interface HistoryProjection {
  /** Register complete saved credentials before any history text is clipped. */
  registerConnections?: (stored: Omit<StoredChat, 'entries'>) => void;
  sanitizeText?: (text: string) => string;
}

/** Small storage seam for hosts and network-free tests. */
export interface ChatStorage {
  readonly persistenceWarning: boolean;
  load(projection?: HistoryProjection): Promise<StoredChat>;
  saveConnection(connection: StoredConnection, options?: { rememberCredentials: boolean }): Promise<StoredConnection | void>;
  /** Merge client changes, then sanitize full current text independently of the mutation mask. */
  saveEntries(entries: readonly ChatEntry[], changedIds?: readonly string[], sanitizeText?: (text: string) => string): Promise<void>;
  /** Reject a turn before it is appended or sent if the complete archive cannot retain it. */
  ensureCapacity?(additionalEntries: number): Promise<void>;
  /** Clear history and invalidate writes from clients that have not loaded the new history. */
  clearEntries(): Promise<void>;
  close(): void;
}

const MAX_ENTRIES = 200;
const MAX_HISTORY_CHARS = 240_000;
const MAX_ENTRY_CHARS = 16_000;
const ACTIONS = new Set<string>(COMPANION_ACTIONS);

/** Validate restored data and put a ceiling on local history, independent of model context. */
export function boundedEntries(value: unknown, sanitizeText: (text: string) => string = (text) => text): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ChatEntry[] = [];
  let remaining = MAX_HISTORY_CHARS;
  for (let i = value.length - 1; i >= 0 && entries.length < MAX_ENTRIES && remaining > 0; i--) {
    const entry = value[i] as Partial<ChatEntry> | null;
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
      typeof entry.text !== 'string' || !Number.isFinite(entry.createdAt) ||
      (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'action')) continue;
    if (entry.role === 'action' && !ACTIONS.has(entry.text)) continue;
    const text = sanitizeText(entry.text).slice(0, Math.min(MAX_ENTRY_CHARS, remaining));
    if (!text.trim()) continue;
    entries.push({ id: entry.id.slice(0, 200), role: entry.role, text, createdAt: entry.createdAt! });
    remaining -= text.length;
  }
  return entries.reverse();
}

function connectionFrom(value: unknown): StoredConnection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const connection = value as StoredConnection;
  try {
    return normalizeModelOptions({
      id: connection.id, baseUrl: connection.baseUrl,
      ...(connection.provider !== undefined ? { provider: connection.provider } : {}),
      ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
      ...(connection.headers !== undefined ? { headers: connection.headers } : {}),
      ...(connection.tools !== undefined ? { tools: connection.tools } : {}),
      ...(connection.effort !== undefined ? { effort: connection.effort } : {}),
    });
  } catch { return; }
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
    this.opening = openStateDatabase(`${this.namespace}:chat`, {
      isClosed: () => this.closed,
      onFailure: () => this.fail(),
      onReady: (db) => { this.db = db; },
    });
    return this.opening;
  }

  private async transact(write: boolean, action: (store: IDBObjectStore) => void): Promise<boolean> {
    const db = await this.open();
    if (!db || this.closed) return false;
    const ok = await stateTransaction(db, write, action);
    if (!ok && !this.closed) this.fail();
    return ok;
  }

  load(projection?: HistoryProjection): Promise<StoredChat> {
    if (this.closing) return Promise.resolve(structuredClone(this.state));
    return this.enqueue(async () => {
      const restored: StoredChat = { entries: [] };
      let rawEntries: unknown;
      let epoch = '';
      const ok = await this.transact(false, (store) => {
        const connection = store.get('connection');
        connection.onsuccess = () => {
          const value = connectionFrom(connection.result);
          if (value) restored.connection = value;
        };
        const entries = store.get('entries');
        entries.onsuccess = () => { rawEntries = entries.result; };
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => { if (typeof barrier.result === 'string') epoch = barrier.result; };
      });
      projection?.registerConnections?.(ok ? restored : this.state);
      if (ok) {
        restored.entries = boundedEntries(rawEntries, projection?.sanitizeText);
        this.state = restored; this.epoch = epoch;
      } else this.state.entries = boundedEntries(this.state.entries, projection?.sanitizeText);
      this.snapshot = structuredClone(this.state.entries);
      return structuredClone(this.state);
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(action);
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }

  saveConnection(connection: StoredConnection, options?: { rememberCredentials: boolean }): Promise<StoredConnection | void> {
    const copy = connectionFrom(connection);
    if (!copy || this.closing) return Promise.resolve();
    return this.enqueue(async () => {
      const retained = (known?: StoredConnection) => prepareSavedConnection(copy, known, options?.rememberCredentials);
      let saved = retained(this.state.connection);
      await this.transact(true, (store) => {
        const request = store.get('connection');
        request.onsuccess = () => {
          saved = retained(connectionFrom(request.result));
          store.put(saved, 'connection');
        };
      });
      this.state.connection = saved;
      return structuredClone(saved);
    });
  }

  saveEntries(entries: readonly ChatEntry[], changedIds?: readonly string[], sanitizeText?: (text: string) => string): Promise<void> {
    if (this.closing) return Promise.resolve();
    const copy = boundedEntries(entries, sanitizeText);
    const selected = changedIds === undefined ? undefined : [...changedIds];
    return this.enqueue(async () => {
      const changes = entryChanges(this.snapshot, copy, selected);
      this.snapshot = copy;
      let merged = boundedEntries(applyEntryChanges(this.state.entries, changes), sanitizeText);
      let epoch = this.epoch;
      const ok = await this.transact(true, (store) => {
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => {
          const currentEpoch = typeof barrier.result === 'string' ? barrier.result : '';
          const entries = store.get('entries');
          entries.onsuccess = () => {
            const current = boundedEntries(entries.result, sanitizeText);
            if (epoch === undefined || epoch === currentEpoch) {
              epoch = currentEpoch;
              merged = boundedEntries(applyEntryChanges(current, changes));
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
