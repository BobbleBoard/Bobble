/**
 * The card for a job you will be waiting on.
 *
 * From the blind test, the moment that lost her: an image took 293 seconds and
 * the app said nothing for any of them. Her three rules, adopted verbatim:
 *
 *   (a) anything over ~10s gets a card the instant it starts — with the
 *       estimate, a moving timer, and a Cancel;
 *   (b) it must show evidence of life, something that CHANGES;
 *   (c) if it blows the estimate, say so.
 *
 * And the principle underneath them: "cloud apps stream so you never feel the
 * wait. You can't stream an image. So the honest substitute is the number, up
 * front. '2–5 minutes' that turns out to be four is fine. Zero information for
 * 293 seconds is not fine at any duration."
 *
 * ON THIS MAC is meant literally. A shipped range is a guess about someone
 * else's hardware; the range narrows to what this machine has actually done as
 * soon as it has done it twice. See {@link estimateFor}.
 *
 * Pure — no React, no storage. The persistence seam is passed in.
 */

/** The kinds of work worth putting a card in front of. */
export type JobKind = 'image' | 'video' | 'music' | 'speech' | 'sfx' | 'model3d' | 'svg' | 'other';

/** Seconds, low to high — the range the card quotes. */
export interface JobEstimate {
  lowSec: number;
  highSec: number;
  /** True once the range comes from this machine rather than the shipped guess. */
  measured: boolean;
}

/**
 * The shipped ranges: deliberately WIDE, because a narrow guess about unknown
 * hardware is the 99%-progress-bar mistake in another costume. They are only
 * ever the answer until this Mac has run the job twice.
 */
export const DEFAULT_ESTIMATES: Record<JobKind, [lowSec: number, highSec: number]> = {
  image: [30, 180],
  video: [180, 600],
  music: [60, 300],
  speech: [10, 60],
  sfx: [10, 60],
  model3d: [180, 600],
  // OmniSVG: a 5 s server start, then three samples of up to 1,536 ids.
  svg: [20, 90],
  other: [10, 120],
};

/** The verb on the card. First person, present tense, no tool names. */
export const JOB_TITLE: Record<JobKind, string> = {
  image: 'Making your image',
  video: 'Making your video',
  music: 'Composing your music',
  speech: 'Recording the audio',
  sfx: 'Making the sound',
  model3d: 'Building your 3D model',
  svg: 'Drawing the SVG',
  other: 'Working on it',
};

/**
 * Kinds that get a card the INSTANT they start.
 *
 * It was "kinds that are never quick", and speech and sfx were left out on that
 * reading: a four-second door slam can be over before you notice it, so waiting
 * ten seconds to say anything was right.
 *
 * It is not right any more, because the card is no longer only an apology for a
 * wait — it is the BOX THE RESULT ARRIVES IN (the user: "they get shown inline, the
 * large card"), and its generating state is the waveform that resolves into the
 * clip you play. Withholding it for ten seconds means a sound that takes eight
 * appears out of nothing, and one that takes twelve shows two seconds of an
 * animation whose whole point is the transition into the result.
 *
 * `other` keeps the delay. A card in front of a two-second tool call is exactly
 * the noise the delay exists to prevent — that job has no result to hold a place
 * for.
 */
const ALWAYS_CARD = new Set<JobKind>([
  'image',
  'video',
  'music',
  'speech',
  'sfx',
  'model3d',
  'svg',
]);

/** How long a not-known-slow job runs before it earns a card. */
export const CARD_AFTER_MS = 10_000;

export function shouldShowCard(kind: JobKind, elapsedMs: number): boolean {
  return ALWAYS_CARD.has(kind) || elapsedMs >= CARD_AFTER_MS;
}

/**
 * The range for this kind: the middle 50% of what this machine has actually
 * done, once there are at least two samples, else the shipped guess.
 *
 * Two is a low bar for a statistic and a high one for honesty — it is the point
 * at which the app is quoting THIS Mac instead of a table, and a range that is
 * merely rough beats a number that is about someone else's laptop.
 */
export function estimateFor(kind: JobKind, samplesSec: readonly number[]): JobEstimate {
  const usable = samplesSec.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const [lo, hi] = DEFAULT_ESTIMATES[kind];
  if (usable.length < 2) return { lowSec: lo, highSec: hi, measured: false };
  const at = (q: number): number =>
    usable[Math.min(usable.length - 1, Math.floor(q * usable.length))] as number;
  const low = at(0.25);
  const high = at(0.75);
  /*
   * A range that has collapsed to a point reads as a promise rather than an
   * estimate — and it is a promise about a local model on a machine that is
   * also doing other things, so it will be broken. Spread it.
   *
   * The trigger is deliberately tight (5%): a genuinely consistent job SHOULD
   * quote a tight range, and widening one that the machine has earned would
   * throw away the whole point of measuring.
   */
  if (high - low < Math.max(2, low * 0.05)) {
    return { lowSec: Math.max(1, low * 0.85), highSec: high * 1.15, measured: true };
  }
  return { lowSec: low, highSec: high, measured: true };
}

/** 45 → "45 seconds"; 150 → "2 minutes"; rounded the way a person would say it. */
function saySeconds(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec / 5) * 5)} seconds`;
  const mins = Math.round(sec / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * What the card says about how long this will take.
 *
 * TWO DIFFERENT SENTENCES, because there are two different truths.
 *
 * Before this machine has run the job, we genuinely do not know: the shipped
 * range is 30 seconds to 3 minutes, a six-fold spread, and the tester read that
 * for what it is — "a six-fold range reads as *we have no idea*. Which is true!
 * So say that instead, and it becomes charming rather than evasive." Her line,
 * kept: it also explains why the second run will be better, which makes the
 * learning visible instead of silent.
 *
 * Once the machine HAS run it, one number with "about" beats a range.
 */
export function estimateText(est: JobEstimate): string {
  if (!est.measured) return "I haven't done this on your Mac yet, so I'm timing it";
  const mid = (est.lowSec + est.highSec) / 2;
  return `about ${saySeconds(mid)} on your Mac`;
}

/** 0 → "0:00"; 154_000 → "2:34". Always mm:ss, so its width never jumps. */
export function timerText(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Everything the card renders, derived in one place so the copy is testable. */
export interface JobView {
  title: string;
  estimate: string;
  timer: string;
  /** Past the high end of the estimate — the card says so rather than hoping. */
  overrun: boolean;
  /** The line shown once it has overrun; null before that. */
  overrunText: string | null;
}

export function jobView(kind: JobKind, elapsedMs: number, est: JobEstimate): JobView {
  /*
   * THE OVERRUN LINE IS THE WHOLE POINT OF QUOTING A RANGE.
   *
   * A quoted estimate that silently expires is worse than no estimate: the user
   * now has a number they have watched the app break. Saying it out loud costs
   * one sentence and buys back the trust the number was supposed to earn.
   */
  const overrun = elapsedMs > est.highSec * 1000;
  /*
   * ANSWER THE QUESTION THEY ARE ACTUALLY ASKING. The first cut said "Taking
   * longer than usual. You can keep waiting or stop." The tester: "The second
   * sentence is redundant — there's a Cancel button right there — and it's
   * slightly cold, a shrug. At the moment an estimate blows, my actual thought
   * is not 'what are my options', it's *is it stuck?*"
   */
  return {
    title: JOB_TITLE[kind],
    estimate: estimateText(est),
    timer: timerText(elapsedMs),
    overrun,
    overrunText: overrun
      ? `Longer than I expected. Still working — nothing has gone wrong. ${timerText(elapsedMs)} so far.`
      : null,
  };
}

/**
 * The generation tool a shell command is really running, or null.
 *
 * In the bash-CLI tool interface (the default) a picture is asked for as
 * `media generate image --prompt …` inside a `bash` call, and the thread used
 * to read only the tool's NAME — so the card that shows the picture being
 * made never appeared, and the finished picture never landed in the thread
 * (SEEN: the children's book in CLI mode, eight pictures, nothing to look at
 * but "Ran a command"). The command says what the tool name does not.
 */
export function mediaToolOfCommand(command: string | undefined): string | null {
  if (typeof command !== 'string' || command.length === 0) return null;
  const gen = /(?:^|[\s;&|(`])media\s+generate\s+(image|video|speech|music|sfx)\b/.exec(command);
  if (gen !== null) return `generate_${gen[1]}`;
  if (/(?:^|[\s;&|(`])media\s+edit\s+image\b/.test(command)) return 'edit_image';
  // The OmniSVG command: `svg --prompt=… [out]` — a drawing, with a live card.
  // Only as THE command (`ls svg` and `cat logo.svg` are not drawings), and
  // not its manual.
  if (
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*svg(?:\s|$)/.test(command) &&
    !/\s(?:--help|-h)(?:\s|$)/.test(command)
  ) {
    return 'generate_svg';
  }
  // The Bobble 3D connector's commands: `3d generate …` and `3d refine …`.
  const model = /(?:^|[\s;&|(`])3d\s+(generate|refine)\b/.exec(command);
  if (model !== null) return `${model[1]}_3d`;
  return null;
}

/** The `command` of a bash call's arguments, whatever shape the block carries. */
export function commandOfArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const c = (args as { command?: unknown }).command;
  return typeof c === 'string' ? c : undefined;
}

/**
 * What a tool call is FOR: its own name, or — for a shell call running one of
 * the media commands — the generation tool behind that command.
 */
export function effectiveToolName(name: string | undefined, args: unknown): string | undefined {
  if (name === 'bash') return mediaToolOfCommand(commandOfArgs(args)) ?? name;
  return name;
}

/** Map a tool name to a job kind (null = not a job worth a card). */
export function jobKindForTool(name: string | undefined): JobKind | null {
  const n = (name ?? '').toLowerCase();
  if (n.length === 0) return null;
  if (n.includes('image') || n.includes('picture')) return 'image';
  if (n.includes('video') || n.includes('clip')) return 'video';
  if (n.includes('music')) return 'music';
  if (n.includes('speech') || n.includes('voice') || n.includes('tts')) return 'speech';
  if (n.includes('sfx') || n.includes('sound_effect')) return 'sfx';
  if (n.includes('3d') || n.includes('mesh') || n.includes('model_gen')) return 'model3d';
  if (n === 'generate_svg') return 'svg';
  return null;
}
