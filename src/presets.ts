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

async function fetchJson(input: string, base: string): Promise<{ data: unknown; url: string }> {
  // The base itself may be relative, e.g. a self-hosted catalog at '/figures/'.
  const url = new URL(input, new URL(base, document.baseURI));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Figure URLs must use https: or http:.');
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
  return { data: await response.json(), url: response.url || url.href };
}

/**
 * Resolves a figure option:
 * - a bundled preset id (`miru`), used directly;
 * - any other catalog id (`xiaoxiao`), loaded from {@link FIGURE_CATALOG};
 * - a URL or relative path to a figure JSON file;
 * - figure data.
 * Everything loaded is validated before use.
 */
export async function resolveFigure(input: string | object = 'miru', catalog = FIGURE_CATALOG): Promise<Figure> {
  if (typeof input === 'object') return resolveSoundSources(validateFigure(input), globalThis.document?.baseURI);
  if (Object.hasOwn(PRESETS, input)) return PRESETS[input as PresetId];
  const loaded = FIGURE_ID.test(input) ? await fetchJson(`${input}.json`, catalog) : await fetchJson(input, document.baseURI);
  return resolveSoundSources(validateFigure(loaded.data), loaded.url);
}

/** Lists the figures in a catalog, e.g. for a character picker. */
export async function listFigures(catalog = FIGURE_CATALOG): Promise<CatalogEntry[]> {
  const { data } = await fetchJson('index.json', catalog) as { data: { format?: unknown; figures?: unknown } };
  if (data?.format !== CATALOG_FORMAT || !Array.isArray(data.figures)) throw new Error('Not a Peetty figure catalog.');
  return data.figures.filter((e): e is CatalogEntry =>
    !!e && typeof e === 'object' && typeof e.id === 'string' && FIGURE_ID.test(e.id) && typeof e.url === 'string'
    && /^https?:\/\//.test(e.url));
}
