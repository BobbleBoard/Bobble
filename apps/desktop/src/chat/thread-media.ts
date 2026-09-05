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

/** The generate tools whose output we mount. Anything else is left as text. */
export const MEDIA_TOOLS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_video',
  'generate_speech',
  'generate_music',
  'generate_sfx',
]);

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
  text: string | undefined,
  isError?: boolean,
): ThreadMediaItem[] {
  if (toolName === undefined || !MEDIA_TOOLS.has(toolName)) return [];
  if (isError === true) return [];
  if (typeof text !== 'string' || text.length === 0) return [];

  const seen = new Set<string>();
  const out: ThreadMediaItem[] = [];
  for (const match of text.matchAll(PATH_RX)) {
    const path = match[1];
    const ext = (match[2] ?? '').toLowerCase();
    const kind = EXT[ext];
    if (path === undefined || kind === undefined) continue;
    // A turn that produced four candidates lists four paths; a turn that
    // mentions the same file twice (path + footnote) should still mount once.
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind, name: path.split('/').pop() ?? path });
  }
  return out;
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
