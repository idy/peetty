import type { Figure } from '../figure/types.ts';
import { validateFigure } from '../figure/validate.ts';
import { COMPANION_ACTIONS, type ChatEntry } from './types.ts';
import type { ChatStorage, StoredChat, StoredConnection, StoredSessionConnection } from './store.ts';
import { boundedEntries, ChatStorageError } from './store.ts';
import { connectionIdentity, normalizeModelOptions, prepareSavedConnection } from './connections.ts';
import { applyEntryChanges, entryChanges, sanitizeEntries } from './history.ts';
import { openStateDatabase, stateTransaction } from './idb.ts';
import { PROFILE_LIMITS } from './limits.ts';
import { jsonChunks, jsonFingerprint, parseJSONChunks } from './bounded-json.ts';

export { PROFILE_LIMITS } from './limits.ts';

export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  sourceEntryId?: string;
  sourceText?: string;
  manual: boolean;
}

export interface ProfileRecord {
  id: string;
  name: string;
  figure: string | Figure;
  personality: string;
  useMemories: boolean;
  autoRemember: boolean;
  memories: MemoryEntry[];
  entries: ChatEntry[];
  connection?: StoredConnection;
  createdAt: number;
  updatedAt: number;
}

export type ProfileInfo = Omit<ProfileRecord, 'entries' | 'memories' | 'connection'> & { memoryCount: number; entryCount: number };
export interface BackupSession extends StoredSessionConnection { profileId: string }
type BackupOptions = { sessions: readonly BackupSession[] };
export interface BackupDownloadFile { name: string; text: string }
type BackupDownloadOptions = Partial<BackupOptions> & { _testing?: { fileBytes: number } };
interface BackupPart { format: 'peetty-backup-part'; version: 1; backupId: string; index: number; count: number; digest: string; text: string }
type Defaults = { name?: string; figure?: string | object; personality?: string };
type Settings = Pick<ProfileRecord, 'name' | 'figure' | 'personality' | 'useMemories' | 'autoRemember'>;
type SettingsInput = Omit<Partial<Settings>, 'figure'> & { figure?: string | object };
interface Directory { version: 1; ids: string[]; activeProfileId: string; bootstrapProfileId?: string }
interface RecordState { profile: ProfileRecord; epoch: string }
interface State { directory: Directory; records: Map<string, RecordState> }
interface LegacySnapshot { entries: unknown; connection: unknown; epoch: unknown }
interface LegacyMigration extends StoredChat { used: boolean; retire?: LegacySnapshot }
interface LegacyProof { version: 1; entries: string[]; connections: string[] }
function legacyProofFrom(value: unknown): LegacyProof | undefined {
  if (value === undefined) return;
  const proof = object(value, ['version', 'entries', 'connections']);
  check(proof.version === 1);
  const hashes = (value: unknown) => array(value, Number.MAX_SAFE_INTEGER, (hash) => { check(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)); return hash; });
  return { version: 1, entries: hashes(proof.entries), connections: hashes(proof.connections) };
}

/** Snapshots eligible for retirement contain validated JSON-shaped records only. */
function sameLegacyValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const first = a as Record<string, unknown>; const second = b as Record<string, unknown>;
  const fields = Object.keys(first);
  return fields.length === Object.keys(second).length && fields.every((field) => Object.hasOwn(second, field) && sameLegacyValue(first[field], second[field]));
}
interface Draft extends State { dirty: Set<string>; isolated: Set<string>; isolatedMemories: Set<string>; directoryDirty: boolean; legacyProof: LegacyProof | undefined; legacyDirty: boolean }
interface Backup { format: 'peetty-backup'; version: 1 | 2; createdAt: number; activeProfileId: string; profiles: ProfileRecord[]; sessions?: BackupSession[] }

const ACTIONS = new Set<string>(COMPANION_ACTIONS);
const INVALID = 'Invalid or unsupported profile data.';
const LIMIT = 'Profile storage limit reached.';
const MISSING = 'Profile or record no longer exists.';
const clone = <T>(value: T): T => structuredClone(value);
const emptyState = (): State => ({ directory: { version: 1, ids: [], activeProfileId: '' }, records: new Map() });
const key = (profileId: string): string => `profile:${profileId}`;
const freshId = (): string => Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-');
const normalizedText = (body: string): string => body.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
// Integrity check over exact UTF-16 chunks, including split surrogate pairs. This is
// accidental-corruption detection, not a signature or an authenticity guarantee.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function backupDigest(chunks: Iterable<string>): string {
  let crc = 0xffffffff; let length = 0;
  for (const value of chunks) {
    length += value.length;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      crc = CRC_TABLE[(crc ^ code) & 255]! ^ (crc >>> 8);
      crc = CRC_TABLE[(crc ^ (code >>> 8)) & 255]! ^ (crc >>> 8);
    }
  }
  return `crc32:${((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}:${length}`;
}

function check(condition: unknown, message = INVALID): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  check(Object.keys(record).every((field) => fields.includes(field)));
  return record;
}
function text(value: unknown, max: number, allowEmpty = false): string {
  check(typeof value === 'string' && value.length <= max && (allowEmpty || !!value.trim()));
  return value;
}
function id(value: unknown): string {
  const result = text(value, 200);
  check(result === result.trim() && !/[\u0000-\u001f\u007f]/u.test(result));
  return result;
}
function timestamp(value: unknown): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return value;
}
function boolean(value: unknown): boolean { check(typeof value === 'boolean'); return value; }
function array<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  check(Array.isArray(value) && value.length <= max);
  return value.map(parse);
}
function unique<T extends { id: string }>(values: T[]): T[] {
  check(new Set(values.map((value) => value.id)).size === values.length);
  return values;
}
function entryFrom(value: unknown): ChatEntry {
  const entry = object(value, ['id', 'role', 'text', 'createdAt']);
  check(entry.role === 'user' || entry.role === 'assistant' || entry.role === 'action');
  const body = text(entry.text, PROFILE_LIMITS.entryText);
  check(entry.role !== 'action' || ACTIONS.has(body));
  return { id: id(entry.id), role: entry.role, text: body, createdAt: timestamp(entry.createdAt) };
}
function memoryFrom(value: unknown): MemoryEntry {
  const memory = object(value, ['id', 'text', 'createdAt', 'updatedAt', 'sourceEntryId', 'sourceText', 'manual']);
  return {
    id: id(memory.id), text: text(memory.text, PROFILE_LIMITS.memoryText),
    createdAt: timestamp(memory.createdAt), updatedAt: timestamp(memory.updatedAt), manual: boolean(memory.manual),
    ...(memory.sourceEntryId !== undefined ? { sourceEntryId: id(memory.sourceEntryId) } : {}),
    ...(memory.sourceText !== undefined ? { sourceText: text(memory.sourceText, PROFILE_LIMITS.entryText, true) } : {}),
  };
}
function figureFrom(value: unknown): string | Figure {
  if (typeof value === 'string') return text(value, PROFILE_LIMITS.figureReference).trim();
  try { return clone(validateFigure(value)); } catch { throw new Error(INVALID); }
}
/** One transport codec for persisted, restored, and explicit session connections. */
function connectionFrom(value: unknown, strict = true): StoredConnection {
  const connection = strict ? object(value, ['id', 'baseUrl', 'apiKey', 'tools', 'effort', 'provider', 'headers', 'nonCredentialHeaders']) : value as Record<string, unknown>;
  check(connection !== null && typeof connection === 'object' && !Array.isArray(connection));
  try {
    const normalized = normalizeModelOptions({
      id: text(connection.id, 200), baseUrl: text(connection.baseUrl, PROFILE_LIMITS.fileBytes),
      ...(connection.apiKey !== undefined ? { apiKey: text(connection.apiKey, PROFILE_LIMITS.fileBytes, true) } : {}),
      ...(connection.provider !== undefined ? { provider: text(connection.provider, 200, true) } : {}),
      ...(connection.headers !== undefined ? { headers: connection.headers as Record<string, string> } : {}),
      ...(connection.nonCredentialHeaders !== undefined ? { nonCredentialHeaders: connection.nonCredentialHeaders as string[] } : {}),
      ...(connection.tools !== undefined ? { tools: boolean(connection.tools) } : {}),
      ...(connection.effort !== undefined ? { effort: connection.effort as StoredConnection['effort'] & string } : {}),
    });
    return normalized;
  } catch { throw new Error(INVALID); }
}
function profileFrom(value: unknown): ProfileRecord {
  const profile = object(value, ['id', 'name', 'figure', 'personality', 'useMemories', 'autoRemember', 'memories', 'entries', 'connection', 'createdAt', 'updatedAt']);
  return {
    id: id(profile.id), name: text(profile.name, PROFILE_LIMITS.name), figure: figureFrom(profile.figure),
    personality: text(profile.personality, PROFILE_LIMITS.personality, true), useMemories: boolean(profile.useMemories), autoRemember: boolean(profile.autoRemember),
    memories: unique(array(profile.memories, PROFILE_LIMITS.memories, memoryFrom)), entries: unique(array(profile.entries, PROFILE_LIMITS.entries, entryFrom)),
    createdAt: timestamp(profile.createdAt), updatedAt: timestamp(profile.updatedAt),
    ...(profile.connection !== undefined ? { connection: connectionFrom(profile.connection) } : {}),
  };
}
function directoryFrom(value: unknown): Directory {
  if (value === undefined) return emptyState().directory;
  const directory = object(value, ['version', 'ids', 'activeProfileId', 'bootstrapProfileId']);
  check(directory.version === 1);
  const ids = array(directory.ids, PROFILE_LIMITS.profiles, id);
  check(new Set(ids).size === ids.length);
  const activeProfileId = ids.length ? id(directory.activeProfileId) : text(directory.activeProfileId, 0, true);
  check(!ids.length || ids.includes(activeProfileId));
  if (directory.bootstrapProfileId !== undefined) check(ids.includes(id(directory.bootstrapProfileId)));
  return { version: 1, ids, activeProfileId, ...(directory.bootstrapProfileId !== undefined ? { bootstrapProfileId: id(directory.bootstrapProfileId) } : {}) };
}
function recordFrom(value: unknown, expectedId: string): RecordState {
  const record = object(value, ['profile', 'epoch']);
  const profile = profileFrom(record.profile);
  check(profile.id === expectedId);
  return { profile, epoch: id(record.epoch) };
}
function checkFile(value: string, message = INVALID): void {
  check(value.length <= PROFILE_LIMITS.fileBytes && new TextEncoder().encode(value).length <= PROFILE_LIMITS.fileBytes, message);
}
function parseJSON(value: string): unknown {
  check(typeof value === 'string');
  checkFile(value);
  try { return JSON.parse(value) as unknown; } catch { throw new Error(INVALID); }
}
function stringify(value: unknown): string {
  const result = JSON.stringify(value);
  checkFile(result, LIMIT);
  return result;
}
function sessionFrom(value: unknown): BackupSession {
  const session = object(value, ['profileId', 'connection', 'rememberKey']);
  return { profileId: id(session.profileId), connection: connectionFrom(session.connection), rememberKey: boolean(session.rememberKey) };
}
function backupFrom(value: unknown): Backup {
  const backup = object(value, ['format', 'version', 'createdAt', 'activeProfileId', 'profiles', 'sessions']);
  check(backup.format === 'peetty-backup' && (backup.version === 1 || backup.version === 2));
  check(backup.version === 2 || backup.sessions === undefined);
  const profiles = unique(array(backup.profiles, PROFILE_LIMITS.profiles, profileFrom));
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const activeProfileId = id(backup.activeProfileId);
  check(profiles.length && profileIds.has(activeProfileId));
  const sessions = backup.sessions === undefined ? undefined : array(backup.sessions, PROFILE_LIMITS.fileBytes, sessionFrom);
  if (sessions) check(sessions.every((session) => profileIds.has(session.profileId)));
  return { format: 'peetty-backup', version: backup.version, createdAt: timestamp(backup.createdAt), activeProfileId, profiles, ...(sessions ? { sessions } : {}) };
}
function settingsFrom(patch: SettingsInput): Partial<Settings> {
  const supplied = object(patch, ['name', 'figure', 'personality', 'useMemories', 'autoRemember']);
  return {
    ...(supplied.name !== undefined ? { name: text(supplied.name, PROFILE_LIMITS.name).trim() } : {}),
    ...(supplied.figure !== undefined ? { figure: figureFrom(supplied.figure) } : {}),
    ...(supplied.personality !== undefined ? { personality: text(supplied.personality, PROFILE_LIMITS.personality, true).trim() } : {}),
    ...(supplied.useMemories !== undefined ? { useMemories: boolean(supplied.useMemories) } : {}),
    ...(supplied.autoRemember !== undefined ? { autoRemember: boolean(supplied.autoRemember) } : {}),
  };
}
function getRecord(draft: State, profileId: string): RecordState {
  const record = draft.records.get(profileId);
  if (!draft.directory.ids.includes(profileId) || !record) throw new ChatStorageError('missing-profile', MISSING);
  return record;
}
function useBootstrap(draft: Draft, profileId: string): void {
  if (draft.directory.bootstrapProfileId !== profileId) return;
  delete draft.directory.bootstrapProfileId;
  draft.directoryDirty = true;
}
function touch(draft: Draft, profileId: string): RecordState {
  let record = getRecord(draft, profileId);
  if (!draft.isolated.has(profileId)) {
    record = { ...record, profile: { ...record.profile } };
    draft.records.set(profileId, record);
    draft.isolated.add(profileId);
  }
  record.profile.updatedAt = Date.now();
  draft.dirty.add(profileId);
  useBootstrap(draft, profileId);
  return record;
}
/** Memories are the only nested records edited in place; histories always replace their array/entry. */
function touchMemories(draft: Draft, profileId: string): RecordState {
  const record = touch(draft, profileId);
  if (!draft.isolatedMemories.has(profileId)) {
    record.profile.memories = record.profile.memories.map((memory) => ({ ...memory }));
    draft.isolatedMemories.add(profileId);
  }
  return record;
}
function detachSources(profile: ProfileRecord, removed: readonly ChatEntry[]): void {
  const sources = new Map(removed.map((entry) => [entry.id, entry.text]));
  for (const memory of profile.memories) {
    if (memory.sourceEntryId && sources.has(memory.sourceEntryId)) {
      memory.sourceText ??= sources.get(memory.sourceEntryId)!;
      delete memory.sourceEntryId;
    }
  }
}
function addSession(sessions: Map<string, StoredSessionConnection>, incoming: StoredSessionConnection): void {
  const identity = connectionIdentity(incoming.connection);
  // The latest equivalent connection owns its consent and remains the active (last) session.
  sessions.delete(identity);
  sessions.set(identity, incoming);
}
/** Memory-only sharing excludes conversation evidence; complete backups retain it. */
function portableMemories(profile: ProfileRecord): MemoryEntry[] {
  return profile.memories.map(({ sourceEntryId: _sourceId, sourceText: _sourceText, ...memory }) => memory);
}
/** Keep original text for CAS without retaining entries outside the runtime's bounded view. */
function runtimeWindow(archive: readonly ChatEntry[], sanitizeText?: (text: string) => string): { entries: ChatEntry[]; originals: ChatEntry[] } {
  const entries = boundedEntries(archive, sanitizeText);
  const originals: ChatEntry[] = [];
  for (let i = archive.length - 1, j = entries.length - 1; i >= 0 && j >= 0; i--) {
    if (archive[i]!.id === entries[j]!.id) { originals.push(archive[i]!); j--; }
  }
  return { entries, originals: originals.reverse() };
}
function page<T extends { text: string }>(values: readonly T[], query: string, count: number, reverse = false): { entries: T[]; hasMore: boolean } {
  const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const needle = query.trim();
  const search = needle ? needle.toLocaleLowerCase('en-US') : '';
  const matches: T[] = [];
  for (let i = reverse ? values.length - 1 : 0; reverse ? i >= 0 : i < values.length; i += reverse ? -1 : 1) {
    const value = values[i]!;
    if (search && !value.text.toLocaleLowerCase('en-US').includes(search)) continue;
    matches.push(value);
    if (matches.length > limit) break;
  }
  return { entries: matches.slice(0, limit).map((value) => clone(value)), hasMore: matches.length > limit };
}

/** Browser-only profiles. IndexedDB is authoritative; failed storage degrades to this instance's memory. */
export class BrowserProfileStore {
  private readonly namespace: string;
  private readonly persist: boolean;
  private state: State = emptyState();
  private readonly sessions = new Map<string, StoredSessionConnection[]>();
  private readonly figureTokens = new WeakMap<Figure, symbol>();
  private db: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase | undefined> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private selectedId: string | undefined;
  private closing = false;
  private closed = false;
  private failed = false;
  private legacyProof: LegacyProof | undefined;
  private reconcilingLegacy = false;

  constructor(namespace = 'peetty', persist = true) { this.namespace = namespace; this.persist = persist; }
  get persistenceWarning(): boolean { return this.failed; }
  get activeProfileId(): string { return this.selectedId && this.state.directory.ids.includes(this.selectedId) ? this.selectedId : this.state.directory.activeProfileId; }
  get profiles(): readonly ProfileRecord[] { return this.state.directory.ids.map((profileId) => clone(getRecord(this.state, profileId).profile)); }
  get activeProfile(): ProfileRecord { return clone(getRecord(this.state, this.activeProfileId).profile); }
  listProfiles(): readonly { id: string; name: string }[] { return this.state.directory.ids.map((profileId) => ({ id: profileId, name: getRecord(this.state, profileId).profile.name })); }
  /** Cheap identity for immutable figure data; storage refreshes naturally invalidate it. */
  figureToken(profileId: string): string | symbol | undefined {
    const figure = this.state.records.get(profileId)?.profile.figure;
    if (typeof figure !== 'object') return figure;
    let token = this.figureTokens.get(figure);
    if (!token) { token = Symbol(); this.figureTokens.set(figure, token); }
    return token;
  }
  profileInfo(profileId: string): ProfileInfo | undefined {
    const profile = this.state.records.get(profileId)?.profile;
    if (!profile) return;
    const { entries, memories, connection: _connection, ...info } = profile;
    return { ...info, figure: typeof profile.figure === 'string' ? profile.figure : clone(profile.figure), memoryCount: memories.length, entryCount: entries.length };
  }
  storedConnection(profileId: string): StoredConnection | undefined {
    const connection = this.state.records.get(profileId)?.profile.connection;
    return connection ? clone(connection) : undefined;
  }
  memoryEnabled(profileId: string): boolean { return this.state.records.get(profileId)?.profile.useMemories ?? false; }
  autoRememberEnabled(profileId: string): boolean { return this.state.records.get(profileId)?.profile.autoRemember ?? false; }
  memoryTexts(profileId: string): readonly { text: string }[] { return this.state.records.get(profileId)?.profile.memories.map((memory) => ({ text: memory.text })) ?? []; }
  memoryPage(profileId: string, query: string, count: number): { entries: MemoryEntry[]; hasMore: boolean } { return page(this.state.records.get(profileId)?.profile.memories ?? [], query, count); }
  historyPage(profileId: string, query: string, count: number): { entries: ChatEntry[]; hasMore: boolean } { return page(this.state.records.get(profileId)?.profile.entries ?? [], query, count, true); }
  sourceText(profileId: string, entryId: string): string | undefined {
    const entries = this.state.records.get(profileId)?.profile.entries;
    if (entries) for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.id === entryId) return entries[i]!.text;
    }
    return undefined;
  }

  private fail(): void { this.failed = true; this.db?.close(); this.db = undefined; }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Profile storage is closed.'));
    const operation = this.queue.then(action);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  private async open(): Promise<IDBDatabase | undefined> {
    if (!this.persist || this.failed || this.closed) return undefined;
    if (this.db) return this.db;
    if (this.opening) return this.opening;
    this.opening = openStateDatabase(`${this.namespace}:profiles`, { isClosed: () => this.closed, onFailure: () => this.fail() });
    this.db = await this.opening;
    return this.db;
  }

  /** Read/modify/write within ONE transaction; only dirty records are written, never a cached directory. */
  private async run<T>(selection: readonly string[] | 'all', write: boolean, action: (draft: Draft) => T): Promise<T> {
    if (write && this.initialized && !this.reconcilingLegacy) await this.reconcileLegacy();
    const db = await this.open();
    let proof = this.legacyProof;
    let draft: Draft | undefined;
    let result!: T;
    let completedAction = false;
    let domainError: unknown;
    const apply = (current: State, isolated = new Set<string>()) => {
      draft = { directory: { ...current.directory, ids: [...current.directory.ids] }, records: new Map(current.records), dirty: new Set(), isolated,
        isolatedMemories: new Set(isolated), directoryDirty: false, legacyProof: proof, legacyDirty: false };
      result = action(draft);
      completedAction = true;
    };
    if (db) {
      const ok = await stateTransaction(db, write, (store, abort) => {
          const guard = (callback: () => void) => {
            try { callback(); } catch (error) {
              // Domain errors roll back. A failed put/delete after the action retains its draft in memory.
              if (!completedAction) domainError = error;
              abort();
            }
          };
          const proofRequest = store.get('legacyMigration');
          proofRequest.onsuccess = () => { try { proof = legacyProofFrom(proofRequest.result); } catch { proof = undefined; } };
          const directoryRequest = store.get('directory');
          directoryRequest.onsuccess = () => guard(() => {
            const directory = directoryFrom(directoryRequest.result);
            const records = new Map(this.state.records);
            const present = new Set(directory.ids);
            for (const cachedId of records.keys()) if (!present.has(cachedId)) records.delete(cachedId);
            const ids = selection === 'all' ? directory.ids : [...new Set([...selection, ...directory.ids.filter((profileId) => !records.has(profileId))])].filter((profileId) => present.has(profileId));
            const isolated = new Set(ids);
            let remaining = ids.length;
            const finishRead = () => {
              apply({ directory, records }, isolated);
              if (write) {
                for (const profileId of draft!.dirty) {
                  const record = draft!.records.get(profileId);
                  if (record) store.put(record, key(profileId));
                  else store.delete(key(profileId));
                }
                if (draft!.directoryDirty) store.put(draft!.directory, 'directory');
                if (draft!.legacyDirty) store.put(draft!.legacyProof, 'legacyMigration');
              }
            };
            if (!remaining) finishRead();
            for (const profileId of ids) {
              const request = store.get(key(profileId));
              request.onsuccess = () => guard(() => {
                records.set(profileId, recordFrom(request.result, profileId));
                if (--remaining === 0) finishRead();
              });
            }
          });
      });
      if (domainError) throw domainError;
      if (!ok) this.fail();
    }
    if (!completedAction) apply(this.state);
    this.state = { directory: draft!.directory, records: draft!.records };
    this.legacyProof = draft!.legacyProof;
    for (const profileId of this.sessions.keys()) if (!this.state.records.has(profileId)) this.sessions.delete(profileId);
    return result;
  }

  private ready(): void { check(this.initialized, 'Initialize profile storage first.'); }
  private queued<T>(selection: readonly string[], write: boolean, action: (draft: Draft) => T): Promise<T> {
    return this.enqueue(async () => { this.ready(); return this.run(selection, write, action); });
  }

  /** Read raw legacy records without applying the runtime's history truncation policy. */
  private async legacy(): Promise<LegacyMigration> {
    if (!this.persist || this.failed || this.closed) return { entries: [], used: false };
    // Migration is optional and owns its connection. Its failure must not close
    // healthy profile storage or bypass the authoritative initialization recheck.
    const db = await openStateDatabase(`${this.namespace}:chat`, { isClosed: () => this.closed, onFailure: () => {} });
    // Unreadable legacy data is not evidence of an unused bootstrap profile.
    if (!db) return { entries: [], used: true };
    try {
      let entries: unknown;
      let connection: unknown;
      let epoch: unknown;
      const ok = await stateTransaction(db, false, (store) => {
        const history = store.get('entries');
        history.onsuccess = () => { entries = history.result; };
        const setup = store.get('connection');
        setup.onsuccess = () => { connection = setup.result; };
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => { epoch = barrier.result; };
      });
      if (!ok) return { entries: [], used: true };
      // Legacy data was less strict: salvage each valid entry independently and
      // never disable healthy profile persistence because one old record is malformed.
      const salvaged: ChatEntry[] = [];
      const seen = new Set<string>();
      if (Array.isArray(entries)) for (const value of entries) {
        try {
          const entry = entryFrom(value);
          if (!seen.has(entry.id) && salvaged.length < PROFILE_LIMITS.entries) { salvaged.push(entry); seen.add(entry.id); }
        } catch { /* Preserve the legacy database for manual recovery. */ }
      }
      let saved: StoredConnection | undefined;
      try { if (connection !== undefined) saved = connectionFrom(connection, false); } catch { /* History can still migrate. */ }
      // Partial salvage is useful, but does not authorize deleting any originals.
      let complete = false;
      try {
        if (entries !== undefined) {
          unique(array(entries, PROFILE_LIMITS.entries, entryFrom));
          check(Array.isArray(entries) && entries.length === salvaged.length);
        }
        if (connection !== undefined) connectionFrom(connection);
        check(epoch === undefined || typeof epoch === 'string');
        complete = true;
      } catch { /* Leave malformed/partially copied legacy data available for recovery. */ }
      const used = entries !== undefined || connection !== undefined || epoch !== undefined;
      return { entries: salvaged, used, ...(saved ? { connection: saved } : {}),
        ...(complete && used ? { retire: { entries, connection, epoch } } : {}) };
    } finally { db.close(); }
  }

  /** Retire only the exact records copied by our successful authoritative write.
   * Read/compare/delete share a legacy transaction, so a concurrent old client wins. */
  private async retireLegacy(snapshot: LegacySnapshot, proof: LegacyProof): Promise<void> {
    if (!this.persist || this.failed || this.closed) return;
    const knownEntries = new Set(proof.entries); const knownConnections = new Set(proof.connections);
    const original = snapshot.entries === undefined ? undefined : array(snapshot.entries, PROFILE_LIMITS.entries, entryFrom);
    const remainingEntries = original?.filter((entry) => !knownEntries.has(jsonFingerprint(entry)));
    const changedEntries = original !== undefined && (original.length === 0 || remainingEntries!.length !== original.length);
    const removeConnection = snapshot.connection !== undefined && knownConnections.has(jsonFingerprint(connectionFrom(snapshot.connection)));
    if (!changedEntries && !removeConnection) return;
    const db = await openStateDatabase(`${this.namespace}:chat`, { isClosed: () => this.closed, onFailure: () => {} });
    if (!db) return;
    try {
      await stateTransaction(db, true, (store, abort) => {
        const fields = [['entries', 'entries'], ['connection', 'connection'], ['entriesEpoch', 'epoch']] as const;
        const current = {} as LegacySnapshot;
        let remaining = fields.length;
        for (const [recordKey, field] of fields) {
          const request = store.get(recordKey);
          request.onsuccess = () => {
            try {
              current[field] = request.result;
              if (--remaining || !sameLegacyValue(current, snapshot)) return;
              if (changedEntries) {
                if (remainingEntries!.length) store.put(remainingEntries, 'entries');
                else store.delete('entries');
              }
              if (removeConnection) store.delete('connection');
              if ((!original || changedEntries && !remainingEntries!.length) && (snapshot.connection === undefined || removeConnection)) store.delete('entriesEpoch');
            } catch { abort(); }
          };
        }
      });
    } finally { db.close(); }
  }

  /** Establish proof from actual authoritative correspondence before user deletion,
   * then retry CAS cleanup. Previously copied digests survive clear/key opt-out. */
  private async reconcileLegacy(): Promise<void> {
    if (!this.persist || this.failed || this.closed || this.reconcilingLegacy) return;
    this.reconcilingLegacy = true;
    try {
      const legacy = await this.legacy();
      if (!legacy.retire) return;
      const candidates = legacy.entries.map((entry) => ({ entry, digest: jsonFingerprint(entry) }));
      const connectionDigest = legacy.connection ? jsonFingerprint(legacy.connection) : undefined;
      const proof = await this.run('all', true, (draft) => {
        const entries = new Set(draft.legacyProof?.entries); const connections = new Set(draft.legacyProof?.connections);
        let changed = false;
        for (const record of draft.records.values()) {
          const current = new Map(record.profile.entries.map((entry) => [entry.id, entry]));
          for (const candidate of candidates) if (!entries.has(candidate.digest) && sameLegacyValue(candidate.entry, current.get(candidate.entry.id))) {
            entries.add(candidate.digest); changed = true;
          }
          if (connectionDigest && !connections.has(connectionDigest) && sameLegacyValue(legacy.connection, record.profile.connection)) {
            connections.add(connectionDigest); changed = true;
          }
        }
        if (changed) {
          draft.legacyProof = { version: 1, entries: [...entries], connections: [...connections] };
          draft.legacyDirty = true;
        }
        return draft.legacyProof;
      });
      if (!this.failed && proof) await this.retireLegacy(legacy.retire, proof);
    } finally { this.reconcilingLegacy = false; }
  }

  async initialize(defaults: Defaults = {}): Promise<void> {
    const settings = settingsFrom(defaults);
    return this.enqueue(async () => {
      if (this.initialized) return;
      await this.run('all', false, () => {});
      if (!this.state.directory.ids.length) {
        const { used, retire, ...legacy } = await this.legacy();
        const proof: LegacyProof | undefined = retire ? { version: 1, entries: legacy.entries.map(jsonFingerprint),
          connections: legacy.connection ? [jsonFingerprint(legacy.connection)] : [] } : undefined;
        const now = Date.now();
        const profile: ProfileRecord = {
          id: freshId(), name: settings.name ?? 'Miru', figure: settings.figure ?? 'miru', personality: settings.personality ?? '',
          useMemories: true, autoRemember: false, memories: [], ...legacy, createdAt: now, updatedAt: now,
        };
        const migrated = await this.run('all', true, (draft) => {
          // Another tab may have completed migration while we read the legacy database.
          if (draft.directory.ids.length) return false;
          draft.directory = { version: 1, ids: [profile.id], activeProfileId: profile.id, ...(!used ? { bootstrapProfileId: profile.id } : {}) };
          draft.records.set(profile.id, { profile, epoch: freshId() });
          draft.dirty.add(profile.id);
          draft.directoryDirty = true;
          if (proof) { draft.legacyProof = proof; draft.legacyDirty = true; }
          return true;
        });
        if (migrated && !this.failed && retire && proof) await this.retireLegacy(retire, proof);
        else if (!migrated) await this.reconcileLegacy();
      } else await this.reconcileLegacy();
      this.selectedId = this.state.directory.activeProfileId;
      this.initialized = true;
    });
  }

  /** Hosts call this for meaningful SDK-only configuration that does not write a saved connection. */
  markBootstrapUsed(profileId = this.activeProfileId): Promise<void> {
    return this.queued([profileId], true, (draft) => { getRecord(draft, profileId); useBootstrap(draft, profileId); });
  }
  select(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      this.ready();
      await this.run([profileId], true, (draft) => {
        getRecord(draft, profileId);
        draft.directory.activeProfileId = profileId;
        draft.directoryDirty = true;
      });
      this.selectedId = profileId;
    });
  }
  async create(input: { name: string; figure?: string | object; personality?: string }): Promise<ProfileRecord> {
    const settings = settingsFrom(input);
    check(settings.name);
    const now = Date.now();
    const profile: ProfileRecord = { id: freshId(), name: settings.name, figure: settings.figure ?? 'miru', personality: settings.personality ?? '',
      useMemories: true, autoRemember: false, memories: [], entries: [], createdAt: now, updatedAt: now };
    return this.enqueue(async () => {
      this.ready();
      const created = await this.run([], true, (draft) => {
        check(draft.directory.ids.length < PROFILE_LIMITS.profiles, LIMIT);
        while (draft.records.has(profile.id)) profile.id = freshId();
        draft.records.set(profile.id, { profile: clone(profile), epoch: freshId() });
        draft.directory.ids.push(profile.id);
        draft.directory.activeProfileId = profile.id;
        draft.directoryDirty = true;
        draft.dirty.add(profile.id);
        return clone(profile);
      });
      this.selectedId = created.id;
      return created;
    });
  }
  async update(profileId: string, patch: SettingsInput): Promise<void> {
    const settings = settingsFrom(patch);
    return this.queued([profileId], true, (draft) => {
      const profile = getRecord(draft, profileId).profile;
      const changed = (Object.keys(settings) as (keyof Settings)[]).some((field) => {
        const value = settings[field];
        return field === 'figure' && typeof value === 'object' && typeof profile.figure === 'object'
          ? JSON.stringify(value) !== JSON.stringify(profile.figure) : value !== profile[field];
      });
      if (changed) Object.assign(touch(draft, profileId).profile, settings);
    });
  }
  remove(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      this.ready();
      await this.run([profileId], true, (draft) => {
        getRecord(draft, profileId);
        check(draft.directory.ids.length > 1, 'Cannot remove the last profile.');
        useBootstrap(draft, profileId);
        draft.directory.ids = draft.directory.ids.filter((value) => value !== profileId);
        if (draft.directory.activeProfileId === profileId) draft.directory.activeProfileId = draft.directory.ids[0]!;
        draft.records.delete(profileId);
        draft.dirty.add(profileId);
        draft.directoryDirty = true;
      });
      this.sessions.delete(profileId);
    });
  }

  /** Complete storage API for hosts, migrations, and direct archive consumers. */
  storage(profileId: string): ChatStorage { return this.profileStorage(profileId, false); }

  /** Bounded view for runtimes supplying changedIds; the profile retains the complete archive. */
  runtimeStorage(profileId: string): ChatStorage { return this.profileStorage(profileId, true); }

  private profileStorage(profileId: string, runtime: boolean): ChatStorage {
    let snapshot: ChatEntry[] = this.state.records.get(profileId)?.profile.entries ?? [];
    if (runtime) snapshot = runtimeWindow(snapshot).originals;
    let epoch = this.state.records.get(profileId)?.epoch;
    let closing = false;
    const manager = this;
    return {
      get persistenceWarning() { return manager.persistenceWarning; },
      load: (projection) => this.queued([profileId], false, (draft) => {
        const record = getRecord(draft, profileId);
        const sessions = this.sessions.get(profileId);
        const connections = { ...(record.profile.connection ? { connection: clone(record.profile.connection) } : {}),
          ...(sessions?.length ? { sessionConnections: clone(sessions) } : {}) };
        projection?.registerConnections?.(connections);
        let entries: ChatEntry[];
        if (runtime) {
          const window = runtimeWindow(record.profile.entries, projection?.sanitizeText);
          snapshot = window.originals;
          entries = window.entries;
        } else { snapshot = record.profile.entries; entries = clone(sanitizeEntries(snapshot, projection?.sanitizeText)); }
        epoch = record.epoch;
        return { entries, ...connections };
      }),
      ensureCapacity: (additionalEntries) => this.queued([profileId], false, (draft) => {
        const count = getRecord(draft, profileId).profile.entries.length;
        if (count + additionalEntries > PROFILE_LIMITS.entries) throw new ChatStorageError('capacity', 'Conversation archive is full. Export or remove history before sending.');
      }),
      saveConnection: async (connection, options) => {
        if (closing) return;
        const copy = connectionFrom(connection, false);
        return this.enqueue(async () => {
          this.ready();
          const saved = await this.run([profileId], true, (draft) => {
            const known = this.sessions.get(profileId)?.at(-1)?.connection ?? getRecord(draft, profileId).profile.connection;
            const saved = prepareSavedConnection(copy, known, options?.rememberCredentials);
            touch(draft, profileId).profile.connection = saved;
            return clone(saved);
          });
          this.sessions.delete(profileId);
          return saved;
        });
      },
      saveEntries: async (entries, changedIds, sanitizeText) => {
        if (closing) return;
        const copy = unique(array(entries, PROFILE_LIMITS.entries, entryFrom));
        const selected = changedIds === undefined ? undefined : [...changedIds];
        await this.enqueue(async () => {
          this.ready();
          const changes = entryChanges(snapshot, copy, selected);
          await this.run([profileId], true, (draft) => {
            const record = getRecord(draft, profileId);
            let merged = record.profile.entries;
            if (epoch === undefined || epoch === record.epoch) {
              merged = applyEntryChanges(merged, changes, true);
              if (merged.length > PROFILE_LIMITS.entries) throw new ChatStorageError('capacity', 'Conversation archive is full. Export or remove history before sending.');
              epoch = record.epoch;
            }
            // Sanitize complete CURRENT text independently of masked user edits and
            // their CAS baselines. Never replace full archive text with the clipped view.
            merged = sanitizeEntries(merged, sanitizeText);
            if (merged.length !== record.profile.entries.length || merged.some((entry, i) => entry !== record.profile.entries[i])) touch(draft, profileId).profile.entries = merged;
            // Only clear advances the barrier. Rejected edits keep their local baseline, never reinsert.
          });
          snapshot = sanitizeEntries(applyEntryChanges(snapshot, changes), sanitizeText);
          if (runtime) snapshot = runtimeWindow(snapshot).originals;
        });
      },
      clearEntries: async () => {
        if (closing) return;
        await this.enqueue(async () => {
          this.ready();
          await this.run([profileId], true, (draft) => {
            const record = touchMemories(draft, profileId);
            detachSources(record.profile, record.profile.entries);
            record.profile.entries = [];
            record.epoch = freshId();
            epoch = record.epoch;
            snapshot = [];
          });
        });
      },
      // A runtime owns this adapter only; queued writes finish and session state belongs to the manager.
      close: () => { closing = true; },
    };
  }

  async saveMemory(profileId: string, input: { id?: string; text: string; sourceEntryId?: string; sourceText?: string; manual?: boolean }, signal?: AbortSignal): Promise<void> {
    const body = text(input.text, PROFILE_LIMITS.memoryText).trim();
    const normalized = normalizedText(body);
    const memoryId = input.id === undefined ? undefined : id(input.id);
    const sourceEntryId = input.sourceEntryId === undefined ? undefined : id(input.sourceEntryId);
    const sourceText = input.sourceText === undefined ? undefined : text(input.sourceText, PROFILE_LIMITS.entryText, true);
    const manual = input.manual === undefined ? true : boolean(input.manual);
    return this.queued([profileId], true, (draft) => {
        if (signal?.aborted) throw new DOMException('Memory operation stopped.', 'AbortError');
        const current = getRecord(draft, profileId).profile;
        check(manual || current.autoRemember, 'Automatic memory is disabled.');
        let source: ChatEntry | undefined;
        if (sourceEntryId !== undefined) for (let i = current.entries.length - 1; i >= 0; i--) {
          if (current.entries[i]!.id === sourceEntryId) { source = current.entries[i]; break; }
        }
        if (!manual && sourceEntryId !== undefined) check(source && source.text === sourceText, 'The source message no longer matches.');
        const targetIndex = memoryId ? current.memories.findIndex((memory) => memory.id === memoryId) : -1;
        check(!memoryId || targetIndex !== -1, MISSING);
        const duplicateIndex = current.memories.findIndex((memory) => normalizedText(memory.text) === normalized);
        if (!manual && ((targetIndex !== -1 && current.memories[targetIndex]!.manual) || (duplicateIndex !== -1 && current.memories[duplicateIndex]!.manual))) return;
        check(targetIndex === -1 || duplicateIndex === -1 || targetIndex === duplicateIndex, 'A memory with this text already exists.');
        const existingIndex = targetIndex !== -1 ? targetIndex : duplicateIndex;
        if (existingIndex === -1) check(current.memories.length < PROFILE_LIMITS.memories, LIMIT);
        const profile = touchMemories(draft, profileId).profile;
        const now = Date.now();
        const memory = existingIndex === -1 ? { id: freshId(), text: body, createdAt: now, updatedAt: now, manual } as MemoryEntry : profile.memories[existingIndex]!;
        memory.text = body;
        memory.manual = manual;
        memory.updatedAt = now;
        if (sourceEntryId !== undefined) {
          if (source) { memory.sourceEntryId = sourceEntryId; memory.sourceText = sourceText ?? source.text; }
          else { delete memory.sourceEntryId; if (sourceText !== undefined) memory.sourceText = sourceText; }
        } else if (sourceText !== undefined) { memory.sourceText = sourceText; }
        if (existingIndex === -1) profile.memories.push(memory);
    });
  }
  removeMemory(profileId: string, memoryId: string): Promise<void> {
    return this.queued([profileId], true, (draft) => {
      const profile = touch(draft, profileId).profile;
      check(profile.memories.some((memory) => memory.id === memoryId), MISSING);
      profile.memories = profile.memories.filter((memory) => memory.id !== memoryId);
    });
  }
  async editEntry(profileId: string, entryId: string, body: string): Promise<void> {
    const copy = text(body, PROFILE_LIMITS.entryText);
    return this.queued([profileId], true, (draft) => {
      const record = touchMemories(draft, profileId);
      const index = record.profile.entries.findIndex((entry) => entry.id === entryId);
      const entry = record.profile.entries[index];
      check(entry, MISSING);
      check(entry.role !== 'action' || ACTIONS.has(copy));
      for (const memory of record.profile.memories) if (memory.sourceEntryId === entryId) memory.sourceText ??= entry.text;
      // Replace the array and entry so adapter baselines and lazy source indexes remain immutable.
      record.profile.entries = record.profile.entries.map((value, i) => i === index ? { ...value, text: copy } : value);
    });
  }
  removeEntry(profileId: string, entryId: string): Promise<void> {
    return this.queued([profileId], true, (draft) => {
      const record = touchMemories(draft, profileId);
      const entry = record.profile.entries.find((entry) => entry.id === entryId);
      check(entry, MISSING);
      detachSources(record.profile, [entry]);
      record.profile.entries = record.profile.entries.filter((value) => value.id !== entryId);
    });
  }

  /** Bounded legacy API. UI downloads use backupDownload to preserve larger archives. */
  async backup(options?: BackupOptions): Promise<string> {
    const backup = await this.backupSnapshot(options);
    const chunks: string[] = []; let bytes = 0;
    for (const chunk of jsonChunks(backup, 1_048_576)) {
      bytes += new TextEncoder().encode(chunk).length;
      check(bytes <= PROFILE_LIMITS.fileBytes, LIMIT);
      chunks.push(chunk);
    }
    return chunks.join('');
  }

  async backupDownload(options?: BackupDownloadOptions): Promise<string | BackupDownloadFile[]> {
    const fileBytes = options?._testing?.fileBytes ?? PROFILE_LIMITS.fileBytes;
    check(Number.isSafeInteger(fileBytes) && fileBytes >= 1_024 && fileBytes <= PROFILE_LIMITS.fileBytes);
    const backup = await this.backupSnapshot(options);
    // Only individual metadata/string tokens and bounded transport chunks are
    // serialized. A profile archive can exceed the engine's maximum string length.
    const chunkSize = Math.floor((fileBytes - 512) / 6);
    const chunks = Array.from(jsonChunks(backup, chunkSize));
    let bytes = 0;
    for (const chunk of chunks) bytes += new TextEncoder().encode(chunk).length;
    if (bytes <= fileBytes) return chunks.join(''); // Proven bounded single-file path only.
    const count = chunks.length;
    const backupId = freshId(); const digest = backupDigest(chunks);
    return chunks.map((text, index) => {
      const part: BackupPart = { format: 'peetty-backup-part', version: 1, backupId, index, count, digest, text };
      const serialized = stringify(part);
      check(new TextEncoder().encode(serialized).length <= fileBytes, LIMIT);
      return { name: `peetty-backup-${backupId}.part-${String(index + 1).padStart(String(count).length, '0')}-of-${count}.json`, text: serialized };
    });
  }

  private async backupSnapshot(options?: Partial<BackupOptions>): Promise<Backup> {
    const supplied = options?.sessions?.map(sessionFrom) ?? [];
    return this.enqueue(async () => {
      this.ready();
      return this.run('all', false, (draft) => {
        const profiles = draft.directory.ids.map((profileId) => {
          // Histories and memories are already validated; serialization needs no second deep copy.
          const profile = { ...getRecord(draft, profileId).profile };
          if (profile.connection) profile.connection = connectionFrom(profile.connection);
          return profile;
        });
        const byProfile = new Map<string, Map<string, StoredSessionConnection>>();
        for (const profileId of draft.directory.ids) {
          const sessions = new Map<string, StoredSessionConnection>();
          for (const session of this.sessions.get(profileId) ?? []) addSession(sessions, { connection: connectionFrom(session.connection), rememberKey: boolean(session.rememberKey) });
          byProfile.set(profileId, sessions);
        }
        // Credential callbacks may have resolved while another tab deleted their profile.
        for (const session of supplied) {
          const sessions = byProfile.get(session.profileId);
          if (sessions) addSession(sessions, session);
        }
        const sessions = Array.from(byProfile, ([profileId, values]) => Array.from(values.values(), (session) => ({ profileId, ...session }))).flat();
        return { format: 'peetty-backup', version: 2, createdAt: Date.now(),
          activeProfileId: this.selectedId && draft.directory.ids.includes(this.selectedId) ? this.selectedId : draft.directory.activeProfileId,
          profiles, ...(sessions.length ? { sessions } : {}) };
      });
    });
  }
  async restore(value: string): Promise<void> {
    return this.restoreFiles([value]);
  }

  async restoreFiles(texts: readonly string[]): Promise<void> {
    check(Array.isArray(texts) && texts.length > 0);
    // Each input retains the original file ceiling. Only a complete, consistent
    // multipart envelope can authorize parsing a larger reconstructed document.
    const values = Array.from(texts, parseJSON);
    let value: unknown = values[0];
    if (values.length > 1 || (value && typeof value === 'object' && 'format' in value && value.format === 'peetty-backup-part')) {
      const parts = values.map((item) => {
        const part = object(item, ['format', 'version', 'backupId', 'index', 'count', 'digest', 'text']);
        check(part.format === 'peetty-backup-part' && part.version === 1);
        check(Number.isSafeInteger(part.index) && Number.isSafeInteger(part.count));
        const index = part.index as number; const count = part.count as number;
        check(count > 1 && count === values.length && index >= 0 && index < count);
        const digest = text(part.digest, 100);
        check(/^crc32:[0-9a-f]{8}:[1-9][0-9]*$/.test(digest));
        return { backupId: id(part.backupId), index, count, digest, text: text(part.text, PROFILE_LIMITS.fileBytes) };
      });
      const first = parts[0]!;
      check(parts.every((part) => part.backupId === first.backupId && part.count === first.count && part.digest === first.digest));
      check(new Set(parts.map((part) => part.index)).size === parts.length);
      const chunks = parts.sort((a, b) => a.index - b.index).map((part) => part.text);
      check(backupDigest(chunks) === first.digest);
      value = parseJSONChunks(chunks, PROFILE_LIMITS.fileBytes * 6);
    } else check(values.length === 1);
    // Validate EVERY reconstructed profile and session before enqueueing a mutation.
    const backup = backupFrom(value);
    return this.enqueue(async () => {
      this.ready();
      const sessions = await this.run('all', true, (draft) => {
        if (draft.directory.ids.length + backup.profiles.length > PROFILE_LIMITS.profiles) {
          const bootstrapId = draft.directory.bootstrapProfileId;
          const shell = bootstrapId ? draft.records.get(bootstrapId)?.profile : undefined;
          const pristine = shell && !shell.entries.length && !shell.memories.length && !shell.connection && shell.createdAt === shell.updatedAt && shell.useMemories && !shell.autoRemember;
          check(pristine && draft.directory.ids.length - 1 + backup.profiles.length <= PROFILE_LIMITS.profiles, LIMIT);
          draft.directory.ids = draft.directory.ids.filter((profileId) => profileId !== bootstrapId);
          draft.records.delete(bootstrapId!);
          draft.dirty.add(bootstrapId!);
          delete draft.directory.bootstrapProfileId;
        }
        const reserved = new Set(draft.directory.ids);
        for (const profile of [...Array.from(draft.records.values(), (record) => record.profile), ...backup.profiles]) {
          reserved.add(profile.id);
          for (const entry of profile.entries) reserved.add(entry.id);
          for (const memory of profile.memories) reserved.add(memory.id);
        }
        const allocate = () => { let result: string; do { result = freshId(); } while (reserved.has(result)); reserved.add(result); return result; };
        const profileIds = new Map<string, string>();
        for (const original of backup.profiles) {
          const profile = clone(original);
          profile.id = allocate();
          profileIds.set(original.id, profile.id);
          const entryIds = new Map(profile.entries.map((entry) => [entry.id, allocate()]));
          for (const entry of profile.entries) entry.id = entryIds.get(entry.id)!;
          for (const memory of profile.memories) {
            memory.id = allocate();
            if (memory.sourceEntryId) {
              const mapped = entryIds.get(memory.sourceEntryId);
              if (mapped) memory.sourceEntryId = mapped;
              else delete memory.sourceEntryId;
            }
          }
          draft.records.set(profile.id, { profile, epoch: freshId() });
          draft.dirty.add(profile.id);
          draft.directory.ids.push(profile.id);
          if (original.id === backup.activeProfileId) draft.directory.activeProfileId = profile.id;
        }
        const sessions = new Map<string, Map<string, StoredSessionConnection>>();
        for (const session of backup.sessions ?? []) {
          const profileId = profileIds.get(session.profileId)!;
          const values = sessions.get(profileId) ?? new Map<string, StoredSessionConnection>();
          addSession(values, { connection: session.connection, rememberKey: session.rememberKey });
          sessions.set(profileId, values);
        }
        draft.directoryDirty = true;
        return new Map(Array.from(sessions, ([profileId, values]) => [profileId, Array.from(values.values())]));
      });
      for (const [profileId, values] of sessions) this.sessions.set(profileId, values);
      this.selectedId = this.state.directory.activeProfileId;
    });
  }
  private memoryExport(profileId: string): Promise<{ name: string; memories: MemoryEntry[] }> {
    return this.queued([profileId], false, (draft) => {
      const profile = getRecord(draft, profileId).profile;
      return { name: profile.name, memories: portableMemories(profile) };
    });
  }
  async exportMemories(profileId: string): Promise<string> {
    const { memories } = await this.memoryExport(profileId);
    return stringify({ format: 'peetty-memories', version: 1, memories });
  }
  async exportMemoryMarkdown(profileId: string): Promise<string> {
    const { name, memories } = await this.memoryExport(profileId);
    const result = [`# ${name} memories`, ...memories.map((memory, i) => [
      `## Memory ${i + 1}`, memory.text,
      `- ID: ${memory.id}\n- Saved: ${memory.manual ? 'Manually' : 'Automatically'}\n- Created (Unix ms): ${memory.createdAt}\n- Updated (Unix ms): ${memory.updatedAt}`,
    ].join('\n\n'))].join('\n\n') + '\n';
    checkFile(result, LIMIT);
    return result;
  }
  async importMemories(profileId: string, value: string): Promise<void> {
    const document = object(parseJSON(value), ['format', 'version', 'memories']);
    check(document.format === 'peetty-memories' && document.version === 1);
    const incoming = unique(array(document.memories, PROFILE_LIMITS.memories, memoryFrom)).map((memory) => ({ memory, normalized: normalizedText(memory.text) }));
    return this.queued([profileId], true, (draft) => {
        const profile = touchMemories(draft, profileId).profile;
        const byText = new Map(profile.memories.map((memory) => [normalizedText(memory.text), memory]));
        const ids = new Set([...profile.memories.map((memory) => memory.id), ...incoming.map(({ memory }) => memory.id)]);
        for (const { memory: original, normalized } of incoming) {
          const existing = byText.get(normalized);
          if (existing) {
            // Imports can promote extracted facts, but never overwrite a manual edit.
            if (!existing.manual && original.manual) {
              existing.manual = true;
              existing.text = original.text;
              existing.updatedAt = original.updatedAt;
              if (original.sourceText !== undefined) existing.sourceText = original.sourceText;
              delete existing.sourceEntryId;
            }
            continue;
          }
          const memory = clone(original);
          do { memory.id = freshId(); } while (ids.has(memory.id));
          ids.add(memory.id);
          delete memory.sourceEntryId;
          profile.memories.push(memory);
          byText.set(normalized, memory);
        }
        check(profile.memories.length <= PROFILE_LIMITS.memories, LIMIT);
    });
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.queue.then(() => { this.closed = true; this.sessions.clear(); this.db?.close(); this.db = undefined; });
  }
}
