/**
 * The guard's HANDS — what a verdict does to the runs registered with it.
 *
 * The verdicts themselves are pinned in packages/inference (guardian.test.ts);
 * this exercises the wiring in main: a `pause` stops every registered tree in
 * place, the calm verdict after it lets them go, a `shed` ends them (through
 * their own cancel, then the signal) and, with nothing of ours to end, parks
 * the chat model rather than letting the Mac hit the wall. With the guard
 * switched off, nothing is touched.
 */
import { describe, expect, it, vi } from 'vitest';

// A machine we control: the sampler is a queue of readings.
const readings: {
  memoryFree?: number;
  memoryFreeNow?: number;
  memory?: 'normal' | 'warn' | 'critical';
}[] = [];
vi.mock('@pi-desktop/inference', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pi-desktop/inference')>();
  return {
    ...real,
    samplePressure: async () => ({
      sources: ['test'],
      ...(readings.shift() ?? { memoryFree: 0.7 }),
    }),
  };
});

import { guardRun, pausables, startGuardian } from './guardian-main';

describe('the memory guard in main', () => {
  it('pauses, resumes, and terminates the runs registered with it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const announced: string[] = [];
    let guard = true;
    const parked: string[] = [];
    const g = startGuardian({
      queue: () => null,
      mode: () => 'auto',
      reserveGB: () => undefined,
      guardEnabled: () => guard,
      parkChatModel: async (why) => {
        parked.push(why);
      },
      announce: (e) =>
        announced.push(
          `${e.verdict}${e.paused ? `+paused:${e.paused.join('/')}` : ''}${e.resumed ? `+resumed:${e.resumed.join('/')}` : ''}`,
        ),
      log: () => {},
    });
    // The start-up reading (calm) has to land before the scripted ones.
    await new Promise((r) => setTimeout(r, 20));
    const cancel = vi.fn();
    const off = guardRun({
      id: 'gen3d:1',
      label: 'the 3D texture',
      kind: 'gen3d',
      pid: () => process.pid,
      cancel,
    });
    try {
      // 12% free: the pause line.
      readings.push({ memoryFree: 0.12 });
      expect(await g.refresh()).toBe('pause');
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGSTOP');
      expect(pausables.paused()).toBe(true);
      expect(announced.at(-1)).toBe('pause+paused:the 3D texture');
      // Nothing is admitted while a pause stands.
      expect(g.admit(1).ok).toBe(false);

      // Three readings OFF the pause line — still "warn", still a hold at the
      // door — and the run is let go: its own memory is what keeps the kernel
      // at warn, so waiting for calm was a pause that never lifted (MEASURED
      // 2026-09-16: CubePart in ps state T for five minutes).
      readings.push(
        { memoryFree: 0.4, memory: 'warn' },
        { memoryFree: 0.4, memory: 'warn' },
        { memoryFree: 0.4, memory: 'warn' },
      );
      expect(await g.refresh()).toBe('pause');
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGCONT');
      await g.refresh();
      expect(await g.refresh()).toBe('hold');
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGCONT');
      expect(announced.at(-1)).toBe('hold+resumed:the 3D texture');
      expect(pausables.paused()).toBe(false);
      expect(g.admit().ok).toBe(false); // unknown sizes wait at the door under a hold
      kill.mockClear();

      // A dip pauses it again; calm readings resume it.
      readings.push({ memoryFree: 0.12 });
      expect(await g.refresh()).toBe('pause');
      readings.push({ memoryFree: 0.7 }, { memoryFree: 0.7 }, { memoryFree: 0.7 });
      await g.refresh();
      await g.refresh();
      expect(await g.refresh()).toBe('calm');
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGCONT');
      expect(announced.at(-1)).toBe('calm+resumed:the 3D texture');

      // A pause, then the wall: the run is ended through its own cancel, and
      // the pause does not outlive it — a run registered afterwards runs.
      readings.push({ memoryFree: 0.12 });
      expect(await g.refresh()).toBe('pause');
      readings.push({ memoryFree: 0.5, memory: 'critical', memoryFreeNow: 0.01 });
      expect(await g.refresh()).toBe('shed');
      await new Promise((r) => setTimeout(r, 600));
      expect(cancel).toHaveBeenCalledWith(
        expect.stringMatching(/Stopped to keep your Mac responsive/),
      );
      expect(pausables.paused()).toBe(false);
      kill.mockClear();
      const offLater = guardRun({
        id: 'gen3d:2',
        label: 'the part split',
        kind: 'gen3d',
        pid: () => process.pid,
      });
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGSTOP');
      offLater();
    } finally {
      off();
    }

    // At the wall with nothing of ours running: the chat model is parked.
    readings.push(
      { memoryFree: 0.5 },
      { memoryFree: 0.5 },
      { memoryFree: 0.5 },
      { memoryFree: 0.5 },
      { memoryFree: 0.5 },
    );
    for (let i = 0; i < 5; i += 1) await g.refresh();
    readings.push({ memory: 'critical' });
    expect(await g.refresh()).toBe('shed');
    await new Promise((r) => setTimeout(r, 500));
    expect(parked.length).toBe(1);

    // Switched off: a pause-grade reading pauses nothing.
    guard = false;
    kill.mockClear();
    const off2 = guardRun({
      id: 'gen:2',
      label: 'the picture',
      kind: 'gen',
      pid: () => process.pid,
    });
    readings.push(
      { memoryFree: 0.7 },
      { memoryFree: 0.7 },
      { memoryFree: 0.7 },
      { memoryFree: 0.7 },
      { memoryFree: 0.7 },
    );
    for (let i = 0; i < 5; i += 1) await g.refresh();
    readings.push({ memoryFree: 0.12 });
    expect(await g.refresh()).toBe('pause');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGSTOP');
    off2();
    g.stop();
    kill.mockRestore();
  });

  it('brings back the chat model it parked once the machine is calm (MEASURED: Qwen 3.8 27B, parked for good)', async () => {
    let parks = 0;
    let resumes = 0;
    let generating = false;
    const g = startGuardian({
      queue: () =>
        ({
          running: () => generating,
          queued: () => 0,
          shedRunning: () => [],
          reconsider: () => {},
        }) as never,
      mode: () => 'auto',
      reserveGB: () => undefined,
      parkChatModel: async () => {
        parks += 1;
        return { ok: true };
      },
      resumeChatModel: async () => {
        resumes += 1;
      },
      announce: () => {},
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    const toTheWall = async () => {
      readings.push(
        { memoryFree: 0.5 },
        { memoryFree: 0.5 },
        { memoryFree: 0.5 },
        { memoryFree: 0.5 },
      );
      for (let i = 0; i < 4; i += 1) await g.refresh();
      readings.push({ memory: 'critical' });
      expect(await g.refresh()).toBe('shed');
      await new Promise((r) => setTimeout(r, 500));
    };
    const toCalm = async () => {
      let v = await g.refresh();
      for (let i = 0; i < 12 && v !== 'calm'; i += 1) {
        readings.push({ memoryFree: 0.8 });
        v = await g.refresh();
      }
      return v;
    };
    await toTheWall();
    expect(parks).toBe(1);
    expect(resumes).toBe(0);
    expect(await toCalm()).toBe('calm');
    expect(resumes).toBe(1);
    // Never while a generation runs: what it made room for is still using it.
    await toTheWall();
    generating = true;
    expect(await toCalm()).toBe('calm');
    expect(resumes).toBe(1);
    generating = false;
    readings.push({ memoryFree: 0.8 });
    await g.refresh();
    expect(resumes).toBe(2);
    g.stop();
  });
});
