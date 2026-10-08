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
 * WHERE pi RUNS BEFORE A CHAT HAS EARNED A FOLDER.
 *
 * A conversation's folder is named from its first message, so at boot there is
 * no name yet. Resolving one anyway — with the literal string "new chat" — is
 * what the app did, and it cost more than clutter: pi spawned in
 * `~/Bobble/new-chat` and recorded that as its session's working directory, the
 * first message then RENAMED the folder to the message's own slug, and the next
 * restart (the model preload) tried to resume a session whose directory no
 * longer existed. MEASURED on a genuinely fresh profile: pi exits 1 with
 * "Stored session working directory does not exist", the app recovers by
 * respawning WITH ALL EXTENSIONS DISABLED, and the user — mid first message —
 * is told "The assistant stopped", 416ms after pressing enter.
 *
 * So before a chat has a name, pi runs in `~/Bobble` itself: it exists, it is
 * one directory rather than one per conversation, and nothing ever renames it.
 * The chat's real folder is made on the first send (`ensureChatWorkspace`) and
 * handed to the tools with `/harness workspace`, which needs no respawn.
 */
export function bobbleRootDir(home: string = os.homedir()): string {
  const dir = bobbleBaseDir(home);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* a root we cannot create is one the run will fail on anyway, loudly */
  }
  return dir;
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

/**
 * A folder name from the FIRST USER MESSAGE.
 *
 * The generated chat title would be nicer, but it does not exist yet: it is
 * derived FROM the first message, and by the time it lands a corp run has
 * already created `.scratch` in the placeholder — which correctly blocks the
 * rename, because moving a directory under a running team makes paths the model
 * has already used stop existing. MEASURED: every clean run ended up stuck at
 * `~/Bobble/new-chat`.
 *
 * The first message is available the instant the user hits enter, before any
 * tool runs, so naming from it means no rename is ever needed. Six words, not
 * the whole sentence — an earlier attempt used the raw prompt and produced
 * `build-a-small-command-line-todo-list-tool-in-python.-require`.
 */
export function conversationNameFrom(firstMessage: string): string {
  const words: string[] = firstMessage
    .trim()
    .replace(/^(please|can you|could you|hey|hi|ok|okay)[,\s]+/i, '')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  // A name ending in a preposition reads like a truncation, because it is:
  // "build a todo list tool in" -> "build a todo list tool".
  const TRAILING = new Set([
    'in',
    'on',
    'of',
    'to',
    'a',
    'an',
    'the',
    'with',
    'and',
    'for',
    'at',
    // Relative pronouns and connectors read even worse at the end: measured
    // live, "make me a python script that" was the real output for
    // "Please make me a python script that renames photos by their EXIF date".
    'that',
    'which',
    'who',
    'whose',
    'when',
    'where',
    'from',
    'by',
    'using',
    'about',
    'into',
    'so',
    'is',
    'it',
    'my',
  ]);
  while (words.length > 1 && TRAILING.has((words[words.length - 1] ?? '').toLowerCase())) {
    words.pop();
  }
  const name = words.join(' ');
  return name.length > 0 ? name : 'new chat';
}

/** The absolute path for a projectless conversation's folder. No fs touch. */
export function bobbleProjectPath(name: string, home: string = os.homedir()): string {
  return path.join(bobbleBaseDir(home), projectSlug(name));
}

/**
 * Two chats called the same thing get their own folders.
 *
 * Chat titles are generated, so collisions are ordinary, not exotic: "Godot game
 * demo" twice in an afternoon happened repeatedly while testing. Sharing one
 * directory would let a second chat overwrite the first one's work with no
 * warning, which is the same silent-damage shape as every other path bug here.
 *
 * `owner` keys the folder to the CHAT, so the mapping is stable: the same chat
 * always resolves to the same directory, and a different chat with the same
 * title gets `-2`. Re-running a chat never migrates its files.
 */
/**
 * WHICH FOLDER EACH SAVED CHAT USES — sessionFile → folder, kept by main in
 * `~/.pi/desktop/chat-workspaces.json`.
 *
 * The claim file (`.bobble-chat`) holds the id the renderer passed, and that id
 * is the WINDOW's (pi-connect `conversationId`, sessionStorage), minted again
 * every launch. So a chat reopened after a restart no longer owned its own
 * folder, and resolving it made `~/Bobble/<name>-2`: the chat's later work went
 * to a second folder, and the transcript's relative paths ("Drew …:
 * skills.svg") pointed at a folder without them — the card never came back.
 * MEASURED 2026-10-08 (chart-reentry-probe, RESTART=1): `radar-make-a-radar-
 * chart` held the chart, the reopened chat worked in `…-2`. The session file is
 * the one name a chat keeps across launches, so it decides.
 */
export interface ChatWorkspaceMap {
  [sessionFile: string]: string;
}

export function chatWorkspacesPath(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'chat-workspaces.json');
}

export function readChatWorkspaces(home: string = os.homedir()): ChatWorkspaceMap {
  try {
    const raw = JSON.parse(fs.readFileSync(chatWorkspacesPath(home), 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ChatWorkspaceMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeChatWorkspaces(map: ChatWorkspaceMap, home: string): void {
  try {
    const file = chatWorkspacesPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    /* an unwritable map only costs the next launch a lookup by name */
  }
}

/**
 * The folder for a SAVED chat: its own, by the map; else the first of `base`,
 * `base-2`, … that no other chat's session is mapped to — and, for a chat that
 * is being REOPENED, an existing folder of its name that nobody is mapped to
 * even when its claim names another window: a folder from before this map
 * existed, which is this chat's (the claim's id was only ever a window's).
 */
function chatDir(
  base: string,
  owner: string,
  chat: { sessionFile: string; resumed: boolean },
  map: ChatWorkspaceMap,
): string {
  const takenBy = new Map<string, string>();
  for (const [session, dir] of Object.entries(map)) takenBy.set(dir, session);
  for (let n = 1; n < 200; n += 1) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const claim = path.join(dir, '.bobble-chat');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(claim, owner);
        return dir;
      }
      const other = takenBy.get(dir);
      if (other !== undefined && other !== chat.sessionFile) continue;
      const existing = fs.existsSync(claim) ? fs.readFileSync(claim, 'utf8').trim() : '';
      if (existing === owner || existing === '' || chat.resumed || other === chat.sessionFile) {
        fs.writeFileSync(claim, owner);
        return dir;
      }
    } catch {
      return dir;
    }
  }
  return base;
}

function uniqueDir(base: string, owner: string): string {
  const claimFile = path.join(base, '.bobble-chat');
  for (let n = 1; n < 200; n += 1) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const claim = n === 1 ? claimFile : path.join(dir, '.bobble-chat');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(claim, owner);
        return dir;
      }
      // An existing folder is ours if it carries our id, or if nobody claimed it
      // (a folder the user made by hand should be usable, not skipped).
      const existing = fs.existsSync(claim) ? fs.readFileSync(claim, 'utf8').trim() : '';
      if (existing === owner) return dir;
      if (existing === '') {
        fs.writeFileSync(claim, owner);
        return dir;
      }
    } catch {
      return dir; // unreadable/unwritable — the caller will fail loudly, not silently
    }
  }
  return base;
}

/** Is `dir` an EMPTY folder this chat owns? The two conditions for a safe
 * rename: nobody else's, and nothing in it to move. `.bobble-chat` is the claim
 * file and does not count as content. */
function ownsEmptyDir(dir: string, owner: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    const claim = path.join(dir, '.bobble-chat');
    if (!fs.existsSync(claim) || fs.readFileSync(claim, 'utf8').trim() !== owner) return false;
    return fs.readdirSync(dir).filter((f) => f !== '.bobble-chat').length === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace. THE dropdown wins; otherwise `~/Bobble/<name>`.
 *
 * `selected` is the composer's folder selection — null/empty means "No project".
 * A selected project is used EXACTLY as given: no slugging, no de-duplication,
 * no surprises. the user: "that dropdown right there is the end all be all ... always
 * always always nothing competes with that."
 *
 * The directory is created either way, because a workspace that does not exist
 * is how relative writes end up somewhere else.
 */
export function resolveProjectDir(
  selected: string | null | undefined,
  conversationName: string,
  home: string = os.homedir(),
  conversationId?: string,
  /** The chat's session file, when it has one, and whether it is being reopened. */
  chat?: { sessionFile: string; resumed: boolean },
): string {
  const chosen = typeof selected === 'string' ? selected.trim() : '';
  if (chosen !== '') {
    const dir = path.resolve(chosen);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // A workspace we cannot create is one the run will fail on anyway, loudly.
    }
    return dir;
  }
  const base = bobbleProjectPath(conversationName, home);
  if (conversationId === undefined || conversationId === '') {
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      /* see above */
    }
    return base;
  }
  /*
   * THE TITLE ARRIVES AFTER THE FOLDER IS NEEDED.
   *
   * A chat is nameless at its first turn — the harness derives a title from the
   * first message — so the folder gets made as `new-chat` and renamed once the
   * real name lands. MEASURED on the first clean run: `~/Bobble/new-chat`
   * appeared, and without this a second folder would have been created under the
   * real title, splitting one chat's work across two places.
   *
   * ONLY while the folder is still empty. Once anything has been written, the
   * name is cosmetic and moving files under a running team is not worth it —
   * paths the model has already used would stop existing mid-turn.
   */
  const placeholder = bobbleProjectPath('new chat', home);
  const map = chat === undefined ? null : readChatWorkspaces(home);
  // A saved chat's own folder first, while it still exists.
  if (chat !== undefined && map !== null) {
    const known = map[chat.sessionFile];
    if (known !== undefined && fs.existsSync(known)) return known;
  }
  const remember = (dir: string): string => {
    if (chat !== undefined && map !== null && map[chat.sessionFile] !== dir) {
      writeChatWorkspaces({ ...map, [chat.sessionFile]: dir }, home);
    }
    return dir;
  };
  if (base !== placeholder && ownsEmptyDir(placeholder, conversationId)) {
    try {
      fs.renameSync(placeholder, base);
      return remember(base);
    } catch {
      /* a rename we cannot do is not worth failing the run over */
    }
  }
  if (chat !== undefined && map !== null) return remember(chatDir(base, conversationId, chat, map));
  return uniqueDir(base, conversationId);
}
