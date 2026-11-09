import type { Figure, FigureSounds } from './types.ts';

// Keep asset location outside the JSON: URL serialization must not change the
// figure's validated strings or inflate its serialized size before rendering.
const soundBases = new WeakMap<FigureSounds, string | undefined>();

export function resolveSoundSources(figure: Figure, base?: string): Figure {
  const pack = figure.sounds;
  if (!pack || soundBases.has(pack) || !Object.values(pack.events).some((cues) => cues?.some((cue) => cue.src))) return figure;
  const sounds = { ...pack };
  soundBases.set(sounds, base);
  return { ...figure, sounds };
}

/** Resolve at the audio boundary, preserving the figure pack's JSON data. */
export function soundSource(sounds: FigureSounds, source: string): string | undefined {
  try {
    const base = soundBases.has(sounds) ? soundBases.get(sounds) : globalThis.document?.baseURI;
    const origin = base ? new URL(base) : undefined;
    if (origin) { origin.username = ''; origin.password = ''; }
    const url = new URL(source, origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return;
    return url.href;
  } catch { return undefined; }
}
