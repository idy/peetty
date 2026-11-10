/**
 * Catalog facts shared by the SDK and scripts/figures.mjs. Kept free of figure
 * data, so the generator can load it before the figure JSON exists.
 */

// Browser builds replace this constant before bundling; package clients retain
// their historical origin so existing connect-src policies keep working.
declare const __PEETTY_BROWSER_CATALOG__: string;
export let FIGURE_CATALOG = typeof __PEETTY_BROWSER_CATALOG__ === 'undefined'
  ? 'https://peetty.idy.dev/figures/' : __PEETTY_BROWSER_CATALOG__;

/** Browser bundles live in cdn/ (or sdk/), alongside the figures/ directory. */
export function setFigureScriptSource(source: string): void {
  FIGURE_CATALOG = new URL('../figures/', source).href;
}
export const CATALOG_FORMAT = 'peetty.catalog';

const BUNDLED = ['miru', 'koharu', 'xiaoxiao', 'riley', 'amara', 'elsie'] as const;
export type PresetId = (typeof BUNDLED)[number];
/** The figures bundled into the SDK, in catalog order. */
export const PRESET_IDS: PresetId[] = [...BUNDLED];
