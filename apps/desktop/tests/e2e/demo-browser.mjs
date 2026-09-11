/**
 * THE APP'S OWN BROWSER — a different tool family from computer use.
 *
 * Chrome is the user's browser, driven through Accessibility. This is the one
 * the app ships: browser_navigate / browser_snapshot / browser_read, which need
 * no screen, no grant and no window. A model can be good at one and hopeless at
 * the other, and until now nothing here measured the second.
 *
 * The page is served from this machine so the test cannot fail on somebody
 * else's uptime, and the answer is a string no model can produce without having
 * actually read it.
 */
import { createServer } from 'node:http';
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
const TOKEN = `KELDER-${Math.floor(Math.random() * 90000) + 10000}`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>Depot register</title><h1>Depot register</h1>` +
      `<p>Nothing to see in this paragraph.</p>` +
      `<p>The reference code for the Harrow Vale depot is <b>${TOKEN}</b>.</p>` +
      `<p>Another paragraph, also irrelevant.</p>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

try {
  await demoRun({
    name: process.env.RUN_NAME ?? `browser-${MODEL}-${MODE}`,
    app: 'Finder',
    attach: true,
    model: MODEL,
    mode: MODE,
    prompt:
      `Open ${url} in your own built-in browser and read it. ` +
      'Tell me the reference code for the Harrow Vale depot, exactly as written.',
    verify: async (_dbg, last) => ({
      verdict: last.text.includes(TOKEN) ? 'pass' : 'fail',
      expected: TOKEN,
      /* A model that never opened it cannot have the code; one that opened the
         wrong thing says so here rather than in a stack trace. */
      said: last.text.slice(0, 160),
    }),
  });
} finally {
  /*
   * DESTROY THE CONNECTIONS, not just the listener.
   *
   * `server.close()` stops accepting and then WAITS for open connections to end
   * — and the app's browser holds a keep-alive socket open long after it has
   * finished reading. MEASURED: three browser runs at 319-325s each whose actual
   * capture was 23-28 seconds. Five minutes per run, all of it after the work
   * was done.
   */
  server.closeAllConnections?.();
  server.close();
}
