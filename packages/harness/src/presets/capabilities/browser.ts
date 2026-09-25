/**
 * The `browser` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import type { Capability } from './types.js';

export const browser: Capability = {
  name: 'browser',
  /*
   * THE WEB GOES HERE, BY DEFAULT. the user (2026-09-13): the model was reaching
   * for computer use on the user's Chrome for ordinary web tasks. In bash-CLI
   * mode this line is all it reads about the group, so the default lives in
   * the summary: any page, any site, this browser — the user's own Chrome
   * only when they name it.
   */
  summary:
    "Drive the app's own built-in browser: navigate, click, type, read a page. THE way onto " +
    "the web for any site or page — not the user's own Chrome, unless they name it.",
  guidance:
    'Your PRIMARY web control. browser_navigate and browser_snapshot are always in your ' +
    'list; this adds the rest — click, type, scroll, read, wait, back, forward, key. Never ' +
    're-navigate to a page you are already on just to look at it: snapshot it. If a tab is ' +
    'already open, act on THAT tab rather than opening another.',
  tools: [...BROWSER_TOOL_NAMES],
};
