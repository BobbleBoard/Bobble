import { buildCorpRoster } from '@pi-desktop/harness/corp';
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STEPS_PER_MESSAGE,
  hostPassthrough,
  PASSTHROUGH_KEYS,
  taskNote,
  excerptFailures,
  listProject,
  emptyProjectComplaint, MESH_ENTRY, isUncheckable, runtimeCheck, testSuiteReport } from './mesh-host';

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
    writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\nrun/main_scene="res://x.tscn"\n');
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
