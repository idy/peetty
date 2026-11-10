import type { Figure } from './types.ts';
import { parseCssColor } from './color.ts';

/** Image colours (印象色) a character can lend to the interface around her. */
export const IMAGE_COLORS = ['violet', 'pink', 'red', 'orange', 'green', 'teal', 'blue'] as const;
export type ImageColor = (typeof IMAGE_COLORS)[number];

/** The bundled characters' colours are chosen by hand; hue alone would call Xiaoxiao's brown eyes orange. */
const BUNDLED: Record<string, ImageColor> = { miru: 'violet', koharu: 'orange', xiaoxiao: 'red', riley: 'green', amara: 'teal', elsie: 'blue' };
/** Upper hue bound of each colour, in degrees. */
const HUES: [number, ImageColor][] = [[15, 'red'], [75, 'orange'], [165, 'green'], [200, 'teal'], [250, 'blue'], [290, 'violet'], [345, 'pink'], [360, 'red']];

/** Map opaque sRGB channels (0–1) to the contrast-tested interface palette. */
export function imageColorFromRgb(r: number, g: number, b: number): ImageColor | undefined {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  // Greys, near-whites and near-blacks carry no colour worth borrowing.
  if (delta < 0.12 || lightness < 0.12 || lightness > 0.92) return undefined;
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return HUES.find(([limit]) => (hue * 60 + 360) % 360 < limit)?.[1];
}

/** A stable colour for a name alone: a bundled character's own, otherwise one picked by hash. */
export function imageColorById(id: string): ImageColor {
  if (Object.hasOwn(BUNDLED, id)) return BUNDLED[id]!;
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return IMAGE_COLORS[hash % IMAGE_COLORS.length]!;
}

/** The colour a character is remembered by: her eyes first, then her hair. */
export function imageColorOf(figure: Pick<Figure, 'id' | 'palette'>): ImageColor {
  if (Object.hasOwn(BUNDLED, figure.id)) return BUNDLED[figure.id]!;
  for (const key of ['iris', 'hair', 'ribbon']) {
    const rgba = parseCssColor(figure.palette[key] ?? '');
    if (!rgba || rgba[3] === 0) continue;
    const color = imageColorFromRgb(rgba[0], rgba[1], rgba[2]);
    if (color) return color;
  }
  return imageColorById(figure.id);
}
