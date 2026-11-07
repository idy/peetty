import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { geometryOf, Motion, type MotionFrame, type MotionPhase } from '../src/figure/motion.ts';
import { BONES, STATES, type Behavior, type BoneName, type RigFigure } from '../src/figure/types.ts';

const PIVOTS: Record<BoneName, [number, number]> = {
  root: [100, 256], hips: [100, 198], body: [100, 194], head: [100, 134],
  armL: [77, 146], armR: [123, 146], legL: [93, 208], legR: [107, 208],
};

function rig(unit = 1, origin: [number, number] = [0, 0]): Pick<RigFigure, 'viewBox' | 'anchor' | 'skeleton'> {
  const [ox, oy] = origin;
  return {
    viewBox: [ox, oy, 200 * unit, 260 * unit],
    anchor: [100 * unit + ox, 256 * unit + oy],
    skeleton: Object.fromEntries(BONES.map((bone) => {
      const [x, y] = PIVOTS[bone];
      return [bone, { pivot: [x * unit + ox, y * unit + oy] }];
    })) as RigFigure['skeleton'],
  };
}

function motion(unit = 1, behavior?: Behavior, origin?: [number, number]): Motion {
  return new Motion(behavior, () => 0.5, geometryOf(rig(unit, origin)));
}

function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} should equal ${expected}`);
}

/** Equal poses after the SVG's drawing-to-display conversion. */
function equivalent(actual: MotionFrame, expected: MotionFrame, unit: number): void {
  for (const bone of BONES) {
    const a = actual.pose[bone];
    const e = expected.pose[bone];
    assert.equal(!!a, !!e, `${bone} is present in both poses`);
    for (const field of ['rotate', 'x', 'y', 'sx', 'sy'] as const) {
      const av = a?.[field];
      const ev = e?.[field];
      assert.equal(av === undefined, ev === undefined, `${bone}.${field} is present in both poses`);
      if (av !== undefined && ev !== undefined) {
        near(av / (field === 'x' || field === 'y' ? unit : 1), ev, `${bone}.${field}`);
      }
    }
  }
  near(actual.push[0] / unit, expected.push[0], 'push.x');
  near(actual.push[1] / unit, expected.push[1], 'push.y');
  assert.equal(!!actual.soul, !!expected.soul, 'soul is out in both');
  if (actual.soul && expected.soul) {
    near(actual.soul.out, expected.soul.out, 'soul.out');
    // Drift stays in animation units; the renderer scales it.
    near(actual.soul.drift[0], expected.soul.drift[0], 'soul.drift.x');
    near(actual.soul.drift[1], expected.soul.drift[1], 'soul.drift.y');
  }
  assert.deepEqual(actual.slots, expected.slots);
  assert.deepEqual(actual.look, expected.look);
  assert.equal(actual.emote, expected.emote);
  assert.equal(actual.cut, expected.cut);
}

const BEHAVIORS: (Behavior | undefined)[] = [
  undefined,
  { idleProp: 'book' }, { idleProp: 'cup' }, { idleProp: 'camera' },
  { idleProp: 'stretch' }, { idleProp: 'gum' }, { fallProp: 'umbrella' },
];

describe('Motion drawing units', () => {
  for (const unit of [0.1, 2.5]) {
    it(`keeps every state, crossfade and push equivalent at scale ${unit}`, () => {
      for (const behavior of BEHAVIORS) {
        const original = motion(1, behavior);
        const scaled = motion(unit, behavior);
        original.setGaze(0.6, -0.3);
        scaled.setGaze(0.6, -0.3);
        for (const state of STATES) {
          original.play(state);
          scaled.play(state);
          for (const dt of [0.04, 0.09, 0.07, 0.13, 0.8]) {
            equivalent(scaled.update(dt), original.update(dt), unit);
          }
        }
        original.land(0.95);
        scaled.land(0.95);
        for (const dt of [0.02, 0.15, 0.3, 1]) equivalent(scaled.update(dt), original.update(dt), unit);
      }
    });

    it(`normalizes timed idle gestures at scale ${unit}`, () => {
      for (const behavior of BEHAVIORS) {
        const original = motion(1, behavior);
        const scaled = motion(unit, behavior);
        // Covers sipping, taking a photo, blowing gum and the periodic stretch.
        for (const dt of [0.3, 5.5, 1, 1.4, 0.4, 0.5, 3.5, 1]) {
          equivalent(scaled.update(dt), original.update(dt), unit);
        }
      }
    });

    it(`converts external walking speed while retaining the default pace at scale ${unit}`, () => {
      const behavior = { walkSpeed: 1.2 };
      const original = motion(1, behavior);
      const scaled = motion(unit, behavior);
      original.play('walk');
      scaled.play('walk');
      let cycles = 0;
      for (const speed of [90, -120, 0, null]) {
        original.setWalkSpeed(speed);
        scaled.setWalkSpeed(speed === null ? null : speed * unit);
        equivalent(scaled.update(0.2), original.update(0.2), unit);
        cycles += Math.abs(speed ?? 44 * behavior.walkSpeed) * 0.2 / 60;
        near(scaled.phase.walkPhase, cycles, 'distance-driven walking cycles');
      }
    });

    it(`measures edges in animation units and scales lying offsets and acceleration at scale ${unit}`, () => {
      const measured = geometryOf(rig(unit));
      assert.deepEqual(Object.keys(measured).sort(), ['anchor', 'chest', 'seat', 'unit']);
      assert.equal(measured.unit, unit);
      near(measured.anchor, 256, 'anchor');
      near(measured.seat, 212, 'seat');
      near(measured.chest, 162, 'chest');
      const animator = motion(unit);
      animator.play('sit');
      near(animator.update(0.3).pose.root!.y! / unit, 44, 'seated root');
      animator.play('lie');
      const lying = animator.update(0.3);
      near(lying.pose.root!.y! / unit, 94, 'lying root');
      near(lying.pose.legL!.x! / unit, 60, 'lying left leg x');
      near(lying.pose.legR!.x! / unit, 50, 'lying right leg x');
      near(lying.pose.legL!.y! / unit, -120, 'lying left leg y');
      near(lying.pose.legR!.y! / unit, -126, 'lying right leg y');
      animator.play('jump');
      near(animator.update(0.2).push[1], -2200 * unit, 'takeoff acceleration in drawing units');
    });
  }

  it('supports a shifted viewBox origin', () => {
    const original = motion();
    const shifted = motion(0.1, undefined, [13, -9]);
    for (const state of ['sit', 'lie', 'hang'] as const) {
      original.play(state);
      shifted.play(state);
      equivalent(shifted.update(0.3), original.update(0.3), 0.1);
    }
  });

  it('retains the default geometry behavior for the canonical preset size', () => {
    for (const behavior of BEHAVIORS) {
      const defaults = new Motion(behavior, () => 0.5);
      const preset = motion(1, behavior);
      for (const state of STATES) {
        defaults.play(state);
        preset.play(state);
        assert.deepEqual(preset.update(0.3), defaults.update(0.3));
      }
    }
  });
});

describe('held idle props', () => {
  for (const prop of ['book', 'cup', 'camera'] as const) {
    it(`holds ${prop} in neutral and releases it when the mood changes`, () => {
      const animator = motion(1, { idleProp: prop });
      const holding = animator.update(0.3);
      assert.equal(holding.slots.hand, prop);
      assert.equal(holding.slots.armL, 'bent');
      assert.equal(holding.slots.armR, 'bent');
      near(holding.pose.armL!.rotate!, -holding.pose.armR!.rotate!, 'both arms breathe together');
      for (const mood of ['happy', 'worried'] as const) {
        animator.setMood(mood);
        const released = animator.update(0.3);
        assert.equal(released.slots.hand, 'rest');
        assert.equal(released.slots.armL, 'rest');
        assert.equal(released.slots.armR, 'rest');
      }
    });
  }
});

describe('fright', () => {
  it('knocks her soul out on a fall, blanks her face, and lets it slip back after landing', () => {
    const animator = motion();
    animator.play('fall');
    assert.equal(animator.update(0.05).soul, null, 'a short drop stays calm');
    const scared = animator.update(0.5);
    assert.ok(scared.soul && scared.soul.out > 0.9, 'fully out after half a second');
    assert.deepEqual([scared.slots.eyes, scared.slots.mouth, scared.emote], ['open', 'o', null]);
    for (let i = 0; i < 300; i++) assert.equal(animator.update(1 / 60).slots.eyes, 'open', 'blank eyes never blink');
    animator.land(0.95);
    assert.ok(animator.update(0.3).soul, 'it lingers just after landing');
    let frame = animator.update(1 / 60);
    for (let i = 0; frame.soul && i < 120; i++) frame = animator.update(1 / 60);
    assert.equal(frame.soul, null, 'back in');
    assert.equal(frame.emote, 'dizzy', 'a hard landing still leaves her dizzy');
  });

  it('keeps her soul in with the fright off and under an umbrella', () => {
    const cases: [Behavior | undefined, boolean][] = [[undefined, false], [{ fallProp: 'umbrella' }, true]];
    for (const [behavior, fright] of cases) {
      const animator = motion(1, behavior);
      animator.play('fall');
      animator.setFright(fright);
      for (let i = 0; i < 60; i++) assert.equal(animator.update(1 / 60).soul, null);
    }
  });

  it('lets the host switch the fright during a fall without restarting it', () => {
    const animator = motion();
    animator.play('fall');
    animator.setFright(false);
    for (let i = 0; i < 20; i++) assert.equal(animator.update(1 / 60).soul, null, 'calm while the fright is off');
    animator.setFright(true);
    assert.ok(animator.update(1 / 60).soul, 'frightened at once: the fall has already lasted long enough');
    animator.setFright(false);
    let frame = animator.update(1 / 60);
    for (let i = 0; frame.soul && i < 60; i++) frame = animator.update(1 / 60);
    assert.equal(frame.soul, null, 'her soul slips back in while she is still falling');
    animator.play('fall');
    assert.ok(animator.update(1 / 60).soul, "play('fall') turns the fright back on");
    assert.ok(animator.phase.elapsed > 0.3, 'without restarting the fall');
    animator.update(0.3);
    animator.land(0.3);
    animator.setFright(false);
    assert.ok(animator.update(0.3).soul, 'the soul still lingers after landing');
  });

  it('carries her soul over to a replacement figure, where a fall frightens her again', () => {
    const scared = motion();
    scared.play('fall');
    scared.update(0.3);
    assert.ok(scared.phase.soul! > 0.3);
    const replacement = motion(0.1);
    replacement.resume(scared.phase);
    equivalent(replacement.update(0.1), scared.update(0.1), 0.1);
    const dropping = motion();
    dropping.play('fall');
    dropping.setFright(false);
    dropping.update(0.2);
    const resumed = motion();
    resumed.resume(dropping.phase);
    assert.ok(resumed.update(1 / 60).soul, 'resuming a fall turns the fright on');
    const calm = motion();
    calm.resume(dropping.phase);
    calm.setFright(false);
    for (let i = 0; i < 30; i++) assert.equal(calm.update(1 / 60).soul, null, 'until the host turns it off again');
  });
});

describe('Motion phase transfer', () => {
  for (const state of ['jump', 'sleep', 'drag', 'walk'] as const) {
    it(`continues ${state} on a replacement figure without restarting its phase`, () => {
      const original = motion();
      original.update(0.8);
      original.play(state);
      const before = original.update(0.45);
      const phase: MotionPhase = original.phase;
      assert.deepEqual(Object.keys(phase), ['state', 'elapsed', 'time', 'walkPhase', 'soul']);
      assert.equal(phase.state, state);
      near(phase.elapsed, 0.45, 'elapsed state time');
      near(phase.time, 1.25, 'continuous time');
      if (state === 'walk') assert.ok(phase.walkPhase > 0);
      const saved = { ...phase };
      const replacement = motion(0.1);
      replacement.resume(phase);
      assert.deepEqual(replacement.phase, phase);
      equivalent(replacement.update(0), before, 0.1);
      equivalent(replacement.update(0.12), original.update(0.12), 0.1);
      assert.deepEqual(phase, saved, 'phase snapshots do not change when animation advances');
      assert.deepEqual(replacement.phase, original.phase);
    });
  }

  it('keeps play transitions and same-state no-ops unchanged', () => {
    const animator = motion();
    animator.update(0.8);
    animator.play('jump');
    assert.equal(animator.phase.elapsed, 0);
    assert.ok(animator.update(0.15).pose.root!.sy! < 0.9, 'a new jump still crouches');
    const phase = animator.phase;
    animator.play('jump');
    assert.deepEqual(animator.phase, phase);
    animator.play('sleep');
    assert.equal(animator.phase.elapsed, 0);
    assert.equal(animator.phase.time, phase.time);
    assert.equal(animator.phase.walkPhase, phase.walkPhase);
  });
});
