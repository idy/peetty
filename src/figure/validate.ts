import {
  BONES,
  FIGURE_FORMAT,
  FIGURE_VERSION,
  SLOT_STATES,
  STATES,
  type Figure,
} from './types.ts';

export const LIMITS = {
  /** Serialized size of a figure pack, including embedded images. */
  maxBytes: 2_000_000,
  maxParts: 200,
  maxShapesPerPart: 64,
  maxPathLength: 20_000,
  maxPaletteEntries: 64,
  maxGradients: 64,
  maxFrames: 512,
} as const;

export class FigureError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid Peetty figure:\n- ${issues.join('\n- ')}`);
    this.name = 'FigureError';
    this.issues = issues;
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/;
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC = /^(?:rgba?|hsla?)\([0-9.,%\s/+-]+\)$/;
const IMAGE = /^(?:https:\/\/[^\s"'<>]+|data:image\/(?:png|webp|gif);base64,[A-Za-z0-9+/=]+)$/;

export function isColorLiteral(value: string): boolean {
  return value === 'none' || value === 'transparent' || HEX.test(value) || FUNC.test(value);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNum);

/**
 * Validates untrusted figure data. Returns the figure typed on success and
 * throws {@link FigureError} listing every problem otherwise.
 */
export function validateFigure(input: unknown): Figure {
  const issues: string[] = [];
  const fail = (path: string, message: string) => {
    if (issues.length < 50) issues.push(`${path}: ${message}`);
  };

  let size = 0;
  try {
    size = JSON.stringify(input)?.length ?? 0;
  } catch {
    throw new FigureError(['figure: must be plain JSON data']);
  }
  if (size > LIMITS.maxBytes) fail('figure', `is ${size} bytes; the limit is ${LIMITS.maxBytes}`);
  if (!isObj(input)) throw new FigureError(['figure: must be an object']);
  const f = input;

  if (f.format !== FIGURE_FORMAT) fail('format', `must be "${FIGURE_FORMAT}"`);
  if (f.version !== FIGURE_VERSION) fail('version', `must be ${FIGURE_VERSION}`);
  if (typeof f.id !== 'string' || !ID.test(f.id)) fail('id', 'must be 1–40 lowercase letters, digits or hyphens');
  checkText(f.name, 'name', fail, true);
  if (f.description !== undefined) checkText(f.description, 'description', fail, false);
  for (const key of ['author', 'license'] as const) {
    if (f[key] !== undefined && (typeof f[key] !== 'string' || (f[key] as string).length > 200)) {
      fail(key, 'must be a string of at most 200 characters');
    }
  }

  const vb = f.viewBox;
  if (!Array.isArray(vb) || vb.length !== 4 || !vb.every(isNum) || (vb[2] as number) <= 0 || (vb[3] as number) <= 0) {
    fail('viewBox', 'must be [minX, minY, width, height] with positive size');
  }
  if (!isNum(f.height) || f.height < 24 || f.height > 480) fail('height', 'must be 24–480 CSS pixels');
  if (!isPoint(f.anchor)) fail('anchor', 'must be [x, y]');

  const palette = isObj(f.palette) ? f.palette : {};
  if (!isObj(f.palette)) fail('palette', 'must be an object');
  const paletteKeys = Object.keys(palette);
  if (paletteKeys.length > LIMITS.maxPaletteEntries) fail('palette', `has more than ${LIMITS.maxPaletteEntries} entries`);
  for (const key of paletteKeys) {
    const value = palette[key];
    if (!KEY.test(key)) fail(`palette.${key}`, 'key must be an identifier');
    if (typeof value !== 'string' || !isColorLiteral(value)) fail(`palette.${key}`, 'must be a hex, rgb() or hsl() color');
  }

  if (f.behavior !== undefined) checkBehavior(f.behavior, fail);

  if (f.renderer === 'rig') checkRig(f, palette, fail);
  else if (f.renderer === 'sprite') checkSprite(f, fail);
  else fail('renderer', 'must be "rig" or "sprite"');

  if (issues.length) throw new FigureError(issues);
  return input as unknown as Figure;
}

type Fail = (path: string, message: string) => void;

function checkText(v: unknown, path: string, fail: Fail, required: boolean) {
  const ok = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 200;
  if (v === undefined && !required) return;
  if (ok(v)) return;
  if (isObj(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, s]) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k) && ok(s))) return;
  fail(path, 'must be a string or an object of language codes to strings');
}

function checkBehavior(b: unknown, fail: Fail) {
  if (!isObj(b)) return fail('behavior', 'must be an object');
  if (b.weights !== undefined) {
    if (!isObj(b.weights)) fail('behavior.weights', 'must be an object');
    else for (const [k, w] of Object.entries(b.weights)) {
      if (!KEY.test(k) || !isNum(w) || w < 0 || w > 100) fail(`behavior.weights.${k}`, 'must be a number from 0 to 100');
    }
  }
  for (const key of ['walkSpeed', 'jumpPower'] as const) {
    const v = b[key];
    if (v !== undefined && (!isNum(v) || v < 0.25 || v > 3)) fail(`behavior.${key}`, 'must be 0.25–3');
  }
  if (b.idleProp !== undefined && !['book', 'cup', 'camera', 'gum', 'stretch', 'none'].includes(b.idleProp as string)) {
    fail('behavior.idleProp', 'must be "book", "cup", "camera", "gum", "stretch" or "none"');
  }
  if (b.fallProp !== undefined && !['umbrella', 'none'].includes(b.fallProp as string)) {
    fail('behavior.fallProp', 'must be "umbrella" or "none"');
  }
}

function checkRig(f: Obj, palette: Obj, fail: Fail) {
  const skeleton = f.skeleton;
  if (!isObj(skeleton)) fail('skeleton', 'must give a pivot for every bone');
  else for (const bone of BONES) {
    const entry = skeleton[bone];
    if (!isObj(entry) || !isPoint(entry.pivot)) fail(`skeleton.${bone}.pivot`, 'must be [x, y]');
  }

  const gradients = f.gradients === undefined ? {} : f.gradients;
  if (!isObj(gradients)) fail('gradients', 'must be an object');
  const gradientKeys = isObj(gradients) ? Object.keys(gradients) : [];
  if (gradientKeys.length > LIMITS.maxGradients) fail('gradients', `has more than ${LIMITS.maxGradients} entries`);

  const paint = (v: unknown, path: string) => {
    if (v === undefined) return;
    if (typeof v !== 'string') return fail(path, 'must be a string');
    if (v in palette || gradientKeys.includes(v) || isColorLiteral(v)) return;
    fail(path, `"${v}" is not a palette key, gradient key or color`);
  };

  if (isObj(gradients)) for (const key of gradientKeys) {
    const g = gradients[key];
    const p = `gradients.${key}`;
    if (!KEY.test(key)) fail(p, 'key must be an identifier');
    if (key in palette) fail(p, 'must not reuse a palette key');
    if (!isObj(g)) { fail(p, 'must be an object'); continue; }
    if (g.type === 'linear') {
      if (!isPoint(g.from) || !isPoint(g.to)) fail(p, 'linear gradients need from and to points');
    } else if (g.type === 'radial') {
      if (!isPoint(g.center) || !isNum(g.radius) || g.radius <= 0) fail(p, 'radial gradients need center and radius');
      if (g.focus !== undefined && !isPoint(g.focus)) fail(`${p}.focus`, 'must be [x, y]');
    } else fail(`${p}.type`, 'must be "linear" or "radial"');
    if (!Array.isArray(g.stops) || g.stops.length < 1 || g.stops.length > 16) fail(`${p}.stops`, 'needs 1–16 stops');
    else g.stops.forEach((s, i) => {
      const sp = `${p}.stops[${i}]`;
      if (!isObj(s) || !isNum(s.offset) || s.offset < 0 || s.offset > 1) return fail(sp, 'offset must be 0–1');
      if (typeof s.color !== 'string' || !(s.color in palette || isColorLiteral(s.color))) fail(`${sp}.color`, 'must be a palette key or color');
      if (s.opacity !== undefined && (!isNum(s.opacity) || s.opacity < 0 || s.opacity > 1)) fail(`${sp}.opacity`, 'must be 0–1');
    });
  }

  const checkShapes = (shapes: unknown, path: string) => {
    if (!Array.isArray(shapes) || shapes.length === 0 || shapes.length > LIMITS.maxShapesPerPart) {
      return fail(path, `needs 1–${LIMITS.maxShapesPerPart} shapes`);
    }
    shapes.forEach((s, i) => {
      const sp = `${path}[${i}]`;
      if (!isObj(s)) return fail(sp, 'must be an object');
      if (s.type === 'path') {
        if (typeof s.d !== 'string' || s.d.length > LIMITS.maxPathLength || !PATH_DATA.test(s.d)) fail(`${sp}.d`, 'must be SVG path data');
      } else if (s.type === 'ellipse') {
        if (![s.cx, s.cy, s.rx, s.ry].every(isNum) || (s.rx as number) < 0 || (s.ry as number) < 0) fail(sp, 'ellipse needs cx, cy, rx, ry');
        if (s.rotate !== undefined && !isNum(s.rotate)) fail(`${sp}.rotate`, 'must be a number');
      } else return fail(`${sp}.type`, 'must be "path" or "ellipse"');
      paint(s.fill, `${sp}.fill`);
      paint(s.stroke, `${sp}.stroke`);
      if (s.strokeWidth !== undefined && (!isNum(s.strokeWidth) || s.strokeWidth < 0 || s.strokeWidth > 50)) fail(`${sp}.strokeWidth`, 'must be 0–50');
      if (s.opacity !== undefined && (!isNum(s.opacity) || s.opacity < 0 || s.opacity > 1)) fail(`${sp}.opacity`, 'must be 0–1');
      if (s.lineCap !== undefined && !['butt', 'round', 'square'].includes(s.lineCap as string)) fail(`${sp}.lineCap`, 'invalid');
      if (s.lineJoin !== undefined && !['miter', 'round', 'bevel'].includes(s.lineJoin as string)) fail(`${sp}.lineJoin`, 'invalid');
      if (s.blend !== undefined && !['normal', 'multiply', 'screen', 'overlay'].includes(s.blend as string)) fail(`${sp}.blend`, 'invalid');
    });
  };

  const clips = f.clips === undefined ? {} : f.clips;
  if (!isObj(clips)) fail('clips', 'must be an object');
  const clipKeys = isObj(clips) ? Object.keys(clips) : [];
  if (isObj(clips)) for (const key of clipKeys) {
    if (!KEY.test(key)) fail(`clips.${key}`, 'key must be an identifier');
    checkShapes(clips[key], `clips.${key}`);
  }

  const parts = f.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > LIMITS.maxParts) {
    return fail('parts', `needs 1–${LIMITS.maxParts} parts`);
  }
  const ids = new Set<string>();
  parts.forEach((part, i) => {
    const p = `parts[${i}]`;
    if (!isObj(part)) return fail(p, 'must be an object');
    if (typeof part.id !== 'string' || !KEY.test(part.id)) fail(`${p}.id`, 'must be an identifier');
    else if (ids.has(part.id)) fail(`${p}.id`, `"${part.id}" is used twice`);
    else ids.add(part.id);
    if (!BONES.includes(part.bone as never)) fail(`${p}.bone`, `must be one of ${BONES.join(', ')}`);
    if (!isNum(part.z)) fail(`${p}.z`, 'must be a number');
    if (part.slot !== undefined) {
      const [slot, state, extra] = String(part.slot).split(':');
      const states = SLOT_STATES[slot as keyof typeof SLOT_STATES] as readonly string[] | undefined;
      if (extra !== undefined || !states || !states.includes(state ?? '')) {
        fail(`${p}.slot`, `must be <slot>:<state>, e.g. eyes:open (slots: ${Object.keys(SLOT_STATES).join(', ')})`);
      }
    }
    if (part.pivot !== undefined && !isPoint(part.pivot)) fail(`${p}.pivot`, 'must be [x, y]');
    if (part.look !== undefined && !isPoint(part.look)) fail(`${p}.look`, 'must be [x, y]');
    if (part.clip !== undefined && !clipKeys.includes(part.clip as string)) fail(`${p}.clip`, 'must name an entry in clips');
    if (part.spring !== undefined) {
      const s = part.spring;
      if (!isObj(s)) fail(`${p}.spring`, 'must be an object');
      else {
        if (!isNum(s.stiffness) || s.stiffness < 0.01 || s.stiffness > 1) fail(`${p}.spring.stiffness`, 'must be 0.01–1');
        if (!isNum(s.damping) || s.damping < 0 || s.damping > 0.99) fail(`${p}.spring.damping`, 'must be 0–0.99');
        if (s.gain !== undefined && (!isNum(s.gain) || s.gain < 0 || s.gain > 10)) fail(`${p}.spring.gain`, 'must be 0–10');
        if (s.limit !== undefined && (!isNum(s.limit) || s.limit < 0 || s.limit > 90)) fail(`${p}.spring.limit`, 'must be 0–90');
        if (s.hang !== undefined && (!isNum(s.hang) || s.hang < 0 || s.hang > 1)) fail(`${p}.spring.hang`, 'must be 0–1');
        if (part.pivot === undefined) fail(`${p}.pivot`, 'is required with a spring');
      }
    }
    checkShapes(part.shapes, `${p}.shapes`);
  });
}

function checkSprite(f: Obj, fail: Fail) {
  const s = f.sprite;
  if (!isObj(s)) return fail('sprite', 'must be an object');
  if (typeof s.image !== 'string' || !IMAGE.test(s.image)) fail('sprite.image', 'must be an https: URL or a base64 PNG, WebP or GIF data URL');
  for (const key of ['frameWidth', 'frameHeight', 'columns'] as const) {
    const v = s[key];
    if (!isNum(v) || !Number.isInteger(v) || v < 1 || v > 4096) fail(`sprite.${key}`, 'must be a positive integer');
  }
  const anims = s.animations;
  if (!isObj(anims) || !isObj(anims.idle)) return fail('sprite.animations.idle', 'is required');
  for (const [name, a] of Object.entries(anims)) {
    const p = `sprite.animations.${name}`;
    if (!STATES.includes(name as never)) fail(p, `is not a known state (${STATES.join(', ')})`);
    if (!isObj(a)) { fail(p, 'must be an object'); continue; }
    if (!Array.isArray(a.frames) || a.frames.length === 0 || a.frames.length > LIMITS.maxFrames
      || !a.frames.every((n) => Number.isInteger(n) && (n as number) >= 0)) fail(`${p}.frames`, 'must be frame indexes');
    if (!isNum(a.fps) || a.fps <= 0 || a.fps > 60) fail(`${p}.fps`, 'must be 1–60');
    if (a.loop !== undefined && typeof a.loop !== 'boolean') fail(`${p}.loop`, 'must be true or false');
  }
}
