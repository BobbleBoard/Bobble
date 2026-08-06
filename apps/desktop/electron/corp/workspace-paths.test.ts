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


describe('workspaceFromTask — sentence punctuation is not part of the path', () => {
  const HOME = '/Users/user';

  /*
   * MEASURED. The prompt was "Ask the manager to set up a sample Godot game to
   * demo Godot in /Users/user/bobble-testbed/godotdemo." — the full stop was
   * captured, the whole team was rooted in a directory named `godotdemo.`, and
   * it built there perfectly. Nothing errored. The target directory stayed
   * empty and the run looked like it had produced nothing for 20 minutes.
   */
  it('drops a sentence-ending full stop', () => {
    expect(
      workspaceFromTask('set up a Godot game in /Users/user/bobble-testbed/godotdemo.', HOME),
    ).toBe('/Users/user/bobble-testbed/godotdemo');
  });

  it('drops it after a tilde path too', () => {
    expect(workspaceFromTask('build it in ~/work/mygame.', HOME)).toBe('/Users/user/work/mygame');
  });

  it('KEEPS interior dots — only the trailing one goes', () => {
    expect(workspaceFromTask('put it in ~/work/my.project', HOME)).toBe(
      '/Users/user/work/my.project',
    );
    expect(workspaceFromTask('put it in ~/work/my.project.', HOME)).toBe(
      '/Users/user/work/my.project',
    );
  });

  it('handles an ellipsis without leaving a stray dot', () => {
    expect(workspaceFromTask('start in ~/work/game...', HOME)).toBe('/Users/user/work/game');
  });

  it('still finds the path when the sentence continues normally', () => {
    expect(workspaceFromTask('build in ~/work/game and tell me when done', HOME)).toBe(
      '/Users/user/work/game',
    );
  });
});

describe('workspaceFromTask — the workspace is a directory, not an input file', () => {
  const HOME = '/Users/user';

  /*
   * MEASURED. "Deepest wins" was written for prompts naming one path. As soon as
   * a task names an input AND an output, the deepest is usually the input file
   * and the whole team gets rooted there — inside the user's Downloads, at a PDF.
   */
  it('picks the output directory over a deeper input file', () => {
    expect(
      workspaceFromTask(
        'build a tool in /Users/user/work/salestool that loads /Users/user/data/sales.csv',
        HOME,
      ),
    ).toBe('/Users/user/work/salestool');
  });

  it('does not root the team in Downloads because a source file was named', () => {
    expect(
      workspaceFromTask('convert ~/Downloads/report.pdf and put the result in ~/work/out', HOME),
    ).toBe('/Users/user/work/out');
  });

  it('still picks the deepest DIRECTORY when several are named', () => {
    expect(workspaceFromTask('work in ~/a and really in ~/a/b/game', HOME)).toBe(
      '/Users/user/a/b/game',
    );
  });

  it('falls back to a file-looking path when nothing else is named', () => {
    // A directory genuinely named `my.project` must still win when it is alone.
    expect(workspaceFromTask('set it up in ~/work/my.project', HOME)).toBe(
      '/Users/user/work/my.project',
    );
  });
});
