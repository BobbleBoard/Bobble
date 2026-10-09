/**
 * The guardian is the part of the power policy that ACTS, so every rule here is
 * one that, wrong, either freezes the machine (too lax) or cancels a fine job
 * (too eager). Both are things a person notices.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUSY_INTERVAL_MS,
  createGuardian,
  fits,
  type GuardianVerdict,
  IDLE_INTERVAL_MS,
  judge,
  limitsFor,
  settle,
} from './guardian.js';

const AUTO = limitsFor('auto');
const LOW = limitsFor('low');

describe('judge', () => {
  it('is calm on a healthy machine', () => {
    expect(judge({ memoryFree: 0.66, memory: 'normal', sources: ['sysctl'] }, AUTO).verdict).toBe(
      'calm',
    );
  });

  it('holds while memory is tight, and sheds at the wall', () => {
    expect(judge({ memoryFree: 0.18, sources: [] }, AUTO).verdict).toBe('hold');
    expect(judge({ memoryFree: 0.07, sources: [] }, AUTO).verdict).toBe('shed');
  });

  it("takes the OS's own verdict over any number", () => {
    // Plenty free by the percentage, but the kernel says critical: it knows
    // something about wired and compressor pages that the percentage does not.
    expect(judge({ memoryFree: 0.4, memory: 'critical', sources: [] }, AUTO).verdict).toBe('shed');
    // "warn" with memory to spare is the kernel reclaiming cache under a load
    // (MEASURED: ten seconds of it at 40% free while a 10 GB model loads) —
    // a hold at the door; with memory also tight it pauses running work.
    expect(judge({ memoryFree: 0.4, memory: 'warn', sources: [] }, AUTO).verdict).toBe('hold');
    expect(judge({ memoryFree: 0.18, memory: 'warn', sources: [] }, AUTO).verdict).toBe('pause');
  });

  it('reads the pages ACTUALLY free only with the kernel already warning', () => {
    // MEASURED on a calm Mac at 83% available: 2.4% of pages free. Normal —
    // macOS keeps its free count low by design. Alone it means nothing…
    expect(judge({ memoryFree: 0.83, memoryFreeNow: 0.024, sources: [] }, AUTO).verdict).toBe(
      'calm',
    );
    // …with the kernel at "warn" the run is paused (a load takes macOS through
    // warn at 0.6% free for a second; only "critical" or a pause that does
    // not lift ends it), and the number rides along in the reason.
    const j = judge({ memoryFree: 0.19, memory: 'warn', memoryFreeNow: 0.007, sources: [] }, AUTO);
    expect(j.verdict).toBe('pause');
    expect(j.reason).toMatch(/0\.7% of pages/);
    expect(
      judge({ memoryFree: 0.44, memory: 'critical', memoryFreeNow: 0.007, sources: [] }, AUTO)
        .verdict,
    ).toBe('shed');
  });

  it('reads heavy swap with memory to spare as a load burst — a hold, marked hot', () => {
    // MEASURED: FLUX.2 klein loading at 512² from 84% free — 33,000 pages/s for
    // a second or two, memory still at 43%. The load, not the freeze.
    const j = judge({ memoryFree: 0.43, swapIoPerSec: 33000, sources: [] }, AUTO);
    expect(j.verdict).toBe('hold');
    expect(j.hot).toBe(true);
    // Housekeeping-level traffic is not even that (MEASURED idle: 0-71 pages/s).
    expect(judge({ memoryFree: 0.4, swapIoPerSec: 60, sources: [] }, AUTO).verdict).toBe('calm');
  });

  it('sheds on heavy swap once memory is gone too — the burst had nowhere to go', () => {
    expect(judge({ memoryFree: 0.15, swapIoPerSec: 9000, sources: [] }, AUTO).verdict).toBe('shed');
  });

  it('reads a main-thread stall as thrashing only when memory is also tight', () => {
    // A long synchronous call with memory to spare is not the machine freezing.
    expect(judge({ memoryFree: 0.5, stallMs: 2400, sources: [] }, AUTO).verdict).toBe('calm');
    // The pointer freezing, measured from the inside.
    expect(judge({ memoryFree: 0.19, stallMs: 2400, sources: [] }, AUTO).verdict).toBe('shed');
    expect(judge({ memoryFree: 0.19, stallMs: 400, sources: [] }, AUTO).verdict).toBe('hold');
  });

  it('does not act on a machine that would not say', () => {
    expect(judge({ sources: [] }, AUTO).verdict).toBe('calm');
  });

  it('holds earlier in low power mode, but never sheds earlier', () => {
    // 25% free: fine at full/auto, already held in low.
    expect(judge({ memoryFree: 0.25, sources: [] }, AUTO).verdict).toBe('calm');
    expect(judge({ memoryFree: 0.25, sources: [] }, LOW).verdict).toBe('hold');
    // 12% free: PAUSED in both — the job keeps what it has and takes no more
    // until the machine breathes; it is stopped for good only where the OS
    // itself would start killing. The user: "low can't stop image generation
    // requests" — a pause is a wait, not a stop.
    expect(judge({ memoryFree: 0.12, sources: [] }, AUTO).verdict).toBe('pause');
    expect(judge({ memoryFree: 0.12, sources: [] }, LOW).verdict).toBe('pause');
    expect(judge({ memoryFree: 0.07, sources: [] }, LOW).verdict).toBe('shed');
    expect(LOW.shedFree).toBe(AUTO.shedFree);
    expect(LOW.pauseFree).toBe(AUTO.pauseFree);
    // A load burst at 30% free — ComfyUI reading a 5 GB DiT in — has room to
    // land in BOTH modes: a hold, never a pause. The room line used to be
    // low's own 30% hold line, and MEASURED (CubePart's text encode through
    // the app at 28–30% free) that was 39 pause/resume cycles in seven
    // minutes, each resume swapping back in what the pause had let the
    // kernel evict. Low must not slow a generation to half speed either.
    const burst = { memoryFree: 0.3, swapIoPerSec: 44506, sources: [] };
    expect(judge(burst, AUTO).verdict).toBe('hold');
    expect(judge(burst, LOW).verdict).toBe('hold');
    expect(judge({ ...burst, memoryFree: 0.28 }, LOW).verdict).toBe('hold');
    expect(judge({ ...burst, memoryFree: 0.28, memory: 'warn' }, LOW).verdict).toBe('hold');
    expect(judge({ ...burst, memoryFree: 0.24 }, LOW).verdict).toBe('pause');
    expect(LOW.tightFree).toBe(AUTO.tightFree);
    expect(LOW.pauseRoomFree).toBe(AUTO.pauseRoomFree);
    // With memory comfortable the burst is also marked as having ROOM, which
    // is what gives it the longer streak in settle().
    expect(judge({ memoryFree: 0.43, swapIoPerSec: 9000, sources: [] }, AUTO).room).toBe(true);
    expect(judge({ memoryFree: 0.22, swapIoPerSec: 9000, sources: [] }, LOW).room).toBe(false);
    // …and a real thrash (swapping with memory gone) is a shed in both.
    expect(judge({ memoryFree: 0.15, swapIoPerSec: 9000, sources: [] }, LOW).verdict).toBe('shed');
  });

  it('says why, in words a person can act on', () => {
    expect(judge({ memoryFree: 0.05, sources: [] }, AUTO).reason).toMatch(/5% of memory/);
    expect(judge({ memoryFree: 0.4, swapIoPerSec: 9000, sources: [] }, AUTO).reason).toMatch(
      /swapping/,
    );
  });
});

describe('settle', () => {
  it('acts at once on a bad reading', () => {
    expect(settle({ verdict: 'shed', reason: 'x' }, 'calm', 0, AUTO).verdict).toBe('shed');
    expect(settle({ verdict: 'hold', reason: 'x' }, 'calm', 0, AUTO).verdict).toBe('hold');
  });

  it('lifts a hold only after several calm readings in a row', () => {
    let state = { verdict: 'hold' as const, calmStreak: 0 };
    for (let i = 1; i < AUTO.recoveryReadings; i++) {
      const s = settle({ verdict: 'calm', reason: 'fine' }, state.verdict, state.calmStreak, AUTO);
      expect(s.verdict).toBe('hold');
      state = { verdict: s.verdict as 'hold', calmStreak: s.calmStreak };
    }
    const lifted = settle({ verdict: 'calm', reason: 'fine' }, 'hold', state.calmStreak, AUTO);
    expect(lifted.verdict).toBe('calm');
  });

  it('resets the streak on any dip', () => {
    const s = settle({ verdict: 'hold', reason: 'tight' }, 'hold', 3, AUTO);
    expect(s.calmStreak).toBe(0);
  });

  it('turns a swap burst that will not end into a shed', () => {
    const hot = { verdict: 'hold' as const, reason: 'swapping', hot: true };
    let previous: 'calm' | 'hold' = 'calm';
    let hotStreak = 0;
    for (let i = 1; i < AUTO.hotReadings; i++) {
      const s = settle(hot, previous, 0, AUTO, hotStreak);
      expect(s.verdict).toBe('hold');
      previous = 'hold';
      hotStreak = s.hotStreak;
    }
    const s = settle(hot, 'hold', 0, AUTO, hotStreak);
    expect(s.verdict).toBe('shed');
    expect(s.reason).toMatch(/readings running/);
  });

  it('a burst with room to land is given the longer streak', () => {
    // 43% free and churning (the mesh bake): four readings are not a thrash…
    const roomy = { verdict: 'hold' as const, reason: 'swapping', hot: true, room: true };
    let hotStreak = 0;
    for (let i = 1; i < AUTO.hotReadingsWithRoom; i++) {
      const s = settle(roomy, 'hold', 0, AUTO, hotStreak);
      expect(s.verdict).toBe('hold');
      hotStreak = s.hotStreak;
    }
    // …twenty of them are.
    expect(settle(roomy, 'hold', 0, AUTO, hotStreak).verdict).toBe('shed');
    expect(AUTO.hotReadingsWithRoom).toBeGreaterThan(AUTO.hotReadings);
  });

  it('a burst that ends resets the count', () => {
    const hot = { verdict: 'hold' as const, reason: 'swapping', hot: true };
    const a = settle(hot, 'calm', 0, AUTO, 0);
    const b = settle({ verdict: 'hold', reason: 'tight' }, 'hold', 0, AUTO, a.hotStreak);
    expect(b.hotStreak).toBe(0);
  });

  it('a shed is not sticky — it becomes an ordinary hold that recovers', () => {
    const s = settle({ verdict: 'calm', reason: 'fine' }, 'shed', 0, AUTO);
    expect(s.verdict).toBe('hold');
    expect(s.calmStreak).toBe(1);
  });
});

describe('fits', () => {
  it('admits a job with room to spare and names the numbers', () => {
    const r = fits({ footprintGB: 5.2, totalGB: 24, freeFraction: 0.66, reserveGB: 6 });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/GB needed/);
  });

  it('holds a job that would eat the reserve', () => {
    // 24 GB, 40% free = 9.6 GB available; a 12 GB image model needs ~14.8 GB.
    const r = fits({ footprintGB: 12, totalGB: 24, freeFraction: 0.4, reserveGB: 6 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs about 14\.8 GB/);
    expect(r.reason).toMatch(/keeping 6 GB/);
  });

  it('holds a job that fits only by spending the reserve', () => {
    // 16 GB available, 7 GB needed leaves 9 — fine with a 6 GB reserve, not with 10.
    expect(fits({ footprintGB: 5.2, totalGB: 24, freeFraction: 0.66, reserveGB: 6 }).ok).toBe(true);
    expect(fits({ footprintGB: 5.2, totalGB: 24, freeFraction: 0.66, reserveGB: 10 }).ok).toBe(
      false,
    );
  });

  it('refuses outright, with advice, a job that could not fit with everything else closed', () => {
    // FLUX.2 klein at 1024² on a 24 GB Mac: ~19 GB + headroom + a 6 GB reserve
    // is more than the machine. No reading will ever admit that — say so.
    const r = fits({ footprintGB: 19, totalGB: 24, freeFraction: 0.9, reserveGB: 6 });
    expect(r.ok).toBe(false);
    expect(r.never).toBe(true);
    expect(r.reason).toMatch(/smaller size/);
    expect(r.reason).toMatch(/reserve/);
    // …while the same job on a 48 GB machine is an ordinary question.
    expect(
      fits({ footprintGB: 19, totalGB: 48, freeFraction: 0.9, reserveGB: 6 }).never,
    ).toBeUndefined();
  });

  it('never holds a job on a guess', () => {
    // Unmeasured free memory admits a job that COULD fit; one that could not
    // is still refused, because that answer needs no reading.
    expect(fits({ footprintGB: 5, totalGB: 24, freeFraction: undefined, reserveGB: 6 }).ok).toBe(
      true,
    );
    expect(fits({ footprintGB: 40, totalGB: 24, freeFraction: undefined, reserveGB: 6 }).ok).toBe(
      false,
    );
  });
});

describe('createGuardian', () => {
  function harness(readings: Array<{ memoryFree?: number; swapIoPerSec?: number }>) {
    let i = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const verdicts: Array<{ verdict: string; reason: string }> = [];
    let busy = true;
    const g = createGuardian({
      sample: async () => ({
        ...(readings[Math.min(i++, readings.length - 1)] ?? {}),
        sources: ['t'],
      }),
      busy: () => busy,
      limits: () => AUTO,
      onVerdict: (verdict, reason) => verdicts.push({ verdict, reason }),
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    return { g, timers, verdicts, setBusy: (b: boolean) => (busy = b) };
  }

  it('calls a pause line with nothing heavy running a hold, and never sheds on it', async () => {
    const h = harness(Array.from({ length: 40 }, () => ({ memoryFree: 0.13 })));
    h.setBusy(false);
    for (let n = 0; n < 30; n += 1) expect(await h.g.poke()).not.toBe('shed');
    expect(h.verdicts.every((v) => v.verdict === 'hold' || v.verdict === 'calm')).toBe(true);
    h.setBusy(true);
    expect(await h.g.poke()).toBe('pause');
  });

  it('samples every second while heavy work runs, and slowly when idle', async () => {
    const h = harness([{ memoryFree: 0.6 }]);
    h.g.start();
    await vi.waitFor(() => expect(h.timers.length).toBe(1));
    expect(h.timers[0]?.ms).toBe(BUSY_INTERVAL_MS);
    h.setBusy(false);
    h.timers[0]?.fn();
    await vi.waitFor(() => expect(h.timers.length).toBe(2));
    expect(h.timers[1]?.ms).toBe(IDLE_INTERVAL_MS);
    h.g.stop();
  });

  it('sheds the moment a reading crosses the line', async () => {
    const h = harness([{ memoryFree: 0.6 }, { memoryFree: 0.05 }]);
    expect(await h.g.poke()).toBe('calm');
    expect(await h.g.poke()).toBe('shed');
    expect(h.verdicts[1]?.reason).toMatch(/5% of memory/);
  });

  it('takes an immediate reading when the host reports a long stall while busy', async () => {
    const h = harness([{ memoryFree: 0.15 }]);
    h.g.start();
    await vi.waitFor(() => expect(h.verdicts.length).toBe(1));
    h.g.heartbeat(2000);
    await vi.waitFor(() => expect(h.verdicts.length).toBe(2));
    // Tight memory + a 2s stall = the pointer freezing.
    expect(h.verdicts[1]?.verdict).toBe('shed');
    h.g.stop();
  });

  it('carries the worst stall into the next reading rather than the latest', async () => {
    const h = harness([{ memoryFree: 0.15 }]);
    h.g.heartbeat(1900);
    h.g.heartbeat(20);
    expect(await h.g.poke()).toBe('shed');
    // …and clears it, so one old stall does not shed twice (15% free on its
    // own is the pause line).
    expect(await h.g.poke()).toBe('pause');
  });

  it('turns raw swap counters into a rate across two readings', async () => {
    let n = 0;
    const g = createGuardian({
      sample: async () => {
        n += 1;
        return {
          memoryFree: 0.5,
          swapCounters: { ins: n === 1 ? 0 : 20000, outs: 0, at: n === 1 ? 0 : 1000 },
          sources: ['t'],
        };
      },
      busy: () => true,
      limits: () => AUTO,
      onVerdict: () => undefined,
    });
    expect(await g.poke()).toBe('calm'); // a rate needs two readings
    expect(await g.poke()).toBe('hold'); // 20,000 pages in one second with memory to spare: a burst
  });
});

describe('settle — the pause', () => {
  const at = (v: GuardianVerdict, extra = {}) => ({ verdict: v, reason: 'r', ...extra });

  it('pauses at once and resumes after a short calm streak', () => {
    let st = settle(at('pause'), 'calm', 0, AUTO);
    expect(st.verdict).toBe('pause');
    expect(st.pausedStreak).toBe(1);
    st = settle(at('calm'), 'pause', 0, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('pause'); // 1 of 3
    st = settle(at('calm'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('pause'); // 2 of 3
    st = settle(at('calm'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('calm');
  });

  it('a hold-grade reading keeps a paused job paused only briefly, then resumes it', () => {
    // MEASURED 2026-09-16: CubePart paused at "warn" with 27% free stayed in
    // ps state T for five minutes — its own memory kept the kernel at warn,
    // so "calm" never came. Hold means start nothing, not stop everything.
    let st = settle(at('hold'), 'pause', 0, AUTO, 0, 4);
    expect(st.verdict).toBe('pause'); // 1 of 3
    expect(st.pausedStreak).toBe(4);
    st = settle(at('hold'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('pause'); // 2 of 3
    st = settle(at('hold'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('hold'); // resumed; new work still held at the door
    expect(st.pausedStreak).toBe(0);
    expect(st.reason).toMatch(/resuming/);
  });

  it('a pause-line reading in the middle restarts the resume count', () => {
    let st = settle(at('hold'), 'pause', 0, AUTO, 0, 2);
    st = settle(at('hold'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.calmStreak).toBe(2);
    st = settle(at('pause'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('pause');
    expect(st.calmStreak).toBe(0);
    expect(st.pausedStreak).toBe(3);
  });

  it('hold-grade and calm readings count together toward the resume', () => {
    let st = settle(at('hold'), 'pause', 0, AUTO, 0, 1);
    st = settle(at('calm'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('pause'); // 2 of 3
    st = settle(at('hold'), 'pause', st.calmStreak, AUTO, 0, st.pausedStreak);
    expect(st.verdict).toBe('hold');
  });

  it('a pause that does not bring the memory back becomes a shed', () => {
    let st = {
      verdict: 'calm' as GuardianVerdict,
      calmStreak: 0,
      hotStreak: 0,
      pausedStreak: 0,
      reason: '',
    };
    for (let i = 0; i < AUTO.pausedReadingsBeforeShed - 1; i += 1) {
      st = settle(at('pause'), st.verdict, st.calmStreak, AUTO, st.hotStreak, st.pausedStreak);
      expect(st.verdict).toBe('pause');
    }
    st = settle(at('pause'), st.verdict, st.calmStreak, AUTO, st.hotStreak, st.pausedStreak);
    expect(st.verdict).toBe('shed');
    expect(st.reason).toMatch(/did not come back/);
  });

  it('a dip after a resume just pauses again — no streak carried over', () => {
    const st = settle(at('pause'), 'calm', 0, AUTO, 0, 0);
    expect(st.pausedStreak).toBe(1);
  });
});
