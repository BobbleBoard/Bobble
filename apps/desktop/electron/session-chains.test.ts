/**
 * ONE ROW PER CONVERSATION — the fix for the user's "many duplicate chats appear".
 *
 * MEASURED in their sessions directory: one conversation about spoofdpi had become
 * NINE files, because pi writes a fresh session (with a `parentSession` pointer)
 * every time the child is restarted on an existing one — and three of those nine
 * were created within seven seconds of each other. The chain there also FORKED:
 * two files claimed the same parent.
 */
import { describe, expect, it } from 'vitest';
import { keepChainTips } from './fs-handlers';
import type { SessionSummary } from './ipc-contract';

const s = (
  file: string,
  modifiedAt: string,
  parentSession: string | null = null,
): SessionSummary => ({
  file,
  id: file,
  cwd: '/w',
  cwdLabel: '/w',
  startedAt: modifiedAt,
  modifiedAt,
  messageCount: 2,
  firstUserText: 'how does spoofdpi work',
  title: 'how does spoofdpi work',
  parentSession,
  supersedes: [],
});

const files = (list: readonly SessionSummary[]) => list.map((x) => x.file).sort();

describe('keepChainTips', () => {
  it('collapses a resume chain to its newest member', () => {
    const chain = [
      s('/s/a.jsonl', '2026-09-04T04:32:00Z'),
      s('/s/b.jsonl', '2026-09-04T05:05:00Z', '/s/a.jsonl'),
      s('/s/c.jsonl', '2026-09-04T05:12:00Z', '/s/b.jsonl'),
    ];
    expect(files(keepChainTips(chain))).toEqual(['/s/c.jsonl']);
  });

  it('collapses a chain that FORKED — one row, the most recent state', () => {
    // His did: two restarts from the same parent, seconds apart.
    const chain = [
      s('/s/a.jsonl', '2026-09-04T05:13:24Z'),
      s('/s/dead.jsonl', '2026-09-04T05:13:31Z', '/s/a.jsonl'),
      s('/s/live.jsonl', '2026-09-04T05:51:44Z', '/s/a.jsonl'),
    ];
    expect(files(keepChainTips(chain))).toEqual(['/s/live.jsonl']);
  });

  it('keeps genuinely separate conversations apart', () => {
    const list = [s('/s/one.jsonl', 't1'), s('/s/two.jsonl', 't2')];
    expect(files(keepChainTips(list))).toEqual(['/s/one.jsonl', '/s/two.jsonl']);
  });

  it('does not lose a conversation whose ancestor was deleted', () => {
    // The parent is not in the listing, so the child is its own root.
    const list = [s('/s/child.jsonl', 't2', '/s/gone.jsonl')];
    expect(files(keepChainTips(list))).toEqual(['/s/child.jsonl']);
  });

  it('terminates on a corrupted self-referential pointer', () => {
    const list = [s('/s/loop.jsonl', 't1', '/s/loop.jsonl')];
    expect(files(keepChainTips(list))).toEqual(['/s/loop.jsonl']);
  });

  it('tells the renderer which files the surviving row stands in for', () => {
    // The store still names the ancestor after a resume (pi forked underneath
    // it), so without this the sidebar draws a second row for the same chat.
    const chain = [
      s('/s/a.jsonl', 't1'),
      s('/s/b.jsonl', 't2', '/s/a.jsonl'),
      s('/s/c.jsonl', 't3', '/s/b.jsonl'),
    ];
    const kept = keepChainTips(chain);
    expect(kept).toHaveLength(1);
    expect([...(kept[0]?.supersedes ?? [])].sort()).toEqual(['/s/a.jsonl', '/s/b.jsonl']);
  });

  it('leaves `supersedes` empty for a chat that never forked', () => {
    expect(keepChainTips([s('/s/solo.jsonl', 't1')])[0]?.supersedes).toEqual([]);
  });

  it('resolves paths before matching, so `.` segments still link a chain', () => {
    const list = [s('/s/a.jsonl', 't1'), s('/s/b.jsonl', 't2', '/s/./a.jsonl')];
    expect(files(keepChainTips(list))).toEqual(['/s/b.jsonl']);
  });
});
