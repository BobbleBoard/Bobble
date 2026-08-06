/**
 * THE DROPDOWN IS THE END ALL BE ALL.
 *
 * the user: "if they have a project selected that dropdown right there is the end all
 * be all, everything is THAT DROPDOWN'S SELECTION. always always always nothing
 * competes with that." Otherwise ~/Bobble/<conversation name>.
 */
import { describe, expect, it } from 'vitest';
import { bobbleProjectPath, projectSlug, resolveProjectDir } from './project-dir';

const HOME = '/Users/user';

describe('resolveProjectDir', () => {
  it('uses the selected project EXACTLY, whatever it is', () => {
    expect(resolveProjectDir('/Users/user/Desktop', 'anything', HOME)).toBe('/Users/user/Desktop');
    expect(resolveProjectDir('/Users/user/work/my app', 'anything', HOME)).toBe(
      '/Users/user/work/my app',
    );
  });

  it('falls back to ~/Bobble/<name> only when there is NO project', () => {
    expect(resolveProjectDir(null, 'Godot game demo', HOME)).toBe(
      '/Users/user/Bobble/godot-game-demo',
    );
    expect(resolveProjectDir('', 'Godot game demo', HOME)).toBe(
      '/Users/user/Bobble/godot-game-demo',
    );
    expect(resolveProjectDir('   ', 'Sales Data Tool', HOME)).toBe(
      '/Users/user/Bobble/sales-data-tool',
    );
  });
});

describe('projectSlug — this is a folder a human opens in Finder', () => {
  it('stays readable: spaces become hyphens, not nothing', () => {
    expect(projectSlug('Godot game demo')).toBe('godot-game-demo');
    expect(projectSlug('Sales   Data  Tool')).toBe('sales-data-tool');
  });

  it('cannot escape the base directory', () => {
    expect(projectSlug('../../etc/passwd')).not.toContain('/');
    expect(projectSlug('../../etc/passwd')).not.toMatch(/^\./);
    expect(projectSlug('...')).toBe('untitled');
    expect(projectSlug('/')).toBe('untitled');
  });

  it('never yields an empty segment', () => {
    expect(projectSlug('')).toBe('untitled');
    expect(projectSlug('!!!')).toBe('untitled');
  });

  it('is deterministic and length-capped', () => {
    expect(projectSlug('a'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(projectSlug('Same Name')).toBe(projectSlug('Same Name'));
  });

  it('bobbleProjectPath lands under ~/Bobble', () => {
    expect(bobbleProjectPath('My Deck', HOME)).toBe('/Users/user/Bobble/my-deck');
  });
});
