/**
 * c1: an unattended run must not be able to send anything outward.
 *
 * Reading the user's mail to summarise it is the feature. Sending a message on
 * their behalf while they are asleep is not, and no prompt wording is a
 * guarantee against it.
 */
import { describe, expect, it } from 'vitest';
import { FORBID_TOOLS_ENV, forbiddenReason, forbiddenTools } from './forbidden.js';

describe('forbiddenTools', () => {
  it('forbids nothing by default — this is opt-in, per run', () => {
    expect(forbiddenTools({}).size).toBe(0);
    expect(forbiddenTools({ [FORBID_TOOLS_ENV]: '' }).size).toBe(0);
    expect(forbiddenTools({ [FORBID_TOOLS_ENV]: '   ' }).size).toBe(0);
  });

  it('reads a comma-separated list, tolerating spacing', () => {
    const set = forbiddenTools({ [FORBID_TOOLS_ENV]: 'messages_send, mail_send ,, bash' });
    expect([...set].sort()).toEqual(['bash', 'mail_send', 'messages_send']);
  });
});

describe('forbiddenReason', () => {
  it('points at what the model CAN do, not just the closed door', () => {
    // A model told only "no" tries the same thing another way, which is how a
    // refusal becomes a loop. The useful half here is "draft, do not send".
    const reason = forbiddenReason('messages_send');
    expect(reason).toMatch(/draft/i);
    expect(reason).toMatch(/unattended/i);
  });

  it('still says something specific for anything else', () => {
    expect(forbiddenReason('some_tool')).toContain('some_tool');
  });
});
