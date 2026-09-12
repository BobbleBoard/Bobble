/**
 * LIVE TOKENS-PER-SECOND, while the answer is still coming.
 *
 * The app's throughput numbers arrive AFTER a request (llama.cpp's `timings`
 * block on the last chunk; provider-mlx's client-side count at stream end),
 * which is the wrong moment for a readout in the top bar — the user: "during
 * generation this should also live show tps numbers." The provider is the one
 * place that sees every streamed chunk as it lands, so it counts them here and
 * says so on stderr a few times a second:
 *
 *   [pi-tps] tok=<generated so far> ms=<since the first token> done=<0|1>
 *
 * stderr because it is already the wire: pi's stderr is forwarded to the app
 * as `_stderr` events (the `[pi-kv]` lines travel the same way), so nothing
 * new has to be plumbed through pi's event types. One chunk is one token on
 * llama.cpp; an engine that batches chunks under-counts slightly, and the
 * readout is labelled as an estimate for that reason.
 */

export interface LiveTpsReporter {
  /** A streamed chunk carried generated text / thinking / tool-argument bytes. */
  tick(): void;
  /** The stream ended (normally or not): emit the final line. */
  end(): void;
}

const INTERVAL_MS = 400;

export function createLiveTpsReporter(
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
  now: () => number = () => Date.now(),
): LiveTpsReporter {
  let tokens = 0;
  let firstAt: number | undefined;
  let lastReport = 0;
  let ended = false;
  const line = (done: boolean): string =>
    `[pi-tps] tok=${tokens} ms=${firstAt === undefined ? 0 : Math.max(0, now() - firstAt)} done=${done ? 1 : 0}`;
  return {
    tick() {
      if (ended) return;
      const t = now();
      firstAt ??= t;
      tokens += 1;
      if (t - lastReport >= INTERVAL_MS) {
        lastReport = t;
        write(line(false));
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (tokens > 0) write(line(true));
    },
  };
}

/** Parse one `[pi-tps]` line back; null for anything else. */
export function parseLiveTpsLine(
  text: string,
): { tokens: number; ms: number; done: boolean } | null {
  const m = text.match(/\[pi-tps\] tok=(\d+) ms=(\d+) done=([01])/);
  if (m === null) return null;
  return { tokens: Number(m[1]), ms: Number(m[2]), done: m[3] === '1' };
}
