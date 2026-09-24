/**
 * LIVE, READ-ONLY checks against this machine's real Tailscale. Opt-in:
 *
 *   PI_CLUSTER_LIVE=1 ./node_modules/.bin/vitest run src/live.test.ts
 *
 * Skipped otherwise, so the suite never depends on a tailnet. Each check runs
 * `scripts/live-check.mjs` under `env -i HOME=… PATH=/usr/bin:/bin` — no TERM,
 * no SHLVL, the environment a Finder-launched app has — because that is the
 * environment in which the macOS Tailscale binary can decide to be its GUI.
 * Only reads happen: status, whois, one `ping --c 1`.
 *
 * The frontmost app is read before and after: the check fails if Tailscale's
 * own window came to the front. (A change to some OTHER app is the person at
 * the keyboard, which is theirs to do — the same rule as the probe harness.)
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIVE = process.env.PI_CLUSTER_LIVE === '1';
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'live-check.mjs',
);

function frontmostApp(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to name of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

/** Run the live script the way the Finder would: an empty environment plus HOME and a bare PATH. */
function runFinderLike(mode: string): Record<string, unknown> {
  const out = execFileSync(
    '/usr/bin/env',
    ['-i', `HOME=${homedir()}`, 'PATH=/usr/bin:/bin', process.execPath, SCRIPT, mode],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const line = out.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

function assertTailscaleStayedHidden(before: string | null, after: string | null): void {
  if (before === null || after === null) return; // cannot tell: not macOS, or no automation permission
  if (after !== before) expect(after).not.toMatch(/tailscale/i);
}

describe.skipIf(!LIVE)('live, read-only (PI_CLUSTER_LIVE=1)', () => {
  it('readTailnet answers Running from a Finder-like environment, and no window appears', () => {
    const before = frontmostApp();
    const summary = runFinderLike('read-tailnet');
    const after = frontmostApp();
    // eslint-disable-next-line no-console
    console.log('[live] read-tailnet', JSON.stringify({ ...summary, before, after }));
    expect(summary.error).toBeUndefined();
    // The env really was empty: no TERM/SHLVL/PS1 for Tailscale to key off.
    expect(summary.env).not.toContain('TERM');
    expect(summary.env).not.toContain('SHLVL');
    expect(summary.state).toBe('Running');
    expect(summary.available).toBe(true);
    expect(summary.peers).toBeGreaterThan(0);
    assertTailscaleStayedHidden(before, after);
  });

  it('the adapter picks a backend, and whois/ping reach an own device', () => {
    const before = frontmostApp();
    const summary = runFinderLike('adapter');
    const after = frontmostApp();
    // eslint-disable-next-line no-console
    console.log('[live] adapter', JSON.stringify({ ...summary, before, after }));
    expect(summary.error).toBeUndefined();
    expect(summary.state).toBe('Running');
    expect(['localapi', 'cli']).toContain(summary.backend);
    expect((summary.cli as { state?: string } | null)?.state).toBe('Running');
    if (summary.target !== null) {
      expect((summary.whois as { found?: boolean }).found).toBe(true);
      expect((summary.whois as { stableIdMatches?: boolean }).stableIdMatches).toBe(true);
    }
    assertTailscaleStayedHidden(before, after);
  });
});
