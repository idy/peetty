import { clamp } from '../math.ts';
import { BONES, HELD_PROPS, unitOf, type Behavior, type BonePose, type Pose, type RigFigure, type SlotName, type Soul, type StateName } from './types.ts';

/**
 * Procedural animation for the standard skeleton.
 *
 * What makes it read as natural rather than mechanical:
 * - every state change crossfades from the pose actually on screen;
 * - idle movement is driven by smooth noise, not a metronome;
 * - eyes turn first, the head follows a beat later;
 * - the walk cycle is driven by distance travelled, so feet do not slide;
 * - anticipation before actions, squash on landing scaled by impact;
 * - springs on hair and ribbons (in the renderer) provide follow-through.
 */

export interface MotionFrame {
  pose: Pose;
  slots: Partial<Record<SlotName, string>>;
  /** Whole-figure acceleration for springs, viewBox units/s². */
  push: [number, number];
  /** Small emote drawn above the head, if any. */
  emote: Emote | null;
  /** Gaze override (-1..1 per axis); null follows the pointer. */
  look: [number, number] | null;
  /** Hide everything below the anchor line, as if behind the perch edge. */
  cut: boolean;
  /** Her soul knocked out by a fright, if any; while it is out her eyes go blank. */
  soul: Soul | null;
}

export type Emote = 'note' | 'sweat' | 'alert' | 'sleep' | 'heart' | 'dizzy' | 'flash';
export type Mood = 'neutral' | 'happy' | 'worried';

/** Animation clocks that can be transferred to a replacement figure. */
export interface MotionPhase {
  state: StateName;
  /** Seconds since the current state began. */
  elapsed: number;
  /** Seconds on the continuous animation clock. */
  time: number;
  /** Walking cycles completed, with two steps per cycle. */
  walkPhase: number;
  /** How far a fright has knocked her soul out, 0..1; 0 when omitted. */
  soul?: number;
}

/** Figure measurements the edge poses need, in animation units. */
export interface Geometry {
  /** Drawing units per animation unit; see {@link unitOf}. */
  unit: number;
  /** The anchor line (feet). */
  anchor: number;
  /** Where the seat meets an edge when sitting. */
  seat: number;
  /** Chest line that rests on an edge when lying on it. */
  chest: number;
}

const DEFAULT_GEOMETRY: Geometry = { unit: 1, anchor: 256, seat: 212, chest: 162 };
const BLEND = 0.26;
const STRIDE = 30; // canonical animation units travelled per step
/** Seconds of falling before the fright shows, so short drops stay calm. */
const SOUL_DELAY = 0.12;
/** Seconds for her soul to drift out, and to slip back in. */
const SOUL_OUT = 0.35;
const SOUL_IN = 0.18;
/** Seconds her soul stays out after she lands. */
const SOUL_LINGER = 0.5;
const TAU = Math.PI * 2;
const wave = (t: number, period: number, phase = 0) => Math.sin((t / period) * TAU + phase);
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Overshoots past 1 and settles: used for pops and landings. */
const backOut = (x: number) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c = 2.2;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
};

/** Smooth 1D value noise in -1..1, deterministic per seed. */
export function noise(t: number, seed = 0): number {
  const hash = (n: number) => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const i = Math.floor(t);
  const u = ease(t - i);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
const drift = (t: number, seed: number) => noise(t, seed) * 0.65 + noise(t * 2.3, seed + 9) * 0.35;

const DEFAULTS: Required<BonePose> = { rotate: 0, x: 0, y: 0, sx: 1, sy: 1 };
const FIELDS = Object.keys(DEFAULTS) as (keyof BonePose)[];

function mix(from: Pose, to: Pose, k: number): Pose {
  const out: Pose = {};
  for (const bone of BONES) {
    const a = from[bone];
    const b = to[bone];
    if (!a && !b) continue;
    const p: BonePose = {};
    for (const field of FIELDS) {
      const va = a?.[field] ?? DEFAULTS[field];
      const vb = b?.[field] ?? DEFAULTS[field];
      p[field] = va + (vb - va) * k;
    }
    out[bone] = p;
  }
  return out;
}

export class Motion {
  private state: StateName = 'idle';
  private since = 0;
  private time = 0;
  private nextBlink = 1.5;
  private blinkUntil = 0;
  private doubleBlink = false;
  private talkFlip = 0;
  private talkShape = 'talk';
  private mood: Mood = 'neutral';
  private impact = 0;
  private landed = false;
  /** How far her soul is out of her mouth, 0..1. */
  private soul = 0;
  private soulLinger = 0;
  /** A fall frightens her while this is on; `play('fall')` turns it back on. */
  private fright = true;
  private alertUntil = -1;
  private walkPhase = 0;
  private walkSpeed: number | null = null;
  private gaze: [number, number] = [0, 0];
  private headTurn = 0;
  private last: Pose = {};
  private from: Pose = {};
  private lastSlots: MotionFrame['slots'] = {};
  private fromSlots: MotionFrame['slots'] = {};
  private blend = BLEND;
  private readonly calm: number;
  private readonly speed: number;
  private readonly prop: Behavior['idleProp'];
  /** The idle prop she holds in both hands, if any. */
  private readonly held: (typeof HELD_PROPS)[number] | null;
  private readonly fallProp: Behavior['fallProp'];
  private readonly random: () => number;
  private readonly geometry: Geometry;
  private readonly unit: number;
  private readonly seed: number;

  constructor(behavior?: Behavior, random: () => number = Math.random, geometry: Geometry = DEFAULT_GEOMETRY) {
    this.random = random;
    this.speed = behavior?.walkSpeed ?? 1;
    this.calm = 1 / clamp(this.speed, 0.6, 1.4);
    this.prop = behavior?.idleProp ?? 'none';
    this.held = HELD_PROPS.find((prop) => prop === this.prop) ?? null;
    this.fallProp = behavior?.fallProp ?? 'none';
    this.geometry = geometry;
    this.unit = geometry.unit;
    this.seed = Math.floor(random() * 1000);
  }

  get current(): StateName {
    return this.state;
  }

  get phase(): MotionPhase {
    return { state: this.state, elapsed: this.since, time: this.time, walkPhase: this.walkPhase, soul: this.soul };
  }

  /** Plays a state; a fall frightens her unless {@link setFright} turns that off. */
  play(state: StateName): void {
    if (state === 'fall') this.fright = true;
    if (state === this.state) return;
    // A jump's crouch must read immediately; other changes ease in.
    this.begin(state, state === 'jump' ? 0.08 : BLEND);
    this.landed = false;
  }

  /** Continues another figure's animation without replaying its transition. */
  resume(phase: MotionPhase): void {
    this.begin(phase.state, 0);
    this.since = phase.elapsed;
    this.time = phase.time;
    this.walkPhase = phase.walkPhase;
    this.soul = phase.soul ?? 0;
    if (phase.state === 'fall') this.fright = true;
    this.landed = false;
  }

  /**
   * Whether the current fall frightens her: once it has lasted a moment, her soul
   * slips out, unless she floats under an umbrella. `play('fall')` turns it on;
   * hosts may switch it at any time, such as off for a calm drop.
   */
  setFright(on: boolean): void {
    this.fright = on;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  /** Where the pointer is, -1..1; the head follows the eyes with a lag. */
  setGaze(x: number, y: number): void {
    this.gaze = [x, y];
  }

  /** Horizontal walking speed in viewBox units/s; null uses the figure's own pace. */
  setWalkSpeed(unitsPerSecond: number | null): void {
    this.walkSpeed = unitsPerSecond === null ? null : unitsPerSecond / this.unit;
  }

  /**
   * Ends a fall or jump with a squash. `impact` 0..1 scales the squash;
   * a hard landing (above 0.85) leaves her briefly dizzy.
   */
  land(impact = 0.5): void {
    // Impacts are instant: no crossfade, or the squash would be swallowed.
    this.begin('idle', 0);
    this.landed = true;
    this.impact = clamp(impact, 0, 1);
    // A soul that got out stays out a moment longer, then slips back in.
    this.soulLinger = this.soul > 0.2 ? SOUL_LINGER : 0;
  }

  /** A short startled "!" over her head. */
  exclaim(): void {
    this.alertUntil = this.time + 0.9;
  }

  update(dt: number): MotionFrame {
    this.time += dt;
    this.since += dt;
    const t = this.time;
    const s = this.since;
    const c = this.calm;
    const g = this.geometry;
    const pose: Pose = {};
    const slots: MotionFrame['slots'] = { eyes: 'open', mouth: 'smile', brows: 'calm', hand: 'rest', armL: 'rest', armR: 'rest' };
    let push: [number, number] = [0, 0];
    let emote: Emote | null = null;
    let look: [number, number] | null = null;
    let cut = false;

    // Eyes move instantly (renderer); the head turns toward them a beat later.
    const turnTarget = clamp(this.gaze[0], -1, 1) * 5;
    this.headTurn += (turnTarget - this.headTurn) * (1 - Math.exp(-dt * 2.6));

    // Breathing plus noise-driven sway runs under every state.
    const breath = wave(t, 3.4 * c);
    const n = t / (2.2 * c);
    pose.body = { sy: 1 + breath * 0.012, sx: 1 - breath * 0.004, rotate: drift(n, this.seed) * 1.1 };
    pose.head = { rotate: drift(n * 0.8, this.seed + 3) * 3 + this.headTurn, y: breath * -0.4 };
    // Arms are drawn in natural poses; the bones only add small whole-arm
    // rotations, so nothing bends or stretches unnaturally.
    pose.armL = { rotate: 1.5 + drift(n, this.seed + 5) * 1.5 };
    pose.armR = { rotate: -1.5 - drift(n, this.seed + 7) * 1.5 };
    pose.hips = { x: drift(n * 0.6, this.seed + 11) * 0.6 };

    if (this.mood === 'happy') {
      slots.eyes = 'happy';
      slots.mouth = 'open';
      pose.head.rotate = (pose.head.rotate ?? 0) + 6;
    } else if (this.mood === 'worried') {
      slots.brows = 'worried';
      slots.mouth = 'o';
    }

    const heldProp = this.mood === 'neutral' ? this.held : null;
    const reading = heldProp === 'book';

    // A fall frightens her soul out of her mouth; it lingers after landing, then slips back in.
    const frightened = this.state === 'fall'
      ? this.fright && this.fallProp !== 'umbrella' && s > SOUL_DELAY
      : this.landed && this.state === 'idle' && s < this.soulLinger;
    this.soul = frightened ? Math.min(1, this.soul + dt / SOUL_OUT) : Math.max(0, this.soul - dt / SOUL_IN);

    switch (this.state) {
      case 'idle':
        if (heldProp) {
          slots.hand = heldProp;
          slots.armL = slots.armR = 'bent';
          pose.armL = { rotate: breath * 0.6 };
          pose.armR = { rotate: -breath * 0.6 };
        }
        if (reading) {
          // Reading: hands meet at the book, head bows, eyes scan the lines.
          pose.head.rotate = (pose.head.rotate ?? 0) * 0.3 + 3;
          pose.head.y = (pose.head.y ?? 0) + 1.6;
          look = [((t * 0.45) % 1) * 1.6 - 0.8, 0.9];
        } else if (this.prop === 'stretch' && this.mood === 'neutral') {
          // Every so often: a big stretch with a yawn.
          const period = 14 * c;
          const cycle = (t % period) - (period - 2.2);
          if (cycle > 0) {
            const k = Math.sin((cycle / 2.2) * Math.PI);
            if (k > 0.2) {
              slots.armL = slots.armR = 'up';
              const lift = ease((k - 0.2) / 0.8);
              pose.armL = { rotate: -25 * (1 - lift) + 12 * lift };
              pose.armR = { rotate: 25 * (1 - lift) - 12 * lift };
            } else {
              pose.armL = { rotate: 30 * k };
              pose.armR = { rotate: -30 * k };
            }
            pose.root = { sy: 1 + 0.05 * k, sx: 1 - 0.03 * k };
            pose.head.rotate = (pose.head.rotate ?? 0) * 0.3 - 3 * k;
            slots.eyes = k > 0.25 ? 'closed' : 'open';
            slots.mouth = k > 0.35 ? 'open' : 'smile';
          }
        } else if (heldProp === 'cup') {
          // Both hands around a warm drink; a sip now and then, then a happy sigh.
          const period = 7 * c;
          const phase = t % period;
          if (phase > period - 1.6) {
            const dip = Math.sin(((phase - (period - 1.6)) / 1.6) * Math.PI);
            pose.head.rotate = (pose.head.rotate ?? 0) * 0.4 + 5 * dip;
            pose.head.y = (pose.head.y ?? 0) + 2.5 * dip;
            slots.eyes = 'closed';
            slots.mouth = 'flat';
          } else if (phase < 1 && t > period) {
            slots.eyes = 'happy';
            emote = 'heart';
          }
        } else if (heldProp === 'camera') {
          // Holds her camera; now and then leans in, snaps a photo, and is pleased.
          const period = 8 * c;
          const phase = t % period;
          if (phase > period - 1.4) {
            const lean = ease((phase - (period - 1.4)) / 0.4);
            pose.head.rotate = (pose.head.rotate ?? 0) * 0.4 + 4 * lean;
            pose.head.y = (pose.head.y ?? 0) + 1.5 * lean;
            look = [0, 0.3];
            slots.mouth = 'flat';
            if (phase > period - 0.45) {
              emote = 'flash';
              slots.eyes = 'closed';
              pose.root = { sy: 0.98, sx: 1.01 };
            }
          } else if (phase < 1.1 && t > period) {
            slots.eyes = 'happy';
            slots.mouth = 'open';
          }
        } else if (this.prop === 'gum' && this.mood === 'neutral') {
          // Blows a bubble bigger and bigger until it pops.
          const period = 10 * c;
          const k = (t % period) - (period - 2.4);
          if (k > 0) {
            if (k < 0.8) slots.mouth = 'gum';
            else if (k < 1.9) {
              slots.mouth = 'gumBig';
              if (k > 1.5) slots.eyes = 'closed';
            } else {
              slots.mouth = 'o';
              slots.eyes = 'closed';
              emote = 'alert';
              pose.head.rotate = (pose.head.rotate ?? 0) + wave(k, 0.2) * 3;
              pose.root = { sy: 0.97, sx: 1.02 };
            }
          }
        }
        break;

      case 'wave': {
        // Anticipation dip, then the raised arm pops up past its pose and waves.
        const up = backOut(ease((s - 0.06) / 0.3));
        const flap = wave(s, 0.44) * 9 * ease((s - 0.3) / 0.2);
        if (s > 0.06) slots.armR = 'up';
        pose.armR = s > 0.06 ? { rotate: (1 - up) * 45 + flap } : { rotate: -6 * ease(s / 0.06) };
        pose.armL = { rotate: 3 };
        pose.head.rotate = (pose.head.rotate ?? 0) - 7 * up;
        pose.body.rotate = (pose.body.rotate ?? 0) - 2.5 * up;
        slots.eyes = 'happy';
        slots.mouth = 'open';
        if (s < 1.6) emote = 'note';
        break;
      }

      case 'talk': {
        this.talkFlip -= dt;
        if (this.talkFlip <= 0) {
          this.talkFlip = 0.07 + this.random() * 0.09;
          const r = this.random();
          this.talkShape = r < 0.45 ? 'talk' : r < 0.75 ? 'open' : r < 0.9 ? 'o' : 'smile';
        }
        slots.mouth = this.talkShape;
        pose.head.rotate = (pose.head.rotate ?? 0) + wave(t, 1.3) * 3;
        pose.head.y = (pose.head.y ?? 0) + Math.abs(wave(t, 0.36)) * -0.8;
        pose.armL = { rotate: 3 + wave(t, 1.1) * 3 };
        break;
      }

      case 'think':
        pose.head.rotate = (pose.head.rotate ?? 0) * 0.4 - 9;
        // Arms folded in front, head tilted, eyes up: a hand on the chin
        // would need longer forearms than a chibi has.
        slots.armL = slots.armR = 'bent';
        pose.armL = { rotate: -3 };
        pose.armR = { rotate: 3 + wave(t, 3.1) * 1.2 };
        slots.mouth = 'flat';
        slots.brows = 'worried';
        look = [0.5, -0.8];
        break;

      case 'sleep': {
        // Slow, deep breathing with a drooping head and a small nod.
        const deep = wave(t, 4.6);
        pose.body = { sy: 1 + deep * 0.02, sx: 1 - deep * 0.006, rotate: -2 };
        pose.head = { rotate: 11 + wave(t, 4.6, 0.6) * 2.5, y: 2.5 + deep * 0.8 };
        pose.armL = { rotate: 1 };
        pose.armR = { rotate: -1 };
        slots.eyes = 'sleepy';
        slots.mouth = 'o';
        emote = 'sleep';
        break;
      }

      case 'walk': {
        // Phase follows distance, so each step covers what the feet push.
        const speed = this.walkSpeed ?? 44 * this.speed;
        this.walkPhase += (Math.abs(speed) * dt) / (STRIDE * 2);
        const phase = this.walkPhase * TAU;
        const swing = Math.sin(phase);
        const bob = Math.abs(Math.sin(phase));
        pose.legL = { rotate: swing * 18 };
        pose.legR = { rotate: -swing * 18 };
        pose.armL = { rotate: 2 - swing * 9 };
        pose.armR = { rotate: -2 + swing * 9 };
        pose.hips = { y: -bob * 3.2, rotate: swing * 2 };
        pose.body = { ...pose.body, rotate: 3 + swing * 1.5 };
        // The head bobs slightly after the body.
        pose.head = { ...pose.head, rotate: (pose.head.rotate ?? 0) - Math.sin(phase - 0.6) * 2.5, y: Math.abs(Math.sin(phase - 0.5)) * 0.9 };
        push = [Math.cos(phase) * 160, 0];
        break;
      }

      case 'jump': {
        // Crouch (anticipation) → stretch on takeoff → tuck in the air.
        const crouch = ease(s / 0.16);
        const air = ease((s - 0.16) / 0.12);
        const sy = 1 - 0.14 * crouch + 0.24 * air;
        const sx = 1 + 0.1 * crouch - 0.12 * air;
        pose.root = { sy: Math.max(0.8, sy - 0.1 * ease((s - 0.4) / 0.2)), sx };
        // Arms swing out on the crouch and up for the leap.
        if (air > 0.3) {
          slots.armL = slots.armR = 'up';
          pose.armL = { rotate: -40 * (1 - air) };
          pose.armR = { rotate: 40 * (1 - air) };
        } else {
          pose.armL = { rotate: 22 * crouch };
          pose.armR = { rotate: -22 * crouch };
        }
        pose.legL = { rotate: -10 * air };
        pose.legR = { rotate: 14 * air };
        slots.eyes = s < 0.16 ? 'closed' : 'open';
        slots.mouth = 'open';
        push = [0, air > 0 && air < 1 ? -2200 : 0];
        break;
      }

      case 'fall': {
        if (this.fallProp === 'umbrella') {
          // Floats down under her umbrella: calm, feet swinging gently.
          slots.hand = 'umbrella';
          slots.armR = 'up';
          pose.armR = { rotate: wave(t, 1.6) * 4 };
          pose.armL = { rotate: 8 + wave(t, 1.6, 1) * 3 };
          pose.legL = { rotate: wave(t, 1.4) * 8 };
          pose.legR = { rotate: wave(t, 1.4, 1.2) * 8 };
          if (s > 0.4) emote = 'note';
          break;
        }
        // Flailing, until her soul is out and she goes limp.
        const flail = 1 - this.soul * 0.75;
        slots.armL = slots.armR = 'up';
        pose.armL = { rotate: -8 + wave(t, 0.3) * 9 * flail };
        pose.armR = { rotate: 8 - wave(t, 0.3, 1.4) * 9 * flail };
        pose.legL = { rotate: wave(t, 0.4) * 12 * flail };
        pose.legR = { rotate: -wave(t, 0.4) * 12 * flail };
        slots.mouth = 'o';
        slots.brows = 'worried';
        emote = 'sweat';
        break;
      }

      case 'drag': {
        // Dangling: legs kick and raised arms flail beside the head.
        slots.armL = slots.armR = 'up';
        pose.armL = { rotate: -12 + wave(t, 0.34) * 10 };
        pose.armR = { rotate: 12 - wave(t, 0.34, 1.3) * 10 };
        pose.legL = { rotate: wave(t, 0.28) * 22 };
        pose.legR = { rotate: wave(t, 0.28, Math.PI) * 22 };
        pose.body = { rotate: wave(t, 0.9) * 5 };
        slots.brows = 'worried';
        slots.mouth = 'o';
        slots.eyes = wave(t, 1.8) > 0.6 ? 'closed' : 'open';
        emote = 'sweat';
        break;
      }

      case 'sit': {
        // Seat on the edge; thighs foreshorten toward the viewer, feet swing
        // over the edge in turn.
        pose.root = { y: g.anchor - g.seat };
        pose.legL = { sy: 0.8, rotate: drift(t / 1.4, this.seed + 13) * 10 + wave(t, 1.7 * c) * 8 };
        pose.legR = { sy: 0.8, rotate: drift(t / 1.4, this.seed + 17) * 10 + wave(t, 1.7 * c, 2.2) * 8 };
        pose.armL = { rotate: 5 };
        pose.armR = { rotate: -5 };
        if (heldProp) {
          slots.hand = heldProp;
          slots.armL = slots.armR = 'bent';
          pose.armL = { rotate: 0 };
          pose.armR = { rotate: 0 };
          pose.head.rotate = (pose.head.rotate ?? 0) * 0.3 + 3;
          if (reading) look = [((t * 0.45) % 1) * 1.6 - 0.8, 0.9];
        }
        break;
      }

      case 'lie': {
        // Lying on top of an element: everything below the chest is behind
        // the edge, chin on folded arms, feet kicking up behind her.
        cut = true;
        pose.root = { y: g.anchor - g.chest };
        slots.armL = slots.armR = 'fold';
        pose.armL = { rotate: breath * 0.8 };
        pose.armR = { rotate: -breath * 0.8 };
        pose.head = { ...pose.head, y: (pose.head.y ?? 0) + 5, rotate: (pose.head.rotate ?? 0) + 6 + wave(t, 4.2 * c) * 3 };
        pose.body = { ...pose.body, sy: 0.96 + breath * 0.01 };
        const kick = wave(t, 1.1 * c);
        // Feet peek out beside her shoulder, behind the body.
        const lift = -(g.anchor - g.chest) - 26;
        pose.legL = { rotate: -150 + kick * 18, x: 60, y: lift };
        pose.legR = { rotate: -164 - kick * 18, x: 50, y: lift - 6 };
        // Lying around is contented: a soft smile, now and then a little hum.
        if (this.mood === 'neutral' && wave(t, 9) > 0.85) slots.mouth = 'talk';
        break;
      }

      case 'hang': {
        // Clinging to an edge: forearms folded over it, chin just above,
        // the body dangling in front of the element with kicking feet.
        // (Chibi arms are too short to hang at full stretch.)
        pose.root = { y: g.anchor - g.chest };
        slots.armL = slots.armR = 'fold';
        const swing = wave(t, 1.3) * Math.exp(-s * 0.6);
        pose.armL = { rotate: -swing * 2 };
        pose.armR = { rotate: -swing * 2 };
        pose.head = { ...pose.head, y: (pose.head.y ?? 0) + 4, rotate: (pose.head.rotate ?? 0) * 0.5 };
        pose.hips = { rotate: swing * 5 };
        pose.legL = { rotate: wave(t, 0.5) * 14 };
        pose.legR = { rotate: wave(t, 0.5, Math.PI) * 14 };
        slots.brows = 'worried';
        slots.mouth = s > 1.2 ? 'flat' : 'o';
        emote = 'sweat';
        break;
      }
    }

    // Landing pop: squash then spring back with overshoot, scaled by impact.
    if (this.landed && this.state === 'idle') {
      const duration = 0.35 + this.impact * 0.25;
      if (s < duration) {
        const k = backOut(s / duration);
        const depth = 0.08 + this.impact * 0.16;
        pose.root = { sy: 1 - depth + depth * k, sx: 1 + depth * 0.7 - depth * 0.7 * k };
      }
      if (this.impact > 0.85 && s < 1.6) {
        emote = 'dizzy';
        slots.eyes = 'closed';
        pose.head.rotate = (pose.head.rotate ?? 0) + wave(s, 0.5) * 6;
      }
    }

    if (t < this.alertUntil) {
      emote = 'alert';
      slots.eyes = 'open';
      slots.mouth = 'o';
    }

    // With her soul out the eyes go blank (the renderer hides the irises) and her mouth hangs open.
    if (this.soul > 0) {
      slots.eyes = 'open';
      slots.mouth = 'o';
      emote = null;
    }

    // Natural blinking, sometimes twice; never over closed, happy or blank eyes.
    if (slots.eyes === 'open' && !this.soul) {
      if (t >= this.nextBlink) {
        this.blinkUntil = t + 0.11;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.nextBlink = t + 0.24;
        } else {
          this.doubleBlink = this.random() < 0.22;
          this.nextBlink = t + (2.2 + this.random() * 3.6) * c;
        }
      }
      if (t < this.blinkUntil) slots.eyes = 'closed';
    }

    // Arm drawings swap halfway through a crossfade, when the old and new
    // rotations meet, so the change reads as one movement.
    if (s < this.blend * 0.5) {
      if (this.fromSlots.armL) slots.armL = this.fromSlots.armL;
      if (this.fromSlots.armR) slots.armR = this.fromSlots.armR;
    }
    this.lastSlots = { ...slots };

    // Crossfade from the pose on screen when the state changed.
    const output = s < this.blend ? mix(this.from, pose, ease(s / this.blend)) : pose;
    this.last = output;
    // Retain canonical poses for future blends; only the renderer receives drawing units.
    let rendered = output;
    if (this.unit !== 1) {
      rendered = {};
      for (const bone of BONES) {
        const p = output[bone];
        if (!p) continue;
        const scaled = { ...p };
        if (scaled.x !== undefined) scaled.x *= this.unit;
        if (scaled.y !== undefined) scaled.y *= this.unit;
        rendered[bone] = scaled;
      }
    }
    // The soul's drift stays in animation units; the renderer scales it with the figure.
    const soul: Soul | null = this.soul > 0 ? { out: ease(this.soul), drift: [wave(t, 1.7) * 4, wave(t, 1.1, 1) * 3] } : null;
    return { pose: rendered, slots, push: [push[0] * this.unit, push[1] * this.unit], emote, look, cut, soul };
  }

  private begin(state: StateName, blend: number) {
    this.from = this.last;
    this.fromSlots = { ...this.lastSlots };
    this.blend = blend;
    this.state = state;
    this.since = 0;
  }
}

/** Measures a rig figure for the edge poses, in animation units. */
export function geometryOf(figure: Pick<RigFigure, 'anchor' | 'skeleton' | 'viewBox'>): Geometry {
  const unit = unitOf(figure.viewBox);
  const shoulder = figure.skeleton.armL.pivot[1] / unit;
  const hip = figure.skeleton.legL.pivot[1] / unit;
  return { unit, anchor: figure.anchor[1] / unit, seat: hip + 4, chest: shoulder + 16 };
}
