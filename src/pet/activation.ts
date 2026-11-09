/** Events that can activate Web Audio in the document receiving the gesture. */
export const SOUND_GESTURES = ['pointerdown', 'pointerup', 'keydown', 'click'] as const;

export function isSoundGesture(event: Event): boolean {
  if (!event.isTrusted) return false;
  if (event.type === 'pointerdown') return (event as PointerEvent).pointerType === 'mouse';
  if (event.type === 'pointerup') return (event as PointerEvent).pointerType !== 'mouse';
  // Includes assistive activation that has no preceding pointer event.
  if (event.type === 'click') return true;
  if (event.type !== 'keydown') return false;
  const key = event as KeyboardEvent;
  return !key.repeat && !key.isComposing && !key.metaKey && !key.ctrlKey && !key.altKey
    && !['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(key.key);
}
