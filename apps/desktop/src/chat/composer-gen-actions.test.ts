/**
 * Composer "+" modality actions: each key prefills a clean prompt scaffold.
 * Pure, node-testable.
 *
 * These used to also pin a harness task class. Classification is gone, so what
 * is left to assert is the part that was always doing the real work — the words
 * the button puts in the box.
 */
import { describe, expect, it } from 'vitest';
import { GEN_ACTION_PLANS, type GenActionKey } from './composer-gen-actions';

const KEYS: GenActionKey[] = ['image', 'video', 'motion', 'perception'];

describe('GEN_ACTION_PLANS', () => {
  it('covers every modality key, with a pill and an icon', () => {
    for (const key of KEYS) {
      const plan = GEN_ACTION_PLANS[key];
      expect(plan.pill.trim().length, key).toBeGreaterThan(0);
      expect(plan.icon, key).toBeTruthy();
    }
  });

  it('scaffolds are non-empty natural-language leads (never a `/slash` command)', () => {
    for (const key of KEYS) {
      const { scaffold } = GEN_ACTION_PLANS[key];
      expect(scaffold.trim().length).toBeGreaterThan(0);
      expect(scaffold.startsWith('/')).toBe(false);
      // Trailing space so the caret lands where the user types the subject.
      expect(scaffold.endsWith(' ')).toBe(true);
    }
  });
});
