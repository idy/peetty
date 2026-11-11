/** Opens have no record-size cost, but may wait for the browser's storage process. */
export const IDB_OPEN_TIMEOUT_MS = 30_000;
/** Full profile records can contain 100,000 entries or a 50 MiB import. Allow
 * structured cloning and disk commits on slower devices, while bounding stalls. */
export const IDB_TRANSACTION_TIMEOUT_MS = 120_000;

/** Settle one transaction once, including timeouts and synchronous setup failures.
 * Callers retain ownership of domain errors and their RAM fallback policy. */
export function stateTransaction(database: IDBDatabase, write: boolean,
  action: (store: IDBObjectStore, abort: () => void) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    const abort = () => { try { transaction?.abort(); } catch { /* Already complete. */ } finish(false); };
    const timer = setTimeout(abort, IDB_TRANSACTION_TIMEOUT_MS);
    try {
      transaction = database.transaction('state', write ? 'readwrite' : 'readonly');
      transaction.oncomplete = () => finish(true);
      transaction.onerror = transaction.onabort = () => finish(false);
      action(transaction.objectStore('state'), abort);
    } catch { abort(); }
  });
}

interface DatabaseOwner {
  isClosed: () => boolean;
  onFailure: () => void;
  /** Some owners publish their cache before the open promise resolves. */
  onReady?: (database: IDBDatabase) => void;
  /** Updated legacy adapters reopen the latest version without degrading to RAM. */
  onVersionChange?: () => void;
  onOpenError?: (error: DOMException | null) => void;
}

/** Profile databases stay at v1. Legacy adapters can discover the current
 * version, and destructive credential cleanup can fence obsolete v1 adapters. */
export function openStateDatabase(name: string, owner: DatabaseOwner, version: number | 'latest' = 1, timeoutMs = IDB_OPEN_TIMEOUT_MS): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (database?: IDBDatabase) => {
      if (settled) { database?.close(); return; }
      settled = true;
      clearTimeout(timer);
      if (owner.isClosed()) { database?.close(); resolve(undefined); return; }
      if (database) owner.onReady?.(database);
      else owner.onFailure();
      resolve(database);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      const request = version === 'latest' ? globalThis.indexedDB.open(name) : globalThis.indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        if (settled || owner.isClosed()) {
          try { request.transaction?.abort(); } catch { /* Already aborted. */ }
          request.result.close();
          return;
        }
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); (owner.onVersionChange ?? owner.onFailure)(); };
        finish(database);
      };
      request.onerror = () => { if (!settled) owner.onOpenError?.(request.error ?? null); finish(); };
      request.onblocked = () => finish();
    } catch { finish(); }
  });
}

/** Fence deployed v1 adapters once, without deleting any records. Upgrade success
 * means old connections closed and all their queued transactions drained. A late
 * upgrade after blocked/timeout rejection is aborted by openStateDatabase. */
export async function fenceLegacyDatabase(name: string, isClosed: () => boolean): Promise<IDBDatabase | undefined> {
  const deadline = Date.now() + IDB_OPEN_TIMEOUT_MS;
  let versionRace = false;
  const open = (version: number | 'latest') => openStateDatabase(name, {
    isClosed, onFailure: () => {}, onOpenError: (error) => { versionRace = error?.name === 'VersionError'; },
  }, version, Math.max(1, deadline - Date.now()));
  const current = await open('latest');
  if (!current) return;
  if (current.version >= 2) return current;
  current.close();
  const upgraded = await open(2);
  if (upgraded || !versionRace || isClosed() || Date.now() >= deadline) return upgraded;
  // Another fence may have upgraded beyond the requested version while our
  // versioned open was queued. Discover it once within the same finite deadline.
  const latest = await open('latest');
  if (latest && latest.version >= 2) return latest;
  latest?.close();
  return undefined;
}
