/**
 * The `chrome` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import { CHROME_TOOL_NAMES } from '@pi-desktop/mac-computer-use/tool-names';
import type { Capability } from './types.js';

export const chrome: Capability = {
  /*
   * the user: "instead of integrating into mac, add a chrome connector and have
   * chrome be its own set." A browser is not just another app you click at.
   * It has tabs, an address bar, a page, and the user's own logged-in
   * session — and folding that into the generic Mac tools made a model asked
   * to work "in Chrome" reach for `mac` and find nothing about any of it.
   */
  name: 'chrome',
  summary:
    "The user's OWN Google Chrome — its open tabs, the page in front, and their logged-in " +
    'session. ONLY when they say so: "in Chrome", "in my browser", "the tab I have open". A web ' +
    "task they did not tie to Chrome is the built-in browser's.",
  guidance:
    'For work in the browser the USER already has open, with their logins and their tabs — ' +
    "not the app's built-in browser (that is `browser`). chrome_tabs lists what is open and " +
    'chrome_tab switches between them; SWITCHING is invisible to the user, but OPENING or ' +
    'CLOSING a tab brings Chrome to the front and cannot be undone, so prefer switching. ' +
    "Read a page with a snapshot: it carries the page's own text with the point to click on " +
    'each line, so a page can be read and driven without a screenshot and without any Chrome ' +
    'setting. Everything else about the window — profiles, settings, the toolbar — is ' +
    'ordinary computer use on the Chrome app.',
  tools: [...CHROME_TOOL_NAMES],
};
