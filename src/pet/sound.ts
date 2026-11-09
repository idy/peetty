import { soundSource } from '../figure/sources.ts';
import type { FigureSounds, SoundCue, SoundEvent } from '../figure/types.ts';
import { clamp } from '../math.ts';

export interface PeettySoundOptions {
  enabled?: boolean;
  volume?: number;
}

const HEADROOM = 0.12;
const MAX_SECONDS = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CACHE = 24;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONS = 4;
const MAX_FAILURES = 24;
const FAILURE_TTL_MS = 30_000;
const DEADLINE_MS = 1_000;
const THROTTLE_MS = 120;

interface PlayingCue {
  sources: Set<AudioScheduledSourceNode>;
  gain: GainNode;
}

interface Download {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  promise: Promise<AudioBuffer | undefined>;
}

function level(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : clamp(value, 0, 1);
}

class InvalidAudio extends Error {}

function pcmBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try { await body?.cancel(); } catch { /* Already locked or canceled. */ }
}

/** Check streamed bytes as well as Content-Length; never buffer an unbounded response. */
async function readAudio(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!response.ok || signal.aborted) {
    await cancelBody(response.body);
    throw new Error('Audio unavailable');
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await cancelBody(response.body);
    throw new InvalidAudio('Audio too large');
  }
  if (!response.body) throw new InvalidAudio('Empty audio');
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (cancellation) return;
    try { cancellation = reader.cancel().catch(() => {}); }
    catch { cancellation = Promise.resolve(); }
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) break;
      if (done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes.buffer;
      }
      size += value.byteLength;
      if (size > MAX_BYTES) { cancel(); throw new InvalidAudio('Audio too large'); }
      chunks.push(value);
    }
    throw new Error('Audio canceled');
  } finally {
    signal.removeEventListener('abort', cancel);
    // Cancellation may settle the read before the underlying stream has stopped.
    await cancellation;
    reader.releaseLock();
  }
}

/** Browser-local, opt-in audio. Only unlock() may create or resume the context. */
export class SoundPlayer {
  private options = { enabled: false, volume: 1 };
  private figure: FigureSounds | undefined;
  private context: AudioContext | undefined;
  private unlocked = false;
  private readonly suspensions = new Set<object>();
  private document: Document | undefined;
  private playing: PlayingCue | undefined;
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly downloads = new Map<string, Download>();
  // Aborted native work still occupies a slot until its underlying promise settles.
  private readonly operations = new Set<Download>();
  private failures = new Map<string, number>();
  private readonly lastEvents = new Map<SoundEvent, number>();
  private lastPlay = -Infinity;
  private generation = 0;
  private request = 0;
  private readonly visibilityChanged = () => { if (this.document?.hidden) this.stop(); };
  private readonly contextChanged = () => {
    if (this.context?.state === 'running') {
      if (!this.audible && !this.suspensions.size) this.suspend();
    } else if (this.unlocked) {
      this.unlocked = false;
      this.stop();
    }
  };

  constructor(options: boolean | PeettySoundOptions = false) {
    this.setOptions(options);
  }

  get enabled(): boolean { return this.options.enabled; }

  setOptions(options: boolean | PeettySoundOptions): void {
    const next = typeof options === 'boolean' ? { enabled: options } : options;
    if (next.volume !== undefined && (!Number.isFinite(next.volume) || next.volume < 0 || next.volume > 1)) {
      throw new TypeError('Sound volume must be a finite number between 0 and 1');
    }
    const previousVolume = this.options.volume;
    this.options = {
      enabled: next.enabled ?? this.options.enabled,
      volume: next.volume ?? this.options.volume,
    };
    if (!this.audible) {
      this.unlocked = false;
      this.stop();
      this.suspend();
    } else if (this.playing && previousVolume !== this.options.volume) this.stopPlaying();
  }

  setFigure(sounds: FigureSounds | undefined): void {
    this.stop();
    this.cache.clear();
    this.failures = new Map();
    this.figure = sounds;
  }

  /** Call synchronously from a trusted user gesture; this never queues a cue. */
  unlock(): void | Promise<void> {
    if (!this.audible || (typeof document !== 'undefined' && document.hidden)) return;
    try {
      if (!this.context || this.context.state === 'closed') {
        const Audio = globalThis.AudioContext
          ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        this.context = new Audio();
        this.context.addEventListener('statechange', this.contextChanged);
      }
      if (!this.document && typeof document !== 'undefined') {
        this.document = document;
        this.document.addEventListener('visibilitychange', this.visibilityChanged);
      }
      const context = this.context;
      // A queued suspend must be followed by a native resume even if state is still running.
      if (context.state === 'running' && !this.suspensions.size) { this.unlocked = true; return; }
      this.unlocked = false;
      const generation = this.generation;
      const settled = () => {
        if (this.context !== context) return;
        if (!this.audible) {
          if (context.state === 'running' && !this.suspensions.size) this.suspend();
        } else if (generation === this.generation) {
          // An older rejected resume cannot relock a newer successful gesture.
          this.unlocked = context.state === 'running';
        }
      };
      // Every gesture retries natively, including when an earlier resume is still pending.
      return context.resume().then(settled, settled);
    } catch { /* Web Audio may be unavailable or blocked. */ }
  }

  /** A gesture-requested preview may wait for resume; lifecycle changes cancel it. */
  preview(event: SoundEvent): void {
    const generation = this.generation;
    const ready = this.unlock();
    const play = () => { if (generation === this.generation) this.play(event); };
    if (ready) void ready.then(play);
    else play();
  }

  play(event: SoundEvent): void {
    if (!this.canPlay() || !this.figure || !Object.hasOwn(this.figure.events, event)) return;
    const cues = this.figure.events[event];
    if (!cues?.length) return;
    const now = performance.now();
    if (now - this.lastPlay < THROTTLE_MS || now - (this.lastEvents.get(event) ?? -Infinity) < (this.figure.cooldown ?? 0.6) * 1_000) return;
    const cue = cues[Math.floor(Math.random() * cues.length)];
    if (!cue) return;
    const volume = this.options.volume * level(this.figure.volume, 0.35) * level(cue.volume, 1) * HEADROOM;
    const src = cue.src ? soundSource(this.figure, cue.src) : undefined;
    if (volume <= 0 || (!src && !cue.notes?.length)) return;
    this.lastPlay = now;
    this.lastEvents.set(event, now);
    const request = ++this.request;
    this.stopPlaying();
    try {
      if (cue.notes) this.playNotes(cue, volume);
      else if (src) {
        const cached = this.cache.get(src);
        if (cached) {
          this.cache.delete(src);
          this.cache.set(src, cached);
          this.playBuffer(cached, cue, volume);
        } else {
          void this.load(src).then((buffer) => {
            if (!buffer || request !== this.request || performance.now() - now >= DEADLINE_MS || !this.canPlay()) return;
            // Options may have changed while the audio was loading.
            const currentVolume = this.options.volume * level(this.figure?.volume, 0.35) * level(cue.volume, 1) * HEADROOM;
            try { this.playBuffer(buffer, cue, currentVolume); } catch { this.stopPlaying(); }
          }).catch(() => {});
        }
      }
    } catch { this.stopPlaying(); }
  }

  stop(): void {
    this.generation++;
    this.request++;
    for (const { controller, timeout } of this.downloads.values()) {
      clearTimeout(timeout);
      controller.abort();
    }
    this.downloads.clear();
    this.stopPlaying();
    this.lastEvents.clear();
    this.lastPlay = -Infinity;
  }

  /** Release owned resources; a later explicit unlock() may create a fresh context. */
  destroy(): void {
    this.stop();
    this.cache.clear();
    this.failures = new Map();
    this.figure = undefined;
    this.document?.removeEventListener('visibilitychange', this.visibilityChanged);
    this.document = undefined;
    const context = this.context;
    this.context = undefined;
    this.unlocked = false;
    this.suspensions.clear();
    if (context) {
      context.removeEventListener('statechange', this.contextChanged);
      try { void context.close().catch(() => {}); } catch { /* Context already closed. */ }
    }
  }

  private get audible(): boolean { return this.options.enabled && this.options.volume > 0; }

  private suspend(): void {
    const context = this.context;
    if (!context || context.state === 'closed') return;
    const pending = {};
    this.suspensions.add(pending);
    const settled = () => { this.suspensions.delete(pending); };
    try { void context.suspend().then(settled, settled); }
    catch { settled(); /* Suspension is not supported by every audio implementation. */ }
  }

  private canPlay(): boolean {
    return this.audible && this.unlocked && this.context?.state === 'running'
      && !(typeof document !== 'undefined' && document.hidden);
  }

  private stopPlaying(): void {
    const playing = this.playing;
    this.playing = undefined;
    if (!playing) return;
    for (const source of playing.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      try { source.disconnect(); } catch { /* Already disconnected. */ }
    }
    playing.sources.clear();
    try { playing.gain.disconnect(); } catch { /* Already disconnected. */ }
  }

  private begin(): PlayingCue {
    const gain = this.context!.createGain();
    const playing = { gain, sources: new Set<AudioScheduledSourceNode>() };
    this.playing = playing;
    gain.connect(this.context!.destination);
    return playing;
  }

  private track(playing: PlayingCue, source: AudioScheduledSourceNode): void {
    playing.sources.add(source);
    source.connect(playing.gain);
    source.onended = () => {
      source.onended = null;
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      playing.sources.delete(source);
      if (!playing.sources.size) {
        try { playing.gain.disconnect(); } catch { /* Already disconnected. */ }
        if (this.playing === playing) this.playing = undefined;
      }
    };
  }

  private envelope(gain: AudioParam, start: number, duration: number, volume: number): void {
    const attack = Math.min(0.005, duration / 4);
    const release = Math.min(0.015, duration / 4);
    gain.setValueAtTime(0, start);
    gain.linearRampToValueAtTime(volume, start + attack);
    gain.setValueAtTime(volume, start + duration - release);
    gain.linearRampToValueAtTime(0, start + duration);
  }

  private playNotes(cue: SoundCue, volume: number): void {
    const notes = cue.notes?.slice(0, 8);
    if (!notes?.length || notes.some((hz) => !Number.isFinite(hz) || hz < 80 || hz > 4_000)) return;
    const duration = clamp(cue.duration ?? 0.08, 0.03, 1);
    if (!Number.isFinite(duration)) return;
    const context = this.context!;
    const playing = this.begin();
    const start = context.currentTime;
    for (let i = 0; i < notes.length && i * duration < MAX_SECONDS; i++) {
      const at = start + i * duration;
      const length = Math.min(duration, MAX_SECONDS - i * duration);
      const source = context.createOscillator();
      this.track(playing, source);
      source.type = cue.waveform ?? 'sine';
      source.frequency.setValueAtTime(notes[i]!, at);
      this.envelope(playing.gain.gain, at, length, volume);
      source.start(at);
      source.stop(at + length);
    }
  }

  private playBuffer(buffer: AudioBuffer, cue: SoundCue, volume: number): void {
    const context = this.context!;
    const playing = this.begin();
    const source = context.createBufferSource();
    this.track(playing, source);
    const rate = clamp(cue.playbackRate ?? 1, 0.5, 2);
    const duration = Math.min(MAX_SECONDS, buffer.duration / rate);
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(rate, context.currentTime);
    this.envelope(playing.gain.gain, context.currentTime, duration, volume);
    source.start(context.currentTime, 0, duration * rate);
    source.stop(context.currentTime + duration);
  }

  private cacheBuffer(src: string, buffer: AudioBuffer): void {
    if (pcmBytes(buffer) > MAX_CACHE_BYTES) return;
    this.cache.set(src, buffer);
    let bytes = [...this.cache.values()].reduce((sum, cached) => sum + pcmBytes(cached), 0);
    while (this.cache.size > MAX_CACHE || bytes > MAX_CACHE_BYTES) {
      const [oldest, evicted] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      bytes -= pcmBytes(evicted);
    }
  }

  private load(src: string): Promise<AudioBuffer | undefined> {
    const existing = this.downloads.get(src);
    if (existing) return existing.promise;
    const failures = this.failures;
    const retryAt = failures.get(src);
    if (retryAt !== undefined) {
      if (performance.now() < retryAt) return Promise.resolve(undefined);
      failures.delete(src);
    }
    if (this.operations.size >= MAX_OPERATIONS) return Promise.resolve(undefined);
    const context = this.context!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
    const download: Download = { controller, timeout, promise: Promise.resolve(undefined) };
    this.downloads.set(src, download);
    this.operations.add(download);
    download.promise = (async () => {
      try {
        const response = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        const bytes = await readAudio(response, controller.signal);
        if (controller.signal.aborted) return;
        let buffer: AudioBuffer;
        try { buffer = await context.decodeAudioData(bytes); }
        catch { throw new InvalidAudio('Invalid audio'); }
        if (controller.signal.aborted || context !== this.context) return;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_SECONDS) throw new InvalidAudio('Invalid audio duration');
        this.cacheBuffer(src, buffer);
        return buffer;
      } catch (error) {
        if (error instanceof InvalidAudio && !controller.signal.aborted) {
          failures.set(src, performance.now() + FAILURE_TTL_MS);
          while (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value!);
        }
        return undefined;
      } finally {
        clearTimeout(timeout);
        this.operations.delete(download);
        if (this.downloads.get(src) === download) this.downloads.delete(src);
      }
    })();
    return download.promise;
  }
}
