import { describe, expect, it } from 'vitest';
import { createMacSessionState } from './session-state.js';

describe('createMacSessionState (controlled-app state machine)', () => {
  it('starts with no control: empty target params, empty description', () => {
    const s = createMacSessionState();
    expect(s.controlled()).toBeNull();
    expect(s.targetParams()).toEqual({});
    expect(s.describe()).toBe('');
  });

  it('a launch takes control and stamps the pid onto every act', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242, 99);
    /* No `visualOnly` yet: a launch has not looked at the app. mac_launch takes
     * a snapshot immediately afterwards, and that is what records which kind of
     * app it is. */
    expect(s.controlled()).toEqual({
      pid: 4242,
      app: 'TextEdit',
      windowId: 99,
      lastAct: 'opened TextEdit',
    });
    expect(s.targetParams()).toEqual({ pid: 4242 });
    expect(s.describe()).toContain('"TextEdit"');
    expect(s.describe()).toContain('4242');
  });

  it('a snapshot of a different app MOVES control to it', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242);
    s.noteSnapshot({ app: 'Maps', pid: 7777, windowId: 12 });
    expect(s.controlled()).toEqual({
      pid: 7777,
      app: 'Maps',
      windowId: 12,
      visualOnly: false,
      dialogKey: '',
    });
    expect(s.targetParams()).toEqual({ pid: 7777 });
  });

  it('a same-pid snapshot refreshes without losing the known windowId', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242, 99);
    s.noteSnapshot({ app: 'TextEdit', pid: 4242 }); // no windowId on the wire
    expect(s.controlled()).toEqual({
      pid: 4242,
      app: 'TextEdit',
      windowId: 99,
      visualOnly: false,
      dialogKey: '',
      /* A LOOK IS NOT AN ACT: snapshotting must not overwrite what the model
       * actually did, or the snapshot header would report the snapshot. */
      lastAct: 'opened TextEdit',
    });
  });

  it('an unresolved snapshot (no pid) cannot take or clobber control', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'Mystery' });
    expect(s.controlled()).toBeNull();
    s.noteLaunched('TextEdit', 4242);
    s.noteSnapshot({});
    expect(s.controlled()?.pid).toBe(4242);
  });

  it('release drops control back to the pre-launch state', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242);
    s.release();
    expect(s.controlled()).toBeNull();
    expect(s.targetParams()).toEqual({});
    expect(s.describe()).toBe('');
  });
});

/*
 * Which KIND of app is being controlled decides whether index-less typing is a
 * mistake or the only option — see the refusal in tools.ts. An app that answers
 * Accessibility has indices to pass; one that does not has nothing else.
 */
describe('visual-only control', () => {
  it('remembers that a snapshot came back with no Accessibility elements', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'Preview', pid: 31, visualOnly: true });
    expect(s.controlled()?.visualOnly).toBe(true);
  });

  it('clears the flag when control moves to an app that does answer', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'Preview', pid: 31, visualOnly: true });
    s.noteSnapshot({ app: 'Maps', pid: 32 });
    expect(s.controlled()?.visualOnly).toBe(false);
  });
});

/*
 * WHICH SURFACE WAS UP AT THE LAST LOOK.
 *
 * An index the model is about to act on was read at some earlier moment. If a
 * save sheet has opened since, that number now belongs to whatever the fresh
 * walk assigned it — possibly a control in the window BEHIND the sheet. The
 * state machine's job here is only to remember the surface; tools.ts compares.
 */
describe('the dialog that was open at the last look', () => {
  it('remembers a modal surface, and forgets it once it is gone', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'TextEdit', pid: 42, dialogKey: '7|Save|AXSheet' });
    expect(s.controlled()?.dialogKey).toBe('7|Save|AXSheet');
    // A look with no dialog must OVERWRITE, or a dismissed sheet blocks retries
    // forever.
    s.noteSnapshot({ app: 'TextEdit', pid: 42 });
    expect(s.controlled()?.dialogKey).toBe('');
  });

  it('does not carry one app’s dialog over to another', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'TextEdit', pid: 42, dialogKey: '7|Save|AXSheet' });
    s.noteSnapshot({ app: 'Maps', pid: 43 });
    expect(s.controlled()?.dialogKey).toBe('');
  });
});

describe('a coordinate that hit nothing', () => {
  /*
   * A coordinate click answered "Clicked at (380, 450)." whatever happened, so a
   * click on empty window read exactly like a click that worked. MEASURED: a 4B
   * holding a snapshot of Calculator's 25 named buttons clicked (380,450),
   * (430,450) and (300,450) — none of them a button — and was told each time
   * that it had clicked. Nothing in the loop could tell it otherwise.
   */
  const BUTTONS = [
    { index: 5, name: '7', role: 'AXButton', bbox: { x: 340, y: 658, w: 48, h: 48 } },
    { index: 6, name: '8', role: 'AXButton', bbox: { x: 394, y: 658, w: 48, h: 48 } },
    { index: 20, name: 'Equals', role: 'AXButton', bbox: { x: 502, y: 820, w: 48, h: 48 } },
  ];
  const withButtons = () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'Calculator', pid: 1, elements: BUTTONS });
    return s;
  };

  it('says nothing when the point is inside a control', () => {
    expect(withButtons().missAt(340, 658)).toBeNull();
    // and anywhere within its box, not just the centre
    expect(withButtons().missAt(360, 675)).toBeNull();
  });

  it('names the nearest controls when the point is on empty window', () => {
    const note = withButtons().missAt(380, 450);
    expect(note).toContain('NOTHING IS AT (380, 450)');
    expect(note).toContain('[5] "7"');
    expect(note).toContain('mac_snapshot');
  });

  it('stays quiet for an app that exposes nothing — coordinates are all it has', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'SomeGame', pid: 2, visualOnly: true, elements: [] });
    expect(s.missAt(10, 10)).toBeNull();
  });

  it('stays quiet before anything has been looked at', () => {
    expect(createMacSessionState().missAt(10, 10)).toBeNull();
  });

  it('keeps the controls across a look that does not re-list them', () => {
    const s = withButtons();
    s.noteSnapshot({ app: 'Calculator', pid: 1 });
    expect(s.missAt(380, 450)).toContain('NOTHING IS AT');
  });
});
