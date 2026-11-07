import { isColorLiteral } from './validate.ts';
import {
  BONES,
  BONE_PARENTS,
  SLOT_STATES,
  type BoneName,
  type Gradient,
  type Part,
  type Pose,
  type RigFigure,
  type Shape,
  type SlotName,
} from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** Fallback order when a figure does not draw a requested slot state. */
const SLOT_FALLBACKS: Record<string, string[]> = {
  'eyes:closed': ['eyes:open'],
  'eyes:happy': ['eyes:closed', 'eyes:open'],
  'eyes:sleepy': ['eyes:closed', 'eyes:open'],
  'mouth:open': ['mouth:smile'],
  'mouth:talk': ['mouth:open', 'mouth:smile'],
  'mouth:o': ['mouth:open', 'mouth:smile'],
  'mouth:flat': ['mouth:smile'],
  'brows:worried': ['brows:calm'],
  'hand:book': ['hand:rest'],
  'hand:cup': ['hand:rest'],
  'hand:camera': ['hand:rest'],
  'hand:umbrella': ['hand:rest'],
  'mouth:gum': ['mouth:o', 'mouth:smile'],
  'mouth:gumBig': ['mouth:gum', 'mouth:o', 'mouth:smile'],
};

type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const fmt = (m: Matrix) => `matrix(${m.map((v) => +v.toFixed(4)).join(' ')})`;

interface PartView {
  part: Part;
  outer: SVGGElement;
  inner: SVGGElement;
  slot: string | null;
  angle: number;
  velocity: number;
  last: [number, number] | null;
  lastVelocity: [number, number];
}

export interface RigOptions {
  /** Palette overrides, merged over the figure's palette. */
  palette?: Record<string, string>;
}

let instances = 0;

/**
 * Draws a rig figure as SVG and moves it from a {@link Pose} each frame.
 * Only shapes from validated data are created; no markup is parsed.
 */
export class RigRenderer {
  readonly svg: SVGSVGElement;
  readonly figure: RigFigure;
  private readonly views: PartView[] = [];
  private readonly prefix = `peetty-${++instances}`;
  private readonly palette: Record<string, string>;
  private readonly available = new Set<string>();
  private readonly slots = new Map<SlotName, string>();
  private look: [number, number] = [0, 0];
  private time = 0;

  constructor(figure: RigFigure, options: RigOptions = {}) {
    this.figure = figure;
    this.palette = { ...figure.palette };
    for (const [key, value] of Object.entries(options.palette ?? {})) {
      if (key in this.palette && isColorLiteral(value)) this.palette[key] = value;
    }

    const [x, y, w, h] = figure.viewBox;
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute('width', String(+(figure.height * (w / h)).toFixed(2)));
    this.svg.setAttribute('height', String(figure.height));
    this.svg.setAttribute('overflow', 'visible');
    this.svg.style.isolation = 'isolate';
    this.svg.style.overflow = 'visible';

    const defs = el('defs');
    for (const [key, gradient] of Object.entries(figure.gradients ?? {})) defs.append(this.gradient(key, gradient));
    for (const [key, shapes] of Object.entries(figure.clips ?? {})) {
      const clip = el('clipPath', { id: this.ref(key), clipPathUnits: 'userSpaceOnUse' });
      for (const shape of shapes) clip.append(this.shape(shape));
      defs.append(clip);
    }
    this.svg.append(defs);

    const ordered = figure.parts.map((part, index) => ({ part, index }))
      .sort((a, b) => a.part.z - b.part.z || a.index - b.index);
    for (const { part } of ordered) {
      if (part.slot) this.available.add(part.slot);
      const outer = el('g');
      outer.dataset.part = part.id;
      // The clip sits outside the look/spring transform, so an iris can move
      // while staying inside its eye.
      const inner = el('g');
      for (const shape of part.shapes) inner.append(this.shape(shape));
      if (part.clip) {
        const clipped = el('g', { 'clip-path': `url(#${this.ref(part.clip)})` });
        clipped.append(inner);
        outer.append(clipped);
      } else outer.append(inner);
      this.svg.append(outer);
      this.views.push({ part, outer, inner, slot: part.slot ?? null, angle: 0, velocity: 0, last: null, lastVelocity: [0, 0] });
    }

    for (const slot of Object.keys(SLOT_STATES) as SlotName[]) this.slots.set(slot, SLOT_STATES[slot][0]);
    this.refreshSlots();
    this.frame({}, 0);
  }

  /** Switches a slot, falling back to a drawn state when needed. */
  setSlot(slot: SlotName, state: string): void {
    if (this.slots.get(slot) === state) return;
    this.slots.set(slot, state);
    this.refreshSlots();
  }

  /** Pointer direction for the eyes, each axis -1..1. */
  setLook(x: number, y: number): void {
    this.look = [clamp(x, -1, 1), clamp(y, -1, 1)];
  }

  /**
   * Applies a pose and advances springs.
   * @param dt seconds since the last frame
   * @param push whole-figure acceleration in viewBox units/s², e.g. from walking
   */
  frame(pose: Pose, dt: number, push: [number, number] = [0, 0]): void {
    const world = this.worldMatrices(pose);
    const rotation: Partial<Record<BoneName, number>> = {};
    for (const bone of BONES) {
      const m = world[bone];
      rotation[bone] = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    }
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.time += step;

    for (const view of this.views) {
      const { part } = view;
      const matrix = world[part.bone];
      view.outer.setAttribute('transform', fmt(matrix));
      let transform = '';
      if (part.look) {
        transform += `translate(${(this.look[0] * part.look[0]).toFixed(3)} ${(this.look[1] * part.look[1]).toFixed(3)}) `;
      }
      if (part.spring && part.pivot) {
        this.spring(view, matrix, rotation[part.bone] ?? 0, step, push);
        transform += `rotate(${view.angle.toFixed(3)} ${part.pivot[0]} ${part.pivot[1]})`;
      }
      if (transform) view.inner.setAttribute('transform', transform.trim());
      else view.inner.removeAttribute('transform');
    }
  }

  destroy(): void {
    this.svg.remove();
  }

  private spring(view: PartView, matrix: Matrix, boneAngle: number, dt: number, push: [number, number]) {
    const spring = view.part.spring!;
    const [px, py] = view.part.pivot!;
    const position = apply(matrix, px, py);
    if (!view.last || dt === 0) {
      view.last = position;
      return;
    }
    const vx = (position[0] - view.last[0]) / dt;
    const vy = (position[1] - view.last[1]) / dt;
    const ax = (vx - view.lastVelocity[0]) / dt + push[0];
    const ay = (vy - view.lastVelocity[1]) / dt + push[1];
    view.last = position;
    view.lastVelocity = [vx, vy];

    const gain = spring.gain ?? 1;
    const limit = spring.limit ?? 25;
    const target = -boneAngle * (spring.hang ?? 0.6);
    // Fixed 120 Hz substeps keep the feel independent of the display rate.
    const steps = Math.max(1, Math.round(dt * 120));
    // Sideways acceleration swings the part opposite to the motion; a light
    // vertical term adds bounce on landing without flipping the direction.
    const force = clamp((-ax * 0.0009 - Math.abs(ay) * 0.00015 * Math.sign(view.angle || 1)) * gain, -4, 4) / steps;
    for (let i = 0; i < steps; i++) {
      view.velocity += (target - view.angle) * spring.stiffness * 0.5 + force;
      view.velocity *= spring.damping;
      view.angle = clamp(view.angle + view.velocity, -limit, limit);
    }
  }

  private worldMatrices(pose: Pose): Record<BoneName, Matrix> {
    const out = {} as Record<BoneName, Matrix>;
    for (const bone of BONES) {
      const [px, py] = this.figure.skeleton[bone].pivot;
      const p = pose[bone] ?? {};
      const r = ((p.rotate ?? 0) * Math.PI) / 180;
      const sx = p.sx ?? 1;
      const sy = p.sy ?? 1;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      // translate(pivot + offset) · rotate · scale · translate(-pivot)
      const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
      const local: Matrix = [a, b, c, d, px + (p.x ?? 0) - (a * px + c * py), py + (p.y ?? 0) - (b * px + d * py)];
      const parent = BONE_PARENTS[bone];
      out[bone] = parent ? multiply(out[parent], local) : multiply(IDENTITY, local);
    }
    return out;
  }

  private refreshSlots() {
    const shown = new Set<string>();
    for (const [slot, state] of this.slots) {
      const wanted = `${slot}:${state}`;
      // Missing states fall back to their listed alternatives, then to the slot's default.
      const fallback = `${slot}:${SLOT_STATES[slot][0]}`;
      const resolved = [wanted, ...(SLOT_FALLBACKS[wanted] ?? []), fallback].find((s) => this.available.has(s));
      if (resolved) shown.add(resolved);
    }
    for (const view of this.views) {
      if (view.slot) view.outer.style.display = shown.has(view.slot) ? '' : 'none';
    }
  }

  private ref(key: string) {
    return `${this.prefix}-${key}`;
  }

  private color(value: string): string {
    return this.palette[value] ?? value;
  }

  private paint(value: string | undefined): string | null {
    if (value === undefined) return null;
    if (this.figure.gradients && value in this.figure.gradients) return `url(#${this.ref(value)})`;
    return this.color(value);
  }

  private gradient(key: string, g: Gradient): SVGElement {
    const node = g.type === 'linear'
      ? el('linearGradient', { x1: g.from[0], y1: g.from[1], x2: g.to[0], y2: g.to[1] })
      : el('radialGradient', {
          cx: g.center[0], cy: g.center[1], r: g.radius,
          ...(g.focus ? { fx: g.focus[0], fy: g.focus[1] } : {}),
        });
    node.setAttribute('id', this.ref(key));
    node.setAttribute('gradientUnits', 'userSpaceOnUse');
    for (const stop of g.stops) {
      node.append(el('stop', {
        offset: stop.offset,
        'stop-color': this.color(stop.color),
        ...(stop.opacity !== undefined ? { 'stop-opacity': stop.opacity } : {}),
      }));
    }
    return node;
  }

  private shape(shape: Shape): SVGElement {
    const node = shape.type === 'path'
      ? el('path', { d: shape.d })
      : el('ellipse', {
          cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry,
          ...(shape.rotate ? { transform: `rotate(${shape.rotate} ${shape.cx} ${shape.cy})` } : {}),
        });
    node.setAttribute('fill', this.paint(shape.fill) ?? 'none');
    const stroke = this.paint(shape.stroke);
    if (stroke) {
      node.setAttribute('stroke', stroke);
      node.setAttribute('stroke-width', String(shape.strokeWidth ?? 1));
      node.setAttribute('stroke-linecap', shape.lineCap ?? 'round');
      node.setAttribute('stroke-linejoin', shape.lineJoin ?? 'round');
    }
    if (shape.opacity !== undefined) node.setAttribute('opacity', String(shape.opacity));
    if (shape.blend && shape.blend !== 'normal') node.style.mixBlendMode = shape.blend;
    return node;
  }
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
