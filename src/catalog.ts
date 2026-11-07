/**
 * Catalog facts shared by the SDK and scripts/figures.mjs. Kept free of figure
 * data, so the generator can load it before the figure JSON exists.
 */

/** Where the public figure catalog lives; `<id>.json` and `index.json`. */
export const FIGURE_CATALOG = 'https://peetty.idy.dev/figures/';
export const CATALOG_FORMAT = 'peetty.catalog';

const BUNDLED = ['miru', 'koharu', 'xiaoxiao', 'riley', 'amara', 'elsie'] as const;
export type PresetId = (typeof BUNDLED)[number];
/** The figures bundled into the SDK, in catalog order. */
export const PRESET_IDS: PresetId[] = [...BUNDLED];
