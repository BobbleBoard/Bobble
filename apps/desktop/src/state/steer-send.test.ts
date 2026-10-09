import { describe, expect, it } from 'vitest';
import { deliveryForSend } from './pi-connect';

/**
 * A MID-RUN MESSAGE HAS TO REACH THE MODEL AT THE NEXT TOOL ROUND.
 *
 * The user: "I attempted to ask a follow up/steering prompt in the middle of the
 * action which I assumed would be properly queued greyed out sent, and then at
 * the next tool result, my prompt would be passed along and the following
 * thinking block would address my prompt as it would be in context then. however
 * that was wrong, currently it completely breaks showing a different processing
 * spinner that never clears and leaving it in the conversation in the ui someplace
 * where it was never actually put in context."
 *
 * Two separate defects, one per assertion below.
 *
 * (1) It was dispatched as a FOLLOW-UP. pi drains follow-ups only after the agent
 *     loop would have exited; steering messages are drained at every `turn_end`.
 *     The run in question was then ABORTED by the loop detector, and an aborted
 *     run drops its follow-up queue unread — which is why his text is absent from
 *     the entire 1.4MB session transcript.
 *
 * (2) `promptInFlight` was raised and nothing was left to lower it. It exists to
 *     bridge dispatch→`agent_start` for a NEW run; a message joining a run that
 *     already started never sees another `agent_start`.
 *
 * These assert the DECISION, which is all a unit test can honestly reach. That the
 * steer actually lands in the model's context at the next tool round is proved by
 * tests/e2e/steer-probe.mjs against a real model, not here.
 */
describe('deliveryForSend', () => {
  it('steers when a turn is already running, so it lands at the next tool round', () => {
    expect(deliveryForSend(true).body).toEqual({ streamingBehavior: 'steer' });
  });

  /* Not 'followUp': that queue is read only after the whole run, and is dropped
   * entirely if the run aborts first. */
  it('never uses the follow-up queue, which an aborted run throws away', () => {
    expect(deliveryForSend(true).body.streamingBehavior).not.toBe('followUp');
  });

  it('leaves an idle send alone — pi rejects a streamingBehavior it did not ask for', () => {
    expect(deliveryForSend(false).body).toEqual({});
  });

  /* The spinner that never cleared. */
  it('makes the dispatch responsible for lowering the in-flight bridge when steering', () => {
    expect(deliveryForSend(true).clearsInFlight).toBe(true);
  });

  it('leaves an idle send to be cleared by agent_start, as before', () => {
    expect(deliveryForSend(false).clearsInFlight).toBe(false);
  });
});
