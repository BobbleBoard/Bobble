/**
 * The nudge fires on the shape of GIVING UP, and on nothing else. Every case
 * below is a turn that ends with a plan on the board; only some of them mean
 * the model stopped short.
 */
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '../state.js';
import { unfinishedPlan, unfinishedPlanNudge } from './unfinished-plan.js';

const item = (id: string, text: string, status: PlanItem['status']): PlanItem => ({
  id,
  text,
  status,
});

describe('unfinishedPlan', () => {
  it('says nothing when there is no plan', () => {
    expect(unfinishedPlan(null)).toBeNull();
    expect(unfinishedPlan([])).toBeNull();
  });

  it('says nothing when every step is done', () => {
    expect(unfinishedPlan([item('1', 'write it', 'done'), item('2', 'run it', 'done')])).toBeNull();
  });

  it('says nothing when NOTHING was ever finished', () => {
    // A plan written and then abandoned for a better approach, or a turn the
    // user interrupted. Pushing "carry on" here is as likely to be wrong as
    // right, so it stays quiet.
    expect(unfinishedPlan([item('1', 'a', 'pending'), item('2', 'b', 'in_progress')])).toBeNull();
  });

  it('fires when real progress was made and then stopped', () => {
    const u = unfinishedPlan([
      item('1', 'scaffold the project', 'done'),
      item('2', 'write the parser', 'done'),
      item('3', 'write the tests', 'pending'),
      item('4', 'run everything', 'in_progress'),
    ]);
    expect(u).not.toBeNull();
    expect(u?.done).toBe(2);
    expect(u?.remaining).toEqual(['write the tests', 'run everything']);
  });

  it('counts an in_progress step as unfinished — started is not done', () => {
    const u = unfinishedPlan([item('1', 'a', 'done'), item('2', 'b', 'in_progress')]);
    expect(u?.remaining).toEqual(['b']);
  });

  it('ignores roadmap steps — parking future work is not giving up', () => {
    // The app renders these dimmer precisely because they are NOT this turn's
    // work. Counting them would punish the more useful plan.
    expect(
      unfinishedPlan([
        item('1', 'ship it', 'done'),
        { id: '2', text: 'someday: rewrite in rust', status: 'pending', roadmap: true },
      ]),
    ).toBeNull();
  });

  it('still fires when a real step hides among roadmap ones', () => {
    const u = unfinishedPlan([
      item('1', 'ship it', 'done'),
      item('2', 'write the tests', 'pending'),
      { id: '3', text: 'someday: rewrite in rust', status: 'pending', roadmap: true },
    ]);
    expect(u?.remaining).toEqual(['write the tests']);
  });
});

describe('unfinishedPlanNudge', () => {
  it("quotes the model's own remaining steps back at it", () => {
    const text = unfinishedPlanNudge({ done: 2, remaining: ['write the tests', 'run everything'] });
    expect(text).toContain('write the tests');
    expect(text).toContain('run everything');
    expect(text).toContain('2 steps done');
  });

  it('says "1 step" rather than "1 steps"', () => {
    expect(unfinishedPlanNudge({ done: 1, remaining: ['x'] })).toContain('1 step done');
  });

  it('caps a long plan instead of pasting a wall of text mid-run', () => {
    const remaining = Array.from({ length: 20 }, (_, i) => `step ${i}`);
    const text = unfinishedPlanNudge({ done: 3, remaining });
    expect(text).toContain('step 7');
    expect(text).not.toContain('step 8');
    expect(text).toContain('…and 12 more');
    // …and it still states the true total, so the cap cannot understate the work.
    expect(text).toContain('20 unfinished');
  });

  it('offers the honest exit: drop a step, do not leave it hanging', () => {
    const text = unfinishedPlanNudge({ done: 1, remaining: ['impossible thing'] });
    expect(text).toMatch(/unnecessary or impossible/);
  });
});
