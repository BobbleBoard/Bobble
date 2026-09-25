/**
 * The `memory` capability — PLACEHOLDER from the W0-A pre-wire
 * (deliverables/research/PLAN.md §2.3).
 *
 * `memory recall|remember|forget` — what Bobble learned across chats
 * (deliverables/research/hindsight-memory.md §4.5).
 * WP-M6 (lane MEM, W3) makes this a Capability. Until then it is
 * `undefined`, the list in ../capabilities.ts leaves it out, and the canonical
 * prompt is byte-identical to the one without it (the snapshot test in
 * ../../prompt). Filling it IS a prompt change: the prefix ledger entry and a
 * BENCH TTFT check come with it (PLAN.md R8).
 */
import type { Capability } from './types.js';

export const memory: Capability | undefined = undefined;
