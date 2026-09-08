/**
 * The IDENTITY of the one "Activity" tab, in a leaf module of its own.
 *
 * The router that drives it (activity-routing.ts) reaches for disk reads, the
 * file surface and the pi store; the browser bridge only needs to know WHICH tab
 * to hand the model's browsing to. Keeping the two constants here means asking
 * that question costs nothing — no `window` at import time, no file-surface
 * machinery pulled into a module that has no use for it.
 */

/** The ONE canvas tab the chat's tool calls drive. Constant, so it is the same
 * tab for the life of the conversation: found once, still there an hour later. */
export const ACTIVITY_TAB_KEY = 'pi:activity';

/** Its name — stable on purpose. A tab that renamed itself to each filename made
 * the tab bar shuffle under the cursor; the `subtitle` says what is inside. */
export const ACTIVITY_TITLE = 'Activity';
