export type Rgba = [number, number, number, number];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const number = '[+-]?(?:\\d*\\.)?\\d+';
const channel = `(${number}%?)`;
const rgb = new RegExp(`^rgba?\\(\\s*${channel}[,\\s]+${channel}[,\\s]+${channel}(?:\\s*[,/]\\s*${channel})?\\s*\\)$`, 'i');
const hsl = new RegExp(`^hsla?\\(\\s*(${number})(deg|grad|rad|turn)?[,\\s]+(${number})%[,\\s]+(${number})%(?:\\s*[,/]\\s*${channel})?\\s*\\)$`, 'i');
const alpha = (value: string | undefined) => value === undefined ? 1 : clamp(parseFloat(value) / (value.endsWith('%') ? 100 : 1));

/** Parse the sRGB literals accepted by figure palettes without needing a rendering context. */
export function parseCssColor(value: string): Rgba | undefined {
  value = value.trim();
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
    return [...[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255), full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1] as Rgba;
  }
  const channels = rgb.exec(value);
  if (channels) return [...channels.slice(1, 4).map(v => clamp(parseFloat(v!) / (v!.endsWith('%') ? 100 : 255))), alpha(channels[4])] as Rgba;
  const components = hsl.exec(value);
  if (!components) return undefined;
  const degrees = Number(components[1]) * ({ grad: .9, rad: 180 / Math.PI, turn: 360 }[components[2]?.toLowerCase() ?? ''] ?? 1);
  const hue = ((degrees % 360) + 360) % 360 / 60;
  const saturation = clamp(Number(components[3]) / 100);
  const lightness = clamp(Number(components[4]) / 100);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const middle = chroma * (1 - Math.abs(hue % 2 - 1));
  const base = lightness - chroma / 2;
  const segment = Math.floor(hue);
  const colors = [[chroma, middle, 0], [middle, chroma, 0], [0, chroma, middle], [0, middle, chroma], [middle, 0, chroma], [chroma, 0, middle]][segment]!;
  return [...colors.map(c => c + base), alpha(components[5])] as Rgba;
}
