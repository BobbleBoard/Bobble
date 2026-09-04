import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatOrganization } from '../../electron/settings/settings-contract';
import { displayTitle, groupChats, PROJECT_PROMPT_AT, shouldOfferProject } from './chat-org';

const EMPTY: ChatOrganization = { projects: [], assignments: {}, pinned: [], titles: {} };
const SANDBOX = '/home/u/.pi/desktop/sandbox/conv1';

function chat(file: string, cwd: string, modifiedAt = 't', title = file): SessionSummary {
  return {
    file,
    id: file,
    cwd,
    cwdLabel: cwd.replace('/home/u', '~'),
    startedAt: 't',
    modifiedAt,
    messageCount: 1,
    firstUserText: title,
    title,
    parentSession: null,
  };
}

describe('a working folder is NOT a project', () => {
  /*
   * the user: "not every working directory folder becomes a project, delete all
   * projects now, and projects can now only be created when explicitly done
   * so." Every cwd used to sprout its own folder, so the sidebar filled with
   * run5/run6/run7/corp-probe2 — one per experiment, none of them asked for.
   */
  it('leaves chats with a real cwd ungrouped', () => {
    const g = groupChats([chat('a', '/home/u/proj'), chat('b', '/home/u/proj')], EMPTY);
    expect(g.projects).toEqual([]);
    expect(g.ungrouped.map((c) => c.file)).toEqual(['a', 'b']);
  });

  it('invents no folder even for many chats in one directory', () => {
    const many = ['a', 'b', 'c', 'd'].map((f) => chat(f, '/home/u/proj'));
    expect(groupChats(many, EMPTY).projects).toEqual([]);
  });

  /* A project the user MADE still groups its chats — that is the whole point. */
  it('groups a chat the user assigned to a project they created', () => {
    const org: ChatOrganization = {
      projects: [{ id: 'p1', name: 'Converter' }],
      assignments: { a: 'p1' },
      pinned: [],
      titles: {},
    };
    const g = groupChats([chat('a', '/home/u/proj'), chat('b', '/home/u/proj')], org);
    expect(g.projects).toHaveLength(1);
    expect(g.projects[0]?.project.name).toBe('Converter');
    expect(g.projects[0]?.chats.map((c) => c.file)).toEqual(['a']);
    expect(g.ungrouped.map((c) => c.file)).toEqual(['b']);
  });

  it('floats pinned chats to the top of the ungrouped list', () => {
    const org: ChatOrganization = { ...EMPTY, pinned: ['b'] };
    const g = groupChats([chat('a', '/home/u/proj'), chat('b', '/home/u/proj')], org);
    expect(g.ungrouped.map((c) => c.file)).toEqual(['b', 'a']);
  });
});

describe('shouldOfferProject — exactly the third chat', () => {
  /*
   * the user: "the user gets a popup to 'create project' when they make their third
   * chat in the same working directory (excluding no project). not after or
   * before the third time." Asking at one is noise; asking at four and five is
   * nagging.
   */
  const inDir = (n: number) => Array.from({ length: n }, (_, i) => chat(`f${i}`, '/home/u/proj'));

  it('does not offer before the third', () => {
    expect(shouldOfferProject(inDir(1), '/home/u/proj', EMPTY)).toBe(false);
    expect(shouldOfferProject(inDir(2), '/home/u/proj', EMPTY)).toBe(false);
  });

  it('offers on exactly the third', () => {
    expect(PROJECT_PROMPT_AT).toBe(3);
    expect(shouldOfferProject(inDir(3), '/home/u/proj', EMPTY)).toBe(true);
  });

  it('does not keep asking after the third', () => {
    expect(shouldOfferProject(inDir(4), '/home/u/proj', EMPTY)).toBe(false);
    expect(shouldOfferProject(inDir(9), '/home/u/proj', EMPTY)).toBe(false);
  });

  /* No folder was chosen, so there is nothing to make a project of. */
  it('never offers for the sandbox', () => {
    const s = Array.from({ length: 3 }, (_, i) => chat(`f${i}`, SANDBOX));
    expect(shouldOfferProject(s, SANDBOX, EMPTY)).toBe(false);
  });

  it('does not offer when the folder already has a project', () => {
    const org: ChatOrganization = {
      projects: [{ id: 'p1', name: 'Converter' }],
      assignments: { f0: 'p1' },
      pinned: [],
      titles: {},
    };
    expect(shouldOfferProject(inDir(3), '/home/u/proj', org)).toBe(false);
  });
});

describe('displayTitle', () => {
  it('uses the rename override when present, else the derived title', () => {
    const s = chat('a', SANDBOX, 't', 'plan a launch');
    expect(displayTitle(s, EMPTY)).toBe('plan a launch');
    expect(displayTitle(s, { ...EMPTY, titles: { a: 'Launch plan' } })).toBe('Launch plan');
  });
});

/**
 * HOME is not a project. Sessions recorded at `~` exist (40 of them on the user's
 * machine — anything that reached pi without a usable cwd got pi's own
 * `existsSync(cwd) ? cwd : os.homedir()` fallback), and directory grouping names
 * a folder after the cwd label's last segment — so they invented a project
 * literally called `~` and every one of them joined it. the user asked for that to
 * stop, and for those chats to be treated as "no project".
 */
