/**
 * Turn prefill — prime the model's KV with everything about the next turn that
 * is ALREADY FIXED, so that pressing enter only ever prefills what you typed.
 *
 * Two things are fixed before you finish typing: the conversation so far (the
 * moment you open a chat) and any attachment (the moment you add it). the user:
 * "when I go to an existing chat and take some time, while I'm writing my prompt
 * or waiting or whatever, it's getting loaded … so no time after pressing send
 * is wasted on that stuff."
 *
 * It began as attachment-only, which is why it is still named for that; the
 * history was the bigger half all along. There is nothing predictive here: the attachment is known and fixed
 * as soon as it's added; this just moves its (seconds-long) prompt processing off
 * the send path — MEASURED ~3747ms → ~290ms for a ~5k-token paste, holding across
 * the idle while the user finishes typing.
 *
 * It sends `[system, ...history, {user: <attachment prefix>}]` (+ the turn's
 * tools) to `pi:prefill`, which renders that exact prompt, TRUNCATES it right
 * after the attachment (so it's a true, unclosed prefix of the real turn's
 * prompt), and primes it over the raw `/completion` endpoint — see
 * @pi-desktop/provider-llamacpp/prefill for why the closed /chat/completions
 * shape only reuses partially. System + tools come from the harness (published
 * over `harness-prefill-*`); the attachment prefix is the exact `buildAgentMessage`
 * output for the text attachments alone, so the real turn's user message begins
 * with it byte-for-byte.
 *
 * Text only: images are excluded (the vision encode re-runs per request on the
 * pinned llama.cpp build, so priming one buys no send-latency). Fires only when
 * the attachment prefix actually changes (add/remove), never per keystroke; only
 * one prefill in flight per window (the main handler supersedes); never while a
 * turn streams; aborted the instant a turn is dispatched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../../state/llm-store';
import { usePiStore } from '../../state/pi-slice';
import { recordPrefillRate } from '../prefill-speed';
import { prefillDecision } from './prefill-gate';

/** Below this many chars an attachment isn't worth priming — its send already
 * prefills near-instantly against the warm [system][tools]. */
export const PREFILL_MIN_CHARS = 400;
/** Small debounce to coalesce a multi-file drop into one prefill. */
const PREFILL_DEBOUNCE_MS = 200;

/** The live transcript as plain-text OpenAI messages (thinking / tool / image
 * blocks dropped — a text-only approximation that fully matches a plain chat and
 * degrades gracefully on tool/image turns). */
function historyAsMessages(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.kind === 'user') {
      const text = m.text.trim();
      if (text.length > 0) out.push({ role: 'user', content: text });
    } else if (m.kind === 'assistant') {
      const text = m.blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (text.length > 0) out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

/**
 * Wire attachment prefill for the given fixed attachment prefix (the exact
 * `buildAgentMessage('', textAttachments)` that will START the sent message).
 * Returns `abortPrefill`, which the composer calls the instant it dispatches a
 * real turn so the send never queues behind an in-flight prefill on the single
 * slot.
 */
export function useAttachmentPrefill(attachmentPrefix: string): {
  abortPrefill: () => void;
  /** A prime is in flight — the attachment chips show a spinner where the token
   * count goes, so "is it still working on this?" is answerable by looking. */
  inFlight: boolean;
} {
  /*
   * IT IS NOT ONLY ATTACHMENTS ANY MORE — see the note at the top of the
   * `useEffect` below.
   */
  const messages = usePiStore((s) => s.messages);
  const system = usePiStore((s) => s.extensionStatus['harness-prefill-system']);
  const toolsJson = usePiStore((s) => s.extensionStatus['harness-prefill-tools']);
  const serverRunning = useLlmStore((s) => s.status.serverRunning);
  /** The rate is a property of the MODEL as much as the machine, so it is
   * recorded per model — see prefill-speed.ts. */
  const modelId = useLlmStore((s) => s.status.model?.id ?? null);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const lastSig = useRef<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  /*
   * COMING BACK TO THE WINDOW RE-PRIMES.
   *
   * the user: "TTFT is unacceptable, I was idle for like an hour, left this in the
   * background, and it took on a blank conversation and another essentially
   * blank one almost 10 seconds each to respond."
   *
   * A probe that idles two minutes keeps 100% prefix reuse, so this is not a
   * timer we own — over a longer background stretch the OS reclaims what it
   * likes, and the first message afterwards pays a full cold prefill of the
   * whole system prompt. We cannot stop that from the renderer.
   *
   * What we CAN do is move it off the critical path, which is the same trick
   * that works at app open: prime again the moment the window comes back, while
   * the user is still reading the screen, so the cost lands before they type
   * rather than after they press enter. If the prefix WAS still resident it
   * costs a couple of hundred milliseconds and changes nothing.
   *
   * A counter rather than a boolean because the signature below has to change
   * for the effect to act — the conversation is identical, which is the whole
   * point.
   */
  const [focusEpoch, setFocusEpoch] = useState(0);
  useEffect(() => {
    const bump = () => {
      if (document.visibilityState === 'visible') setFocusEpoch((n) => n + 1);
    };
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);

  const abortPrefill = useCallback(() => {
    lastSig.current = null;
    setInFlight(false);
    void window.piDesktop.invoke('pi:prefill-abort', undefined).catch(() => {});
  }, []);

  useEffect(() => {
    const prefix = attachmentPrefix.trim();
    const history = historyAsMessages(messages);
    /*
     * THE DECISION IS NOT MADE HERE — see prefill-gate.ts, and read its header
     * before changing anything about it. The short version: the slot holds ONE
     * sequence, so priming a prefix the turn does not begin with does not merely
     * fail to help, it evicts the prefix that WOULD have been reused. Measured
     * cost of getting that wrong once: a fully-resident 9,750-token chat came
     * back `reused 20`, a complete re-read, because the prime rendered without
     * the tool list the turn would carry.
     */
    const decision = prefillDecision({
      system,
      toolsJson,
      serverRunning,
      busy,
      prefixChars: prefix.length,
      historyTurns: history.length,
      focusEpoch,
      minPrefixChars: PREFILL_MIN_CHARS,
    });
    if (!decision.prime) return;

    // Cheap dedupe key (avoid stringifying the whole prefix each render).
    const sig = `${focusEpoch}|${history.length}|${prefix.length}|${prefix.slice(0, 96)}`;
    if (sig === lastSig.current) return;

    const timer = window.setTimeout(() => {
      lastSig.current = sig;
      const oaiMessages: Array<Record<string, unknown>> = [
        { role: 'system', content: system },
        ...history,
        // Only when there IS one. An empty user turn would render as an empty
        // `<|im_start|>user` block that the real turn does not begin with, so
        // the primed prefix would stop being a prefix of it.
        ...(prefix.length >= PREFILL_MIN_CHARS
          ? [{ role: 'user', content: attachmentPrefix }]
          : []),
      ];
      /*
       * WHAT THIS ACTUALLY PRIMES, MEASURED on a 40-turn chat: 9,578 tokens,
       * where before this widening it primed ZERO — the hook only ever fired for
       * an attachment over 400 characters, so opening an old conversation primed
       * nothing at all.
       *
       * Worth recording how that was nearly missed: a probe that spied on
       * `window.piDesktop.invoke` saw no calls and looked like proof the effect
       * was dead. contextBridge objects are FROZEN, so the spy silently never
       * installed and the assignment did nothing. The instrumentation had to go
       * inside this module to see the truth.
       */
      setInFlight(true);
      void window.piDesktop
        .invoke('pi:prefill', { messages: oaiMessages, tools: decision.tools })
        .then((res) => {
          /*
           * EVERY PREFILL IS ALSO A MEASUREMENT of how fast this machine reads a
           * prompt under this model — which is the only honest basis for telling
           * the user that a model switch will cost them eighteen seconds. Free:
           * the server reports it on the response we were already waiting for.
           */
          if (res?.processedN !== undefined && res.processedMs !== undefined) {
            recordPrefillRate(modelId ?? '', res.processedN, res.processedMs);
          }
        })
        .catch(() => {
          // Non-fatal: the send path still works, it just pays the full prefill.
        })
        .finally(() => setInFlight(false));
    }, PREFILL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [attachmentPrefix, system, toolsJson, serverRunning, busy, messages, focusEpoch, modelId]);

  return { abortPrefill, inFlight };
}
