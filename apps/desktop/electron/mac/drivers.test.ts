/**
 * One overlay, one monitor, one brake — and more than one session that can be
 * driving at once (a chat and its subagent, a background chat, a corp role).
 * `end` and `gone` answer "put the overlay away now?".
 */
import { describe, expect, it } from 'vitest';
import { createDriverRegistry } from './drivers';

const chatA = { name: 'chat A' };
const chatB = { name: 'subagent B' };
const idle = { name: 'a chat that never drove' };

describe('the overlay stays until the last driver ends', () => {
  it('one session ending while another still drives leaves it up', () => {
    const d = createDriverRegistry();
    d.noteRequest(chatA, 'snapshot');
    d.noteRequest(chatB, 'click');
    expect(d.end(chatA)).toBe(false);
    // …and the last one out puts it away.
    expect(d.end(chatB)).toBe(true);
  });

  it('a session that never drove, ending, does not put away another’s run', () => {
    const d = createDriverRegistry();
    d.noteRequest(chatA, 'type');
    expect(d.end(idle)).toBe(false);
  });

  it('reads, the policy and the brake are not driving', () => {
    const d = createDriverRegistry();
    for (const m of ['check', 'policy', 'brake', 'frontmost', 'setDriving'] as const) {
      d.noteRequest(idle, m);
    }
    d.noteRequest(chatA, 'key');
    expect(d.end(chatA)).toBe(true);
  });

  it('the same session driving many times is one driver', () => {
    const d = createDriverRegistry();
    d.noteRequest(chatA, 'snapshot');
    d.noteRequest(chatA, 'click');
    d.noteRequest(chatA, 'menuClick');
    expect(d.end(chatA)).toBe(true);
  });
});

describe('a session whose process died mid-run', () => {
  it('is dropped when its connection closes — and the last one out puts it away', () => {
    const d = createDriverRegistry();
    d.noteRequest(chatA, 'scroll');
    d.noteRequest(chatB, 'launch');
    expect(d.gone(chatA)).toBe(false);
    expect(d.gone(chatB)).toBe(true);
  });

  it('a connection that never drove closing changes nothing', () => {
    const d = createDriverRegistry();
    d.noteRequest(chatA, 'snapshot');
    expect(d.gone(idle)).toBe(false);
    expect(d.end(chatA)).toBe(true);
  });
});
