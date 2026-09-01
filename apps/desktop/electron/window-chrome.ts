/**
 * WHERE THE macOS TRAFFIC LIGHTS ARE — one source of truth, shared by the
 * process that PLACES them and the surface that has to sit beside them.
 *
 * The window is `titleBarStyle: 'hiddenInset'`, so the close/minimise/zoom
 * cluster is drawn by AppKit inside our own top bar. Anything the renderer puts
 * near the top-left has to clear it, and until now that meant a hand-tuned
 * `left-[78px]` in a Tailwind class — a number with no relationship to the one
 * main passes to `trafficLightPosition`. Change either and they drift apart
 * silently, which is exactly what "ensure this always works" rules out.
 *
 * So the geometry lives here, in a module with NO imports: `main.ts` positions
 * the cluster from it, and the renderer positions itself from it too. The same
 * pattern the ipc contracts use — the renderer already imports those.
 *
 * ## The numbers, and where they come from
 *
 * `x`/`y` are ours: we choose them, AppKit honours them, and main reads them
 * back with `getWindowButtonPosition()` after the window exists to confirm the
 * platform agreed (see `verifyTrafficLights`).
 *
 * `BUTTON` and `PITCH` are AppKit's, not ours: three 12pt buttons on a 20pt
 * pitch at the standard size. They are stated as constants because there is no
 * API that reports them — and they are the only assumption in this file, which
 * is why it is the one thing the alignment test pins.
 */

/** AppKit's standard window-button diameter, in points. */
export const TRAFFIC_LIGHT_BUTTON = 12;
/** Centre-to-centre spacing between the three buttons. */
export const TRAFFIC_LIGHT_PITCH = 20;

/**
 * The cluster's top-left, passed to `BrowserWindow`'s `trafficLightPosition`.
 *
 * `y` centres the cluster in the 46px top bar (`--pd-height-topbar`): the
 * cluster is `TRAFFIC_LIGHT_BUTTON` tall, so `(46 - 12) / 2 = 17`. Earlier
 * rounds chased "sit lower" and parked it ~10px below centre; the arithmetic is
 * here now so it cannot be nudged by feel again.
 */
export const TOP_BAR_HEIGHT = 46;
export const TRAFFIC_LIGHTS = {
  x: 19,
  y: Math.round((TOP_BAR_HEIGHT - TRAFFIC_LIGHT_BUTTON) / 2),
} as const;

/** Total width of the three-button cluster: 12 + 20 + 20 = 52. */
export const TRAFFIC_LIGHT_CLUSTER_WIDTH = TRAFFIC_LIGHT_BUTTON + TRAFFIC_LIGHT_PITCH * 2;

/** The x the cluster ENDS at — where the renderer's own chrome may begin. */
export const TRAFFIC_LIGHTS_RIGHT = TRAFFIC_LIGHTS.x + TRAFFIC_LIGHT_CLUSTER_WIDTH;

/**
 * The gap between the last light and whatever the renderer puts next to it.
 *
 * the user: "move it slightly to the right so the hover animation gives breathing
 * room and doesn't overlap". The sidebar toggle grows a rounded background on
 * hover, so the clearance has to be measured from that background's edge, not
 * from the glyph — 14px leaves the hover shape clear of the zoom button at every
 * size the button takes.
 */
export const TRAFFIC_LIGHT_GUTTER = 14;

/** Where the renderer's first top-left control sits. */
export const CHROME_LEFT = TRAFFIC_LIGHTS_RIGHT + TRAFFIC_LIGHT_GUTTER;

/**
 * The vertical centre the traffic lights sit on — and therefore the line
 * anything beside them should be centred on.
 */
export const TRAFFIC_LIGHT_CENTRE_Y = TRAFFIC_LIGHTS.y + TRAFFIC_LIGHT_BUTTON / 2;
