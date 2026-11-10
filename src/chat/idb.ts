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
    const timer = setTimeout(abort, 2_000);
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
}

/** One uncached handshake for the version-one browser state databases. */
export function openStateDatabase(name: string, owner: DatabaseOwner): Promise<IDBDatabase | undefined> {
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
    const timer = setTimeout(() => finish(), 2_000);
    try {
      const request = globalThis.indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); owner.onFailure(); };
        finish(database);
      };
      request.onerror = request.onblocked = () => finish();
    } catch { finish(); }
  });
}
