/** Limits a value to the range from `min` to `max`; an empty range (`min > max`) gives its middle. */
export function clamp(value: number, min: number, max: number): number {
  return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value));
}
