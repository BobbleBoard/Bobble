import { describe, expect, it } from 'vitest';
import { prefillLabel } from './harness-status';

describe('prefillLabel', () => {
  it('names a chat model parked for a generation before any other cause', () => {
    expect(prefillLabel({ parked: true, modelPhase: 'starting' })).toBe(
      'Making room for a generation',
    );
    expect(prefillLabel({ parked: false, modelPhase: 'starting' })).toBe('Loading model');
    expect(prefillLabel({ modelPhase: 'ready', firstOfSession: true })).toBe('Starting up');
  });
});
