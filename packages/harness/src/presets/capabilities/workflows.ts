/**
 * The `workflows` capability — PLACEHOLDER from the W0-A pre-wire
 * (deliverables/research/PLAN.md §2.3).
 *
 * Run a saved workflow or a Deep research from the chat
 * (deliverables/research/workflows.md §4).
 * WF-10 (lane WF, W3) makes this a Capability. Until then it is
 * `undefined`, the list in ../capabilities.ts leaves it out, and the canonical
 * prompt is byte-identical to the one without it (the snapshot test in
 * ../../prompt). Filling it IS a prompt change: the prefix ledger entry and a
 * BENCH TTFT check come with it (PLAN.md R8).
 */
import type { Capability } from './types.js';

export const workflows: Capability | undefined = undefined;
