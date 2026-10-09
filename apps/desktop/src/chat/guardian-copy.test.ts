import { describe, expect, it } from 'vitest';
import { plainPressure } from './guardian-copy';

describe('plainPressure', () => {
  it('drops the counters and the mechanism, keeps the cause', () => {
    expect(
      plainPressure(
        'the machine is swapping hard (10643 pages/s) with 9% of memory free — paused for 20 readings and it did not come back',
      ),
    ).toBe('your Mac is moving memory to disk, and only 9% of memory is free');
    expect(plainPressure('the system reports memory pressure with 14% free (0.7% of pages)')).toBe(
      'only 14% of memory is free',
    );
    expect(plainPressure('only 4% of memory is free')).toBe('only 4% of memory is free');
    expect(plainPressure('the system reports critical memory pressure')).toBe(
      'macOS says memory is critically low',
    );
    expect(plainPressure('the app stalled for 2.1s with 8% of memory free')).toBe(
      'the app stopped responding for a moment, and only 8% of memory is free',
    );
  });
});
