/**
 * IS THE FAKE TAILSCALE READ BY THE REAL readTailnet()? — W0-B's acceptance for
 * _fake-tailscale.
 *
 * Imports packages/cluster's real `readTailnet` (the source, through
 * _ts-source.mjs) and runs it against the fake CLI in every state — Running
 * with its eight kinds of peer, NeedsLogin, NeedsMachineAuth, Stopped, and not
 * installed at all — then once more from a child process with an EMPTY
 * environment (no PATH, no TERM, no HOME), which is how a Finder-launched app
 * spawns the CLI and the case the devices doc's defect 1 is about. The real
 * tailnet is never touched and Tailscale's GUI never opens.
 *
 *   SHOT_DIR=/tmp/out node tests/e2e/fake-tailscale-smoke-probe.mjs
 */
import './_ts-source.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeTailscale, PEER_ROLES } from './_fake-tailscale.mjs';
import { focusComplaint, frontmostApp, REPO_ROOT } from './harness.mjs';

const { readTailnet } = await import('../../../../packages/cluster/src/host.ts');

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'fake-tailscale-smoke');
mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
    console.error(`fake-tailscale-smoke FAILED: ${message}`);
  }
  return ok;
};

const before = frontmostApp();
const ts = createFakeTailscale();
const results = {};
try {
  // ── every state, through the real reader ──
  ts.setState('running');
  const running = await readTailnet({ candidates: [ts.bin] });
  results.running = running;
  check(running.available === true, 'Running read as unavailable');
  check(
    running.peers.length === 1 + Object.keys(PEER_ROLES).length,
    `peers: ${running.peers.length}`,
  );
  for (const host of Object.keys(PEER_ROLES)) {
    check(
      running.peers.some((p) => p.hostname === host),
      `peer ${host} (${PEER_ROLES[host]}) missing`,
    );
  }
  check(
    running.peers.find((p) => p.hostname === 'old-laptop')?.online === false,
    'the offline peer read as online',
  );

  for (const [state, backend] of [
    ['needs-login', 'NeedsLogin'],
    ['needs-machine-auth', 'NeedsMachineAuth'],
    ['stopped', 'Stopped'],
  ]) {
    ts.setState(state);
    const s = await readTailnet({ candidates: [ts.bin] });
    results[state] = s;
    check(s.available === false && s.reason?.includes(backend), `${state}: ${JSON.stringify(s)}`);
  }

  ts.setState('not-installed');
  const missing = await readTailnet({ candidates: [ts.bin] });
  results['not-installed'] = missing;
  check(
    missing.available === false && /ENOENT/.test(missing.reason ?? ''),
    `not installed: ${missing.reason}`,
  );

  // ── the Finder case: a child with an empty environment ──
  ts.setState('running');
  const child = `
    import ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), '_ts-source.mjs'))};
    const { readTailnet } = await import(${JSON.stringify(path.join(REPO_ROOT, 'packages/cluster/src/host.ts'))});
    const s = await readTailnet({ candidates: [${JSON.stringify(ts.bin)}] });
    process.stdout.write(JSON.stringify({ available: s.available, peers: s.peers.length, env: Object.keys(process.env) }));
  `;
  const finder = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', child], {
      env: {},
      encoding: 'utf8',
    }),
  );
  results.finderLike = finder;
  check(
    finder.available === true && finder.peers === running.peers.length,
    `empty env: ${JSON.stringify(finder)}`,
  );

  // ── how the CLI was run ──
  const calls = ts.calls();
  results.calls = calls.map(
    (c) => `${c.argv.join(' ')} (TAILSCALE_BE_CLI=${c.env.TAILSCALE_BE_CLI})`,
  );
  check(
    calls.every((c) => c.argv.join(' ') === 'status --json'),
    'readTailnet ran something other than status --json',
  );
  // Recorded, not asserted: DEV-0 makes readTailnet pass TAILSCALE_BE_CLI=1 and
  // will assert it here; today it passes nothing.
  results.beCliToday = [...new Set(calls.map((c) => c.env.TAILSCALE_BE_CLI))];
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  ts.cleanup();
  const complaint = focusComplaint(before, frontmostApp());
  if (complaint !== null) check(false, complaint);
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      running: `${results.running?.peers?.length} peers`,
      states: Object.fromEntries(
        ['needs-login', 'needs-machine-auth', 'stopped', 'not-installed'].map((s) => [
          s,
          results[s]?.reason,
        ]),
      ),
      finderLike: results.finderLike,
      calls: results.calls,
      beCliToday: results.beCliToday,
    },
    null,
    2,
  ),
);
if (failures.length > 0) {
  console.error(`fake-tailscale-smoke: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('fake-tailscale-smoke OK');
}
