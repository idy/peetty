import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSoundGesture } from '../src/pet/activation.ts';

const gesture = (type: string, values: Record<string, unknown> = {}) => ({ type, isTrusted: true, ...values }) as unknown as Event;

describe('sound activation gestures', () => {
  it('uses mouse down and touch/pen release, after their activation becomes available', () => {
    assert.equal(isSoundGesture(gesture('pointerdown', { pointerType: 'mouse' })), true);
    assert.equal(isSoundGesture(gesture('pointerup', { pointerType: 'mouse' })), false);
    for (const pointerType of ['touch', 'pen']) {
      assert.equal(isSoundGesture(gesture('pointerdown', { pointerType })), false);
      assert.equal(isSoundGesture(gesture('pointerup', { pointerType })), true);
    }
  });

  it('accepts keyboard and assistive activation without accepting synthetic events or shortcuts', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a']) assert.equal(isSoundGesture(gesture('keydown', { key })), true);
    for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta']) assert.equal(isSoundGesture(gesture('keydown', { key })), false);
    for (const values of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      assert.equal(isSoundGesture(gesture('keydown', { key: 'a', ...values })), false);
    }
    assert.equal(isSoundGesture(gesture('click')), true);
    assert.equal(isSoundGesture(new Event('click')), false);
    assert.equal(isSoundGesture(gesture('pointermove', { pointerType: 'mouse' })), false);
  });
});
