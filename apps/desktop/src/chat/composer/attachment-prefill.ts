/**
 * Turn prefill — prime the model's KV with everything about the next turn that
 * is ALREADY FIXED, so that pressing enter only ever prefills what you typed.
 *
 * Two things are fixed before you finish typing: the conversation so far (the
 * moment you open a chat) and any attachment (the moment you add it). The user:
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
import type { ContentBlock } from '@pi-desktop/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../../state/llm-store';
import { usePiStore } from '../../state/pi-slice';
import { prefillSeconds, recordPrefillRate } from '../prefill-speed';
import { PREFILL_MIN_CHARS, prefillDecision } from './prefill-gate';

/* Re-exported from its owner (the pure gate) so the existing import sites do
 * not have to care where the number lives. */
export { PREFILL_MIN_CHARS };

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
 * The user's rule is about exactly this: "if the user puts in an attachment that
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

/**
 * The live transcript as the OpenAI messages the turn itself will send.
 *
 * `agentText`, NOT `text`, for a user turn — and this one was expensive. `text`
 * is the ECHO, what the bubble shows; `agentText` is pi's copy, with any pasted
 * block or dropped file folded back in. A conversation containing one paste
 * therefore rendered here MISSING that paste, so the primed prompt diverged from
 * the real one at the first attachment — and because the slot holds a single
 * sequence, priming it EVICTED the correct prefix. MEASURED on a transcript with
 * a 3.2k-token paste in it: the following turn re-read 6,896 tokens, roughly the
 * paste twice over, on a conversation the server had entirely cached a moment
 * earlier. Long conversations are exactly the ones with pastes and files in
 * them, which is why this showed up as "every follow-up re-prefills".
 *
 * THE SAME LESSON, ONE LAYER DOWN (2026-09-13): an assistant turn carried as
 * bare text is not the turn either. The provider sends its thoughts as
 * `reasoning_content`, its tool calls as `tool_calls`, and each result as a
 * `tool` message; with preserved thinking the template renders every one of
 * them, so a prime without them rendered an EMPTY think block where the turn
 * had its thoughts and rewrote the slot from the first reply on. MEASURED
 * (prompt tap + llama.cpp's own cache_n): the second turn of every chat
 * re-read its first reply, ~160 tokens, and a tool-using chat was never primed
 * at all. Nothing is trimmed: the bytes must be the provider's bytes.
 */
export function historyAsMessages(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.kind === 'user') {
      const text = m.agentText ?? m.text;
      if (text.trim().length > 0) out.push({ role: 'user', content: text });
    } else if (m.kind === 'assistant') {
      const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const reasoning = m.blocks.map((b) => (b.type === 'thinking' ? b.thinking : '')).join('');
      const toolCalls = m.blocks
        .filter(
          (b): b is Extract<ContentBlock, { type: 'toolCall' }> =>
            b.type === 'toolCall' && b.name.length > 0,
        )
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.arguments) },
        }));
      if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.kind === 'toolResult') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        name: m.toolName,
        content: m.text,
      });
    }
  }
  return out;
}

/**
 * The harness's published wire copy of the conversation, when it describes the
 * transcript on screen: its last assistant reply must be the transcript's last
 * assistant reply (a chat switch, or a turn that ended without a request,
 * would otherwise prime another conversation's bytes). Null → render locally.
 */
export function residentHistory(
  json: string | undefined,
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): Array<Record<string, unknown>> | null {
  if (json === undefined || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const wire = parsed as Array<Record<string, unknown>>;
  if (wire[0]?.role !== 'system') return null;
  const lastWire = [...wire].reverse().find((m) => m.role === 'assistant');
  const lastLocal = [...messages].reverse().find((m) => m.kind === 'assistant');
  if (lastWire === undefined || lastLocal === undefined || lastLocal.kind !== 'assistant') {
    return null;
  }
  const localText = lastLocal.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const wireText = typeof lastWire.content === 'string' ? lastWire.content : '';
  if (localText !== wireText) return null;
  // No turn may be in flight (a streaming reply is not on the wire yet).
  if (lastLocal.isStreaming === true) return null;
  return wire;
}

/**
 * Is this transcript one we can render EXACTLY as the turn will?
 *
 * The gate's rule is both halves of the prefix or neither, and it applies to the
 * conversation as much as to the tools. A turn that carried an image puts the
 * image in the model's copy as an `image_url` part (and a tool that returned one
 * adds a user turn for it) — neither survives the text rendering above, so a
 * prime built over such a history is not an approximation of the real prompt:
 * it is a different prompt, and writing it to the slot costs the whole
 * conversation. Tool calls and results DO render exactly now (see
 * historyAsMessages), so a tool-using chat is primed like any other.
 *
 * The old comment here said this "degrades gracefully on tool/image turns". It
 * does not degrade. It evicts.
 */
export function historyIsRenderable(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): boolean {
  for (const m of messages) {
    if (m.kind === 'user') {
      if ((m.images ?? []).length > 0) return false;
    } else if (m.kind === 'assistant') {
      for (const b of m.blocks ?? []) {
        if (b.type !== 'text' && b.type !== 'thinking' && b.type !== 'toolCall') return false;
        // A call still streaming its arguments has nothing exact to render.
        if (b.type === 'toolCall' && b.name.length === 0) return false;
      }
    } else if (m.kind === 'toolResult') {
      // `[image returned by …]` becomes an extra user turn in the provider.
      if (/^\[image returned by /.test(m.text)) return false;
    }
  }
  return true;
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
  /**
   * Roughly how long the prime in flight will take on this machine, from the
   * measured rate for this model, or null before the rate is known.
   *
   * The user's rule for the pill is that its ABSENCE is a promise: "if that pill
   * disappears, that means the entire conversation up to the point I have
   * started typing and sent in that turn is already prefilled". A fixed delay
   * before showing breaks that promise for exactly the primes worth knowing
   * about, so the wait announces itself immediately when it is long enough to
   * be felt, and stays quiet when it is not — because a prime nobody can
   * perceive is not a wait the promise is about.
   */
  estimatedMs: number | null;
} {
  /*
   * IT IS NOT ONLY ATTACHMENTS ANY MORE — see the note at the top of the
   * `useEffect` below.
   */
  const messages = usePiStore((s) => s.messages);
  const system = usePiStore((s) => s.extensionStatus['harness-prefill-system']);
  const toolsJson = usePiStore((s) => s.extensionStatus['harness-prefill-tools']);
  /*
   * THE CONVERSATION AS IT WENT OVER THE WIRE, published by the harness at the
   * end of every turn (the last request's messages + the reply, in the
   * provider's shape). It is what the slot holds. The transcript rendering
   * below is the fallback for a chat that has not had a turn yet: it cannot
   * see a hidden custom message (pi's workspace note) or a canvas block, and a
   * prime built without them rewrote the slot from the first user message on —
   * MEASURED 2026-09-13, the second message of every chat re-read the reply.
   */
  const residentJson = usePiStore((s) => s.extensionStatus['harness-prefill-history']);
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
  /** Unloaded (idle-unload.ts, or making room): nothing to prime until it is
   * back — and coming back must re-prime, so it is in the signature below. */
  const parked = useLlmStore((s) => s.status.parked !== undefined);
  /** The rate is a property of the MODEL as much as the machine, so it is
   * recorded per model — see prefill-speed.ts. */
  const modelId = useLlmStore((s) => s.status.model?.id ?? null);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const lastSig = useRef<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [estimatedMs, setEstimatedMs] = useState<number | null>(null);
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
   * The user: "TTFT is unacceptable, I was idle for like an hour, left this in the
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
    const resident = residentHistory(residentJson, messages);
    const history = resident ?? historyAsMessages(messages);
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
    if (resident === null && !historyIsRenderable(messages)) {
      note({ what: 'skipped', because: 'the transcript has a turn we cannot render exactly' });
      return;
    }
    const decision = prefillDecision({
      system,
      toolsJson,
      serverRunning,
      parked,
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
    const sig = `${focusEpoch}|${slotEpoch}|${parked ? 'p' : 'u'}|${resident === null ? 't' : 'w'}${history.length}|${prefix.length}|${prefix.slice(0, 96)}`;
    if (sig === lastSig.current) return;

    const timer = window.setTimeout(() => {
      lastSig.current = sig;
      const oaiMessages: Array<Record<string, unknown>> = [
        // The wire copy carries its own system message; the rendering does not.
        ...(resident !== null ? [] : [{ role: 'system', content: system }]),
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
      // ~4 chars a token is close enough to decide "will anyone notice this",
      // and the rate is measured rather than assumed (prefill-speed.ts).
      const seconds = prefillSeconds(modelId ?? '', Math.round(prefix.length / 4));
      setEstimatedMs(seconds === null ? null : Math.round(seconds * 1000));
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
          // A refusal is not a prime: it logged "primed" on every MLX engine
          // while nothing was read (prefill-completion's chat fallback).
          const ok = (res as { success?: boolean } | undefined)?.success !== false;
          note({ what: ok ? 'primed' : 'prime-failed', ...(res as Record<string, unknown>) });
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
    residentJson,
    serverRunning,
    parked,
    busy,
    messages,
    focusEpoch,
    slotEpoch,
    modelId,
  ]);

  return { abortPrefill, inFlight, estimatedMs };
}
