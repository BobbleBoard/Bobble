/**
 * COMPACTION SIZED TO THE WINDOW WE ACTUALLY HAVE.
 *
 * Every corp role builds its session with `SettingsManager.inMemory()`, so every
 * role has always run pi's DEFAULTS — `reserveTokens: 16384`,
 * `keepRecentTokens: 20000`. Those are sensible for a 200k cloud model, where
 * they are small fractions of the window. On our local 32,768 they are not:
 *
 *   shouldCompact fires above  window - reserve = 32768 - 16384 = 16384
 *   findCutPoint then keeps the most recent                      20000
 *
 * The trigger point is BELOW the keep budget, so between them `findCutPoint`
 * walks the whole history without ever reaching 20,000, falls through to its
 * default cut at the first message, and `prepareCompaction` returns a plan whose
 * `messagesToSummarize` is empty. Nothing guards that — the only early exits are
 * "last entry is already a compaction" and "missing id" — so the summarization
 * call runs anyway.
 *
 * MEASURED against pi's own shouldCompact/findCutPoint at window=32768:
 *
 *   first fires at        ~16,800 tokens
 *   first frees anything  ~20,800 tokens
 *   dead band              ~4,000 tokens
 *
 * In that band every eligible turn runs a full summarization that frees zero —
 * and because that call goes through the same single llama-server slot with a
 * different prefix, it evicts the conversation's KV and the next real turn pays
 * a full re-prefill. That is the mechanism behind the context-ceiling and
 * follow-up-cost bugs, and it is a CONFIGURATION fault, not an architectural one.
 *
 * The invariant that was violated is the whole content of this module:
 *
 *   keepRecentTokens  <  contextWindow - reserveTokens
 *
 * Anything else has a dead band. {@link compactionSettingsFor} derives both
 * numbers from the live window so the invariant holds at any size, and
 * {@link compactionDeadBand} exists so a test can assert there is none.
 */

/** What pi uses when nothing configures it — kept here so the test can show the gap. */
export const PI_DEFAULT_COMPACTION = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

export interface CompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

/**
 * Headroom left for the turn that is about to happen: the assistant's reply plus
 * its tool call. An eighth of the window, floored so a small window still has
 * room to answer and capped so a large one does not reserve absurdly.
 */
function reserveFor(contextWindow: number): number {
  return Math.min(16384, Math.max(2048, Math.round(contextWindow / 8)));
}

/**
 * Compaction settings for a live context window.
 *
 * `keepRecent` is a fraction of what is left AFTER the reserve, which is what
 * makes the invariant hold by construction rather than by luck. 45% keeps
 * roughly the last half of a full context — enough that the model still has its
 * recent working state — while guaranteeing a compaction that fires frees about
 * as much as it keeps.
 */
export function compactionSettingsFor(contextWindow: number): CompactionSettings {
  // A nonsense window must not produce nonsense settings; fall back to the
  // smallest geometry we support rather than dividing by something absurd.
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 8192;
  const reserveTokens = reserveFor(window);
  const usable = window - reserveTokens;
  const keepRecentTokens = Math.max(1024, Math.round(usable * 0.45));
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/**
 * Tokens of context in which compaction fires but frees nothing — the quantity
 * this module exists to drive to zero.
 *
 * Compaction fires above `window - reserve`, and cannot free anything until the
 * history exceeds `keepRecent`. When the trigger sits below the keep budget the
 * gap between them is dead.
 */
export function compactionDeadBand(contextWindow: number, s: CompactionSettings): number {
  const firesAbove = contextWindow - s.reserveTokens;
  return Math.max(0, s.keepRecentTokens - firesAbove);
}
