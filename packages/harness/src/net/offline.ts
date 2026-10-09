/**
 * IS THERE ANY INTERNET? — answered by what actually happened, not by a probe.
 *
 * The user: "model still has search and web tools even when there's no internet, and
 * gets confused looping in them."
 *
 * The looping is not a preference the model can be talked out of. llama-server
 * constrains the emitted tool name to the ADVERTISED list, so a model that wants
 * to look something up and has `web_search` in front of it will keep calling
 * `web_search` however many times it fails. The only thing that stops it is
 * taking the tool away.
 *
 * Deciding that with a connectivity PROBE would be worse than the bug: this app
 * is offline-first by design, and pinging a third party on the off-chance is
 * exactly the traffic it exists not to generate. The web tools already tell us —
 * a DNS or connect failure IS the answer — so the latch is set by their own
 * failures and costs nothing until one happens.
 *
 * It expires rather than sticking: someone whose wifi drops for a minute should
 * get search back without restarting the app, and {@link OFFLINE_TTL_MS} is far
 * longer than any single turn, so a turn can never loop through it.
 */

/** How long a network failure keeps the web tools off the table. */
export const OFFLINE_TTL_MS = 5 * 60 * 1000;

/** The tools that need the internet, and are withheld while it is missing. */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

/**
 * Error text that means "the network is not there", as distinct from "that page
 * said 404" — a site being down is not a reason to withdraw search.
 *
 * Node's undici reports a failed connection as the famously unhelpful `fetch
 * failed` with the real reason on `cause`, which is flattened into the message
 * by the time a tool result carries it; the codes below are what appears there.
 */
const NETWORK_FAILURE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED)\b|fetch failed|getaddrinfo|network is unreachable|could not resolve host/i;

/** True when this text is a tool failing because there is no network. */
export function isNetworkFailure(text: string): boolean {
  return NETWORK_FAILURE.test(text);
}

/** The one line handed back so the model stops retrying and answers instead. */
export const OFFLINE_TOOL_NOTE =
  'There is no internet connection right now, so the web tools cannot be used and have been ' +
  'withdrawn for this turn. Do not try to search or fetch again — answer from what you already ' +
  'know and from the files on this machine, and say plainly which parts you could not verify.';

/** The latch. Session-scoped state, kept out of the module's callers. */
export interface OfflineLatch {
  /** Record a tool outcome; returns true when this one tripped the latch. */
  note(toolName: string, isError: boolean, text: string): boolean;
  /** Are the web tools currently withheld? */
  offline(): boolean;
  /** Forget everything (a fresh session starts hopeful). */
  reset(): void;
}

export function createOfflineLatch(now: () => number = Date.now): OfflineLatch {
  let since: number | null = null;
  return {
    note(toolName, isError, text) {
      if (!NETWORK_TOOLS.has(toolName)) return false;
      if (!isError) {
        // A web call that WORKED is proof the network is back — better evidence
        // than the clock, so it clears the latch early.
        since = null;
        return false;
      }
      if (!isNetworkFailure(text)) return false;
      const already = since !== null && now() - since < OFFLINE_TTL_MS;
      since = now();
      return !already;
    },
    offline() {
      return since !== null && now() - since < OFFLINE_TTL_MS;
    },
    reset() {
      since = null;
    },
  };
}
