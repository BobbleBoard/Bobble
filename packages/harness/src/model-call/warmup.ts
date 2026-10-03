/**
 * Preemptive model warm-up (the user: "if possible preemptively prefill the system
 * prompt before the user even sends the first message upon their model
 * selection").
 *
 * The first completion a freshly-loaded llama-server serves pays one-time costs
 * the user shouldn't have to wait through on their first message: Metal kernel
 * compilation, KV-slot allocation, and prefilling the whole (unchanging) system
 * prompt. So the moment a model is selected we fire ONE tiny (1-token) completion
 * carrying just the system prompt down the SAME local endpoint the chat uses
 * (the utility base URL = the local llama-server). That primes the server and
 * seeds its KV cache with the system-prompt prefix, so the real turn-1 prefill
 * reuses it and first-token latency drops toward a warm follow-up's.
 *
 * Fire-and-forget by contract: it NEVER throws and NEVER blocks a turn. If the
 * server isn't up yet (or the request aborts) it simply returns false — the
 * existing turn-1 classify+title piggyback, which shares the same prefix, warms
 * the cache on the first real message regardless. Pure enough to unit-test with an
 * injected {@link CallModel}.
 */
import type { CallModel, CallModelRequest } from './call-model.js';

export interface WarmupOptions {
  readonly signal?: AbortSignal;
  /**
   * Tool defs to include so the warmed prefix matches a REAL turn's. CRITICAL:
   * chat templates render tools at the START of the prompt, so a system-only
   * warm-up reuses NOTHING once the real turn carries tools (measured: cache_n=0,
   * a full cold re-prefill — the "first message takes 4-5s" the user hit). Passing
   * the initial tool set makes the whole deterministic prefix (system + tools)
   * resident, so the first message only prefills its own few tokens.
   */
  readonly tools?: CallModelRequest['tools'];
  /**
   * How long to allow. Defaults to {@link WARMUP_TIMEOUT_MS}, NOT the utility
   * endpoint's ordinary timeout — see there for why.
   */
  readonly timeoutMs?: number;
}

/**
 * A warm-up may take as long as ONE COLD PREFILL, because that is exactly what
 * it is: the ~5k-token system+tools prefix this exists to make resident.
 *
 * MEASURED, and the reason this constant exists: the utility endpoint's default
 * timeout is 5s — sized for the short helper calls it was built for — and a cold
 * prefill of this prompt takes ~4s plus request overhead. So every warm-up was
 * ABORTED at 5003ms and primed nothing, silently, because the result is
 * deliberately swallowed. Two separate earlier fixes (making it run at all, and
 * matching the tool set) were both correct and both invisible behind this.
 *
 * Nothing waits on it, so a generous budget costs nothing: it is fire-and-forget
 * on a background endpoint, and finishing late is still finishing.
 */
export const WARMUP_TIMEOUT_MS = 120_000;

/**
 * Warm the local model with a 1-token completion of `systemPrompt` (+ `tools`).
 * Returns true if the warm-up call completed, false if it was skipped (empty
 * prompt) or failed (swallowed). Callers should NOT await this on the critical
 * path — fire it and move on.
 */
export async function warmSystemPrompt(
  callModel: CallModel,
  systemPrompt: string,
  opts: WarmupOptions = {},
): Promise<boolean> {
  const sys = systemPrompt.trim();
  if (sys.length === 0) return false;
  try {
    await callModel({
      system: sys,
      // A minimal user turn so the request is well-formed; the SYSTEM (+ tools)
      // prefix is what we want resident in the KV cache (it precedes the message).
      prompt: '.',
      ...(opts.tools !== undefined && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      maxTokens: 1,
      temperature: 0,
      timeoutMs: opts.timeoutMs ?? WARMUP_TIMEOUT_MS,
      /*
       * No thinking switch of its own: the warm-up renders as the chat renders,
       * or it warms a prefix no turn will match. One token is all it generates,
       * so thinking costs nothing. MEASURED (Qwen 3.8 27B, 2026-10-02): with
       * `enable_thinking: false` its system turn wrote the tool instructions
       * without their thinking lines, and the turn after re-read the prompt.
       * Gemma 4 marks thinking at the top of the system turn — the same trap.
       */
      signal: opts.signal,
    });
    return true;
  } catch {
    // Server not ready / aborted / endpoint hiccup — non-fatal by design.
    return false;
  }
}
