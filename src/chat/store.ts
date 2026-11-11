import { COMPANION_ACTIONS, type ChatEntry, type PeettyReasoningEffort } from './types.ts';
import { isCredentialHeader } from './connections.ts';

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
  unresolvedAuthentication?: boolean;
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
  readonly code: 'missing-profile' | 'capacity' | 'stale-connection' | 'legacy-cleanup' | 'profile-delete' | 'privacy-delete' | 'settings-save';
  constructor(code: 'missing-profile' | 'capacity' | 'stale-connection' | 'legacy-cleanup' | 'profile-delete' | 'privacy-delete' | 'settings-save', message: string) { super(message); this.code = code; this.name = 'ChatStorageError'; }
}

export interface HistoryProjection {
  /** False for history refreshes that preserve the caller's current connection/consent. */
  observeConnection?: boolean;
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
