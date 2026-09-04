/**
 * FULL ACCESS — the project mode the user asked for: "gives the model full reign and
 * full access … no sandboxing."
 *
 * Two doors have to open together, because a mode that opens one and not the
 * other is worse than either: the model's own write fence (the harness's
 * sandbox-fs override, installed from `PI_DESKTOP_FS_FENCE` at spawn) and the
 * app's write channel (`allowedWriteRoots`). These check the second directly and
 * the first through the flag that decides it.
 *
 * HOME is redirected at a temp dir for the whole file — both modules read
 * `os.homedir()` at import time, and a test that edited the real
 * `~/.pi/desktop/projects.json` would be one crash away from wiping someone's
 * project list.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fa-home-')));
const realHome = process.env.HOME;
process.env.HOME = home;
const PROJECTS = path.join(home, '.pi', 'desktop', 'projects.json');

beforeEach(() => {
  // Both modules capture paths (and read the doc) at import, so each case gets a
  // fresh module graph over the projects.json it just wrote.
  vi.resetModules();
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Write a projects.json with one active project, full access on or off. */
function withProject(dir: string, fullAccess: boolean): void {
  fs.mkdirSync(path.dirname(PROJECTS), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    PROJECTS,
    JSON.stringify({
      version: 1,
      activeId: 'p_test',
      projects: [{ id: 'p_test', name: path.basename(dir), path: dir, fullAccess }],
    }),
    'utf8',
  );
}

describe('activeProjectFullAccess', () => {
  const dir = path.join(home, 'work');

  it('is false for an ordinary project', async () => {
    withProject(dir, false);
    const { activeProjectFullAccess } = await import('./project/project-main');
    expect(activeProjectFullAccess()).toBe(false);
  });

  it('is true once the project is switched into it', async () => {
    withProject(dir, true);
    const { activeProjectFullAccess } = await import('./project/project-main');
    expect(activeProjectFullAccess()).toBe(true);
  });

  it('is false with NO project selected — the sandboxed default', async () => {
    fs.mkdirSync(path.dirname(PROJECTS), { recursive: true });
    fs.writeFileSync(
      PROJECTS,
      JSON.stringify({ version: 1, activeId: null, projects: [] }),
      'utf8',
    );
    const { activeProjectFullAccess } = await import('./project/project-main');
    expect(activeProjectFullAccess()).toBe(false);
  });
});

describe("the app's own write fence follows the mode", () => {
  const dir = path.join(home, 'work');
  const volumeRoot = path.parse(home).root;

  it('is a short list of project/session roots by default', async () => {
    withProject(dir, false);
    const { allowedWriteRoots } = await import('./fs-handlers');
    const roots = allowedWriteRoots();
    expect(roots).not.toContain(volumeRoot);
    expect(roots).toContain(dir);
  });

  it('opens to the whole filesystem under full access', async () => {
    withProject(dir, true);
    const { allowedWriteRoots } = await import('./fs-handlers');
    // "No sandboxing" (the user) — everything is under the volume root.
    expect(allowedWriteRoots()).toEqual([volumeRoot]);
  });
});
