/**
 * A view's theme is ONE set of sheets: the last one applied, never the pile.
 *
 * `insertCSS` adds a stylesheet and returns its key; nothing removes it unless
 * the key is handed back. The editor themes are all `!important`, so when the
 * app went from dark to light the new light sheet landed BESIDE the old dark
 * one and lost to it: a report opened in a light app wore a black status bar
 * (office-render-probe, 2026-09-25 — the throwaway HOME starts dark and the
 * probe switches to light). Each swap takes the previous sheets out first,
 * serialized per view so two quick theme changes cannot interleave.
 */

export interface CssHost {
  isDestroyed(): boolean;
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
}

const applied = new WeakMap<CssHost, { keys: string[]; chain: Promise<void> }>();

/** Replace whatever this helper last inserted into `host` with `sheets`. */
export function swapCss(host: CssHost, sheets: readonly string[]): Promise<void> {
  const state = applied.get(host) ?? { keys: [], chain: Promise.resolve() };
  const chain = state.chain.then(async () => {
    if (host.isDestroyed()) return;
    const old = state.keys;
    state.keys = [];
    await Promise.all(old.map((key) => host.removeInsertedCSS(key).catch(() => undefined)));
    for (const css of sheets) {
      if (host.isDestroyed()) return;
      try {
        state.keys.push(await host.insertCSS(css));
      } catch {
        /* a view that went away mid-swap */
      }
    }
  });
  state.chain = chain;
  applied.set(host, state);
  return chain;
}
