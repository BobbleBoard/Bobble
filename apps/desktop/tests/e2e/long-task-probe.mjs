/**
 * ROUND 3 — A LONG TASK THAT HAS TO ACTUALLY FINISH.
 *
 * The user: "long running tasks where you can't accept an 'I can't do this' needs to
 * truly run until completion."
 *
 * The task is deliberately dull and objectively checkable: eight small files,
 * each of which must EXIST and must RUN. Dull because the point is not whether
 * the model can write clever code — it is whether a request with eight parts
 * comes back with eight parts done. Objectively checkable because "did it
 * finish" cannot be a matter of opinion: the probe reads the working directory
 * and runs the files itself.
 *
 * That shape is chosen to provoke the exact failure this round is about. The
 * commonest way a long task ends early is not a refusal and not a crash — it is
 * three of eight things done, a good summary of the three, and a stop. It reads
 * like success. So the probe asks for more parts than a small model will
 * comfortably do in one turn, and then checks the DISK.
 *
 * WHAT IT REPORTS
 *   - how many of the eight parts actually exist, and how many run
 *   - whether the model wrote a plan, and what state it left it in
 *   - whether the harness's unfinished-plan steer fired, and whether the model
 *     carried on after it
 *   - the final reply, so a "I have completed the main parts" can be seen
 *
 * It FAILS on an incomplete delivery. That is the assertion: a long task that
 * comes back two-thirds done is the defect, however good the summary is.
 *
 *   MODEL     catalog id (default qwen3.5-9b-mtp)
 *   MAX_MIN   give up after this many minutes (default 30)
 *   PARTS     how many files to ask for (default 8)
 *
 * Run `npm run build` first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-9b-mtp';
/*
 * THE VARIABLE THIS PROBE EXISTS TO MOVE.
 *
 * `realVerify` is off at low/medium and on at high/max, with a bounded fix
 * budget (1 at high, 2 at max). That budget is the harness's only way to
 * restart a turn that ENDED — so running the same task at two levels is what
 * makes "swapping effort and seeing the desired behavior" a number rather than
 * a table of constants.
 */
const EFFORT = process.env.EFFORT ?? 'max';
const CAP_MS = Number(process.env.MAX_MIN ?? 30) * 60_000;
const PARTS = Number(process.env.PARTS ?? 8);

const realCache = path.join(homedir(), '.cache', 'bobble');
if (!existsSync(path.join(realCache, 'models', MODEL))) {
  console.log(`long-task-probe: SKIP — ${MODEL} is not downloaded`);
  process.exit(0);
}

const home = mkdtempSync(path.join(tmpdir(), 'pd-long-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
/* The project the agent works in. Empty at the start — a probe that finds its
   own answer already on disk proves nothing. */
const work = path.join(home, 'shapes');
mkdirSync(work, { recursive: true });

/*
 * THE EIGHT PARTS. Each is one file, one function, one printed line — small
 * enough that none of them is the hard bit, and specific enough that "did it
 * happen" is a question about the filesystem rather than about prose.
 */
const ALL_SHAPES = [
  ['square', 'side', 'side * side'],
  ['rectangle', 'width and height', 'width * height'],
  ['triangle', 'base and height', '0.5 * base * height'],
  ['circle', 'radius', 'pi * radius squared'],
  ['trapezoid', 'the two parallel sides a, b and the height', '0.5 * (a + b) * height'],
  ['parallelogram', 'base and height', 'base * height'],
  ['ellipse', 'the two radii a and b', 'pi * a * b'],
  ['rhombus', 'the two diagonals p and q', '0.5 * p * q'],
  ['kite', 'the two diagonals p and q', '0.5 * p * q'],
  ['regular_pentagon', 'side', '0.25 * sqrt(5*(5+2*sqrt(5))) * side squared'],
  ['regular_hexagon', 'side', '1.5 * sqrt(3) * side squared'],
  ['regular_octagon', 'side', '2 * (1 + sqrt(2)) * side squared'],
  ['annulus', 'the outer radius R and inner radius r', 'pi * (R squared - r squared)'],
  ['circular_sector', 'radius and angle in radians', '0.5 * radius squared * angle'],
  [
    'circular_segment',
    'radius and angle in radians',
    '0.5 * radius squared * (angle - sin(angle))',
  ],
  ['sphere_surface', 'radius', '4 * pi * radius squared'],
  ['cylinder_surface', 'radius and height', '2*pi*radius*(radius + height)'],
  ['cone_surface', 'radius and slant height l', 'pi*radius*(radius + l)'],
  ['cube_surface', 'side', '6 * side squared'],
  ['torus_surface', 'the two radii R and r', '4 * pi squared * R * r'],
  ['right_triangle_hyp', 'the two legs a and b', 'sqrt(a squared + b squared)'],
  ['equilateral_triangle', 'side', 'sqrt(3)/4 * side squared'],
  [
    'regular_polygon',
    'the number of sides n and the side length s',
    '0.25 * n * s squared / tan(pi/n)',
  ],
  ['ellipse_perimeter', 'the two radii a and b', "Ramanujan's approximation"],
];
const SHAPES = ALL_SHAPES.slice(0, PARTS);
if (PARTS > ALL_SHAPES.length) {
  console.log(`long-task-probe: PARTS capped at ${ALL_SHAPES.length}`);
}

const ASK = [
  `In the folder ${work} create ${SHAPES.length} Python files, one per shape:`,
  ...SHAPES.map(
    ([name, args, formula], i) =>
      `${i + 1}. ${name}.py — a function area(...) taking ${args}, returning ${formula}, and a __main__ block that prints one example result.`,
  ),
  '',
  `Every file must exist and must run with "python3 <file>" printing a number. Run each one after you write it and fix anything that fails. Do all ${SHAPES.length}.`,
].join('\n');

const { page, check, finish, shot, shotDir } = await launchApp('long-task-probe', {
  env: {
    HOME: home,
    PI_BIN: undefined,
    MOCK_PI_FIXTURE: undefined,
    PI_DESKTOP_CACHE_DIR: realCache,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
  },
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});

const harnessStatus = () =>
  page.evaluate(() => {
    const raw = window.__pi_store().getState().extensionStatus?.harness;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

/** Which parts are real: the file exists AND running it prints a number. */
function delivered() {
  const out = [];
  for (const [name] of SHAPES) {
    const file = path.join(work, `${name}.py`);
    if (!existsSync(file)) {
      out.push({ name, exists: false, runs: false });
      continue;
    }
    let runs = false;
    try {
      // `stdio` pipes stderr too: the default INHERITS it, so every traceback
      // from a file that does not run was printed into this probe's own log —
      // hundreds of lines of someone else's error, interleaved with the
      // progress it is trying to report.
      const stdout = execFileSync('python3', [file], {
        timeout: 15_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runs = /\d/.test(stdout);
    } catch {
      runs = false;
    }
    out.push({ name, exists: true, runs });
  }
  return out;
}

try {
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 30_000,
  });
  await page.evaluate(
    ([id]) =>
      window
        .__settings_store()
        .getState()
        .update({
          modelSelection: { mode: 'model', modelId: id },
          // The level the user's question is about: at max the harness persists
          // longest before giving up on anything.
          effort: 'max',
          effortMode: 'manual',
          // The agent has to be able to write and run without a prompt per file.
          permissionMode: 'bypass',
        }),
    [MODEL, EFFORT],
  );
  /*
   * Work in the folder the task names. `/harness workspace` is the app's own
   * transport for this (see pi-connect's setWorkspace) — the file tools and
   * bash retarget on their next call, with no respawn.
   */
  await page
    .evaluate(
      ([dir]) => window.piDesktop.invoke('pi:prompt', { message: `/harness workspace ${dir}` }),
      [work],
    )
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  await page.waitForSelector('.pd-composer-editor', { timeout: 60_000 });
  await page.click('.pd-composer-editor');
  await page.keyboard.insertText(ASK);
  await page.keyboard.press('Enter');
  console.log(`   asked for ${SHAPES.length} parts in ${work}, effort=${EFFORT}`);

  /*
   * COUNT THE TURN BOUNDARIES.
   *
   * The harness's verify fix is delivered with `deliverAs: 'followUp'`, which is
   * PRIVATE — it never becomes a user bubble, so scanning the message list for
   * it reports zero however many times it fired. What is observable is that the
   * turn ended and another one started: stage 'done'/'idle' followed by
   * 'working'. MEASURED at 24 parts and max effort: the model finished, twice,
   * with a confident summary and a third of the files, and was restarted both
   * times — which is exactly `verifyFixAttempts: 2`.
   */
  let restarts = 0;
  let wasDone = false;
  /* The app STARTS at 'idle', which is not "a turn ended" — without this the
     very first transition into 'working' counts as a restart. */
  let everWorked = false;

  const t0 = Date.now();
  let lastLine = '';
  let steers = [];
  while (Date.now() - t0 < CAP_MS) {
    const state = await page
      .evaluate(() => {
        const s = window.__pi_store().getState();
        const ms = s.messages ?? [];
        return {
          streaming: ms.some((m) => m.isStreaming === true),
          assistants: ms.filter((m) => m.kind === 'assistant').length,
        };
      })
      .catch(() => null);
    if (state === null) break;
    const st = await harnessStatus();
    if (st?.stage === 'working') everWorked = true;
    if (everWorked && (st?.stage === 'done' || st?.stage === 'idle')) wasDone = true;
    else if (wasDone && st?.stage === 'working') {
      restarts += 1;
      wasDone = false;
      console.log(`   ↻ the harness restarted the turn (${restarts})`);
    }
    const done = (st?.plan ?? []).filter((p) => p.status === 'done').length;
    const line = `${((Date.now() - t0) / 1000).toFixed(0)}s · ${st?.stage ?? '?'} · plan ${done}/${st?.plan?.length ?? 0} · files ${delivered().filter((d) => d.exists).length}/${SHAPES.length}`;
    if (line.slice(line.indexOf('·')) !== lastLine.slice(lastLine.indexOf('·'))) {
      console.log(`   ${line}`);
      lastLine = line;
    }
    if (!state.streaming && state.assistants > 0) {
      // Give the harness its chance to steer before calling the turn over: the
      // unfinished-plan nudge fires at agent_end and starts a NEW turn.
      await page.waitForTimeout(4000);
      const again = await page
        .evaluate(() => (window.__pi_store().getState().messages ?? []).some((m) => m.isStreaming))
        .catch(() => false);
      if (!again) break;
    }
    await page.waitForTimeout(3000);
  }

  /* ---------------------------------------------------- what actually landed */
  const results = delivered();
  const exists = results.filter((r) => r.exists).length;
  const runs = results.filter((r) => r.runs).length;
  const status = await harnessStatus();
  const plan = status?.plan ?? [];
  const planDone = plan.filter((p) => p.status === 'done').length;

  // Did the harness push back, and did the model carry on when it did?
  steers = await page
    .evaluate(() =>
      (window.__pi_store().getState().messages ?? [])
        .filter((m) => m.kind === 'user')
        .map((m) => String(m.text ?? ''))
        // EVERY user message after the first is the harness talking: this probe
        // sends exactly one. Captured whole rather than matched against
        // phrasings I already know — MEASURED at 24 parts, the turn ENDED at
        // 9/24 and something restarted it twice, and a regex for the three
        // nudges I knew about found nothing at all.
        .slice(1),
    )
    .catch(() => []);

  /*
   * WHAT THE AGENT ACTUALLY RAN.
   *
   * MEASURED on a low-effort run: the file count went 24 -> 0 -> 13 -> 24 -> 0
   * and the whole working directory, and the temp HOME containing it,
   * disappeared. "The files are gone" is not a diagnosis — the commands are.
   * Bash calls are the only ones that can do that, so they are what gets
   * printed when a run ends short.
   */
  const commands = await page
    .evaluate(() =>
      (window.__pi_store().getState().messages ?? [])
        .filter((m) => m.kind === 'assistant')
        .flatMap((m) => m.blocks ?? [])
        .filter((b) => b.type === 'toolCall')
        .map((b) => {
          // `arguments` once parsed, `argsText` while still streaming — the two
          // fields ChatThread itself reads. An earlier guess at `args`/`input`
          // reported "0 shell commands" for a run full of them.
          const parsed = b.arguments ?? {};
          const cmd =
            parsed.command ??
            parsed.cmd ??
            parsed.script ??
            (typeof b.argsText === 'string' ? b.argsText : undefined);
          return typeof cmd === 'string' ? `${b.name ?? 'tool'}: ${cmd}` : `${b.name ?? 'tool'}`;
        }),
    )
    .catch(() => []);
  const destructive = commands.filter((c) => /\brm\b|\bmv\b|\btrash\b|shutil\.rmtree/.test(c));

  const reply = await page
    .evaluate(() => {
      const ms = (window.__pi_store().getState().messages ?? []).filter(
        (m) => m.kind === 'assistant',
      );
      const last = ms.at(-1);
      return (last?.blocks ?? [])
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .slice(0, 600);
    })
    .catch(() => '');

  console.log('');
  console.log(`   parts on disk : ${exists}/${SHAPES.length}`);
  console.log(`   parts that run: ${runs}/${SHAPES.length}`);
  console.log(`   plan          : ${planDone}/${plan.length} done`);
  console.log(`   turn restarts : ${restarts} (harness pushed the turn back into working)`);
  console.log(`   harness steers: ${steers.length}`);
  for (const [i, t] of steers.entries()) {
    console.log(`     [${i + 1}] ${t.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  const turns = await page
    .evaluate(
      () =>
        (window.__pi_store().getState().messages ?? []).filter((m) => m.kind === 'assistant')
          .length,
    )
    .catch(() => 0);
  console.log(`   assistant turns: ${turns}`);
  console.log(
    `   missing       : ${
      results
        .filter((r) => !r.runs)
        .map((r) => r.name)
        .join(', ') || 'none'
    }`,
  );
  console.log(`   elapsed       : ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  console.log('');
  console.log(`   final reply: ${reply.replace(/\n/g, ' ').slice(0, 400)}`);
  console.log(
    `   files: ${existsSync(work) ? JSON.stringify(readdirSync(work)) : 'THE WORKING DIRECTORY IS GONE'}`,
  );
  if (destructive.length > 0) {
    console.log(`   destructive commands (${destructive.length}):`);
    for (const c of destructive.slice(-10)) console.log(`     ${c.slice(0, 200)}`);
  }
  console.log(`   tool calls: ${commands.length}`);

  await shot('1-after');
  check(
    existsSync(work),
    `the agent DELETED its own working directory (${work}) — ${destructive.length} destructive command(s) ran`,
  );
  check(
    runs === SHAPES.length,
    `only ${runs} of ${SHAPES.length} parts actually work — a long task came back unfinished`,
  );
  // If it DID stop short, the harness must at least have noticed.
  if (runs < SHAPES.length) {
    check(
      steers.length > 0,
      'the task came back unfinished and the harness never pushed back on it',
    );
  }
  console.log(`shots: ${shotDir}`);
} finally {
  await finish();
}
