/**
 * INPUT IS BEING PREPARED — tell the app, at most every couple of seconds.
 *
 * The model is unloaded after five minutes with nothing typed and nothing
 * running (electron/inference/idle-unload.ts). The first sign that a message is
 * on its way loads it back, so the load and the prefill happen while the user
 * is still typing: a keystroke, a paste, a file dropped or attached, the
 * microphone, a click into the input. The same call restarts the five-minute
 * clock, so a steady typist never sees an unload.
 */

const THROTTLE_MS = 2_000;
let last = 0;

export function noteInputActivity(now: number = Date.now()): void {
  if (now - last < THROTTLE_MS) return;
  last = now;
  const bridge = (
    window as { piDesktop?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } }
  ).piDesktop;
  void bridge?.invoke?.('llm:input-activity', undefined)?.catch(() => {});
}

/** For tests: forget the throttle. */
export function resetInputActivityThrottle(): void {
  last = 0;
}
