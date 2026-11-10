import { imageColorFromRgb, type ImageColor } from '../figure/image-color.ts';
import { parseCssColor } from '../figure/color.ts';

const TOKENS = ['--primary-color', '--brand-color', '--accent-color', '--color-primary', '--color-accent', '--primary', '--accent'];
const CONTROLS = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';
const MAX_NODES = 600;
const MAX_CONTROLS = 24;

/** Read visual colour only. Never reads page text, images, form values or external stylesheets. */
export function pageColor(document: Document): ImageColor | undefined {
  const window = document.defaultView;
  if (!window) return undefined;
  let canvas: CanvasRenderingContext2D | null | undefined;
  function color(value: string): ImageColor | undefined {
    value = value.trim();
    if (!value || /^(?:transparent|currentcolor|inherit|initial|unset)$/i.test(value)) return undefined;
    const rgba = parseCssColor(value);
    if (rgba) return rgba[3] >= .75 ? imageColorFromRgb(rgba[0], rgba[1], rgba[2]) : undefined;
    // Let the browser resolve named colours, oklch() and wide-gamut values.
    // This canvas paints one solid pixel only; no page/image pixels are sampled.
    try {
      if (canvas === undefined) {
        const element = document.createElement('canvas'); element.width = element.height = 1;
        canvas = element.getContext('2d', { willReadFrequently: true });
      }
      if (!canvas) return undefined;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = '#000'; // Invalid CSS stays neutral and is ignored.
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return a! / 255 >= .75 ? imageColorFromRgb(r! / 255, g! / 255, b! / 255) : undefined;
    } catch { canvas = null; return undefined; }
  }

  // Explicit design tokens win over incidental coloured buttons and browser chrome.
  for (const element of [document.documentElement, document.body]) {
    if (!element) continue;
    const style = window.getComputedStyle(element);
    for (const token of TOKENS) {
      const found = color(style.getPropertyValue(token));
      if (found) return found;
    }
  }
  for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).slice(0, 8)) {
    if (meta.media && !window.matchMedia(meta.media).matches) continue;
    const found = color(meta.content);
    if (found) return found;
  }
  if (!document.body) return undefined;
  const fills = new Map<ImageColor, number>();
  const links = new Map<ImageColor, number>();
  const add = (votes: Map<ImageColor, number>, value: ImageColor | undefined, weight: number) => {
    if (value) votes.set(value, (votes.get(value) ?? 0) + weight);
  };
  // A bounded walk avoids querying every link on a large document, and does not enter shadow roots.
  const walk = document.createTreeWalker(document.body, 1 /* SHOW_ELEMENT */);
  let inspected = 0;
  for (let visited = 0; visited < MAX_NODES && inspected < MAX_CONTROLS; visited++) {
    const element = walk.nextNode() as Element | null;
    if (!element) break;
    if (!element.matches(CONTROLS) || element.closest('[data-peetty], [hidden], [inert], [aria-hidden="true"]')) continue;
    inspected++;
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
    const style = window.getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) < .75) continue;
    const fill = color(style.backgroundColor);
    add(fills, fill, element.matches('button, [role="button"], input') ? 3 : 2);
    // Do not mistake the browser's default blue/purple links for site branding.
    const text = style.color.replace(/\s/g, '').toLowerCase();
    if (element.matches('a[href]') && !['rgb(0,0,238)', 'rgb(85,26,139)', '#0000ee', '#551a8b'].includes(text)) add(links, color(style.color), 1);
  }
  const winner = (votes: Map<ImageColor, number>) => [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const fill = winner(fills);
  if (fill) return fill;
  for (const element of [document.body, document.documentElement]) {
    const found = color(window.getComputedStyle(element).backgroundColor);
    if (found) return found;
  }
  return winner(links);
}
