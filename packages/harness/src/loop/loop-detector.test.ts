import { describe, expect, it } from 'vitest';
import { effortKnobs } from '../effort/effort.js';
import {
  createLoopDetector,
  DEFAULT_LOOP_ABORT_AFTER,
  DEFAULT_LOOP_STEER_AFTER,
  DEFAULT_REPEAT_STEER_AFTER,
  DEFAULT_WANDER_ABORT_AFTER,
  DEFAULT_WANDER_STEER_AFTER,
  isExplorationTool,
  type LoopDetectorConfig,
  loopDetectorConfig,
  toolCallSignature,
} from './loop-detector.js';

const CFG: LoopDetectorConfig = {
  steerAfter: 3,
  abortAfter: 5,
  // The live default is 75 (the user); these tests exercise the MECHANISM, so they
  // pin a small threshold and the default is asserted separately below.
  repeatSteerAfter: 3,
  maxSteps: 20,
};

describe('toolCallSignature', () => {
  it('is stable across argument key order', () => {
    expect(toolCallSignature('read', { path: '/a', mode: 'r' })).toBe(
      toolCallSignature('read', { mode: 'r', path: '/a' }),
    );
  });

  it('differs on tool name, args, or nested values', () => {
    expect(toolCallSignature('read', { path: '/a' })).not.toBe(
      toolCallSignature('write', { path: '/a' }),
    );
    expect(toolCallSignature('read', { path: '/a' })).not.toBe(
      toolCallSignature('read', { path: '/b' }),
    );
    expect(toolCallSignature('x', { a: [1, 2] })).not.toBe(toolCallSignature('x', { a: [2, 1] }));
  });

  it('tolerates undefined / null args', () => {
    expect(toolCallSignature('t', undefined)).toBe(toolCallSignature('t', null));
  });
});

describe('identical-call streak', () => {
  it('steers once at the count threshold, then aborts only after the WALL-CLOCK window', () => {
    let clock = 1000;
    const d = createLoopDetector({
      ...CFG,
      maxSteps: 100,
      now: () => clock,
      repeatWallMs: 180_000,
    });
    const call = () => d.onToolCall('bash', { command: 'ls' });
    expect(call().kind).toBe('none'); // 1
    expect(call().kind).toBe('none'); // 2
    const third = call(); // 3 → steer (count nudge)
    expect(third.kind).toBe('steer');
    if (third.kind === 'steer') {
      expect(third.cause).toBe('identical');
      expect(third.message.length).toBeGreaterThan(0);
    }
    // A FAST burst of many more identical calls with NO time elapsed is NOT yet a
    // loop (the user: a genuine loop is the same call STILL repeating minutes later).
    for (let i = 0; i < 20; i++) expect(call().kind).toBe('none');
    // Once the same call has been repeating past the wall-clock window → abort.
    clock += 180_001;
    const late = call();
    expect(late.kind).toBe('abort');
    if (late.kind === 'abort') expect(late.cause).toBe('identical');
  });

  it('aborts a small CYCLE of calls that fills the wall-clock window', () => {
    // MEASURED on a 4B: 179 calls in twelve minutes — 150 of one write, a
    // dozen of one read, a few of a second write — and the identical-call
    // clock restarted on every change of signature, so nothing fired.
    let clock = 1000;
    const d = createLoopDetector({
      ...CFG,
      maxSteps: 1000,
      repeatSteerAfter: 1000,
      now: () => clock,
      repeatWallMs: 180_000,
    });
    const cycle = [
      ['write', { path: 'a.txt', content: 'searching' }],
      ['write', { path: 'a.txt', content: 'searching' }],
      ['read', { path: 'a.txt' }],
      ['write', { path: 'b.txt', content: 'searching' }],
    ] as const;
    let signal = d.onToolCall('write', { path: 'a.txt', content: 'searching' });
    for (let i = 0; i < 40; i += 1) {
      clock += 4_000; // 40 calls over 160 s: inside the window, not yet a loop
      const [tool, args] = cycle[i % cycle.length] ?? cycle[0];
      signal = d.onToolCall(tool, args);
      expect(signal.kind).toBe('none');
    }
    clock += 25_000; // …and past three minutes of the same three calls: a loop
    signal = d.onToolCall('write', { path: 'a.txt', content: 'searching' });
    expect(signal.kind).toBe('abort');
    if (signal.kind === 'abort') expect(signal.reason).toMatch(/cycling between 3 tool calls/);
  });

  it('never mistakes reading many different files for a cycle', () => {
    let clock = 1000;
    const d = createLoopDetector({
      ...CFG,
      maxSteps: 1000,
      now: () => clock,
      repeatWallMs: 180_000,
    });
    for (let i = 0; i < 60; i += 1) {
      clock += 4_000;
      // Concrete actions (a write is not "wandering"), each a distinct call.
      expect(d.onToolCall('write', { path: `file-${i}.ts`, content: 'x' }).kind).toBe('none');
    }
  });

  it('resets the streak when a different call interrupts it', () => {
    const d = createLoopDetector(CFG);
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.snapshot().identicalStreak).toBe(2);
    d.onToolCall('bash', { command: 'pwd' }); // different → streak resets to 1
    expect(d.snapshot().identicalStreak).toBe(1);
    // A fresh run of the same call must climb again from 1 (no early abort).
    expect(d.onToolCall('bash', { command: 'pwd' }).kind).toBe('none');
    expect(d.onToolCall('bash', { command: 'pwd' }).kind).toBe('steer');
  });
});

describe('consecutive-error streak', () => {
  it('steers once at steerAfter, then aborts at abortAfter', () => {
    const d = createLoopDetector(CFG);
    expect(d.onToolResult(true).kind).toBe('none'); // 1
    expect(d.onToolResult(true).kind).toBe('none'); // 2
    const third = d.onToolResult(true); // 3 → steer
    expect(third.kind).toBe('steer');
    if (third.kind === 'steer') expect(third.cause).toBe('error');
    expect(d.onToolResult(true).kind).toBe('none'); // 4 — already steered
    expect(d.onToolResult(true).kind).toBe('abort'); // 5 → abort
  });

  it('a success resets the error streak', () => {
    const d = createLoopDetector(CFG);
    d.onToolResult(true);
    d.onToolResult(true);
    d.onToolResult(false); // success → reset
    expect(d.snapshot().errorStreak).toBe(0);
    expect(d.onToolResult(true).kind).toBe('none'); // back to 1
  });

  it('only steers ONCE per turn across BOTH causes', () => {
    const d = createLoopDetector(CFG);
    // Trip the identical-call steer first.
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.onToolCall('bash', { command: 'ls' }).kind).toBe('steer');
    // Now trip an error streak — the single steer is already spent, so no 2nd steer.
    d.onToolResult(true);
    d.onToolResult(true);
    expect(d.onToolResult(true).kind).toBe('none');
    // …but the error streak still aborts past the 2nd threshold.
    d.onToolResult(true);
    expect(d.onToolResult(true).kind).toBe('abort');
  });
});

describe('hard step cap', () => {
  it('aborts once the per-turn tool-call cap is exceeded (varying calls, no streak)', () => {
    const d = createLoopDetector({ steerAfter: 3, abortAfter: 5, maxSteps: 4 });
    // Distinct calls each time → identical streak never trips.
    expect(d.onToolCall('bash', { command: 'a' }).kind).toBe('none'); // 1
    expect(d.onToolCall('bash', { command: 'b' }).kind).toBe('none'); // 2
    expect(d.onToolCall('bash', { command: 'c' }).kind).toBe('none'); // 3
    expect(d.onToolCall('bash', { command: 'd' }).kind).toBe('none'); // 4 (== cap, allowed)
    const over = d.onToolCall('bash', { command: 'e' }); // 5 (> cap) → abort
    expect(over.kind).toBe('abort');
    if (over.kind === 'abort') expect(over.cause).toBe('cap');
  });

  it('the cap takes priority over an identical-call abort', () => {
    const d = createLoopDetector({
      steerAfter: 3,
      repeatSteerAfter: 3,
      abortAfter: 99,
      maxSteps: 3,
    });
    d.onToolCall('t', { x: 1 });
    d.onToolCall('t', { x: 1 });
    d.onToolCall('t', { x: 1 }); // step 3 (== cap): identical streak=3 → steer
    const capped = d.onToolCall('t', { x: 1 }); // step 4 (> cap) → cap abort wins
    expect(capped).toMatchObject({ kind: 'abort', cause: 'cap' });
  });
});

describe('unproductive-wandering cap (productivity heuristic)', () => {
  // A generous hard cap so the wander thresholds — not the step cap — do the work.
  const WCFG: LoopDetectorConfig = {
    steerAfter: 3,
    abortAfter: 5,
    maxSteps: 50,
    wanderSteerAfter: 4,
    wanderAbortAfter: 7,
  };

  it('classifies read-only exploration vs concrete-action tools', () => {
    for (const t of [
      'read',
      'read_file',
      'ls',
      'list',
      'find',
      'glob',
      'grep',
      'tool_search',
      'update_plan',
    ]) {
      expect(isExplorationTool(t)).toBe(true);
    }
    // Writes, edits, shell, connectors, gen, asking the user — all real actions.
    for (const t of [
      'write',
      'edit',
      'bash',
      'python_run',
      'calendar_list_events',
      'send_mail',
      'ask_user',
      'web_search',
      'image_generate',
      'spawn_subagent',
    ]) {
      expect(isExplorationTool(t)).toBe(false);
    }
  });

  it('steers ONCE after N different read-only calls but NEVER aborts (the user: different files aren’t a loop)', () => {
    const d = createLoopDetector(WCFG);
    // Many DIFFERENT files → distinct signatures, so the identical-call streak
    // never trips. Wandering gets ONE gentle nudge, but must never terminate the
    // turn — reading different files is productive exploration, not a loop.
    const readFile = (n: number) => d.onToolCall('read', { path: `/f${n}.txt` });
    expect(readFile(1).kind).toBe('none'); // 1
    expect(readFile(2).kind).toBe('none'); // 2
    expect(readFile(3).kind).toBe('none'); // 3
    const fourth = readFile(4); // 4 → wander steer (the single nudge)
    expect(fourth.kind).toBe('steer');
    if (fourth.kind === 'steer') {
      expect(fourth.cause).toBe('wander');
      expect(fourth.message.length).toBeGreaterThan(0);
    }
    expect(d.snapshot().identicalStreak).toBe(1); // all paths differ
    // Reading 25 MORE different files never aborts.
    for (let n = 5; n < 30; n++) expect(readFile(n).kind).toBe('none');
  });

  it('a concrete action resets the unproductive streak', () => {
    const d = createLoopDetector(WCFG);
    d.onToolCall('read', { path: '/a' });
    d.onToolCall('ls', { path: '/' });
    d.onToolCall('grep', { q: 'x' });
    expect(d.snapshot().unproductiveStreak).toBe(3);
    d.onToolCall('write', { path: '/out.md', content: 'hi' }); // progress → reset
    expect(d.snapshot().unproductiveStreak).toBe(0);
    // Exploration climbs again from scratch — no leaked streak causing an early trip.
    expect(d.onToolCall('read', { path: '/b' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/c' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/d' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/e' }).kind).toBe('steer'); // 4th since reset
  });

  it('interleaving a real action every other call never trips (productive work)', () => {
    const d = createLoopDetector(WCFG);
    for (let i = 0; i < 12; i++) {
      expect(d.onToolCall('read', { path: `/r${i}` }).kind).toBe('none');
      expect(d.onToolCall('edit', { path: `/e${i}` }).kind).toBe('none');
    }
    expect(d.snapshot().unproductiveStreak).toBe(0);
    expect(d.snapshot().steered).toBe(false);
  });

  it('shares the single per-turn steer budget with the identical-call cause; wander never aborts', () => {
    // identical trips the ONE steer first; the wander cause can no longer steer,
    // and (the user) it must NEVER abort no matter how many different files are read.
    const d = createLoopDetector({
      steerAfter: 3,
      repeatSteerAfter: 3,
      abortAfter: 99,
      maxSteps: 50,
      wanderSteerAfter: 4,
    });
    d.onToolCall('read', { path: '/same' });
    d.onToolCall('read', { path: '/same' });
    expect(d.onToolCall('read', { path: '/same' }).kind).toBe('steer'); // identical steer (budget spent)
    // Many DIFFERENT reads: wander would steer but budget spent; and never aborts.
    for (let i = 0; i < 20; i++) {
      expect(d.onToolCall('read', { path: `/x${i}` }).kind).toBe('none');
    }
  });

  it('with the default wander thresholds, steers once but never aborts (different reads)', () => {
    const d = createLoopDetector({ steerAfter: 3, abortAfter: 5, maxSteps: 200 });
    for (let i = 0; i < DEFAULT_WANDER_STEER_AFTER - 1; i++) {
      expect(d.onToolCall('read', { path: `/f${i}` }).kind).toBe('none');
    }
    expect(d.onToolCall('read', { path: '/final' }).kind).toBe('steer');
    // Far PAST the old count-abort threshold — still no abort (they're all different).
    for (let i = DEFAULT_WANDER_STEER_AFTER; i < DEFAULT_WANDER_ABORT_AFTER + 30; i++) {
      expect(d.onToolCall('read', { path: `/g${i}` }).kind).toBe('none');
    }
  });
});

describe('reset', () => {
  it('clears all per-turn state', () => {
    const d = createLoopDetector(CFG);
    d.onToolCall('bash', { command: 'ls' });
    d.onToolResult(true);
    d.reset();
    expect(d.snapshot()).toMatchObject({
      steps: 0,
      identicalStreak: 0,
      errorStreak: 0,
      steered: false,
      lastSignature: null,
    });
    // After reset a repeat must climb from scratch (no leaked streak/steer state).
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.onToolCall('bash', { command: 'ls' }).kind).toBe('steer');
  });
});

describe('loopDetectorConfig from effort knobs', () => {
  it('uses fixed streak thresholds, a patient repeat guard, and no step cap', () => {
    const low = loopDetectorConfig(effortKnobs('low'));
    const max = loopDetectorConfig(effortKnobs('max'));
    expect(low.steerAfter).toBe(DEFAULT_LOOP_STEER_AFTER);
    expect(low.abortAfter).toBe(DEFAULT_LOOP_ABORT_AFTER);
    expect(max.steerAfter).toBe(DEFAULT_LOOP_STEER_AFTER);
    // No cap is configured at ANY effort (the user: "remove the tool call cap").
    expect(low.maxSteps).toBeUndefined();
    expect(max.maxSteps).toBeUndefined();
    // …and the repeat guard sits at 75, not 3.
    expect(low.repeatSteerAfter).toBe(DEFAULT_REPEAT_STEER_AFTER);
    expect(max.repeatSteerAfter).toBe(DEFAULT_REPEAT_STEER_AFTER);
  });
});

describe('a loop made entirely of prose', () => {
  /*
   * MEASURED: a turn emitted "Actually, I'll just present the app.py." roughly
   * forty times in a row and nothing stopped it. Every counter in this file
   * watched TOOL CALLS, and that loop made none — so the harness was blind to
   * the most visible failure a user can see.
   */
  const det = () => createLoopDetector({ steerAfter: 3, abortAfter: 6, maxSteps: 200 });
  const LINE = "Actually, I'll just present the app.py.";

  it('steers once the same sentence keeps coming back', () => {
    const d = det();
    expect(d.onText(LINE).kind).toBe('none');
    expect(d.onText(LINE).kind).toBe('none');
    expect(d.onText(LINE).kind).toBe('none');
    const s = d.onText(LINE);
    expect(s.kind).toBe('steer');
    if (s.kind === 'steer') expect(s.cause).toBe('repeat-text');
  });

  it('aborts if it just carries on', () => {
    const d = det();
    let last = d.onText(LINE);
    for (let i = 0; i < 10; i++) last = d.onText(LINE);
    expect(last.kind).toBe('abort');
  });

  it('survives punctuation, case and spacing drift', () => {
    /*
     * What normalisation actually buys, stated honestly. The observed run
     * drifted its punctuation between repeats, and comparing raw bytes would
     * have reset the streak on every one.
     *
     * It does NOT survive a dropped or corrupted letter ("!ll" normalises to
     * "ll", not "ill"), which the same run also produced occasionally. That
     * costs a little sensitivity and buys predictability: an exact match on a
     * normalised line cannot accuse a model that merely wrote something similar,
     * and a loop long enough to matter supplies plenty of clean repeats anyway.
     */
    const d = det();
    d.onText("Actually, I'll just present the app.py.");
    d.onText('Actually, Ill just present the app.py');
    d.onText("  ACTUALLY, I'LL JUST PRESENT THE APP.PY!  ");
    expect(d.onText("actually i'll just present the app.py").kind).toBe('steer');
  });

  it('leaves ordinary prose alone', () => {
    const d = det();
    expect(d.onText('First I will read the CSV files.').kind).toBe('none');
    expect(d.onText('Then I will compute the totals.').kind).toBe('none');
    expect(d.onText('Finally I will report what is wrong.').kind).toBe('none');
    expect(d.onText('First I will read the CSV files.').kind).toBe('none');
  });

  it('ignores short fragments that repeat innocently', () => {
    const d = det();
    for (let i = 0; i < 12; i++) expect(d.onText('ok').kind).toBe('none');
  });

  it('forgets the streak on reset, so it never leaks across turns', () => {
    const d = det();
    d.onText(LINE);
    d.onText(LINE);
    d.onText(LINE);
    d.reset();
    expect(d.onText(LINE).kind).toBe('none');
  });
});

describe('exploration, when every call is bash', () => {
  /*
   * In the bash-CLI tool interface the tool name is ALWAYS `bash`, which is not
   * in EXPLORATION_TOOLS — so every call reset the unproductive streak and the
   * wander guard could never fire. `tools`, `media --help`, `ls`, repeated to
   * the step cap, looked like productive work to the detector because each one
   * arrived under the name of a tool that usually does something.
   */
  it('reads the command, not just the tool name', () => {
    expect(isExplorationTool('bash', { command: 'ls -la src' })).toBe(true);
    expect(isExplorationTool('bash', { command: 'grep -rn foo .' })).toBe(true);
    expect(isExplorationTool('bash', { command: 'tools search voice' })).toBe(true);
  });

  it('treats any --help as discovery, whatever the command', () => {
    expect(isExplorationTool('bash', { command: 'media --help' })).toBe(true);
    expect(isExplorationTool('bash', { command: 'media generate image --help' })).toBe(true);
  });

  it('still counts real work as work', () => {
    // These RESET the streak — a turn doing them is getting somewhere.
    expect(isExplorationTool('bash', { command: 'media generate image "a fox"' })).toBe(false);
    expect(isExplorationTool('bash', { command: 'python3 build.py' })).toBe(false);
    expect(isExplorationTool('bash', { command: 'npm test' })).toBe(false);
  });

  it('is not fooled by a path or a leading pipe segment', () => {
    expect(isExplorationTool('bash', { command: '/bin/ls' })).toBe(true);
    expect(isExplorationTool('bash', { command: 'cat a.txt | wc -l' })).toBe(true);
  });

  it('leaves non-bash classification exactly as it was', () => {
    expect(isExplorationTool('read')).toBe(true);
    expect(isExplorationTool('write')).toBe(false);
    expect(isExplorationTool('web_search')).toBe(false);
  });
});
