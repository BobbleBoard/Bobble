/**
 * A PICTURE (OR A SOUND) SYNTHESISED BY SCRIPT WHILE A GENERATOR IS INSTALLED.
 *
 * The same mistake handwritten-svg.ts catches, one modality over, and MEASURED
 * the same way. Asked in chat for "an image of a hand-thrown ceramic mug on a
 * windowsill in morning light", with
 *
 *   media — Create images, video, speech, music and sound effects on-device …
 *
 * in its command list AND the standing line "Do not look for other programs —
 * ffmpeg, sox, say, festival, imaging libraries and the like are not how this
 * works", MiniCPM5 2B probed the shell, reported "ImageMagick and Pillow
 * available", and wrote a 54-line Pillow script that draws a mug out of
 * rectangles and gradients. The prompt names the exact failure and the model
 * does it anyway — which is the finding that justified a guard for SVG and
 * justifies one here: a line among nine abilities does not outweigh what a
 * model already knows how to do.
 *
 * ## What makes this narrow enough to be safe
 * Drawing with code is a perfectly good thing to do — charts, diagrams, test
 * fixtures, procedural art are all legitimate and none of them is what a
 * generator makes. So the test is not "imports PIL". It is the conjunction of:
 *
 *   1. the file is a SCRIPT (by extension),
 *   2. it imports a media-SYNTHESIS library, and
 *   3. it writes out an image/audio/video file, and
 *   4. a generator for that modality is actually registered.
 *
 * A chart script fails (2): matplotlib and friends are deliberately absent from
 * the list, because a chart is a rendering of data, not a picture of something.
 * A script that loads and crops an existing photo fails (2) as well — PIL is on
 * the list only through `ImageDraw`/`Image.new`, which is how you SYNTHESISE.
 *
 * And as with the SVG guard the refusal is crossable: writing the same bytes
 * again puts the file through, because sometimes the script really is the point
 * and a fence that cannot be crossed is the wrong kind.
 */

/** Scripts only. A `.png` written directly is not this problem. */
const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|rb)$/i;

/**
 * Synthesis, not processing. `ImageDraw` and `Image.new` make a picture from
 * nothing; `Image.open` reads one that already exists, and cropping, resizing
 * or compositing a real photo is ordinary work this must not touch.
 */
const SYNTHESISES = [
  /\bImageDraw\b/,
  /\bImage\s*\.\s*new\s*\(/,
  /\bfrom\s+PIL\s+import\b[^\n]*\bImageDraw\b/,
  /\baggdraw\b/,
  /\bcairo\s*\.\s*(?:ImageSurface|Context)\b/,
  /\bwave\s*\.\s*open\s*\([^)]*['"]w/,
  /\bsoundfile\s*\.\s*write\b/,
  /\bscipy\.io\.wavfile\s*\.\s*write\b/,
  /\bmoviepy\b/,
  /\bImageMagick\b|\bconvert\s+-size\b/,
] as const;

/** …and it actually emits a media file. A script that draws into a window is
 * not competing with a generator. */
const WRITES_MEDIA = /\.(png|jpe?g|webp|gif|bmp|tiff?|wav|mp3|flac|ogg|m4a|mp4|webm|mov)\b/i;

/** Which generator would have made this, if one is installed. */
export type MediaKind = 'image' | 'audio' | 'video';

/**
 * A NUMBERED FRAME is a clip, whatever the extension says.
 *
 * MEASURED: asked in chat for a two-second video, a 2B wrote a script that drew
 * sixty PNGs called `frame_0000.png`… and shelled out to ffmpeg afterwards. The
 * script itself never names an `.mp4`, so on extension alone this is an image
 * script and the refusal would have offered `media generate image` for something
 * the user asked to move. The f-string/format placeholder is the tell: nobody
 * numbers ONE picture.
 */
const FRAME_SEQUENCE =
  /\bframes?[_-]?\{?[a-z]?:?0\d*d\}?|\bframes?[_-]?%0\d*d|\bframe[_-]?\{i|\bframes\.append\b/i;

const KIND_HINT: readonly { kind: MediaKind; re: RegExp }[] = [
  { kind: 'video', re: /\.(mp4|webm|mov)\b|\bmoviepy\b/i },
  { kind: 'video', re: FRAME_SEQUENCE },
  { kind: 'audio', re: /\.(wav|mp3|flac|ogg|m4a)\b|\bwave\s*\.\s*open\b|\bsoundfile\b/i },
  { kind: 'image', re: /\.(png|jpe?g|webp|gif|bmp|tiff?)\b|\bImageDraw\b/i },
];

/** The modality this script is synthesising, or null when it is not. */
export function handmadeMediaKind(path: string, content: string): MediaKind | null {
  if (!SCRIPT_EXT.test(path.trim())) return null;
  if (!SYNTHESISES.some((re) => re.test(content))) return null;
  if (!WRITES_MEDIA.test(content)) return null;
  return KIND_HINT.find((k) => k.re.test(content))?.kind ?? 'image';
}

/**
 * Should this write be refused? Only when the generator that would have done
 * the job is registered — with generation off there is nothing to point at, and
 * the script is the only way the model has.
 */
export function isHandmadeMedia(input: {
  path: string;
  content: string;
  available: ReadonlySet<MediaKind>;
}): MediaKind | null {
  const kind = handmadeMediaKind(input.path, input.content);
  return kind !== null && input.available.has(kind) ? kind : null;
}

const COMMAND: Record<MediaKind, string> = {
  image:
    'media generate image "a hand-thrown ceramic mug on a windowsill, morning light" --save-to <folder or file the user named>',
  audio: 'media generate music "warm lo-fi beat, mellow rhodes"',
  video: 'media generate video "a red paper boat drifting across calm water"',
};

/** The same three, as the tools a schemas-mode model calls by name. */
const TOOL_CALL: Record<MediaKind, string> = {
  image:
    'generate_image { prompt: "a hand-thrown ceramic mug on a windowsill, morning light", save_to: "<folder or file the user named>" }',
  audio: 'generate_music { prompt: "warm lo-fi beat, mellow rhodes" }',
  video: 'generate_video { prompt: "a red paper boat drifting across calm water" }',
};

/**
 * A MEDIA FILE WRITTEN AS TEXT. `write` puts characters in a file; a `.png`
 * made that way is broken by construction, whatever is in it. SEEN (4B,
 * bash-CLI, "make one picture of a fox and save it to ~/Pictures/fox-test/"):
 * a Pillow script was refused, and the next move was `write
 * fox_under_oak_tree.png "placeholder"` — twelve times, against the workspace
 * fence, before giving up and telling the user the picture was there. The
 * path it chose is the one useful thing in the call: it is where the picture
 * was meant to go, so the refusal hands it straight to the generator.
 */
const MEDIA_FILE: readonly { kind: MediaKind; re: RegExp }[] = [
  { kind: 'image', re: /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i },
  { kind: 'audio', re: /\.(wav|mp3|flac|ogg|m4a)$/i },
  { kind: 'video', re: /\.(mp4|webm|mov)$/i },
];

/** The modality of a media file a `write` is about to fill with text, or null. */
export function mediaFileKind(path: string): MediaKind | null {
  const p = path.trim();
  return MEDIA_FILE.find((m) => m.re.test(p))?.kind ?? null;
}

/** The refusal for a media file written as text: the generator, aimed at that path. */
export function mediaFileRefusal(
  path: string,
  kind: MediaKind,
  opts: { cli?: boolean } = {},
): string {
  const dest = path.trim();
  const call =
    kind === 'image'
      ? opts.cli === true
        ? `media generate image "<describe the picture>" --save-to ${JSON.stringify(dest)}`
        : `generate_image { prompt: "<describe the picture>", save_to: ${JSON.stringify(dest)} }`
      : opts.cli === true
        ? COMMAND[kind]
        : TOOL_CALL[kind];
  const how =
    opts.cli === true
      ? 'Make it with the generator — run this command with the bash tool:'
      : 'Make it with the generator — call this tool (if it is not in your list, call capability("generation") first):';
  return [
    `Not written: ${dest} is ${NOUN[kind]}, and \`write\` only writes text — a media file made this way is broken whatever it contains. This machine has a generator for that.`,
    '',
    how,
    `  ${call}`,
    kind === 'image'
      ? 'It saves the finished picture at that path for you; then tell the user where it is.'
      : 'Then use the file it produces, and tell the user where it is.',
  ].join('\n');
}

const NOUN: Record<MediaKind, string> = {
  image: 'a picture',
  audio: 'a sound',
  video: 'a clip',
};

/**
 * The refusal: name the generator in the shape THIS mode calls it, and say
 * plainly that the script is not to be run.
 *
 * SEEN (the user's screenshot, a subagent asked for eight illustrations): the old
 * wording "Run it with the bash tool: media generate image …" was read as
 * "run the script with bash" — the model's next line was "Let me run the
 * script using bash instead, as the system suggests." It was also the CLI
 * form, handed to a model in schemas mode that has no such command. "It" is
 * now the generator, by name, in the mode's own syntax; the script is named
 * as the thing NOT to run.
 */
export function handmadeMediaRefusal(
  path: string,
  kind: MediaKind,
  opts: { cli?: boolean } = {},
): string {
  const call = opts.cli === true ? COMMAND[kind] : TOOL_CALL[kind];
  const how =
    opts.cli === true
      ? `Make ${NOUN[kind]} with the generator instead — run this command with the bash tool (one call per ${NOUN[kind].replace(/^an? /, '')}):`
      : `Make ${NOUN[kind]} with the generator instead — call this tool (one call per ${NOUN[kind].replace(/^an? /, '')}; if it is not in your list, call capability("generation") first):`;
  return [
    `Not written: ${path} synthesises ${NOUN[kind]} in code, and this machine has a generator for that. A drawing library makes shapes you described; the generator makes the thing itself, on-device. Do NOT run this script, with bash or otherwise.`,
    '',
    how,
    `  ${call}`,
    'Then use the file it produces, and tell the user where it is.',
    '',
    `If the SCRIPT is genuinely the deliverable (a chart, a diagram, a fixture — something a generator cannot make), write it again UNCHANGED.`,
  ].join('\n');
}
