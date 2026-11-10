/**
 * Catalog facts shared by the SDK and scripts/figures.mjs. Kept free of figure
 * data, so the generator can load it before the figure JSON exists.
 */

/** Default catalog for package consumers; browser entries follow their own CDN URL. */
export let FIGURE_CATALOG = 'https://cdn.jsdelivr.net/gh/idy/peetty@v0.3.2/figures/';

/** Browser bundles live in cdn/ (or sdk/), alongside the figures/ directory. */
export function setFigureScriptSource(source: string): void {
  FIGURE_CATALOG = new URL('../figures/', source).href;
}
export const CATALOG_FORMAT = 'peetty.catalog';

const BUNDLED = ['miru', 'koharu', 'xiaoxiao', 'riley', 'amara', 'elsie'] as const;
export type PresetId = (typeof BUNDLED)[number];
/** The figures bundled into the SDK, in catalog order. */
export const PRESET_IDS: PresetId[] = [...BUNDLED];
