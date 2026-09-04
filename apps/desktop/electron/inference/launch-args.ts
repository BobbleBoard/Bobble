/**
 * Assembling a llama-server command line from several minds at once.
 *
 * The launch used to be built by one chooser; it is now built by three — the
 * chat-template resolver, the per-hardware perf args, and the live power policy
 * — and two of those can legitimately want the same knob. This is the small
 * amount of arithmetic that keeps them from contradicting each other on the
 * command line.
 *
 * Its own module, and not part of supervisor-entry, because that file is a
 * utility-process ENTRY POINT: importing it runs `parentPort.on(...)`, so
 * nothing in it can be unit-tested from outside.
 */

/**
 * Collapse repeated `--flag value` pairs, last writer wins.
 *
 * Two independent choosers can now ask for the same knob — `chooseServerPerfArgs`
 * quantises the KV under its own RAM estimate, and the power policy does so under
 * live pressure — and llama.cpp takes the LAST value for a repeated flag, so
 * without this the command line would carry the same argument twice and the
 * winner would depend on array order rather than on intent. Bare switches
 * (`--no-kv-offload`) are kept once.
 */
export function dedupeFlags(args: readonly string[]): string[] {
  const seen = new Map<string, string[]>();
  const order: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    if (!token.startsWith('-')) continue; // a stray value; the pair below claims it
    const next = args[i + 1];
    const pair = next !== undefined && !next.startsWith('-') ? [token, next] : [token];
    if (!seen.has(token)) order.push(token);
    seen.set(token, pair);
    if (pair.length === 2) i++;
  }
  return order.flatMap((flag) => seen.get(flag) ?? []);
}
