import { describe, expect, it, vi } from 'vitest';
import { setBackgroundPriority } from './process-priority';

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
