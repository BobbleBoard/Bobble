import { describe, expect, it } from 'vitest';
import {
  HAND_REASONS,
  HandLedger,
  handAlert,
  PAUSE_TOOL_DEF,
  PauseLedger,
  pausedNote,
  RAISE_HAND_TOOL_DEF,
  type RaisedHand,
  raisedHandReply,
  reasonPhrase,
  withHandAlerts,
} from './raise-hand.js';

const hand = (over: Partial<RaisedHand> = {}): RaisedHand => ({
  from: 'engineer:1',
  reason: 'not_working',
  message: 'The browser tool returns no elements on main.html',
  ...over,
});

describe('a raised hand cannot be mistaken for finished work', () => {
  /*
   * THE POINT OF THE WHOLE MODULE. An agent in trouble used to have exactly one
   * exit — reply — and a reply is indistinguishable from a deliverable. That is
   * how a stuck engineer became, in the manager's own words, "the engineer keeps
   * replying with nothing… the tool isn't functioning properly".
   */
  it('says STOPPED, says nothing was delivered, and names who', () => {
    const reply = raisedHandReply(hand());
    expect(reply).toContain('STOPPED');
    expect(reply).toContain('engineer:1');
    expect(reply).toContain('Nothing was delivered');
    expect(reply).toContain('do not record this as done');
  });

  it('carries what was already tried, so nobody loops the agent', () => {
    const reply = raisedHandReply(hand({ tried: 'browser_snapshot twice, then chrome_snapshot' }));
    expect(reply).toContain('Already tried: browser_snapshot twice');
  });

  it('omits the tried line entirely when there is none', () => {
    expect(raisedHandReply(hand())).not.toContain('Already tried');
    expect(raisedHandReply(hand({ tried: '' }))).not.toContain('Already tried');
  });

  it('has a plain phrase for every reason the tool accepts', () => {
    // A new reason with no phrase would render as undefined in a manager's note.
    for (const r of HAND_REASONS) {
      expect(reasonPhrase(r)).toBeTruthy();
      expect(reasonPhrase(r)).not.toContain('undefined');
    }
  });

  it('advertises every reason the phrase table knows', () => {
    // The enum the model is shown and the table we format from must not drift.
    expect([...RAISE_HAND_TOOL_DEF.parameters.properties.reason.enum]).toEqual([...HAND_REASONS]);
  });
});

describe('the alert rides the next tool result', () => {
  /* The user's exact mechanism: "<tool result> + 'additional info, <subagent> is
   * stopped: <message>'" — so a hand raised while the manager was busy reaches
   * it without needing a turn of its own. */
  it('appends in the user’s stated form', () => {
    expect(handAlert([hand()])).toContain(
      'additional info, engineer:1 is stopped: The browser tool returns no elements',
    );
  });

  it('leaves a quiet tool result completely untouched', () => {
    expect(withHandAlerts('ok', [])).toBe('ok');
    expect(handAlert([])).toBe('');
  });

  it('keeps the original result intact when it does append', () => {
    const out = withHandAlerts('exit 0\nbuild succeeded', [hand()]);
    expect(out.startsWith('exit 0\nbuild succeeded')).toBe(true);
    expect(out).toContain('additional info');
  });

  it('reports several stuck agents in one note', () => {
    const out = handAlert([
      hand(),
      hand({ from: 'engineer:2', message: 'no such file: deck.json' }),
    ]);
    expect(out).toContain('engineer:1 is stopped');
    expect(out).toContain('engineer:2 is stopped');
  });
});

describe('HandLedger', () => {
  it('delivers a hand to the manager it was raised to', () => {
    const led = new HandLedger();
    led.raise('manager', hand());
    expect(led.drain('manager').map((h) => h.from)).toEqual(['engineer:1']);
  });

  it('DRAINS — an alert is delivered once, not on every result after it', () => {
    // Repeating it forever would train the manager to ignore the one line that
    // says a person is stuck.
    const led = new HandLedger();
    led.raise('manager', hand());
    expect(led.drain('manager')).toHaveLength(1);
    expect(led.drain('manager')).toHaveLength(0);
  });

  it('keeps each manager’s hands separate', () => {
    const led = new HandLedger();
    led.raise('manager', hand());
    led.raise('ceo', hand({ from: 'manager' }));
    expect(led.drain('manager').map((h) => h.from)).toEqual(['engineer:1']);
    expect(led.drain('ceo').map((h) => h.from)).toEqual(['manager']);
  });

  it('peek does NOT clear, so a status line cannot swallow an alert', () => {
    const led = new HandLedger();
    led.raise('manager', hand());
    expect(led.peek('manager')).toHaveLength(1);
    expect(led.drain('manager')).toHaveLength(1);
  });

  it('lists who still has a hand up', () => {
    const led = new HandLedger();
    led.raise('manager', hand());
    expect(led.pendingManagers()).toEqual(['manager']);
    led.drain('manager');
    expect(led.pendingManagers()).toEqual([]);
  });

  it('preserves order when one agent raises twice', () => {
    const led = new HandLedger();
    led.raise('manager', hand({ message: 'first' }));
    led.raise('manager', hand({ message: 'second' }));
    expect(led.drain('manager').map((h) => h.message)).toEqual(['first', 'second']);
  });
});

/**
 * THE MANAGER'S SIDE OF WAITING.
 *
 * The user: "maybe have the manager get a stop subagent tool call, that will pause it
 * until the manager decides to message it again."
 *
 * A manager could hand work out and wait for it, but had no way to tell somebody
 * to STOP — so an engineer heading the wrong way either finished anyway or was
 * told nothing, and a 4B told nothing keeps going. It is also how a manager frees
 * the machine: one model, so four "working" engineers are four turns queued on one
 * slot.
 */
describe('pause_subagent', () => {
  it('takes who to pause, and only that is required', () => {
    expect(PAUSE_TOOL_DEF.parameters.required).toEqual(['agent']);
    expect(PAUSE_TOOL_DEF.parameters.properties).toHaveProperty('why');
  });

  /* It must not read as firing somebody, or a 4B will hoard work rather than
   * stand anyone down. */
  it('says plainly that nothing is lost and a message resumes them', () => {
    const d = PAUSE_TOOL_DEF.description;
    expect(d).toMatch(/nothing is lost/i);
    expect(d).toMatch(/until you message them again/);
    expect(d).toMatch(/not firing anybody/i);
  });

  /* The consequence of NOT using it is the thing the wait tool forgot to say. */
  it('tells the manager when it is the right move', () => {
    expect(PAUSE_TOOL_DEF.description).toMatch(/heading the wrong way/);
    expect(PAUSE_TOOL_DEF.description).toMatch(/machine free/);
  });
});

describe('PauseLedger', () => {
  it('holds who is stood down, and messaging is what resumes them', () => {
    const l = new PauseLedger();
    l.pause('engineer:2');
    expect(l.isPaused('engineer:2')).toBe(true);
    expect(l.isPaused('engineer:1')).toBe(false);
    l.resume('engineer:2');
    expect(l.isPaused('engineer:2')).toBe(false);
  });

  it('lists them stably, so a status line does not reshuffle', () => {
    const l = new PauseLedger();
    l.pause('engineer:3');
    l.pause('engineer:1');
    expect(l.list()).toEqual(['engineer:1', 'engineer:3']);
  });

  it('pausing twice is not two pauses', () => {
    const l = new PauseLedger();
    l.pause('engineer:1');
    l.pause('engineer:1');
    l.resume('engineer:1');
    expect(l.isPaused('engineer:1')).toBe(false);
  });
});

describe('pausedNote', () => {
  it('carries the reason back when there is one', () => {
    expect(pausedNote('engineer:2', 'UI is not needed yet')).toContain('UI is not needed yet');
  });

  it('still reads properly with no reason given', () => {
    const note = pausedNote('engineer:2');
    expect(note).toContain('engineer:2 is standing by');
    expect(note).not.toContain('()');
  });

  /* Whoever reads it must know the work survived. */
  it('always says the work is kept', () => {
    for (const n of [pausedNote('e:1'), pausedNote('e:1', 'x')]) {
      expect(n).toMatch(/keeps everything it has done/);
    }
  });
});
