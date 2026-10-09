/**
 * THE APPS ON THIS MAC, WITH THEIR REAL ICONS — what the computer-use chooser
 * shows, in onboarding and in Settings → Computer use.
 *
 * The user (2026-09-15): "choose what apps to allow control of, show this as a
 * grid of real app icons w/ names below".
 *
 * The list and the icons come from the `pi-mac` helper (`--apps`,
 * `--app-icon`), because only AppKit draws the icon Finder draws: modern apps
 * keep it in an asset catalog no other tool reads, and Electron's own
 * `getFileIcon` stops at 32 px on macOS. Each icon is rendered once at 128 px
 * into the support root and handed to the renderer as a data URL, so a hundred
 * apps cost one helper run the first time and a directory read after.
 *
 * The denylist is applied here: Bobble itself, Keychain Access and System
 * Settings can never be allowed, so they are not offered.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { cacheRoot } from '@pi-desktop/inference';
import { checkDenylist } from '@pi-desktop/mac-computer-use/permissions';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:mac-apps');
const execFileAsync = promisify(execFile);

/** One installed app as the chooser draws it. */
export interface InstalledAppInfo {
  /** Bundle identifier — what the allowlist stores. */
  readonly id: string;
  /** The name Finder shows. */
  readonly name: string;
  readonly path: string;
  /**
   * The icon as a `data:image/png;base64,…` URL (128 px), or null if it
   * could not be drawn. A data URL rather than a path because the renderer's
   * `pd-file://` scheme is fenced to the person's own folders and the icon
   * cache under the support root is not one — the first cut handed paths
   * over and every tile drew a broken-image glyph. ~12 KB each, once a
   * session; a hundred apps is a megabyte.
   */
  readonly icon: string | null;
}

/** Where the rendered icons live: `<support root>/app-icons/<hash>.png`. */
export function appIconDir(): string {
  return path.join(cacheRoot(), 'app-icons');
}

const ICON_PX = 128;

/**
 * The apps a person is most likely to hand over, first. Everything else
 * follows alphabetically — a hundred tiles need an order that puts Safari
 * and Notes on the first row rather than Activity Monitor.
 */
const FAMILIAR_FIRST: readonly string[] = [
  'com.apple.Safari',
  'com.google.Chrome',
  'com.apple.finder',
  'com.apple.Notes',
  'com.apple.TextEdit',
  'com.apple.Preview',
  'com.apple.mail',
  'com.apple.MobileSMS',
  'com.apple.iCal',
  'com.apple.reminders',
  'com.apple.Music',
  'com.apple.Photos',
  'com.apple.calculator',
  'com.apple.Terminal',
  'com.microsoft.VSCode',
  'com.apple.dt.Xcode',
  'com.tinyspeck.slackmacgap',
  'com.spotify.client',
  'com.apple.Pages',
  'com.apple.Numbers',
  'com.apple.Keynote',
];

interface RawApp {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** `pi-mac --apps` → the raw list, denylisted bundles removed. */
async function rawApps(helperPath: string): Promise<RawApp[]> {
  const { stdout } = await execFileAsync(helperPath, ['--apps'], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  const line = stdout.split('\n').find((l) => l.trim().startsWith('['));
  if (line === undefined) return [];
  const parsed = JSON.parse(line) as unknown;
  if (!Array.isArray(parsed)) return [];
  const out: RawApp[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.path !== 'string') {
      continue;
    }
    // Never offer what the gate would refuse anyway.
    if (checkDenylist(e.id) !== null || checkDenylist(e.name) !== null) continue;
    out.push({ id: e.id, name: e.name, path: e.path });
  }
  return out;
}

/** Sort: the familiar apps in their listed order, then the rest by name. */
export function orderApps<T extends { readonly id: string; readonly name: string }>(
  apps: readonly T[],
): T[] {
  const rank = new Map(FAMILIAR_FIRST.map((id, i) => [id.toLowerCase(), i]));
  return [...apps].sort((a, b) => {
    const ra = rank.get(a.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** The app's icon as a data URL, rendered into the cache the first time. */
async function iconFor(helperPath: string, app: RawApp): Promise<string | null> {
  const dir = appIconDir();
  const file = path.join(
    dir,
    `${createHash('sha1').update(app.id.toLowerCase()).digest('hex')}.png`,
  );
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      await execFileAsync(helperPath, ['--app-icon', app.path, String(ICON_PX), file], {
        timeout: 15_000,
      });
    }
    if (!existsSync(file)) return null;
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } catch (err) {
    log.warn('app icon failed', { app: app.name, error: String(err) });
    return null;
  }
}

let listing: Promise<InstalledAppInfo[]> | null = null;
/** The bare list (no icons) the chat's icon lookup searches; see installedAppIcon. */
let rawListing: Promise<RawApp[]> | null = null;

/**
 * The installed apps with their icons, familiar ones first. One listing per
 * process — apps rarely appear mid-session, and the chooser can ask again by
 * passing `refresh`.
 */
export function listInstalledApps(
  helperPath: string,
  refresh = false,
): Promise<InstalledAppInfo[]> {
  if (listing === null || refresh) {
    if (refresh) rawListing = null;
    listing = (async () => {
      const apps = orderApps(await rawApps(helperPath));
      // Icons a few at a time: a hundred helper spawns at once would be a
      // noticeable hitch on the first open, and none after.
      const out: InstalledAppInfo[] = [];
      const width = 6;
      for (let i = 0; i < apps.length; i += width) {
        const slice = apps.slice(i, i + width);
        const icons = await Promise.all(slice.map((a) => iconFor(helperPath, a)));
        for (const [j, a] of slice.entries()) out.push({ ...a, icon: icons[j] ?? null });
      }
      return out;
    })().catch((err: unknown) => {
      listing = null;
      log.warn('app listing failed', { error: String(err) });
      return [];
    });
  }
  return listing;
}

/**
 * The installed app a name means — the name a chat row carries, which may be
 * Finder's ("Google Chrome"), a bundle id, or the model's shorthand ("chrome").
 * An exact name or id wins; then an app whose name holds the asked one (the
 * shortest, so "chrome" is Google Chrome rather than Chrome Remote Desktop);
 * then one whose name the asked one holds (the longest). Neither side of a
 * partial match may be under three letters — "X" is inside "textedit".
 */
export function findInstalledApp<T extends { readonly id: string; readonly name: string }>(
  apps: readonly T[],
  asked: string,
): T | undefined {
  const q = asked.trim().toLowerCase();
  if (q === '') return undefined;
  const lower = (a: T) => a.name.toLowerCase();
  const exact = apps.find((a) => lower(a) === q || a.id.toLowerCase() === q);
  if (exact !== undefined) return exact;
  if (q.length < 3) return undefined;
  const holding = apps
    .filter((a) => lower(a).includes(q))
    .sort((a, b) => a.name.length - b.name.length);
  if (holding[0] !== undefined) return holding[0];
  return apps
    .filter((a) => a.name.length >= 3 && q.includes(lower(a)))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * The real icon of the installed app `asked` names, as a data URL, or null.
 * The chat's computer-use rows come here when the running helper cannot place
 * the name (see app-icon-source.ts). The list is read once per process (the
 * chooser's refresh reads it again) and the icon is the chooser's own cached
 * 128 px render, so an app the chooser has drawn costs a file read.
 */
export async function installedAppIcon(helperPath: string, asked: string): Promise<string | null> {
  if (rawListing === null) {
    rawListing = rawApps(helperPath).catch((err: unknown) => {
      rawListing = null;
      log.warn('app list for an icon failed', { error: String(err) });
      return [];
    });
  }
  const app = findInstalledApp(await rawListing, asked);
  return app === undefined ? null : iconFor(helperPath, app);
}

/**
 * The same app, as the model named it and as macOS names it — "chrome" and
 * "Google Chrome" are one app. The pi-mac helper matches app names by
 * case-insensitive substring; so does this, from either side.
 */
export function sameApp(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x !== '' && y !== '' && (x === y || x.includes(y) || y.includes(x));
}
