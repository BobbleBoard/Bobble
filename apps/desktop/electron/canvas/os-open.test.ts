import { describe, expect, it } from 'vitest';
import {
  describeOpenFailure,
  isBundleId,
  openArgv,
  openPolicy,
  openRequestsFor,
  resolveOpenTarget,
} from './os-open';

const HOME = '/Users/probe';
const onDisk =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('resolveOpenTarget — what the renderer handed over, as a file on disk', () => {
  it('keeps an absolute path that exists', () => {
    expect(
      resolveOpenTarget('/Users/probe/Bobble/x/report.md', {
        home: HOME,
        exists: onDisk('/Users/probe/Bobble/x/report.md'),
      }),
    ).toEqual({ ok: true, target: '/Users/probe/Bobble/x/report.md' });
  });

  /* path.resolve used to turn this into `/report.md` — main's cwd is `/` when
     the app is launched from Finder — and `open` failed with nobody told. */
  it('refuses a relative path instead of resolving it against main’s cwd', () => {
    const r = resolveOpenTarget('report.md', { home: HOME, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/which folder/);
  });

  it('says a file that is gone is gone', () => {
    const r = resolveOpenTarget('/Users/probe/gone.png', { home: HOME, exists: () => false });
    expect(r).toEqual({
      ok: false,
      error: 'It is not there any more — it may have been moved or deleted.',
    });
  });

  it('expands a home reference', () => {
    expect(
      resolveOpenTarget('~/Bobble/a.png', {
        home: HOME,
        exists: onDisk('/Users/probe/Bobble/a.png'),
      }),
    ).toEqual({ ok: true, target: '/Users/probe/Bobble/a.png' });
  });

  it('reads file:// and pd-file:// URLs as the paths they carry', () => {
    const exists = onDisk('/Users/probe/My Files/a b.png');
    expect(
      resolveOpenTarget('file:///Users/probe/My%20Files/a%20b.png', { home: HOME, exists }),
    ).toEqual({ ok: true, target: '/Users/probe/My Files/a b.png' });
    expect(
      resolveOpenTarget('pd-file://f/Users/probe/My%20Files/a%20b.png', { home: HOME, exists }),
    ).toEqual({ ok: true, target: '/Users/probe/My Files/a b.png' });
  });

  it('normalises dot segments and a trailing slash', () => {
    const exists = onDisk('/Users/probe/proj');
    expect(resolveOpenTarget('/Users/probe/x/../proj/', { home: HOME, exists })).toEqual({
      ok: true,
      target: '/Users/probe/proj',
    });
  });

  it('refuses an empty path', () => {
    expect(resolveOpenTarget('  ', { home: HOME, exists: () => true }).ok).toBe(false);
    expect(resolveOpenTarget(undefined, { home: HOME, exists: () => true }).ok).toBe(false);
  });
});

describe('openRequestsFor — the Open-with id → what `open` is asked', () => {
  const T = '/w/report.md';

  it('default is the Finder double-click', () => {
    expect(openRequestsFor('default', T, false)).toEqual([{ kind: 'default', target: T }]);
    expect(openArgv({ kind: 'default', target: T })).toEqual([T]);
  });

  it('a bundle id is `open -b`', () => {
    const [req] = openRequestsFor('com.apple.Preview', T, false);
    expect(req).toEqual({ kind: 'bundle', bundleId: 'com.apple.Preview', target: T });
    expect(openArgv(req as never)).toEqual(['-b', 'com.apple.Preview', T]);
  });

  it('an .app path — spaces and all — is `open -a`', () => {
    const [req] = openRequestsFor('/Applications/Visual Studio Code.app', T, false);
    expect(openArgv(req as never)).toEqual(['-a', '/Applications/Visual Studio Code.app', T]);
  });

  /* An id nobody recognised used to fall through to the VS Code branch. */
  it('an app NAME is found by name, not sent to VS Code', () => {
    expect(openRequestsFor('Preview', T, false)).toEqual([
      { kind: 'app', app: 'Preview', target: T },
    ]);
  });

  it('keeps the legacy ids: Terminal opens the folder, Insiders falls back to stable', () => {
    expect(openRequestsFor('terminal', T, false)).toEqual([
      { kind: 'app', app: 'Terminal', target: '/w' },
    ]);
    expect(openRequestsFor('terminal', '/w/proj', true)).toEqual([
      { kind: 'app', app: 'Terminal', target: '/w/proj' },
    ]);
    expect(
      openRequestsFor('vscode-insiders', T, false).map((r) => (r as { app: string }).app),
    ).toEqual(['Visual Studio Code - Insiders', 'Visual Studio Code']);
  });

  it('reveal is `open -R`', () => {
    expect(openArgv({ kind: 'reveal', target: T })).toEqual(['-R', T]);
  });

  it('tells bundle ids from names and bundle paths', () => {
    expect(isBundleId('com.microsoft.VSCodeInsiders')).toBe(true);
    expect(isBundleId('Code - Insiders')).toBe(false);
    expect(isBundleId('/Applications/Preview.app')).toBe(false);
    expect(isBundleId('Foo.app')).toBe(false);
  });
});

describe('describeOpenFailure — why, in words a person can act on', () => {
  const doc = { kind: 'default', target: '/w/level.gd' } as const;

  it('no app claims the file type → pick one from Open with', () => {
    expect(
      describeOpenFailure(
        doc,
        'No application knows how to open URL file:///w/level.gd (Error Domain=NSOSStatusErrorDomain Code=-10814 "kLSApplicationNotFoundErr")',
      ),
    ).toBe('No app on this Mac is set to open .gd files — choose one from Open with.');
  });

  it('a named app that is not installed is named', () => {
    expect(
      describeOpenFailure(
        { kind: 'app', app: '/Applications/Blender.app', target: '/w/a.glb' },
        "Unable to find application named 'Blender'",
      ),
    ).toBe('Blender is not installed on this Mac.');
  });

  it('a bundle id that is not installed', () => {
    expect(
      describeOpenFailure(
        { kind: 'bundle', bundleId: 'com.nope.App', target: '/w/a.png' },
        'Unable to find application with identifier com.nope.App',
      ),
    ).toBe('That app is not installed on this Mac any more.');
  });

  it('a file that vanished', () => {
    expect(describeOpenFailure(doc, 'The file /w/level.gd does not exist.')).toBe(
      'It is not there any more — it may have been moved or deleted.',
    );
  });

  it('passes anything else through, first line only', () => {
    expect(describeOpenFailure(doc, 'LSOpenURLsWithRole() failed with error -600\nmore')).toBe(
      'LSOpenURLsWithRole() failed with error -600',
    );
    expect(describeOpenFailure(doc, '')).toBe('The Mac did not say why.');
  });
});

describe('openPolicy — a probe never launches an app over someone’s work', () => {
  it('launches for real outside E2E', () => {
    expect(openPolicy({})).toBe('launch');
  });

  it('records, and does not run, under E2E', () => {
    expect(openPolicy({ PI_E2E: '1' })).toBe('record');
  });

  it('runs under E2E only when the probe put a fake `open` first on PATH', () => {
    expect(openPolicy({ PI_E2E: '1', PI_E2E_FAKE_OPEN: '1' })).toBe('launch');
    // The flag alone outside E2E changes nothing.
    expect(openPolicy({ PI_E2E_FAKE_OPEN: '1' })).toBe('launch');
  });
});
