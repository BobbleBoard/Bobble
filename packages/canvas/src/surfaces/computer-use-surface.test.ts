/**
 * What the computer-use surface SAYS.
 *
 * The picture on this surface was already good; the words were the weak half.
 * Measured over 45 seconds of the real choreography, the status the user reads
 * was `thinking 63% · pressing 13% · scrolling 11% · clicking 10% · typing 3%`
 * — two thirds of the time the only thing this tab said was a word that means
 * nothing, in a pill identical whether the model was one token from finishing
 * or stuck for four minutes. And "Clicking" never named what was being clicked
 * even when the name was in hand.
 *
 * These are pure functions precisely so that pacing is a test rather than a
 * thing somebody watches for and gives up on.
 */
import { describe, expect, it } from 'vitest';
import {
  actWords,
  type Bubble,
  bubbleText,
  dialogCaption,
  identity,
  type MonitorAct,
  thinkingAfter,
} from './computer-use-surface.tsx';

const say = (
  state: Parameters<typeof bubbleText>[0],
  text = '',
  since = 0,
  after = '',
): Bubble => bubbleText(state, text, since, after);

describe('bubbleText — naming the act', () => {
  it('names what is being clicked when the producer supplies a name', () => {
    expect(say('clicking', 'Save').label).toBe('Clicking Save');
    expect(say('clicking', 'Cancel').label).toBe('Clicking Cancel');
  });

  it('falls back to the bare verb rather than inventing a target', () => {
    expect(say('clicking').label).toBe('Clicking');
  });

  it('says what is being typed, and what key is being pressed', () => {
    expect(say('typing', 'bobble-dialog-probe')).toMatchObject({
      label: 'Typing',
      detail: 'bobble-dialog-probe',
    });
    expect(say('pressing', '⌘S').label).toBe('Pressing ⌘S');
  });

  it('never says a bare "Scrolling" with no object at all', () => {
    expect(say('scrolling').label).toBe('Scrolling the window');
    expect(say('scrolling', 'the sidebar').label).toBe('Scrolling the sidebar');
  });
});

describe('bubbleText — thinking decays, then admits', () => {
  it('says what it is thinking AFTER, for the first few seconds', () => {
    const b = say('thinking', '', 1_000, 'after clicking Save');
    expect(b.visible).toBe(true);
    expect(b.detail).toBe('after clicking Save');
    expect(b.dots).toBe(true);
  });

  it('gets out of the way rather than pulsing forever', () => {
    expect(say('thinking', '', 6_500, 'after clicking Save').visible).toBe(false);
    expect(say('thinking', '', 19_000, '').visible).toBe(false);
  });

  it('comes back to ADMIT how long it has been', () => {
    const b = say('thinking', '', 32_400, '');
    expect(b.visible).toBe(true);
    expect(b.label).toBe('Still thinking — 32s');
    // No dots: the question by then is "is this stuck", and three animated dots
    // are exactly what fails to answer it.
    expect(b.dots).toBe(false);
  });
});

describe('bubbleText — dots mean one thing', () => {
  it('gives dots ONLY to waiting on the model', () => {
    const dotted = (['thinking', 'reading', 'opening'] as const).map((s) => say(s).dots);
    expect(dotted).toEqual([true, true, true]);
  });

  it('gives an act in progress a steady mark instead', () => {
    for (const state of ['clicking', 'typing', 'pressing', 'scrolling'] as const) {
      const b = say(state, 'x');
      expect({ state, dots: b.dots, mark: b.mark }).toEqual({ state, dots: false, mark: true });
    }
  });

  it('says nothing at all when nothing is happening', () => {
    expect(say('idle')).toMatchObject({ visible: false, label: '' });
  });
});

describe('actWords', () => {
  it('splits an act into a verb and its object, for the history strip', () => {
    expect(actWords('clicking', 'Save')).toEqual({ verb: 'Click', object: 'Save' });
    expect(actWords('pressing', '⌘S')).toEqual({ verb: 'Press', object: '⌘S' });
    // The producer sends the whole sentence for a launch.
    expect(actWords('opening', 'Opening TextEdit')).toEqual({ verb: 'Open', object: 'TextEdit' });
  });
});

describe('thinkingAfter', () => {
  const act = (verb: string, object: string): MonitorAct => ({
    id: 1,
    state: 'clicking',
    verb,
    object,
    at: 0,
    endedAt: 1,
    wall: 0,
    point: null,
    rect: null,
    thumb: null,
    frame: null,
    dialog: false,
  });

  it('is the last thing that actually happened', () => {
    expect(thinkingAfter([act('Click', 'Save')])).toBe('after clicking Save');
    expect(thinkingAfter([act('Press', '⌘S')])).toBe('after pressing ⌘S');
  });

  it('is nothing at all before anything has happened', () => {
    expect(thinkingAfter([])).toBe('');
  });

  it('keeps a long object short enough to ride in a pill', () => {
    const long = thinkingAfter([act('Type', 'The quick brown fox jumps over the lazy dog')]);
    expect(long.length).toBeLessThan(40);
    expect(long.startsWith('after typing ')).toBe(true);
  });
});

describe('dialogCaption', () => {
  it('names the app and the question', () => {
    expect(dialogCaption('TextEdit', 'Save')).toBe('TextEdit is asking: Save');
  });

  it('never says "untitled" — the most common macOS sheet has no title', () => {
    // TextEdit's real save sheet measures as `title: ""`.
    expect(dialogCaption('TextEdit', '')).toBe('TextEdit is asking you something');
    expect(dialogCaption('', '')).toBe('This app is asking you something');
  });
});

describe('identity', () => {
  it('is one run of text, app first', () => {
    expect(identity('TextEdit', 'Untitled 2')).toEqual({
      text: 'TextEdit — Untitled 2',
      edited: false,
    });
  });

  it('carries "Edited" as state, not as a word hanging off the title', () => {
    expect(identity('TextEdit', 'Untitled 2 — Edited')).toEqual({
      text: 'TextEdit — Untitled 2',
      edited: true,
    });
  });

  it('survives a session with no window and no app', () => {
    expect(identity('TextEdit', '')).toEqual({ text: 'TextEdit', edited: false });
    expect(identity('', '')).toEqual({ text: '', edited: false });
  });
});
