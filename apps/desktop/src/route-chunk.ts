/**
 * WHEN ONE ROUTE'S CODE WILL NOT LOAD, ONLY THAT ROUTE IS BROKEN.
 *
 * the user, on the full-window crash card: "rendering error self explanatory, that
 * simply can't happen anymore, it's totally unacceptable."
 *
 * One of the two ways to reach that card had nothing to do with a render bug at
 * all. The studios, the 3D workspace and the candidate galleries are
 * `React.lazy` — each is a separate file the window fetches the first time you
 * open it, named by content hash (`ImageStudio-BwnLp1LD.js`). Rebuild the app
 * while a window is open and that file is deleted and rewritten under a new
 * hash, so the OLD window's import 404s. Nothing stood between the rejected
 * import and the app-wide boundary, so a missing 10KB chunk replaced the
 * sidebar, the top bar and the conversation with
 *
 *     Failed to fetch dynamically imported module: …/ImageStudio-CPT1vDU_.js
 *
 * MEASURED by parking that one file while the app ran (tests/e2e/route-chunk-probe.mjs).
 *
 * This module is the decision half — what the failure IS and what may be
 * offered about it — kept pure so the policy is unit-tested rather than
 * screenshotted. The React half is RouteBoundary.tsx.
 */

/**
 * How many times a person may press "Try again" before the panel stops offering
 * it.
 *
 * A retry is worth having because the commonest cause is genuinely transient
 * from the app's point of view: the rebuild that moved the chunk has usually
 * FINISHED, and a second import of the same URL succeeds (verified in the probe
 * by putting the parked file back and pressing the button). But when the URL is
 * gone for good, pressing forever gets nowhere, and a panel that keeps insisting
 * is how a person ends up clicking a button forty times. Two is enough to clear
 * a race and few enough that the third answer — reload the window — arrives
 * while they still care.
 */
export const MAX_ROUTE_RETRIES = 2;

/** Best-effort message text for anything a boundary might be handed. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : String(error);
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * The wordings a browser uses for "the file behind this import did not arrive".
 *
 * Deliberately a list of substrings rather than one regex: Chromium, Vite's
 * preload helper and the bundler's own runtime each phrase it differently, and
 * the ones that matter here were collected from the real failure and from
 * Vite's `preload-helper` source rather than guessed.
 */
const CHUNK_ERROR_MARKERS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
  'unable to preload css for',
] as const;

/**
 * Is this "the code for this route is missing", as opposed to a bug INSIDE the
 * route?
 *
 * It changes what the panel can honestly promise. A missing chunk is very
 * likely fixed by fetching it again, and certainly fixed by reloading the
 * document (which re-reads index.html and therefore the new hashes). A render
 * throw inside a loaded route is neither — retrying re-mounts the same code.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if ((error as { name?: unknown }).name === 'ChunkLoadError') return true;
  const message = errorMessage(error).toLowerCase();
  return CHUNK_ERROR_MARKERS.some((marker) => message.includes(marker));
}

/**
 * THE URL THAT DID NOT LOAD, PULLED BACK OUT OF THE ERROR — and why a retry
 * needs it.
 *
 * MEASURED, because the first cut of the retry button did not work and the
 * reason is not obvious: a dynamic import that fails is remembered as failed for
 * the life of the document. Chromium records the failure in the module map, so
 * importing the SAME specifier again rejects instantly without going near the
 * disk. Driven directly in the running app — park the chunk, import (fails), put
 * the chunk back, import again:
 *
 *   parked;   first import      → Failed to fetch dynamically imported module
 *   restored; same url again    → Failed to fetch dynamically imported module
 *   restored; url + '?rc=1'     → ok, exports ["VideoStudio"]
 *
 * A different specifier is a different module-map key, so the fetch really
 * happens. That is the entire reason the panel's button can do anything at all;
 * without it "Try again" would be a button that is guaranteed not to work.
 *
 * Chromium puts the URL in the message, so it can be recovered from the error
 * itself rather than threaded down from the bundler.
 */
const URL_IN_MESSAGE = /(file:\/\/\/|https?:\/\/|\/)[^\s'")]+\.(?:m?js)\b/i;

export function chunkUrlFromError(error: unknown): string | null {
  const match = URL_IN_MESSAGE.exec(errorMessage(error));
  /* Only a script. "Unable to preload CSS for /assets/x.css" also carries a URL,
   * and importing a stylesheet as a module would fail in a new and more
   * confusing way than the failure it is trying to recover from. */
  return match?.[0] ?? null;
}

/** The same URL, made unique so the module map has to fetch it again. */
export function bustedChunkUrl(url: string, attempt: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}pdRetry=${attempt}`;
}

/** What the route's panel says and offers. */
export interface RoutePanel {
  readonly title: string;
  readonly copy: string;
  /** The raw error, shown rather than hidden — this is a local app and the user
   * is the only reporter there is (same reasoning as the app-wide card). */
  readonly detail: string;
  /** Offer "Try again"? False once the attempts are spent. */
  readonly canRetry: boolean;
  /**
   * WHICH existing recovery the secondary button runs — never a new one.
   *
   * `document` is app-reload's `hardReload`, and a stale chunk NEEDS it: the
   * running document's module graph already names the file that is gone, so
   * re-mounting the React tree asks for the same missing URL again. Only
   * re-reading index.html picks up the new hashes.
   *
   * `remount` is app-reload's `softReload` — the right escape for a route that
   * loaded fine and then threw, because that is a broken tree, not a broken
   * fetch, and the soft path keeps the chat, the canvas tabs and the scroll
   * position.
   */
  readonly reload: 'document' | 'remount';
  readonly reloadLabel: string;
}

/**
 * What to show for a failed route. Pure: the label, the error and how many
 * attempts have already been spent are everything the wording depends on.
 */
export function routePanel(input: {
  /** The route's own name, as the person knows it ("Image studio"). */
  readonly label: string;
  readonly error: unknown;
  /** Imports attempted and failed so far — 1 the first time this is shown. */
  readonly attempts: number;
}): RoutePanel {
  const { label, error, attempts } = input;
  const chunk = isChunkLoadError(error);
  const spent = attempts > MAX_ROUTE_RETRIES;
  return {
    title: chunk ? `${label} could not be loaded` : `${label} stopped working`,
    copy: chunk
      ? spent
        ? `Its files could not be fetched after ${attempts} attempts. Bobble was most likely updated while this window was open — reloading picks up the new files. Everything else is still running.`
        : 'Its files could not be fetched. This usually means Bobble was updated while this window was open. Everything else is still running.'
      : spent
        ? 'It failed again on every retry. Everything else is still running — reloading rebuilds the view without touching your chat.'
        : 'Something in this screen threw while drawing. Everything else — your chat, the sidebar, anything running — is untouched.',
    detail: errorMessage(error),
    canRetry: !spent,
    reload: chunk ? 'document' : 'remount',
    reloadLabel: chunk ? 'Reload Bobble' : 'Reload the view',
  };
}

/*
 * ── A WAY TO MAKE ONE IMPORT FAIL ────────────────────────────────────────────
 *
 * The panel is, like the crash card before it, a screen that only appears when
 * something else has already gone wrong — so it cannot be checked by waiting for
 * it. Parking the real chunk file proves the FIRST failure end to end (and the
 * probe does exactly that), but it cannot drive "the retry fails too, and again,
 * and then the panel gives up", because restoring the file is the only lever and
 * it fixes everything at once.
 *
 * So, behind the same `?piE2E=1` opt-in as the store/theme/crash seams: arm a
 * route to reject its next N imports. Nothing is armed without the flag, and the
 * guard below is a Map lookup on a path that already awaits a network fetch.
 */
const armedFailures = new Map<string, number>();

/** Make the next `times` imports of `label` reject. Test seam. */
export function armChunkFailure(label: string, times = 1): void {
  if (times <= 0) armedFailures.delete(label);
  else armedFailures.set(label, times);
}

/** Consume one armed failure for `label`, returning the message to reject with. */
export function takeArmedFailure(label: string): string | null {
  const left = armedFailures.get(label) ?? 0;
  if (left <= 0) return null;
  if (left === 1) armedFailures.delete(label);
  else armedFailures.set(label, left - 1);
  /* Shaped like the real one, so the panel's own classification is exercised
   * rather than bypassed — an armed failure must be indistinguishable from a
   * chunk that is genuinely missing. */
  return `Failed to fetch dynamically imported module: ${label.replace(/[^A-Za-z0-9]+/g, '')}-e2e00000.js`;
}

/** Run a route's import, honouring an armed failure. */
export function loadRouteChunk<T>(label: string, importer: () => Promise<T>): Promise<T> {
  const armed = takeArmedFailure(label);
  if (armed !== null) return Promise.reject(new Error(armed));
  return importer();
}

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (
    window as unknown as { __pi_fail_chunk: (label: string, times?: number) => void }
  ).__pi_fail_chunk = (label, times) => armChunkFailure(label, times ?? 1);
}
