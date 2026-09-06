/**
 * "Run, but do not let me notice."
 *
 * A test suite that steals focus is a test suite you cannot run while working.
 * Every probe launches a real Electron app, and a real Electron app on macOS
 * wants the screen: it activates, it takes key focus, it appears in the dock and
 * the ⌘-Tab switcher, it posts notifications, and — during a computer-use probe
 * — it floats an always-on-top overlay over whatever you were reading.
 *
 * the user: "ideally headlessly … but it doesn't take any focus away from me, I can
 * use the computer without any notice of any rapid test suites."
 *
 * ## What this mode does
 *
 * The window is created and NEVER SHOWN. That is not a compromise: a hidden
 * BrowserWindow still runs its renderer, still lays out at its configured size,
 * still animates, Playwright still drives it over CDP, and `capturePage()` still
 * returns a real, complete screenshot. Verified on this app — the screenshots in
 * `tests/e2e` are taken this way.
 *
 * IT DOES NOT ANIMATE AT FULL RATE, and this used to claim it did. MEASURED on
 * the same machine in the same minute: 61 animation frames per 500ms with the
 * window shown, 6 with it hidden. The page is not "hidden" as far as Blink is
 * concerned (`document.visibilityState` is "visible", so page-visibility
 * throttling is not the mechanism, and `backgroundThrottling: false` changes
 * nothing) — a window with no on-screen surface simply is not driven by the
 * display's vsync, and falls back to a timer at around 12fps.
 *
 * That is fine for what probes need and worth knowing before you write one. CSS
 * animations and transitions are driven by TIME, not by frames, so they still
 * land where they should; `capturePage()` forces its own frame, so screenshots
 * are complete. What you must not do is wait on a frame COUNT, or on "a few
 * frames should be enough for that transition" — wait on the state you actually
 * care about.
 *
 * Everything else that would surface is suppressed at its own call site, each
 * gated on {@link isBackgroundMode}: OS notifications, the computer-use
 * overlay, second-instance activation, and the popout's focus grab.
 *
 * ## Why not `offscreen: true`
 *
 * Electron's OSR path renders without a GPU and changes how compositing,
 * WebGL and native child views behave — which is exactly the surface this app
 * leans on (the canvas browser, the 3D viewport, xterm). A hidden ordinary
 * window keeps full fidelity; it simply is not composited to a display.
 *
 * ## Opting out
 *
 * `PI_E2E_VISIBLE=1` turns the whole mode off — a normal, visible window — for
 * when someone actually wants to watch a run.
 */

/**
 * True when this process is running a test that must not surface.
 *
 * ANY test run counts, not just one that remembered a flag. `PI_E2E=1` is what
 * every probe already sets — 172 of them, plus the packaged smoke test that
 * runs on every install — and requiring a second opt-in meant each probe
 * independently forgot it. Being unnoticeable is the default for a test; being
 * watched is the thing you ask for.
 *
 * `PI_E2E_BACKGROUND=1` stays as an explicit opt-in for anything driving the
 * app outside the probe suite.
 */
export function isBackgroundMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_E2E_VISIBLE === '1') return false;
  return env.PI_E2E === '1' || env.PI_E2E_BACKGROUND === '1';
}

/**
 * True when the window should never be shown at all.
 *
 * Identical to {@link isBackgroundMode} today, and kept separate because the two
 * questions are genuinely different: one is "must this run be unnoticeable", the
 * other is "may the window exist on screen". If a future mode ever wants an
 * unfocused-but-visible window, this is the one that changes.
 */
export function isHiddenMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return isBackgroundMode(env);
}
