/**
 * Capturing the controlled app's windows from ELECTRON, using the app's own
 * identity.
 *
 * The helper (`pi-mac --stream`) captures with ScreenCaptureKit, and macOS keys
 * the Screen Recording grant to the binary that calls it. The helper is signed
 * as its own identity, so it is its own TCC client: a user who enables
 * **Bobble** in System Settings — the only name they would ever look for — has
 * granted the wrong binary and the monitor stays blind. the user hit exactly this:
 * "I notice a lot of permission re-popups in bobble even after I totally have
 * provided the permissions and double checked and restarted the app."
 *
 * Chromium's window capture runs inside Electron, so the grant the user gives
 * to Bobble is the one that counts. macOS window source ids are
 * `window:<CGWindowID>:0`, and the AX side already knows every window's
 * CGWindowID — so the two halves join with no guessing: Accessibility says
 * WHERE each window is, Chromium provides its pixels.
 */
import { desktopCapturer, systemPreferences } from 'electron';

/** A window Chromium is willing to hand us pixels for. */
export interface CapturableWindow {
  /** Chromium's source id, passed to getUserMedia in the renderer. */
  readonly sourceId: string;
  /** The same window's CGWindowID — how the AX side names it. */
  readonly windowId: number;
  readonly name: string;
}

/**
 * `window:<CGWindowID>:<n>` on macOS. Returns null for a screen source or any
 * shape we do not recognise, so a future Chromium format degrades to "no
 * pixels" rather than to a wrong window.
 */
export function windowIdOfSource(sourceId: string): number | null {
  const m = /^window:(\d+):\d+$/.exec(sourceId);
  if (m === null) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Whether CHROMIUM — that is, this app, under the name the user sees — has the
 * Screen Recording grant.
 *
 * Three answers, not two: 'unknown' is what a non-macOS build (and any future
 * Electron that stops answering) gives, and it must not be read as a denial,
 * because a denial is a screen with a button on it.
 */
export function screenCaptureGrant(): 'granted' | 'denied' | 'unknown' {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted') return 'granted';
    if (status === 'denied' || status === 'restricted') return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Whether Chromium currently has the Screen Recording grant. */
export function screenCaptureGranted(): boolean {
  return screenCaptureGrant() === 'granted';
}

/**
 * Put THIS app in the Screen Recording list, so the pane we are about to open
 * has a switch to show.
 *
 * macOS only lists an app once it has attempted a capture, and the attempt is
 * what registers it — the refusal is the point, not a failure. This is the
 * difference between "Privacy & Security opens on a list with Bobble in it" and
 * "Privacy & Security opens on a list the user has to believe us about".
 */
export async function registerForScreenRecording(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch {
    /* refused — which is exactly what registers the app */
  }
}

/**
 * Sources for the given windows, in the order asked for. Enumeration itself
 * needs the grant, so a denial surfaces here as an empty list plus `denied`,
 * which is what the monitor turns into a screen the user can act on.
 */
export async function capturableWindows(
  windowIds: readonly number[],
): Promise<{ windows: CapturableWindow[]; denied: boolean }> {
  const wanted = new Set(windowIds);
  try {
    // No thumbnails: enumeration is all this needs, and rasterising every
    // window on the machine at 8fps is not a cost worth paying.
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const byId = new Map<number, CapturableWindow>();
    for (const s of sources) {
      const windowId = windowIdOfSource(s.id);
      if (windowId === null || !wanted.has(windowId)) continue;
      byId.set(windowId, { sourceId: s.id, windowId, name: s.name });
    }
    const windows = windowIds
      .map((id) => byId.get(id))
      .filter((w): w is CapturableWindow => w !== undefined);
    return { windows, denied: false };
  } catch {
    return { windows: [], denied: true };
  }
}

/**
 * What to tell the user, naming the thing they will actually see in the list.
 * The whole point of capturing from Electron is that this sentence can say
 * "Bobble" and be true.
 */
export const SCREEN_RECORDING_APP_NAME = 'Bobble';
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
