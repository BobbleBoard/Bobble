/**
 * Both real manglings, and the legitimate paths that must survive untouched.
 * A false positive here would silently relocate a correct file, which is worse
 * than the bug being fixed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairNote, repairShadowTree, shadowRoots, unmanglePath,
  workspaceFromTask,
  stripBrokenInputMap,
} from './workspace-paths';

describe('the path the agent meant', () => {
  it('undoes run 11’s mangling — the whole absolute path, minus its leading slash', () => {
    const cwd = '/private/tmp/claude-501/abc-123/scratchpad/mesh11/ws';
    expect(
      unmanglePath(cwd, 'private/tmp/claude-501/abc-123/scratchpad/mesh11/ws/src/cli.py'),
    ).toBe('src/cli.py');
  });

  it('undoes run 9’s mangling — only the tail of the path', () => {
    const cwd = '/private/tmp/claude-501/abc-123/scratchpad/mesh9/ws';
    expect(unmanglePath(cwd, 'scratchpad/mesh9/ws/test_converter.py')).toBe('test_converter.py');
  });

  it('leaves ordinary relative paths completely alone', () => {
    const cwd = '/private/tmp/x/scratchpad/mesh9/ws';
    for (const p of ['cli.py', 'src/cli.py', 'tests/test_convert.py', 'a/b/c/d.py']) {
      expect(unmanglePath(cwd, p)).toBeUndefined();
    }
  });

  it('leaves absolute paths alone — those resolve correctly already', () => {
    const cwd = '/private/tmp/x/ws';
    expect(unmanglePath(cwd, '/private/tmp/x/ws/cli.py')).toBeUndefined();
  });

  it('does not strip a single matching component', () => {
    // The workspace ends in `src`, and `src/cli.py` is a perfectly normal thing
    // to write. One component is never enough evidence.
    const cwd = '/home/u/project/src';
    expect(unmanglePath(cwd, 'src/cli.py')).toBeUndefined();
  });

  it('never strips the whole path away', () => {
    const cwd = '/a/b/ws';
    expect(unmanglePath(cwd, 'b/ws')).toBeUndefined();
  });
});

describe('rescuing a shadow tree', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'pd-ws-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  /** Rebuild run 11's wreckage: the product written into a nested copy of ws. */
  const buildShadow = (): string => {
    const inner = path.join(ws, ...ws.split(path.sep).filter((c) => c !== ''));
    mkdirSync(path.join(inner, 'src'), { recursive: true });
    writeFileSync(path.join(inner, 'src', 'cli.py'), 'print("real work")');
    writeFileSync(path.join(inner, 'src', 'json_converter.py'), 'x = 1');
    return inner;
  };

  it('finds the shadow root', () => {
    const inner = buildShadow();
    expect(shadowRoots(ws)).toContain(inner);
  });

  it('moves the product to where the gate will look', () => {
    buildShadow();
    const moved = repairShadowTree(ws);
    expect(moved.map((m) => m.to).sort()).toEqual(
      [path.join('src', 'cli.py'), path.join('src', 'json_converter.py')].sort(),
    );
    expect(readFileSync(path.join(ws, 'src', 'cli.py'), 'utf8')).toBe('print("real work")');
  });

  it('never overwrites the real tree — the orphan is left readable', () => {
    const inner = buildShadow();
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src', 'cli.py'), 'the version already here');
    const moved = repairShadowTree(ws);
    expect(readFileSync(path.join(ws, 'src', 'cli.py'), 'utf8')).toBe('the version already here');
    expect(existsSync(path.join(inner, 'src', 'cli.py'))).toBe(true);
    expect(moved.map((m) => m.to)).toEqual([path.join('src', 'json_converter.py')]);
  });

  it('does nothing at all to a clean workspace', () => {
    writeFileSync(path.join(ws, 'cli.py'), 'fine');
    expect(shadowRoots(ws)).toEqual([]);
    expect(repairShadowTree(ws)).toEqual([]);
    expect(readFileSync(path.join(ws, 'cli.py'), 'utf8')).toBe('fine');
  });

  it('never throws on a directory that is not there', () => {
    expect(() => repairShadowTree('/definitely/not/a/directory')).not.toThrow();
  });

  it('says nothing when nothing moved, and names the files when they did', () => {
    expect(repairNote([])).toBe('');
    const note = repairNote([{ from: 'private/tmp/x/ws/src/cli.py', to: 'src/cli.py' }]);
    expect(note).toContain('src/cli.py');
    expect(note).toContain('BARE relative paths');
  });
});

describe('workspaceFromTask', () => {
  const home = '/Users/user';

  /* The exact task that put ten files on the Desktop: the corp rooted at the
   * chat's folder, so every relative `mkdir` landed there instead. */
  it('roots the team at the directory the task names', () => {
    expect(
      workspaceFromTask(
        'Build me a 2D platformer in Godot 4 at /Users/user/bobble-testbed/platformer: a player…',
        home,
      ),
    ).toBe('/Users/user/bobble-testbed/platformer');
  });

  it('understands ~ and takes the deepest path named', () => {
    expect(workspaceFromTask('put it in ~/bobble-testbed/games/run1 please', home)).toBe(
      '/Users/user/bobble-testbed/games/run1',
    );
    expect(workspaceFromTask('somewhere under ~/projects, say ~/projects/app/src', home)).toBe(
      '/Users/user/projects/app/src',
    );
  });

  it('falls through when the task names nowhere', () => {
    expect(workspaceFromTask('build me a platformer game', home)).toBeNull();
  });

  /* Same rule as the write fence: a direct child of HOME is a dump, and
   * application state is never a workspace. */
  it('refuses bare HOME, its direct children, dot-dirs and Library', () => {
    expect(workspaceFromTask('write to ~ please', home)).toBeNull();
    expect(workspaceFromTask('use ~/notes.txt', home)).toBeNull();
    expect(workspaceFromTask('use ~/.ssh/keys', home)).toBeNull();
    expect(workspaceFromTask('use ~/Library/Caches/x', home)).toBeNull();
  });

  it('ignores paths belonging to somebody else', () => {
    expect(workspaceFromTask('compare with /Users/other/thing/here', home)).toBeNull();
  });
});

describe('the one-component shadow', () => {
  /* Rooting the corp at the directory the task names made this common: the model
   * is told "build at .../platformer", is already standing in platformer, and
   * creates platformer/ again. Run 19 built its whole game in
   * platformer/platformer/2D Platformer/. */
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'shadow-'));

  it('finds a repeated leaf holding the project', () => {
    const root = tmp();
    mkdirSync(path.join(root, path.basename(root)), { recursive: true });
    writeFileSync(path.join(root, path.basename(root), 'project.godot'), 'x');
    expect(shadowRoots(root)).toContain(path.join(root, path.basename(root)));
  });

  it('finds it one level deeper, the way run 19 nested it', () => {
    const root = tmp();
    const inner = path.join(root, path.basename(root), '2D Platformer');
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, 'project.godot'), 'x');
    expect(shadowRoots(root)).toContain(path.join(root, path.basename(root)));
  });

  /* A genuine nested package (src/src, a python package inside its project) has
   * no marker that the outer level lacks, and must be left alone. */
  it('leaves a legitimate nested directory alone', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'project.godot'), 'x'); // real project at the top
    mkdirSync(path.join(root, path.basename(root)), { recursive: true });
    expect(shadowRoots(root)).not.toContain(path.join(root, path.basename(root)));
  });
});

describe('stripBrokenInputMap', () => {
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'inputmap-'));

  /* Six runs died on a hand-written [input] map redefining actions Godot already
   * ships. Run 25's had a stray escaped quote mid-serialisation. */
  it('removes the [input] section and leaves the rest intact', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'project.godot'),
      'config_version=5\n\n[application]\nconfig/name="G"\n\n[input]\nui_right={\n"deadzone": 0.5\n}\n\n[display]\nwindow/size/viewport_width=900\n',
    );
    expect(stripBrokenInputMap(dir)).toBe(true);
    const after = readFileSync(path.join(dir, 'project.godot'), 'utf8');
    expect(after).not.toContain('[input]');
    expect(after).not.toContain('deadzone');
    expect(after).toContain('config_version=5');
    expect(after).toContain('[display]');
    expect(after).toContain('window/size/viewport_width=900');
  });

  it('removes a trailing [input] section with nothing after it', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n\n[input]\nui_left={}\n');
    expect(stripBrokenInputMap(dir)).toBe(true);
    expect(readFileSync(path.join(dir, 'project.godot'), 'utf8')).not.toContain('[input]');
  });

  it('does nothing when there is no input section, or no file', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
    expect(stripBrokenInputMap(dir)).toBe(false);
    expect(stripBrokenInputMap(path.join(dir, 'nope'))).toBe(false);
  });
});
