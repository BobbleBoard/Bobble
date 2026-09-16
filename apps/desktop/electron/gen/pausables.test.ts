import { describe, expect, it, vi } from 'vitest';
import { createPausables, processTree, processTreeWithDepth } from './pausables';

describe('processTree', () => {
  it('walks every descendant of a root from one ps listing, root first', () => {
    const ps = ['  1 0', ' 100 1', ' 200 100', ' 201 100', ' 300 201', ' 400 1'].join('\n');
    expect(processTree(100, ps).sort((a, b) => a - b)).toEqual([100, 200, 201, 300]);
    expect(processTree(100, ps)[0]).toBe(100);
    expect(processTree(400, ps)).toEqual([400]);
    expect(processTree(999, ps)).toEqual([999]);
  });
});

describe('the registry', () => {
  it('stops and continues the trees it was given, and forgets a run that ends', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const reg = createPausables();
    const off = reg.register({
      id: 'gen:1',
      label: 'the picture',
      kind: 'gen',
      pid: () => process.pid,
    });
    expect(reg.active()).toBe(true);
    expect(reg.pauseAll('12% free')).toEqual(['the picture']);
    expect(reg.paused()).toBe(true);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGSTOP');
    expect(reg.resumeAll()).toEqual(['the picture']);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGCONT');
    off();
    expect(reg.active()).toBe(false);
    kill.mockRestore();
  });

  it('a run registered during a pause is stopped at once, and continued when it ends', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const reg = createPausables();
    reg.pauseAll('tight');
    const off = reg.register({
      id: 'gen3d:1',
      label: 'the 3D texture',
      kind: 'gen3d',
      pid: () => process.pid,
    });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGSTOP');
    kill.mockClear();
    off();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGCONT');
    kill.mockRestore();
  });

  it("terminates with the run's own cancel first, never an agent", async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const reg = createPausables();
    const cancel = vi.fn();
    reg.register({ id: 'gen:1', label: 'the picture', kind: 'gen', pid: () => undefined, cancel });
    reg.register({
      id: 'pi:1',
      label: 'the chat',
      kind: 'agent',
      pid: () => process.pid,
      neverTerminate: true,
    });
    const ended = await reg.terminateAll('only 2% of memory is free');
    expect(ended).toEqual(['the picture']);
    expect(cancel).toHaveBeenCalledWith('only 2% of memory is free');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(reg.list().map((e) => e.id)).toEqual(['pi:1']);
    kill.mockRestore();
  });
});

describe('a run under a server', () => {
  it('terminates only below the spared depth', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const reg = createPausables();
    reg.register({
      id: 'gen3d:1',
      label: 'the part split',
      kind: 'gen3d',
      pid: () => process.pid,
      spareDepth: 1,
    });
    await reg.terminateAll('the wall');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGKILL');
    kill.mockRestore();
  });

  it('reads depths off the listing: uv → server → worker', () => {
    const ps = ['  1 0', ' 100 1', ' 200 100', ' 300 200', ' 301 300'].join('\n');
    const tree = processTreeWithDepth(100, ps);
    expect(tree.find((t) => t.pid === 200)?.depth).toBe(1);
    expect(tree.find((t) => t.pid === 300)?.depth).toBe(2);
    expect(tree.find((t) => t.pid === 301)?.depth).toBe(3);
  });
});
