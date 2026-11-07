/**
 * Peetty figure pack, format version 1.
 *
 * A figure is data only: shapes, colors and motion hints. The SDK owns every
 * animation, so a rig figure only needs parts attached to the standard bones.
 */

export const FIGURE_FORMAT = 'peetty.figure';
export const FIGURE_VERSION = 1;

/** Standard skeleton. Parent of each bone is listed in {@link BONE_PARENTS}. */
export const BONES = ['root', 'hips', 'body', 'head', 'armL', 'armR', 'legL', 'legR'] as const;
export type BoneName = (typeof BONES)[number];

export const BONE_PARENTS: Record<BoneName, BoneName | null> = {
  root: null,
  hips: 'root',
  legL: 'hips',
  legR: 'hips',
  body: 'hips',
  head: 'body',
  armL: 'body',
  armR: 'body',
};

/**
 * Slots switch between alternative parts. A part with `slot: "eyes:closed"` is
 * visible only while the eyes slot is in the closed state.
 */
export const SLOT_STATES = {
  eyes: ['open', 'closed', 'happy', 'sleepy'],
  mouth: ['smile', 'open', 'talk', 'flat', 'o', 'gum', 'gumBig'],
  brows: ['calm', 'worried'],
  hand: ['rest', 'book', 'cup', 'camera', 'umbrella'],
  /** Drawn arm poses; the arm bone only rotates the whole drawing. */
  armL: ['rest', 'bent', 'up', 'fold'],
  armR: ['rest', 'bent', 'up', 'fold'],
} as const;
export type SlotName = keyof typeof SLOT_STATES;
export type SlotState<S extends SlotName = SlotName> = (typeof SLOT_STATES)[S][number];

/** Animation states the SDK can request from any figure. */
export const STATES = ['idle', 'walk', 'jump', 'fall', 'sit', 'lie', 'hang', 'sleep', 'drag', 'wave', 'talk', 'think'] as const;
export type StateName = (typeof STATES)[number];

export type Point = [x: number, y: number];
export type LocalizedText = string | Record<string, string>;

export interface Paint {
  /** Palette key, gradient key, or a literal color. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  lineCap?: 'butt' | 'round' | 'square';
  lineJoin?: 'miter' | 'round' | 'bevel';
  /** `multiply` and `screen` give soft shading and glow. */
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay';
}

export interface PathShape extends Paint {
  type: 'path';
  d: string;
}

export interface EllipseShape extends Paint {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Rotation in degrees around the center. */
  rotate?: number;
}

export type Shape = PathShape | EllipseShape;

export interface GradientStop {
  offset: number;
  color: string;
  opacity?: number;
}

export interface LinearGradient {
  type: 'linear';
  from: Point;
  to: Point;
  stops: GradientStop[];
}

export interface RadialGradient {
  type: 'radial';
  center: Point;
  radius: number;
  /** Optional focal point for an off-center highlight. */
  focus?: Point;
  stops: GradientStop[];
}

export type Gradient = LinearGradient | RadialGradient;

export interface Spring {
  /** Pull back toward rest, 0.01–1. */
  stiffness: number;
  /** Velocity kept per frame, 0–0.99. */
  damping: number;
  /** How strongly movement swings this part. */
  gain?: number;
  /** Maximum swing in degrees. */
  limit?: number;
  /** 0–1: how much the part keeps hanging when its bone tilts. */
  hang?: number;
}

export interface Part {
  id: string;
  bone: BoneName;
  /** Draw order across the whole figure; higher is in front. */
  z: number;
  /** `<slot>:<state>`; omit for always visible. */
  slot?: string;
  /** Pivot for springs, in viewBox coordinates. */
  pivot?: Point;
  spring?: Spring;
  /** Maximum offset in viewBox units when following the pointer (eyes). */
  look?: Point;
  /** Clip key from {@link RigFigure.clips}. */
  clip?: string;
  shapes: Shape[];
}

export interface Behavior {
  /** Relative weights for idle choices, e.g. `{ "sit": 3 }`. */
  weights?: Partial<Record<StateName | string, number>>;
  /** Walking speed multiplier, 0.25–3. */
  walkSpeed?: number;
  /** Jump strength multiplier, 0.25–3. */
  jumpPower?: number;
  /**
   * Custom idle: `book`, `cup` and `camera` are held in both hands
   * (`hand:book`, `hand:cup`, `hand:camera`), `gum` blows bubbles (`mouth:gum`, `mouth:gumBig`), `stretch`
   * is an occasional stretch and yawn.
   */
  idleProp?: 'book' | 'cup' | 'camera' | 'gum' | 'stretch' | 'none';
  /** `umbrella`: floats down slowly under an umbrella (`hand:umbrella`) when falling. */
  fallProp?: 'umbrella' | 'none';
}

interface FigureBase {
  format: typeof FIGURE_FORMAT;
  version: typeof FIGURE_VERSION;
  id: string;
  name: LocalizedText;
  description?: LocalizedText;
  author?: string;
  license?: string;
  /** Drawing coordinates: [minX, minY, width, height]. */
  viewBox: [number, number, number, number];
  /** Display height in CSS pixels at scale 1. */
  height: number;
  /** Point that rests on an edge, in viewBox coordinates. */
  anchor: Point;
  palette: Record<string, string>;
  behavior?: Behavior;
}

export interface RigFigure extends FigureBase {
  renderer: 'rig';
  skeleton: Record<BoneName, { pivot: Point }>;
  gradients?: Record<string, Gradient>;
  clips?: Record<string, Shape[]>;
  parts: Part[];
}

export interface SpriteAnimation {
  frames: number[];
  fps: number;
  loop?: boolean;
}

export interface SpriteFigure extends FigureBase {
  renderer: 'sprite';
  sprite: {
    /** `https:` URL or `data:image/png|webp|gif` URL. */
    image: string;
    frameWidth: number;
    frameHeight: number;
    columns: number;
    animations: Partial<Record<StateName, SpriteAnimation>> & { idle: SpriteAnimation };
  };
}

export type Figure = RigFigure | SpriteFigure;

/** Per-bone pose produced by the animator each frame. */
export interface BonePose {
  rotate?: number;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
}
export type Pose = Partial<Record<BoneName, BonePose>>;
