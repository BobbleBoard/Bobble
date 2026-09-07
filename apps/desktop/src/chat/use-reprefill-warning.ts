/**
 * SAY IT BEFORE IT COSTS THEM — the live half of prefill-risk.ts.
 *
 * the user: "flagged to the user to my face right there whenever anything threatens
 * to cause a full re prefill (including model switches) at over 16k context."
 *
 * "Right there" is the pill above the composer, which is already where this app
 * says "you are waiting for something". This watches the two facts that decide
 * it — which model the conversation was last answered by, and how big the
 * conversation is — and publishes into that slot the moment they disagree.
 *
 * WHY IT WATCHES STATE RATHER THAN HOOKING THE SWITCH. A model can change from
 * the quick menu, the model hub, a tier pick, auto-routing, or a restart after a
 * crash. Hooking each one means five places to remember; comparing the model
 * that ANSWERED against the model that is loaded catches all of them, including
 * the ones added later.
 */
import { useEffect, useRef } from 'react';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { dismissPill, showPill } from './pill-store';
import { riskSentence, worthWarning } from './prefill-risk';
import { prefillSeconds } from './prefill-speed';

const PILL_ID = 'reprefill-warning';

/** How many prompt tokens the conversation last cost, per the engine's usage. */
export function conversationTokens(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === 'assistant' && m.usage !== undefined) return m.usage.input ?? 0;
  }
  return 0;
}

export function useRePrefillWarning(): void {
  const messages = usePiStore((s) => s.messages);
  const modelId = useLlmStore((s) => s.status.model?.id ?? null);
  const streaming = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  /** The model the conversation on screen was actually answered by. */
  const answeredBy = useRef<string | null>(null);

  useEffect(() => {
    /*
     * A turn that just ran re-establishes the baseline: whatever model produced
     * it now owns this conversation's KV, warning or not. Recorded on the way
     * OUT of streaming so a switch made mid-turn is still noticed.
     */
    if (streaming) return;
    if (messages.length === 0) {
      answeredBy.current = modelId;
      dismissPill(PILL_ID);
      return;
    }
    if (answeredBy.current === null) {
      answeredBy.current = modelId;
      return;
    }
    const tokens = conversationTokens(messages);
    const changed = modelId !== null && modelId !== answeredBy.current;
    if (!changed || !worthWarning(tokens)) {
      if (!changed) dismissPill(PILL_ID);
      return;
    }
    showPill({
      id: PILL_ID,
      tone: 'warn',
      // Not a spinner: nothing is happening yet. That is the point — this is a
      // warning about the next message, not a report on this one.
      priority: 80,
      text: riskSentence({
        tokens,
        cause: 'model-switch',
        seconds: prefillSeconds(modelId ?? '', tokens),
      }),
    });
  }, [messages, modelId, streaming]);

  /*
   * The warning is about the NEXT message. Once a turn has actually run, the
   * conversation belongs to whichever model produced it and the pill has said
   * its piece — so the baseline moves and the pill goes.
   */
  useEffect(() => {
    if (!streaming) return;
    // A turn started under the new model: it is paying the cost right now, and
    // when it lands the model that answered is the one that is loaded.
    return () => {
      answeredBy.current = useLlmStore.getState().status.model?.id ?? answeredBy.current;
      dismissPill(PILL_ID);
    };
  }, [streaming]);
}
