import type { PeettyModelOptions, PeettyReasoningEffort } from './types.ts';
import type { StoredConnection } from './store.ts';

export function isReasoningEffort(value: unknown): value is PeettyReasoningEffort {
  return typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

/** Accept an API base or recover it from a completions/models URL, preserving root APIs. */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid API base URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS API base URL without credentials or a query.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '');
  return `${url.origin}${path}`;
}

/** Validate before replacing a connection, with errors that never echo supplied credentials. */
export function normalizeModelOptions(model: PeettyModelOptions): PeettyModelOptions {
  try {
    const id = model.id.trim();
    if (!id || id.length > 200 || /[\r\n]/.test(id)) throw new Error();
    if (model.provider !== undefined && (typeof model.provider !== 'string' || model.provider.length > 200)) throw new Error();
    if (model.apiKey !== undefined && typeof model.apiKey !== 'string') throw new Error();
    if (model.getApiKey !== undefined && typeof model.getApiKey !== 'function') throw new Error();
    if (model.tools !== undefined && typeof model.tools !== 'boolean') throw new Error();
    if (model.effort !== undefined && !isReasoningEffort(model.effort)) throw new Error();
    let headers: Record<string, string> | undefined;
    const suppliedHeaders = model.headers;
    if (suppliedHeaders !== undefined) {
      if (Object.prototype.toString.call(suppliedHeaders) !== '[object Object]') throw new Error();
      const normalized = new Headers();
      for (const [name, value] of Object.entries(suppliedHeaders)) {
        if (typeof value !== 'string') throw new Error();
        normalized.set(name, value);
      }
      headers = Object.fromEntries(normalized.entries());
    }
    return {
      id, baseUrl: normalizeBaseUrl(model.baseUrl),
      ...(model.provider?.trim() ? { provider: model.provider.trim() } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey.trim() } : {}),
      ...(model.getApiKey ? { getApiKey: model.getApiKey } : {}),
      ...(headers ? { headers } : {}),
      ...(model.tools !== undefined ? { tools: model.tools } : {}),
      ...(model.effort !== undefined ? { effort: model.effort } : {}),
    };
  } catch { throw new Error('Enter a valid API base URL and model ID.'); }
}

/** Authentication headers follow the same device-lifetime choice as an API key. */
export function isCredentialHeader(name: string): boolean {
  return /authorization|api[-_]?key|subscription[-_]?key|token|secret/i.test(name);
}

/** Keep only headers already owned by this endpoint, including unchanged subsets after key rotation. */
export function retainedConnectionHeaders(
  chosen: { baseUrl: string; headers?: Record<string, string> },
  known?: { baseUrl: string; headers?: Record<string, string> },
  rememberCredentials = true,
): Record<string, string> | undefined {
  if (!chosen.headers || !known?.headers) return;
  try {
    if (normalizeBaseUrl(chosen.baseUrl) !== normalizeBaseUrl(known.baseUrl)) return;
    const previous = new Headers(known.headers);
    const kept = [...new Headers(chosen.headers)].filter(([name, value]) =>
      previous.has(name) && previous.get(name) === value && (rememberCredentials || !isCredentialHeader(name)));
    return kept.length ? Object.fromEntries(kept) : undefined;
  } catch { return; }
}

/** Project validated model options; the caller explicitly chooses which key may be serialized. */
export function toStoredConnection(model: PeettyModelOptions, apiKey: string | undefined): StoredConnection {
  return {
    id: model.id, baseUrl: model.baseUrl,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.tools !== undefined ? { tools: model.tools } : {}),
    ...(model.effort !== undefined ? { effort: model.effort } : {}),
  };
}

/** Apply the same device-lifetime and restored-header policy at both storage boundaries. */
export function prepareSavedConnection(
  chosen: StoredConnection, known?: StoredConnection, rememberCredentials = true,
): StoredConnection {
  const saved = { ...chosen };
  const headers = retainedConnectionHeaders(chosen, known, rememberCredentials);
  if (headers) saved.headers = headers;
  else delete saved.headers;
  if (!rememberCredentials) delete saved.apiKey;
  return saved;
}

function connectionFields(model: PeettyModelOptions) {
  return [model.id.trim(), normalizeBaseUrl(model.baseUrl), model.provider?.trim() || '', model.apiKey?.trim() || '',
    model.tools !== false, model.effort, JSON.stringify([...new Headers(model.headers)])] as const;
}

/** Canonical transport identity shared by session deduplication and override detection. */
export function connectionIdentity(model: PeettyModelOptions): string {
  return JSON.stringify(connectionFields(model));
}

/** Compare effective values without serializing keys or confusing callbacks with saved credentials. */
export function sameConnection(a?: PeettyModelOptions, b?: PeettyModelOptions): boolean {
  if (!a || !b || a.getApiKey || b.getApiKey) return false;
  try {
    const first = connectionFields(a); const second = connectionFields(b);
    return first.every((value, i) => value === second[i]);
  } catch { return false; }
}

export function hasStoredCredentials(connection?: PeettyModelOptions): boolean {
  return !!connection?.apiKey || Object.entries(connection?.headers ?? {}).some(([name, value]) => isCredentialHeader(name) && !!value.trim());
}

/** Magpie's default gateway on the device running the browser. Supply your own model ID and gateway key. */
export const LOCAL_MAGPIE = Object.freeze({ baseUrl: 'http://127.0.0.1:3425/v1' });

/** Reuse credentials only when already configured for this exact local gateway. */
export function localMagpieConnection(current?: PeettyModelOptions): PeettyModelOptions {
  if (current?.baseUrl.replace(/\/+$/, '') !== LOCAL_MAGPIE.baseUrl) return { ...LOCAL_MAGPIE, id: '' };
  return { ...current, ...LOCAL_MAGPIE, ...(current.headers ? { headers: { ...current.headers } } : {}) };
}
