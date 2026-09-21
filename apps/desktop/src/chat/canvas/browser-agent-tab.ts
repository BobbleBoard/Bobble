/**
 * WHICH CANVAS TAB THE MODEL IS BROWSING IN, in a leaf module the Activity
 * router and the browser bridge both read.
 *
 * The bridge (browser-agent.ts) adopts a tab when the model starts browsing —
 * the one the user is looking at if it is a browser, else the newest browser,
 * else the Activity tab. The router (activity-routing.ts) decides what the
 * Activity tab shows from the thread. The two used to know nothing of each
 * other, and the user watched the result: the bridge turned the Activity tab into
 * the page, the router — seeing only an `open <url>` line — turned it straight
 * back into a terminal, and every `browser click` after that drove a page
 * nobody could see. "the activity panel doesn't focus the working browser tab
 * it shows a terminal actually executing the browser snapshot command, and
 * then doesn't show the user anything for the actual browser actions".
 *
 * So the bridge SAYS which tab it drives, here, and the router reads it: when
 * the model browses in a tab of its own (the user's page), the router brings
 * that tab forward instead of morphing Activity into a second, empty browser;
 * when the model browses in the Activity tab, the router keeps it a browser.
 */

let drivenTabId: string | null = null;
const listeners = new Set<() => void>();

/** The tab the bridge registered for the model's browsing, or null. */
export function getDrivenBrowserTab(): string | null {
  return drivenTabId;
}

export function setDrivenBrowserTab(id: string | null): void {
  if (drivenTabId === id) return;
  drivenTabId = id;
  for (const fn of listeners) fn();
}

/** Wake a listener when the driven tab changes (the router re-runs its pass). */
export function subscribeDrivenBrowserTab(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
