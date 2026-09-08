/**
 * Live pixels for the computer-use monitor, taken by CHROMIUM rather than by
 * the helper.
 *
 * Two capture paths exist and they differ in one way that matters more than any
 * technical difference: which binary the user has to enable. macOS keys Screen
 * Recording to the process that calls the capture API, and the helper is signed
 * as its own identity — so a user who enables "Bobble", the only name they would
 * ever look for, has granted the wrong thing and the monitor stays blank with no
 * way to work out why. Capturing here means the grant they give to Bobble is the
 * grant that counts.
 *
 * Geometry still comes from Accessibility: this module only turns a set of
 * window source ids into playing <video> elements. The surface composes them at
 * the frames the AX side reports, which is also what makes a sheet land in the
 * right place over its parent.
 */

export interface WindowStreamHandle {
  readonly sourceId: string;
  readonly windowId: number;
  readonly video: HTMLVideoElement;
}

/** Chromium's constraint shape for capturing one window (Electron/desktop). */
interface DesktopConstraints {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
}

/**
 * Open one window's stream and return a video element already playing it.
 *
 * The element is never added to the document — it exists to be drawn from, and
 * a detached <video> still decodes. `muted` and `playsInline` keep autoplay
 * policies out of the way; without them the first `play()` can reject and the
 * caller would see a permanently black frame with no error.
 */
export async function openWindowStream(
  sourceId: string,
  windowId: number,
  maxFrameRate = 15,
): Promise<WindowStreamHandle | null> {
  const constraints: DesktopConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxFrameRate,
    },
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Chromium's desktop-capture constraints are not in the standard
      // MediaTrackConstraints type, so this cast is the whole reason the
      // feature can exist at all.
      // biome-ignore lint/suspicious/noExplicitAny: not in the DOM lib.
      video: constraints as any,
    });
  } catch {
    return null;
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    stopWindowStream({ sourceId, windowId, video });
    return null;
  }
  return { sourceId, windowId, video };
}

/** Release a stream. Leaving a desktop capture running keeps the macOS
 * recording indicator lit, which is alarming and, for a background agent, a
 * promise we did not mean to make. */
export function stopWindowStream(handle: WindowStreamHandle): void {
  const src = handle.video.srcObject;
  if (src !== null && typeof (src as MediaStream).getTracks === 'function') {
    for (const track of (src as MediaStream).getTracks()) track.stop();
  }
  handle.video.srcObject = null;
}

/**
 * Bring a set of open streams in line with the windows that should be showing:
 * keep the ones still wanted, stop the ones that are not, open the new ones.
 * Returned in the order asked for, because that order is back-to-front z-order
 * and the surface draws them in it.
 */
export async function reconcileWindowStreams(
  open: readonly WindowStreamHandle[],
  wanted: readonly { sourceId: string; windowId: number }[],
  maxFrameRate = 15,
): Promise<WindowStreamHandle[]> {
  const byId = new Map(open.map((h) => [h.sourceId, h]));
  const keep = new Set(wanted.map((w) => w.sourceId));
  for (const handle of open) {
    if (!keep.has(handle.sourceId)) stopWindowStream(handle);
  }
  const next: WindowStreamHandle[] = [];
  for (const w of wanted) {
    const existing = byId.get(w.sourceId);
    if (existing !== undefined) {
      next.push(existing);
      continue;
    }
    const opened = await openWindowStream(w.sourceId, w.windowId, maxFrameRate);
    if (opened !== null) next.push(opened);
  }
  return next;
}
