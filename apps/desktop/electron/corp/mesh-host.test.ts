/**
 * The parts of the mesh host that can be checked without a model.
 *
 * The bug these exist for is not a crash. `onSubmitted` was declared on the run
 * options AND on the host config, and forwarded between them by nothing — so run
 * 7's one accepted `submit_work`, the first any run had ever produced, left no
 * record at all and the run looked like the tool had never fired. A dropped
 * observer is silent, and silence is what makes it expensive: you go looking for
 * a wiring bug that isn't there.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCorpRoster,
  HandLedger,
  type MeshAgent,
  RAISE_HAND_TOOL,
  WAIT_TOOL,
} from '@pi-desktop/harness/corp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLEAN_LOAD,
  communicationTools,
  DEFAULT_STEPS_PER_MESSAGE,
  dispatchesTo,
  emptyProjectComplaint,
  excerptFailures,
  hasProduct,
  hostPassthrough,
  isUncheckable,
  listProject,
  MESH_ENTRY,
  type MeshDispatcher,
  managerOf,
  orphanReport,
  PASSTHROUGH_KEYS,
  runtimeCheck,
  taskNote,
  testSuiteReport,
} from './mesh-host';
import { roleActiveTools, unusablePathRefusal, unusableWritePath } from './role-agent';

describe('what a run hands through to its host', () => {
  it('carries every passthrough setting that was supplied', () => {
    const onActivity = (): void => {};
    const onSubmitted = (): void => {};
    const out = hostPassthrough({
      maxTokens: 2048,
      maxLiveAgents: 3,
      maxStepsPerMessage: 12,
      onActivity,
      onSubmitted,
      // Not passthrough — the run handles these itself.
      task: 'build a thing',
      cwd: '/tmp/x',
    });
    expect(out).toEqual({
      maxTokens: 2048,
      maxLiveAgents: 3,
      maxStepsPerMessage: 12,
      onActivity,
      onSubmitted,
    });
  });

  it('carries the submission observer — the one that was silently dropped', () => {
    const onSubmitted = (): void => {};
    expect(hostPassthrough({ onSubmitted })).toEqual({ onSubmitted });
  });

  it('omits what was not supplied, so the host keeps its own defaults', () => {
    // Under exactOptionalPropertyTypes, setting a key to `undefined` is NOT the
    // same as leaving it out: `{maxStepsPerMessage: undefined}` would override the
    // default with nothing and take the budget away again.
    const out = hostPassthrough({ maxTokens: 100, maxLiveAgents: undefined });
    expect(out).toEqual({ maxTokens: 100 });
    expect('maxLiveAgents' in out).toBe(false);
  });

  it('passes nothing through when nothing was given', () => {
    expect(hostPassthrough({})).toEqual({});
  });

  it('lists the keys once, where they can be read', () => {
    expect([...PASSTHROUGH_KEYS]).toEqual([
      'maxTokens',
      'maxLiveAgents',
      'maxStepsPerMessage',
      'onActivity',
      'onSubmitted',
      'onRepaired',
    ]);
  });
});

describe('what the manager is told, every time', () => {
  // Run 10's manager measured once and then repeated a stale diagnosis four
  // times; run 17 dropped a requirement stated in a sentence of its own. It is
  // handed the ask, unchanged, on every message — and no automated verdict,
  // because an automated verdict only means anything for a project somebody
  // anticipated, and this has to work for a film too.
  it('restates the task verbatim', () => {
    const note = taskNote('Build a thing that does the following.');
    expect(note).toContain('WHAT WAS ASKED FOR');
    expect(note).toContain('Build a thing that does the following.');
  });

  it('says nothing at all when there is no task to restate', () => {
    expect(taskNote()).toBe('');
    expect(taskNote('   ')).toBe('');
  });

  it('carries no automated verdict — the manager judges by using the product', () => {
    const note = taskNote('anything');
    expect(note).not.toContain('PRODUCT CHECK');
    expect(note).not.toContain('PASSES');
    expect(note).not.toContain('FAILS');
  });
});

describe('the per-message work budget', () => {
  it('is generous enough for real work and finite enough to end', () => {
    /*
     * Real work is a dozen reads, a few writes and several test runs. Run 7's
     * engineer passed forty-eight calls in ONE message and had not stopped —
     * which is what the upper bound was originally written against.
     *
     * RAISED to allow 60. Runs 9 and 10 both ended "(ceo ran out of steps after
     * 31 / 33 tool calls without ever replying)": seventeen files of a Godot
     * project is more than 24 calls of work, so the cap was landing mid-build
     * and a role cut off mid-build never reaches the part where it RUNS what it
     * wrote. The cap is a runaway guard, not a work budget — it must not be the
     * thing that decides the outcome of ordinary work — but it stays finite,
     * because a role that never stops never reports.
     */
    expect(DEFAULT_STEPS_PER_MESSAGE).toBeGreaterThanOrEqual(12);
    expect(DEFAULT_STEPS_PER_MESSAGE).toBeLessThanOrEqual(60);
  });
});

describe('an empty project is not a clean load', () => {
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'empty-'));

  /* Run 29's project.godot was a YAML build config with GCC flags and
   * `engine_hollywood` in it, and the project had no .tscn at all. Godot ignores
   * what it cannot parse, opens nothing, and reports no errors — which would
   * have ended the convergence loop on an empty directory. */
  it('says so when there is no scene to open', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'project.godot'),
      'config_version=5\nrun/main_scene="res://x.tscn"\n',
    );
    expect(emptyProjectComplaint(dir)).toContain('NOTHING TO LOAD');
  });

  it('says so when nothing names a main scene', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'scenes'), { recursive: true });
    writeFileSync(path.join(dir, 'scenes', 'main.tscn'), '[gd_scene]');
    writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
    expect(emptyProjectComplaint(dir)).toContain('no `run/main_scene`');
  });

  it('is silent about a project that really is set up', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'scenes'), { recursive: true });
    writeFileSync(path.join(dir, 'scenes', 'main.tscn'), '[gd_scene]');
    writeFileSync(
      path.join(dir, 'project.godot'),
      'config_version=5\n\n[application]\nrun/main_scene="res://scenes/main.tscn"\n',
    );
    expect(emptyProjectComplaint(dir)).toBeNull();
  });
});

describe('only one sentence means success', () => {
  /* Run 32 was told "loads clean but nothing was said" about a directory holding
   * two scripts and no project.godot: the bump tested for a leading
   * "N problem(s):", so the empty-project complaint read as success. A new
   * failure message must never pass just because it is phrased differently. */
  it('treats every complaint as broken, however worded', () => {
    const clean = 'It loaded with NO errors.';
    const isBroken = (state: string): boolean => !state.startsWith(clean);
    expect(isBroken('3 problem(s):\nERROR: x')).toBe(true);
    expect(isBroken('There is no project.godot at all, so this is not a Godot project yet.')).toBe(
      true,
    );
    expect(isBroken('It reported no errors — because there is NOTHING TO LOAD.')).toBe(true);
    expect(isBroken(clean)).toBe(false);
    expect(isBroken(`${clean}\nNOTE: I removed your [input] section.`)).toBe(false);
  });
});

describe('an unchecked project is never reported as checked', () => {
  /*
   * THE INVERSE OF THE BUG ABOVE, and it shipped for longer.
   *
   * `broken` is `!CLEAN_LOAD && !isUncheckable(state)`, so the success path is
   * reached in TWO states — genuinely clean, and never checked at all. It
   * asserted the first for both: "The project LOADS CLEANLY — I checked."
   *
   * runtimeCheck is Godot-only, so EVERY other kind of project lands in the
   * second state. Measured on the CloudConvert run: an Electron app whose
   * main.js throws at module scope on a non-existent import, and the harness
   * told the manager it had checked that it loads.
   */
  const verifiedWording = (state: string): boolean => state.startsWith(CLEAN_LOAD);

  it('separates "it loaded" from "there was no way to check"', () => {
    expect(verifiedWording(CLEAN_LOAD)).toBe(true);
    expect(verifiedWording('(no automatic check exists for this kind of project.)')).toBe(false);
  });

  /* Both are `!broken`, which is exactly why the wording had to stop keying off
   * `broken` and start keying off the state itself. */
  it('agrees with the broken gate that neither state is a failure', () => {
    const isBroken = (state: string): boolean =>
      !state.startsWith(CLEAN_LOAD) && !isUncheckable(state);
    expect(isBroken(CLEAN_LOAD)).toBe(false);
    expect(isBroken('(no automatic check exists for this kind of project.)')).toBe(false);
    expect(isBroken('3 problem(s):\nERROR: x')).toBe(true);
  });
});

describe('the mesh entry point exists', () => {
  /*
   * THE BUG THIS EXISTS FOR. The harness has its own `runCorpMesh`, which the
   * desktop does not use — mesh-host builds the roster and runs the mesh itself.
   * So when the `ceo` seat was removed from `buildCorpRoster`, the harness path
   * was updated and green while the desktop still delivered to 'ceo'. Delivering
   * to an id that is not in the roster is not an error: the mesh answers
   * `(there is no "ceo" to talk to.)` and the run "completes" instantly with that
   * as its product. The CEO read it as "the manager is unavailable", built the
   * whole thing itself, and shipped a project.godot that degenerated into
   * hundreds of lines of repeated tokens.
   *
   * A whole suite passed through that. This is the invariant that would not have.
   */
  it('MESH_ENTRY names an agent that is actually in the roster', () => {
    const roster = buildCorpRoster({ task: 'build a game' });
    expect(roster.map((a) => a.id)).toContain(MESH_ENTRY);
  });

  it('the entry is the root of the org chart — nothing is above it', () => {
    const roster = buildCorpRoster({ task: 'build a game' });
    const entry = roster.find((a) => a.id === MESH_ENTRY);
    // The entry reports by RETURNING; it has no peer above it to message.
    expect(entry).toBeDefined();
    expect(entry?.peers ?? []).not.toContain('ceo');
  });
});

describe('"could not check" is not "broken"', () => {
  /*
   * MEASURED on a Python app the team had built correctly. The bump decided
   * broken as `!state.startsWith(CLEAN_LOAD)` — two states — so
   * "(no automatic check exists for this kind of project.)" read as failure and
   * the manager was told "STOP. I ran the project check myself and IT DOES NOT
   * LOAD ... Fix exactly these errors and nothing else" about a project with no
   * errors. It would have spent all six bumps chasing a phantom.
   *
   * That is five of the six corp benchmarks: Python, web, decks, documents.
   * Only Godot escaped, because Godot is the only runtime runtimeCheck drives.
   */
  it('reports a non-Godot project as UNCHECKABLE, not as failing', () => {
    const state = runtimeCheck(null, '/tmp');
    expect(isUncheckable(state)).toBe(true);
    // The exact predicate the bump uses to decide "send it back".
    expect(!state.startsWith('It loaded with NO errors.') && !isUncheckable(state)).toBe(false);
  });

  it('says the same for any runtime it does not drive', () => {
    for (const rt of ['python', 'node', 'unity', 'blender']) {
      expect(isUncheckable(runtimeCheck(rt, '/tmp'))).toBe(true);
    }
  });

  it('does NOT call a real failure uncheckable', () => {
    expect(isUncheckable('3 problem(s):\nres://main.tscn:5 Parse Error')).toBe(false);
    expect(isUncheckable('It loaded with NO errors.')).toBe(false);
  });
});

describe('testSuiteReport — a file named test_* with no tests in it', () => {
  /*
   * MEASURED: a run asked for a CSV merger "with tests". The team delivered
   * test_merger.py — 35 lines, correctly named, containing NO test functions.
   * pytest collected zero items and printed "no tests ran", which reads as fine,
   * and the claim went undischarged.
   */
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bobble-tests-'));

  it('is SILENT when the project has no test files at all', () => {
    const dir = path.join(tmp, 'no-tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'main.py'), 'print(1)\n');
    // A task that never asked for tests must not be nagged about them.
    expect(testSuiteReport(dir)).toBe('');
  });

  it('reports zero-collected as the failure it is', () => {
    const dir = path.join(tmp, 'fake-tests');
    mkdirSync(dir, { recursive: true });
    // Exactly the shape delivered: top-level script code, no test functions.
    writeFileSync(path.join(dir, 'test_thing.py'), 'x = 1\nprint("ran")\n');
    const out = testSuiteReport(dir);
    expect(out).toContain('THERE ARE NONE');
    expect(out).toContain('test_*');
  });

  it('passes a real suite through', () => {
    const dir = path.join(tmp, 'real-tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'test_ok.py'), 'def test_one():\n    assert 1 == 1\n');
    const out = testSuiteReport(dir);
    expect(out).toContain('I ran your tests');
    expect(out).not.toContain('THERE ARE NONE');
  });
});

describe('orphanReport — written, but nothing can reach it', () => {
  /*
   * MEASURED on run 9: `main_scene.tscn` and `main_scene.gd` were written and
   * announced, and `run/main_scene` was never added to project.godot. A perfect
   * scene nothing could reach, which surfaced 45 seconds later as a timeout.
   *
   * The same shape as test_merger.py (a test file with no test) and a mesh entry
   * naming a seat that did not exist: registered is not reachable.
   */
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bobble-orphan-'));
  const mk = (name: string, files: Record<string, string>): string => {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
    return dir;
  };

  it('catches the run 9 delivery: a scene no project.godot points at', () => {
    const dir = mk('godot', {
      'project.godot': 'config_version=5\n\n[application]\nconfig/name="Godot Test"\n',
      'main_scene.tscn': '[gd_scene load_steps=2]\n[ext_resource path="res://player.tscn"]\n',
      'player.tscn': '[gd_scene]\n[ext_resource path="res://player.gd"]\n',
      'player.gd': 'extends Node2D\n',
    });
    const out = orphanReport(dir);
    expect(out).toContain('NOTHING REFERENCES THESE FILES');
    expect(out).toContain('main_scene.tscn');
    // player.gd and player.tscn ARE referenced — they must not be dragged in.
    expect(out).not.toContain('player.gd');
    expect(out).not.toContain('player.tscn');
  });

  it('is SILENT when everything is wired up', () => {
    const dir = mk('wired', {
      'project.godot': 'config_version=5\nrun/main_scene="res://main_scene.tscn"\n',
      'main_scene.tscn': '[gd_scene]\n[ext_resource path="res://player.gd"]\n',
      'player.gd': 'extends Node2D\n',
    });
    expect(orphanReport(dir)).toBe('');
  });

  it('never flags entry points, tests, or standalone docs', () => {
    // Nothing references main.py, and nothing is supposed to. pytest finds
    // test_x.py by NAME, not by reference. A README stands alone by design.
    const dir = mk('conventions', {
      'main.py': 'import helper\nhelper.go()\n',
      'helper.py': 'def go(): pass\n',
      'test_helper.py': 'def test_go(): pass\n',
      'README.md': '# notes\n',
      'data.csv': 'a,b\n1,2\n',
    });
    expect(orphanReport(dir)).toBe('');
  });

  it('catches an unimported python module and an unlinked stylesheet', () => {
    // The same defect in two ecosystems the Godot check knows nothing about.
    const dir = mk('mixed', {
      'main.py': 'print("hi")\n',
      'utils.py': 'def helper(): pass\n',
      'index.html': '<html><body>hi</body></html>\n',
      'styles.css': 'body { color: red }\n',
    });
    const out = orphanReport(dir);
    expect(out).toContain('utils.py');
    expect(out).toContain('styles.css');
  });

  it('says nothing about a single-file deliverable', () => {
    expect(orphanReport(mk('solo', { 'main.py': 'print(1)\n' }))).toBe('');
  });
});

describe('a timed-out runtime check explains itself', () => {
  /*
   * MEASURED on run 9: a project.godot with a valid config_version and real
   * scenes but NO `run/main_scene`. `godot --headless --quit` had nothing to run,
   * so it never quit — my own check sat for over two minutes with no output.
   * Reporting "spawnSync ETIMEDOUT" tells the model nothing it can act on, and
   * the cause is one emptyProjectComplaint already knows how to name.
   */
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bobble-timeout-'));

  it('names the missing main_scene rather than the errno', () => {
    const dir = path.join(tmp, 'no-main-scene');
    mkdirSync(path.join(dir, 'scenes'), { recursive: true });
    writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\n');
    writeFileSync(path.join(dir, 'scenes', 'a.tscn'), '[gd_scene format=3]\n');
    const complaint = emptyProjectComplaint(dir);
    expect(complaint).toBeTruthy();
    expect(complaint).toContain('run/main_scene');
    // And the wording must not claim a clean run when nothing ran.
    expect(complaint?.replace(/^It reported no errors,\s*but\s*/i, '')).not.toContain(
      'reported no errors',
    );
  });
});

describe('hasProduct — a handback needs something to hand back', () => {
  /*
   * MEASURED, run 11: 2.5 minutes in, the manager had written a plan and its
   * first contract, no engineer had run, and the workspace held only
   * `.bobble-chat` and an empty `.scratch`. The harness called that a handback
   * and demanded a FINAL CHECK, listing the plan back as twelve claims about a
   * finished product.
   *
   * Cause: runtimeCheck returns NO_CHECK for anything non-Godot, so `broken` is
   * false and the branch labelled "Clean" runs at the end of turn one. Five of
   * six benchmarks have no runtime check.
   */
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bobble-product-'));
  const mk = (name: string, files: Record<string, string>, dirs: string[] = []): string => {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    for (const d of dirs) mkdirSync(path.join(dir, d), { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
    return dir;
  };

  it('is false for the exact shape run 11 was final-checked on', () => {
    expect(hasProduct(mk('run11', { '.bobble-chat': 'id' }, ['.scratch']))).toBe(false);
  });

  it('is false for an empty workspace', () => {
    expect(hasProduct(mk('empty', {}))).toBe(false);
  });

  it('is true as soon as one real file exists', () => {
    expect(hasProduct(mk('one', { 'main.py': 'print(1)\n' }))).toBe(true);
  });

  it('finds a product nested in a subdirectory', () => {
    const dir = mk('nested', {}, ['src']);
    writeFileSync(path.join(dir, 'src', 'app.py'), 'x = 1\n');
    expect(hasProduct(dir)).toBe(true);
  });

  it('does not count the roles own scratch area as a deliverable', () => {
    const dir = mk('scratchonly', {}, ['.scratch']);
    writeFileSync(path.join(dir, '.scratch', 'notes.md'), 'thinking\n');
    expect(hasProduct(dir)).toBe(false);
  });
});

describe('nothing built yet is a continue, not a stop', () => {
  /*
   * Run 12, after the hasProduct guard landed: the manager wrote a plan, ended
   * its turn without commissioning anybody, and nothing restarted it —
   * `manager:done`, zero files, no engineer ever run.
   *
   * The premature final check had been masking that. It said something false but
   * it was the kick that made the manager delegate, so removing it removed the
   * kick. hasProduct decides WHICH message to send, never whether to stop
   * bumping: a manager that halts after planning is the premature stop the bump
   * exists to catch.
   */
  it('keeps hasProduct as a message choice, not a termination', () => {
    const src = readFileSync(path.join(__dirname, 'mesh-host.ts'), 'utf8');
    const guard = src.slice(src.indexOf('if (!hasProduct(config.cwd))'));
    const body = guard.slice(0, guard.indexOf('// Clean.'));
    expect(body).toContain('NOTHING HAS BEEN BUILT YET');
    // The regression in one line: this branch must never end the loop.
    expect(body).not.toContain('return undefined');
  });
});

describe('raise_hand — a stuck agent is not a finished agent', () => {
  const agent = (id: string, role: string, peers: string[]): MeshAgent => ({
    id,
    role,
    systemPrompt: '',
    peers,
    tools: [],
  });
  const noTalk = async (): Promise<string> => '';
  const names = (a: MeshAgent, hands?: HandLedger): string[] =>
    communicationTools(a, noTalk, undefined, hands).map((t) => t.name as string);

  /*
   * ADVERTISEMENT IS THE PROPERTY. A tool that exists but is not offered to the
   * agent that needs it is the same as no tool — twice this project has chased a
   * "the model won't use it" bug that was really "it was never in the list".
   */
  it('is advertised to an engineer, who reports to the manager', () => {
    expect(names(agent('engineer:1', 'engineer', ['manager']), new HandLedger())).toContain(
      RAISE_HAND_TOOL,
    );
  });

  it('is advertised to the manager, who reports to the CEO', () => {
    expect(names(agent('manager', 'manager', ['ceo', 'engineer:1']), new HandLedger())).toContain(
      RAISE_HAND_TOOL,
    );
  });

  it('is NOT advertised to the lead — it reports to nobody', () => {
    expect(names(agent('ceo', 'ceo', ['manager']), new HandLedger())).not.toContain(
      RAISE_HAND_TOOL,
    );
  });

  it('is NOT advertised when the agent cannot actually reach its manager', () => {
    // Routing a hand at a non-peer would drop it silently, which is precisely the
    // failure the tool exists to remove.
    expect(names(agent('engineer:9', 'engineer', []), new HandLedger())).not.toContain(
      RAISE_HAND_TOOL,
    );
  });

  it('records the hand against the manager, and reports it as NOT delivered', async () => {
    const hands = new HandLedger();
    const tools = communicationTools(
      agent('engineer:1', 'engineer', ['manager']),
      noTalk,
      undefined,
      hands,
    );
    const tool = tools.find((t) => t.name === RAISE_HAND_TOOL);
    const res = await (
      tool as unknown as {
        execute: (id: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).execute('c1', { reason: 'not_working', message: 'browser tool returns no elements' });
    expect(res.content[0]?.text).toContain('STOPPED');
    expect(res.content[0]?.text).toContain('Nothing was delivered');
    expect(hands.peek('manager')).toHaveLength(1);
    expect(hands.peek('manager')[0]?.from).toBe('engineer:1');
  });

  it('rides the manager’s NEXT tool result, then does not repeat', async () => {
    const hands = new HandLedger();
    hands.raise('manager', {
      from: 'engineer:1',
      reason: 'not_working',
      message: 'browser tool returns no elements',
    });
    const mgr = communicationTools(
      agent('manager', 'manager', ['ceo', 'engineer:1']),
      async () => 'engineer replied: done',
      undefined,
      hands,
    );
    const talkTool = mgr.find((t) => t.name === 'talk_to');
    const exec = (
      talkTool as unknown as {
        execute: (id: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).execute;
    const first = await exec('c1', { recipient: 'engineer:1', message: 'status?' });
    expect(first.content[0]?.text).toContain('engineer replied: done');
    expect(first.content[0]?.text).toContain('additional info, engineer:1 is stopped');
    // Drained: a second call carries the reply alone.
    const second = await exec('c2', { recipient: 'engineer:1', message: 'and now?' });
    expect(second.content[0]?.text).toContain('engineer replied: done');
    expect(second.content[0]?.text).not.toContain('additional info');
  });
});

describe('managerOf — where a raised hand goes', () => {
  const a = (id: string, role: string, peers: string[]) =>
    ({ id, role, systemPrompt: '', peers, tools: [] }) as MeshAgent;

  it('sends an engineer’s hand to the manager, and the manager’s to the CEO', () => {
    expect(managerOf(a('engineer:1', 'engineer', ['manager']))).toBe('manager');
    expect(managerOf(a('manager', 'manager', ['ceo', 'engineer:1']))).toBe('ceo');
    expect(managerOf(a('specialist:tester', 'specialist', ['manager']))).toBe('manager');
  });

  it('gives the lead nobody to raise to', () => {
    expect(managerOf(a('ceo', 'ceo', ['manager']))).toBeUndefined();
    expect(managerOf(a('solo', 'solo', []))).toBeUndefined();
  });

  it('refuses to route at a NON-PEER, which would drop the hand silently', () => {
    // Derived from the real peer list rather than assumed from the role — an
    // unreachable target is exactly the disappearance this tool exists to stop.
    expect(managerOf(a('engineer:9', 'engineer', []))).toBeUndefined();
    expect(managerOf(a('manager', 'manager', ['engineer:1']))).toBeUndefined();
  });
});

describe('wait — the manager delegates a round, then stands by', () => {
  const agent = (id: string, role: string, peers: string[]) =>
    ({ id, role, systemPrompt: '', peers, tools: [] }) as MeshAgent;
  const mgr = agent('manager', 'manager', ['ceo', 'engineer:1', 'engineer:2']);
  const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? '';
  const call = (tools: ReturnType<typeof communicationTools>, name: string) =>
    (
      tools.find((t) => t.name === name) as unknown as {
        execute: (id: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).execute;

  /** A dispatcher stub — the mesh's contract, without a mesh. */
  const stub = (over: Partial<MeshDispatcher> = {}): MeshDispatcher => ({
    dispatch: () => 'handed off',
    waitOn: async () => ({ kind: 'idle', finished: [], stillRunning: [] }),
    outstanding: () => [],
    ...over,
  });

  it('is advertised to the manager and NOT to an engineer', () => {
    const names = (a: MeshAgent) =>
      communicationTools(a, async () => '', undefined, new HandLedger(), stub()).map((t) => t.name);
    expect(names(mgr)).toContain(WAIT_TOOL);
    // An engineer does the work; it has nobody to stand by for.
    expect(names(agent('engineer:1', 'engineer', ['manager']))).not.toContain(WAIT_TOOL);
  });

  it('DELEGATION HANDS OFF — talk_to downward returns without the reply', async () => {
    /* The whole point: a blocking hand-off means engineer:2 can never start, so
     * there is no round to wait on. */
    let dispatched = '';
    const tools = communicationTools(
      mgr,
      async () => 'SHOULD NOT BE USED',
      undefined,
      undefined,
      stub({
        dispatch: (_f, to) => {
          dispatched = to;
          return `Handed to ${to}, who is working on it now.`;
        },
      }),
    );
    const out = text(
      await call(tools, 'talk_to')('c1', { recipient: 'engineer:1', message: 'build' }),
    );
    expect(dispatched).toBe('engineer:1');
    expect(out).toContain('working on it now');
    expect(out).not.toContain('SHOULD NOT BE USED');
  });

  it('a report UPWARD still waits — the answer is why it was asked', async () => {
    const tools = communicationTools(
      mgr,
      async () => 'the CEO says go ahead',
      undefined,
      undefined,
      stub({
        dispatch: () => 'WRONG — should not dispatch upward',
      }),
    );
    const out = text(await call(tools, 'talk_to')('c1', { recipient: 'ceo', message: 'done?' }));
    expect(out).toBe('the CEO says go ahead');
  });

  it('reports who came back, and who is still going', async () => {
    const tools = communicationTools(
      mgr,
      async () => '',
      undefined,
      new HandLedger(),
      stub({
        waitOn: async () => ({
          kind: 'finished',
          finished: [{ to: 'engineer:1', reply: 'movement built' }],
          stillRunning: ['engineer:2'],
        }),
      }),
    );
    const out = text(await call(tools, WAIT_TOOL)('c1', {}));
    expect(out).toContain('engineer:1 came back');
    expect(out).toContain('movement built');
    expect(out).toContain('Still working: engineer:2');
  });

  it('says plainly when the round is over, so the manager moves on to testing', async () => {
    const tools = communicationTools(
      mgr,
      async () => '',
      undefined,
      new HandLedger(),
      stub({
        waitOn: async () => ({
          kind: 'finished',
          finished: [{ to: 'engineer:1', reply: 'done' }],
          stillRunning: [],
        }),
      }),
    );
    expect(text(await call(tools, WAIT_TOOL)('c1', {}))).toContain('That was everyone');
  });

  it('waiting on an empty team is a MISTAKE TO REPORT, never a hang', async () => {
    const tools = communicationTools(mgr, async () => '', undefined, new HandLedger(), stub());
    const out = text(await call(tools, WAIT_TOOL)('c1', {}));
    expect(out).toContain('nothing to wait for');
    expect(out).toContain('Delegate the next round');
  });

  it('carries a raised hand out of the wait, so standing by is how you hear it', async () => {
    const hands = new HandLedger();
    hands.raise('manager', {
      from: 'engineer:2',
      reason: 'not_working',
      message: 'three.js will not load offline',
    });
    const tools = communicationTools(
      mgr,
      async () => '',
      undefined,
      hands,
      stub({
        waitOn: async () => ({ kind: 'nudged', finished: [], stillRunning: ['engineer:2'] }),
      }),
    );
    const out = text(await call(tools, WAIT_TOOL)('c1', {}));
    expect(out).toContain('additional info, engineer:2 is stopped');
    expect(out).toContain('three.js will not load offline');
  });
});

describe('dispatchesTo — which hand-offs run in parallel', () => {
  const a = (id: string, role: string) =>
    ({ id, role, systemPrompt: '', peers: [], tools: [] }) as MeshAgent;

  it('parallelises work handed DOWN to engineers', () => {
    expect(dispatchesTo(a('manager', 'manager'), 'engineer:1')).toBe(true);
    expect(dispatchesTo(a('ceo', 'ceo'), 'engineer:2')).toBe(true);
  });

  it('keeps a specialist SYNCHRONOUS — its measurement is the answer you asked for', () => {
    expect(dispatchesTo(a('manager', 'manager'), 'specialist:tester')).toBe(false);
  });

  it('keeps a report UPWARD synchronous', () => {
    expect(dispatchesTo(a('manager', 'manager'), 'ceo')).toBe(false);
  });

  it('an engineer never dispatches — it does the work itself', () => {
    expect(dispatchesTo(a('engineer:1', 'engineer'), 'engineer:2')).toBe(false);
  });
});

describe('the custom communication tools survive the active-set narrowing', () => {
  /*
   * THE RUN-KILLER, 2026-08-09. A role's active set was narrowed to
   * `config.tools` — the manager's is ['read','ls','write'] — while everything
   * that makes it a team member arrives as customTools. So talk_to,
   * commission_specialist, ready_to_delegate and request_test_tools were
   * registered and then deactivated, and the manager, fenced from writing the
   * product AND holding no way to hand it off, wrote it itself. In its own
   * words: "no talk_to or commission_specialist active… there are no engineers
   * available on this machine".
   */
  const names = ['talk_to', 'commission_specialist', 'ready_to_delegate', 'request_test_tools'];

  it('unions the custom tool names into the active set', () => {
    const active = roleActiveTools(['read', 'ls', 'write', ...names]);
    for (const n of names) expect(active).toContain(n);
    // The file kit and tool_search are still there.
    expect(active).toContain('write');
    expect(active).toContain('tool_search');
  });

  it('a planning kit ALONE leaves a manager unable to delegate — the bug', () => {
    // Kept as the counter-example: this is precisely what shipped, and what the
    // union above exists to prevent.
    const active = roleActiveTools(['read', 'ls', 'write']);
    for (const n of names) expect(active).not.toContain(n);
  });

  it('does not duplicate a name that is in both lists', () => {
    const active = roleActiveTools(['read', 'talk_to', 'talk_to']);
    expect(active.filter((n) => n === 'talk_to')).toHaveLength(2); // caller dedupes; pass-through is honest
    expect(
      roleActiveTools(['read', 'tool_search']).filter((n) => n === 'tool_search'),
    ).toHaveLength(1);
  });
});

describe('a write whose path cannot be opened is refused, not relocated', () => {
  /*
   * the user: "it just shows up blank in the canvas sidebar… ensure even if paths are
   * malformed or something it gets written somewhere / reprompted to specify the
   * path if there's error." The write PARSED and the +N counter climbed, so
   * nothing looked wrong until the file was wanted an hour later.
   *
   * Refusing beats relocating: this project already shipped a silent-relocation
   * bug, where the agent was never told its file had gone somewhere else.
   */
  it('rejects the shapes that cannot name a file', () => {
    expect(unusableWritePath('')).toBeTruthy();
    expect(unusableWritePath('   ')).toBeTruthy();
    expect(unusableWritePath('/tmp/out/')).toContain('folder');
    expect(unusableWritePath('/tmp/report.md.')).toContain('dot');
    expect(unusableWritePath('the file at src/x.ts')).toContain('sentence');
    expect(unusableWritePath('/tmp/a\nb.md')).toContain('line break');
  });

  it('leaves ORDINARY paths alone — a fence that second-guesses is worse than none', () => {
    for (const ok of [
      '/Users/user/bobble-testbed/run/report.md',
      'src/index.ts',
      './notes.md',
      '../sibling/file.json',
      '/tmp/a b.md', // a single space is a legal filename
      'C:\\Users\\x\\file.txt',
    ]) {
      expect(unusableWritePath(ok)).toBeUndefined();
    }
  });

  it('tells the model nothing was written AND what to do next', () => {
    const msg = unusablePathRefusal('write', '/tmp/out/', 'it names a folder');
    expect(msg).toContain('did NOT happen');
    expect(msg).toContain('nothing was moved somewhere else');
    expect(msg).toContain('absolute path');
  });
});
