import { describe, expect, it } from 'vitest';
import { EDIT_PHASES, PENDING_PHASES, pendingPhase } from './PendingMediaCard';

describe('what the waiting card says', () => {
  it('an edit says it is editing where a new picture says it is creating', () => {
    const at = pendingPhase(EDIT_PHASES.length, 0.2, 0, false);
    expect(EDIT_PHASES[at]).toBe('Editing your image…');
    expect(PENDING_PHASES.image[pendingPhase(PENDING_PHASES.image.length, 0.2, 0, false)]).toBe(
      'Creating your image…',
    );
  });

  it('otherwise walks the same phases in the same order', () => {
    expect(EDIT_PHASES.length).toBe(PENDING_PHASES.image.length);
    expect(EDIT_PHASES[0]).toBe(PENDING_PHASES.image[0]);
    expect(EDIT_PHASES.at(-1)).toBe(PENDING_PHASES.image.at(-1));
  });
});
