/**
 * WHERE THE WORK HAPPENS. One rule, and nothing competes with it.
 *
 * the user, pointing at the folder dropdown in the composer: "if they have a project
 * selected that dropdown right there is the end all be all, everything is THAT
 * DROPDOWN'S SELECTION. always always always nothing competes with that."
 *
 *   project selected  ->  exactly that path, as specified
 *   "No project"      ->  ~/Bobble/<conversation name>
 *
 * That is the whole resolution. Not the prompt text, not process.cwd(), not a
 * temp directory, not the Desktop.
 *
 * WHAT THIS REPLACES. The corp used to derive its root by regex from the prompt
 * ("build it in ~/x/game"), which outranked the dropdown. Inferring a root from
 * English prose cannot be made to work, and it fails SILENTLY — a team works
 * perfectly wherever you put it, so nobody finds out until the user opens the
 * folder they chose and it is empty. Measured failures: a sentence-ending full
 * stop became part of the directory (`godotdemo.`); naming an input and an
 * output rooted the whole team at the input (`~/Downloads/report.pdf`).
 *
 * A path named in the prompt is a DELIVERY DESTINATION now — see
 * `deliveryFromTask`. Writing there is already permitted by `isNamedDestination`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The visible home for projectless work. Chosen over the old hidden
 * `~/.pi/desktop/sandbox/<uuid>` because a user has to be able to FIND their own
 * output without the app telling them where it went. */
export function bobbleBaseDir(home: string = os.homedir()): string {
  return path.join(home, 'Bobble');
}

/**
 * A conversation name reduced to one safe, readable path segment.
 *
 * Readable is the point — this is the folder the user opens in Finder. Spaces
 * become hyphens rather than being stripped, so "Godot game demo" reads as
 * `godot-game-demo` and not `godotgamedemo`. Anything that could escape the base
 * (separators, leading dots) is removed outright.
 */
export function projectSlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'untitled';
}

/** The absolute path for a projectless conversation's folder. No fs touch. */
export function bobbleProjectPath(name: string, home: string = os.homedir()): string {
  return path.join(bobbleBaseDir(home), projectSlug(name));
}

/**
 * Resolve the workspace. THE dropdown wins; otherwise `~/Bobble/<name>`.
 *
 * `selected` is the composer's folder selection — null/empty means "No project".
 * The directory is created either way, because a workspace that does not exist
 * is how relative writes end up somewhere else.
 */
export function resolveProjectDir(
  selected: string | null | undefined,
  conversationName: string,
  home: string = os.homedir(),
): string {
  const chosen = typeof selected === 'string' ? selected.trim() : '';
  const dir = chosen !== '' ? path.resolve(chosen) : bobbleProjectPath(conversationName, home);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // A workspace we cannot create is one the run will fail on anyway, loudly.
  }
  return dir;
}
