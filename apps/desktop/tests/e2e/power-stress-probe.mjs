/**
 * DOES THE POLICY ACTUALLY HOLD WHEN THE MACHINE IS IN TROUBLE?
 *
 * The user: "test everything monitor fans, power memory pressure etc. attempt to run
 * reasonably heavy other processes, stress test system ensure no OOM and
 * graceful handling if too many resources are in use."
 *
 * The unit tests judge the policy against readings I wrote down. This puts real
 * memory pressure on a real machine, with the real app running, and watches what
 * happens — which is the only way to find out whether the SENSING works, as
 * opposed to the arithmetic downstream of it. Two rules of mine were already
 * wrong in exactly that gap (free memory on macOS, swap stock vs flow), and both
 * survived a green unit suite.
 *
 * ## What it will not do to your machine
 *
 * The ramp is stepwise and the parent decides each step: it stops the moment the
 * OS reports CRITICAL, or at a hard cap of the smaller of 10 GB and a third of
 * RAM, whichever comes first. It never pushes toward jetsam. Everything is
 * released in a `finally`, the hog dies with its parent, and the run is bounded
 * in wall-clock. Set `STRESS_CAP_GB` to lower the cap further.
 *
 * ## What "no OOM" is checked against
 *
 * `kern.memorystatus.kill_on_sustained_pressure_count` — the OS's own tally of
 * processes it has killed for sustained memory pressure. Read before and after;
 * if the machine had to kill anything to survive this test, the test failed,
 * whatever else it observed.
 *
 * FANS AND PACKAGE POWER ARE NOT MEASURED, and it is worth saying why rather
 * than quietly omitting them: `powermetrics` is the only source on macOS and it
 * refuses to run without sudo. What IS readable — the OS's thermal verdict
 * (`pmset -g therm`, which reports a CPU speed limit when throttling) — is
 * sampled throughout and reported.
 *
 * ## Run it deliberately: `pnpm --filter @pi-desktop/desktop e2e:stress`
 *
 * Kept OUT of the default e2e suite. It holds gigabytes for minutes, and a
 * routine suite run should not do that to whatever machine it happens to land
 * on. `STRESS_CAP_GB=<n>` raises the ceiling.
 *
 * ## What it found, in order
 *
 *   1. The first hog touched one byte per page, and MEASURED, "6 GB held" moved
 *      the OS's free-memory percentage not at all — a page of zeros with one
 *      byte set compresses ~100:1. It fills with random bytes now.
 *   2. Releasing in-process left free memory pinned at 22%; V8 dropped the
 *      buffers and kept the pages. Killing the process took it to 78% at once.
 *   3. The swap thresholds were calibrated on the numbers this run produced:
 *      background housekeeping 0–71 pages/sec, real thrashing 8,804–81,003.
 *      The first guess (100) sat on top of the noise.
 *   4. macOS does NOT reach 'critical' readily. At 15 GB held on a 24 GB
 *      machine — 62% of RAM, plus half the cores busy — it stayed at 'warn' and
 *      swapped 81,003 pages/sec rather than declaring an emergency. Which is the
 *      case FOR the rate signal: the coarse verdict is not an alarm you can wait
 *      for.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchApp, REPO_ROOT } from './harness.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(REPO_ROOT, 'packages/inference/src');

const { samplePressure } = await import(`${SRC}/pressure.ts`);
const { decidePower } = await import(`${SRC}/power-policy.ts`);
const { classifyBottleneck, powerBudgetGB } = await import(`${SRC}/power-manager.ts`);
const { detectAccelerators } = await import(`${SRC}/accelerator.ts`);

/** The OS's own tally of processes killed for sustained memory pressure. */
const oomKills = () => {
  try {
    return Number.parseInt(
      execFileSync('sysctl', ['-n', 'kern.memorystatus.kill_on_sustained_pressure_count'], {
        encoding: 'utf8',
      }).trim(),
      10,
    );
  } catch {
    return null; // Not macOS, or the key is gone — then this check abstains.
  }
};

const totalGB = totalmem() / 1024 ** 3;
/*
 * A third of the machine by default, capped at 10 GB — enough to move the OS's
 * own numbers on anything from an 8 GB laptop up, without going near jetsam.
 * `STRESS_CAP_GB` overrides it OUTRIGHT rather than being min'd with the derived
 * value: it is an explicit opt-in for pushing harder, and a "cap" that silently
 * refuses to be raised is a knob that does nothing.
 */
const CAP_GB =
  Number.parseFloat(process.env.STRESS_CAP_GB ?? '') || Math.min(10, Math.max(2, totalGB / 3));
const CHUNK_GB = 0.25;

const { page, check, finish } = await launchApp('power-stress-probe');

const acc = await detectAccelerators();
const bottleneck = classifyBottleneck(acc);
const budgetGB = powerBudgetGB(acc);

let previousSwap;
const reading = async () => {
  const p = await samplePressure({
    run: async (cmd, args) => {
      try {
        return (await run(cmd, [...args], { timeout: 4000 })).stdout;
      } catch {
        return null;
      }
    },
    readFile: async (f) => {
      try {
        return await readFile(f, 'utf8');
      } catch {
        return null;
      }
    },
    loadAvg: () => loadavg(),
    cpuCount: cpus().length,
    memory: () => ({ total: totalmem(), free: freemem() }),
    platform: process.platform,
    hasNvidia: acc.gpus.some((g) => g.vendor === 'nvidia'),
    ...(previousSwap !== undefined ? { previousSwap } : {}),
  });
  if (p.swapCounters !== undefined) previousSwap = { ...p.swapCounters };
  return p;
};

let level = 'full';
let calmStreak = 0;
const judge = (pressure) => {
  const d = decidePower({
    mode: 'auto',
    pressure,
    bottleneck,
    budgetGB,
    cpuCount: cpus().length,
    previous: level,
    calmStreak,
  });
  level = d.level;
  calmStreak = d.calmStreak;
  return d;
};

let hog = null;
/** Held outside the try so the `finally` can always stop them. */
const burnersRef = [];
const say = (chunkGB, p, d) =>
  console.log(
    `  ${String(chunkGB.toFixed(2)).padStart(6)}GB held | free=${((p.memoryFree ?? 0) * 100).toFixed(0)}% ` +
      `verdict=${p.memory ?? '?'} swapIo/s=${Math.round(p.swapIoPerSec ?? 0)} thermal=${p.throttled === true ? 'THROTTLED' : 'ok'} ` +
      `→ ${d.level} (heavy=${d.allowHeavyJobs ? 'yes' : 'HELD'}) ${d.level !== 'full' ? `— ${d.reason}` : ''}`,
  );

try {
  console.log(
    `machine: ${acc.chip ?? acc.platform} · ${acc.totalRamGB}GB · wall=${bottleneck} · cap=${CAP_GB.toFixed(1)}GB`,
  );
  const killsBefore = oomKills();

  /*
   * Baseline — and WAIT for the machine to actually be calm rather than assuming
   * it. MEASURED: running this twice in a row, the second run opened with 3,091
   * pages/sec still settling from the first, so the "calm machine" precondition
   * was false and the baseline assertion failed on a policy that was reading its
   * inputs correctly. A test that cannot tell its own noise from a defect is
   * worse than no test.
   */
  await page.waitForTimeout(1500);
  let p = await reading();
  let d = judge(p);
  for (let i = 0; i < 30; i++) {
    p = await reading();
    d = judge(p);
    if (d.level === 'full' && (p.swapIoPerSec ?? 0) < 200) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  say(0, p, d);
  check(
    d.level === 'full',
    `the machine never settled enough to start (${d.reason}; swapIo/s=${Math.round(p.swapIoPerSec ?? 0)})`,
  );
  check(d.allowHeavyJobs, 'heavy jobs are held on a calm machine');

  /*
   * ── competition ───────────────────────────────────────────────────────────
   *
   * The user: "attempt to run reasonably heavy other processes". Half the cores,
   * busy — what a build, an export or a video call actually looks like next to a
   * model. It matters for two reasons: the app has to stay responsive with the
   * machine genuinely contended, and the CPU signal has to MOVE, or the policy
   * is blind on the one class of machine where cores are the wall.
   */
  const burners = [];
  const burnerCount = Math.max(1, Math.floor(cpus().length / 2));
  for (let i = 0; i < burnerCount; i++) {
    const b = spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random()*1e9)}'], {
      stdio: 'ignore',
    });
    burners.push(b);
    burnersRef.push(b);
  }
  const killBurners = () => {
    for (const b of burners) b.kill('SIGKILL');
    burners.length = 0;
  };
  console.log(`competing load: ${burnerCount} busy cores of ${cpus().length}`);
  await new Promise((r) => setTimeout(r, 2500));
  const busy = await reading();
  console.log(`  cpu contention now ${((busy.cpu ?? 0) * 100).toFixed(0)}% of cores`);
  check((busy.cpu ?? 0) > 0.2, `the CPU signal did not move under real load (${busy.cpu})`);

  // ── the ramp ──────────────────────────────────────────────────────────────
  hog = spawn(process.execPath, [path.join(HERE, '_memory-hog.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const held = [];
  hog.stdout.setEncoding('utf8');
  hog.stdout.on('data', (t) => held.push(...String(t).trim().split('\n')));
  const grow = async () => {
    hog.stdin.write('grow\n');
    await new Promise((r) => setTimeout(r, 350));
  };

  let heldGB = 0;
  let sawEasing = false;
  let sawHeavyHeld = false;
  let sawCritical = false;
  console.log('ramping memory pressure:');
  while (heldGB < CAP_GB) {
    await grow();
    heldGB += CHUNK_GB;
    p = await reading();
    d = judge(p);
    if (heldGB % 1 < CHUNK_GB) say(heldGB, p, d);
    if (d.level !== 'full') sawEasing = true;
    if (!d.allowHeavyJobs) sawHeavyHeld = true;
    if (p.memory === 'critical') {
      sawCritical = true;
      say(heldGB, p, d);
      console.log('  OS reports CRITICAL — stopping the ramp here, as designed');
      break;
    }
  }
  say(heldGB, p, d);

  check(
    sawEasing,
    `the policy never eased off across ${heldGB.toFixed(1)}GB of real pressure ` +
      `(last: free=${((p.memoryFree ?? 0) * 100).toFixed(0)}% verdict=${p.memory})`,
  );
  check(sawHeavyHeld, 'heavy generation jobs were never held under real pressure');

  // The app has to still be there, and still answering.
  const alive = await page
    .evaluate(() => typeof window.__pi_store === 'function')
    .catch(() => false);
  check(alive, 'the app stopped responding under memory pressure');
  // Responsive, not merely alive: a render round-trip under full contention.
  const responsive = await page
    .evaluate(() => document.querySelectorAll('.pd-composer-editor').length)
    .catch(() => 0);
  check(responsive > 0, 'the app was alive but its UI was gone under pressure');

  /*
   * ── recovery ──────────────────────────────────────────────────────────────
   *
   * BY KILLING THE HOG, not by asking it to drop its references. MEASURED: an
   * in-process `release` left the OS's free-memory percentage pinned at 22% —
   * V8 dropped the buffers and did not hand the pages back — while killing the
   * process took it straight to 78%. Killing is also the honest simulation: what
   * actually happens on a real machine is that the other heavy app QUITS.
   */
  console.log('releasing (killing the hog and the busy cores):');
  hog.kill('SIGKILL');
  hog = null;
  killBurners();
  await new Promise((r) => setTimeout(r, 2000));
  /*
   * Generous on purpose. Two clocks have to run out, and both are meant to be
   * slow: macOS reclaims lazily, and the policy needs RECOVERY_READINGS calm
   * samples before it will believe the machine is well — the asymmetry that
   * stops it flapping between configurations, each flap costing a cold prefill.
   */
  let recovered = false;
  for (let i = 0; i < 40; i++) {
    p = await reading();
    d = judge(p);
    if (i % 8 === 0) say(0, p, d);
    if (d.level === 'full') {
      recovered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  say(0, p, d);
  check(recovered, `the policy never came back to full after the pressure cleared (${d.reason})`);

  // ── and the machine survived it ───────────────────────────────────────────
  const killsAfter = oomKills();
  if (killsBefore !== null && killsAfter !== null) {
    check(
      killsAfter === killsBefore,
      `the OS killed ${killsAfter - killsBefore} process(es) for memory pressure during this run`,
    );
    console.log(`OOM kills during the run: ${killsAfter - killsBefore} (OS counter)`);
  } else {
    console.log('OOM-kill counter unavailable on this platform — check abstained');
  }
  if (!sawCritical)
    console.log(`ramp finished at the ${CAP_GB.toFixed(1)}GB cap without reaching critical`);
} finally {
  hog?.kill('SIGKILL');
  for (const b of burnersRef) b.kill('SIGKILL');
  await finish();
}
