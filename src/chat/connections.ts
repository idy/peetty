import type { PeettyModelOptions } from './types.ts';

/** Magpie's default gateway on the device running the browser. Supply your own model ID and gateway key. */
export const LOCAL_MAGPIE = Object.freeze({ baseUrl: 'http://127.0.0.1:3425/v1' });

/** Reuse credentials only when already configured for this exact local gateway. */
export function localMagpieConnection(current?: PeettyModelOptions): PeettyModelOptions {
  if (current?.baseUrl.replace(/\/+$/, '') !== LOCAL_MAGPIE.baseUrl) return { ...LOCAL_MAGPIE, id: '' };
  return { ...current, ...LOCAL_MAGPIE, ...(current.headers ? { headers: { ...current.headers } } : {}) };
}
