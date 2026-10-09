import { describe, expect, it } from 'vitest';
import { claimsUndoForUnsend, isUndoKey, UNSEND_WINDOW_MS } from './unsend-gesture';

/**
 * The user (2026-09-24): "pressing cmd z within 3 seconds of sending a message and
 * before any text has been typed into the input box should unsend+rewind the
 * chat". Every other ⌘Z is ordinary undo and must stay exactly that.
 */
const key = (over: Partial<Parameters<typeof isUndoKey>[0]> = {}) => ({
  key: 'z',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});
const SENT = 1_000_000;
const armed = (over: Partial<Parameters<typeof claimsUndoForUnsend>[0]> = {}) =>
  claimsUndoForUnsend({
    armedAt: SENT,
    now: SENT + 1200,
    draftEmpty: true,
    inOtherField: false,
    ...over,
  });

describe('which keys are undo', () => {
  it('⌘Z and Ctrl+Z', () => {
    expect(isUndoKey(key())).toBe(true);
    expect(isUndoKey(key({ metaKey: false, ctrlKey: true }))).toBe(true);
    expect(isUndoKey(key({ key: 'Z' }))).toBe(true);
  });

  it('not redo (⇧⌘Z), not ⌥⌘Z, not a bare z', () => {
    expect(isUndoKey(key({ shiftKey: true }))).toBe(false);
    expect(isUndoKey(key({ altKey: true }))).toBe(false);
    expect(isUndoKey(key({ metaKey: false }))).toBe(false);
  });
});

describe('when ⌘Z takes the message back', () => {
  it('inside the window, with nothing in the box', () => {
    expect(armed()).toBe(true);
    expect(armed({ now: SENT + UNSEND_WINDOW_MS })).toBe(true);
  });

  it('the window is three seconds', () => {
    expect(UNSEND_WINDOW_MS).toBe(3000);
  });
});

describe('when ⌘Z is ordinary undo', () => {
  it('after the window', () => {
    expect(armed({ now: SENT + UNSEND_WINDOW_MS + 1 })).toBe(false);
  });

  it('once anything is in the box — that text is what undo is for', () => {
    expect(armed({ draftEmpty: false })).toBe(false);
  });

  it('in another field, whose own undo it is', () => {
    expect(armed({ inOtherField: true })).toBe(false);
  });

  it('with nothing sent to take back', () => {
    expect(armed({ armedAt: null })).toBe(false);
  });
});
