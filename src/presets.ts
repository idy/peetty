import amara from '../figures/amara.json' with { type: 'json' };
import elsie from '../figures/elsie.json' with { type: 'json' };
import koharu from '../figures/koharu.json' with { type: 'json' };
import miru from '../figures/miru.json' with { type: 'json' };
import riley from '../figures/riley.json' with { type: 'json' };
import xiaoxiao from '../figures/xiaoxiao.json' with { type: 'json' };
import type { Figure, LocalizedText } from './figure/types.ts';
import { validateFigure } from './figure/validate.ts';

/** The figures bundled into the SDK, by id. */
export const PRESETS = { miru, koharu, xiaoxiao, riley, amara, elsie } as unknown as Record<'miru' | 'koharu' | 'xiaoxiao' | 'riley' | 'amara' | 'elsie', Figure>;
export type PresetId = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** Where the public figure catalog lives; `<id>.json` and `index.json`. */
export const FIGURE_CATALOG = 'https://peetty.idy.dev/figures/';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

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

async function fetchJson(input: string, base: string): Promise<unknown> {
  // The base itself may be relative, e.g. a self-hosted catalog at '/figures/'.
  const url = new URL(input, new URL(base, document.baseURI));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Figure URLs must use https: or http:.');
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
  return response.json();
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
  if (typeof input === 'object') return validateFigure(input);
  if (input in PRESETS) return PRESETS[input as PresetId];
  if (ID.test(input)) return validateFigure(await fetchJson(`${input}.json`, catalog));
  return validateFigure(await fetchJson(input, document.baseURI));
}

/** Lists the figures in a catalog, e.g. for a character picker. */
export async function listFigures(catalog = FIGURE_CATALOG): Promise<CatalogEntry[]> {
  const data = await fetchJson('index.json', catalog) as { format?: unknown; figures?: unknown };
  if (data?.format !== 'peetty.catalog' || !Array.isArray(data.figures)) throw new Error('Not a Peetty figure catalog.');
  return data.figures.filter((e): e is CatalogEntry =>
    !!e && typeof e === 'object' && typeof e.id === 'string' && ID.test(e.id) && typeof e.url === 'string'
    && /^https?:\/\//.test(e.url));
}
