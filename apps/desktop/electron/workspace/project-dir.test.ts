/**
 * THE DROPDOWN IS THE END ALL BE ALL.
 *
 * the user: "if they have a project selected that dropdown right there is the end all
 * be all, everything is THAT DROPDOWN'S SELECTION. always always always nothing
 * competes with that." Otherwise ~/Bobble/<conversation name>.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('duplicate chat names get their own folders', () => {
  /*
   * Chat titles are GENERATED, so collisions are ordinary — "Godot game demo"
   * came up repeatedly in one afternoon of testing. Sharing a directory would
   * let a second chat overwrite the first one's work silently, which is the same
   * shape as every other path bug in this harness.
   */
  const tmp = mkdtempSync(join(tmpdir(), 'bobble-dirs-'));

  it('gives a second chat with the same title its own -2 folder', () => {
    const a = resolveProjectDir(null, 'Godot game demo', tmp, 'chat-a');
    const b = resolveProjectDir(null, 'Godot game demo', tmp, 'chat-b');
    expect(a).not.toBe(b);
    expect(a.endsWith('godot-game-demo')).toBe(true);
    expect(b.endsWith('godot-game-demo-2')).toBe(true);
  });

  it('is STABLE — the same chat always lands in the same folder', () => {
    const first = resolveProjectDir(null, 'Sales tool', tmp, 'chat-x');
    const again = resolveProjectDir(null, 'Sales tool', tmp, 'chat-x');
    expect(again).toBe(first);
  });

  it('adopts a folder the user made by hand rather than skipping past it', () => {
    // The projectless base is <home>/Bobble/<slug>.
    mkdirSync(join(tmp, 'Bobble', 'hand-made'), { recursive: true });
    expect(resolveProjectDir(null, 'hand made', tmp, 'chat-h')).toBe(
      join(tmp, 'Bobble', 'hand-made'),
    );
  });

  it('a SELECTED project is never slugged or de-duplicated', () => {
    // The dropdown is verbatim: two chats on one project share it, by design.
    const p = join(tmp, 'A Real Project');
    expect(resolveProjectDir(p, 'anything', tmp, 'chat-1')).toBe(p);
    expect(resolveProjectDir(p, 'anything', tmp, 'chat-2')).toBe(p);
  });
});

describe('the placeholder folder is renamed when the title arrives', () => {
  /*
   * MEASURED on the first clean run: a chat is nameless at its first turn (the
   * harness derives a title from the first message), so the folder is created as
   * `new-chat` and the real name lands seconds later. Without a rename the chat
   * ends up with TWO folders and its work split across them.
   */
  const tmp = mkdtempSync(join(tmpdir(), 'bobble-rename-'));

  it('renames new-chat to the real title while it is still empty', () => {
    const first = resolveProjectDir(null, 'new chat', tmp, 'chat-r');
    expect(first).toBe(join(tmp, 'Bobble', 'new-chat'));

    const renamed = resolveProjectDir(null, 'Todo CLI tool', tmp, 'chat-r');
    expect(renamed).toBe(join(tmp, 'Bobble', 'todo-cli-tool'));
    expect(existsSync(join(tmp, 'Bobble', 'new-chat'))).toBe(false);
  });

  it('does NOT move work that already exists — the name is cosmetic by then', () => {
    const dir = resolveProjectDir(null, 'new chat', tmp, 'chat-busy');
    writeFileSync(join(dir, 'main.py'), 'print(1)');
    const after = resolveProjectDir(null, 'Some Real Title', tmp, 'chat-busy');
    // A fresh folder for the new name; the written file stays where the model put it.
    expect(existsSync(join(dir, 'main.py'))).toBe(true);
    expect(after).not.toBe(dir);
  });

  it("never steals another chat's placeholder", () => {
    resolveProjectDir(null, 'new chat', tmp, 'chat-owner');
    const other = resolveProjectDir(null, 'Different Title', tmp, 'chat-thief');
    expect(other).toBe(join(tmp, 'Bobble', 'different-title'));
    expect(existsSync(join(tmp, 'Bobble', 'new-chat'))).toBe(true);
  });
});
