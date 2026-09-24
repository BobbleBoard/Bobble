import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerDeleteChatOption,
  registerThreadMenuEntry,
  runDeleteOptions,
  type ThreadMenuContext,
  threadMenuEntriesFor,
} from './thread-menu-entries';
import { registerThreadSlot, threadSlots } from './thread-slots';
import { registerTopBarNotice, sortNotices, type TopBarNotice } from './topbar-notices';

let off: Array<() => void> = [];
afterEach(() => {
  for (const f of off) f();
  off = [];
});

const ctx: ThreadMenuContext = {
  file: '/s/a.jsonl',
  title: 'plan a launch',
  pinned: false,
  projectId: undefined,
};

describe('thread slots', () => {
  it('are empty until a feature registers one', () => {
    expect(threadSlots()).toEqual([]);
    off.push(registerThreadSlot({ id: 'memory-chip', Component: () => null }));
    expect(threadSlots().map((s) => s.id)).toEqual(['memory-chip']);
  });
});

describe('the chat ⋯ menu and the delete dialog', () => {
  it('filters menu rows by the chat they are about', () => {
    const entries = [
      { id: 'forget', label: 'Forget what Bobble learned here', onSelect: vi.fn() },
      {
        id: 'pinned-only',
        label: 'x',
        onSelect: vi.fn(),
        visible: (c: ThreadMenuContext) => c.pinned,
      },
    ];
    expect(threadMenuEntriesFor(entries, ctx).map((e) => e.id)).toEqual(['forget']);
    off.push(registerThreadMenuEntry(entries[0] as (typeof entries)[0]));
  });

  it('runs every delete option with the box as ticked, or its default when the dialog was skipped', async () => {
    const got: Array<[string, boolean]> = [];
    off.push(
      registerDeleteChatOption({
        id: 'forget-memory',
        label: 'Also forget what Bobble learned from this chat',
        defaultChecked: () => true,
        onDelete: (_c, checked) => void got.push(['forget-memory', checked]),
      }),
      registerDeleteChatOption({
        id: 'broken',
        label: 'x',
        defaultChecked: () => false,
        onDelete: async () => {
          throw new Error('bug');
        },
      }),
    );
    const onError = vi.fn();
    await runDeleteOptions(ctx, { 'forget-memory': false }, onError);
    await runDeleteOptions(ctx, undefined, onError);
    expect(got).toEqual([
      ['forget-memory', false],
      ['forget-memory', true],
    ]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no option is registered', async () => {
    await expect(runDeleteOptions(ctx, undefined)).resolves.toBeUndefined();
  });
});

describe('top-bar notices', () => {
  it('sort most urgent first, ties in registration order', () => {
    const n = (id: string, priority: number): TopBarNotice => ({
      id,
      priority,
      Component: () => null,
    });
    expect(sortNotices([n('a', 0), n('b', 5), n('c', 5), n('d', -1)]).map((x) => x.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
    off.push(registerTopBarNotice(n('training', 10)));
  });
});
