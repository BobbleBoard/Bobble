/**
 * HANDING A FILE TO THE OS — one door for every "Open", "Open with" and "Show".
 *
 * the user: "open buttons in the canvas / file presentation cards don't work, even
 * with selection of specific applications to open with." Part of why nobody
 * could see it: every caller dropped the answer on the floor (`void invoke`),
 * so a refusal and a success looked identical — nothing happened either way.
 * This module makes each request say what it did, and when it could not, WHY,
 * in words a person can act on.
 *
 * Electron-free on purpose (the unit tests run in plain Node): canvas-main.ts
 * owns the process-spawning half and the IPC.
 *
 * On macOS every request is ONE `open` invocation — `open <file>` is exactly
 * what a double-click in Finder does (LaunchServices, no Apple Events, no
 * `duti`), `-a`/`-b` pick the app, `-R` reveals. One mechanism means one set of
 * failure messages, and one thing a probe can observe (a fake `open` first on
 * PATH records the argv — see tests/e2e/open-buttons-probe.mjs).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the user asked the OS to do with a file. */
export type OpenRequest =
  /** Whatever the OS opens it with — the Finder double-click. */
  | { readonly kind: 'default'; readonly target: string }
  /** A named app or an `.app` bundle path (`open -a`). */
  | { readonly kind: 'app'; readonly app: string; readonly target: string }
  /** An app by bundle id (`open -b`) — what the Open-with menu offers. */
  | { readonly kind: 'bundle'; readonly bundleId: string; readonly target: string }
  /** Select it in a Finder window (`open -R`). */
  | { readonly kind: 'reveal'; readonly target: string };

export type OpenOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type TargetResult =
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly error: string };

/** `open`'s argv for a request. The target is always absolute, so it can never read as a flag. */
export function openArgv(req: OpenRequest): string[] {
  switch (req.kind) {
    case 'default':
      return [req.target];
    case 'app':
      return ['-a', req.app, req.target];
    case 'bundle':
      return ['-b', req.bundleId, req.target];
    case 'reveal':
      return ['-R', req.target];
  }
}

/**
 * What the renderer handed over → an absolute path that is on disk, or the
 * reason it cannot be opened.
 *
 * `path.resolve` used to do this, and it resolves a RELATIVE path against the
 * main process's cwd — `/` for an app launched from Finder — so a path the
 * renderer had not made absolute pointed at nothing, and `open` failed with a
 * message nobody saw. The URL forms are the ones a path can arrive in from the
 * page (a markdown link, a media src); a leading `~/` is a home reference.
 */
export function resolveOpenTarget(
  raw: unknown,
  deps: { readonly home: string; readonly exists: (p: string) => boolean },
): TargetResult {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, error: 'There was no file to open.' };
  let p = text;
  try {
    if (/^file:\/\//i.test(p)) p = fileURLToPath(p);
    else if (/^pd-file:\/\//i.test(p)) p = decodeURIComponent(new URL(p).pathname);
  } catch {
    return { ok: false, error: `${text} is not a file on this Mac.` };
  }
  if (p === '~') p = deps.home;
  else if (p.startsWith('~/')) p = path.join(deps.home, p.slice(2));
  if (!path.isAbsolute(p)) {
    return {
      ok: false,
      error: `Its path (${p}) does not say which folder it is in, so it cannot be found.`,
    };
  }
  const target = path.resolve(p);
  if (!deps.exists(target)) {
    return { ok: false, error: 'It is not there any more — it may have been moved or deleted.' };
  }
  return { ok: true, target };
}

/** Reverse-DNS bundle id (`com.apple.Preview`): dotted, no spaces, no slashes. */
export function isBundleId(value: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) && !/\.app$/i.test(value);
}

/**
 * The request(s) to try, in order, for an id from the Open-with menu.
 *
 * Real system apps arrive as a bundle id (`open -b`) or an `.app` path
 * (`open -a`); the named legacy ids stay as they were. Anything else is an app
 * NAME, which `open -a` finds by name — it used to fall through to the VS Code
 * branch, so an id this function did not recognise opened VS Code.
 */
export function openRequestsFor(
  appId: string,
  target: string,
  isDirectory: boolean,
): OpenRequest[] {
  const id = appId.trim().replace(/\/+$/, '');
  if (id === '' || id === 'default') return [{ kind: 'default', target }];
  if (/\.app$/i.test(id)) return [{ kind: 'app', app: id, target }];
  if (isBundleId(id)) return [{ kind: 'bundle', bundleId: id, target }];
  if (id === 'terminal') {
    return [{ kind: 'app', app: 'Terminal', target: isDirectory ? target : path.dirname(target) }];
  }
  if (id === 'xcode') return [{ kind: 'app', app: 'Xcode', target }];
  if (id === 'vscode-insiders') {
    return [
      { kind: 'app', app: 'Visual Studio Code - Insiders', target },
      { kind: 'app', app: 'Visual Studio Code', target },
    ];
  }
  return [{ kind: 'app', app: id, target }];
}

function extensionOf(target: string): string {
  const base = path.basename(target);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function appLabel(app: string): string {
  return path.basename(app).replace(/\.app$/i, '');
}

/**
 * `open`'s complaint (its stderr, or Electron's error string off macOS) → one
 * sentence saying WHY, phrased so it follows "Couldn't open report.md."
 *
 * The raw lines are for engineers: "No application knows how to open URL
 * file:///…/level.gd (Error Domain=NSOSStatusErrorDomain Code=-10814 …)".
 * Unrecognised text is passed through (first line only) rather than guessed at.
 */
export function describeOpenFailure(req: OpenRequest, detail: string): string {
  const text = detail.trim();
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  /* An .app PATH that no longer holds the app (moved, uninstalled, still in a
     cached Open-with list): `open -a` answers "The application … cannot be
     opened … no such file" (NSCocoaErrorDomain 260) — about the APP. Read as
     the file below, it sent the user looking for a file that is fine. */
  if (
    req.kind === 'app' &&
    /the application .+ cannot be opened.*(no such file|Code=260)/is.test(text)
  ) {
    return `${appLabel(req.app)} is not installed on this Mac.`;
  }
  if (/does not exist|no such file/i.test(text)) {
    return 'It is not there any more — it may have been moved or deleted.';
  }
  if (/unable to find application|LSCopyApplicationURLsForBundleIdentifier/i.test(text)) {
    return req.kind === 'app'
      ? `${appLabel(req.app)} is not installed on this Mac.`
      : 'That app is not installed on this Mac any more.';
  }
  if (/-10814|kLSApplicationNotFoundErr|no application knows how to open/i.test(text)) {
    if (req.kind === 'bundle' || req.kind === 'app') {
      return 'That app is not installed on this Mac any more.';
    }
    const ext = extensionOf(req.target);
    return ext === ''
      ? 'No app on this Mac is set to open it — choose one from Open with.'
      : `No app on this Mac is set to open .${ext} files — choose one from Open with.`;
  }
  if (/operation not permitted|not permitted|-54\b|permission/i.test(text)) {
    return `macOS did not allow it (${firstLine}).`;
  }
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(text)) {
    return 'The app did not answer in time.';
  }
  return firstLine === '' ? 'The Mac did not say why.' : firstLine;
}

/**
 * What a failed `open` said, for {@link describeOpenFailure}: its stderr — or,
 * when execFile's timeout killed it, that it timed out. That kill is told only
 * in `killed`/`signal`; the message is "Command failed: open -a … <file>" and
 * stderr is empty, so a slow app read as an engineer's command line.
 */
export function openFailureDetail(error: unknown): string {
  const e = error as { stderr?: string; killed?: boolean };
  if (e.killed === true) return 'timed out';
  return e.stderr?.trim() || String(error);
}

/**
 * May this process really hand things to the OS?
 *
 * A probe must never launch Preview, Finder or a browser over someone's work
 * (tests/e2e/harness.mjs), so under `PI_E2E=1` every request is RECORDED and
 * not run — unless the probe says it put a fake `open` first on PATH
 * (`PI_E2E_FAKE_OPEN=1`), in which case running it is exactly the point: the
 * fake records the argv the real one would have got.
 *
 * This used to be a renderer seam that skipped the IPC entirely under E2E,
 * which is why no probe ever saw an Open fail — the half that failed never ran.
 */
export type OpenPolicy = 'launch' | 'record';

export function openPolicy(env: Readonly<Record<string, string | undefined>>): OpenPolicy {
  if (env.PI_E2E !== '1') return 'launch';
  return env.PI_E2E_FAKE_OPEN === '1' ? 'launch' : 'record';
}
