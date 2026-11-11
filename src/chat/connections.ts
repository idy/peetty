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
    const nonCredentialHeaders = normalizeNonCredentialHeaders(model.nonCredentialHeaders, headers);
    return {
      id, baseUrl: normalizeBaseUrl(model.baseUrl),
      ...(model.provider?.trim() ? { provider: model.provider.trim() } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey.trim() } : {}),
      ...(model.getApiKey ? { getApiKey: model.getApiKey } : {}),
      ...(headers ? { headers } : {}),
      ...(nonCredentialHeaders?.length ? { nonCredentialHeaders } : {}),
      ...(model.tools !== undefined ? { tools: model.tools } : {}),
      ...(model.effort !== undefined ? { effort: model.effort } : {}),
    };
  } catch { throw new Error('Enter a valid API base URL and model ID.'); }
}

/** Only documented request metadata may outlive authentication consent. Unknown headers
 * can carry credentials under arbitrary names and therefore default to sensitive. */
const NONCREDENTIAL_HEADERS = new Set([
  'accept', 'content-type',
  'openai-organization', 'openai-project', 'openai-beta',
  'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'http-referer', 'x-title', // OpenRouter application attribution.
]);
// Authentication names remain sensitive even if a caller attempts to classify them otherwise.
const AUTHENTICATION_HEADER = /(?:^|[-_])(?:auth(?:entication|orization)?|tokens?|secrets?|cookies?|passwords?|credentials?|subscription|(?:api|access|subscription)[-_]?(?:key|token))(?:$|[-_])|^(?:x[-_])?key$/i;

function normalizeNonCredentialHeaders(value: unknown, headers?: Record<string, string>): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error();
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string') throw new Error();
    // Headers validates HTTP token syntax and canonicalizes case without accepting whitespace.
    const normalized = [...new Headers([[name, '']]).keys()][0]!;
    if (!Object.hasOwn(headers ?? {}, normalized) || AUTHENTICATION_HEADER.test(normalized)) throw new Error();
    names.add(normalized);
  }
  return [...names].sort();
}

export function isCredentialHeader(name: string, nonCredentialHeaders: readonly string[] = []): boolean {
  const normalized = name.trim().toLowerCase();
  return AUTHENTICATION_HEADER.test(normalized) ||
    !NONCREDENTIAL_HEADERS.has(normalized) && !nonCredentialHeaders.some(value => value.toLowerCase() === normalized);
}

type HeaderConnection = Pick<StoredConnection, 'baseUrl' | 'headers' | 'nonCredentialHeaders'>;

/** Explicit nonsecret classifications opt those headers into storage. Other headers must
 * already belong to this endpoint; unclassified values still follow authentication consent. */
export function retainedConnectionHeaders(
  chosen: HeaderConnection,
  known?: HeaderConnection,
  rememberCredentials = true,
): Record<string, string> | undefined {
  if (!chosen.headers) return;
  try {
    const explicit = normalizeNonCredentialHeaders(chosen.nonCredentialHeaders, Object.fromEntries(new Headers(chosen.headers))) ?? [];
    const previous = new Headers(known && normalizeBaseUrl(chosen.baseUrl) === normalizeBaseUrl(known.baseUrl) ? known.headers : undefined);
    const kept = [...new Headers(chosen.headers)].filter(([name, value]) =>
      explicit.includes(name) || previous.has(name) && previous.get(name) === value && (rememberCredentials || !isCredentialHeader(name, explicit)));
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
    ...(model.nonCredentialHeaders ? { nonCredentialHeaders: [...model.nonCredentialHeaders] } : {}),
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
  const nonCredentialHeaders = normalizeNonCredentialHeaders(chosen.nonCredentialHeaders, Object.fromEntries(new Headers(chosen.headers)))?.filter(name => Object.hasOwn(headers ?? {}, name));
  if (nonCredentialHeaders?.length) saved.nonCredentialHeaders = nonCredentialHeaders;
  else delete saved.nonCredentialHeaders;
  if (!rememberCredentials) delete saved.apiKey;
  return saved;
}

function connectionFields(model: PeettyModelOptions) {
  return [model.id.trim(), normalizeBaseUrl(model.baseUrl), model.provider?.trim() || '', model.apiKey?.trim() || '',
    model.tools !== false, model.effort, JSON.stringify([...new Headers(model.headers)]),
    JSON.stringify(normalizeNonCredentialHeaders(model.nonCredentialHeaders, Object.fromEntries(new Headers(model.headers))) ?? [])] as const;
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
  return !!connection?.apiKey || Object.entries(connection?.headers ?? {}).some(([name, value]) => isCredentialHeader(name, connection?.nonCredentialHeaders) && !!value.trim());
}

/** Magpie's default gateway on the device running the browser. Supply your own model ID and gateway key. */
export const LOCAL_MAGPIE = Object.freeze({ baseUrl: 'http://127.0.0.1:3425/v1' });

/** Reuse credentials only when already configured for this exact local gateway. */
export function localMagpieConnection(current?: PeettyModelOptions): PeettyModelOptions {
  if (current?.baseUrl.replace(/\/+$/, '') !== LOCAL_MAGPIE.baseUrl) return { ...LOCAL_MAGPIE, id: '' };
  return { ...current, ...LOCAL_MAGPIE,
    ...(current.headers ? { headers: { ...current.headers } } : {}),
    ...(current.nonCredentialHeaders ? { nonCredentialHeaders: [...current.nonCredentialHeaders] } : {}),
  };
}
