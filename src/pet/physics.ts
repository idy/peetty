/**
 * Pure movement helpers in viewport pixels (y grows downward). Kept free of
 * the DOM so they can be tested directly.
 */

export const GRAVITY = 2600;
/** Fall speed (px/s) that counts as a full-strength landing. */
export const HARD_LANDING = 1500;

export interface Edge {
  left: number;
  right: number;
  y: number;
}

export interface Jump {
  vx: number;
  vy: number;
  duration: number;
  /** Height of the arc's top above the higher of the two points. */
  apex: number;
}

/**
 * Plans a ballistic jump that lands exactly on `to`. Returns null when the
 * target is out of reach for this jump power.
 */
export function planJump(from: [number, number], to: [number, number], power = 1): Jump | null {
  const dx = to[0] - from[0];
  const top = Math.min(from[1], to[1]);
  const apex = 36 + Math.min(80, Math.abs(dx) * 0.14);
  const peak = top - apex;
  const rise = from[1] - peak;
  if (rise > 360 * power || Math.abs(dx) > 440 * power) return null;
  const vy = -Math.sqrt(2 * GRAVITY * rise);
  const up = -vy / GRAVITY;
  const down = Math.sqrt((2 * (to[1] - peak)) / GRAVITY);
  const duration = up + down;
  return { vx: dx / duration, vy, duration, apex };
}

/** Position along a planned jump after `t` seconds. */
export function along(from: [number, number], jump: Jump, t: number): [number, number] {
  return [from[0] + jump.vx * t, from[1] + jump.vy * t + 0.5 * GRAVITY * t * t];
}

/**
 * The first edge a falling body crosses between two frames, if any. Only
 * edges under the body's x are considered; the highest crossed edge wins.
 */
export function landing(edges: readonly Edge[], x: number, fromY: number, toY: number): Edge | null {
  let best: Edge | null = null;
  for (const edge of edges) {
    if (x < edge.left || x > edge.right) continue;
    // An edge at or above the starting point was not crossed during this
    // frame. In particular, do not land again on the perch she just left.
    if (edge.y <= fromY || edge.y > toY) continue;
    if (!best || edge.y < best.y) best = edge;
  }
  return best;
}

/** Landing strength 0..1 from the vertical speed at impact. */
export function impact(vy: number): number {
  return Math.max(0, Math.min(1, vy / HARD_LANDING));
}

/** Picks a key by relative weight. */
export function weighted<K extends string>(weights: Partial<Record<K, number>>, random: () => number = Math.random): K | null {
  const entries = Object.entries(weights).filter(([, w]) => typeof w === 'number' && (w as number) > 0) as [K, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return null;
  let r = random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}
