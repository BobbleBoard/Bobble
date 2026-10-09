/**
 * The picker offers exactly what the SIDEBAR lists — and the sidebar only lists
 * projects the user made.
 *
 * The user, first: "nothing should be in this dropdown if it isn't in the left
 * sidebar." Then, after seeing what that still allowed: "they shouldn't be there
 * unless they're in the project sidebar on the left which I should have to make
 * manually." The intermediate version derived a row per distinct chat working
 * directory, which sounded like "folders that exist" and turned out to mean one
 * row per conversation — MEASURED on his machine, 199 named `new-chat-N`.
 */
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../electron/ipc-contract';
import { activeVisibleProjectId, autoProjectPath, visibleProjectsOf } from './visible-projects';

const chat = (file: string, cwd: string): SessionSummary =>
  ({ file, cwd, cwdLabel: cwd, modifiedAt: '2026-07-29T00:00:00Z' }) as SessionSummary;

const org = (over: Partial<Parameters<typeof visibleProjectsOf>[1]> = {}) =>
  ({ projects: [], assignments: {}, pinned: [], titles: {}, ...over }) as Parameters<
    typeof visibleProjectsOf
  >[1];

describe('what a user may pick', () => {
  it('lists a project the user made, even before it has chats', () => {
    const got = visibleProjectsOf([], org({ projects: [{ id: 'p1', name: 'Movie' }] }));
    expect(got.map((p) => p.name)).toEqual(['Movie']);
    expect(got[0]?.auto).toBe(false);
  });

  it('lists NOTHING for a working folder nobody made a project for', () => {
    // This is the whole change: a chat living in ~/Desktop does not put
    // "Desktop" in the picker, because the user never made that project.
    expect(visibleProjectsOf([chat('a.jsonl', '/Users/j/Desktop')], org())).toEqual([]);
  });

  it('is empty with no projects, however many chats exist', () => {
    const sessions = Array.from({ length: 50 }, (_, i) =>
      chat(`c${i}.jsonl`, `/Users/j/Bobble/new-chat-${i}`),
    );
    expect(visibleProjectsOf(sessions, org())).toEqual([]);
  });

  it('never marks anything auto — there are no directory-derived rows left', () => {
    const got = visibleProjectsOf(
      [chat('a.jsonl', '/Users/j/code/thing')],
      org({ projects: [{ id: 'p1', name: 'Movie' }] }),
    );
    expect(got.every((p) => !p.auto)).toBe(true);
    expect(got.map(autoProjectPath)).toEqual([null]);
  });
});

/**
 * The user: "project selection just doesn't actually select the project when I click
 * it." It did select — the working folder changed underneath — but the chip asked
 * the ELECTRON project store which project was active, and that store answers with
 * a path hash (`p_1a2b`) while every row in the menu is a sidebar id. Nothing
 * could match, so no row was checked and the chip still read "No project".
 */
describe('which project reads as selected', () => {
  const visible = visibleProjectsOf([], org({ projects: [{ id: 'p1', name: 'Movie' }] }));

  it("checks the chat's own project", () => {
    expect(activeVisibleProjectId(visible, { orgProjectId: 'p1' })).toBe('p1');
  });

  it('never asks the electron store for the answer — its ids are not in the list', () => {
    expect(visible.some((p) => p.id === 'p_1a2b')).toBe(false);
  });

  it('selects nothing for a working folder with no project of its own', () => {
    // The chip still LABELS that folder (ComposerBar's placeholder) — a status
    // readout, not a list entry.
    expect(activeVisibleProjectId(visible, { workingPath: '/Users/j/Desktop' })).toBeNull();
    expect(activeVisibleProjectId(visible, { workingPath: null })).toBeNull();
  });
});
