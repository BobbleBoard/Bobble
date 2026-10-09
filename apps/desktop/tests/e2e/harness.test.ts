/**
 * The probe harness's focus rule.
 *
 * A suite that steals focus is one you cannot run while working, and the guard
 * is what turns "I believe it is unobtrusive" into "it goes red if it stops
 * being". Tested here rather than by actually moving focus, because a test that
 * activates another application is itself the problem.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error - the harness is plain ESM for probes, not typed app code.
import { focusComplaint } from './harness.mjs';

describe('focusComplaint', () => {
  it('is silent when the frontmost app never changed', () => {
    expect(focusComplaint('Claude', 'Claude')).toBeNull();
  });

  it('complains, with both names, when it did', () => {
    const c = focusComplaint('Claude', 'Electron');
    expect(c).toContain('Claude');
    expect(c).toContain('Electron');
  });

  it('ignores the PERSON switching apps — only our own window counts', () => {
    // Seen live on a green probe: `was "Safari", became "Mail"`, because the user
    // read their mail while it ran. That is not the app taking the screen.
    expect(focusComplaint('Safari', 'Mail')).toBeNull();
    // …but the packaged app coming to the front still is.
    expect(focusComplaint('Safari', 'Bobble')).toContain('Bobble');
  });

  it('cannot tell on a platform without the reading, so does not fail', () => {
    // Not macOS, or the automation permission withheld. A check that cannot
    // tell must not fail — otherwise the suite is red everywhere else.
    expect(focusComplaint(null, 'Electron')).toBeNull();
    expect(focusComplaint('Claude', null)).toBeNull();
    expect(focusComplaint(null, null)).toBeNull();
  });
});
