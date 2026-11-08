import type { PeettyModelOptions } from './types.ts';

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
    if (model.apiKey !== undefined && typeof model.apiKey !== 'string') throw new Error();
    if (model.getApiKey !== undefined && typeof model.getApiKey !== 'function') throw new Error();
    return {
      id, baseUrl: normalizeBaseUrl(model.baseUrl),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey.trim() } : {}),
      ...(model.getApiKey ? { getApiKey: model.getApiKey } : {}),
      ...(model.headers ? { headers: { ...model.headers } } : {}),
    };
  } catch { throw new Error('Enter a valid API base URL and model ID.'); }
}

/** Magpie's default gateway on the device running the browser. Supply your own model ID and gateway key. */
export const LOCAL_MAGPIE = Object.freeze({ baseUrl: 'http://127.0.0.1:3425/v1' });

/** Reuse credentials only when already configured for this exact local gateway. */
export function localMagpieConnection(current?: PeettyModelOptions): PeettyModelOptions {
  if (current?.baseUrl.replace(/\/+$/, '') !== LOCAL_MAGPIE.baseUrl) return { ...LOCAL_MAGPIE, id: '' };
  return { ...current, ...LOCAL_MAGPIE, ...(current.headers ? { headers: { ...current.headers } } : {}) };
}
