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

/**
 * A SMALL RING OF WHAT THIS HOOK ACTUALLY DID, on `window.__prefill_log`.
 *
 * Everything here happens between a keystroke and a network call in another
 * process, and the only externally visible effect is a number on llama-server's
 * slot — which is the same number for "we primed the wrong prefix", "we primed
 * nothing", and "we primed and something else overwrote it". Those three want
 * completely different fixes. Fifty bounded entries is a rounding error next to
 * a chat transcript, and it turns that guess into a reading.
 */
function note(entry: Record<string, unknown>): void {
  const w = window as Window & { __prefill_log?: Record<string, unknown>[] };
  if (w.__prefill_log === undefined) w.__prefill_log = [];
  const log = w.__prefill_log;
  log.push({ at: Date.now(), ...entry });
  if (log.length > 50) log.shift();
}
/** Small debounce to coalesce a multi-file drop into one prefill. */
const PREFILL_DEBOUNCE_MS = 200;

/** What a prime in flight is priming: the fixed prefix and the history it saw. */
export interface PrimingNow {
  readonly prefix: string;
  readonly turns: number;
  /** Identity of the request that wrote this, so a superseded one cannot clear it. */
  readonly ticket?: object;
}

/**
 * SHOULD DISPATCHING THIS TURN CANCEL THE PRIME THAT IS RUNNING?
 *
 * Only when the prime is not part of this turn. A prime renders
 * `[system, …history, {user: attachment}]` and the turn renders
 * `[system, …history, {user: attachment + what you typed}]`, so a prime for the
 * same attachment and the same history is a BYTE-EXACT PREFIX of the turn: every
 * token it is still reading is a token the turn would otherwise read itself.
 * Cancelling that either changes nothing or — if the server drops the partial KV
 * — makes the whole prefix be read again from zero.
 *
 * the user's rule is about exactly this: "if the user puts in an attachment that
 * takes 20 seconds to prefill and then types for 10s, then sends, they should be
 * waiting 10 seconds for the attachment + however much else they typed, and no
 * more." Ten seconds of remaining prime is the honest price; twenty is what a
 * cancel risks charging.
 *
 * A prime for something else — an attachment removed inside the debounce window,
 * or one rendered against a different conversation — really is competing for the
 * single slot, and goes. Pure.
 */
export function abortsOnSend(
  priming: PrimingNow | null,
  sending: { readonly body: string } | undefined,
  turnsNow: number,
): boolean {
  if (priming === null) return true;
  if (sending === undefined) return true;
  if (priming.turns !== turnsNow) return true;
  return !sending.body.startsWith(priming.prefix);
}

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
 * real turn — see there for why it usually does NOT abort.
 */
export function useAttachmentPrefill(attachmentPrefix: string): {
  /**
   * Called the instant a turn is dispatched. Pass the message body that is being
   * sent and an in-flight prime that the turn BEGINS WITH is left alone — see
   * the note on the implementation.
   */
  abortPrefill: (sending?: { readonly body: string }) => void;
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
  /*
   * SOMEONE ELSE TOUCHED THE SLOT.
   *
   * The harness bumps this whenever one of its own background calls lands on
   * the model server — the startup warm-up, post-turn naming, the reviewer.
   * They all overwrite the single KV sequence, so whatever we primed before one
   * of them is simply gone, and the send that follows pays full price for a
   * prime that had already finished (MEASURED at app open: 5542 of 15261 tokens
   * re-read after a completed prime). Treating a bump like any other change to
   * the prefix puts our prompt back on the slot, and costs nothing when it was
   * still there — a re-prime of an unchanged prefix is a complete cache hit.
   */
  const slotEpoch = usePiStore((s) => s.extensionStatus['harness-slot-epoch'] ?? '');
  const serverRunning = useLlmStore((s) => s.status.serverRunning);
  /** The rate is a property of the MODEL as much as the machine, so it is
   * recorded per model — see prefill-speed.ts. */
  const modelId = useLlmStore((s) => s.status.model?.id ?? null);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const lastSig = useRef<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  /**
   * WHAT THE IN-FLIGHT PRIME IS PRIMING — the exact attachment prefix and the
   * number of history turns it rendered — so a send can ask "does the turn I am
   * dispatching begin with this?" and answer it exactly rather than assuming.
   */
  const priming = useRef<PrimingNow | null>(null);
  /** The live history length, for that same question. */
  const turnsNow = useRef(0);

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

  /* The rule lives in `abortsOnSend` above — read it before changing this. */
  const abortPrefill = useCallback((sending?: { readonly body: string }) => {
    const keep = !abortsOnSend(priming.current, sending, turnsNow.current);
    lastSig.current = null;
    note({ what: keep ? 'kept-on-send' : 'aborted-on-send', had: priming.current !== null });
    if (keep) return;
    setInFlight(false);
    priming.current = null;
    void window.piDesktop.invoke('pi:prefill-abort', undefined).catch(() => {});
  }, []);

  useEffect(() => {
    const prefix = attachmentPrefix.trim();
    const history = historyAsMessages(messages);
    turnsNow.current = history.length;
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
    if (!decision.prime) {
      note({ what: 'skipped', because: decision.because, prefixChars: prefix.length });
      return;
    }

    // Cheap dedupe key (avoid stringifying the whole prefix each render).
    const sig = `${focusEpoch}|${slotEpoch}|${history.length}|${prefix.length}|${prefix.slice(0, 96)}`;
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
      /*
       * A TOKEN, so a prime that has already been superseded cannot clear the
       * record belonging to the one that replaced it.
       *
       * MEASURED on a chat switch: two primes in a row, each logging
       * `aborted: true` within five milliseconds, and the send that followed
       * took 2.4s against a prefix that should have been resident. A superseded
       * prime's `finally` runs LAST, after its replacement has already written
       * its own record — so it nulled a live prime, and the send then read
       * `priming.current === null` and cancelled work that was about to serve it.
       */
      const ticket = {} as const;
      priming.current = { prefix: attachmentPrefix, turns: history.length, ticket };
      note({
        what: 'prime',
        slotEpoch,
        prefixChars: prefix.length,
        historyTurns: history.length,
        withUser: oaiMessages.length > 1 + history.length,
        tools: decision.tools.length,
      });
      void window.piDesktop
        .invoke('pi:prefill', { messages: oaiMessages, tools: decision.tools })
        .then((res) => {
          note({ what: 'primed', ...(res as Record<string, unknown>) });
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
        .catch((error: unknown) => {
          // Non-fatal: the send path still works, it just pays the full prefill.
          note({ what: 'failed', error: String(error) });
        })
        .finally(() => {
          if (priming.current?.ticket !== ticket) return; // superseded — not ours to clear
          priming.current = null;
          setInFlight(false);
        });
    }, PREFILL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    attachmentPrefix,
    system,
    toolsJson,
    serverRunning,
    busy,
    messages,
    focusEpoch,
    slotEpoch,
    modelId,
  ]);

  return { abortPrefill, inFlight };
}
