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
  remediesFor,
  excerptFailures,
  listProject,
} from './mesh-host';

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

describe('what the does-not-load bump carries', () => {
  const tmpdir = (): string => mkdtempSync(path.join(os.tmpdir(), 'bump-'));

  /* Runs 10, 16, 17 and 18 all died on a hand-written project.godot while the
   * charter already said not to hand-write formats a program owns. A remedy at
   * the point of failure beats a rule read once at the start. */
  it('hands over the known fix for a corrupted project.godot', () => {
    const out = remediesFor(
      "2 problem(s):\nERROR: Error parsing '/x/project.godot' at line 27: Unexpected identifier 'deadzone' File might be corrupted.",
    );
    expect(out).toContain('DELETE the entire [input] section');
    expect(out).toContain('ui_left');
  });

  it('hands over the scene-building fix for a broken .tscn', () => {
    const out = remediesFor('1 problem(s):\nERROR: res://main.tscn:2 - Parse Error: Unexpected end of file.');
    expect(out).toContain('extends SceneTree');
    expect(out).toContain('ResourceSaver.save()');
  });

  it('says nothing when it does not recognise the failure', () => {
    expect(remediesFor('1 problem(s):\nERROR: something entirely new')).toBe('');
  });

  /* "line 27: Unexpected identifier" is only actionable next to line 27. */
  it('excerpts the line an error points at, and marks it', () => {
    const dir = tmpdir();
    writeFileSync(path.join(dir, 'thing.gd'), 'a\nb\nc\nd\ne\nf\n');
    const out = excerptFailures(`ERROR: res://thing.gd:3 - Parse Error`, dir);
    expect(out).toContain('thing.gd around line 3');
    expect(out).toContain('>> 3| c');
    expect(out).toContain('  2| b');
  });

  /* Run 15 spent four bumps on a missing main.tscn without ever being told the
   * project contained no .tscn at all. */
  it('lists what the directory actually holds', () => {
    const dir = tmpdir();
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'project.godot'), 'x');
    writeFileSync(path.join(dir, 'scripts', 'player.gd'), 'y');
    const out = listProject(dir);
    expect(out).toContain('project.godot');
    expect(out).toContain('scripts/player.gd');
  });
});

describe('the autoload remedy', () => {
  /* Run 20's errors went UP across two bumps (22 -> 26) on `counter="Counter"`:
   * autoload entries pointing at names rather than paths. Same shape as the
   * input map — unnecessary configuration, written wrong. */
  it('explains autoload paths, and that a platformer needs none', () => {
    const out = remediesFor(
      '26 problem(s):\nERROR: Failed to instantiate an autoload, can\'t load from path: Counter.',
    );
    expect(out).toContain('*res://');
    expect(out).toContain('DELETE the');
  });
});

describe('excerpting both Godot position formats', () => {
  /* Godot writes `res://x.tscn:15 - Parse Error` in one place and
   * `Error parsing '/abs/project.godot' at line 25` in another. The second is
   * the failure that has killed the most runs, and the first regex missed it —
   * the excerpt never fired for the case it existed for. */
  it("handles \"'file' at line N\", not just file:line", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pos-'));
    writeFileSync(path.join(dir, 'project.godot'), 'a\nb\nc\nd\ne\n');
    const out = excerptFailures(
      `ERROR: Error parsing '${path.join(dir, 'project.godot')}' at line 3: Unexpected identifier`,
      dir,
    );
    expect(out).toContain('around line 3');
    expect(out).toContain('>> 3| c');
  });
});

describe('the missing-main-scene remedy', () => {
  /* Runs 15 and 23 both stalled on `run/main_scene` naming a file that was never
   * created — the malformed-.tscn remedy does not match a MISSING one. */
  it('fires when the main scene does not exist', () => {
    const out = remediesFor("3 problem(s):\nERROR: Cannot open file 'res://main.tscn'.");
    expect(out).toContain('run/main_scene');
    expect(out).toContain('or point');
  });
});

describe('the project.godot remedy gives the whole file', () => {
  /* Run 24 copied Godot's comment header and wrote its `====` illustration in as
   * literal syntax, then `version=5` for `config_version=5`. Describing the
   * sections in prose was not enough; the minimal file itself is. */
  it('spells out a valid minimal project.godot', () => {
    const out = remediesFor(
      "ERROR: Error parsing '/x/project.godot' at line 8: Expected value, got '=' File might be corrupted.",
    );
    expect(out).toContain('config_version=5');
    expect(out).toContain('run/main_scene=');
    expect(out).toContain('Do NOT copy the comment header');
  });
});
