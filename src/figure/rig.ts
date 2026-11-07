import { clamp } from '../math.ts';
import { isColorLiteral } from './validate.ts';
import {
  BONES,
  BONE_PARENTS,
  SLOT_STATES,
  unitOf,
  type BoneName,
  type Gradient,
  type Part,
  type Pose,
  type RigFigure,
  type Shape,
  type SlotName,
  type Soul,
} from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';
const SPRING_STEP = 1 / 120;
/** The soul a fright knocks out, in the units of a 260-unit-tall figure. */
const SOUL_RADIUS = 22;
/** Where it floats, from her mouth: up and off to the side, clear of her eyes. */
const SOUL_RISE: [number, number] = [58, -96];
/** A chibi mouth sits about this far above the head pivot (the neck). */
const SOUL_MOUTH = 9;

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
  /** The part follows the pointer or swings on a spring, so its inner group carries a transform. */
  innerTransform: boolean;
  visible: boolean;
  angle: number;
  velocity: number;
  last: [number, number] | null;
  lastVelocity: [number, number];
  pendingAcceleration: [number, number];
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
  private world: Record<BoneName, Matrix>;
  /** Bone transforms of the current `world`, each formatted on first use; reset whenever it changes. */
  private transforms: Partial<Record<BoneName, string>> = {};
  private springRemainder = 0;
  private readonly unit: number;
  private soul: Soul | null = null;
  private readonly mouth: [number, number];
  private readonly soulLayer: SVGGElement;
  private readonly soulShape: SVGPathElement;
  private readonly soulFace: SVGGElement;

  constructor(figure: RigFigure, options: RigOptions = {}) {
    this.figure = figure;
    this.world = this.worldMatrices({});
    this.unit = unitOf(figure.viewBox);
    this.palette = { ...figure.palette };
    for (const [key, value] of Object.entries(options.palette ?? {})) {
      if (Object.hasOwn(this.palette, key) && isColorLiteral(value)) this.palette[key] = value;
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
      const clip = el('clipPath', { id: this.ref('clip', key), clipPathUnits: 'userSpaceOnUse' });
      for (const shape of shapes) clip.append(this.shape(shape));
      defs.append(clip);
    }
    this.svg.append(defs);

    const ordered = [...figure.parts].sort((a, b) => a.z - b.z);
    for (const part of ordered) {
      if (part.slot) this.available.add(part.slot);
      const outer = el('g');
      outer.dataset.part = part.id;
      // The clip sits outside the look/spring transform, so an iris can move
      // while staying inside its eye.
      const inner = el('g');
      for (const shape of part.shapes) inner.append(this.shape(shape));
      if (part.clip) {
        const clipped = el('g', { 'clip-path': `url(#${this.ref('clip', part.clip)})` });
        clipped.append(inner);
        outer.append(clipped);
      } else outer.append(inner);
      this.svg.append(outer);
      this.views.push({
        part, outer, inner, innerTransform: !!part.look || !!(part.spring && part.pivot), visible: true,
        angle: 0, velocity: 0, last: null, lastVelocity: [0, 0], pendingAcceleration: [0, 0],
      });
    }

    // Drawn by the SDK above every part: her soul, when a fright knocks it out.
    const [headX, headY] = figure.skeleton.head.pivot;
    this.mouth = [headX, headY - SOUL_MOUTH * this.unit];
    this.soulShape = el('path', { fill: '#ffffff', stroke: '#bdb6e0', 'stroke-width': +(2 * this.unit).toFixed(3), 'stroke-linejoin': 'round' });
    this.soulFace = el('g', { fill: '#5f5a80' });
    const features = [
      el('ellipse', { cx: -0.34, cy: -0.12, rx: 0.12, ry: 0.15 }),
      el('ellipse', { cx: 0.34, cy: -0.12, rx: 0.12, ry: 0.15 }),
      el('ellipse', { cx: 0, cy: 0.3, rx: 0.12, ry: 0.16 }),
    ];
    this.soulFace.append(...features);
    this.soulLayer = el('g');
    this.soulLayer.dataset.effect = 'soul';
    this.soulLayer.style.display = 'none';
    this.soulLayer.append(this.soulShape, this.soulFace);
    // Inline, so a host stylesheet that makes her parts grabbable cannot make the soul catch the pointer.
    for (const node of [this.soulLayer, this.soulShape, this.soulFace, ...features]) node.style.pointerEvents = 'none';
    this.svg.append(this.soulLayer);

    for (const slot of Object.keys(SLOT_STATES) as SlotName[]) this.slots.set(slot, SLOT_STATES[slot][0]);
    this.refreshSlots();
    this.frame({}, 0);
  }

  /** Switches a slot, falling back to a drawn state when needed. */
  setSlot(slot: SlotName, state: string): void {
    this.setSlots({ [slot]: state });
  }

  /** Switches several slots at once, updating which parts are shown only once. */
  setSlots(slots: Partial<Record<SlotName, string>>): void {
    let changed = false;
    for (const [slot, state] of Object.entries(slots) as [SlotName, string][]) {
      if (this.slots.get(slot) === state) continue;
      this.slots.set(slot, state);
      changed = true;
    }
    if (changed) this.refreshSlots();
  }

  /** Pointer direction for the eyes, each axis -1..1. */
  setLook(x: number, y: number): void {
    this.look = [clamp(x, -1, 1), clamp(y, -1, 1)];
  }

  /**
   * Her soul after a fright, with its drift in animation units, or null.
   * While it is out, the irises (parts with `look`) go blank.
   */
  setSoul(soul: Soul | null): void {
    const changed = !soul !== !this.soul;
    this.soul = soul;
    if (!changed) return;
    this.soulLayer.style.display = soul ? '' : 'none';
    this.refreshSlots();
  }

  /**
   * Applies a pose and advances springs.
   * @param dt seconds since the last frame
   * @param push whole-figure acceleration in viewBox units/s², e.g. from walking
   */
  frame(pose: Pose, dt: number, push: [number, number] = [0, 0]): void {
    this.world = this.worldMatrices(pose);
    this.transforms = {};
    const step = Math.min(Math.max(dt, 0), 0.1);
    const elapsed = this.springRemainder + step;
    const steps = Math.floor((elapsed + 1e-10) / SPRING_STEP);

    for (const view of this.views) {
      const { part } = view;
      // Hidden alternatives still track their bone and spring, so revealing one
      // does not restart its motion or turn old displacement into acceleration.
      if (part.spring && part.pivot) this.spring(view, this.world[part.bone], step, push, steps);
      if (view.visible) this.render(view);
    }
    this.springRemainder = Math.max(0, elapsed - steps * SPRING_STEP);
    if (this.soul) this.drawSoul(this.soul);
  }

  /** One outline: a round wisp floating up beside her head, its tail curling back down into her mouth. */
  private drawSoul({ out, drift }: Soul): void {
    const u = this.unit;
    const [mx, my] = apply(this.world.head, this.mouth[0], this.mouth[1]);
    const r = SOUL_RADIUS * u * (0.35 + 0.65 * out);
    const [dx, dy] = [drift[0] * u, drift[1] * u];
    const cx = mx + (SOUL_RISE[0] * u + dx) * out;
    const cy = my + (SOUL_RISE[1] * u + dy) * out;
    // The tail leaves the wisp heading down, then turns into her mouth from the side,
    // below her eyes; the bend sways with the drift.
    const kx = cx + dx * 0.8;
    const ky = my;
    const toward = Math.atan2(ky - cy, kx - cx);
    const [nx, ny] = [-Math.sin(toward), Math.cos(toward)];
    const edge = (side: number) => [cx + r * Math.cos(toward + side), cy + r * Math.sin(toward + side)] as const;
    const [ax, ay] = edge(0.85);
    const [bx, by] = edge(-0.85);
    const wide = r * 0.4;
    const n = (v: number) => +v.toFixed(2);
    this.soulShape.setAttribute('d', `M${n(bx)} ${n(by)}A${n(r)} ${n(r)} 0 1 0 ${n(ax)} ${n(ay)}`
      + `Q${n(kx + nx * wide)} ${n(ky + ny * wide)} ${n(mx)} ${n(my)}`
      + `Q${n(kx - nx * wide)} ${n(ky - ny * wide)} ${n(bx)} ${n(by)}Z`);
    this.soulFace.setAttribute('transform', `translate(${n(cx)} ${n(cy)}) scale(${n(r)})`);
    this.soulLayer.setAttribute('opacity', String(n(Math.min(1, out * 3))));
  }

  private render(view: PartView): void {
    const { part } = view;
    view.outer.setAttribute('transform', this.transform(part.bone));
    if (!view.innerTransform) return;
    let transform = '';
    if (part.look) {
      transform += `translate(${(this.look[0] * part.look[0]).toFixed(3)} ${(this.look[1] * part.look[1]).toFixed(3)}) `;
    }
    if (part.spring && part.pivot) {
      transform += `rotate(${view.angle.toFixed(3)} ${part.pivot[0]} ${part.pivot[1]})`;
    }
    view.inner.setAttribute('transform', transform.trim());
  }

  /** A bone's transform for the current pose, formatted once and shared by its parts. */
  private transform(bone: BoneName): string {
    return (this.transforms[bone] ??= fmt(this.world[bone]));
  }

  destroy(): void {
    this.svg.remove();
  }

  private spring(view: PartView, matrix: Matrix, dt: number, push: [number, number], steps: number) {
    const spring = view.part.spring!;
    const [px, py] = view.part.pivot!;
    const position = apply(matrix, px, py);
    if (!view.last || dt === 0) {
      view.last = position;
      return;
    }
    const vx = (position[0] - view.last[0]) / dt;
    const vy = (position[1] - view.last[1]) / dt;
    // Motion uses the drawing's units; spring tuning uses a 260-unit figure.
    const ax = ((vx - view.lastVelocity[0]) / dt + push[0]) / this.unit;
    const ay = ((vy - view.lastVelocity[1]) / dt + push[1]) / this.unit;
    view.last = position;
    view.lastVelocity = [vx, vy];

    if (steps === 0) {
      view.pendingAcceleration[0] += ax * dt;
      view.pendingAcceleration[1] += ay * dt;
      return;
    }
    const gain = spring.gain ?? 1;
    const limit = spring.limit ?? 25;
    const boneAngle = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
    const target = -boneAngle * (spring.hang ?? 0.6);
    // Carry partial ticks and their acceleration across display frames.
    const firstDuration = SPRING_STEP - this.springRemainder;
    for (let i = 0; i < steps; i++) {
      const tickAx = i === 0 ? (view.pendingAcceleration[0] + ax * firstDuration) / SPRING_STEP : ax;
      const tickAy = i === 0 ? (view.pendingAcceleration[1] + ay * firstDuration) / SPRING_STEP : ay;
      // Half the acceleration per tick preserves the original 60 Hz tuning.
      const force = clamp((-tickAx * 0.0009 - Math.abs(tickAy) * 0.00015 * Math.sign(view.angle || 1)) * gain, -4, 4) * 0.5;
      view.velocity += (target - view.angle) * spring.stiffness * 0.5 + force;
      view.velocity *= spring.damping;
      view.angle = clamp(view.angle + view.velocity, -limit, limit);
    }
    const remainder = Math.max(0, this.springRemainder + dt - steps * SPRING_STEP);
    view.pendingAcceleration = [ax * remainder, ay * remainder];
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
      const { slot, look } = view.part;
      if (!slot && !look) continue;
      // Irises are the parts that follow the pointer; with her soul out, her eyes go blank.
      const visible = (!slot || shown.has(slot)) && !(this.soul && look);
      if (visible === view.visible) continue;
      view.visible = visible;
      view.outer.style.display = visible ? '' : 'none';
      if (visible) this.render(view);
    }
  }

  private ref(kind: 'gradient' | 'clip', key: string) {
    return `${this.prefix}-${kind}-${key}`;
  }

  private color(value: string): string {
    return Object.hasOwn(this.palette, value) ? this.palette[value]! : value;
  }

  private paint(value: string | undefined): string | null {
    if (value === undefined) return null;
    if (this.figure.gradients && Object.hasOwn(this.figure.gradients, value)) return `url(#${this.ref('gradient', value)})`;
    return this.color(value);
  }

  private gradient(key: string, g: Gradient): SVGElement {
    const node = g.type === 'linear'
      ? el('linearGradient', { x1: g.from[0], y1: g.from[1], x2: g.to[0], y2: g.to[1] })
      : el('radialGradient', {
          cx: g.center[0], cy: g.center[1], r: g.radius,
          ...(g.focus ? { fx: g.focus[0], fy: g.focus[1] } : {}),
        });
    node.setAttribute('id', this.ref('gradient', key));
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
