import { describe, expect, it, vi } from 'vitest';
import { createUiRegistry } from './ui-registry';

describe('createUiRegistry', () => {
  it('keeps registration order, and the SAME array until something changes', () => {
    const r = createUiRegistry<{ id: string; n: number }>();
    const empty = r.list();
    expect(r.list()).toBe(empty); // a stable snapshot: no thrash for useSyncExternalStore
    r.register({ id: 'a', n: 1 });
    r.register({ id: 'b', n: 2 });
    const two = r.list();
    expect(two.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.list()).toBe(two);
  });

  it('replaces by id in place, and a stale removal leaves the replacement', () => {
    const r = createUiRegistry<{ id: string; n: number }>();
    const offOld = r.register({ id: 'a', n: 1 });
    r.register({ id: 'b', n: 2 });
    r.register({ id: 'a', n: 3 });
    expect(r.list().map((x) => [x.id, x.n])).toEqual([
      ['a', 3],
      ['b', 2],
    ]);
    offOld();
    expect(r.get('a')?.n).toBe(3);
  });

  it('notifies subscribers on register, removal and touch', () => {
    const r = createUiRegistry<{ id: string }>();
    const heard = vi.fn();
    const unsub = r.subscribe(heard);
    const off = r.register({ id: 'a' });
    r.touch();
    off();
    off(); // idempotent
    unsub();
    r.register({ id: 'b' });
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
