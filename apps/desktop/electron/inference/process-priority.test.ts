import { describe, expect, it, vi } from 'vitest';
import { setBackgroundPriority, setWorkerTier } from './process-priority';

const okExec = () => vi.fn(async () => undefined);

describe('setBackgroundPriority', () => {
  it('uses taskpolicy on macOS, which needs no privileges', async () => {
    const exec = okExec();
    await expect(setBackgroundPriority(4242, true, { platform: 'darwin', exec })).resolves.toBe(
      'applied',
    );
    expect(exec).toHaveBeenCalledWith('taskpolicy', ['-b', '-p', '4242']);
  });

  it('restores with -B rather than leaving the server backgrounded forever', async () => {
    const exec = okExec();
    await setBackgroundPriority(4242, false, { platform: 'darwin', exec });
    expect(exec).toHaveBeenCalledWith('taskpolicy', ['-B', '-p', '4242']);
  });

  it('uses renice on Linux', async () => {
    const exec = okExec();
    await setBackgroundPriority(7, true, { platform: 'linux', exec });
    expect(exec).toHaveBeenCalledWith('renice', ['-n', '10', '-p', '7']);
  });

  it('says so, rather than pretending, where the platform offers nothing', async () => {
    const exec = okExec();
    await expect(setBackgroundPriority(7, true, { platform: 'win32', exec })).resolves.toBe(
      'unsupported',
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('is best-effort: a missing tool is not an error', async () => {
    const exec = vi.fn(async () => {
      throw new Error('taskpolicy: command not found');
    });
    await expect(setBackgroundPriority(7, true, { platform: 'darwin', exec })).resolves.toBe(
      'failed',
    );
  });

  it('refuses a pid that cannot be one', async () => {
    const exec = okExec();
    await expect(setBackgroundPriority(0, true, { platform: 'darwin', exec })).resolves.toBe(
      'failed',
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('setWorkerTier', () => {
  it('clamps a heavy worker to utility on macOS — lower CPU priority, disk untouched', async () => {
    const exec = vi.fn(async () => undefined);
    const r = await setWorkerTier(4242, 'utility', { platform: 'darwin', exec });
    expect(r).toBe('applied');
    expect(exec).toHaveBeenCalledWith('taskpolicy', ['-c', 'utility', '-p', '4242']);
  });

  it('uses the fully backgrounded tier for low power mode', async () => {
    const exec = vi.fn(async () => undefined);
    await setWorkerTier(4242, 'background', { platform: 'darwin', exec });
    expect(exec).toHaveBeenCalledWith('taskpolicy', ['-b', '-p', '4242']);
  });

  it('is a gentler nice on Linux for utility than for background', async () => {
    const exec = vi.fn(async () => undefined);
    await setWorkerTier(7, 'utility', { platform: 'linux', exec });
    await setWorkerTier(7, 'background', { platform: 'linux', exec });
    expect(exec.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      ['-n', '5', '-p', '7'],
      ['-n', '10', '-p', '7'],
    ]);
  });
});
