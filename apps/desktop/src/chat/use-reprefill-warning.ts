/**
 * SAY IT BEFORE IT COSTS THEM — the live half of prefill-risk.ts.
 *
 * the user: "flagged to the user to my face right there whenever anything threatens
 * to cause a full re prefill (including model switches) at over 16k context."
 *
 * "Right there" is the pill above the composer, which is already where this app
 * says "you are waiting for something". This watches the PREFIX ITSELF — model,
 * system prompt, tool list — rather than the actions that can change it, so a
 * cause nobody thought of still gets noticed. See reprefill-watch.ts for why
 * that is the shape, and prefill-risk.ts for the threshold and the wording.
 */
import { useEffect, useRef } from 'react';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { dismissPill, showPill } from './pill-store';
import { riskSentence, worthWarning } from './prefill-risk';
import { prefillSeconds } from './prefill-speed';
import { type PrefixIdentity, prefixChange, toolChangeIsCostly } from './reprefill-watch';

const PILL_ID = 'reprefill-warning';
const E2E =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E');

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
  const system = usePiStore((s) => s.extensionStatus['harness-prefill-system'] ?? '');
  const toolsJson = usePiStore((s) => s.extensionStatus['harness-prefill-tools'] ?? '');
  const streaming = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  /** The prefix the conversation on screen was actually answered against. */
  const answered = useRef<PrefixIdentity | null>(null);

  useEffect(() => {
    /*
     * A turn that just ran re-establishes the baseline: whatever prefix produced
     * it now owns this conversation's KV, warning or not. So nothing is judged
     * while one is in flight.
     */
    if (streaming) return;
    const now: PrefixIdentity = { modelId, system, toolsJson };

    // A prefix we cannot see is not a baseline. The harness publishes these
    // asynchronously; adopting "" as the truth and then noticing it "changed"
    // is a warning about the harness finishing its own startup.
    if (system.length === 0 || toolsJson.length === 0) return;

    // An empty chat has nothing to re-read; it is also where the baseline for
    // the next conversation is set.
    if (messages.length === 0) {
      answered.current = now;
      dismissPill(PILL_ID);
      return;
    }
    if (answered.current === null) {
      answered.current = now;
      return;
    }

    const tokens = conversationTokens(messages);
    const cause = prefixChange(answered.current, now);
    /* E2E only: the decision, so a probe can say WHY nothing was warned about
     * rather than guessing. Same `?piE2E=1` opt-in as the store accessors. */
    if (E2E) {
      (window as unknown as { __reprefill?: unknown }).__reprefill = {
        tokens,
        cause,
        before: answered.current,
        now,
      };
    }
    /*
     * A tool APPENDED costs the tokens after it, not the whole prompt — the
     * harness keeps the list append-only for exactly that reason — so it is not
     * worth interrupting for. Anything else that moved is.
     */
    const costly =
      cause !== null &&
      (cause !== 'tools' || toolChangeIsCostly(answered.current.toolsJson, toolsJson));

    if (!costly || !worthWarning(tokens)) {
      /*
       * DISMISS, not just "do not show". Reaching here means the prefix agrees
       * with the baseline in every way that would cost a re-read — including
       * the case where a warning was up and the thing that caused it has since
       * been put back. A warning that outlives its cause is worse than none.
       */
      dismissPill(PILL_ID);
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
        cause,
        seconds: prefillSeconds(modelId ?? '', tokens),
      }),
    });
  }, [messages, modelId, system, toolsJson, streaming]);

  /*
   * The warning is about the NEXT message. Once a turn has actually run, the
   * conversation belongs to the prefix that produced it and the pill has said
   * its piece.
   */
  useEffect(() => {
    if (!streaming) return;
    return () => {
      answered.current = {
        modelId: useLlmStore.getState().status.model?.id ?? null,
        system: usePiStore.getState().extensionStatus['harness-prefill-system'] ?? '',
        toolsJson: usePiStore.getState().extensionStatus['harness-prefill-tools'] ?? '',
      };
      dismissPill(PILL_ID);
    };
  }, [streaming]);
}
