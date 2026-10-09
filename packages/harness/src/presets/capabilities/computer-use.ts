/**
 * The `computer-use` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import { MAC_COMPUTER_USE_TOOL_NAMES } from '@pi-desktop/mac-computer-use/tool-names';
import type { Capability } from './types.js';

export const computerUse: Capability = {
  name: 'computer-use',
  /*
   * NAME THE REQUEST, not just the ability. The user asked for the Mac tools to be
   * "described as computer use so it knows when the user asks for 'use this
   * app' it can do that" — and in bash-CLI mode this one line is ALL the model
   * gets about the group, because the capability section that spells it out is
   * stripped there. So the phrasings a person actually uses have to be in the
   * summary itself.
   */
  summary:
    "Computer use: see and control any app on the user's Mac — its windows, menu bar, and its " +
    'own dialogs, sheets and file pickers. "Use <app>", "open <app> and…", "do it in <app>", ' +
    '"click that", "type it in there". Not for the web: a web page is the built-in browser\'s ' +
    'job unless the user names their own browser.',
  guidance:
    "For work inside the user's OWN applications — Notes, Finder, Photoshop, a game — and " +
    'for their own browsers (Safari, Chrome, Arc) when they ask for those specifically. A web ' +
    "page in any of them comes back as TEXT from the ordinary snapshot — the page's own " +
    'headings, prices and labels, each with the point to click it — so read a page that way ' +
    'first rather than reaching for a screenshot. (The chrome_* tools read the real DOM, but ' +
    'they need a Chrome setting that is off by default and that only the user can turn on, so ' +
    'they usually fail; the snapshot needs nothing.) The window AROUND the page — which tabs ' +
    'are open, switching between them, opening and closing one — is mac_tabs / mac_tab, and no ' +
    'page can tell you any of it. An app that ' +
    'exposes nothing to Accessibility returns a screenshot automatically; act by x,y then. A ' +
    'save sheet or file picker is part of the app that opened it — same snapshot, same clicks. ' +
    'A third of what an app can do is in its menu bar, which is in no window: mac_click takes ' +
    'menu:"File > New". It runs in the background — the app never comes to the front. Document ' +
    'commands (Save, Bold, Close) are the exception: macOS runs those only for the frontmost ' +
    'app, so pass activate:true to borrow the focus for one command. Open an app with the ' +
    'launch here, NEVER with `open -a` in a shell — that yanks it in front of whatever the ' +
    'user is doing.',
  tools: [...MAC_COMPUTER_USE_TOOL_NAMES],
};
