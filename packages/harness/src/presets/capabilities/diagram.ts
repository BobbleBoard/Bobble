/**
 * The `diagram` capability — PLACEHOLDER from the W0-A pre-wire
 * (deliverables/research/PLAN.md §2.3).
 *
 * Process and structure as a diagram from bundled Mermaid, the way `chart`
 * is data (deliverables/research/visual-quality.md §4).
 * VQ-10 (lane VQ (vq-kit), W2) makes this a Capability. Until then it is
 * `undefined`, the list in ../capabilities.ts leaves it out, and the canonical
 * prompt is byte-identical to the one without it (the snapshot test in
 * ../../prompt). Filling it IS a prompt change: the prefix ledger entry and a
 * BENCH TTFT check come with it (PLAN.md R8).
 */
import type { Capability } from './types.js';

export const diagram: Capability | undefined = undefined;
