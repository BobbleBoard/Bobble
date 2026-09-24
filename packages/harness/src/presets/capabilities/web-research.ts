/**
 * The `web-research` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const webResearch: Capability = {
  name: 'web-research',
  summary: 'Search the web and fetch a page as readable text.',
  guidance:
    'Search to FIND things, fetch to read one quickly. When you need to interact with a page ' +
    'rather than just read it, activate the browser capability instead.',
  tools: ['web_search', 'web_fetch'],
};
