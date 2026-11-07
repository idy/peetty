import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Motion } from '../src/figure/motion.ts';
import { FigureError, LIMITS, validateFigure } from '../src/figure/validate.ts';
import { STATES, type RigFigure } from '../src/figure/types.ts';

const PRESETS = ['miru', 'koharu', 'xiaoxiao', 'riley', 'amara', 'elsie', 'shiori'];

async function preset(id: string): Promise<RigFigure> {
  return JSON.parse(await readFile(new URL(`../figures/${id}.json`, import.meta.url), 'utf8'));
}

function issues(input: unknown): string[] {
  try {
    validateFigure(input);
    return [];
  } catch (error) {
    assert.ok(error instanceof FigureError);
    return error.issues;
  }
}

describe('preset figures', () => {
  for (const id of PRESETS) {
    it(`${id} is valid, within limits and draws every expression`, async () => {
      const figure = await preset(id);
      assert.deepEqual(issues(figure), []);
      assert.equal(figure.id, id);
      assert.ok(JSON.stringify(figure).length < 64_000, 'presets stay small');
      const slots = new Set(figure.parts.map((p) => p.slot).filter(Boolean));
      for (const slot of ['eyes:open', 'eyes:closed', 'eyes:happy', 'eyes:sleepy', 'mouth:smile', 'mouth:open', 'mouth:talk', 'mouth:o', 'brows:calm', 'brows:worried']) {
        assert.ok(slots.has(slot), `${id} draws ${slot}`);
      }
    });
  }

  it('Shiori draws the book used by her reading idle', async () => {
    const shiori = await preset('shiori');
    assert.equal(shiori.behavior?.idleProp, 'book');
    assert.ok(shiori.parts.some((p) => p.slot === 'hand:book'));
  });

  it('every character looks different', async () => {
    const all = await Promise.all(PRESETS.map(preset));
    assert.equal(new Set(all.map((f) => f.palette.hair)).size, all.length);
    assert.equal(new Set(all.map((f) => f.palette.iris)).size, all.length);
  });

  it('each prop idle has its drawing', async () => {
    const needs: Record<string, string[]> = { book: ['hand:book'], cup: ['hand:cup'], camera: ['hand:camera'], gum: ['mouth:gum', 'mouth:gumBig'] };
    for (const figure of await Promise.all(PRESETS.map(preset))) {
      const slots = new Set(figure.parts.map((p) => p.slot));
      for (const slot of needs[figure.behavior?.idleProp ?? ''] ?? []) assert.ok(slots.has(slot), `${figure.id} draws ${slot}`);
      if (figure.behavior?.fallProp === 'umbrella') assert.ok(slots.has('hand:umbrella'), `${figure.id} draws hand:umbrella`);
    }
  });
});

describe('validateFigure', () => {
  const base = async () => structuredClone(await preset('miru'));

  it('rejects markup and script in path data', async () => {
    const figure = await base();
    figure.parts[0]!.shapes = [{ type: 'path', d: 'M0 0"/><script>alert(1)</script>' }];
    assert.match(issues(figure).join('\n'), /parts\[0\]\.shapes\[0\]\.d/);
  });

  it('rejects CSS and url() in colors', async () => {
    const figure = await base();
    figure.palette.hair = 'url(https://example.com/x.svg)';
    figure.parts[0]!.shapes[0]!.fill = 'red;background:url(x)';
    const found = issues(figure).join('\n');
    assert.match(found, /palette\.hair/);
    assert.match(found, /not a palette key/);
  });

  it('checks bones, slots, clips and springs', async () => {
    const figure = await base();
    const part = figure.parts[0]!;
    Object.assign(part, { bone: 'tail', slot: 'eyes:wink', clip: 'missing', spring: { stiffness: 2, damping: 0.5 } });
    delete part.pivot;
    const found = issues(figure).join('\n');
    for (const field of ['bone', 'slot', 'clip', 'spring.stiffness', 'pivot']) assert.match(found, new RegExp(`parts\\[0\\]\\.${field.replace('.', '\\.')}`));
  });

  it('rejects duplicate part ids and oversized packs', async () => {
    const figure = await base();
    figure.parts[1]!.id = figure.parts[0]!.id;
    figure.description = 'x'.repeat(10);
    (figure as unknown as Record<string, unknown>).author = 'y'.repeat(LIMITS.maxBytes);
    const found = issues(figure).join('\n');
    assert.match(found, /is used twice/);
    assert.match(found, /the limit is/);
  });

  it('accepts a minimal sprite figure and rejects unsafe images', () => {
    const sprite = {
      format: 'peetty.figure', version: 1, id: 'pixel', name: 'Pixel', renderer: 'sprite',
      viewBox: [0, 0, 32, 32], height: 64, anchor: [16, 31], palette: {},
      sprite: { image: 'data:image/png;base64,iVBORw0KGgo=', frameWidth: 32, frameHeight: 32, columns: 4, animations: { idle: { frames: [0, 1], fps: 4 } } },
    };
    assert.deepEqual(issues(sprite), []);
    assert.match(issues({ ...sprite, sprite: { ...sprite.sprite, image: 'javascript:alert(1)' } }).join('\n'), /sprite\.image/);
    assert.match(issues({ ...sprite, sprite: { ...sprite.sprite, animations: {} } }).join('\n'), /idle/);
  });

  it('rejects the wrong format or version', () => {
    assert.match(issues({ format: 'other', version: 2 }).join('\n'), /format[\s\S]*version/);
    assert.deepEqual(issues(null), ['figure: must be an object']);
  });
});

describe('Motion', () => {
  const seeded = () => {
    let s = 42;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  };

  it('blinks on its own and never stays frozen', () => {
    const motion = new Motion(undefined, seeded());
    let closed = 0;
    const heads = new Set<number>();
    for (let i = 0; i < 60 * 12; i++) {
      const frame = motion.update(1 / 60);
      if (frame.slots.eyes === 'closed') closed++;
      heads.add(Math.round((frame.pose.head?.rotate ?? 0) * 100));
    }
    assert.ok(closed > 6 && closed < 120, `blinked for ${closed} frames`);
    assert.ok(heads.size > 50, 'idle keeps moving');
  });

  it('produces a pose for every state', () => {
    for (const state of STATES) {
      const motion = new Motion(undefined, seeded());
      motion.play(state);
      const frame = motion.update(0.3);
      assert.ok(frame.pose.body && frame.pose.head, state);
    }
  });

  it('anticipates a jump with a crouch before stretching', () => {
    const motion = new Motion(undefined, seeded());
    motion.play('jump');
    const crouch = motion.update(0.15).pose.root!.sy!;
    const stretch = motion.update(0.13).pose.root!.sy!;
    assert.ok(crouch < 0.9, `crouch ${crouch}`);
    assert.ok(stretch > 1.05, `stretch ${stretch}`);
  });

  it('squashes on landing and settles', () => {
    const motion = new Motion(undefined, seeded());
    motion.land();
    const squash = motion.update(0.02).pose.root!.sy!;
    motion.update(0.6);
    const settled = motion.update(0.02).pose.root?.sy ?? 1;
    assert.ok(squash < 0.9);
    assert.equal(settled, 1);
  });

  it('Shiori reads in idle; moods override the prop', () => {
    const motion = new Motion({ idleProp: 'book' }, seeded());
    const reading = motion.update(0.1);
    assert.equal(reading.slots.hand, 'book');
    assert.ok(reading.look && reading.look[1] > 0.5, 'looks down at the page');
    motion.setMood('happy');
    const happy = motion.update(0.1);
    assert.equal(happy.slots.hand, 'rest');
    assert.equal(happy.slots.eyes, 'happy');
  });

  it('Koharu stretches and yawns now and then', () => {
    const motion = new Motion({ idleProp: 'stretch', walkSpeed: 0.7 }, seeded());
    let yawned = false;
    for (let i = 0; i < 60 * 20 && !yawned; i++) yawned = motion.update(1 / 60).slots.mouth === 'open';
    assert.ok(yawned);
  });
});
