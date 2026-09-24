/**
 * THE GUARDIAN READS THIS MACHINE — in the built app, on the OS it runs on.
 *
 * XP-01 (crossplatform.md §2.4 A6): main used to hand the sampler `free: 0`
 * and a readFile that read nothing. macOS consults neither. Off macOS the
 * portable floor read "0 bytes free" as critical: every reading was a shed,
 * announced to the window each time, and with nothing of ours running the
 * chat model was parked each time. The unit tests pin the probes
 * (electron/gen/guardian-probes.test.ts, guardian-main.platforms.test.ts);
 * this watches the real app do the reading.
 *
 *   1. IDLE. Nothing runs for twenty seconds, which spans an idle reading
 *      (every 15 s). None may be a shed, and the chat model may not be parked.
 *      The broken build announced a shed at every reading.
 *   2. GRADED. The guardian's own probe seam (PI_GUARDIAN_HOLD_FREE, read at
 *      every reading) is raised inside main, so the next reading holds. That
 *      hold must quote the OS's own free figure ("NN% of memory is free"),
 *      and it must match what the OS said around that reading: macOS's
 *      memorystatus_level, Linux's MemAvailable, traced for the whole wait
 *      (_os-free-window.mjs: beside another lane's heavy job the figure moves
 *      ten points in a second). Windows has no graded figure until XP-15, so
 *      the step is skipped there.
 *
 * Hidden, throwaway HOME, focus guard (launchApp). It starts no model, runs no
 * generation and writes no shared settings. The seam lives only in the
 * probe's own app instance, which is closed at the end.
 *
 *   node scripts/with-lock.mjs probe -- node tests/e2e/guardian-reading-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { quotedMatchesOs, startOsFreeTrace } from './_os-free-window.mjs';
import { launchApp } from './harness.mjs';

const IDLE_MS = Number(process.env.IDLE_MS ?? 20_000);
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

/** What the OS itself says is free right now, in percent, where it says so. */
function osFreePercent() {
  try {
    if (platform() === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' });
      return Number(out.trim());
    }
    if (platform() === 'linux') {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
      return Math.round((available / total) * 100);
    }
  } catch {
    // fall through: not measured
  }
  return undefined;
}

const { app, page, check, finish, shot } = await launchApp('guardian-reading', {
  timeout: 60_000,
});
try {
  // Main's own guardian lines from here on: the logger calls console.info as
  // `<time> [desktop:main] guardian {"line":…}`. (A bare "guardian" also
  // matches this probe's own HOME path in unrelated lines.)
  await app.evaluate(() => {
    const lines = [];
    globalThis.__guardianLines = lines;
    const info = console.info.bind(console);
    console.info = (...args) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (/\] guardian \{/.test(text)) lines.push(text);
      info(...args);
    };
  });
  // …and what the window is told, and when it heard.
  await page.evaluate(() => {
    window.__guardianEvents = [];
    window.piDesktop.onEvent('gen:guardian', (e) =>
      window.__guardianEvents.push({ ...e, receivedAt: Date.now() }),
    );
  });

  say(`idle: ${IDLE_MS / 1000}s of readings with nothing running (${platform()})`);
  await page.waitForTimeout(IDLE_MS);
  const idleEvents = await page.evaluate(() => window.__guardianEvents.slice());
  const idleLines = await app.evaluate(() => globalThis.__guardianLines.slice());
  for (const e of idleEvents) say(`window  ${e.verdict}: ${e.reason}`);
  for (const line of idleLines) say(`main    ${line}`);
  check(
    !idleEvents.some((e) => e.verdict === 'shed'),
    `an idle machine was shed: ${JSON.stringify(idleEvents)}`,
  );
  check(
    !idleLines.some((line) => /PARK the chat model|SHED |TERMINATED /.test(line)),
    `the idle guardian parked or ended something: ${idleLines.join(' | ')}`,
  );
  await shot('idle');

  if (platform() === 'win32') {
    say('graded: no graded free figure on Windows until XP-15; skipped');
  } else {
    // What the OS says for the whole wait, from before the line is raised.
    const trace = startOsFreeTrace(osFreePercent);
    await app.evaluate(() => {
      process.env.PI_GUARDIAN_HOLD_FREE = '0.999';
    });
    say('graded: hold line raised to 99.9% free inside main; waiting for the next reading');
    const hold = await page
      .waitForFunction(
        () => window.__guardianEvents.find((e) => e.verdict === 'hold') ?? null,
        undefined,
        {
          timeout: 20_000,
          polling: 250,
        },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    // A beat after the window heard, so the span has its far side.
    await page.waitForTimeout(600);
    trace.stop();
    say(
      `window  ${hold === null ? 'no hold' : `${hold.verdict}: ${hold.reason} (memoryFree ${hold.memoryFree})`}`,
    );
    if (check(hold !== null, 'the raised hold line produced no hold within 20 s')) {
      const quoted = /^(\d+)% of memory is free$/.exec(hold.reason);
      if (check(quoted !== null, `the hold did not quote a free figure: "${hold.reason}"`)) {
        const percent = Number(quoted[1]);
        check(
          typeof hold.memoryFree === 'number' && Math.round(hold.memoryFree * 100) === percent,
          `memoryFree ${hold.memoryFree} does not match the quoted ${percent}%`,
        );
        if (trace.samples.length === 0) {
          say('os      not measured');
        } else {
          const os = quotedMatchesOs(percent, trace.samples, hold.receivedAt);
          const span = os.lo === os.hi ? `${os.lo}%` : `${os.lo}–${os.hi}%`;
          say(
            `os      ${os.n === 0 ? 'no look' : span} free in the 2.5 s around it (${os.n} looks)`,
          );
          check(
            os.ok,
            `the guardian read ${percent}% free, the OS said ${os.n === 0 ? 'nothing' : span} around that reading`,
          );
        }
      }
    }
    await app.evaluate(() => {
      delete process.env.PI_GUARDIAN_HOLD_FREE;
    });
  }
} finally {
  await finish();
}
