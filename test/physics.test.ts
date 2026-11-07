import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { along, impact, landing, planJump, weighted } from '../src/pet/physics.ts';

describe('planJump', () => {
  it('lands exactly on the target, up or down', () => {
    for (const [from, to] of [[[100, 500], [320, 380]], [[400, 300], [150, 560]], [[200, 400], [260, 400]]] as [[number, number], [number, number]][]) {
      const plan = planJump(from, to)!;
      assert.ok(plan, `${from} -> ${to}`);
      const [x, y] = along(from, plan, plan.duration);
      assert.ok(Math.abs(x - to[0]) < 0.01 && Math.abs(y - to[1]) < 0.01, `ended at ${x},${y}`);
    }
  });

  it('clears the higher point by its apex', () => {
    const from: [number, number] = [0, 500];
    const plan = planJump(from, [200, 400])!;
    let top = Infinity;
    for (let t = 0; t <= plan.duration; t += 0.005) top = Math.min(top, along(from, plan, t)[1]);
    assert.ok(Math.abs(400 - top - plan.apex) < 2);
  });

  it('refuses targets out of reach and allows more with power', () => {
    assert.equal(planJump([0, 800], [100, 300]), null);
    assert.equal(planJump([0, 400], [700, 400]), null);
    assert.ok(planJump([0, 800], [100, 500], 1.2));
  });
});

describe('landing', () => {
  const edges = [{ left: 0, right: 100, y: 200 }, { left: 0, right: 100, y: 260 }, { left: 200, right: 300, y: 150 }];

  it('finds the first edge crossed under the body', () => {
    assert.equal(landing(edges, 50, 190, 270)?.y, 200);
    assert.equal(landing(edges, 50, 205, 270)?.y, 260);
  });

  it('falls past the perch she just left and lands on a lower edge', () => {
    assert.equal(landing(edges, 50, 200, 200.4), null);
    assert.equal(landing(edges, 50, 200, 270)?.y, 260);
    assert.equal(landing(edges, 50, 200.25, 270)?.y, 260);
  });

  it('ignores edges not under her or not crossed this frame', () => {
    assert.equal(landing(edges, 150, 0, 400), null);
    assert.equal(landing(edges, 250, 160, 200), null);
  });
});

describe('helpers', () => {
  it('scales impact from fall speed', () => {
    assert.equal(impact(0), 0);
    assert.equal(impact(99999), 1);
  });

  it('picks by weight and skips zero weights', () => {
    assert.equal(weighted({ a: 0, b: 1 }, () => 0.99), 'b');
    assert.equal(weighted({ a: 1, b: 3 }, () => 0.1), 'a');
    assert.equal(weighted({}), null);
  });
});
