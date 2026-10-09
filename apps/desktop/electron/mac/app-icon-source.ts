/**
 * ONE APP'S REAL ICON, for the rows in the chat that name it.
 *
 * The user: "you can get the real app icon of any program being used right? so
 * just use that no emoji." A computer-use row names the app it acted on, and
 * this is where main turns that name into the picture macOS draws for it
 * (`mac:app-icon`, src/chat/app-icons.ts).
 *
 * Two ways in, in order:
 *  1. the long-lived `pi-mac --serve` helper's `appIcon` method — a running app
 *     by its name, or any app by its bundle id;
 *  2. the apps installed on this Mac (the computer-use chooser's own list), for
 *     the names the helper cannot place: an app that is not running yet — a
 *     `launch` row is drawn before the app is up — or the model's shorthand,
 *     "chrome" or "textedit".
 *
 * Both draw through NSWorkspace, which asks for no permission. Electron's own
 * `app.getFileIcon` is deliberately not a way in: called from main in a hidden,
 * accessory-policy run it ended the process with SIGTRAP.
 *
 * Electron-free — the two lookups are handed in — so the cache rules are
 * unit-tested without a Mac (app-icon-source.test.ts).
 */

export interface AppIconSourceDeps {
  /** The helper's `appIcon` answer; rejects when it has no icon for the name. */
  helperIcon(app: string): Promise<{ base64?: string; mimeType?: string }>;
  /** The icon of the installed app the name means, as a data URL, or null. */
  installedIcon(app: string): Promise<string | null>;
  now?(): number;
}

/**
 * How long "no icon for that name" stands before the name is asked again. A
 * found icon is kept for the session; a miss is not, so an app installed or
 * first launched later gets its picture on the next window or reload — without
 * a row that has none asking on every frame.
 */
export const APP_ICON_MISS_MS = 60_000;

/** Longer than any app name; a longer "name" is not one. */
const MAX_NAME_CHARS = 256;

interface Entry {
  readonly icon: Promise<string | null>;
  /** When the lookup came back empty; null while pending or once found. */
  missAt: number | null;
}

/**
 * A per-app cached lookup. Names are matched case-insensitively ("Safari" and
 * "safari" are one app, one request), and concurrent asks for one app share
 * one lookup.
 */
export function createAppIconSource(
  deps: AppIconSourceDeps,
): (app: string) => Promise<string | null> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();

  async function lookup(name: string): Promise<string | null> {
    try {
      const r = await deps.helperIcon(name);
      if (typeof r.base64 === 'string' && r.base64 !== '') {
        return `data:${r.mimeType ?? 'image/png'};base64,${r.base64}`;
      }
    } catch {
      // Not running under that name and not a bundle id: try the installed apps.
    }
    try {
      return await deps.installedIcon(name);
    } catch {
      return null;
    }
  }

  return (app: string) => {
    const name = app.trim();
    if (name === '' || name.length > MAX_NAME_CHARS) return Promise.resolve(null);
    const key = name.toLowerCase();
    const held = cache.get(key);
    if (held !== undefined && (held.missAt === null || now() - held.missAt < APP_ICON_MISS_MS)) {
      return held.icon;
    }
    const entry: Entry = {
      icon: lookup(name).then((icon) => {
        if (icon === null) entry.missAt = now();
        return icon;
      }),
      missAt: null,
    };
    cache.set(key, entry);
    return entry.icon;
  };
}
