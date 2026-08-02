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
  emptyProjectComplaint,
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

