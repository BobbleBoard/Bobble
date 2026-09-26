/**
 * HYPERFRAMES TEMPLATES — a text prompt becomes a designed card, never a
 * printout of the prompt (VQ-11 lite: the title card).
 *
 * REAL, twice: the user asked for "10-second animated title card with the text
 * 'Launch day' in bright yellow bold letters centered on a dark gradient
 * background with subtle pulse animation", and the card said exactly that —
 * the whole instruction, white on navy, "bright yellow" ignored. His radar
 * request came out the same way. `buildSceneDocument` put any prompt that was
 * not HTML into an `<h1>` as it stood.
 *
 * What a person means by that prompt is plain: the words in quotes are the
 * words on the card, "bright yellow" is the colour of the letters, "dark
 * gradient" is the ground, "pulse" is how it moves. This reads exactly that —
 * deterministically, no model — and fills a title-card template. What it
 * cannot read, it says, instead of guessing:
 *
 *   - a title card with no words to show → put the words in quotes;
 *   - a DESCRIPTION of a picture ("a bouncing ball", "an animated radar
 *     chart") → HyperFrames draws HTML: write the scene, or use the chart
 *     tool / a video model.
 *
 * Words in quotes are printed exactly as written, whatever surrounds them.
 * Without quotes the words are found where people put them — after "saying",
 * "titled", "the words", a colon, before "title card", after "for" — and any
 * instruction still riding on them ("in yellow", "on a navy background",
 * "fading in", ", 10 seconds") is cut off: an instruction on the card is the
 * bug this file exists for. Instructions are told from titles by case, the
 * way people write them: "Launch day in yellow" is a card in yellow, "Men in
 * Black" is a title.
 *
 * A prompt that is not a request at all ("Bobble makes motion graphics",
 * "Launch day") IS the words, and becomes the card as before.
 *
 * Pure: parsing and the document are unit-tested; hyperframes-still.ts drives
 * the window.
 */

import { contrastRatio, fromOklch, normalizeHex, oklch } from '@pi-desktop/charts';

/** What the title card shows and how. */
export interface TitleCard {
  readonly title: string;
  readonly tagline?: string;
  /** The colour of the words, when the prompt named one. */
  readonly ink?: string;
  /** The ground's colour, when the prompt named one. */
  readonly paper?: string;
  /** A light ground ("on white"); dark by default. */
  readonly light: boolean;
  /** A slow breathing after the entrance ("pulse", "glow", "breathe"). */
  readonly pulse: boolean;
  /** Heavier letters ("bold"). */
  readonly bold: boolean;
  /**
   * The letters drop in one after another and land with a bounce ("bouncing
   * in", "bouncy", "playful", "pop in"). The rise is the default entrance, and
   * a playful intro asked for with a bounce that rose like a keynote slide
   * would be the prompt ignored — the same bug as "bright yellow" ignored.
   */
  readonly bounce?: boolean;
}

export type MotionPlan =
  | { readonly kind: 'scene' }
  | { readonly kind: 'title-card'; readonly card: TitleCard }
  | {
      readonly kind: 'refuse';
      readonly reason: 'needs-words' | 'needs-scene';
      readonly message: string;
    };

/** The message a title card with no words gets — the fix, in one line. */
export const NEEDS_WORDS =
  'A HyperFrames title card shows the words it is given, and this prompt names none. Put them in quotes — a title card "Launch day" with the tagline "Doors open at nine" — or pass the scene itself as HTML.';

/** The message a description of a picture gets. */
export const NEEDS_SCENE =
  'HyperFrames draws motion graphics from HTML, not from a description. A title card takes its words in quotes ("Launch day"); anything else is a scene you write — HTML with CSS @keyframes animations, or a window.hyperframesSeek(t) function — passed as the prompt. A chart is the chart tool; footage is a video model.';

/** Does this look like a scene the model authored, rather than a text prompt? */
export function looksLikeScene(prompt: string): boolean {
  return /<\s*(html|body|div|svg|canvas|style|section|main|h1)\b/i.test(prompt);
}

/**
 * The quoted strings of a prompt, in order: "…", “…”, and '…' / ‘…’ when the
 * single quotes open and close words (so "it's" and "Tidewell's" are not quotes).
 */
export function quotedStrings(prompt: string): string[] {
  const out: { at: number; text: string }[] = [];
  const push = (re: RegExp): void => {
    for (const m of prompt.matchAll(re)) {
      const text = (m[1] ?? '').trim();
      if (text !== '' && m.index !== undefined) out.push({ at: m.index, text });
    }
  };
  push(/"([^"\n]{1,120})"/g);
  push(/“([^”\n]{1,120})”/g);
  push(/(?<![\p{L}\p{N}])'(\S(?:[^'\n]{0,118}\S)?)'(?![\p{L}\p{N}])/gu);
  push(/‘([^’\n]{1,120})’/g);
  return out.sort((a, b) => a.at - b.at).map((q) => q.text);
}

/** A prompt with its quoted words blanked out: what is left is the instruction. */
function unquoted(prompt: string): string {
  return prompt
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    .replace(/(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, ' ');
}

const DURATION_RE =
  /(?<![\p{L}\p{N}'’.])(\d{1,3}(?:\.\d+)?)\s*-?\s*(seconds?|secs?|minutes?|mins?|s)(?![\p{L}\p{N}])/giu;

/**
 * How long a prompt says the clip is, in seconds: "10-second", "6 s", "a 10s
 * intro", "2.5 seconds", "a 1.5 min intro". Words in quotes are the card's,
 * not its length ("Back to the 1990s"), and a decade is not a duration: "the
 * 90s", "'90s" and "1990s" are years, and a bare "s" past a minute ("90s") is
 * read as one too.
 */
export function durationFromPrompt(prompt: string): number | undefined {
  const text = unquoted(prompt);
  for (const m of text.matchAll(DURATION_RE)) {
    const n = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    if (!Number.isFinite(n) || n <= 0) continue;
    if (unit === 's') {
      if (n > 60) continue;
      if (/\bthe\s*$/i.test(text.slice(0, m.index))) continue;
    }
    return unit.startsWith('m') ? n * 60 : n;
  }
  return undefined;
}

// ── colours ─────────────────────────────────────────────────────────────────

/** Colour words for type on a card (a user's colour is honoured as asked). */
const COLOURS: Readonly<Record<string, string>> = {
  yellow: '#FFD60A',
  gold: '#F5C518',
  amber: '#FFB020',
  orange: '#FF8A3D',
  red: '#FF4D4D',
  coral: '#FF6F59',
  pink: '#FF5C8A',
  magenta: '#E0218A',
  rose: '#F0668C',
  teal: '#2EC4B6',
  turquoise: '#30D5C8',
  cyan: '#22D3EE',
  aqua: '#3DDBD9',
  blue: '#4C8DFF',
  navy: '#1F3A5F',
  green: '#34D399',
  lime: '#A3E635',
  mint: '#6EE7B7',
  white: '#FFFFFF',
  black: '#111114',
  grey: '#9CA3AF',
  gray: '#9CA3AF',
  silver: '#C7CDD6',
  cream: '#FBF6EA',
  brown: '#8C5A3C',
  purple: '#A855F7',
  violet: '#8B5CF6',
  lavender: '#C4B5FD',
};

const COLOUR_NAMES = Object.keys(COLOURS).join('|');
const MODIFIER = '(?:bright|vivid|neon|light|pale|pastel|dark|deep)';
const COLOUR_WORD = `(?:(bright|vivid|neon|light|pale|pastel|dark|deep)\\s+)?(${COLOUR_NAMES}|#[0-9a-f]{6}|#[0-9a-f]{3})(?![\\w-])`;
/** Words that say what the colour is OF. */
const LETTERING = '(?:letters|text|type|title|words|font|lettering|headline)';

function colourOf(modifier: string | undefined, word: string): string {
  const base = word.startsWith('#')
    ? normalizeHex(word)
    : (COLOURS[word.toLowerCase()] ?? '#FFFFFF');
  if (modifier === undefined) return base;
  const { l, c, h } = oklch(base);
  const m = modifier.toLowerCase();
  if (m === 'bright' || m === 'vivid' || m === 'neon') {
    // The same colour at full strength: as saturated as the screen can show it
    // at that lightness (fromOklch stops at the gamut's edge), never paler.
    // MEASURED on the REAL prompt: lifting the lightness instead turned "bright
    // yellow" into cream (#FFE28F), and "bright white" into grey. White, grey
    // and black have no hue to push, so they stay as they are.
    return c < 0.03 ? base : fromOklch(l, 0.4, h);
  }
  if (m === 'light' || m === 'pale' || m === 'pastel')
    return fromOklch(Math.min(0.95, l + 0.14), c * 0.6, h);
  return fromOklch(Math.max(0.18, l - 0.18), c, h); // dark, deep
}

/**
 * The colours a prompt names, and for what: "on a navy background", "on
 * black" and "white on black" name the ground; "in bright yellow", "yellow
 * letters", "a pink neon title", "in our brand teal" name the words. Words in
 * quotes are the card's content, never its colours ("Out of the Blue").
 */
export function colourWords(prompt: string): { ink?: string; paper?: string } {
  const text = unquoted(prompt);
  const out: { ink?: string; paper?: string } = {};
  const paper = new RegExp(
    `\\b(?:on|against|over)\\s+(?:an?\\s+|the\\s+)?${COLOUR_WORD}(?:\\s+(?:gradient|radial))?(?:\\s+(?:background|backdrop|ground|plate))?(?!\\s+${LETTERING})|\\b${COLOUR_WORD}\\s+(?:background|backdrop)\\b`,
    'i',
  ).exec(text);
  if (paper !== null) {
    const [modifier, word] = paper[2] !== undefined ? [paper[1], paper[2]] : [paper[3], paper[4]];
    if (word !== undefined) out.paper = colourOf(modifier, word);
  }
  const ink = new RegExp(
    [
      `\\b${COLOUR_WORD}(?:\\s+(?:bold|thin|heavy|large|big|italic|neon|glowing|bright|animated))?\\s+${LETTERING}\\b`,
      `\\bin\\s+(?:(?:our|the|a|my|your)\\s+)?(?:brand\\s+)?${COLOUR_WORD}`,
      `\\bbrand\\s+${COLOUR_WORD}`,
      `\\b${COLOUR_WORD}\\s+on\\s+(?:an?\\s+|the\\s+)?${MODIFIER}?\\s*(?:${COLOUR_NAMES})\\b`,
    ].join('|'),
    'i',
  ).exec(text);
  if (ink !== null) {
    const pairs: Array<[string | undefined, string | undefined]> = [
      [ink[1], ink[2]],
      [ink[3], ink[4]],
      [ink[5], ink[6]],
      [ink[7], ink[8]],
    ];
    const hit = pairs.find(([, w]) => w !== undefined);
    // A ground phrase is not the words' colour.
    if (hit?.[1] !== undefined && !(paper !== null && paper.index === ink.index)) {
      out.ink = colourOf(hit[0], hit[1]);
    }
  }
  if (out.ink === undefined && out.paper === undefined) {
    // "Launch day title card, yellow, 10 seconds": one colour, said on its own,
    // is the words' colour.
    const lone = [...text.matchAll(new RegExp(`\\b${COLOUR_WORD}`, 'gi'))];
    if (lone.length === 1 && lone[0]?.[2] !== undefined) {
      out.ink = colourOf(lone[0][1], lone[0][2]);
    }
  }
  return out;
}

// ── what the prompt asks for ────────────────────────────────────────────────

const LEAD_VERB =
  /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:make|create|generate|render|design|build|animate|produce|draw|show|give|do|write|add|put|need|want|i\s+(?:want|need|would\s+like|'d\s+like)|let'?s)\b/i;
/** The words that say WHAT is being asked for — a card of words, or a picture that moves. */
const TITLE_KINDS =
  'title\\s*cards?|title\\s*sequences?|titles?|intros?|outros?|end\\s*cards?|lower\\s*thirds?|kinetic\\s*typography|typography|wordmarks?|headlines?|captions?|banners?|splash(?:\\s*screen)?|openers?|bumpers?|text\\s*animations?|animated\\s*(?:text|titles?|words?|captions?|headlines?)|cards?';
const PICTURE_KINDS =
  'motion\\s*graphics?|animations?|animated|animate|explainers?|slideshows?|clips?|videos?|scenes?|logo\\s*reveals?|loops?|gifs?';
const KIND_AT_START = new RegExp(
  `^(?:(?:an?|the|one|my|our|some)\\s+)?(?:[\\w-]+\\s+){0,2}?(?:${TITLE_KINDS}|${PICTURE_KINDS})\\b`,
  'i',
);
const KIND_BARE_START = new RegExp(`^(?:${TITLE_KINDS}|${PICTURE_KINDS})\\b`, 'i');
const TITLE_KIND = new RegExp(`\\b(?:${TITLE_KINDS})\\b`, 'i');
/** The nouns a card of words is called when a name comes before them: "Launch day title card". */
const CARD_NOUNS =
  'title\\s*cards?|title\\s*sequences?|intros?|outros?|end\\s*cards?|lower\\s*thirds?|banners?|openers?|bumpers?|splash(?:\\s*screen)?|wordmarks?';
const CARD_NOUN_AFTER_WORDS = new RegExp(`\\S\\s+(?:${CARD_NOUNS})(?![\\w-])`, 'i');

/**
 * Is this prompt ASKING for something (so its words are instructions), or is
 * it the words themselves? Asking: an imperative ("make …"), a duration
 * ("10-second …"), a kind of thing at its head ("a bold title card …",
 * "animated title …", "title card: …"), or a card named after its words
 * ("Launch day title card"). "Bobble makes motion graphics" and "Launch day"
 * are the words.
 */
export function isRequest(prompt: string): boolean {
  const p = prompt.trim();
  if (LEAD_VERB.test(p) || durationFromPrompt(p) !== undefined || KIND_BARE_START.test(p)) {
    return true;
  }
  if (CARD_NOUN_AFTER_WORDS.test(unquoted(p))) return true;
  // "a bold title card …": an article, up to two words, then the kind.
  return /^(?:an?|the|one|my|our|some)\s/i.test(p) && KIND_AT_START.test(p);
}

// ── the words on the card ───────────────────────────────────────────────────

/*
 * Where an instruction starts inside a run of words. CASE-SENSITIVE on
 * purpose: instructions are written in lower case ("Launch day in yellow"),
 * titles in title case ("Men in Black", "Dancing In The Dark").
 */
const STYLE_CLAUSE = new RegExp(
  `(?:^|[\\s,;:—–]+)(?:${[
    // "in yellow", "in our brand teal", "on navy", "in bright yellow"
    `(?:in|on|against|over)\\s+(?:(?:an?|the|our|my|your)\\s+)?(?:brand\\s+)?(?:${MODIFIER}\\s+)?(?:${COLOUR_NAMES}|#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)(?![\\w-])`,
    // "on a dark gradient background", "with a subtle pulse", "in bold letters"
    `(?:in|on|with|against|over|using)\\s+(?:[\\w#-]+\\s+){0,4}?(?:background|backdrop|gradient|letters|lettering|font|typeface|pulse|glow|animation|motion)(?![\\w-])`,
    // "centered on …", "fading in", "that pulses"
    `(?:centered|centred|left-aligned|right-aligned)(?![\\w-])`,
    `(?:fading|sliding|rising|pulsing|glowing|zooming|wiping|typing|bouncing|spinning|flying|popping|dropping|scrolling)\\s+(?:in|on|out|up|down|into|onto|across)(?![\\w-])`,
    `(?:that|which)\\s+(?:pulses|glows|fades|slides|rises|zooms|wipes|types|bounces|spins|pops|drops|scrolls|animates)(?![\\w-])`,
  ].join('|')})`,
);

/**
 * A bare colour, length or instruction after a comma or dash: "Coming soon,
 * gold", "Launch day — 10 seconds", "Hello, make it pulse". Lower case, like
 * STYLE_CLAUSE ("Launch Day, Gold Edition" is a title).
 */
const TAIL_CLAUSE = new RegExp(
  `\\s*[,;—–]\\s*(?:(?:${MODIFIER}\\s+)?(?:${COLOUR_NAMES})(?=\\s*(?:$|[,;.!]|on\\s|and\\s|letters|text|background))|\\d+(?:\\.\\d+)?\\s*-?\\s*(?:seconds?|secs?|s|minutes?|mins?)(?![\\w-])|(?:make|use|please|lasting)\\s|(?:animated|bold|pulsing|glowing)(?=\\s*(?:$|[,;.])))`,
);

/** Where a tagline is named after the title: "… and a tagline Doors open at nine". */
const TAGLINE_LABEL =
  /\s*[,;]?\s+(?:and|with)\s+(?:a\s+|the\s+)?(?:tagline|subtitle|subtext|strapline|subheading)(?:\s+(?:of|saying|that\s+says|reading|that\s+reads))?\s*:?\s+/i;

/** Words that describe a card rather than name it. */
const DESCRIPTORS = new Set(
  `a an the my our your this that some one animated simple cool minimal minimalist modern elegant big
  bold short quick fancy clean dark light colorful colourful nice new great stylish sleek fun epic
  cinematic retro vintage neon glowing pulsing moving dynamic kinetic motion text video youtube
  animation typographic gradient bright subtle smooth slick professional corporate little small
  large huge custom looping looped 3d 2d flat basic plain classic fresh creative awesome beautiful
  playful serious dramatic title intro`.split(/\s+/),
);
const FUNCTION_WORDS = new Set('to of for in on at with and or the a an by from'.split(' '));

function isDescriptor(word: string): boolean {
  const w = word.toLowerCase();
  return (
    DESCRIPTORS.has(w) ||
    COLOURS[w] !== undefined ||
    /^(?:\d+(?:\.\d+)?-?(?:s|secs?|seconds?|mins?|minutes?)|\d+)$/.test(w)
  );
}

/** Only colour, weight or size words ("yellow", "bold", "big red") — not words to show. */
function onlyStyleWords(text: string): boolean {
  return text
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => isDescriptor(w) || new RegExp(`^${MODIFIER}$`, 'i').test(w));
}

/**
 * The words of a phrase with every instruction riding on it cut off: "Launch
 * day in bright yellow letters centered on …" → "Launch day". A final full
 * stop goes (a card is not a sentence); "!", "?" and "…" are the words'.
 */
export function withoutInstructions(text: string): string {
  let t = text;
  for (const re of [STYLE_CLAUSE, TAIL_CLAUSE]) {
    const m = re.exec(t);
    if (m !== null) t = t.slice(0, m.index);
  }
  return t
    .replace(/[\s,;:—–-]+$/u, '')
    .replace(/(?<!\.)\.$/, '')
    .trim();
}

/** A phrase of words to show, from where a label left off: to the end of its sentence, instructions cut. */
function phraseFrom(text: string, opts: { commaEnds?: boolean } = {}): string {
  const sentence =
    text.split(
      opts.commaEnds === true ? /[.;,](?:\s|$)|(?<=[!?])\s+/ : /[.;](?:\s|$)|(?<=[!?])\s+/,
    )[0] ?? '';
  const words = withoutInstructions(sentence)
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return onlyStyleWords(words) ? '' : words;
}

/** Split "Launch day and a tagline Doors open at nine" into its title and tagline. */
function splitTagline(phrase: string): { title: string; tagline?: string } {
  const m = TAGLINE_LABEL.exec(phrase);
  if (m === null) return { title: phrase };
  const tagline = phraseFrom(phrase.slice(m.index + m[0].length));
  return { title: phrase.slice(0, m.index), ...(tagline !== '' ? { tagline } : {}) };
}

/** "with the text Launch day in yellow" / "saying …" / "titled …" / "the words …" / "…: Launch day". */
function labelledWords(prompt: string): { title: string; tagline?: string } | undefined {
  const m =
    /\b(?:with\s+the\s+(?:text|words?|title|headline|caption|phrase|line)|with\s+(?:text|words)|the\s+(?:words?|phrase|text|line)|saying|that\s+says|which\s+says|reading|that\s+reads|which\s+reads|titled|entitled|called|named)\s+(.+)$/i.exec(
      prompt,
    );
  if (m?.[1] !== undefined) {
    const { title, tagline } = splitTagline(m[1]);
    const words = phraseFrom(title);
    if (words !== '' && words.split(/\s+/).length <= 10) {
      return { title: words, ...(tagline !== undefined ? { tagline } : {}) };
    }
  }
  // "title card: Launch day" — only when what comes before the colon is a
  // card of words; "a radar chart of my skills: speed 8, power 6" is data.
  const colon = /:\s*([^:]+)$/.exec(prompt);
  if (colon?.[1] !== undefined && TITLE_KIND.test(prompt.slice(0, colon.index))) {
    const { title, tagline } = splitTagline(colon[1]);
    const words = phraseFrom(title);
    if (words !== '' && words.split(/\s+/).length <= 10 && !isRequest(words)) {
      return { title: words, ...(tagline !== undefined ? { tagline } : {}) };
    }
  }
  return undefined;
}

/**
 * "Launch day title card, yellow, 10 seconds" → "Launch day": a name set
 * before the kind of card. A name starts with a capital or a digit, and is not
 * a description ("animated title card", "my YouTube intro").
 */
function nameBeforeKind(prompt: string): string | undefined {
  const m = new RegExp(`^(?:(?:an?|the)\\s+)?(.+?)\\s+(?:${CARD_NOUNS})(?![\\w-])`, 'i').exec(
    prompt.trim(),
  );
  if (m?.[1] === undefined || LEAD_VERB.test(m[1])) return undefined;
  const words = m[1].split(/\s+/).filter((w) => w !== '');
  while (words.length > 0 && isDescriptor(words.at(-1) as string)) words.pop();
  if (words.length === 0 || words.length > 6) return undefined;
  if (words.some(isDescriptor) || FUNCTION_WORDS.has((words.at(-1) as string).toLowerCase())) {
    return undefined;
  }
  if (!/^[\p{Lu}\p{N}]/u.test(words[0] as string)) return undefined;
  const name = withoutInstructions(words.join(' '));
  return name === '' ? undefined : name;
}

/** "a title card for the Tidewell launch" → "Tidewell launch" (the user's words for its subject). */
function subjectWords(prompt: string): string | undefined {
  const m =
    /\b(?:for|about|announcing|introducing|celebrating|welcoming)\s+(?:the|our|my|a|an|your)?\s*(.+)$/i.exec(
      prompt,
    );
  if (m?.[1] === undefined) return undefined;
  const phrase = phraseFrom(m[1], { commaEnds: true });
  if (phrase === '' || phrase.split(/\s+/).length > 6) return undefined;
  if (durationFromPrompt(phrase) !== undefined || isRequest(phrase)) return undefined;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** `text` with the first appearance of `phrase` (any case) blanked out. */
function without(text: string, phrase: string | undefined): string {
  if (phrase === undefined || phrase === '') return text;
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + phrase.length)}`;
}

/** The words on the card, found as {@link planMotion} describes — or which refusal applies. */
function wordsOf(p: string): { title: string; tagline?: string } | 'needs-words' | 'needs-scene' {
  // Words in quotes are the words on the card, whatever surrounds them.
  const quoted = quotedStrings(p);
  if (quoted.length > 0) {
    return {
      title: quoted[0] as string,
      ...(quoted[1] !== undefined ? { tagline: quoted[1] } : {}),
    };
  }
  if (!isRequest(p)) {
    // The prompt is the words, less any instruction riding on them. (A long
    // paragraph is not a title: that is a description, and printing it is the
    // bug this file exists for.)
    const { title, tagline } = splitTagline(p);
    const words = withoutInstructions(title);
    if (words === '' || onlyStyleWords(words)) return 'needs-words';
    if (words.split(/\s+/).length > 12) return 'needs-scene';
    return { title: words, ...(tagline !== undefined ? { tagline } : {}) };
  }
  const labelled = labelledWords(p);
  if (labelled !== undefined) return labelled;
  const named = nameBeforeKind(p);
  if (named !== undefined) return { title: named };
  if (TITLE_KIND.test(p)) {
    const subject = subjectWords(p);
    return subject !== undefined ? { title: subject } : 'needs-words';
  }
  return 'needs-scene';
}

/**
 * What to do with a prompt: a scene (pass through), a title card (with what it
 * says, how it looks), or a refusal that names the fix.
 */
export function planMotion(prompt: string): MotionPlan {
  const p = prompt.trim();
  if (looksLikeScene(p)) return { kind: 'scene' };
  if (p === '') return { kind: 'refuse', reason: 'needs-words', message: NEEDS_WORDS };
  const words = wordsOf(p);
  if (words === 'needs-words')
    return { kind: 'refuse', reason: 'needs-words', message: NEEDS_WORDS };
  if (words === 'needs-scene')
    return { kind: 'refuse', reason: 'needs-scene', message: NEEDS_SCENE };
  // How it looks is read from the instruction — the prompt less its words — so
  // "Men in Black" and "Be brave, bold and kind" are titles, not styles.
  const said =
    quotedStrings(p).length > 0 ? unquoted(p) : without(without(p, words.title), words.tagline);
  const colours = colourWords(said);
  const card: TitleCard = {
    title: words.title,
    ...(words.tagline !== undefined && words.tagline !== '' ? { tagline: words.tagline } : {}),
    ...(colours.ink !== undefined ? { ink: colours.ink } : {}),
    ...(colours.paper !== undefined ? { paper: colours.paper } : {}),
    light:
      /\b(?:on|against|over)\s+(?:an?\s+|the\s+)?(?:white|light|bright|cream|pale)\b/i.test(said) &&
      !/\bdark\b/i.test(said),
    pulse: /\b(?:pulse|pulses|pulsing|breathe|breathing|glow|glowing|throb|beat)\b/i.test(said),
    bold: /\b(?:bold|heavy|chunky|thick)\b/i.test(said),
    bounce:
      /\b(?:bounc(?:e|es|ed|ing|y)|spring(?:y|s|ing)?|playful|pop(?:s|ping)?\s+in|jump(?:s|ing)?\s+in)\b/i.test(
        said,
      ),
  };
  return { kind: 'title-card', card };
}

// ── the document ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mix two hex colours: t = 0 → a, 1 → b. */
function mix(a: string, b: string, t: number): string {
  const ca = normalizeHex(a);
  const cb = normalizeHex(b);
  const ch = (i: number): string =>
    Math.round(
      Number.parseInt(ca.slice(i, i + 2), 16) * (1 - t) +
        Number.parseInt(cb.slice(i, i + 2), 16) * t,
    )
      .toString(16)
      .padStart(2, '0');
  return `#${ch(1)}${ch(3)}${ch(5)}`.toUpperCase();
}

/** The resolved colours of a card: ground, words, tagline, glow — readable by construction. */
export function cardColours(card: TitleCard): {
  readonly paper: string;
  readonly paperEdge: string;
  readonly ink: string;
  readonly tagline: string;
} {
  let light = card.light;
  let paper = card.paper ?? (light ? '#F7F6F2' : '#0D0F14');
  if (card.paper !== undefined) light = oklch(card.paper).l > 0.6;
  let ink = card.ink ?? (light ? '#15171C' : '#F5F5F7');
  // Words the ground would swallow (navy letters on the night plate): the
  // ground turns over rather than the colour the user asked for.
  if (contrastRatio(ink, paper) < 3) {
    if (card.paper === undefined) {
      light = !light;
      paper = light ? '#F7F6F2' : '#0D0F14';
    } else {
      ink = light ? '#15171C' : '#F5F5F7';
    }
  }
  // The dark plate leans a little toward the words' hue, so a yellow title
  // and a teal one do not sit on the same navy.
  const tint = card.ink !== undefined ? mix(paper, card.ink, light ? 0.05 : 0.1) : paper;
  const paperEdge = light ? mix(paper, '#FFFFFF', 0.6) : mix(tint, '#000000', 0.55);
  const tagline = mix(ink, light ? '#15171C' : '#FFFFFF', 0.45);
  return { paper: tint, paperEdge, ink, tagline };
}

export interface CardSize {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
}

/** A bold display face's average advance, as a share of its size (measured on SF Pro Display Bold). */
const CHAR_WIDTH = 0.56;
/** The tallest a title may set, per line count, as a share of the frame's height. */
const LINE_CAP = [0.17, 0.15, 0.115] as const;

/** The longest line, in characters, of the most even split of `words` into `lines` lines. */
function longestLine(words: readonly string[], lines: number): number {
  const n = words.length;
  const run = (a: number, b: number): number => words.slice(a, b).join(' ').length;
  if (lines <= 1 || n <= 1) return run(0, n);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < n; i++) {
    if (lines === 2) {
      best = Math.min(best, Math.max(run(0, i), run(i, n)));
      continue;
    }
    for (let j = i + 1; j < n; j++)
      best = Math.min(best, Math.max(run(0, i), run(i, j), run(j, n)));
  }
  return best === Number.POSITIVE_INFINITY ? run(0, n) : best;
}

/**
 * How the title is set: one line when it fits large, else two or three
 * balanced lines — a long title set on one thin line reads as a caption, not
 * a title. A split must be worth it (≥ 12% larger) to be taken.
 */
export function titleSetting(
  title: string,
  width: number,
  height: number,
): { readonly lines: number; readonly px: number; readonly measure: number } {
  const words = title.split(/\s+/).filter((w) => w !== '');
  const usable = width * 0.82;
  let best = { lines: 1, px: 0, measure: 0 };
  for (let lines = 1; lines <= Math.min(3, Math.max(1, words.length)); lines++) {
    const longest = Math.max(4, longestLine(words, lines));
    // Down, not to the nearest: a size rounded up can push the line past the measure.
    const px = Math.floor(
      Math.min(height * (LINE_CAP[lines - 1] as number), usable / (longest * CHAR_WIDTH)),
    );
    if (best.px === 0 || px > best.px * 1.12) best = { lines, px, measure: longest };
  }
  return best;
}

/**
 * The title card as a full document at the requested size. Every motion is a
 * CSS animation with a real duration and delay, so the renderer's seek pins it:
 * the title rises in and settles (0–0.9 s), the tagline wipes on after it, and
 * the card then holds — breathing gently when a pulse was asked for, a slow
 * light drifting across the plate otherwise, so the hold is alive. The frame
 * the card settles to is the last one, which is the poster.
 */
export function titleCardDocument(card: TitleCard, size: CardSize): string {
  const { width, height } = size;
  const c = cardColours(card);
  const set = titleSetting(card.title, width, height);
  const titlePx = set.px;
  // Two or three lines: a measure that breaks where the even split does (with
  // a little slack for the face), balanced by the browser.
  const measure =
    set.lines > 1 ? `max-width: ${Math.ceil(set.measure * CHAR_WIDTH * titlePx * 1.12)}px;` : '';
  const tagPx = Math.round(Math.max(14, Math.min(titlePx * 0.36, height * 0.06)));
  const weight = card.bold ? 800 : 700;
  const glow = card.ink !== undefined ? c.ink : c.tagline;
  const tagline =
    card.tagline !== undefined
      ? `<div class="hf-tagline" data-hf-tagline>${escapeHtml(card.tagline)}</div>`
      : '';
  // A bounce drops each letter in on its own beat; a word stays one unit so
  // the balanced lines break between words, never inside one. The whole run
  // lands inside ~1.5 s however long the title is.
  const letters = [...card.title].filter((ch) => ch.trim() !== '').length;
  const step = Math.round(Math.min(70, 900 / Math.max(1, letters)));
  let at = 0;
  const title = card.bounce
    ? card.title
        .split(/(\s+)/)
        .map((part) =>
          part.trim() === ''
            ? part
            : `<span class="hf-w">${[...part]
                .map(
                  (ch) =>
                    `<span class="hf-l" style="animation-delay: ${at++ * step}ms">${escapeHtml(ch)}</span>`,
                )
                .join('')}</span>`,
        )
        .join('')
    : escapeHtml(card.title);
  const entrance = card.bounce ? '' : 'hf-rise 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both, ';
  const settleAt = card.bounce ? (at * step + 1100) / 1000 : 1.2;
  const hold = card.pulse
    ? `hf-breathe 2.4s ease-in-out ${settleAt}s infinite`
    : `hf-settle 1s ease-out ${settleAt}s both`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px;
    overflow: hidden; background: ${c.paper};
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", Roboto, sans-serif; }
  .hf-card { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center; padding: 8%; overflow: hidden;
    background: radial-gradient(120% 90% at 50% 45%, ${c.paper} 0%, ${c.paperEdge} 100%); }
  .hf-card::before { content: ""; position: absolute; inset: -30%; pointer-events: none;
    background: radial-gradient(35% 45% at 50% 50%, ${glow}22 0%, transparent 70%);
    animation: hf-drift ${Math.max(4, size.seconds * 1.2).toFixed(1)}s ease-in-out infinite alternate; }
  .hf-card h1 { position: relative; margin: 0; color: ${c.ink}; font-size: ${titlePx}px; ${measure}
    font-weight: ${weight}; line-height: 1.04; letter-spacing: -0.025em; text-wrap: balance;
    animation: ${entrance}${hold}; }
  .hf-w { display: inline-block; white-space: nowrap; }
  .hf-l { display: inline-block; transform-origin: 50% 100%;
    animation: hf-bounce 1.1s linear both; }
  .hf-tagline { position: relative; margin-top: ${Math.round(titlePx * 0.28)}px; color: ${c.tagline};
    font-size: ${tagPx}px; font-weight: 500; letter-spacing: 0.01em; text-wrap: balance;
    animation: hf-wipe 0.8s cubic-bezier(0.6, 0, 0.2, 1) 0.45s both; }
  @keyframes hf-rise { from { opacity: 0; transform: translateY(18%); letter-spacing: 0.02em; filter: blur(6px); }
    to { opacity: 1; transform: translateY(0); letter-spacing: -0.025em; filter: blur(0); } }
  @keyframes hf-wipe { from { opacity: 0; clip-path: inset(0 100% 0 0); }
    to { opacity: 1; clip-path: inset(0 0 0 0); } }
  @keyframes hf-breathe { 0%, 100% { transform: scale(1); text-shadow: 0 0 0 transparent; }
    50% { transform: scale(1.03); text-shadow: 0 0 ${Math.round(titlePx * 0.35)}px ${glow}66; } }
  @keyframes hf-settle { from { text-shadow: 0 0 ${Math.round(titlePx * 0.3)}px ${glow}44; }
    to { text-shadow: 0 0 0 transparent; } }
  @keyframes hf-bounce {
    0% { opacity: 0; transform: translateY(-120%) scale(0.92, 1.12); animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.5); }
    38% { opacity: 1; transform: translateY(0) scale(1.14, 0.84); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
    58% { transform: translateY(-22%) scale(0.96, 1.05); animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.5); }
    74% { transform: translateY(0) scale(1.05, 0.95); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
    86% { transform: translateY(-6%) scale(1, 1); animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.5); }
    100% { opacity: 1; transform: none; } }
  @keyframes hf-drift { from { transform: translate(-6%, -3%); } to { transform: translate(6%, 3%); } }
</style></head><body><div class="hf-card"><h1 data-hf-title>${title}</h1>${tagline}</div></body></html>`;
}
