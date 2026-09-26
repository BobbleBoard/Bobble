/**
 * THE COMPACTION GATE — pi's auto-compaction, held to the window we run.
 *
 * A chat's pi runs pi's own compaction settings (no settings file sets them):
 * reserve 16,384 tokens, keep the last 20,000. Written for a 200k cloud
 * window, on our 32,768 they fire at HALF the window, when keeping 20,000
 * leaves almost nothing to summarise. corp/compaction-settings.ts fixed this
 * for the corp roles; a chat never had it.
 *
 * MEASURED (STEM suite 3, 2026-09-26, Qwen3.5 4B on rapid-mlx, 32,768): a
 * physics task ended at 23k tokens; pi then summarised the chat's first
 * message and kept the rest — a 1,389-character request that thought for
 * 1,532 tokens (35 s) and freed nothing. The next chat's first request queued
 * behind it: first token at 27 s where the others took 2–5 s. Had that chat
 * gone on, its next turn would also have re-prefilled the whole conversation
 * behind the new summary.
 *
 * So the rule the roles already have: compact when the context is within an
 * eighth of the window, not before, and only when the plan frees a real share
 * of it. A plan that fails either is cancelled before any model is called. A
 * context past the window (overflow recovery) and a compaction the user asked
 * for always run.
 */
import { type ExtensionAPI, estimateTokens } from '@mariozechner/pi-coding-agent';

export { MANUAL_COMPACTION_FOCUS } from './compaction-focus.js';

/** Headroom for the turn about to happen — the corp roles' reserve (compaction-settings.ts). */
export function compactionReserve(window: number): number {
  return Math.min(16384, Math.max(2048, Math.round(window / 8)));
}

export interface CompactionPlan {
  /** The model's context window. */
  readonly window: number;
  /** The context now, as pi measured it for the plan. */
  readonly tokensBefore: number;
  /** Tokens in what the plan would summarise away. */
  readonly frees: number;
  /** The user asked (the Compact button), rather than pi deciding. */
  readonly manual: boolean;
}

export type CompactionVerdict =
  | { readonly run: true }
  | { readonly run: false; readonly why: string };

export function compactionVerdict(p: CompactionPlan): CompactionVerdict {
  if (p.manual || !(p.window > 0) || p.tokensBefore >= p.window) return { run: true };
  const firesAbove = p.window - compactionReserve(p.window);
  if (p.tokensBefore < firesAbove) {
    return {
      run: false,
      why: `${p.tokensBefore} of ${p.window} tokens used — it runs above ${firesAbove}`,
    };
  }
  const worth = Math.max(1024, Math.round(p.window * 0.1));
  if (p.frees < worth) {
    return { run: false, why: `it would free ${p.frees} tokens (under ${worth})` };
  }
  return { run: true };
}

export function registerCompactionGate(pi: ExtensionAPI, log: (line: string) => void): void {
  pi.on('session_before_compact', (event, ctx) => {
    const prep = event.preparation;
    const frees = [...prep.messagesToSummarize, ...prep.turnPrefixMessages].reduce(
      (n, m) => n + estimateTokens(m),
      0,
    );
    const verdict = compactionVerdict({
      window: ctx.model?.contextWindow ?? 0,
      tokensBefore: prep.tokensBefore,
      frees,
      manual: event.customInstructions !== undefined,
    });
    if (verdict.run) return undefined;
    log(`[harness] compaction held: ${verdict.why}`);
    return { cancel: true };
  });
}
