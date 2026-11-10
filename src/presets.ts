import amara from '../figures/amara.json' with { type: 'json' };
import elsie from '../figures/elsie.json' with { type: 'json' };
import koharu from '../figures/koharu.json' with { type: 'json' };
import miru from '../figures/miru.json' with { type: 'json' };
import riley from '../figures/riley.json' with { type: 'json' };
import xiaoxiao from '../figures/xiaoxiao.json' with { type: 'json' };
import { CATALOG_FORMAT, FIGURE_CATALOG, type PresetId } from './catalog.ts';
import type { Figure, LocalizedText } from './figure/types.ts';
import { FIGURE_ID, validateFigure } from './figure/validate.ts';
import { resolveSoundSources } from './figure/sources.ts';

export { FIGURE_CATALOG, PRESET_IDS, type PresetId } from './catalog.ts';

/** The figures bundled into the SDK, by id; the type check keeps them in step with PRESET_IDS. */
export const PRESETS = { miru, koharu, xiaoxiao, riley, amara, elsie } satisfies Record<PresetId, object> as unknown as Record<PresetId, Figure>;

export interface CatalogEntry {
  id: string;
  name: LocalizedText;
  description?: LocalizedText;
  author: string;
  license: string;
  renderer: 'rig' | 'sprite';
  /** Bundled into the SDK, so it loads without a request. */
  bundled: boolean;
  url: string;
}

export const FIGURE_LOAD_TIMEOUT = 20_000;

async function fetchJson(input: string, base: string, signal?: AbortSignal): Promise<{ data: unknown; url: string }> {
  // The base itself may be relative, e.g. a self-hosted catalog at '/figures/'.
  const url = new URL(input, new URL(base, document.baseURI));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Figure URLs must use https: or http:.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Figure loading timed out.', 'TimeoutError')), FIGURE_LOAD_TIMEOUT);
  let interrupted!: () => void;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        interrupted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', interrupted, { once: true });
        if (controller.signal.aborted) interrupted();
      }),
      (async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
        const data: unknown = await response.json();
        controller.signal.throwIfAborted();
        return { data, url: response.url || url.href };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', interrupted);
  }
}

/**
 * Resolves a figure option:
 * - a bundled preset id (`miru`), used directly;
 * - any other catalog id (`shiori`), loaded from {@link FIGURE_CATALOG};
 * - a URL or relative path to a figure JSON file;
 * - figure data.
 * Everything loaded is validated before use.
 */
export async function resolveFigure(input: string | object = 'miru', catalog = FIGURE_CATALOG, signal?: AbortSignal): Promise<Figure> {
  signal?.throwIfAborted();
  if (typeof input === 'object') return resolveSoundSources(validateFigure(input), globalThis.document?.baseURI);
  if (Object.hasOwn(PRESETS, input)) return PRESETS[input as PresetId];
  const loaded = FIGURE_ID.test(input) ? await fetchJson(`${input}.json`, catalog, signal) : await fetchJson(input, document.baseURI, signal);
  return resolveSoundSources(validateFigure(loaded.data), loaded.url);
}

/** Lists the figures in a catalog, e.g. for a character picker. */
export async function listFigures(catalog = FIGURE_CATALOG): Promise<CatalogEntry[]> {
  const { data, url } = await fetchJson('index.json', catalog) as { data: { format?: unknown; figures?: unknown }; url: string };
  if (data?.format !== CATALOG_FORMAT || !Array.isArray(data.figures)) throw new Error('Not a Peetty figure catalog.');
  const entries = data.figures.filter((e): e is CatalogEntry =>
    !!e && typeof e === 'object' && typeof e.id === 'string' && FIGURE_ID.test(e.id) && typeof e.url === 'string');
  const resolved: CatalogEntry[] = [];
  for (const entry of entries) {
    try {
      const reference = entry.url.trim();
      if (!reference || reference.startsWith('#')) continue;
      const address = new URL(reference, url);
      if (address.protocol === 'https:' || address.protocol === 'http:') resolved.push({ ...entry, url: address.href });
    } catch { /* Invalid catalog destinations are omitted. */ }
  }
  return resolved;
}
