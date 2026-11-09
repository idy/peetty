import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { FigureSounds, SoundCue } from '../src/figure/types.ts';
import { SoundPlayer } from '../src/pet/sound.ts';
import { deferred } from './helpers/pet-dom.ts';
import { stubGlobals } from './helpers/stubs.ts';

const buffer = (duration = 0.4, numberOfChannels = 2, sampleRate = 48_000) => {
  const length = Math.round(duration * sampleRate);
  return { duration: length / sampleRate, length, numberOfChannels, sampleRate } as AudioBuffer;
};
const audioResponse = () => new Response(new Uint8Array([1, 2, 3]));
const notes = (hz = 440): SoundCue => ({ notes: [hz] });
const figure = (cue: SoundCue = notes()): FigureSounds => ({ events: { idle: [cue] } });
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeParam {
  events: { kind: 'set' | 'ramp'; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ kind: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'ramp', value, time }); return this; }
}
class FakeNode {
  connections: unknown[] = [];
  disconnects = 0;
  connect(destination: unknown) { this.connections.push(destination); }
  disconnect() { this.disconnects++; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  starts: number[][] = [];
  stops: (number | undefined)[] = [];
  start(...args: number[]) { this.starts.push(args); }
  stop(at?: number) { this.stops.push(at); }
  end() { this.onended?.(); }
}
class FakeOscillator extends FakeSource { frequency = new FakeParam(); type = 'sine'; }
class FakeBufferSource extends FakeSource { buffer: AudioBuffer | null = null; playbackRate = new FakeParam(); }
class FakeDocument extends EventTarget {
  readonly baseURI = 'https://sounds.example/';
  hidden = false;
  setHidden(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
interface Environment {
  now: number;
  initialState: 'suspended' | 'running';
  contexts: FakeContext[];
  resume: ((context: FakeContext) => Promise<void>) | undefined;
  suspend: ((context: FakeContext) => Promise<void>) | undefined;
  decode: ((bytes: ArrayBuffer) => Promise<AudioBuffer>) | undefined;
}
class FakeContext extends EventTarget {
  state: 'suspended' | 'running' | 'closed';
  destination = {};
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  sources: FakeBufferSource[] = [];
  decoded: ArrayBuffer[] = [];
  resumes = 0;
  suspends = 0;
  closes = 0;
  private env: Environment;
  constructor(env: Environment) { super(); this.env = env; this.state = env.initialState; }
  get currentTime() { return this.env.now / 1_000; }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
  createOscillator() { const node = new FakeOscillator(); this.oscillators.push(node); return node; }
  createBufferSource() { const node = new FakeBufferSource(); this.sources.push(node); return node; }
  transition(state: FakeContext['state']) { this.state = state; this.dispatchEvent(new Event('statechange')); }
  resume() {
    this.resumes++;
    if (this.env.resume) return this.env.resume(this);
    this.transition('running');
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    if (this.env.suspend) return this.env.suspend(this);
    this.transition('suspended');
    return Promise.resolve();
  }
  close() { this.closes++; this.transition('closed'); return Promise.resolve(); }
  decodeAudioData(bytes: ArrayBuffer) { this.decoded.push(bytes); return this.env.decode?.(bytes) ?? Promise.resolve(buffer()); }
}
function install(t: TestContext, initialState: 'suspended' | 'running' = 'suspended') {
  const env: Environment = { now: 0, initialState, contexts: [], resume: undefined, suspend: undefined, decode: undefined };
  const document = new FakeDocument();
  const players: SoundPlayer[] = [];
  const restores: (() => void)[] = [];
  const replace = (name: string, value: unknown) => { restores.push(stubGlobals({ [name]: value })); };
  replace('document', document);
  replace('AudioContext', class extends FakeContext {
    constructor() { super(env); env.contexts.push(this); }
  });
  t.mock.method(performance, 'now', () => env.now);
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push({ url, options });
    return audioResponse();
  });
  t.after(() => {
    try { for (const player of players) player.destroy(); }
    finally { for (const restore of restores.reverse()) restore(); }
  });
  return {
    env, document, requests, fetch, replace,
    player(options: ConstructorParameters<typeof SoundPlayer>[0] = true) {
      const player = new SoundPlayer(options);
      players.push(player);
      return player;
    },
    context() { assert.equal(env.contexts.length, 1); return env.contexts[0]!; },
  };
}
function peak(gain: FakeGain): number { return Math.max(...gain.gain.events.map(({ value }) => value)); }

// All fakes are local to this file; no browser audio or network is used.
describe('SoundPlayer user-gesture gating and options', () => {
  it('does nothing at construction, while muted, or before a successful explicit unlock', async (t) => {
    const h = install(t);
    const player = h.player(false);
    player.setFigure(figure({ src: 'https://sounds.example/idle.ogg' }));
    player.unlock(); player.play('idle');
    assert.equal(player.enabled, false);
    assert.equal(h.env.contexts.length, 0);
    player.setOptions({ enabled: true });
    player.play('idle');
    assert.equal(h.env.contexts.length, 0);
    assert.equal(h.requests.length, 0);
    player.unlock();
    assert.equal(h.context().resumes, 1, 'resume is invoked synchronously in the gesture');
    player.play('idle');
    assert.equal(h.requests.length, 0, 'a cue during resume is dropped');
    await flush();
    assert.equal(h.requests.length, 0, 'unlock never queues old events or preloads audio');
    player.play('idle');
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.context().sources.length, 1);
  });

  it('waits for a gesture-requested preview, but cancels it when muted before resume', async (t) => {
    const h = install(t);
    const player = h.player();
    player.setFigure(figure());
    const gate = deferred<void>();
    h.env.resume = (context) => gate.promise.then(() => { context.state = 'running'; });
    player.preview('idle');
    assert.equal(h.context().oscillators.length, 0);
    gate.resolve(); await flush();
    assert.equal(h.context().oscillators.length, 1, 'the first preview plays once resume completes');
    player.stop();
    h.context().state = 'suspended';
    const later = deferred<void>();
    h.env.resume = (context) => later.promise.then(() => { context.state = 'running'; });
    player.preview('idle');
    player.setOptions(false); player.setOptions(true);
    later.resolve(); await flush();
    assert.equal(h.context().oscillators.length, 1, 'muting cancels an unfinished preview even if re-enabled');
  });

  it('retries a pending autoplay resume synchronously on the next gesture and ignores its later rejection', async (t) => {
    const h = install(t);
    const blocked = deferred<void>();
    h.env.resume = (context) => {
      if (context.resumes === 1) return blocked.promise;
      context.transition('running');
      return Promise.resolve();
    };
    const player = h.player(); player.setFigure(figure());
    player.unlock();
    assert.equal(h.context().resumes, 1);
    player.preview('idle');
    assert.equal(h.context().resumes, 2, 'the real gesture reaches native resume before returning');
    await flush();
    assert.equal(h.context().oscillators.length, 1, 'the second gesture succeeds while the first promise is pending');
    blocked.reject(new Error('the first resume was blocked')); await flush();
    h.env.now = 700; player.play('idle');
    assert.equal(h.context().oscillators.length, 2, 'the older rejection cannot relock the running context');
  });

  for (const completion of ['resolve', 'reject'] as const) {
    it(`ignores an old context resume ${completion} after destroy and remount`, async (t) => {
      const h = install(t);
      const blocked = deferred<void>();
      h.env.resume = (context) => context === h.env.contexts[0] ? blocked.promise : Promise.resolve().then(() => context.transition('running'));
      const player = h.player(); player.setFigure(figure()); player.preview('idle');
      const old = h.context();
      player.destroy(); player.setFigure(figure()); player.preview('idle'); await flush();
      const current = h.env.contexts[1]!;
      assert.equal(current.oscillators.length, 1);
      if (completion === 'resolve') blocked.resolve();
      else blocked.reject(new Error('old context closed'));
      await flush();
      h.env.now = 700; player.play('idle');
      assert.equal(current.oscillators.length, 2);
      assert.equal(old.oscillators.length, 0);
    });
  }

  it('creates no context at zero master volume', async (t) => {
    const h = install(t);
    const player = h.player({ enabled: true, volume: 0 }); player.setFigure(figure());
    player.unlock(); player.preview('idle'); player.play('idle');
    assert.equal(h.env.contexts.length, 0);
    player.setOptions({ volume: 0.5 }); player.play('idle');
    assert.equal(h.env.contexts.length, 0, 'changing volume is not an audio gesture');
    await player.unlock(); player.play('idle');
    assert.equal(h.context().oscillators.length, 1);
  });

  it('suspends its context on mute or zero volume and resumes only from a later gesture', async (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.setFigure(figure()); player.unlock(); player.play('idle');
    const context = h.context();
    for (const muted of [false, { volume: 0 }] as const) {
      const played = context.oscillators.length;
      const resumes = context.resumes;
      player.setOptions(muted);
      assert.equal(context.state, 'suspended');
      assert.equal(context.oscillators.at(-1)!.disconnects, 1);
      player.setOptions({ enabled: true, volume: 1 }); player.play('idle');
      assert.equal(context.resumes, resumes);
      assert.equal(context.oscillators.length, played);
      await player.unlock(); player.play('idle');
      assert.equal(context.resumes, resumes + 1);
      assert.equal(context.oscillators.length, played + 1);
    }
    assert.equal(context.suspends, 2);
  });

  it('suspends again if a blocked resume completes after muting', async (t) => {
    const h = install(t);
    const gate = deferred<void>();
    h.env.resume = (context) => gate.promise.then(() => context.transition('running'));
    const player = h.player(); player.setFigure(figure()); player.preview('idle');
    player.setOptions(false); await flush();
    assert.equal(h.context().suspends, 1);
    gate.resolve(); await flush();
    assert.equal(h.context().state, 'suspended');
    assert.equal(h.context().suspends, 2, 'a late native resume cannot leave muted audio running');
    assert.equal(h.context().oscillators.length, 0);
  });

  it('queues every rapid mute and gesture in native order while suspend still reports running', async (t) => {
    const h = install(t, 'running');
    const commands: { state: 'suspended' | 'running'; gate: ReturnType<typeof deferred<void>> }[] = [];
    const queue = (context: FakeContext, state: 'suspended' | 'running') => {
      const gate = deferred<void>(); commands.push({ state, gate });
      return gate.promise.then(() => context.transition(state));
    };
    h.env.suspend = (context) => queue(context, 'suspended');
    h.env.resume = (context) => queue(context, 'running');
    const player = h.player(); player.setFigure(figure()); player.unlock();
    for (let i = 0; i < 2; i++) {
      player.setOptions(false); player.setOptions(true); player.preview('idle');
      assert.equal(h.context().resumes, i + 1, 'resume is invoked inside each gesture despite the pending suspend');
    }
    assert.equal(h.context().state, 'running', 'native state changes have not been delivered yet');
    assert.deepEqual(commands.map(({ state }) => state), ['suspended', 'running', 'suspended', 'running']);
    for (const { gate } of commands) { gate.resolve(); await flush(); }
    assert.equal(h.context().state, 'running');
    assert.equal(h.context().oscillators.length, 1, 'only the preview from the latest lifecycle survives');
  });

  for (const failure of ['missing', 'throw', 'reject'] as const) {
    it(`silently tolerates a ${failure} suspend implementation`, async (t) => {
      const h = install(t, 'running');
      const player = h.player(); player.setFigure(figure()); player.unlock(); player.play('idle');
      if (failure === 'missing') Object.assign(h.context(), { suspend: undefined });
      else h.env.suspend = () => { if (failure === 'throw') throw new Error('unsupported'); return Promise.reject(new Error('unsupported')); };
      assert.doesNotThrow(() => player.setOptions(false)); await flush();
      assert.equal(h.context().oscillators[0]!.disconnects, 1);
      player.setOptions(true); await player.unlock(); player.play('idle');
      assert.equal(h.context().oscillators.length, 2);
    });
  }

  it('uses an already-running context only after unlock and never resumes from play or setters', (t) => {
    const h = install(t, 'running');
    const player = h.player();
    player.setFigure(figure());
    player.play('idle');
    assert.equal(h.env.contexts.length, 0);
    player.unlock(); player.play('idle');
    assert.equal(h.context().resumes, 0);
    assert.equal(h.context().oscillators.length, 1);
    h.context().state = 'suspended';
    h.env.now = 700;
    player.setOptions(true); player.setFigure(figure()); player.play('idle');
    assert.equal(h.context().resumes, 0);
    assert.equal(h.context().oscillators.length, 1);
  });

  it('merges object options, preserves volume on boolean changes, and validates volume atomically', async (t) => {
    const h = install(t, 'running');
    const player = h.player({ enabled: true, volume: 0.5 });
    player.setFigure({ volume: 0.4, events: { idle: [{ notes: [440], volume: 0.25 }] } });
    player.unlock();
    for (const volume of [-1, 1.01, NaN, Infinity, -Infinity, '0.5', null]) {
      assert.throws(() => player.setOptions({ enabled: false, volume } as never), TypeError);
      assert.equal(player.enabled, true);
    }
    player.setOptions(false); player.setOptions(true); player.setOptions({});
    await player.unlock(); player.play('idle');
    assert.equal(peak(h.context().gains[0]!), 0.5 * 0.4 * 0.25 * 0.12);
    assert.equal(h.context().suspends, 1);
    assert.equal(h.context().resumes, 1);
    player.setOptions({}); player.setOptions(true);
    assert.equal(h.context().oscillators[0]!.disconnects, 0, 'no-op option updates leave the cue alone');
    player.setOptions({ volume: 0 });
    player.setFigure(figure({ src: 'https://sounds.example/muted.ogg' }));
    player.play('idle');
    assert.equal(h.requests.length, 0);
    assert.ok(h.context().oscillators[0]!.disconnects);
  });

  it('silently tolerates absent Web Audio and construction, synchronous resume, or async resume failures', async (t) => {
    const h = install(t);
    const player = h.player();
    player.setFigure(figure());
    h.replace('AudioContext', undefined);
    assert.doesNotThrow(() => { player.unlock(); player.play('idle'); });
    h.replace('AudioContext', class { constructor() { throw new Error('unavailable'); } });
    assert.doesNotThrow(() => { player.unlock(); player.play('idle'); });
    h.replace('AudioContext', class extends FakeContext {
      constructor() { super(h.env); h.env.contexts.push(this); }
    });
    h.env.resume = () => { throw new Error('blocked'); };
    assert.doesNotThrow(() => player.unlock());
    player.play('idle');
    h.env.resume = () => Promise.reject(new Error('blocked'));
    player.unlock(); await flush(); player.play('idle');
    assert.equal(h.context().oscillators.length, 0);
    h.env.resume = undefined;
    player.unlock(); await flush(); player.play('idle');
    assert.equal(h.context().oscillators.length, 1, 'a later trusted gesture can retry');
  });

  it('drops hidden-page events and stops active sounds on visibility changes', (t) => {
    const h = install(t, 'running');
    const player = h.player();
    player.setFigure(figure());
    h.document.setHidden(true);
    player.unlock();
    assert.equal(h.env.contexts.length, 0);
    h.document.setHidden(false);
    player.unlock(); player.play('idle');
    const source = h.context().oscillators[0]!;
    h.document.setHidden(true);
    assert.equal(source.stops.at(-1), undefined);
    assert.equal(source.disconnects, 1);
    h.env.now = 700;
    player.play('idle');
    assert.equal(h.context().oscillators.length, 1);
  });
});

describe('SoundPlayer cue selection, synthesis, and resource ownership', () => {
  it('applies default gain, duration, waveform, and short attack/release envelopes', (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.setFigure(figure()); player.unlock(); player.play('idle');
    const context = h.context();
    assert.equal(peak(context.gains[0]!), 0.35 * 0.12);
    assert.deepEqual(context.oscillators[0]!.starts, [[0]]);
    assert.deepEqual(context.oscillators[0]!.stops, [0.08]);
    assert.equal(context.oscillators[0]!.type, 'sine');
    assert.deepEqual(context.gains[0]!.gain.events, [
      { kind: 'set', value: 0, time: 0 },
      { kind: 'ramp', value: 0.35 * 0.12, time: 0.005 },
      { kind: 'set', value: 0.35 * 0.12, time: 0.065 },
      { kind: 'ramp', value: 0, time: 0.08 },
    ]);
  });

  it('chooses random variants with per-event cooldown and a global 120ms throttle', (t) => {
    const h = install(t, 'running');
    const player = h.player();
    player.setFigure({ events: { idle: [notes(320), notes(640)], wave: [notes(880)] } });
    t.mock.method(Math, 'random', () => 0.99);
    player.unlock(); player.play('land'); player.play('idle');
    assert.equal(h.context().oscillators[0]!.frequency.events[0]!.value, 640);
    h.env.now = 119; player.play('wave');
    assert.equal(h.context().oscillators.length, 1);
    h.env.now = 120; player.play('wave');
    assert.equal(h.context().oscillators.length, 2);
    h.env.now = 599; player.play('idle');
    assert.equal(h.context().oscillators.length, 2);
    h.env.now = 600; player.play('idle');
    assert.equal(h.context().oscillators.length, 3);
    player.setFigure({ cooldown: 0, events: { idle: [notes()] } });
    player.play('idle');
    h.env.now = 720; player.play('idle');
    assert.equal(h.context().oscillators.length, 5);
  });

  it('plays only configured own event properties, ignoring inherited file cues', async (t) => {
    const h = install(t, 'running');
    const events = Object.assign(Object.create({ wave: [{ src: 'https://sounds.example/inherited.ogg' }] }), { idle: [notes()] });
    const player = h.player(); player.setFigure({ events }); player.unlock(); player.play('wave'); await flush();
    assert.equal(h.fetch.mock.callCount(), 0);
    assert.equal(h.context().sources.length, 0);
    player.play('idle');
    assert.equal(h.context().oscillators.length, 1);
  });

  it('schedules notes in sequence, enforces a five-second ceiling, and stops the previous cue', (t) => {
    const h = install(t, 'running');
    const player = h.player();
    player.setFigure(figure({ notes: Array(8).fill(440), duration: 1, waveform: 'triangle' }));
    player.unlock(); player.play('idle');
    const context = h.context();
    assert.deepEqual(context.oscillators.map((source) => source.starts[0]![0]), [0, 1, 2, 3, 4]);
    assert.ok(context.oscillators.every((source) => source.stops[0]! <= 5 && source.type === 'triangle'));
    h.env.now = 700; player.play('idle');
    for (const source of context.oscillators.slice(0, 5)) {
      assert.equal(source.stops.at(-1), undefined);
      assert.equal(source.disconnects, 1);
      assert.equal(source.onended, null);
    }
    assert.equal(context.gains[0]!.disconnects, 1);
  });

  it('disconnects naturally ended sources and releases the shared gain after the last note', (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.setFigure(figure({ notes: [330, 440] })); player.unlock(); player.play('idle');
    const context = h.context();
    context.oscillators[0]!.end();
    assert.equal(context.oscillators[0]!.disconnects, 1);
    assert.equal(context.gains[0]!.disconnects, 0);
    context.oscillators[1]!.end();
    assert.equal(context.gains[0]!.disconnects, 1);
    player.stop();
    assert.deepEqual(context.oscillators.map((source) => source.stops.length), [1, 1], 'ended nodes are no longer retained');
    assert.equal(context.gains[0]!.disconnects, 1);
  });

  it('retains the unlocked context across figures and closes it on destroy, allowing a fresh remount', (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.setFigure(figure()); player.unlock(); player.play('idle');
    const context = h.context();
    player.setFigure(figure(notes(660))); player.play('idle');
    assert.equal(h.env.contexts.length, 1);
    assert.equal(context.oscillators[1]!.frequency.events[0]!.value, 660);
    player.destroy(); player.destroy();
    assert.equal(context.closes, 1);
    player.setFigure(figure()); player.play('idle');
    assert.equal(h.env.contexts.length, 1, 'remount still needs a gesture');
    player.unlock(); player.play('idle');
    assert.equal(h.env.contexts.length, 2);
    assert.equal(h.env.contexts[1]!.oscillators.length, 1);
    assert.equal(context.oscillators.at(-1)!.onended, null);
  });
});

describe('SoundPlayer bounded file playback', () => {
  it('omits credentials/referrers, decodes once, applies effective file gain and rate, and reuses its cache', async (t) => {
    const h = install(t, 'running');
    const player = h.player({ enabled: true, volume: 0.5 });
    player.setFigure({ volume: 0.3, events: { idle: [{ src: 'https://sounds.example/idle.ogg', volume: 0.4, playbackRate: 2 }] } });
    player.unlock(); player.play('idle'); await flush();
    const context = h.context();
    assert.equal(h.requests[0]!.options?.credentials, 'omit');
    assert.equal(h.requests[0]!.options?.referrerPolicy, 'no-referrer');
    assert.equal(h.requests[0]!.options?.redirect ?? 'follow', 'follow', 'normal audio redirects remain allowed');
    assert.equal(context.decoded[0]!.byteLength, 3);
    assert.equal(peak(context.gains[0]!), 0.5 * 0.3 * 0.4 * 0.12);
    assert.deepEqual(context.sources[0]!.starts, [[0, 0, 0.4]]);
    assert.deepEqual(context.sources[0]!.stops, [0.2]);
    assert.equal(context.sources[0]!.playbackRate.events[0]!.value, 2);
    h.env.now = 700; player.play('idle'); await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(context.decoded.length, 1);
    assert.equal(context.sources.length, 2);
    context.sources[1]!.end();
    assert.equal(context.sources[1]!.disconnects, 1);
    assert.equal(context.gains[1]!.disconnects, 1);
  });

  it('resolves file URLs before loading or caching and skips unsupported sources', async (t) => {
    const h = install(t, 'running');
    const cues = [{ src: '/idle.ogg' }, { src: 'https://sounds.example/idle.ogg' }];
    const player = h.player(); player.setFigure({ events: { idle: cues } }); player.unlock();
    let choice = 0; t.mock.method(Math, 'random', () => choice / cues.length);
    player.play('idle'); await flush();
    assert.equal(h.requests[0]!.url, 'https://sounds.example/idle.ogg');
    choice = 1; h.env.now = 700; player.play('idle'); await flush();
    assert.equal(h.requests.length, 1, 'equivalent resolved URLs share a decoded cache entry');
    for (const src of ['file:///idle.ogg', 'data:audio/wav;base64,AAAA', 'javascript:void(0)', 'blob:https://sounds.example/idle', 'https://user:secret@sounds.example/idle.ogg']) {
      player.setFigure(figure({ src })); player.play('idle'); await flush();
    }
    assert.equal(h.requests.length, 1);
    assert.equal(h.context().sources.length, 2);
  });

  it('coalesces in-flight URLs and plays only the most recent accepted event', async (t) => {
    const h = install(t, 'running');
    const gate = deferred<Response>();
    h.fetch.mock.mockImplementation(() => gate.promise);
    const player = h.player();
    const src = 'https://sounds.example/shared.ogg';
    player.setFigure({ events: { idle: [{ src, volume: 0.2 }], wave: [{ src, volume: 0.8 }] } });
    player.unlock(); player.play('idle');
    h.env.now = 150; player.play('wave');
    assert.equal(h.fetch.mock.callCount(), 1);
    gate.resolve(audioResponse()); await flush();
    assert.equal(h.context().decoded.length, 1);
    assert.equal(h.context().sources.length, 1);
    assert.equal(peak(h.context().gains[0]!), 0.35 * 0.8 * 0.12);
  });

  for (const action of ['stop', 'mute', 'figure', 'hide', 'destroy'] as const) {
    it(`aborts pending fetches on ${action} and prevents stale playback even when fetch ignores abort`, async (t) => {
      const h = install(t, 'running');
      const gate = deferred<Response>();
      let signal: AbortSignal | undefined;
      h.fetch.mock.mockImplementation((_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return gate.promise; });
      const player = h.player(); player.setFigure(figure({ src: 'https://sounds.example/old.ogg' })); player.unlock(); player.play('idle');
      assert.equal(signal?.aborted, false);
      if (action === 'stop') player.stop();
      if (action === 'mute') { player.setOptions(false); player.setOptions(true); }
      if (action === 'figure') player.setFigure(figure(notes(660)));
      if (action === 'hide') { h.document.setHidden(true); h.document.setHidden(false); }
      if (action === 'destroy') player.destroy();
      assert.equal(signal?.aborted, true);
      gate.resolve(audioResponse()); await flush();
      assert.equal(h.context().decoded.length, 0);
      assert.equal(h.context().sources.length, 0);
      if (action === 'figure') {
        player.play('idle');
        assert.equal(h.context().oscillators[0]!.frequency.events[0]!.value, 660);
      }
    });
  }

  for (const stage of ['fetch', 'reader', 'decode'] as const) {
    it(`keeps pending ${stage} work budgeted through deadlines, stop, figure replacement, and destroy/remount`, async (t) => {
      const h = install(t, 'running');
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const gates: ReturnType<typeof deferred<void>>[] = [];
      const pending = () => { const gate = deferred<void>(); gates.push(gate); return gate.promise; };
      if (stage === 'fetch') h.fetch.mock.mockImplementation(() => pending().then(audioResponse));
      if (stage === 'reader') h.fetch.mock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { return pending(); },
      })));
      if (stage === 'decode') h.env.decode = () => pending().then(() => buffer());
      const player = h.player({ enabled: true, volume: 0.4 });
      for (let i = 0; i < 12; i++) {
        player.setFigure(figure({ src: `/pending-${i}.ogg` })); player.unlock(); player.play('idle'); await flush();
        h.env.now += 1_001; t.mock.timers.tick(1_001); await flush();
        if (i % 3 === 0) player.stop();
        if (i % 3 === 1) player.setFigure(figure());
        if (i % 3 === 2) player.destroy();
      }
      assert.equal(h.fetch.mock.callCount(), 4, 'aborting and timing out do not release unsettled native work');
      assert.equal(gates.length, 4);
      player.setFigure(figure({ src: '/next.ogg' })); player.unlock(); player.play('idle'); await flush();
      assert.equal(h.fetch.mock.callCount(), 4, 'the reused player keeps its outstanding budget');
      gates[0]!.resolve(); await flush();
      player.stop(); player.play('idle'); await flush();
      assert.equal(h.fetch.mock.callCount(), 5, 'a slot becomes available once the underlying operation settles');
      assert.equal(h.env.contexts.reduce((sum, context) => sum + context.sources.length, 0), 0, 'old work never plays after remount');
      player.stop();
      for (const gate of gates) gate.resolve();
      await flush();
      h.env.decode = undefined; h.fetch.mock.mockImplementation(async () => audioResponse());
      player.play('idle'); await flush();
      assert.equal(peak(h.env.contexts.at(-1)!.gains[0]!), 0.4 * 0.35 * 0.12, 'settings survive destroy and remount');
    });
  }

  it('discards a decode that completes after a figure switch and clears buffers from previous figures', async (t) => {
    const h = install(t, 'running');
    const gate = deferred<AudioBuffer>();
    h.env.decode = () => gate.promise;
    const player = h.player(); const pack = figure({ src: 'https://sounds.example/idle.ogg' });
    player.setFigure(pack); player.unlock(); player.play('idle'); await flush();
    assert.equal(h.context().decoded.length, 1);
    player.setFigure(pack);
    gate.resolve(buffer()); await flush();
    assert.equal(h.context().sources.length, 0);
    h.env.decode = undefined;
    player.play('idle'); await flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.context().sources.length, 1);
    player.setFigure(pack); player.play('idle'); await flush();
    assert.equal(h.requests.length, 3, 'a figure replacement clears decoded buffers');
  });

  it('aborts a pending stream on stop and never decodes a partial download', async (t) => {
    const h = install(t, 'running');
    let canceled = 0;
    h.fetch.mock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { canceled++; },
    })));
    const player = h.player(); player.setFigure(figure({ src: 'https://sounds.example/stream.ogg' })); player.unlock(); player.play('idle'); await flush();
    player.stop(); await flush();
    assert.equal(canceled, 1);
    assert.equal(h.context().decoded.length, 0);
  });

  it('expires network work after one second and drops a late decode', async (t) => {
    const h = install(t, 'running');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    h.fetch.mock.mockImplementation((_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return gate.promise; });
    const player = h.player(); player.setFigure(figure({ src: 'https://sounds.example/slow.ogg' })); player.unlock(); player.play('idle');
    h.env.now = 1_001;
    t.mock.timers.tick(1_001);
    assert.equal(signal?.aborted, true);
    gate.resolve(audioResponse()); await flush();
    assert.equal(h.context().sources.length, 0);
    player.setFigure(figure({ src: 'https://sounds.example/late-decode.ogg' }));
    h.fetch.mock.mockImplementation(async () => audioResponse());
    const decoded = deferred<AudioBuffer>(); h.env.decode = () => decoded.promise;
    player.play('idle'); await flush();
    h.env.now += 1_001;
    decoded.resolve(buffer()); await flush();
    assert.equal(h.context().sources.length, 0);
  });

  it('rejects advertised and streamed downloads above 2MB before decoding', async (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.unlock();
    const max = 2 * 1024 * 1024;
    let canceled = 0;
    for (const advertised of [true, false]) {
      h.fetch.mock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(max)); controller.enqueue(new Uint8Array(1)); },
        cancel() { canceled++; },
      }), { headers: { 'Content-Length': String(advertised ? max + 1 : 1) } }));
      player.setFigure(figure({ src: `https://sounds.example/large-${advertised}.ogg` }));
      player.play('idle'); await flush();
    }
    assert.equal(canceled, 2);
    assert.equal(h.context().decoded.length, 0);
    assert.equal(h.context().sources.length, 0);
  });

  it('silently handles fetch/decode failures and rejects decoded audio longer than five seconds', async (t) => {
    const h = install(t, 'running');
    const player = h.player(); player.unlock();
    for (const failure of ['fetch', 'http', 'decode', 'duration'] as const) {
      h.fetch.mock.mockImplementation(async () => {
        if (failure === 'fetch') throw new Error('network unavailable');
        return failure === 'http' ? new Response('', { status: 404 }) : audioResponse();
      });
      h.env.decode = async () => {
        if (failure === 'decode') throw new Error('invalid audio');
        return buffer(5.01);
      };
      player.setFigure(figure({ src: `https://sounds.example/${failure}.ogg` }));
      assert.doesNotThrow(() => player.play('idle'));
      await flush();
    }
    assert.equal(h.context().sources.length, 0);
  });

  for (const failure of ['advertised-size', 'streamed-size', 'decode', 'duration'] as const) {
    it(`backs off deterministic ${failure} failures, then retries after its TTL`, async (t) => {
      const h = install(t, 'running');
      h.fetch.mock.mockImplementation(async () => {
        if (failure === 'advertised-size') return new Response(new Uint8Array([1]), { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } });
        if (failure === 'streamed-size') return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
        return audioResponse();
      });
      h.env.decode = async () => {
        if (failure === 'decode') throw new Error('malformed audio');
        return buffer(5.01);
      };
      const player = h.player(); player.setFigure(figure({ src: '/invalid.ogg' })); player.unlock(); player.play('idle'); await flush();
      h.env.now = 700; player.play('idle'); await flush();
      assert.equal(h.fetch.mock.callCount(), 1, 'ordinary cooldown expiry does not fetch deterministic failures again');
      assert.equal(h.context().sources.length, 0);
      h.fetch.mock.mockImplementation(async () => audioResponse()); h.env.decode = undefined;
      h.env.now = 30_001; player.play('idle'); await flush();
      assert.equal(h.fetch.mock.callCount(), 2, 'the failure memo expires so corrected audio can recover');
      assert.equal(h.context().sources.length, 1);
    });
  }

  it('resets deterministic failure backoff when the figure is replaced', async (t) => {
    const h = install(t, 'running');
    h.env.decode = async () => { throw new Error('malformed audio'); };
    const pack = figure({ src: '/idle.ogg' });
    const player = h.player(); player.setFigure(pack); player.unlock(); player.play('idle'); await flush();
    h.env.decode = undefined;
    player.setFigure(pack); player.play('idle'); await flush();
    assert.equal(h.fetch.mock.callCount(), 2);
    assert.equal(h.context().sources.length, 1, 'the replacement figure can retry immediately');
  });

  it('never memoizes stale decode failures into a replacement figure', async (t) => {
    const h = install(t, 'running');
    const old = deferred<AudioBuffer>(); h.env.decode = () => old.promise;
    const pack = figure({ src: '/shared.ogg' });
    const player = h.player(); player.setFigure(pack); player.unlock(); player.play('idle'); await flush();
    player.setFigure(pack);
    h.fetch.mock.mockImplementation(async () => { throw new Error('temporary network failure'); });
    player.play('idle'); await flush();
    old.reject(new Error('old malformed audio')); await flush();
    h.env.decode = undefined; h.fetch.mock.mockImplementation(async () => audioResponse());
    h.env.now = 700; player.play('idle'); await flush();
    assert.equal(h.fetch.mock.callCount(), 3);
    assert.equal(h.context().sources.length, 1);
  });

  it('bounds per-URL deterministic failure memos', async (t) => {
    const h = install(t, 'running');
    h.env.decode = async () => { throw new Error('malformed audio'); };
    const cues = Array.from({ length: 25 }, (_, index) => ({ src: `/invalid-${index}.ogg` }));
    const player = h.player(); player.setFigure({ cooldown: 0, events: { idle: cues } }); player.unlock();
    let choice = 0; t.mock.method(Math, 'random', () => (choice + 0.1) / cues.length);
    const play = async (index: number) => { choice = index; h.env.now += 150; player.play('idle'); await flush(); };
    for (let i = 0; i < cues.length; i++) await play(i);
    await play(24);
    assert.equal(h.fetch.mock.callCount(), 25, 'a recent failure stays memoized');
    await play(0);
    assert.equal(h.fetch.mock.callCount(), 26, 'the oldest failure is evicted from the bounded memo');
  });

  for (const failure of ['network', 'http'] as const) {
    it(`recovers from transient ${failure} failures after the ordinary cooldown`, async (t) => {
      const h = install(t, 'running');
      h.fetch.mock.mockImplementation(async () => {
        if (failure === 'network') throw new TypeError('connection lost');
        return new Response('', { status: 503 });
      });
      const player = h.player(); player.setFigure(figure({ src: '/retry.ogg' })); player.unlock(); player.play('idle'); await flush();
      h.fetch.mock.mockImplementation(async () => audioResponse());
      h.env.now = 700; player.play('idle'); await flush();
      assert.equal(h.fetch.mock.callCount(), 2);
      assert.equal(h.context().sources.length, 1);
    });
  }

  it('uses the latest nonzero volume when a pending file becomes ready', async (t) => {
    const h = install(t, 'running');
    const gate = deferred<Response>();
    h.fetch.mock.mockImplementation(() => gate.promise);
    const player = h.player({ enabled: true, volume: 0.9 });
    player.setFigure(figure({ src: '/idle.ogg' })); player.unlock(); player.play('idle');
    player.setOptions({ volume: 0.2 });
    gate.resolve(audioResponse()); await flush();
    assert.equal(peak(h.context().gains[0]!), 0.2 * 0.35 * 0.12);
  });

  it('can retry a URL after fetch throws synchronously', async (t) => {
    const h = install(t, 'running');
    h.fetch.mock.mockImplementation(() => { throw new Error('unavailable'); });
    const player = h.player(); player.setFigure(figure({ src: '/idle.ogg' })); player.unlock();
    player.play('idle'); await flush();
    h.env.now = 700;
    h.fetch.mock.mockImplementation(async () => audioResponse());
    player.play('idle'); await flush();
    assert.equal(h.fetch.mock.callCount(), 2);
    assert.equal(h.context().sources.length, 1);
  });

  it('caps slow file playback at five seconds even at half speed', async (t) => {
    const h = install(t, 'running'); h.env.decode = async () => buffer(5);
    const player = h.player(); player.setFigure(figure({ src: '/idle.ogg', playbackRate: 0.5 })); player.unlock(); player.play('idle'); await flush();
    assert.deepEqual(h.context().sources[0]!.starts, [[0, 0, 2.5]]);
    assert.deepEqual(h.context().sources[0]!.stops, [5]);
  });

  it('evicts decoded buffers by PCM bytes while preserving recent entries', async (t) => {
    const h = install(t, 'running');
    h.env.decode = async () => buffer(4, 2, 96_000); // 3,072,000 bytes each: only two fit in 8 MiB.
    const cues = Array.from({ length: 3 }, (_, index) => ({ src: `/pcm-${index}.ogg` }));
    const player = h.player(); player.setFigure({ cooldown: 0, events: { idle: cues } }); player.unlock();
    let choice = 0; t.mock.method(Math, 'random', () => (choice + 0.1) / cues.length);
    const play = async (index: number) => { choice = index; h.env.now += 150; player.play('idle'); await flush(); };
    await play(0); await play(1); await play(0); await play(2); await play(0);
    assert.equal(h.fetch.mock.callCount(), 3, 'the recently used PCM buffer remains cached');
    await play(1);
    assert.equal(h.fetch.mock.callCount(), 4, 'PCM pressure evicts the older buffer before the entry limit');
    assert.equal(h.context().sources.length, 6);
  });

  it('plays valid audio larger than the PCM cache budget without retaining it', async (t) => {
    const h = install(t, 'running');
    h.env.decode = async () => buffer(5, 8, 96_000); // 15,360,000 decoded bytes, but still a valid five-second cue.
    const player = h.player(); player.setFigure(figure({ src: '/uncached.ogg' })); player.unlock(); player.play('idle'); await flush();
    h.env.now = 700; player.play('idle'); await flush();
    assert.equal(h.fetch.mock.callCount(), 2);
    assert.equal(h.context().decoded.length, 2);
    assert.equal(h.context().sources.length, 2);
    assert.ok(h.context().sources.every((source) => source.stops[0] === source.starts[0]![0]! + 5));
  });

  it('bounds the decoded cache to 24 entries and refreshes recently used entries', async (t) => {
    const h = install(t, 'running');
    const cues = Array.from({ length: 25 }, (_, index) => ({ src: `https://sounds.example/${index}.ogg` }));
    const player = h.player(); player.setFigure({ cooldown: 0, events: { idle: cues } }); player.unlock();
    let choice = 0;
    t.mock.method(Math, 'random', () => (choice + 0.1) / cues.length);
    const play = async (index: number) => { choice = index; h.env.now += 150; player.play('idle'); await flush(); };
    for (let i = 0; i < 24; i++) await play(i);
    await play(0); await play(24); await play(0);
    assert.equal(h.requests.length, 25, 'recently used entry stays cached');
    await play(1);
    assert.equal(h.requests.length, 26, 'the oldest unused entry was evicted');
  });
});
