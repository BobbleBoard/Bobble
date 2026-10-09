import { describe, expect, it } from 'vitest';
import type { LlmStatus } from '../../electron/ipc-contract';
import { endedIdleUnload } from './idle-return';

const base = { serverRunning: true } as unknown as LlmStatus;

describe('endedIdleUnload', () => {
  it('is the moment an idle park clears with the server up', () => {
    expect(
      endedIdleUnload(
        { ...base, parked: 'x', parkedReason: 'idle' } as LlmStatus,
        { ...base } as LlmStatus,
      ),
    ).toBe(true);
  });

  it('is not a park for a generation, nor a park that is still on', () => {
    expect(endedIdleUnload({ ...base, parked: 'x', parkedReason: 'room' } as LlmStatus, base)).toBe(
      false,
    );
    const idle = { ...base, parked: 'x', parkedReason: 'idle' } as LlmStatus;
    expect(endedIdleUnload(idle, idle)).toBe(false);
  });
});
