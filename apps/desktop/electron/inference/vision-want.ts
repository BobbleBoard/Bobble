/**
 * "Something produced an image the model could not see" — a one-bit want, set
 * where the image is made and acted on at a turn boundary.
 *
 * WHY IT IS NOT ACTED ON IMMEDIATELY. Going multimodal is a hard RESTART of
 * llama-server. Firing it the moment a browser screenshot is captured would kill
 * the very turn that captured it — the model would lose its work and, from the
 * user's side, the turn would simply die. So the capture records the want and the
 * turn boundary spends it.
 *
 * WHY IT EXISTS AT ALL. `ensureVisionMode()` in the renderer is reached only via
 * `messageNeedsVision({ imageDataUris })`, which sees images the USER attaches in
 * the composer. An image the MODEL produces — a screenshot, a rendered frame, an
 * image it just generated — never passes that check, so vision was never
 * requested for exactly the cases an agent needs it (LIVE-TEST-FINDINGS.md §2).
 */

let wanted = false;

/**
 * Record that an image was produced while the server could not read images.
 *
 * NOT when the user switched vision OFF (engine menu → Vision, the user
 * 2026-09-23: "always be on unless the user says to turn it off"). Off means
 * off: a tool's screenshot does not relaunch the model into vision behind the
 * user's back — the model is told "vision is switched off" instead (provider
 * note). An image the USER attaches still loads it (the composer's own path).
 */
export function wantVision(): void {
  if (!visionAllowed()) return;
  wanted = true;
}

let visionAllowed: () => boolean = () => true;

/** Main wires this to the setting once (settings-main is not importable from every test). */
export function setVisionAllowed(fn: () => boolean): void {
  visionAllowed = fn;
}

/** Take the want (and clear it). True at most once per set. */
export function takeVisionWant(): boolean {
  const w = wanted;
  wanted = false;
  return w;
}

/** Test seam. */
export function resetVisionWant(): void {
  wanted = false;
}
