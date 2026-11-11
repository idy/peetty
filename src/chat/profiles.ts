import type { Figure } from '../figure/types.ts';
import { LIMITS as FIGURE_LIMITS, validateFigure } from '../figure/validate.ts';
import { COMPANION_ACTIONS, type ChatEntry } from './types.ts';
import type { ChatStorage, StoredChat, StoredConnection, StoredSessionConnection } from './store.ts';
import { boundedEntries, ChatStorageError, forgetConnectionCredentials } from './store.ts';
import { connectionIdentity, hasStoredCredentials, isCredentialHeader, normalizeModelOptions, prepareSavedConnection } from './connections.ts';
import { applyEntryChanges, entryChanges, sanitizeEntries } from './history.ts';
import { fenceLegacyDatabase, openStateDatabase, stateTransaction } from './idb.ts';
import { PROFILE_LIMITS } from './limits.ts';
import { jsonChunks, jsonFingerprint, parseJSONChunks, parseJSONChunksAsync } from './bounded-json.ts';

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
type BackupOptions = { sessions?: readonly BackupSession[]; omitCredentials?: boolean };
export interface BackupDownloadFile { name: string; text: string; final?: boolean }
export interface BackupRestoreFile { readonly size: number; text(): Promise<string> }
export interface BackupRestoreOptions { signal?: AbortSignal; current?: () => boolean }
type BackupDownloadOptions = Partial<BackupOptions> & { signal?: AbortSignal; _testing?: { fileBytes: number } };
interface BackupPart { format: 'peetty-backup-part'; version: 1; backupId: string; index: number; count: number; digest: string; text: string }
type Defaults = { name?: string; figure?: string | object; personality?: string };
type Settings = Pick<ProfileRecord, 'name' | 'figure' | 'personality' | 'useMemories' | 'autoRemember'>;
type SettingsInput = Omit<Partial<Settings>, 'figure'> & { figure?: string | object };
interface Directory { version: 1; ids: string[]; activeProfileId: string; bootstrapProfileId?: string }
interface RecordState { profile: ProfileRecord; epoch: string; connectionEpoch?: string; unresolvedCleanup?: string }
interface CleanupDebt { credentials: readonly StoredConnection[]; unresolvedAuthentication: boolean; intent?: string }
interface State { directory: Directory; records: Map<string, RecordState> }
interface LegacySnapshot { entries: unknown; connection: unknown; epoch: unknown; connectionEpoch: unknown }
interface LegacyMigration extends StoredChat { used: boolean; retire?: LegacySnapshot }
interface LegacyProof { version: 1; entries: string[]; connections: string[] }
type LegacyPrivacy = 'automatic' | 'history' | 'credentials' | 'profile';
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
/** Combine per-part CRCs in index order without rereading or retaining the part.
 * The CRC processes two little-endian bytes per UTF-16 code unit, as above. */
function combineBackupDigests(digests: Iterable<string>): string {
  const times = (matrix: Uint32Array, vector: number) => {
    let result = 0; let index = 0;
    for (let bits = vector >>> 0; bits; bits >>>= 1) { if (bits & 1) result ^= matrix[index]!; index++; }
    return result >>> 0;
  };
  const square = (matrix: Uint32Array) => Uint32Array.from({ length: 32 }, (_, i) => times(matrix, matrix[i]!));
  const combine = (first: number, second: number, bytes: number) => {
    if (!bytes) return first;
    let odd = new Uint32Array(32); odd[0] = 0xedb88320;
    for (let i = 1, row = 1; i < 32; i++, row <<= 1) odd[i] = row;
    let even = square(odd); odd = square(even);
    do {
      even = square(odd); if (bytes % 2) first = times(even, first); bytes = Math.floor(bytes / 2);
      if (!bytes) break;
      odd = square(even); if (bytes % 2) first = times(odd, first); bytes = Math.floor(bytes / 2);
    } while (bytes);
    return (first ^ second) >>> 0;
  };
  let crc = 0; let length = 0;
  for (const digest of digests) {
    const fields = digest.split(':'); const count = Number(fields[2]);
    check(Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(length + count));
    crc = combine(crc, Number.parseInt(fields[1]!, 16), count * 2); length += count;
  }
  return `crc32:${crc.toString(16).padStart(8, '0')}:${length}`;
}
function backupPartFrom(value: unknown, expectedCount: number): BackupPart {
  const part = object(value, ['format', 'version', 'backupId', 'index', 'count', 'digest', 'text']);
  check(part.format === 'peetty-backup-part' && part.version === 1);
  check(Number.isSafeInteger(part.index) && Number.isSafeInteger(part.count));
  const index = part.index as number; const count = part.count as number;
  check(count > 1 && count === expectedCount && index >= 0 && index < count);
  const digest = text(part.digest, 100);
  check(/^crc32:[0-9a-f]{8}:[1-9][0-9]*$/.test(digest));
  const chunk = text(part.text, PROFILE_LIMITS.fileBytes, true);
  check(chunk.length > 0); // A valid exported chunk may consist entirely of whitespace inside a JSON string.
  return { format: 'peetty-backup-part', version: 1, backupId: id(part.backupId), index, count, digest, text: chunk };
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
function sameSavedAuthentication(a: StoredConnection | undefined, b: StoredConnection): boolean {
  if (!a || a.baseUrl !== b.baseUrl || (a.apiKey ?? '') !== (b.apiKey ?? '')) return false;
  const credentials = (connection: StoredConnection) => Object.entries(connection.headers ?? {})
    .filter(([name]) => isCredentialHeader(name, connection.nonCredentialHeaders)).sort(([a], [b]) => a.localeCompare(b));
  const first = credentials(a); const second = credentials(b);
  return first.length === second.length && first.every(([name, value], i) => name === second[i]![0] && value === second[i]![1]);
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
  const record = object(value, ['profile', 'epoch', 'connectionEpoch', 'unresolvedCleanup']);
  const profile = profileFrom(record.profile);
  check(profile.id === expectedId);
  return { profile, epoch: id(record.epoch), ...(record.connectionEpoch !== undefined ? { connectionEpoch: id(record.connectionEpoch) } : {}),
    ...(record.unresolvedCleanup !== undefined ? { unresolvedCleanup: id(record.unresolvedCleanup) } : {}) };
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
function checkBackupSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Backup stopped.', 'AbortError');
}
async function backupTick(signal?: AbortSignal): Promise<void> {
  checkBackupSignal(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkBackupSignal(signal);
}
/** Assemble bounded transport pieces while yielding macrotasks during the scan,
 * rather than waiting for an entire multi-megabyte part before handling Cancel. */
async function* downloadChunks(snapshot: Backup, chunkSize: number, signal?: AbortSignal): AsyncGenerator<string> {
  await backupTick(signal);
  let pending = ''; let batch = 0;
  for (const token of jsonChunks(snapshot, Math.min(chunkSize, 65_536))) {
    checkBackupSignal(signal);
    for (let offset = 0; offset < token.length;) {
      const count = Math.min(chunkSize - pending.length, token.length - offset);
      pending += token.slice(offset, offset + count); offset += count;
      if (pending.length === chunkSize) {
        const last = pending.charCodeAt(pending.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          yield pending.slice(0, -1); pending = pending.slice(-1);
        } else { yield pending; pending = ''; }
      }
    }
    batch += token.length;
    if (batch >= 262_144) { batch = 0; await backupTick(signal); }
  }
  checkBackupSignal(signal);
  if (pending) yield pending;
}

/** Single-use lazy transport; release the snapshot even if canceled before first next(). */
function multipartDownloads(snapshot: Backup, chunkSize: number, fileBytes: number, count: number, digest: string, signal?: AbortSignal): AsyncIterable<BackupDownloadFile> {
  const holder: { snapshot?: Backup } = { snapshot };
  const backupId = freshId();
  const files = (async function* () {
    try {
      checkBackupSignal(signal);
      if (!holder.snapshot) return;
      let index = 0;
      for await (const text of downloadChunks(holder.snapshot, chunkSize, signal)) {
        checkBackupSignal(signal);
        const part: BackupPart = { format: 'peetty-backup-part', version: 1, backupId, index, count, digest, text };
        const serialized = stringify(part);
        check(new TextEncoder().encode(serialized).length <= fileBytes, LIMIT);
        checkBackupSignal(signal);
        index++;
        yield { name: `peetty-backup-${backupId}.part-${String(index).padStart(String(count).length, '0')}-of-${count}.json`, text: serialized,
          ...(index === count ? { final: true } : {}) };
      }
      checkBackupSignal(signal);
      check(index === count, LIMIT);
    } finally { delete holder.snapshot; signal?.removeEventListener('abort', release); }
  })();
  function release() { delete holder.snapshot; void files.return().catch(() => {}); }
  signal?.addEventListener('abort', release, { once: true });
  const iterator: AsyncIterableIterator<BackupDownloadFile> = {
    [Symbol.asyncIterator]() { return this; },
    next: async () => { checkBackupSignal(signal); return files.next(); },
    return: async () => { delete holder.snapshot; signal?.removeEventListener('abort', release); return files.return(); },
    throw: async (error: unknown) => { delete holder.snapshot; signal?.removeEventListener('abort', release); return files.throw(error); },
  };
  return iterator;
}

function sessionFrom(value: unknown): BackupSession {
  const session = object(value, ['profileId', 'connection', 'rememberKey']);
  return { profileId: id(session.profileId), connection: connectionFrom(session.connection), rememberKey: boolean(session.rememberKey) };
}
function backupTokenLimit(path: readonly string[], key: boolean): number {
  // Imported connection strings historically allow the per-file bound. All
  // conversation/figure fields have substantially narrower decoded schema bounds.
  if (path.includes('connection')) return PROFILE_LIMITS.fileBytes;
  if (path.includes('figure')) return 2_000_000;
  if (key) return 200;
  const field = path.at(-1);
  if (field === 'text') return path.includes('memories') ? PROFILE_LIMITS.memoryText : PROFILE_LIMITS.entryText;
  if (field === 'sourceText') return PROFILE_LIMITS.entryText;
  if (field === 'personality') return PROFILE_LIMITS.personality;
  if (field === 'name') return PROFILE_LIMITS.name;
  return 200;
}

const BACKUP_HEADER_LIMIT = PROFILE_LIMITS.fileBytes; // Preserve the existing schema/file ceiling; no new smaller cap.
function figurePath(path: readonly string[]): readonly string[] | undefined {
  return path[0] === 'profiles' && path[1] === '*' && path[2] === 'figure' ? path.slice(3) : undefined;
}
function figureCollectionLimit(path: readonly string[], array: boolean): number {
  const relative = figurePath(path)!;
  const location = relative.join('.');
  if (!array) return location === 'palette' ? FIGURE_LIMITS.maxPaletteEntries : Infinity;
  // Only renderer-independent fields are constrained here. Renderer-specific
  // fields and extensions share the cumulative byte budget, then validateFigure
  // checks the completed figure with its actual renderer and recognized bones.
  if (location === 'viewBox') return 4;
  if (location === 'anchor') return 2;
  if (relative.length === 3 && relative[0] === 'sounds' && relative[1] === 'events') return 8;
  if (relative.length === 5 && relative[0] === 'sounds' && relative[1] === 'events' && relative[3] === '*' && relative[4] === 'notes') return 8;
  return Infinity;
}
function backupObjectFields(path: readonly string[]): readonly string[] | undefined {
  switch (path.join('.')) {
    case '': return ['format', 'version', 'createdAt', 'activeProfileId', 'profiles', 'sessions'];
    case 'profiles.*': return ['id', 'name', 'figure', 'personality', 'useMemories', 'autoRemember', 'memories', 'entries', 'connection', 'createdAt', 'updatedAt'];
    case 'profiles.*.entries.*': return ['id', 'role', 'text', 'createdAt'];
    case 'profiles.*.memories.*': return ['id', 'text', 'createdAt', 'updatedAt', 'sourceEntryId', 'sourceText', 'manual'];
    case 'sessions.*': return ['profileId', 'connection', 'rememberKey'];
    case 'profiles.*.connection': case 'sessions.*.connection': return ['id', 'baseUrl', 'apiKey', 'tools', 'effort', 'provider', 'headers', 'nonCredentialHeaders'];
    case 'profiles.*.connection.headers': case 'sessions.*.connection.headers': return undefined;
    default: return figurePath(path) ? undefined : [];
  }
}
function backupCollectionLimit(path: readonly string[], array: boolean): number {
  if (figurePath(path)) return figureCollectionLimit(path, array);
  const location = path.join('.');
  if (array) {
    switch (location) {
      case 'profiles': return PROFILE_LIMITS.profiles;
      case 'profiles.*.entries': return PROFILE_LIMITS.entries;
      case 'profiles.*.memories': return PROFILE_LIMITS.memories;
      case 'sessions': return PROFILE_LIMITS.fileBytes; // Existing backup schema ceiling.
      case 'profiles.*.connection.nonCredentialHeaders': case 'sessions.*.connection.nonCredentialHeaders': return BACKUP_HEADER_LIMIT;
      default: return -1;
    }
  }
  if (location.endsWith('.connection.headers')) return BACKUP_HEADER_LIMIT;
  const fields = backupObjectFields(path);
  if (fields) return fields.length;
  return 0;
}
function backupAllowedType(path: readonly string[], type: string): boolean {
  if (figurePath(path)) return true; // Figure schema validation owns its supported shapes.
  const location = path.join('.');
  if (location === '' || ['profiles.*', 'profiles.*.entries.*', 'profiles.*.memories.*', 'sessions.*',
    'profiles.*.connection', 'sessions.*.connection', 'profiles.*.connection.headers', 'sessions.*.connection.headers'].includes(location)) return type === 'object';
  if (['profiles', 'profiles.*.entries', 'profiles.*.memories', 'sessions',
    'profiles.*.connection.nonCredentialHeaders', 'sessions.*.connection.nonCredentialHeaders'].includes(location)) return type === 'array';
  if (path.includes('headers') || path.includes('nonCredentialHeaders')) return type === 'string';
  if (['createdAt', 'updatedAt', 'version'].includes(path.at(-1) ?? '')) return type === 'number';
  if (['useMemories', 'autoRemember', 'manual', 'rememberKey', 'tools'].includes(path.at(-1) ?? '')) return type === 'boolean';
  return type === 'string';
}
function validateBackupValue(path: readonly string[], value: unknown): void {
  switch (path.join('.')) {
    case 'profiles.*.figure':
      if (typeof value !== 'string') { try { validateFigure(value); } catch { throw new Error(INVALID); } }
      break;
    case 'profiles.*.entries.*': entryFrom(value); break;
    case 'profiles.*.memories.*': memoryFrom(value); break;
    case 'sessions.*': sessionFrom(value); break;
    case 'profiles.*.connection': case 'sessions.*.connection': connectionFrom(value); break;
    case 'profiles.*': {
      const fields = backupObjectFields(path)!; const profile = object(value, fields);
      id(profile.id); text(profile.name, PROFILE_LIMITS.name); text(profile.personality, PROFILE_LIMITS.personality, true);
      boolean(profile.useMemories); boolean(profile.autoRemember); timestamp(profile.createdAt); timestamp(profile.updatedAt);
      check(Array.isArray(profile.entries) && Array.isArray(profile.memories));
      check(typeof profile.figure === 'string' || profile.figure !== null && typeof profile.figure === 'object');
      break;
    }
  }
}
const BACKUP_PARSE_BOUNDS = {
  collectionLimit: backupCollectionLimit,
  maxBytes: (path: readonly string[]) => figurePath(path)?.length === 0 ? FIGURE_LIMITS.maxBytes : undefined,
  allowedKey: (path: readonly string[], key: string) => backupObjectFields(path)?.includes(key) ?? true,
  allowedType: backupAllowedType,
  validateValue: validateBackupValue,
};
function checkRestore(options?: BackupRestoreOptions): void {
  if (options?.signal?.aborted || options?.current?.() === false) throw new DOMException('Restore stopped.', 'AbortError');
}
function restoreRead<T>(pending: Promise<T>, options: BackupRestoreOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { options.signal?.removeEventListener('abort', cancel); reject(new DOMException('Restore stopped.', 'AbortError')); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    // File.text itself is not abortable. Stop awaiting it and release selection
    // ownership now; late settlement is observed without resuming the import.
    if (options.signal?.aborted) cancel();
    pending.then((value) => { options.signal?.removeEventListener('abort', cancel); resolve(value); },
      (error: unknown) => { options.signal?.removeEventListener('abort', cancel); reject(error); });
  });
}
async function restoreTick(options?: BackupRestoreOptions): Promise<void> {
  checkRestore(options);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkRestore(options);
}
async function restoreDigest(value: string, options?: BackupRestoreOptions): Promise<string> {
  let crc = 0xffffffff;
  for (let offset = 0; offset < value.length; offset += 262_144) {
    checkRestore(options);
    const end = Math.min(offset + 262_144, value.length);
    for (let i = offset; i < end; i++) {
      const code = value.charCodeAt(i);
      crc = CRC_TABLE[(crc ^ code) & 255]! ^ (crc >>> 8);
      crc = CRC_TABLE[(crc ^ (code >>> 8)) & 255]! ^ (crc >>> 8);
    }
    if (options && end < value.length) await restoreTick(options);
  }
  checkRestore(options);
  return `crc32:${((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}:${value.length}`;
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
  private readonly cleanupDebt = new Map<string, CleanupDebt>();
  private connectionReadKnown = false;
  private reconcilingLegacy = false;
  private legacyReconciliation: Promise<void> | undefined;
  private legacyEmpty = false;
  private legacyRevision = 0;
  private legacyCheckedRevision = -1;

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
  private async run<T>(selection: readonly string[] | 'all', write: boolean, action: (draft: Draft) => T, durable: boolean | 'settings' = false, lifetime?: BackupRestoreOptions): Promise<T> {
    checkRestore(lifetime);
    const db = await this.open();
    checkRestore(lifetime);
    if (durable && this.persist && !db) throw new ChatStorageError(durable === 'settings' ? 'settings-save' : 'privacy-delete', durable === 'settings'
      ? 'Could not save memory settings. Restore browser storage and try again.' : 'Could not delete this data. Restore browser storage and try again.');
    let proof = this.legacyProof;
    let draft: Draft | undefined;
    let result!: T;
    let completedAction = false;
    let domainError: unknown;
    const apply = (current: State, isolated = new Set<string>()) => {
      checkRestore(lifetime);
      draft = { directory: { ...current.directory, ids: [...current.directory.ids] }, records: new Map(current.records), dirty: new Set(), isolated,
        isolatedMemories: new Set(isolated), directoryDirty: false, legacyProof: proof, legacyDirty: false };
      result = action(draft);
      completedAction = true;
    };
    if (db) {
      let detachAbort = () => {};
      const ok = await stateTransaction(db, write, (store, abort) => {
          const cancel = () => { abort(); };
          lifetime?.signal?.addEventListener('abort', cancel, { once: true });
          detachAbort = () => lifetime?.signal?.removeEventListener('abort', cancel);
          if (lifetime?.signal?.aborted) { abort(); return; }
          const guard = (callback: () => void) => {
            try { checkRestore(lifetime); callback(); } catch (error) {
              // Domain errors roll back. A failed put/delete after the action retains its draft in memory.
              if (!completedAction) domainError = error;
              abort();
            }
          };
          if (!this.initialized || this.reconcilingLegacy) {
            const proofRequest = store.get('legacyMigration');
            proofRequest.onsuccess = () => { try { proof = legacyProofFrom(proofRequest.result); } catch { proof = undefined; } };
          }
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
      detachAbort();
      if (domainError) throw domainError;
      if (!ok) {
        checkRestore(lifetime);
        this.fail();
        // Privacy deletion cannot publish a RAM-only draft after a failed disk
        // commit. Keep prior archive, source links, barriers and sessions intact.
        if (durable) throw new ChatStorageError(durable === 'settings' ? 'settings-save' : 'privacy-delete', durable === 'settings'
          ? 'Could not save memory settings. Restore browser storage and try again.' : 'Could not delete this data. Restore browser storage and try again.');
      }
    }
    if (!completedAction) apply(this.state);
    this.state = { directory: draft!.directory, records: draft!.records };
    this.legacyProof = draft!.legacyProof;
    if (draft!.dirty.size) this.legacyRevision++;
    for (const profileId of this.sessions.keys()) if (!this.state.records.has(profileId)) this.sessions.delete(profileId);
    return result;
  }

  private ready(): void { check(this.initialized, 'Initialize profile storage first.'); }
  private queued<T>(selection: readonly string[], write: boolean, action: (draft: Draft) => T, privacyMutation = false, durable = false): Promise<T> {
    return this.enqueue(async () => {
      this.ready();
      if (durable && this.persist && this.failed) throw new ChatStorageError('privacy-delete', 'Could not delete this data. Restore browser storage and try again.');
      if (privacyMutation) await this.reconcileLegacy(true, 'history');
      return this.run(selection, write, action, durable);
    });
  }

  /** Read raw legacy records without applying the runtime's history truncation policy. */
  private async legacy(): Promise<LegacyMigration> {
    if (!this.persist || this.failed || this.closed) return { entries: [], used: false };
    // Migration is optional and owns its connection. Its failure must not close
    // healthy profile storage or bypass the authoritative initialization recheck.
    const db = await openStateDatabase(`${this.namespace}:chat`, { isClosed: () => this.closed, onFailure: () => {} }, 'latest');
    // Unreadable legacy data is not evidence of an unused bootstrap profile.
    if (!db) return { entries: [], used: true };
    try {
      let entries: unknown;
      let connection: unknown;
      let epoch: unknown;
      let connectionEpoch: unknown;
      const ok = await stateTransaction(db, false, (store) => {
        const history = store.get('entries');
        history.onsuccess = () => { entries = history.result; };
        const setup = store.get('connection');
        setup.onsuccess = () => { connection = setup.result; };
        const barrier = store.get('entriesEpoch');
        barrier.onsuccess = () => { epoch = barrier.result; };
        const credentialBarrier = store.get('connectionEpoch');
        credentialBarrier.onsuccess = () => { connectionEpoch = credentialBarrier.result; };
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
        check(connectionEpoch === undefined || typeof connectionEpoch === 'string');
        complete = true;
      } catch { /* Leave malformed/partially copied legacy data available for recovery. */ }
      // Invalidation sentinels protect old writers; they are not user data and
      // must not make a fresh destination look like an already-used profile.
      const used = entries !== undefined || connection !== undefined;
      return { entries: salvaged, used, ...(saved ? { connection: saved } : {}),
        ...(complete && used ? { retire: { entries, connection, epoch, connectionEpoch } } : {}) };
    } finally { db.close(); }
  }

  /** Retire only the exact records copied by our successful authoritative write.
   * Read/compare/delete share a legacy transaction, so a concurrent old client wins. */
  private async retireLegacy(snapshot: LegacySnapshot, proof: LegacyProof, mode: LegacyPrivacy = 'automatic', credentials: readonly StoredConnection[] = []): Promise<void> {
    if (!this.persist || this.failed || this.closed) return;
    const knownEntries = new Set(proof.entries); const knownConnections = new Set(proof.connections);
    const original = snapshot.entries === undefined ? undefined : array(snapshot.entries, PROFILE_LIMITS.entries, entryFrom);
    const remainingEntries = original?.filter((entry) => !knownEntries.has(jsonFingerprint(entry)));
    // Background retirement cannot distinguish an unproven active turn. Explicit
    // history/profile deletion instead removes proven copies, preserving all
    // uncopied entries, and deliberately invalidates the old history snapshot.
    const explicitHistory = mode === 'history' || mode === 'profile';
    const changedEntries = original !== undefined && (remainingEntries!.length === 0 || explicitHistory && remainingEntries!.length < original.length);
    const currentConnection = snapshot.connection === undefined ? undefined : connectionFrom(snapshot.connection);
    const sanitized = currentConnection && (mode === 'credentials' || mode === 'profile') ? forgetConnectionCredentials(currentConnection, credentials) : currentConnection;
    const changedCredentials = sanitized !== currentConnection;
    const copiedConnection = currentConnection !== undefined && knownConnections.has(jsonFingerprint(currentConnection));
    // A credential-specific request cannot erase a newer unrelated key merely
    // because some other profile once copied the complete connection record.
    const removeConnection = copiedConnection && (mode !== 'credentials' || changedCredentials && !hasStoredCredentials(sanitized));
    if (!changedEntries && !removeConnection && !changedCredentials) return;
    const db = await openStateDatabase(`${this.namespace}:chat`, { isClosed: () => this.closed, onFailure: () => {} }, 'latest');
    if (!db) {
      if (mode !== 'automatic') throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      return;
    }
    try {
      let matched = false;
      const ok = await stateTransaction(db, true, (store, abort) => {
        const fields = [['entries', 'entries'], ['connection', 'connection'], ['entriesEpoch', 'epoch'], ['connectionEpoch', 'connectionEpoch']] as const;
        const current = {} as LegacySnapshot;
        let remaining = fields.length;
        for (const [recordKey, field] of fields) {
          const request = store.get(recordKey);
          request.onsuccess = () => {
            try {
              current[field] = request.result;
              if (--remaining || !sameLegacyValue(current, snapshot)) return;
              matched = true;
              if (changedEntries) {
                if (remainingEntries!.length) store.put(remainingEntries, 'entries');
                else store.delete('entries');
              }
              if (removeConnection) store.delete('connection');
              else if (changedCredentials) store.put(sanitized, 'connection');
              // A retired history also invalidates a pending first setup save,
              // even when the old client had not stored its connection yet.
              if (changedEntries || removeConnection || changedCredentials) store.put(freshId(), 'connectionEpoch');
              // Any history removal invalidates stale legacy clients, including
              // clients whose original database had no epoch record at all.
              if (changedEntries) store.put(freshId(), 'entriesEpoch');
            } catch { abort(); }
          };
        }
      });
      if ((!ok || !matched) && mode !== 'automatic') throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
    } finally { db.close(); }
  }

  /** Establish proof from actual authoritative correspondence before user deletion,
   * then retry CAS cleanup. Previously copied digests survive clear/key opt-out. */
  private reconcileLegacy(force = false, mode: LegacyPrivacy = 'automatic', credentials: readonly StoredConnection[] = [], unresolvedAuthentication = false): Promise<void> {
    if (this.legacyReconciliation) return mode === 'automatic' ? this.legacyReconciliation : this.legacyReconciliation.then(() => this.reconcileLegacy(force, mode, credentials, unresolvedAuthentication));
    if (!force && this.legacyEmpty && this.legacyCheckedRevision === this.legacyRevision) return Promise.resolve();
    const operation = this.reconcileLegacyNow(mode, credentials, unresolvedAuthentication);
    this.legacyReconciliation = operation;
    return operation.finally(() => { if (this.legacyReconciliation === operation) this.legacyReconciliation = undefined; });
  }

  private async reconcileLegacyNow(mode: LegacyPrivacy, credentials: readonly StoredConnection[], unresolvedAuthentication: boolean): Promise<void> {
    if (!this.persist || this.closed || this.reconcilingLegacy) return;
    this.reconcilingLegacy = true;
    try {
      if (mode === 'credentials' || mode === 'profile') {
        await this.fenceLegacyAuthentication();
        if (this.failed) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      } else if (this.failed) {
        if (mode !== 'automatic' && this.legacyProof?.entries.length) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
        return;
      }
      const legacy = await this.legacy();
      this.legacyEmpty = !legacy.used;
      this.legacyCheckedRevision = this.legacyRevision;
      if (!legacy.retire) {
        if (legacy.used && mode !== 'automatic') throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
        return;
      }
      if ((mode === 'credentials' || mode === 'profile' && unresolvedAuthentication) && legacy.connection && hasStoredCredentials(legacy.connection)
        && (!credentials.some(hasStoredCredentials) || unresolvedAuthentication && hasStoredCredentials(forgetConnectionCredentials(legacy.connection, credentials)))) {
        // Callback-only authentication must not be resolved during setup. If an
        // unknown key already reached disk, require explicit recovery instead of
        // claiming it was removed without any credential-value correspondence.
        throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      }
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
      if (this.failed && mode !== 'automatic') throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      if (!this.failed && (proof || mode === 'credentials' || mode === 'profile' && credentials.some(hasStoredCredentials))) {
        await this.retireLegacy(legacy.retire, proof ?? { version: 1, entries: [], connections: [] }, mode, credentials);
      }
    } finally { this.reconcilingLegacy = false; }
  }

  private async fenceLegacyAuthentication(): Promise<void> {
    const db = await fenceLegacyDatabase(`${this.namespace}:chat`, () => this.closed);
    if (!db) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
    try {
      const epoch = freshId();
      const ok = await stateTransaction(db, true, (store) => { store.put(epoch, 'connectionEpoch'); });
      if (!ok) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
    } finally { db.close(); }
  }

  private async clearDurableCleanup(): Promise<Map<string, string>> {
    const db = await openStateDatabase(`${this.namespace}:profiles`, { isClosed: () => this.closed, onFailure: () => {} });
    check(db, 'Could not remove legacy data. Try again.');
    const epochs = new Map<string, string>();
    try {
      const ok = await stateTransaction(db, true, (store, abort) => {
        const guard = (action: () => void) => { try { action(); } catch { abort(); } };
        const directory = store.get('directory');
        directory.onsuccess = () => guard(() => {
          store.delete('legacyMigration');
          for (const profileId of directoryFrom(directory.result).ids) {
            const request = store.get(key(profileId));
            request.onsuccess = () => guard(() => {
              const record = recordFrom(request.result, profileId);
              if (!record.unresolvedCleanup) return;
              const epoch = freshId();
              const updated = { ...request.result, connectionEpoch: epoch } as RecordState;
              delete updated.unresolvedCleanup;
              store.put(updated, key(profileId));
              epochs.set(profileId, epoch);
            });
          }
        });
      });
      check(ok, 'Could not remove legacy data. Try again.');
      return epochs;
    } finally { db.close(); }
  }

  /** Destructive recovery for unprovable legacy duplicates. Hosts must obtain an
   * explicit user confirmation; automatic reconciliation never calls this method. */
  clearLegacyData(): Promise<void> {
    return this.enqueue(async () => {
      this.ready();
      await this.fenceLegacyAuthentication();
      const clear = async (database: string, keys: readonly string[]) => {
        const db = await openStateDatabase(database, { isClosed: () => this.closed, onFailure: () => {} }, database === `${this.namespace}:chat` ? 'latest' : 1);
        check(db, 'Could not remove legacy data. Try again.');
        try {
          const barrier = freshId();
          const ok = await stateTransaction(db, true, (store) => {
            for (const key of keys) store.delete(key);
            if (database === `${this.namespace}:chat`) {
              store.put(barrier, 'entriesEpoch');
              store.put(freshId(), 'connectionEpoch');
            }
          });
          check(ok, 'Could not remove legacy data. Try again.');
        } finally { db.close(); }
      };
      // Keep provenance until the old records were successfully removed. Partial
      // cross-database failure is reported and a repeated explicit call is safe.
      await clear(`${this.namespace}:chat`, ['entries', 'connection', 'entriesEpoch']);
      const epochs = await this.clearDurableCleanup();
      // Update only private intent metadata: sticky RAM histories and their
      // warning must survive explicit recovery without a hidden disk reload.
      for (const [profileId, epoch] of epochs) {
        const cached = this.state.records.get(profileId);
        if (cached) {
          const updated = { ...cached, connectionEpoch: epoch };
          delete updated.unresolvedCleanup;
          this.state.records.set(profileId, updated);
        }
      }
      this.legacyProof = undefined;
      this.cleanupDebt.clear();
      this.legacyEmpty = true;
      this.legacyCheckedRevision = this.legacyRevision;
    });
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
    const memorySettings = settings.useMemories !== undefined || settings.autoRemember !== undefined;
    return this.enqueue(async () => {
      this.ready();
      return this.run([profileId], true, (draft) => {
      const profile = getRecord(draft, profileId).profile;
      const changed = (Object.keys(settings) as (keyof Settings)[]).some((field) => {
        const value = settings[field];
        return field === 'figure' && typeof value === 'object' && typeof profile.figure === 'object'
          ? JSON.stringify(value) !== JSON.stringify(profile.figure) : value !== profile[field];
      });
      if (changed) Object.assign(touch(draft, profileId).profile, settings);
      }, memorySettings ? 'settings' : false);
    });
  }
  remove(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      this.ready();
      const source = await this.run([profileId], false, (draft) => {
        const record = getRecord(draft, profileId);
        check(draft.directory.ids.length > 1, 'Cannot remove the last profile.');
        return { connection: record.profile.connection, connectionEpoch: record.connectionEpoch ?? '', unresolvedCleanup: record.unresolvedCleanup };
      });
      if (this.persist && this.failed) throw new ChatStorageError('profile-delete', 'Could not delete this profile. Restore browser storage and try again.');
      const pending = this.cleanupDebt.get(profileId);
      const credentials = [...pending?.credentials ?? [], ...(source.connection ? [source.connection] : [])];
      const unresolvedAuthentication = !!source.unresolvedCleanup && pending?.intent !== source.unresolvedCleanup || pending?.unresolvedAuthentication === true;
      await this.reconcileLegacy(true, 'profile', credentials, unresolvedAuthentication);
      let committed: State | undefined;
      const session = this.sessions.get(profileId);
      const removed = await this.run([profileId], true, (draft) => {
        const current = getRecord(draft, profileId);
        if (current.unresolvedCleanup !== source.unresolvedCleanup || (current.connectionEpoch ?? '') !== source.connectionEpoch) return false;
        check(draft.directory.ids.length > 1, 'Cannot remove the last profile.');
        committed = { directory: { ...draft.directory, ids: [...draft.directory.ids] }, records: new Map(draft.records) };
        useBootstrap(draft, profileId);
        draft.directory.ids = draft.directory.ids.filter((value) => value !== profileId);
        if (draft.directory.activeProfileId === profileId) draft.directory.activeProfileId = draft.directory.ids[0]!;
        draft.records.delete(profileId);
        draft.dirty.add(profileId);
        draft.directoryDirty = true;
        return true;
      });
      if (this.persist && this.failed) {
        if (committed) this.state = committed;
        if (session) this.sessions.set(profileId, session);
        throw new ChatStorageError('profile-delete', 'Could not delete this profile. Restore browser storage and try again.');
      }
      if (!removed) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
      this.cleanupDebt.delete(profileId);
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
    // Manager refreshes are shared; authorization belongs to the connection
    // this particular adapter exposed, not to unrelated history/cache activity.
    let observedConnectionEpoch = this.state.records.get(profileId)?.connectionEpoch ?? '';
    let connectionRevision = 0;
    let authoredConnectionEpoch = observedConnectionEpoch;
    const connectionCommitted = (epoch: string) => {
      observedConnectionEpoch = epoch; authoredConnectionEpoch = epoch; connectionRevision++;
    };
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
        if (projection?.observeConnection !== false) observedConnectionEpoch = record.connectionEpoch ?? '';
        return { entries, ...connections };
      }),
      ensureCapacity: (additionalEntries) => this.queued([profileId], false, (draft) => {
        const count = getRecord(draft, profileId).profile.entries.length;
        if (count + additionalEntries > PROFILE_LIMITS.entries) throw new ChatStorageError('capacity', 'Conversation archive is full. Export or remove history before sending.');
      }),
      saveConnection: async (connection, options) => {
        if (closing) return;
        const copy = connectionFrom(connection, false);
        const supplied = options?.credentialsToForget?.map((source) => connectionFrom(source, false)) ?? [];
        // Submission owns this authorization snapshot, even while initialize or
        // another manager operation is ahead of it in the queue.
        const requestEpoch = observedConnectionEpoch;
        const requestRevision = connectionRevision;
        return this.enqueue(async () => {
          this.ready();
          const pending = this.cleanupDebt.get(profileId);
          // Storage failure is sticky for this manager: its RAM archive may
          // contain unsaved turns. Credential retry must never reload over that
          // archive or clear its warning; require a fresh manager after recovery.
          let previous: StoredConnection | undefined;
          let connectionEpoch = connectionRevision > requestRevision ? authoredConnectionEpoch : requestEpoch;
          let unresolvedCleanup: string | undefined;
          let observedEpoch = '';
          try { previous = await this.run([profileId], false, (draft) => {
            const record = getRecord(draft, profileId);
            observedEpoch = record.connectionEpoch ?? '';
            unresolvedCleanup = record.unresolvedCleanup;
            return record.profile.connection;
          }); }
          catch (error) {
            if (pending && error instanceof ChatStorageError && error.code === 'missing-profile') throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
            throw error;
          }
          this.connectionReadKnown = !this.persist || !this.failed;
          if (this.connectionReadKnown) observedConnectionEpoch = observedEpoch;
          const sources = [...pending?.credentials ?? [], ...supplied, ...(previous ? [previous] : []), ...(options?.rememberCredentials === false ? [copy] : [])];
          const unresolvedAuthentication = !!unresolvedCleanup && pending?.intent !== unresolvedCleanup
            || pending?.unresolvedAuthentication === true || options?.unresolvedAuthentication === true;
          // No credential in a failed read's RAM snapshot is not evidence that
          // disk is empty. Session-only setModel remains available during outage.
          if (!this.connectionReadKnown) {
            this.cleanupDebt.set(profileId, { credentials: sources, unresolvedAuthentication, ...(unresolvedCleanup ? { intent: unresolvedCleanup } : {}) });
            throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
          }
          if (observedEpoch !== connectionEpoch) throw new ChatStorageError('stale-connection', 'Connection settings changed. Reload before saving again.');
          const forget = !!pending || unresolvedAuthentication || options?.rememberCredentials === false && (options.authenticationIntent || sources.some(hasStoredCredentials))
            || previous && hasStoredCredentials(previous) && !sameSavedAuthentication(previous, copy);
          if (forget && this.persist) this.cleanupDebt.set(profileId, { credentials: sources, unresolvedAuthentication, ...(unresolvedCleanup ? { intent: unresolvedCleanup } : {}) });
          const newIntent = options?.authenticationIntent === true || options?.unresolvedAuthentication === true || supplied.length > 0
            || options?.rememberCredentials === false && hasStoredCredentials(copy);
          if (this.persist && forget && (!unresolvedCleanup || newIntent)) {
            // Commit only opaque intent before any fencing/legacy cleanup. Lost
            // RAM sources after reload make even a known-source debt unresolved.
            const intent = freshId(); const epoch = freshId();
            const checkpointed = await this.run([profileId], true, (draft) => {
              const record = getRecord(draft, profileId);
              if ((record.connectionEpoch ?? '') !== connectionEpoch) { observedConnectionEpoch = record.connectionEpoch ?? ''; return false; }
              draft.records.set(profileId, { ...record, connectionEpoch: epoch, unresolvedCleanup: intent });
              draft.dirty.add(profileId);
              useBootstrap(draft, profileId);
              return true;
            });
            if (this.failed) throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
            if (!checkpointed) throw new ChatStorageError('stale-connection', 'Connection settings changed. Reload before saving again.');
            unresolvedCleanup = intent; connectionEpoch = epoch;
            this.cleanupDebt.set(profileId, { credentials: sources, unresolvedAuthentication, intent });
            connectionCommitted(epoch);
          }
          await this.reconcileLegacy(true, forget ? 'credentials' : 'automatic', sources, unresolvedAuthentication);
          let baseline = previous;
          const result = await this.run([profileId], true, (draft) => {
            const current = getRecord(draft, profileId);
            if ((current.connectionEpoch ?? '') !== connectionEpoch || current.unresolvedCleanup !== unresolvedCleanup) {
              observedConnectionEpoch = current.connectionEpoch ?? '';
              return { stale: true as const };
            }
            baseline = current.profile.connection;
            const known = this.sessions.get(profileId)?.at(-1)?.connection ?? baseline;
            const saved = prepareSavedConnection(copy, known, options?.rememberCredentials);
            const record = touch(draft, profileId);
            record.profile.connection = saved;
            if (options?.rememberCredentials === false || unresolvedCleanup || !sameSavedAuthentication(baseline, saved)) record.connectionEpoch = freshId();
            delete record.unresolvedCleanup;
            return { stale: false as const, saved: clone(saved) };
          });
          // Even rejection adopts the authoritative read for a fresh explicit
          // retry; the rejected request itself is never replayed or reauthorized.
          if (result.stale) throw new ChatStorageError('stale-connection', 'Connection settings changed. Reload before saving again.');
          const saved = result.saved;
          if (forget && this.persist && this.failed) {
            const record = this.state.records.get(profileId);
            if (record) {
              record.profile = { ...record.profile };
              if (baseline) record.profile.connection = clone(baseline);
              else delete record.profile.connection;
              if (unresolvedCleanup) record.unresolvedCleanup = unresolvedCleanup;
              else delete record.unresolvedCleanup;
              if (connectionEpoch) record.connectionEpoch = connectionEpoch;
              else delete record.connectionEpoch;
            }
            throw new ChatStorageError('legacy-cleanup', 'Could not forget legacy authentication. Close other tabs and try again.');
          }
          if (!this.persist || !this.failed) connectionCommitted(this.state.records.get(profileId)?.connectionEpoch ?? '');
          this.cleanupDebt.delete(profileId);
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
          if (this.persist && this.failed) throw new ChatStorageError('privacy-delete', 'Could not delete this data. Restore browser storage and try again.');
          await this.reconcileLegacy(true, 'history');
          const clearedEpoch = await this.run([profileId], true, (draft) => {
            const record = touchMemories(draft, profileId);
            detachSources(record.profile, record.profile.entries);
            record.profile.entries = [];
            record.epoch = freshId();
            return record.epoch;
          }, true);
          epoch = clearedEpoch;
          snapshot = [];
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
    }, false, true);
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
    }, true);
  }
  removeEntry(profileId: string, entryId: string): Promise<void> {
    return this.queued([profileId], true, (draft) => {
      const record = touchMemories(draft, profileId);
      const entry = record.profile.entries.find((entry) => entry.id === entryId);
      check(entry, MISSING);
      detachSources(record.profile, [entry]);
      record.profile.entries = record.profile.entries.filter((value) => value.id !== entryId);
    }, true, true);
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

  async backupDownload(options?: BackupDownloadOptions): Promise<string | AsyncIterable<BackupDownloadFile>> {
    const fileBytes = options?._testing?.fileBytes ?? PROFILE_LIMITS.fileBytes;
    check(Number.isSafeInteger(fileBytes) && fileBytes >= 1_024 && fileBytes <= PROFILE_LIMITS.fileBytes);
    const signal = options?.signal;
    checkBackupSignal(signal);
    const backup = await this.backupSnapshot(options, signal);
    checkBackupSignal(signal);
    // Only individual metadata/string tokens and bounded transport chunks are
    // serialized. A profile archive can exceed the engine's maximum string length.
    const chunkSize = Math.floor((fileBytes - 512) / 6);
    let bytes = 0; let count = 0; let crc = 0xffffffff; let length = 0;
    let small: string[] = [];
    for await (const chunk of downloadChunks(backup, chunkSize, signal)) {
      count++; bytes += new TextEncoder().encode(chunk).length; length += chunk.length;
      if (bytes <= fileBytes) small.push(chunk);
      else if (small.length) small = [];
      for (let offset = 0; offset < chunk.length; offset += 65_536) {
        checkBackupSignal(signal);
        const end = Math.min(offset + 65_536, chunk.length);
        for (let i = offset; i < end; i++) {
          const code = chunk.charCodeAt(i);
          crc = CRC_TABLE[(crc ^ code) & 255]! ^ (crc >>> 8);
          crc = CRC_TABLE[(crc ^ (code >>> 8)) & 255]! ^ (crc >>> 8);
        }
        if (offset && offset % 262_144 === 0) await backupTick(signal);
      }
    }
    checkBackupSignal(signal);
    const digest = `crc32:${((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}:${length}`;
    if (bytes <= fileBytes) return small.join(''); // Proven bounded single-file path only.
    return multipartDownloads(backup, chunkSize, fileBytes, count, digest, signal);
  }

  private async backupSnapshot(options?: Partial<BackupOptions>, signal?: AbortSignal): Promise<Backup> {
    checkBackupSignal(signal);
    const supplied = options?.sessions?.map(sessionFrom) ?? [];
    const portableConnection = (connection: StoredConnection) => {
      const validated = connectionFrom(connection);
      return options?.omitCredentials ? prepareSavedConnection(validated, undefined, false) : validated;
    };
    return this.enqueue(async () => {
      this.ready();
      checkBackupSignal(signal);
      return this.run('all', false, (draft) => {
        checkBackupSignal(signal);
        const profiles = draft.directory.ids.map((profileId) => {
          // Histories and memories are already validated; serialization needs no second deep copy.
          const profile = { ...getRecord(draft, profileId).profile };
          if (profile.connection) profile.connection = portableConnection(profile.connection);
          return profile;
        });
        const byProfile = new Map<string, Map<string, StoredSessionConnection>>();
        for (const profileId of draft.directory.ids) {
          const sessions = new Map<string, StoredSessionConnection>();
          for (const session of this.sessions.get(profileId) ?? []) addSession(sessions, {
            connection: portableConnection(session.connection), rememberKey: options?.omitCredentials ? false : boolean(session.rememberKey),
          });
          byProfile.set(profileId, sessions);
        }
        // Credential callbacks may have resolved while another tab deleted their profile.
        for (const session of supplied) {
          const sessions = byProfile.get(session.profileId);
          if (sessions) addSession(sessions, options?.omitCredentials ? { connection: portableConnection(session.connection), rememberKey: false } : session);
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

  /** Read files sequentially twice. Retain only file handles and envelope/checksum
   * metadata between passes; never collect serialized parts into a source array. */
  async restoreFileSelection(files: ArrayLike<BackupRestoreFile>, options?: BackupRestoreOptions): Promise<void> {
    const lifetime: BackupRestoreOptions = { ...(options?.signal ? { signal: options.signal } : {}),
      current: () => !this.closing && !this.closed && (options?.current?.() ?? true) };
    checkRestore(lifetime);
    check(files != null && Number.isSafeInteger(files.length) && files.length > 0);
    const references = Array.from(files);
    type PartMetadata = Omit<BackupPart, 'text'> & { checksum: string; file: BackupRestoreFile };
    const metadata: PartMetadata[] = [];
    const read = async (file: BackupRestoreFile): Promise<unknown> => {
      checkRestore(lifetime);
      try {
        const source = await restoreRead(file.text(), lifetime);
        checkRestore(lifetime);
        return parseJSON(source);
      } catch (error) {
        checkRestore(lifetime);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error(INVALID);
      }
    };
    try {
      for (const file of references) check(file && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= PROFILE_LIMITS.fileBytes && typeof file.text === 'function');
      if (references.length === 1) {
        const value = await read(references[0]!);
        checkRestore(lifetime);
        // A lone multipart envelope still fails through normal schema validation.
        return await this.restoreBackup(backupFrom(value), lifetime);
      }
      let identity: Pick<BackupPart, 'backupId' | 'count' | 'digest'> | undefined;
      const indices = new Set<number>();
      for (const file of references) {
        checkRestore(lifetime);
        const part = backupPartFrom(await read(file), references.length);
        identity ??= { backupId: part.backupId, count: part.count, digest: part.digest };
        check(part.backupId === identity.backupId && part.digest === identity.digest && part.count === identity.count && !indices.has(part.index));
        indices.add(part.index);
        const checksum = await restoreDigest(part.text, lifetime);
        metadata.push({ format: part.format, version: part.version, backupId: part.backupId, index: part.index, count: part.count,
          digest: part.digest, checksum, file });
      }
      metadata.sort((a, b) => a.index - b.index);
      checkRestore(lifetime);
      check(combineBackupDigests(metadata.map((part) => part.checksum)) === identity!.digest);
      await restoreTick(lifetime);
      async function* chunks() {
        for (const expected of metadata) {
          checkRestore(lifetime);
          const part = backupPartFrom(await read(expected.file), references.length);
          check(part.backupId === expected.backupId && part.index === expected.index && part.count === expected.count && part.digest === expected.digest);
          check(await restoreDigest(part.text, lifetime) === expected.checksum);
          checkRestore(lifetime);
          yield part.text;
        }
      }
      const value = await parseJSONChunksAsync(chunks(), backupTokenLimit, undefined, { ...BACKUP_PARSE_BOUNDS, check: () => checkRestore(lifetime) });
      await restoreTick(lifetime);
      return await this.restoreBackup(backupFrom(value), lifetime);
    } finally {
      references.length = 0; metadata.length = 0;
    }
  }

  async restoreFiles(texts: readonly string[]): Promise<void> {
    check(Array.isArray(texts) && texts.length > 0);
    // Each input retains the original file ceiling. Only a complete, consistent
    // multipart envelope can authorize parsing a larger reconstructed document.
    const values = Array.from(texts, parseJSON);
    let value: unknown = values[0];
    if (values.length > 1 || (value && typeof value === 'object' && 'format' in value && value.format === 'peetty-backup-part')) {
      const parts = values.map((item) => backupPartFrom(item, values.length));
      const first = parts[0]!;
      check(parts.every((part) => part.backupId === first.backupId && part.count === first.count && part.digest === first.digest));
      check(new Set(parts.map((part) => part.index)).size === parts.length);
      const chunks = parts.sort((a, b) => a.index - b.index).map((part) => part.text);
      check(backupDigest(chunks) === first.digest);
      value = parseJSONChunks(chunks, backupTokenLimit, undefined, BACKUP_PARSE_BOUNDS);
    } else check(values.length === 1);
    // Validate EVERY reconstructed profile and session before enqueueing a mutation.
    return this.restoreBackup(backupFrom(value));
  }

  private restoreBackup(backup: Backup, lifetime?: BackupRestoreOptions): Promise<void> {
    checkRestore(lifetime);
    // Backup files carry credential values, never trusted SDK header classification.
    for (const profile of backup.profiles) if (profile.connection) delete profile.connection.nonCredentialHeaders;
    for (const session of backup.sessions ?? []) delete session.connection.nonCredentialHeaders;
    checkRestore(lifetime);
    return this.enqueue(async () => {
      checkRestore(lifetime);
      this.ready();
      const sessions = await this.run('all', true, (draft) => {
        checkRestore(lifetime);
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
        checkRestore(lifetime);
        draft.directoryDirty = true;
        return new Map(Array.from(sessions, ([profileId, values]) => [profileId, Array.from(values.values())]));
      }, false, lifetime);
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
  async importMemories(profileId: string, value: string, lifetime?: BackupRestoreOptions): Promise<void> {
    checkRestore(lifetime);
    const document = object(parseJSON(value), ['format', 'version', 'memories']);
    check(document.format === 'peetty-memories' && document.version === 1);
    const incoming = unique(array(document.memories, PROFILE_LIMITS.memories, memoryFrom)).map((memory) => ({ memory, normalized: normalizedText(memory.text) }));
    checkRestore(lifetime);
    return this.enqueue(async () => {
      this.ready(); checkRestore(lifetime);
      return this.run([profileId], true, (draft) => {
        checkRestore(lifetime);
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
        checkRestore(lifetime);
      }, false, lifetime);
    });
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.queue.then(() => { this.closed = true; this.sessions.clear(); this.db?.close(); this.db = undefined; });
  }
}
