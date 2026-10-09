import { describe, expect, it, vi } from 'vitest';
import { createIdleUnloader, IDLE_UNLOAD_MS, idleUnloadMs } from './idle-unload';

function rig(opts: { busy?: boolean } = {}) {
  let t = 0;
  let busy = opts.busy ?? false;
  const unload = vi.fn(async () => true);
  const reload = vi.fn(async () => {});
  const u = createIdleUnloader({
    now: () => t,
    idleMs: 300_000,
    busy: () => busy,
    unload,
    reload,
  });
  return {
    u,
    unload,
    reload,
    advance: (ms: number) => {
      t += ms;
    },
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

describe('the idle unloader', () => {
  it('unloads after five minutes without input, not before', async () => {
    const r = rig();
    r.advance(299_000);
    await r.u.tick();
    expect(r.unload).not.toHaveBeenCalled();
    r.advance(2_000);
    await r.u.tick();
    expect(r.unload).toHaveBeenCalledTimes(1);
    expect(r.u.state().unloaded).toBe(true);
  });

  it('restarts the clock on input', async () => {
    const r = rig();
    r.advance(290_000);
    r.u.noteInput();
    r.advance(290_000);
    await r.u.tick();
    expect(r.unload).not.toHaveBeenCalled();
  });

  it('never unloads under running work, and counts from when it ends', async () => {
    const r = rig({ busy: true });
    r.advance(20 * 60_000);
    await r.u.tick();
    expect(r.unload).not.toHaveBeenCalled();
    r.setBusy(false);
    r.advance(60_000);
    await r.u.tick();
    expect(r.unload).not.toHaveBeenCalled();
    r.advance(300_000);
    await r.u.tick();
    expect(r.unload).toHaveBeenCalledTimes(1);
  });

  it('loads back on the first input after an unload, once', async () => {
    const r = rig();
    r.advance(301_000);
    await r.u.tick();
    r.u.noteInput();
    r.u.noteInput();
    expect(r.reload).toHaveBeenCalledTimes(1);
    expect(r.u.state().unloaded).toBe(false);
  });

  it('does not count an unload that unloaded nothing', async () => {
    const r = rig();
    r.unload.mockResolvedValueOnce(false);
    r.advance(301_000);
    await r.u.tick();
    r.u.noteInput();
    expect(r.reload).not.toHaveBeenCalled();
  });

  it('is five minutes unless a probe sets its own window', () => {
    expect(idleUnloadMs({})).toBe(IDLE_UNLOAD_MS);
    expect(idleUnloadMs({ PI_IDLE_UNLOAD_MS: '4000' })).toBe(4000);
    expect(idleUnloadMs({ PI_IDLE_UNLOAD_MS: 'x' })).toBe(IDLE_UNLOAD_MS);
  });
});
