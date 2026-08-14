/**
 * File-spill containment (blind-test round-2 #2). These cover the ROOT-CAUSE fix:
 * a RELATIVE path a tool writes must land in the resolved sandbox/project cwd, and
 * NEVER in HOME. The "fake tool runner" case drives the actual `write` tool
 * definition against a real temp workspace and asserts the byte hit the sandbox.
 *
 * NOTE: a REAL end-to-end check with a live local model (Gemma-class) issuing a
 * bare `write {path:"file1.txt"}` and confirming the file lands in the sandbox
 * (not /Users/<you>/) is still required to fully close the backlog item — that
 * needs the desktop app + a downloaded model and can't run in unit CI.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedWriteRoots,
  createSandboxFileTools,
  guardDestructiveRewrite,
  isInsideRoots,
  isNamedDestination,
  outsideWorkspaceRefusal,
  registerSandboxFileTools,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  sandboxBaseDir,
  stripCodeFence,
  stripMarkdownEscapes,
  suggestWorkspaceRelative,
  syntaxCheckFor,
  syntaxComplaint,
  withReadPathHeader,
} from './sandbox-fs.js';

const norm = (p: string) => path.resolve(p);

describe('resolveWorkspacePath', () => {
  const sandbox = '/tmp/pi/sandbox/conv1';

  it('roots a bare relative path at the workspace — NOT HOME (the reported bug)', () => {
    expect(resolveWorkspacePath('file1.txt', sandbox)).toBe(path.join(sandbox, 'file1.txt'));
    expect(resolveWorkspacePath('notes/todo.md', sandbox)).toBe(
      path.join(sandbox, 'notes/todo.md'),
    );
    // Crucially it does NOT land under the user's home directory.
    expect(resolveWorkspacePath('file1.txt', sandbox).startsWith(os.homedir() + path.sep)).toBe(
      false,
    );
  });

  it('passes an absolute path through (normalized)', () => {
    expect(resolveWorkspacePath('/etc/hosts', sandbox)).toBe('/etc/hosts');
    expect(resolveWorkspacePath('/tmp/a/../b/c.txt', sandbox)).toBe('/tmp/b/c.txt');
  });

  it('expands ~ and a leading @ the way pi does (so the fence can catch them)', () => {
    expect(resolveWorkspacePath('~/evil.txt', sandbox)).toBe(path.join(os.homedir(), 'evil.txt'));
    expect(resolveWorkspacePath('@file1.txt', sandbox)).toBe(path.join(sandbox, 'file1.txt'));
  });

  it('collapses .. escapes so the fence sees the real target', () => {
    expect(resolveWorkspacePath('../../escape.txt', sandbox)).toBe('/tmp/pi/escape.txt');
  });
});

describe('isNamedDestination', () => {
  const home = '/Users/user';

  /* The exact damage the user found. Asked for ~/bobble-testbed/corp-run with the
   * workspace at the Desktop, the fence refused and told the model to use a
   * relative name — so the project was built at /Users/user/Desktop/corp-run and
   * reported as if it were at the requested path. */
  it('honours an absolute path the caller wrote out in full', () => {
    expect(
      isNamedDestination(
        '/Users/user/bobble-testbed/corp-run',
        '/Users/user/bobble-testbed/corp-run',
        home,
      ),
    ).toBe(true);
  });

  it('honours a ~-anchored path the same way', () => {
    expect(isNamedDestination('~/projects/game', '/Users/user/projects/game', home)).toBe(true);
  });

  /* A bare name is spill, not intent — it stays fenced to the workspace, which is
   * what the containment was for. */
  it('does not honour a bare relative name', () => {
    expect(isNamedDestination('corp-run', '/Users/user/Desktop/corp-run', home)).toBe(false);
  });

  it('never roots work at bare HOME', () => {
    expect(isNamedDestination('~', '/Users/user', home)).toBe(false);
  });

  /* A direct child of HOME is a dump, not a destination — this is the case the
   * pre-existing fence test guards, and honouring it would have re-opened the
   * spill the fence was built for. */
  it('refuses a bare file dumped straight into HOME', () => {
    expect(isNamedDestination('~/notes.txt', '/Users/user/notes.txt', home)).toBe(false);
  });

  it('refuses application state and the OS library', () => {
    expect(isNamedDestination('~/.ssh/x', '/Users/user/.ssh/x', home)).toBe(false);
    expect(isNamedDestination('~/Library/x', '/Users/user/Library/x', home)).toBe(false);
  });

  it('refuses an absolute path outside the user entirely', () => {
    expect(isNamedDestination('/etc/hosts', '/etc/hosts', home)).toBe(false);
  });
});

describe('isInsideRoots', () => {
  const roots = [norm('/tmp/ws'), norm('/tmp/sandbox')];
  it('accepts the root itself and nested paths', () => {
    expect(isInsideRoots('/tmp/ws', roots)).toBe(true);
    expect(isInsideRoots('/tmp/ws/a/b.txt', roots)).toBe(true);
    expect(isInsideRoots('/tmp/sandbox/x.txt', roots)).toBe(true);
  });
  it('rejects HOME, siblings, and prefix look-alikes', () => {
    expect(isInsideRoots(path.join(os.homedir(), 'evil.txt'), roots)).toBe(false);
    expect(isInsideRoots('/tmp/wsomething/x', roots)).toBe(false);
    expect(isInsideRoots('/etc/passwd', roots)).toBe(false);
  });
});

describe('resolveWorkspaceRoot', () => {
  it('prefers the desktop env hint, then ctx.cwd', () => {
    const home = '/Users/tester';
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-'));
    try {
      expect(resolveWorkspaceRoot(ws, { PI_DESKTOP_WORKSPACE_ROOT: ws2 }, home)).toBe(norm(ws2));
      expect(resolveWorkspaceRoot(ws, {}, home)).toBe(norm(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });

  it('never roots at the bare HOME dir — a HOME candidate is skipped', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    try {
      // env hint == HOME is skipped; ctx.cwd (a real temp dir != HOME) wins.
      expect(resolveWorkspaceRoot(ws, { PI_DESKTOP_WORKSPACE_ROOT: home }, home)).toBe(norm(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls through to a dedicated sandbox dir — NEVER HOME — when every candidate is HOME', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
    const originalCwd = process.cwd();
    try {
      // Force process.cwd() == HOME too so ALL candidates collapse to HOME.
      process.chdir(home);
      const root = resolveWorkspaceRoot(home, { PI_DESKTOP_WORKSPACE_ROOT: home }, home);
      expect(root).not.toBe(norm(home));
      expect(root.startsWith(norm(sandboxBaseDir(home)))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createSandboxFileTools — fake tool runner', () => {
  let ws: string;
  let outside: string;
  const ctx = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function writeTool() {
    const tools = createSandboxFileTools({ getRoot: () => ws });
    const write = tools.find((t) => t.name === 'write');
    if (write === undefined) throw new Error('write tool missing');
    return write;
  }

  it('CONTAINS a relative write into the sandbox, not HOME', async () => {
    const write = writeTool();
    const res = await write.execute(
      'call-1',
      { path: 'file1.txt', content: 'hello sandbox' },
      undefined,
      undefined,
      ctx(ws),
    );
    // The byte landed in the sandbox…
    expect(fs.readFileSync(path.join(ws, 'file1.txt'), 'utf8')).toBe('hello sandbox');
    // …and nowhere near HOME.
    expect(fs.existsSync(path.join(os.homedir(), 'file1.txt'))).toBe(false);
    expect(res.content[0]?.type).toBe('text');
  });

  it('creates parent dirs for a nested relative path inside the sandbox', async () => {
    const write = writeTool();
    await write.execute(
      'call-2',
      { path: 'sub/dir/note.md', content: '# hi' },
      undefined,
      undefined,
      ctx(ws),
    );
    expect(fs.readFileSync(path.join(ws, 'sub/dir/note.md'), 'utf8')).toBe('# hi');
  });

  it('REFUSES an absolute write that escapes the workspace (fence), writing nothing', async () => {
    const write = writeTool();
    const target = path.join(outside, 'evil.txt');
    await expect(
      write.execute('call-3', { path: target, content: 'nope' }, undefined, undefined, ctx(ws)),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('REFUSES a ~ escape without touching HOME', async () => {
    const write = writeTool();
    // Resolves to <HOME>/pi-fence-should-never-write.txt — the fence rejects
    // BEFORE any fs call, so HOME is never touched.
    await expect(
      write.execute(
        'call-4',
        { path: '~/pi-fence-should-never-write.txt', content: 'nope' },
        undefined,
        undefined,
        ctx(ws),
      ),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(os.homedir(), 'pi-fence-should-never-write.txt'))).toBe(false);
  });

  it('allowedWriteRoots always includes the sandbox base', () => {
    expect(allowedWriteRoots(ws)).toContain(norm(sandboxBaseDir()));
    expect(allowedWriteRoots(ws)).toContain(norm(ws));
  });
});

describe('registerSandboxFileTools gating', () => {
  it('registers the four overrides only when PI_DESKTOP_FS_FENCE=1', () => {
    const names: string[] = [];
    const pi = { registerTool: (t: { name: string }) => names.push(t.name) } as never;

    expect(registerSandboxFileTools(pi, { env: {} })).toBe(false);
    expect(names).toHaveLength(0);

    expect(registerSandboxFileTools(pi, { env: { PI_DESKTOP_FS_FENCE: '1' } })).toBe(true);
    expect(names.sort()).toEqual(['edit', 'ls', 'read', 'write']);
  });
});

/*
 * the user: "an earlier godot max effort run left a folder on my desktop that is
 * called 'users' and has a hilarious path in it:
 * /Users/user/Desktop/Users/user/Desktop/platformer_game".
 *
 * One dropped character turns an absolute path into a relative one that resolves
 * happily against the cwd — nothing errors, it just builds an absurd tree
 * somewhere real and reports success.
 */
describe('a dropped leading slash is not a relative path', () => {
  it('repairs the exact shape the user found', () => {
    expect(resolveWorkspacePath('Users/the user/Desktop/platformer_game', '/Users/user/Desktop')).toBe(
      '/Users/user/Desktop/platformer_game',
    );
  });

  it('covers the other root-only directories', () => {
    expect(resolveWorkspacePath('Applications/Bobble.app', '/tmp/w')).toBe(
      '/Applications/Bobble.app',
    );
    expect(resolveWorkspacePath('var/log/x', '/tmp/w')).toBe('/var/log/x');
  });

  /* The repair must not eat genuine relative paths, which are the common case. */
  it('leaves real relative paths joined to the workspace', () => {
    expect(resolveWorkspacePath('src/main.ts', '/tmp/w')).toBe('/tmp/w/src/main.ts');
    expect(resolveWorkspacePath('notes.md', '/tmp/w')).toBe('/tmp/w/notes.md');
    expect(resolveWorkspacePath('./a/b', '/tmp/w')).toBe('/tmp/w/a/b');
  });

  it('does not fire on a lookalike that is not a root directory', () => {
    expect(resolveWorkspacePath('userscripts/x.js', '/tmp/w')).toBe('/tmp/w/userscripts/x.js');
    expect(resolveWorkspacePath('username.txt', '/tmp/w')).toBe('/tmp/w/username.txt');
  });

  it('still passes absolute paths straight through', () => {
    expect(resolveWorkspacePath('/Users/user/x', '/tmp/w')).toBe('/Users/user/x');
  });
});

describe('stripCodeFence — a markdown fence must never reach disk', () => {
  /*
   * MEASURED: an engineer wrote scenes/main.tscn ending in a bare ``` line.
   * Godot could not parse it, so a scene that was otherwise nearly right failed
   * to load and the team spent its remaining budget repairing the wrong thing.
   */
  it('drops a DANGLING closing fence (the measured case)', () => {
    const body = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n```\n';
    expect(stripCodeFence(body, '/w/scenes/main.tscn')).toBe(
      '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n',
    );
  });

  it('unwraps a body fenced top and bottom', () => {
    expect(stripCodeFence('```gdscript\nextends Node2D\n```', '/w/s.gd')).toBe('extends Node2D');
    expect(stripCodeFence('```\nhello\n```\n', '/w/a.txt')).toBe('hello');
  });

  it('leaves ordinary content completely alone', () => {
    const plain = 'extends Node2D\n\nfunc _ready():\n\tprint("hi")\n';
    expect(stripCodeFence(plain, '/w/s.gd')).toBe(plain);
  });

  it('leaves INTERIOR fences alone — they are not wrappers', () => {
    const doc = 'intro\n```js\ncode\n```\noutro\n';
    expect(stripCodeFence(doc, '/w/notes.txt')).toBe(doc);
  });

  it('never touches markdown — a fence there is content, not an artifact', () => {
    const md = '```js\nconsole.log(1)\n```\n';
    expect(stripCodeFence(md, '/w/README.md')).toBe(md);
    expect(stripCodeFence(md, '/w/doc.mdx')).toBe(md);
  });

  it('is safe on empty and whitespace bodies', () => {
    expect(stripCodeFence('', '/w/a.txt')).toBe('');
    expect(stripCodeFence('   \n', '/w/a.txt')).toBe('   \n');
  });
});

describe('guardDestructiveRewrite — a rewrite that ran out partway', () => {
  /*
   * MEASURED: asked to fix a 56-line tkinter app, the model rewrote app.py,
   * wrote its own reasoning into the source as it went, and abandoned
   * mid-rewrite. 21 lines landed with every method gone. It still PARSES, so
   * py_compile passed and nothing noticed — the user asked for five bug fixes
   * and got an empty shell.
   */
  const big = Array.from({ length: 56 }, (_, i) => `line ${i}`).join('\n');
  const read = (body: string | null) => () => body;

  it('refuses a write that deletes most of an existing file', () => {
    const out = guardDestructiveRewrite('/w/app.py', 'line 0\nline 1\nline 2', read(big));
    expect(out).not.toBeNull();
    expect(out).toContain('56 lines');
    // It must say what to do instead, not merely refuse.
    expect(out).toContain('`edit`');
  });

  /*
   * IT MUST SAY THE FILE IS UNTOUCHED — measured live, run 5.
   *
   * The refusal used to warn that "the file on disk is the only copy" and never
   * state that nothing had been written. The CEO read a run of these refusals and
   * concluded: "The file is corrupted - it has multiple issues from the failed
   * writes. I need to completely rewrite it from scratch." The file on disk
   * compiled cleanly the whole time. A guard that protects a file while
   * convincing the model it destroyed it has done net harm — `syntaxComplaint`
   * already said "Nothing was written", and this had to as well.
   */
  it('states outright that the file on disk is unchanged', () => {
    const out = guardDestructiveRewrite('/w/app.py', 'line 0\nline 1\nline 2', read(big)) ?? '';
    expect(out).toContain('NOTHING WAS WRITTEN');
    expect(out).toMatch(/UNCHANGED/);
    expect(out).not.toContain('the only copy');
  });

  it('allows a new file — there is nothing to lose', () => {
    expect(guardDestructiveRewrite('/w/new.py', 'a\nb', read(null))).toBeNull();
  });

  it('allows an ordinary edit that keeps most of the file', () => {
    const trimmed = big.split('\n').slice(0, 40).join('\n');
    expect(guardDestructiveRewrite('/w/app.py', trimmed, read(big))).toBeNull();
  });

  it('allows churn in a small file, where it is ordinary', () => {
    const small = 'a\nb\nc\nd\n';
    expect(guardDestructiveRewrite('/w/tiny.py', 'a', read(small))).toBeNull();
  });

  it('allows a genuine full rewrite of similar size', () => {
    const rewritten = Array.from({ length: 50 }, (_, i) => `new ${i}`).join('\n');
    expect(guardDestructiveRewrite('/w/app.py', rewritten, read(big))).toBeNull();
  });
});

describe('guardDestructiveRewrite — losing definitions, not just lines', () => {
  /*
   * MEASURED, and it is why the line-count rule alone was not enough: a rewrite
   * took app.py from 38 lines to 29 — 76% retained, comfortably "safe" — while
   * `main()` and the __main__ block vanished, `convert` was left half-written
   * ending in `# ...`, and the model's own thinking was in the source as
   * `# Wait, I used self.fmt in __init__`. The file was ruined and the
   * arithmetic said fine.
   */
  const before = [
    'import os',
    'class ConvertApp:',
    '    def __init__(self, root):',
    '        self.root = root',
    ...Array.from({ length: 20 }, (_, i) => `        self.x${i} = ${i}`),
    '    def handle_drop(self, path):',
    '        self.convert(path)',
    '    def convert(self, path):',
    '        return path',
    'def main():',
    '    ConvertApp(None)',
  ].join('\n');
  const read = () => before;

  it('refuses a rewrite that drops a function it was not asked to remove', () => {
    const truncated = before
      .split('\n')
      .filter((l) => !l.startsWith('def main'))
      .join('\n');
    const out = guardDestructiveRewrite('/w/app.py', truncated, read);
    expect(out).not.toBeNull();
    expect(out).toContain('main');
    expect(out).toContain('`edit`');
  });

  /* Both refusal paths must say it, not just the line-count one. */
  it('also states outright that the file on disk is unchanged', () => {
    const truncated = before
      .split('\n')
      .filter((l) => !l.startsWith('def main'))
      .join('\n');
    const out = guardDestructiveRewrite('/w/app.py', truncated, read) ?? '';
    expect(out).toContain('NOTHING WAS WRITTEN');
    expect(out).toMatch(/UNCHANGED/);
    expect(out).not.toContain('the only copy');
  });

  it('allows a rewrite that keeps every definition', () => {
    const edited = before.replace('return path', 'return path.upper()');
    expect(guardDestructiveRewrite('/w/app.py', edited, read)).toBeNull();
  });

  it('allows adding definitions', () => {
    expect(
      guardDestructiveRewrite('/w/app.py', `${before}\ndef extra():\n    pass`, read),
    ).toBeNull();
  });

  it('still catches a gutting even when no definition survives to compare', () => {
    expect(guardDestructiveRewrite('/w/app.py', 'import os', read)).not.toBeNull();
  });
});

describe('stripMarkdownEscapes — prose escaping that reached a code file', () => {
  /*
   * MEASURED: a rewrite wrote `self.status\_var.set(...)` into a .py file. The
   * model escaped the underscore the way it would in prose; the file stopped
   * compiling, and three genuinely correct bug fixes in the same write were
   * worth nothing.
   */
  it('unescapes \\_ in source files', () => {
    expect(stripMarkdownEscapes('self.status\\_var.set(1)', '/w/app.py')).toBe(
      'self.status_var.set(1)',
    );
  });

  it('leaves markdown and LaTeX alone, where the escape is real', () => {
    for (const f of ['/w/README.md', '/w/notes.mdx', '/w/paper.tex']) {
      expect(stripMarkdownEscapes('a\\_b', f)).toBe('a\\_b');
    }
  });

  it('does NOT touch \\* — that is ordinary in a regex', () => {
    // The overcorrection this guard must not make: r"\*" is working code.
    const src = 'import re\npat = re.compile(r"\\*")';
    expect(stripMarkdownEscapes(src, '/w/app.py')).toBe(src);
  });

  it('leaves other backslash escapes untouched', () => {
    const src = 'print("a\\nb")\npath = "C:\\\\tmp"';
    expect(stripMarkdownEscapes(src, '/w/app.py')).toBe(src);
  });
});

/**
 * A REFUSAL HAS TO CARRY THE CORRECT CALL.
 *
 * The CloudConvert/localconvert run: the model wrote `/localconvert/index.html`,
 * was refused with a message that named the working folder, and "corrected" it to
 * `localconvert/index.html` — so every file of that run landed in
 * `<workspace>/localconvert/`, one level too deep. The old text was accurate and
 * still steered it wrong, because "write inside the working folder (X)" reads as
 * "put it under X's name".
 */
describe('outsideWorkspaceRefusal', () => {
  const ROOT = '/Users/user/bobble-testbed/localconvert';

  it('hands back the exact relative path to pass', () => {
    const msg = outsideWorkspaceRefusal(
      'write',
      '/localconvert/index.html',
      '/localconvert/index.html',
      ROOT,
    );
    expect(msg).toContain('pass path: "index.html"');
  });

  /* The whole point: name the wrong answer so it cannot be re-derived. */
  it('names the duplicate-basename trap and what it would create', () => {
    const msg = outsideWorkspaceRefusal(
      'write',
      '/localconvert/index.html',
      '/localconvert/index.html',
      ROOT,
    );
    expect(msg).toContain('Do NOT pass "localconvert/index.html"');
    expect(msg).toContain('/Users/user/bobble-testbed/localconvert/localconvert/index.html');
  });

  it('still says which tool refused and where the path resolved', () => {
    const msg = outsideWorkspaceRefusal('edit', '~/evil.txt', '/Users/user/evil.txt', ROOT);
    expect(msg).toMatch(/^Refusing to edit outside the workspace/);
    expect(msg).toContain('/Users/user/evil.txt');
  });

  /* Kept from the original: a deliberate write elsewhere must be DECLARED. */
  it('keeps the never-lie-about-the-path instruction', () => {
    const msg = outsideWorkspaceRefusal('write', '/x/y.txt', '/x/y.txt', ROOT);
    expect(msg).toMatch(/SAY SO in your reply/);
  });
});

describe('suggestWorkspaceRelative', () => {
  const ROOT = '/Users/user/bobble-testbed/localconvert';

  it('drops a leading segment that duplicates the workspace basename', () => {
    expect(suggestWorkspaceRelative('/localconvert/index.html', ROOT)).toBe('index.html');
  });

  it('drops the whole root when it is echoed back absolutely', () => {
    expect(suggestWorkspaceRelative(`${ROOT}/src/app.js`, ROOT)).toBe('src/app.js');
  });

  /* A path with nothing in common with the root says nothing about where it
   * belongs here — suggest the filename, not someone else's directory tree. */
  it('suggests the bare filename for an unrelated absolute path', () => {
    expect(suggestWorkspaceRelative('/tmp/a/b/c.txt', ROOT)).toBe('c.txt');
    expect(suggestWorkspaceRelative('~/evil.txt', ROOT)).toBe('evil.txt');
  });

  it('never strips everything — something has to be written', () => {
    expect(suggestWorkspaceRelative('/localconvert', ROOT)).toBe('localconvert');
  });

  it('leaves a genuine relative path alone', () => {
    expect(suggestWorkspaceRelative('src/core/x.js', ROOT)).toBe('src/core/x.js');
  });
});

/**
 * A FILE THAT DOES NOT PARSE MUST NOT LAND.
 *
 * Run 3 wrote `</parameter> </function> [END OF EDITS]` into the middle of a
 * Python file — the model's own tool-call markup bleeding into content on a long
 * generation — and nothing noticed for the rest of the run. Every structural
 * check passed; the product was broken.
 */
describe('syntaxComplaint', () => {
  const ok = () => ({ status: 0, stderr: '' });
  const bad = (msg: string) => () => ({ status: 1, stderr: msg });

  it('says nothing when the file parses', () => {
    expect(syntaxComplaint('/w/a.py', 'x = 1\n', ok)).toBeNull();
  });

  /* No parser is a SKIP, not a verdict — the clean/broken/could-not-check
   * discipline. A .md or a .toml must never be refused for being unparseable. */
  it('says nothing for a kind of file no parser covers', () => {
    expect(syntaxComplaint('/w/notes.md', 'not code', bad('boom'))).toBeNull();
    expect(syntaxCheckFor('/w/notes.md')).toBeUndefined();
  });

  /* status null = the parser could not launch. Our missing python3 is not the
   * model's fault and must never block its write. */
  it('says nothing when the parser itself is not installed', () => {
    expect(syntaxComplaint('/w/a.py', 'garbage(', () => ({ status: null, stderr: '' }))).toBeNull();
  });

  it('refuses a file that does not parse, and quotes the parser', () => {
    const out = syntaxComplaint('/w/converter.py', 'def f(:\n', bad('SyntaxError: invalid syntax'));
    expect(out).toContain('converter.py does not parse');
    expect(out).toContain('SyntaxError: invalid syntax');
    expect(out).toContain('Nothing was written');
  });

  /* The measured cause deserves naming: a 4B breaks where the generation ran out. */
  it('points at the end of the file, where a long generation breaks', () => {
    const out = syntaxComplaint('/w/a.py', 'x', bad('bad'));
    expect(out).toMatch(/Check the END of what you sent/);
    expect(out).toMatch(/tool-call markup/);
  });

  it('rewrites the temp path back to the real filename', () => {
    let target = '';
    const out = syntaxComplaint('/w/real.py', 'x', (_c, t) => {
      target = t;
      return { status: 1, stderr: `File "${t}", line 3` };
    });
    expect(out).toContain('File "/w/real.py", line 3');
    expect(out).not.toContain(target);
  });

  it('covers the languages whose parsers are already on the machine', () => {
    expect(syntaxCheckFor('/w/a.py')).toEqual(['python3', '-m', 'py_compile']);
  });

  /*
   * NOT THE BARE NAME `node`. A pi child inherits the GUI app's PATH
   * (/usr/bin:/bin:/usr/sbin:/sbin on a launchd-started macOS app), where python3
   * lives and node does not — so `spawnSync('node', …)` returned status null, the
   * parser-not-installed skip fired, and JavaScript went unchecked for a whole
   * run while a truncated main.js sailed through. This process is already a node,
   * so process.execPath is a runtime that exists by definition. Measured: with a
   * GUI PATH, `node --check` → null (never ran); `process.execPath --check` → 1.
   */
  it('reaches a node that exists rather than one it hopes is on PATH', () => {
    expect(syntaxCheckFor('/w/a.js')).toEqual([process.execPath, '--check']);
    expect(syntaxCheckFor('/w/a.mjs')).toEqual([process.execPath, '--check']);
    expect(syntaxCheckFor('/w/a.js')?.[0]).not.toBe('node');
  });
});

describe('withReadPathHeader', () => {
  const ABS = '/Users/user/bobble-testbed/lc/src/main.js';

  it('names the file above its own body', () => {
    const out = withReadPathHeader(ABS, [{ type: 'text', text: 'const x = 1;' }]) as Array<{
      text: string;
    }>;
    expect(out[0]?.text).toBe(`${ABS}\nconst x = 1;`);
  });

  it('always stamps an absolute path, never the relative one the model asked for', () => {
    const out = withReadPathHeader(ABS, [{ type: 'text', text: 'body' }]) as Array<{
      text: string;
    }>;
    expect(out[0]?.text.startsWith('/')).toBe(true);
  });

  /* An image read has no text part; the label still has to land somewhere. */
  it('gives an image result a text part of its own', () => {
    const out = withReadPathHeader(ABS, [{ type: 'image', data: 'AAAA' }]) as Array<{
      type: string;
      text?: string;
    }>;
    expect(out[0]).toEqual({ type: 'text', text: ABS });
    expect(out[1]?.type).toBe('image');
  });

  it('leaves the other parts untouched', () => {
    const parts = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'B' },
    ];
    const out = withReadPathHeader(ABS, parts) as Array<Record<string, unknown>>;
    expect(out[1]).toEqual({ type: 'image', data: 'B' });
    expect(out).toHaveLength(2);
  });

  it('does not throw on a result shape it does not recognise', () => {
    expect(withReadPathHeader(ABS, undefined)).toBeUndefined();
    expect(withReadPathHeader(ABS, 'plain')).toBe('plain');
  });
});
