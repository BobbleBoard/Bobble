/**
 * FINDING THE MEDIA A TURN JUST MADE, so the thread can show it.
 *
 * the user: "I should be able to go to a new chat and ask for any of these types of
 * media or files, all are delivered and embedded cleanly and in full quality
 * into the chat aswell as with a file presentation card(s) to export/reveal."
 *
 * WHY THIS PARSES TEXT, WHICH IS NORMALLY A SMELL. `ToolResultMsg` — the only
 * shape the renderer gets — carries `toolName`, `text` and `isError`. The
 * structured `details` a tool returns is consumed on the agent side and never
 * reaches the store, so the paths are genuinely only available as prose.
 *
 * It is safe HERE and would not be in general, because both ends of this string
 * are ours: the generate tools in `@pi-desktop/gen-tools` emit a numbered list of
 * absolute paths and this reads it back. The tool name gate is what keeps it
 * honest — an arbitrary tool that happens to mention a .png in its output does
 * not get its file mounted as a player in the transcript.
 *
 * The alternative, threading `details` through the engine's event router and the
 * store, is the right long-term fix and a much larger change to a hot path; this
 * is deliberately the small one, marked so it can be replaced.
 */

/**
 * The generate tools whose output we mount. Anything else is left as text.
 *
 * `edit_image` belongs here and was missing: an edit produces a NEW picture,
 * beside the original, and it reached the thread as a line of prose with a path
 * in it while the identical file from `generate_image` got the full card. The
 * whole iterate loop — make one, change it, change it again — ran on the one
 * tool whose output was never shown.
 */
export const MEDIA_TOOLS: ReadonlySet<string> = new Set([
  'generate_image',
  'edit_image',
  'generate_video',
  'generate_speech',
  'generate_music',
  'generate_sfx',
]);

/**
 * The app's own media URL, and the plain path it names.
 *
 * `pd-file://f/Users/…` and `/Users/…` are the SAME FILE, and the image tools
 * return both (line 1 the URL for the renderer, line 2 the path for a follow-up
 * edit — see packages/harness/src/tools/image-tools.ts). The path scanner below
 * matched inside the URL as well, so every generated picture mounted TWICE:
 * once correctly, and once as `//f/Users/…`, a path that exists nowhere and
 * renders as a broken card directly under the real one.
 *
 * A URL is also the STRONGER of the two readings, which is why it is read first
 * rather than merely excluded. It is a single delimited token, so it survives a
 * filename with a space in it — which the bare-path scanner deliberately cannot
 * (see {@link PATH_RX}) — and it is present even when the tool names the file no
 * other way.
 */
const PD_FILE_RX = /pd-file:\/\/f(\/[^\s()]*)/g;

/** `pd-file://f/Users/a%20b/x.png` → `/Users/a b/x.png`, or undefined. */
export function pdFilePath(url: string): string | undefined {
  const m = /^pd-file:\/\/f(\/.*)$/.exec(url.trim());
  if (m === null) return undefined;
  try {
    return (m[1] as string)
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');
  } catch {
    return undefined; // an undecodable URL names nothing we can open
  }
}

/**
 * `model` is 3D. It joins the other three because a generated mesh is shown the
 * same way they are — a card in the thread that made it — and the card is one
 * component with four surfaces rather than four components.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'model';

export interface ThreadMediaItem {
  /** Absolute path on disk. */
  readonly path: string;
  readonly kind: MediaKind;
  /** File name for the presentation card. */
  readonly name: string;
  /**
   * Provenance, when the caller knows it — carried so "Open in studio" can hand
   * the room something to work FROM rather than an empty composer beside the
   * picture you were just looking at. Absent for media parsed out of a tool
   * result, where only the path is available (see the note at the top).
   */
  readonly prompt?: string;
  readonly seed?: number;
  readonly model?: string;
}

const EXT: Readonly<Record<string, MediaKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  wav: 'audio',
  mp3: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  glb: 'model',
  gltf: 'model',
  obj: 'model',
  ply: 'model',
  stl: 'model',
};

/*
 * An absolute POSIX path ending in a media extension.
 *
 * Bounded deliberately: the path may not contain whitespace, which is a real
 * limitation and the right trade here — the generated-output directories are
 * ours and slug-named, and a greedy pattern that allowed spaces would swallow
 * the rest of the sentence (" (seed 7)") into the filename on every line.
 */
const PATH_RX = /(\/[^\s()]+\.([A-Za-z0-9]+))/g;

/**
 * Every media file a generate-tool result mentions, in the order it listed them.
 *
 * Returns nothing for a tool we do not own, for an errored result, or for output
 * that names no recognised media — all three of which should render as the plain
 * text they already are.
 */
export function mediaFromToolResult(
  toolName: string | undefined,
  textIn: string | undefined,
  isError?: boolean,
): ThreadMediaItem[] {
  let text = textIn;
  if (toolName === undefined || !MEDIA_TOOLS.has(toolName)) return [];
  if (isError === true) return [];
  if (typeof text !== 'string' || text.length === 0) return [];

  /*
   * "SAVED TO:" IS THE SAME PICTURE, WHERE THE USER ASKED FOR IT. The image
   * tool's text lists the generated file, then — when `save_to` was given —
   * the copy it made. Both are paths; mounting both showed the picture twice,
   * and the second one broken: the copy lives outside the app's media root,
   * which pd-file:// does not serve (SEEN: "fox-under-oak-tree.png · 9 B").
   * So the copies are read for their NAMES, the generated files for their
   * pixels, and the card is one card called what the user called it.
   */
  /*
   * …AND A DESTINATION THAT COULD NOT BE WRITTEN IS NOT A PICTURE. The tool
   * says "Could not save to /cow-on-the-moon.png: EACCES" (SEEN 2026-09-15: a
   * 4B asked for `--save_to=/cow-on-the-moon.png`, the root of the disk), and
   * that path scanned like any other — a second card, "9 B", for a file that
   * does not exist. The line is a sentence about a failure; drop it before
   * the scan.
   */
  text = text.replace(/^Could not save to .*$/gm, '');
  const savedIdx = text.indexOf('\nSaved to:');
  const savedNames: string[] = [];
  if (savedIdx !== -1) {
    const savedBlock = text.slice(savedIdx).split('\nModel:')[0] ?? '';
    for (const m of savedBlock.matchAll(PATH_RX)) {
      const p = m[1];
      if (p !== undefined) savedNames.push(p.split('/').pop() ?? p);
    }
    text = text.slice(0, savedIdx);
  }

  const seen = new Set<string>();
  const out: ThreadMediaItem[] = [];

  const add = (path: string, ext: string): void => {
    const kind = EXT[ext.toLowerCase()];
    if (kind === undefined) return;
    // A turn that produced four candidates lists four paths; a turn that names
    // the same file twice (its URL and its path) should still mount it once.
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, kind, name: path.split('/').pop() ?? path });
  };

  /*
   * THE APP'S OWN URLs FIRST, then the same text with them — and the paths they
   * name — struck out. A file named both ways has to mount once, and reading the
   * URL first is what makes that reliable rather than lucky: the prose spelling
   * of a path with a space in it is one the bare scanner can only read the tail
   * of ("/fox/cand0.png"), which would have mounted as a second, broken card
   * beside the real one instead of being recognised as the same file.
   */
  let rest = text.replace(PD_FILE_RX, ' ');
  for (const match of text.matchAll(PD_FILE_RX)) {
    const path = pdFilePath(match[0]);
    if (path === undefined) continue;
    add(path, path.split('.').pop() ?? '');
    rest = rest.split(path).join(' ');
  }
  for (const match of rest.matchAll(PATH_RX)) {
    const path = match[1];
    if (path === undefined) continue;
    add(path, match[2] ?? '');
  }
  return out.map((item, i) => {
    const name = savedNames[i];
    return name !== undefined ? { ...item, name } : item;
  });
}

/** Bytes → a short human size for the presentation card. */
export function humanSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Seconds → `m:ss`, for an audio/video transport. */
export function clockTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
