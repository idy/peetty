import { COMPANION_ACTIONS, type ChatEntry, type PeettyReasoningEffort } from './types.ts';
import { hasStoredCredentials, isCredentialHeader, normalizeModelOptions, prepareSavedConnection } from './connections.ts';
import { applyEntryChanges, entryChanges } from './history.ts';
import { fenceLegacyDatabase, openStateDatabase, stateTransaction } from './idb.ts';

/** Setup saves only opted-in keys. Explicit complete backups may also restore provider headers. */
export interface StoredConnection {
  id: string;
  baseUrl: string;
  provider?: string;
  headers?: Record<string, string>;
  nonCredentialHeaders?: string[];
  apiKey?: string;
  tools?: boolean;
  effort?: PeettyReasoningEffort;
}

/** Request-scoped cleanup context. These source values are never stored in a
 * connection record, backup, or durable provenance checkpoint. */
export interface ConnectionSaveOptions {
  rememberCredentials: boolean;
  credentialsToForget?: readonly StoredConnection[];
  authenticationIntent?: boolean;
}

/** Remove only the intended secret values, independent of model/routing changes.
 * Unrelated newer credentials and provider metadata retain their current values. */
export function forgetConnectionCredentials(current: StoredConnection, sources: readonly StoredConnection[]): StoredConnection {
  const values = new Set<string>();
  const token = (value: string) => value.trim().replace(/^(?:Bearer|Basic|Token)\s+/i, '');
  for (const source of sources) {
    if (source.apiKey?.trim()) values.add(source.apiKey.trim());
    for (const [name, value] of Object.entries(source.headers ?? {})) if (isCredentialHeader(name, source.nonCredentialHeaders) && value.trim()) {
      values.add(value.trim()); values.add(token(value));
    }
  }
  const matches = (value: string) => !!value.trim() && (values.has(value.trim()) || values.has(token(value)));
  const result = { ...current }; let changed = false;
  if (result.apiKey && matches(result.apiKey)) { delete result.apiKey; changed = true; }
  if (current.headers) {
    const headers = Object.fromEntries(Object.entries(current.headers).filter(([name, value]) => {
      const remove = isCredentialHeader(name, current.nonCredentialHeaders) && matches(value);
      changed ||= remove; return !remove;
    }));
    if (Object.keys(headers).length) result.headers = headers;
    else delete result.headers;
  }
  return changed ? result : current;
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
  readonly code: 'missing-profile' | 'capacity' | 'stale-connection' | 'legacy-cleanup';
  constructor(code: 'missing-profile' | 'capacity' | 'stale-connection' | 'legacy-cleanup', message: string) { super(message); this.code = code; this.name = 'ChatStorageError'; }
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
  saveConnection(connection: StoredConnection, options?: ConnectionSaveOptions): Promise<StoredConnection | void>;
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
      ...(connection.nonCredentialHeaders !== undefined ? { nonCredentialHeaders: connection.nonCredentialHeaders } : {}),
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
  /** Independent from history: forgetting a key must not cancel an active reply. */
  private connectionEpoch: string | undefined;
  private connectionWriteGeneration = 0;
  private authoredConnectionEpoch: string | undefined;
  private observedCredentials = false;
  private cleanupDebt: readonly StoredConnection[] | undefined;
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
      onVersionChange: () => { this.db = undefined; this.opening = undefined; },
    }, 'latest');
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
      let connectionEpoch = '';
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
        const credentialBarrier = store.get('connectionEpoch');
        credentialBarrier.onsuccess = () => { if (typeof credentialBarrier.result === 'string') connectionEpoch = credentialBarrier.result; };
      });
      projection?.registerConnections?.(ok ? restored : this.state);
      if (ok) {
        restored.entries = boundedEntries(rawEntries, projection?.sanitizeText);
        this.state = restored; this.epoch = epoch; this.connectionEpoch = connectionEpoch;
        this.observedCredentials ||= hasStoredCredentials(restored.connection);
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

  saveConnection(connection: StoredConnection, options?: ConnectionSaveOptions): Promise<StoredConnection | void> {
    const copy = connectionFrom(connection);
    if (!copy || this.closing) return Promise.resolve();
    const requestEpoch = this.connectionEpoch;
    const requestGeneration = this.connectionWriteGeneration;
    const initialLoad = requestEpoch === undefined && !this.observedCredentials;
    const suppliedSources = (options?.credentialsToForget ?? []).map(connectionFrom).filter((value): value is StoredConnection => !!value);
    return this.enqueue(async () => {
      // Only our own committed writes can authorize a later queued save to use a
      // new epoch. A queued load observing a peer's opt-out cannot reauthorize K.
      const expectedEpoch = this.connectionWriteGeneration > requestGeneration ? this.authoredConnectionEpoch ?? ''
        : requestEpoch ?? (initialLoad ? this.connectionEpoch ?? '' : '');
      const sources = [...this.cleanupDebt ?? [], ...suppliedSources,
        ...(options?.rememberCredentials === false ? [copy, ...(this.state.connection ? [this.state.connection] : [])] : [])];
      if (this.persist && options?.rememberCredentials === false && this.connectionEpoch === undefined && !this.failed) {
        await this.transact(false, (store) => {
          const request = store.get('connection');
          request.onsuccess = () => { const current = connectionFrom(request.result); if (current) sources.push(current); };
        });
      }
      const freshRAM = this.failed && !this.observedCredentials && !this.state.connection && !this.cleanupDebt;
      const forget = this.persist && !freshRAM && (!!this.cleanupDebt || options?.rememberCredentials === false && (options.authenticationIntent || sources.some(hasStoredCredentials)));
      let fenced: IDBDatabase | undefined;
      if (forget) {
        this.cleanupDebt = sources;
        fenced = await fenceLegacyDatabase(`${this.namespace}:chat`, () => this.closed);
        if (!fenced) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      }
      const retained = (known?: StoredConnection) => prepareSavedConnection(copy, known, options?.rememberCredentials);
      let saved: StoredConnection | undefined = retained(this.state.connection);
      let stale = false; let committedEpoch = expectedEpoch;
      const write = (store: IDBObjectStore) => {
        const barrier = store.get('connectionEpoch');
        barrier.onsuccess = () => {
          const currentEpoch = typeof barrier.result === 'string' ? barrier.result : '';
          const request = store.get('connection');
          request.onsuccess = () => {
            const current = connectionFrom(request.result);
            if (expectedEpoch !== currentEpoch) { stale = true; saved = current; return; }
            saved = retained(current);
            store.put(saved, 'connection');
            if (options?.rememberCredentials === false) {
              committedEpoch = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-');
              store.put(committedEpoch, 'connectionEpoch');
            }
          };
        };
      };
      let ok: boolean;
      try { ok = fenced ? await stateTransaction(fenced, true, write) : await this.transact(true, write); }
      finally { fenced?.close(); }
      if (!ok && forget) {
        // Retain committed credentials and cleanup debt. A retry must never turn
        // a failed disk deletion into a successful credential-free RAM snapshot.
        this.fail();
        throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      }
      if (saved) this.state.connection = saved;
      else delete this.state.connection;
      this.observedCredentials ||= hasStoredCredentials(saved);
      if (ok && stale) throw new ChatStorageError('stale-connection', 'Connection settings changed. Reload before saving again.');
      if (ok) {
        this.connectionEpoch = committedEpoch;
        this.authoredConnectionEpoch = committedEpoch;
        this.connectionWriteGeneration++;
        if (forget) { this.cleanupDebt = undefined; this.failed = false; this.opening = undefined; this.db?.close(); this.db = undefined; }
      }
      return saved ? structuredClone(saved) : undefined;
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
