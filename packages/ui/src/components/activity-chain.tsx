import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { DiffStat } from './activity.tsx';
import { writeClipboardText } from './copy-button.tsx';
import { type DiffFileData, DiffView } from './diff-view.tsx';
import { IconCheck, IconChevronRight, IconConnector, IconExternal } from './icons.tsx';
import { ContextGauge } from './indicators.tsx';
import { Markdown } from './markdown.tsx';
import { ShimmerText } from './shimmer.tsx';
import { Spinner } from './spinner.tsx';
import { ToolIcon, type ToolIconKind } from './tool-icons.tsx';
import { type WebSearchResultData, WebSearchResults } from './web-search.tsx';

/*
 * Collapsed activity chain (THEME 3, match Claude img8–11). A run of tool/
 * thinking steps collapses to ONE dim summary line that AGGREGATES the whole
 * chain by kind ("Ran 10 commands, thought for 1h 20m, read 3 files"); a
 * trailing chevron appears on hover. Click rolls the chain open to a vertical
 * stacked step list threaded by a left connector line.
 *
 * Step anatomy:
 *   - every step surfaces its PRIMARY arg inline next to the verb ("Read a file:
 *     config.ts" / "Ran: <cmd>" / "Searched: <query>") — the user round-2 #2.
 *   - thinking / search steps are ALWAYS-EXPANDED inside the open chain — the
 *     thought text / web-search list render directly under the row, no click.
 *   - bash / edit / read / file steps make the WHOLE ROW a disclosure control
 *     (trailing chevron); clicking it reveals the full arg + the content
 *     (command+output / diff / preview).
 *   - media/preview steps carry `opensInCanvas` and route to the canvas.
 * Every open/collapse is a smooth height roll (reduced-motion safe).
 */

export type ActivityStepKind = ToolIconKind;

/**
 * WHAT AN AGENT IS ACTUALLY DOING — five states, not two.
 *
 * This was `'running' | 'done'`, so everything that had not finished read as
 * running: it shimmered, it spun, and its elapsed clock ticked. the user, watching a
 * corp run: "timers can't keep ticking for waiting agents, it needs to be more
 * clear who is waiting, working, and waiting because stopped."
 *
 * An agent parked in `talk_to` is not working, and a clock counting up next to
 * it is a claim that it is. The distinctions people actually need at a glance:
 *
 *   running  the model is generating right now  — shimmer + live clock
 *   waiting  parked on someone else's reply     — still, no clock
 *   stopped  stood down, resumable (orange)     — still, no clock
 *   error    the turn failed (red)              — still, no clock
 *   done     finished (green)
 *
 * Only `running` gets the ticking timer. The rest hold a frozen elapsed time if
 * they have one, which is a fact, rather than a counter, which is a claim.
 */
export type ActivityStatus = 'running' | 'queued' | 'waiting' | 'stopped' | 'error' | 'done';

/** States where the agent is NOT generating — no shimmer, no ticking clock. */
export const STILL_STATUSES: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>([
  'queued',
  'waiting',
  'stopped',
  'error',
  'done',
]);

/** The word shown beside a still agent, so "why is nothing happening" has an answer. */
export function statusWord(status: ActivityStatus): string | null {
  switch (status) {
    /*
     * QUEUED — a call the model wrote that has not started yet. the user, on four
     * chart rows each with a spinner and a ticking clock: "why is there a
     * seemingly bunch of command executing all at once". The model writes its
     * calls in one go and the harness runs them one after another; only the
     * one it is on is running. The rest are still, with this word on them.
     */
    case 'queued':
      return 'Queued';
    case 'waiting':
      return 'Waiting';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Failed';
    default:
      return null;
  }
}

interface ActivityStepCommon {
  /** Stable key for lists; derived from kind+label when omitted. */
  id?: string;
  /** Present/past-tense row label ("Rewriting the plan…" / "Ran a command"). */
  label: string;
  /**
   * The step's PRIMARY argument, surfaced inline right after the verb so a row
   * reads "Read a file: <path>" / "Ran: <cmd>" / "Searched: <query>" instead of
   * a bare verb (the user round-2 #2). Carries the FULL value (full path / command /
   * query / url): file-path kinds show its basename on the collapsed row and the
   * whole path in the expanded reveal; the rest show it verbatim. Empty/omitted →
   * no inline arg (the row falls back to just the verb).
   */
  detail?: string;
  /**
   * The Mac app this step acted on, when it acted on one — the row shows its
   * REAL icon beside the verb. the user: "you can get the real app icon of any
   * program being used right? so just use that no emoji." The renderer resolves
   * the name to a picture; the chain only has to carry the name.
   */
  app?: string;
  /**
   * The verb ALONE, with the app's name taken out of it — which turns the row
   * from a sentence into the shape the user asked for: "<generic connectors icon>
   * Used <connector app icon> <connector app name> <action eg. read page or
   * listed tabs>". Present only for the connector-shaped rows; everything else
   * keeps its ordinary label.
   */
  action?: string;
  /** Small pill/subtitle ("Script", or a filename). */
  tag?: ReactNode;
  /** Drives the file-extension icon badge and the default pill/tag. */
  filename?: string;
  /** `running` shimmers the row + spins; defaults to `done`. */
  status?: ActivityStatus;
  /**
   * Epoch ms when this step began, when the caller knows it. Feeds the elapsed
   * counter on a running row so it survives a remount rather than restarting.
   */
  startedAt?: number;
  /**
   * The tool REJECTED this call — nothing was written, run or fetched. Set from
   * the result's `isError`. Without it a failure is indistinguishable from a
   * success in the roll-up, which is how a turn whose six edits were all
   * rejected came to read "edited 6 files".
   */
  failed?: boolean;
  /**
   * Wall-clock this step took, in milliseconds. Summed per kind for the
   * aggregated summary line (thinking → "thought for 1h 20m").
   */
  durationMs?: number;
  /**
   * Media/preview steps (image/pdf/rendered file) do NOT expand inline —
   * activating them opens the canvas. The app reads this flag and routes.
   */
  opensInCanvas?: boolean;
}

export type ActivityStepData =
  | (ActivityStepCommon & { kind: 'thinking'; thought?: string })
  | (ActivityStepCommon & { kind: 'bash' | 'python'; command?: string; output?: string })
  | (ActivityStepCommon & {
      kind: 'edit';
      diff?: DiffFileData[];
      /** Explicit change counts for the label stat; derived from `diff` when omitted. */
      added?: number;
      deleted?: number;
      /** The tool's own words for a refused edit — shown first when `failed`. */
      error?: string;
      /** A refused whole-file write: the path names a file that does not exist. */
      noFile?: boolean;
    })
  /*
   * `folder` belongs here, and did not exist at all.
   *
   * `ls`/`list_dir`/`listdir` resolve to `folder` in the app's tool mapping and
   * VERBS/RUNNING_PHRASE both carry an entry for it — but the union had no
   * member, so the mapping could only emit the step as a `read`. A directory
   * listing therefore arrived labelled "Listed a folder" wearing the file-sheet
   * glyph, and the open-folder icon this project drew for it was unreachable.
   */
  | (ActivityStepCommon & { kind: 'read' | 'file' | 'skill' | 'folder'; preview?: ReactNode })
  | (ActivityStepCommon & {
      kind: 'search';
      query?: string;
      results?: WebSearchResultData[];
      /** Backend note shown in the empty state when there are no results. */
      note?: string;
    })
  | (ActivityStepCommon & {
      // Browser-action steps (round-10 #17): the URL/target is carried for a tag,
      // and browser-read expands the page text it returned as an inline preview.
      kind: 'browser-navigate' | 'browser-click' | 'browser-type' | 'browser-read';
      url?: string;
      /**
       * What the page called itself once it loaded, when the tool reported it.
       * A URL alone does not tell you whether you landed on the thing you meant
       * or on a login wall, and that is the usual reason to open a visit row.
       */
      title?: string;
      /** Load outcome as the tool phrased it ("200", "404 Not Found", "timeout"). */
      pageStatus?: string;
      /**
       * The element that was acted on — a CSS selector, an element ref, or its
       * accessible name. "Clicked" with no target is the least informative row
       * in the whole chain: it names an action and withholds its object.
       */
      target?: string;
      /** The text a `browser-type` step put into that element. */
      typed?: string;
      preview?: ReactNode;
    })
  // Generic tool rows (tool-search + the NEUTRAL unknown-tool fallback) and
  // connector/MCP calls. All three reveal their raw args + result on click
  // (`argsText`/`output`); a connector also carries its brand mark (`iconSvg`)
  // so the row reads "Used <connector icon> <connector name>".
  | (ActivityStepCommon & {
      /* The corp coordination rows belong to this shape, not the file-read one:
       * their ARGS are the content — who was asked, and what for — so they
       * reveal argsText + output exactly like any other tool row. Reaching the
       * read shape is what relabelled them "Read a file". */
      kind:
        | 'tool-search'
        | 'tool'
        | 'talk'
        | 'manager'
        | 'commission'
        | 'delegate'
        | 'toolkit'
        | 'submit';
      argsText?: string;
      output?: string;
    })
  /* A chart drawn by the `chart` tool: the title rides as the detail, and
   * the row reveals the tool's own answer (the file it wrote, the look). */
  | (ActivityStepCommon & { kind: 'chart'; argsText?: string; output?: string })
  | (ActivityStepCommon & {
      kind: 'connector';
      /** The connector's inline brand SVG (mcp-lite connector-icons), if resolved. */
      iconSvg?: string;
      argsText?: string;
      output?: string;
    })
  | (ActivityStepCommon & {
      /*
       * THE ARTIFACT ROWS — a step whose product is a FILE.
       *
       * The generate family (video/speech/music/sfx) had icons, verbs and a
       * KIND_ORDER slot but no member here, so the mapping's fallback arm could
       * only emit them as `read` — the identical defect the corp rows carry a
       * note about above. MEASURED before the fix: a turn whose steps were
       * ["Thought", "Read it aloud", "Thought", "Done"] collapsed to the summary
       * "Thought for 2s, read a file", describing a read that never happened.
       */
      kind:
        | 'image'
        | 'pdf'
        | 'canvas-open'
        | 'video'
        | 'speech'
        | 'music'
        | 'sfx'
        | 'model3d'
        | 'model3d-refine';
      /**
       * What the tool said it made, in ITS words. The fallback for a generator
       * whose result this app cannot parse — losing the only account of a job
       * is worse than showing an unstyled sentence.
       */
      preview?: ReactNode;
      /**
       * That same account, parsed. The chain lays these out the way every other
       * reveal lays out its facts, which is the difference between a scannable
       * row and a run-on line: newlines collapse in HTML, so the raw text
       * renders as one long sentence.
       */
      facts?: readonly { label: string; value?: string; mono?: boolean }[];
      /**
       * Where the artifact actually lives (file path, data URI, canvas tab
       * title). These rows normally route to the canvas via `opensInCanvas`, but
       * when no canvas target resolves — the media URL could not be picked out
       * of the tool result — the row kept the flag off and became inert: a
       * "Generated an image" you could neither open nor interrogate. This is
       * what such a row can still say for itself.
       */
      src?: string;
    });

/* ------------------------------------------------------------------ */
/* Summary derivation (pure — unit-tested)                             */
/* ------------------------------------------------------------------ */

interface VerbSpec {
  verb: string;
  singular: string;
  /** Empty = non-countable phrase (e.g. "searched the web"), never pluralized. */
  plural: string;
  /**
   * What ONE rejected call of this kind is called, for the failure phrasing
   * ("6 edits failed"). The past-tense verbs are irregular — Ran, Read — so
   * this is stated rather than stemmed. Defaults to "call".
   */
  attempt?: string;
}

const VERBS: Record<ActivityStepKind, VerbSpec> = {
  thinking: { verb: 'Thought', singular: '', plural: '' },
  bash: { verb: 'Ran', singular: 'a command', plural: 'commands', attempt: 'command' },
  python: { verb: 'Ran', singular: 'Python', plural: '', attempt: 'Python run' },
  edit: { verb: 'Edited', singular: 'a file', plural: 'files', attempt: 'edit' },
  read: { verb: 'Read', singular: 'a file', plural: 'files', attempt: 'read' },
  folder: { verb: 'Listed', singular: 'a folder', plural: 'folders', attempt: 'listing' },
  // The coordination steps. A collapsed chain that says "messaged 3 colleagues"
  // tells you a corp run actually delegated; "used 3 tools" tells you nothing.
  talk: { verb: 'Messaged', singular: 'a colleague', plural: 'colleagues', attempt: 'message' },
  /*
   * The CEO→manager hand-off is its own kind, not a `talk`. It is the single
   * moment a run stops being one model and becomes a team, and it is the row
   * you look for to answer "did it delegate at all?" — "Messaged a colleague"
   * buries that, and the generic `tool` fallback ("Running a tool") erased it
   * entirely for three runs after the tool was renamed to `talk_to_manager`.
   */
  manager: { verb: 'Briefed', singular: 'the manager', plural: '', attempt: 'brief' },
  commission: {
    verb: 'Commissioned',
    singular: 'a specialist',
    plural: 'specialists',
    attempt: 'commission',
  },
  delegate: { verb: 'Opened', singular: 'delegation', plural: '', attempt: 'gate' },
  toolkit: { verb: 'Requested', singular: 'test tools', plural: '', attempt: 'request' },
  submit: { verb: 'Submitted', singular: 'the work', plural: '', attempt: 'submission' },
  file: { verb: 'Presented', singular: 'a file', plural: 'files', attempt: 'preview' },
  skill: { verb: 'Read', singular: 'a skill', plural: 'skills', attempt: 'skill read' },
  search: { verb: 'Searched', singular: 'the web', plural: '', attempt: 'search' },
  'tool-search': { verb: 'Searched', singular: 'tools', plural: '' },
  'browser-navigate': {
    verb: 'Visited',
    singular: 'a page',
    plural: 'pages',
    attempt: 'page visit',
  },
  'browser-click': { verb: 'Clicked', singular: '', plural: '' },
  'browser-type': { verb: 'Typed', singular: '', plural: '' },
  'browser-read': { verb: 'Read', singular: 'the page', plural: 'pages' },
  connector: { verb: 'Used', singular: 'a connector', plural: 'connectors' },
  tool: { verb: 'Used', singular: 'a tool', plural: 'tools' },
  image: { verb: 'Generated', singular: 'an image', plural: 'images', attempt: 'image' },
  video: { verb: 'Generated', singular: 'a video', plural: 'videos', attempt: 'video' },
  speech: { verb: 'Read', singular: 'it aloud', plural: 'passages', attempt: 'read-aloud' },
  music: { verb: 'Composed', singular: 'music', plural: 'pieces', attempt: 'piece' },
  sfx: { verb: 'Made', singular: 'a sound effect', plural: 'sound effects', attempt: 'sound' },
  model3d: { verb: 'Built', singular: 'a 3D model', plural: '3D models', attempt: '3D model' },
  'model3d-refine': {
    verb: 'Refined',
    singular: 'a 3D model',
    plural: '3D models',
    attempt: '3D refinement',
  },
  pdf: { verb: 'Created', singular: 'a PDF', plural: 'PDFs', attempt: 'PDF' },
  chart: { verb: 'Drew', singular: 'a chart', plural: 'charts', attempt: 'chart' },
  'canvas-open': { verb: 'Opened', singular: 'the canvas', plural: '' },
};

/**
 * Canonical phrase order for the aggregated summary. The summary is
 * order-INDEPENDENT (input order is discarded); kinds always read in this fixed
 * order so "ran, thought, ran, read" collapses to "Ran … thought … read …".
 */
const KIND_ORDER: ActivityStepKind[] = [
  'bash',
  'python',
  'thinking',
  /*
   * THE COORDINATION KINDS, which were absent — so they were dropped from every
   * collapsed summary, the aggregation walking this list and skipping what it
   * does not find. MEASURED: a turn whose steps were [thinking, manager,
   * submit] summarised as "Thought for 2s", omitting both the delegation and
   * the hand-back that were the entire point of the turn.
   *
   * They lead, ahead of the file work, because on a corp turn the hand-off IS
   * the headline: "Briefed the manager" is what happened, and the edits are how.
   */
  'manager',
  'delegate',
  'commission',
  'toolkit',
  'talk',
  'submit',
  'edit',
  'read',
  'folder',
  'file',
  'skill',
  'search',
  'tool-search',
  'browser-navigate',
  'browser-click',
  'browser-type',
  'browser-read',
  'connector',
  'tool',
  'image',
  /* The rest of the generate family. Omitted here they are invisible to the
     chain SUMMARY — the collapsed header aggregates by KIND_ORDER, so a turn
     whose only step was a sound effect summarised as something else entirely. */
  'video',
  'speech',
  'music',
  'sfx',
  'model3d',
  'model3d-refine',
  'pdf',
  'chart',
  'canvas-open',
];

/**
 * Format a millisecond duration as "1h 20m 5s", dropping any ZERO component.
 *
 * the user: "'worked for ah nm rs' please. no 0s." So all three units appear when
 * they carry information and none of them appear when they don't — "1h" rather
 * than "1h 0m", "2m 5s" rather than "0h 2m 5s". An hour-long turn also keeps its
 * seconds now; truncating them was hiding real precision on the long turns where
 * it is most interesting.
 *
 * Returns an EMPTY STRING for zero: there is no useful reading of "0s", and a
 * caller with nothing to report should say nothing rather than print a zero.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function phrase(kind: ActivityStepKind, count: number, durationMs: number, failed = 0): string {
  // Thinking is duration-first when we have one ("thought for 1h 20m").
  if (kind === 'thinking') {
    // Test the FORMATTED value, not the raw ms: a sub-second duration is a real
    // number that formats to nothing, and "Thought for " is worse than "Thought".
    const d = formatDuration(durationMs);
    return d !== '' ? `Thought for ${d}` : 'Thought';
  }
  const spec = VERBS[kind];
  /*
   * Every call of this kind was rejected, so the past-tense verb cannot be used
   * at all — "edited 6 files" asserts six files changed when none did. Name the
   * ATTEMPTS instead: "6 edits failed".
   */
  if (failed > 0 && failed === count) {
    const attempt = spec.attempt ?? 'call';
    return count > 1 ? `${count} ${attempt}s failed` : `1 ${attempt} failed`;
  }
  if (!spec.plural) {
    return spec.singular ? `${spec.verb} ${spec.singular}` : spec.verb;
  }
  const done = count - failed;
  const noun = done > 1 ? `${done} ${spec.plural}` : spec.singular;
  /*
   * NO "(N failed)" TAIL. the user: "additionally, no (failed)." The count of what
   * WORKED is the honest headline; the failures are not hidden, they are red in
   * the expanded rows with their real error, which is where you can act on one.
   * A parenthetical in the summary was noise you could not click.
   */
  return `${spec.verb} ${noun}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Derive the collapsed summary line (past tense) by aggregating the ENTIRE chain
 * by kind — order-independent, each kind appearing once with its total count and
 * summed duration ("Ran 10 commands, thought for 1h 20m, read 3 files"). The
 * first phrase is capitalized, the rest lower-cased. Pure + deterministic.
 */
/**
 * Should this chain print "Done" RIGHT NOW? (The latch lives in the component;
 * this is the per-render decision it latches on.)
 *
 * Extracted because it was wrong three times and the user reported it three times —
 * "the premature done just needs to be fixed now though… it doesn't say done
 * until it's truly totally done", then "done is a final thing". Each fix was a
 * one-line change to an expression buried in a 200-line component, with nothing
 * asserting the rule afterwards. Now there is.
 *
 * The rule, in one place:
 *  · When the turn's owner supplies `complete`, that is the ONLY thing that can
 *    show Done. Quiet rows cannot — `!running && !active` goes true in every gap
 *    between two tool calls, which is what made Done flap on and off mid-turn.
 *  · A `complete` turn that is not yet quiet is still not done: the caller can
 *    know the turn is over before the last row stops rendering.
 *  · With no `complete` (a static render, a historical transcript) fall back to
 *    the debounced quiet guess — those turns are already over.
 */
export function chainIsDone(input: {
  readonly complete?: boolean;
  readonly quiet: boolean;
  readonly settledGuess: boolean;
}): boolean {
  return input.complete !== undefined ? input.complete && input.quiet : input.settledGuess;
}

export function summarizeActivity(steps: ActivityStepData[]): string {
  const agg = new Map<ActivityStepKind, { count: number; durationMs: number; failed: number }>();
  for (const step of steps) {
    const cur = agg.get(step.kind) ?? { count: 0, durationMs: 0, failed: 0 };
    cur.count += 1;
    cur.durationMs += step.durationMs ?? 0;
    if (step.failed === true) cur.failed += 1;
    agg.set(step.kind, cur);
  }
  const phrases: string[] = [];
  for (const kind of KIND_ORDER) {
    const entry = agg.get(kind);
    if (entry) phrases.push(phrase(kind, entry.count, entry.durationMs, entry.failed));
  }
  /*
   * PAST TWO DISTINCT ACTIONS, SAY "WORKED FOR <time>".
   *
   * the user: "if the message shown on tool call blocks exceeds 2 distinct actions
   * simply collapse it to say 'worked' for <time> rather than list everything
   * out." A forty-step turn summarised as "Ran 12 commands, thought for 4m,
   * read 9 files, edited 5 files, listed 3 folders" is a paragraph where a
   * glance should do — and the detail is one click away in the chain itself.
   *
   * Two is the line because two still READS ("Ran 3 commands, thought for 2m");
   * three is where it becomes a list.
   */
  if (phrases.length > 2) {
    /*
     * ...unless nothing worked. "Worked for 2m" over a turn whose every call
     * was rejected is the false-completion this project keeps having to fix,
     * one layer up. When there is nothing that succeeded, the collapse would be
     * a claim rather than a summary, so keep the itemised line — it is the
     * honest one, and a failing turn is exactly when you want the detail.
     */
    const anyDone = steps.some((s) => s.failed !== true);
    if (anyDone) {
      const total = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
      const d = formatDuration(total);
      return d !== '' ? `Worked for ${d}` : 'Worked';
    }
  }
  return phrases.map((p, i) => (i === 0 ? p : lowerFirst(p))).join(', ');
}

/** Present-tense phrase for the step currently in flight (B3). */
const RUNNING_PHRASE: Record<ActivityStepKind, string> = {
  thinking: 'Thinking…',
  bash: 'Running a command',
  python: 'Running Python',
  edit: 'Editing a file',
  read: 'Reading a file',
  folder: 'Listing a folder',
  talk: 'Messaging a colleague',
  manager: 'Briefing the manager',
  commission: 'Commissioning a specialist',
  delegate: 'Opening delegation',
  toolkit: 'Requesting test tools',
  submit: 'Submitting the work',
  file: 'Presenting a file',
  skill: 'Reading a skill',
  search: 'Searching the web',
  'tool-search': 'Searching tools',
  'browser-navigate': 'Navigating',
  'browser-click': 'Clicking',
  'browser-type': 'Typing',
  'browser-read': 'Reading the page',
  connector: 'Using a connector',
  tool: 'Running a tool',
  image: 'Generating an image',
  video: 'Generating a video',
  speech: 'Reading it aloud',
  music: 'Composing music',
  sfx: 'Making a sound effect',
  model3d: 'Building a 3D model',
  'model3d-refine': 'Refining a 3D model',
  pdf: 'Creating a PDF',
  chart: 'Rendering a chart',
  'canvas-open': 'Opening the canvas',
};

/**
 * The collapsed summary line for the chain. While ANY step is still running it
 * reads in the PRESENT tense (the in-flight step's label, else "Working…") so a
 * live chain never claims past-tense completion; once every step is done it
 * flips to the past-tense {@link summarizeActivity} roll-up. Pure + unit-tested.
 */
export function activitySummary(steps: ActivityStepData[]): string {
  if (steps.length === 0) return 'Working…';
  const running = steps.some((s) => s.status === 'running');
  if (!running) return summarizeActivity(steps);
  const current = [...steps].reverse().find((s) => s.status === 'running');
  if (current === undefined) return 'Working…';
  /*
   * THE HEADER AGREES WITH THE ROW IT SUMMARISES.
   *
   * The step's own label IS the present-tense phrase for its kind — the two
   * tables are copies of each other — except where a tool carries a more
   * specific one: "Writing a file" for a write (vs. the kind's "Editing a
   * file"), "Using Linear" for a connector. Reading the label first makes those
   * agree. It was visibly wrong without this: a write showed a chain headed
   * "Editing a file" over a row reading "Writing a file", in the same frame.
   *
   * RUNNING_PHRASE stays as the fallback for a step with no label of its own.
   */
  return current.label.trim().length > 0 ? current.label : RUNNING_PHRASE[current.kind];
}

/* ------------------------------------------------------------------ */
/* Step classification + content by kind                               */
/* ------------------------------------------------------------------ */

/** thinking + search render their content inline (no click) inside an open chain. */
function isInlineKind(kind: ActivityStepKind): boolean {
  return kind === 'thinking' || kind === 'search';
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Kinds whose `detail` is a file PATH: the collapsed row shows just the basename
 * (the meaningful tail — "Read a file: config.ts") while the expanded reveal
 * restates the full path. Command/query/url kinds show `detail` verbatim.
 */
const PATH_DETAIL_KINDS = new Set<ActivityStepKind>(['read', 'edit', 'file', 'skill', 'folder']);

/**
 * File-op kinds that surface their filename as a SUBLINE directly under the verb
 * ("Read a file" / <config.ts>) — a two-line row (spec-tool-call-row). These are
 * also the kinds whose row can OPEN the underlying file in the canvas (the
 * `onOpenFile` seam), so the subline doubles as the "which file" affordance.
 */
const SUBLINE_KINDS = new Set<ActivityStepKind>(['read', 'edit', 'skill']);

/**
 * Kinds whose expanded reveal leads with the full primary arg — their inline
 * content (a file/page preview) doesn't otherwise restate it. bash/edit skip
 * this: their reveal already shows the command / the diff's own path header.
 */
const ARG_HEADER_KINDS = new Set<ActivityStepKind>([
  'read',
  'file',
  'skill',
  'folder',
  'browser-read',
]);

/** Char count past which an in-chain thought fades + offers "Show more". */
const CHAIN_THOUGHT_LONG = 240;

/**
 * An in-chain thought (the user round-5 #3): renders inline (no click) but NEVER
 * scrolls — a long one clamps with a bottom fade + a small "Show more" below.
 */
function ChainThought({ text, live = false }: { text: string; live?: boolean }) {
  const [showMore, setShowMore] = useState(false);
  const long = text.trim().length > CHAIN_THOUGHT_LONG;
  // While the thought is streaming live, never clamp — the newest tokens stay
  // visible so the user watches it generate (the thread auto-scrolls to follow).
  const clamped = long && !showMore && !live;
  return (
    <div className="pd-chain-thought">
      {/* the user UI#5: reasoning renders through the SAME Markdown pipeline as a
       * regular message (gfm, math, code chrome, hex swatches) — the scoped CSS
       * on `.pd-chain-thought .pd-markdown` just scales it to the footnote size +
       * secondary color of a thought. The clamp/fade lives on the wrapper. */}
      <div className="pd-chain-thought-text" data-clamped={clamped}>
        <Markdown>{text}</Markdown>
      </div>
      {long && !live ? (
        <button
          type="button"
          className="pd-showmore pd-focusable"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** Sum per-file ± counts for the `edit` step label stat. */
function editTotals(step: Extract<ActivityStepData, { kind: 'edit' }>): {
  added: number;
  deleted: number;
} {
  if (step.added !== undefined || step.deleted !== undefined) {
    return { added: step.added ?? 0, deleted: step.deleted ?? 0 };
  }
  let added = 0;
  let deleted = 0;
  for (const file of step.diff ?? []) {
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return { added, deleted };
}

/**
 * One terminal-style block: an optional `$ command` prompt line followed by its
 * output, in a single scroll-inside frame — exactly as it appeared in the shell.
 * Replaces the old split CodeBlock(input) + OutputBlock(output) so a bash / tool
 * row reads as ONE thing, with no generic "Input"/"Output" code-block framing and
 * no schema/JSON dump (the user: "nothing should have that generic code block input
 * code block output"). A row with only output (a generic tool result) just shows
 * the result; the row header already carries the tool name + its primary arg.
 */
function TerminalBlock({
  command,
  output,
  prompt = '$',
  live = false,
}: {
  command?: string;
  output?: string;
  prompt?: string;
  /** The command is still running, so this block is a tail, not a transcript. */
  live?: boolean;
}) {
  const body = useRef<HTMLPreElement | null>(null);
  /*
   * A LIVE BLOCK FOLLOWS THE OUTPUT. Without this the newest line is the one you
   * cannot see: output arrives at the bottom of a scrolled box and the view
   * stays parked at the first line the command printed a minute ago. Only while
   * running — once it settles, the top is the right place to be reading from.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `output` is the trigger — it is read through the ref's element, not from the closure
  useEffect(() => {
    if (!live) return;
    const el = body.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [live, output]);

  const hasCmd = command !== undefined && command.length > 0;
  const hasOut = output !== undefined && output.length > 0;
  if (!hasCmd && !hasOut) return null;
  return (
    <div className="pd-chain-output pd-chain-termblock">
      <div className="pd-chain-output-frame">
        <pre
          className="pd-chain-output-body pd-scroll"
          ref={body}
          data-live={live ? '' : undefined}
        >
          {hasCmd ? (
            <span className="pd-term-cmd">
              <span className="pd-term-prompt">{prompt} </span>
              {command}
            </span>
          ) : null}
          {hasCmd && hasOut ? '\n' : null}
          {hasOut ? output : null}
          {/* A caret while it runs — the difference between "printed nothing
              yet" and "finished with no output", which otherwise look the
              same. */}
          {live ? <span className="pd-term-caret" aria-hidden="true" /> : null}
        </pre>
      </div>
    </div>
  );
}

/**
 * The error body of a FAILED step: the real message, in red, with a copy button.
 *
 * the user: "clicking it shows the actual error and 'copy raw' button if it's an
 * actual failed to parse error (this will be useful for debugging)."
 *
 * `copyRaw` appears only for the errors worth pasting somewhere — a parse /
 * schema failure, where the exact bytes are the diagnosis. A "file not found"
 * needs no clipboard, and a button on every error trains you to ignore it.
 */
function looksLikeParseError(text: string): boolean {
  return /pars|json|schema|unexpected token|malformed|invalid|syntax|decode/i.test(text);
}

function StepError({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pd-chain-error">
      <pre className="pd-chain-error-text">{text}</pre>
      {looksLikeParseError(text) ? (
        <div className="pd-chain-error-actions">
          <button
            type="button"
            className="pd-chain-error-copy pd-focusable"
            onClick={() => {
              void writeClipboardText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? 'Copied' : 'Copy raw'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StepContent({ step, live = false }: { step: ActivityStepData; live?: boolean }) {
  /*
   * A FAILURE OUTRANKS THE NORMAL BODY. Whatever this kind usually shows, the
   * thing you opened it for is what went wrong — so the error leads, and the
   * usual content follows it (a bash row still shows its command and stdout
   * under the red stderr).
   */
  const errText =
    step.failed === true
      ? ((step as { output?: string }).output ?? (step as { error?: string }).error ?? '')
      : '';
  if (errText.trim().length > 0) {
    return (
      <>
        <StepError text={errText} />
        {step.kind === 'bash' || step.kind === 'python' ? (
          <TerminalBlock command={(step as { command?: string }).command} />
        ) : null}
        {step.kind === 'edit' && step.diff !== undefined && step.diff.length > 0 ? (
          // What WOULD have been written, under the reason it was not.
          <DiffView files={step.diff} />
        ) : null}
      </>
    );
  }
  switch (step.kind) {
    case 'thinking':
      return step.thought ? <ChainThought text={step.thought} live={live} /> : null;
    case 'bash':
    case 'python':
      return (
        <TerminalBlock
          command={step.command}
          output={step.output}
          prompt={step.kind === 'python' ? '>>>' : '$'}
          live={step.status === 'running'}
        />
      );
    case 'edit':
      return step.diff !== undefined && step.diff.length > 0 ? (
        <DiffView files={step.diff} />
      ) : (
        <EditReveal path={step.detail} {...editTotals(step)} failed={step.failed} />
      );
    case 'search':
      // `results ?? []` rather than a null branch: the empty state names the
      // query and prints the backend `note`, which is the whole answer to "why
      // did that search show me nothing".
      return (
        <WebSearchResults
          query={step.query ?? step.detail ?? step.label}
          results={step.results ?? []}
          emptyHint={step.note}
        />
      );
    case 'read':
    case 'file':
    case 'skill':
    case 'folder':
      return step.preview !== undefined ? (
        <div className="pd-chain-preview">{step.preview}</div>
      ) : (
        <EmptyPreviewNote kind={step.kind} />
      );
    case 'browser-read':
      return step.preview !== undefined ? (
        <div className="pd-chain-preview">{step.preview}</div>
      ) : (
        <>
          {/* No BrowserReveal here: this kind is in ARG_HEADER_KINDS, so the
              reveal already leads with the URL and a second copy of it is the
              only thing this branch could add wrongly. */}
          <ChainFacts
            rows={[
              { label: 'Title', value: step.title },
              { label: 'Status', value: step.pageStatus },
            ]}
          />
          <div className="pd-chain-note">The page returned no text.</div>
        </>
      );
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-type':
      return (
        <BrowserReveal
          kind={step.kind}
          // `detail` is the fallback, not a second source: the mapping fills both
          // from one value, but a hand-built step may set only the row arg.
          url={step.url ?? step.detail}
          title={step.title}
          pageStatus={step.pageStatus}
          target={step.target}
          typed={step.typed}
        />
      );
    case 'image':
    case 'pdf':
    case 'canvas-open':
      return (
        <MediaReveal
          kind={step.kind}
          src={step.src}
          filename={step.filename}
          detail={step.detail}
        />
      );
    /*
     * THE GENERATE FAMILY reveals differently from `image`, because its output
     * is ALREADY IN THE THREAD — the clip is playing a few pixels below the
     * row. MediaReveal's "this has no canvas target, so it cannot be opened"
     * would be both wrong and unhelpful there. What the row can add is the
     * provenance: which file, and what the tool said (seed, model).
     */
    case 'video':
    case 'speech':
    case 'music':
    case 'sfx':
    case 'model3d':
    case 'model3d-refine':
      return <GeneratedReveal src={step.src} note={step.preview} facts={step.facts} />;
    // Generic tool / connector / tool_search: show ONLY the tool's result, as one
    // clean block — never the raw args JSON (that's the schema noise the user called
    // out). The row header already surfaces the tool name + its primary arg.
    case 'tool-search':
    case 'tool':
    case 'connector':
    case 'chart':
      return <TerminalBlock output={step.output} />;
    case 'talk':
    case 'manager':
    case 'commission':
    case 'delegate':
    case 'toolkit':
    case 'submit':
      return <CoordinationReveal argsText={step.argsText} output={step.output} />;
    default:
      return null;
  }
}

/**
 * What a coordination row opens to: the MESSAGE that was sent, the files that
 * went with it, and the reply.
 *
 * the user: "just show the brief and some indented/smaller inline file presentation
 * cards showing what files/folders got passed along." The brief is prose a
 * person reads, so it is rendered as text rather than the raw JSON these args
 * arrive as — the schema noise was the reason args stopped being shown at all.
 */
function CoordinationReveal({ argsText, output }: { argsText?: string; output?: string }) {
  const parsed = (() => {
    if (argsText === undefined) return undefined;
    try {
      return JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  })();
  const message =
    typeof parsed?.message === 'string'
      ? parsed.message
      : typeof parsed?.request === 'string'
        ? parsed.request
        : argsText;
  const files = Array.isArray(parsed?.files)
    ? parsed.files.filter((f): f is string => typeof f === 'string')
    : [];
  return (
    <div className="pd-chain-coord">
      {message !== undefined && message.length > 0 ? (
        <div className="pd-chain-coord-brief">{message}</div>
      ) : null}
      {files.length > 0 ? (
        <div className="pd-chain-coord-files">
          {files.map((f) => (
            <span key={f} className="pd-chain-coord-file" title={f}>
              {f.split(/[/\\]/).filter(Boolean).at(-1) ?? f}
            </span>
          ))}
        </div>
      ) : null}
      {output !== undefined && output.length > 0 ? <TerminalBlock output={output} /> : null}
    </div>
  );
}

/** A string that is actually there — the `?? ''`-and-check the reveals all repeat. */
function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * The reveal shape for rows whose content is a HANDFUL OF FACTS rather than a
 * document: a URL, a selector, a path, a pair of ± counts.
 *
 * Every one of the rows fixed here has the same problem — one to four short
 * values that a person wants named, which is too little for a terminal frame and
 * too much for the row itself. Rendering them all through one labelled list is
 * what stops six new expansions from becoming six new layouts; a `<dl>` because
 * the labels really are labels, including to a screen reader.
 */
function ChainFacts({ rows }: { rows: { label: string; value?: string; mono?: boolean }[] }) {
  const shown = rows.filter((r) => nonEmpty(r.value));
  if (shown.length === 0) return null;
  return (
    <dl className="pd-chain-facts">
      {shown.map((r) => (
        <div className="pd-chain-fact" key={r.label}>
          <dt className="pd-chain-fact-label">{r.label}</dt>
          <dd
            className="pd-chain-fact-value"
            data-mono={r.mono === true ? 'true' : undefined}
            title={r.value}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a browser action row opens to.
 *
 * navigate/click/type all fell through to `default: return false`, so the three
 * commonest browser rows could not be opened at all — the only thing you could
 * learn from a click was the word "Clicked". The URL had to be read from the
 * truncated row `detail`, and the element and the typed text had nowhere to go.
 *
 * A click/type restates the page it happened on rather than assuming the visit
 * row above it is still on screen: in a forty-row chain it is usually not, and
 * "Clicked #submit" on an unknown page answers nothing.
 */
function BrowserReveal({
  kind,
  url,
  title,
  pageStatus,
  target,
  typed,
}: {
  kind: 'browser-navigate' | 'browser-click' | 'browser-type';
  url?: string;
  title?: string;
  pageStatus?: string;
  target?: string;
  typed?: string;
}) {
  return (
    <ChainFacts
      rows={[
        { label: kind === 'browser-navigate' ? 'URL' : 'Page', value: url, mono: true },
        { label: 'Title', value: title },
        { label: 'Status', value: pageStatus },
        { label: kind === 'browser-type' ? 'Field' : 'Target', value: target, mono: true },
        /*
         * Quoted, and never trimmed. Whether the field got "hello " or "hello"
         * is frequently the entire question when a form submit misbehaves, and
         * a bare value renders those two identically.
         */
        { label: 'Typed', value: typed === undefined ? undefined : `"${typed}"` },
      ]}
    />
  );
}

/**
 * A media row that never reached the canvas.
 *
 * image/pdf/canvas-open are `opensInCanvas` rows, and the canvas is the right
 * destination — but the flag is only set when a media URL could be picked out of
 * the tool result. When it could not, the row lost its click AND had no reveal
 * to fall back on, so a generated image became a line of text with nothing
 * behind it. Naming the artifact is the least it can do.
 */
/**
 * The reveal for a step that GENERATED something.
 *
 * Where the file landed, and what the tool said about making it. No thumbnail:
 * a generated clip or image mounts inline in the thread directly beneath this
 * chain, so a second copy inside the row would be the same artifact twice on
 * one screen.
 */
function GeneratedReveal({
  src,
  note,
  facts,
}: {
  src?: string;
  note?: ReactNode;
  facts?: readonly { label: string; value?: string; mono?: boolean }[];
}) {
  /* No File row: the row's own header already carries the filename, and this
     reveal opened directly beneath it. Three copies of one string is not
     thoroughness. */
  const rows = [{ label: 'Path', value: src, mono: true }, ...(facts ?? [])];
  // The raw sentence appears ONLY when nothing could be parsed out of it, so a
  // reveal is never empty and never says the same thing twice.
  return rows.some((r) => nonEmpty(r.value)) ? (
    <ChainFacts rows={rows} />
  ) : note !== undefined ? (
    <div className="pd-chain-preview">{note}</div>
  ) : null;
}

function MediaReveal({
  kind,
  src,
  filename,
  detail,
}: {
  kind:
    | 'image'
    | 'pdf'
    | 'canvas-open'
    | 'video'
    | 'speech'
    | 'music'
    | 'sfx'
    | 'model3d'
    | 'model3d-refine';
  src?: string;
  filename?: string;
  detail?: string;
}) {
  /* Each artifact names ITSELF here. The sentence below ends in this noun, and
     "This canvas tab has no canvas target" is not a thing to tell someone who
     asked for a door slam. */
  const NOUNS: Record<string, string> = {
    pdf: 'PDF',
    image: 'image',
    video: 'video',
    speech: 'recording',
    music: 'track',
    sfx: 'sound',
    model3d: '3D model',
    'model3d-refine': '3D model',
    'canvas-open': 'canvas tab',
  };
  const noun = NOUNS[kind] ?? 'file';
  const where = nonEmpty(src) ? src : nonEmpty(detail) ? detail : undefined;
  return (
    <>
      <ChainFacts
        rows={[
          { label: 'File', value: filename },
          { label: 'Source', value: where, mono: true },
        ]}
      />
      <div className="pd-chain-note">
        This {noun} has no canvas target, so it cannot be opened in a preview tab.
      </div>
    </>
  );
}

/**
 * A file/skill/listing row whose tool returned nothing.
 *
 * These kinds were gated on `preview` alone, so a read that came back empty — or
 * one still in flight, or one whose result was dropped — was a row displaying a
 * path that you could not click to read that path. The reveal's arg header
 * supplies the full path (see {@link ARG_HEADER_KINDS}); this explains the empty
 * space under it, which otherwise reads as a rendering fault rather than a fact
 * about the call.
 */
function EmptyPreviewNote({ kind }: { kind: 'read' | 'file' | 'skill' | 'folder' }) {
  const noun =
    kind === 'folder' ? 'listing' : kind === 'skill' ? 'skill' : kind === 'file' ? 'file' : 'read';
  return <div className="pd-chain-note">The tool returned no content for this {noun}.</div>;
}

/**
 * An edit with counts but no hunks.
 *
 * `hasInlineContent` required a non-empty `diff`, and the mapping produces edits
 * that have none: while a write streams it derives `added` from the partial JSON
 * long before any diff exists, and a rejected edit has counts and no hunks at
 * all. So the row carried a ±stat, and the two questions that stat provokes —
 * which file, and did it land — had no answer behind the click.
 */
function EditReveal({
  path,
  added,
  deleted,
  failed,
}: {
  path?: string;
  added: number;
  deleted: number;
  failed?: boolean;
}) {
  return (
    <>
      <ChainFacts
        rows={[
          { label: 'File', value: path, mono: true },
          { label: 'Changes', value: `+${added} −${deleted}` },
        ]}
      />
      <div className="pd-chain-note">
        {failed === true
          ? 'This edit was rejected — nothing was written.'
          : 'No line-by-line diff was captured for this edit.'}
      </div>
    </>
  );
}

/** Whether a step has inline content worth a reveal (pill) or inline render. */
export function hasInlineContent(step: ActivityStepData): boolean {
  if (step.opensInCanvas) return false;
  /*
   * A RUNNING STEP HAS NOT RETURNED NOTHING — IT HAS NOT RETURNED YET.
   *
   * The fallbacks below open a row on what it can still say when its RESULT is
   * missing, and each of them asserts an absence ("the tool returned no
   * content", "no diff was captured", "no canvas target"). Every one of those
   * sentences is false while the call is in flight, and the row already has a
   * spinner saying so. So the absence-reveals wait for the step to settle;
   * real content (a preview, a diff, a command) still opens a running row, and
   * the browser rows below key on their ARGUMENTS, which are known at call time
   * and true immediately.
   */
  const settled = step.status !== 'running';
  switch (step.kind) {
    case 'thinking':
      return step.thought !== undefined;
    case 'bash':
    case 'python':
      return step.command !== undefined || step.output !== undefined;
    case 'edit':
      /*
       * A ±STAT ON THE ROW IS A PROMISE THAT THE ROW OPENS. Keyed on `diff`
       * alone this was false for every streaming write (counts are derived from
       * partial JSON before any diff exists) and every rejected edit, so the
       * rows most worth interrogating were the inert ones. See {@link EditReveal}.
       */
      return (
        (step.diff !== undefined && step.diff.length > 0) ||
        nonEmpty(step.error) ||
        (settled &&
          (nonEmpty(step.detail) || step.added !== undefined || step.deleted !== undefined))
      );
    case 'search':
      /*
       * ZERO RESULTS IS A RESULT. `results !== undefined` meant a search that
       * came back empty — carrying a `note` that says WHY, a rate limit or a
       * dead backend — rendered nothing at all, which looks like the search
       * never happened. WebSearchResults has an empty state built for exactly
       * this; it just was never reached.
       */
      return step.results !== undefined || nonEmpty(step.query) || nonEmpty(step.note);
    case 'read':
    case 'file':
    case 'skill':
    case 'folder':
    case 'browser-read':
      // A path with no content is still worth opening — the row shows a basename,
      // the reveal shows the full path. See {@link EmptyPreviewNote}.
      return step.preview !== undefined || (settled && nonEmpty(step.detail));
    /*
     * THE THREE DEAD BROWSER ROWS. Only `browser-read` was ever listed, so
     * navigate/click/type fell to `default: false` — the URL that was visited,
     * the element that was clicked and the text that was typed were all carried
     * on the step and none of them could be opened.
     */
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-type':
      return (
        nonEmpty(step.url) ||
        nonEmpty(step.detail) ||
        nonEmpty(step.target) ||
        nonEmpty(step.typed) ||
        nonEmpty(step.title) ||
        nonEmpty(step.pageStatus)
      );
    /*
     * Media rows whose canvas target never resolved. The `opensInCanvas` guard
     * above already returns false for the healthy case (those rows route to the
     * canvas instead of expanding); this catches the ones left with no
     * destination at all. See {@link MediaReveal}.
     */
    case 'image':
    case 'pdf':
    case 'canvas-open':
      return settled && (nonEmpty(step.src) || nonEmpty(step.detail) || nonEmpty(step.filename));
    case 'video':
    case 'speech':
    case 'music':
    case 'sfx':
    case 'model3d':
    case 'model3d-refine':
      return (
        settled &&
        (nonEmpty(step.src) ||
          nonEmpty(step.filename) ||
          (step.facts ?? []).some((f) => nonEmpty(f.value)) ||
          step.preview !== undefined)
      );
    case 'tool-search':
    case 'tool':
    case 'connector':
    case 'chart':
      // Only the result opens a reveal now — the raw args JSON is no longer shown,
      // so args alone must not produce an empty reveal.
      return step.output !== undefined && step.output.length > 0;
    /*
     * COORDINATION ROWS OPEN TOO. the user: "find out all tool calls that are not
     * able to be clicked on for an expansion eg. briefing manager, that's easy,
     * just show the brief and some indented/smaller inline file presentation
     * cards showing what files/folders got passed along."
     *
     * These fell to `default: false`, so the single most consequential message
     * in a run — the brief the whole build is made from — was a row you could
     * not open.
     */
    case 'talk':
    case 'manager':
    case 'commission':
    case 'delegate':
    case 'toolkit':
    case 'submit':
      return (
        (step.argsText !== undefined && step.argsText.length > 0) ||
        (step.output !== undefined && step.output.length > 0)
      );
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* ActivityStep                                                        */
/* ------------------------------------------------------------------ */

export interface ActivityStepProps {
  /** Host-supplied app-name → picture, for a step that acted on an app. */
  resolveAppIcon?: (app: string) => string | undefined;
  data: ActivityStepData;
  /** Toggles a pill-gated step's content (bash/edit/read/file). */
  expanded?: boolean;
  /** This step is streaming live — thought content shows un-clamped. */
  live?: boolean;
  /** Toggles inline content (kinds without `opensInCanvas`). */
  onToggle?: () => void;
  /** Fired for `opensInCanvas` steps instead of toggling. */
  onOpenCanvas?: () => void;
  /**
   * Fired for a file-op row (read/edit/skill with a path) to OPEN that file in
   * the canvas. When set, the row's primary click opens the file and a trailing
   * chevron still discloses the raw args + result; when unset the row falls back
   * to the plain disclosure toggle. Wired by the app (ThreadActivity).
   */
  onOpenFile?: () => void;
}

/**
 * HOW LONG THIS STEP HAS BEEN GOING.
 *
 * the user, watching a command sit there: "some 'seconds' timer going on here would
 * be much appreciated, it's been going for a few minutes, seems like it should
 * be timing out by now." Without it a step that is working and a step that is
 * wedged look identical — the same gap as the processing ring, one level down,
 * and the reason a hung `python3 app.py` went unnoticed for five minutes.
 *
 * Measured from when the row first appeared as running, which is exactly the
 * question being asked ("how long have I been staring at this"), and needs no
 * per-step timestamp threaded through the engine.
 */
export function elapsedLabel(ms: number): string | null {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 2) return null; // don't flicker a "0s" onto every quick step
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * `since` is when the step actually began, when the caller knows it — the timer
 * then survives a remount instead of restarting at zero. Without it the clock
 * starts at mount, which is still the question being asked.
 */
/**
 * FIRST TIME WE EVER SAW THIS STEP RUNNING, keyed by its stable id.
 *
 * the user: "the timer for tool calls… just resets every time I go to a new chat
 * and come back or check on anything else." The clock fell back to MOUNT time
 * whenever the caller had no `startedAt`, so every remount — switching chats,
 * opening a panel, a re-render that drops the subtree — restarted it at zero.
 * A step's start is a fact about the step, not about when a component happened
 * to mount, so it lives outside React.
 */
const STEP_FIRST_SEEN = new Map<string, number>();

function RunningFor({ since, stepId }: { since?: number; stepId?: string }) {
  const [mounted] = useState(() => {
    if (stepId === undefined) return Date.now();
    const prior = STEP_FIRST_SEEN.get(stepId);
    if (prior !== undefined) return prior;
    const t = Date.now();
    STEP_FIRST_SEEN.set(stepId, t);
    return t;
  });
  const start = since ?? mounted;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const label = elapsedLabel(now - start);
  if (label === null) return null;
  return <span className="pd-chain-step-elapsed">{label}</span>;
}

/** One row of the expanded chain: icon + verb + inline arg, then a disclosure reveal. */
export const ActivityStep = forwardRef<HTMLDivElement, ActivityStepProps>(function ActivityStep(
  { data, expanded = false, live = false, onToggle, onOpenCanvas, onOpenFile, resolveAppIcon },
  ref,
) {
  const running = data.status === 'running';
  const canvas = data.opensInCanvas === true;
  const inline = isInlineKind(data.kind);
  // Pill-gated kinds (bash/edit/read/file/skill/browser-read/connector/tool) turn
  // the WHOLE row into a disclosure control (the user round-2 #2): click to reveal the
  // full arg + the result/output.
  const disclosable = !canvas && !inline && hasInlineContent(data);
  const canvasTag = data.tag ?? (data.filename ? basename(data.filename) : undefined);
  // The edit step carries its ±stat right beside the label (round-5 #12).
  const editStat = data.kind === 'edit' ? editTotals(data) : null;
  // The primary arg, surfaced next to the verb: a file-op path shows its basename
  // on a SUBLINE under the label; command/query/url kinds show it inline verbatim.
  const detail = data.detail !== undefined && data.detail !== '' ? data.detail : undefined;
  const subline =
    detail !== undefined && SUBLINE_KINDS.has(data.kind) ? basename(detail) : undefined;
  const detailInline =
    subline !== undefined
      ? undefined
      : detail === undefined
        ? undefined
        : PATH_DETAIL_KINDS.has(data.kind)
          ? basename(detail)
          : detail;
  const argHeader = disclosable && detail !== undefined && ARG_HEADER_KINDS.has(data.kind);
  // A file-op row (read/edit/skill with a path) can open that file in the canvas.
  const canOpen =
    onOpenFile !== undefined &&
    SUBLINE_KINDS.has(data.kind) &&
    detail !== undefined &&
    // A refused whole-file write names no file; the row discloses the reason instead.
    !(data.kind === 'edit' && data.noFile === true);

  /* The app's own icon when this step acted on an app and the host could find
     one — otherwise the generic tool glyph, which is still better than a wrong
     picture. */
  const appIcon = data.app === undefined ? undefined : resolveAppIcon?.(data.app);
  /*
   * A CONNECTOR ROW IS A DIFFERENT SENTENCE.
   *
   * the user: "for connector usage, the icon shown in the left is not the app icon,
   * but it shows as follows, left svg: <generic connectors icon> Used
   * <connector app icon> <connector app name> <action eg. read page or listed
   * tabs>". So the app's icon moves OUT of the leading slot — which now says
   * what KIND of thing this row is — and in beside the app's name, where it
   * belongs to the noun it illustrates.
   */
  const connectorRow = data.action !== undefined && data.app !== undefined;
  const iconEl = (
    <span className="pd-chain-step-icon">
      {running ? (
        <Spinner size={14} />
      ) : connectorRow ? (
        <IconConnector size={15} />
      ) : appIcon !== undefined ? (
        <img className="pd-chain-app-icon" src={appIcon} alt="" width={15} height={15} />
      ) : (
        <ToolIcon
          kind={data.kind}
          filename={data.filename}
          iconSvg={data.kind === 'connector' ? data.iconSvg : undefined}
        />
      )}
    </span>
  );

  const labelText = running ? <ShimmerText>{data.label}</ShimmerText> : data.label;
  /*
   * The elapsed counter rides on whichever row is running, and is folded into
   * `contentEls` so it reaches EVERY row variant — canvas button, split file-op
   * row, plain row. Built once and rendered from one branch, it would have shown
   * on some rows and not others.
   */
  const elapsedEl = running ? (
    <RunningFor
      {...(data.startedAt !== undefined ? { since: data.startedAt } : {})}
      {...(data.id !== undefined ? { stepId: data.id } : {})}
    />
  ) : null;
  /*
   * A STILL AGENT SAYS WHY IT IS STILL. Without this, "waiting" and "stopped"
   * are indistinguishable from "done" — the row just sits there — which is the
   * ambiguity the extra states exist to remove.
   */
  const stateWordEl = (() => {
    const w = statusWord(data.status ?? 'done');
    return w === null ? null : <span className="pd-chain-step-state">{w}</span>;
  })();
  // File-op rows read as a two-line stack (verb + filename subline); other rows
  // keep the verb + inline arg on one line.
  const contentEls =
    subline !== undefined ? (
      <span className="pd-chain-step-labels">
        <span className="pd-chain-step-label">
          {labelText}
          {elapsedEl}
          {stateWordEl}
        </span>
        <span className="pd-chain-step-subline" title={detail}>
          {subline}
        </span>
      </span>
    ) : connectorRow ? (
      /*
       * "Used <icon> <app> <action>", and NOTHING ELSE on the line. the user: "the
       * tiny text to the right with the raw cli command is not shown, instead a
       * '>' is shown ... clicking that expands the individual tool and shows the
       * exact cli command and what was returned." The command is not lost — it
       * is the row's detail, which is exactly what the disclosure reveals.
       */
      <span className="pd-chain-step-label pd-chain-used">
        <span className="pd-chain-used-verb">Used</span>
        {appIcon === undefined ? null : (
          <img className="pd-chain-app-icon" src={appIcon} alt="" width={14} height={14} />
        )}
        <span className="pd-chain-used-app">{data.app}</span>
        <span className="pd-chain-used-action">
          {running ? <ShimmerText>{data.action}</ShimmerText> : data.action}
        </span>
        {elapsedEl}
        {stateWordEl}
      </span>
    ) : (
      <>
        <span className="pd-chain-step-label">{labelText}</span>
        {detailInline !== undefined ? (
          <span className="pd-chain-step-detail" title={detail}>
            {detailInline}
          </span>
        ) : null}
        {elapsedEl}
        {stateWordEl}
      </>
    );

  // No ±stat on a refused edit: "+88" beside "Could not write the file" reads
  // as eighty-eight lines that landed. The reveal still shows the content.
  const editStatEl =
    editStat && data.failed !== true ? (
      <DiffStat
        className="pd-chain-step-diffstat"
        added={editStat.added}
        deleted={editStat.deleted}
      />
    ) : null;
  const chevronEl = (
    <span className="pd-chain-step-chevron" data-expanded={expanded}>
      <IconChevronRight size={12} />
    </span>
  );
  const openLabel = `Open ${subline ?? 'file'} in canvas`;

  return (
    <div
      ref={ref}
      className="pd-chain-step"
      data-expanded={disclosable ? expanded : undefined}
      data-kind={data.kind}
      /* A FAILED STEP IS RED, and only here. the user: "expanded tool calls show
       * fails as red and clicking it shows the actual error". The summary above
       * no longer carries a "(N failed)" tail, so this is where a failure is
       * visible — on the row you can open to see what actually went wrong. */
      data-failed={data.failed === true ? 'true' : undefined}
      /* The five-state colour hook: waiting / stopped (orange) / error (red) /
       * done (green). Carried on the row so the icon, label and state chip all
       * tint from ONE source rather than three components each deciding. */
      data-status={data.status ?? 'done'}
    >
      {canvas ? (
        <button type="button" className="pd-chain-step-row pd-focusable" onClick={onOpenCanvas}>
          {iconEl}
          {contentEls}
          {editStatEl}
          {canvasTag !== undefined ? <span className="pd-chain-step-tag">{canvasTag}</span> : null}
          <span className="pd-chain-step-canvas" role="img" aria-label="Opens in canvas">
            <IconExternal size={13} />
          </span>
        </button>
      ) : canOpen && disclosable ? (
        // File-op row with content: main click OPENS the file in canvas; the
        // trailing chevron discloses the raw args + result.
        <div className="pd-chain-step-row pd-chain-step-row--split">
          <button
            type="button"
            className="pd-chain-step-open-main pd-focusable"
            onClick={onOpenFile}
            aria-label={openLabel}
            title={openLabel}
          >
            {iconEl}
            {contentEls}
            {editStatEl}
          </button>
          <button
            type="button"
            className="pd-chain-step-disclose pd-focusable"
            aria-expanded={expanded}
            aria-label="Show details"
            onClick={onToggle}
          >
            {chevronEl}
          </button>
        </div>
      ) : canOpen ? (
        // File-op row with no captured content yet: the whole row opens the file.
        <button
          type="button"
          className="pd-chain-step-row pd-focusable"
          onClick={onOpenFile}
          aria-label={openLabel}
          title={openLabel}
        >
          {iconEl}
          {contentEls}
          {editStatEl}
          <span className="pd-chain-step-canvas" role="img" aria-label="Opens in canvas">
            <IconExternal size={13} />
          </span>
        </button>
      ) : disclosable ? (
        <button
          type="button"
          className="pd-chain-step-row pd-focusable"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {iconEl}
          {contentEls}
          {editStatEl}
          {chevronEl}
        </button>
      ) : (
        <div className="pd-chain-step-row">
          {iconEl}
          {contentEls}
          {editStatEl}
        </div>
      )}

      {inline && hasInlineContent(data) ? (
        // Thoughts never scroll (they fade + Show more); search keeps a bounded scroll.
        <div
          className={clsx(
            'pd-chain-step-inline',
            data.kind !== 'thinking' && 'pd-chain-step-inline--scroll pd-scroll',
          )}
        >
          <StepContent step={data} live={live} />
        </div>
      ) : null}

      {disclosable ? (
        <div className="pd-chain-reveal" data-open={expanded}>
          <div className="pd-chain-reveal-inner">
            <div className="pd-chain-step-content pd-scroll">
              {argHeader ? (
                <div className="pd-chain-arg" title={detail}>
                  {detail}
                </div>
              ) : null}
              <StepContent step={data} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* ActivityChain                                                       */
/* ------------------------------------------------------------------ */

export interface ActivityChainProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  steps: ActivityStepData[];
  /** Controlled chain expansion (collapsed summary <-> step list). */
  expanded?: boolean;
  defaultExpanded?: boolean;
  /**
   * Streaming/live: while true the chain is FORCE-EXPANDED and its thoughts show
   * un-clamped so the user watches the run generate; the moment it flips false
   * (the run's response text begins, or the turn ends) the chain COLLAPSES to its
   * summary. Overrides `defaultExpanded`/user toggles for the duration. Collapse
   * animates via the existing height roll (reduced-motion safe).
   */
  active?: boolean;
  /**
   * Whether the TURN this chain belongs to is over, from whoever owns it.
   * Supplied → the only thing that can show the terminal "Done". Omitted → the
   * chain falls back to inferring it from quiet rows, which is correct for a
   * historical transcript and wrong for a live one.
   */
  complete?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Seed which pill-gated step's content is open on mount (index into `steps`). */
  defaultOpenStep?: number;
  /** Override the derived past-tense summary line. */
  summary?: ReactNode;
  /** Activated for a step whose `opensInCanvas` is set. */
  onOpenCanvas?: (step: ActivityStepData, index: number) => void;
  /** Activated for a file-op step (read/edit/skill) to open its file in the canvas. */
  onOpenFile?: (step: ActivityStepData, index: number) => void;
  /**
   * The turn is PREFILLING — the model is ingesting the prompt and has produced
   * nothing yet. Renders a trailing processing step carrying the real percent,
   * and suppresses the terminal "Done".
   *
   * A long prefill is silence: no row is running, nothing is streaming, and the
   * chain looks exactly like a finished one. the user: "we can't see what the model
   * is doing right now at this moment… that bottom item should say processing…
   * then completely replace it with the actual tool call / thinking once that's
   * done and generation resumes. we need to have an idea of what's going on at
   * all times."
   *
   * `percent: null` = ingesting but no frame yet (indeterminate). Clear the whole
   * prop the instant tokens resume — the real row takes its place.
   */
  /** The prefill row: how far along, and WHAT this wait is. The label names
   * the cause ("Loading model", "Loading Computer use tools", "Starting up")
   * because "processing the prompt" describes the mechanism to somebody who is
   * waiting to know why. */
  prefill?: { percent: number | null; label?: string };
  /** Turn an app name into a picture of it. Supplied by the host, because only
   * the host can ask macOS; the chain just carries the name. */
  resolveAppIcon?: (app: string) => string | undefined;
}

/**
 * True once `quiet` has held for {@link SETTLE_MS} — a completion that has to
 * stay true for a moment before it is believed.
 *
 * Deliberately asymmetric: it drops to false the INSTANT work resumes (so a new
 * step never renders under a "Done"), and only rises after the pause. A marker
 * that flickers on every gap between tool calls is not information, and the gap
 * is normal — the model is deciding what to do next.
 */
const SETTLE_MS = 600;

function useSettled(quiet: boolean): boolean {
  /*
   * SEEDED FROM THE FIRST RENDER. A chain that mounts already finished — a
   * scrolled-back turn, a rehydrated transcript, a static render — is settled
   * NOW and should say so; only a chain that goes quiet while you are watching
   * has to prove it. Starting at false made every historical turn wait 600ms to
   * admit it was over, and made the marker vanish entirely without an effect.
   */
  const [settled, setSettled] = useState(quiet);
  useEffect(() => {
    if (!quiet) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [quiet]);
  return settled;
}

/** Collapsed/expandable run of tool + thinking steps. */
export const ActivityChain = forwardRef<HTMLDivElement, ActivityChainProps>(function ActivityChain(
  {
    steps,
    expanded,
    defaultExpanded = false,
    active = false,
    complete,
    onExpandedChange,
    defaultOpenStep,
    resolveAppIcon,
    summary,
    onOpenCanvas,
    onOpenFile,
    prefill,
    className,
    ...rest
  },
  ref,
) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  /*
   * A LIVE CHAIN CAN BE COLLAPSED. It could not before: `isExpanded` ignored
   * `internalExpanded` while active AND `toggleChain` returned early, so clicking
   * the summary of a running step did nothing at all until the run finished.
   * the user: "'working/thinking/using tool' expansion is not collapsable until it is
   * complete". On a long turn that is the whole time it matters — a chain that
   * opens itself and then refuses to shut is a wall of text you cannot get past.
   *
   * Auto-open is still the default, because seeing work as it happens is the
   * point. It is just no longer compulsory: once the user says otherwise, their
   * choice holds for the rest of the run. A NEW run clears it, so the next turn
   * opens again rather than inheriting a decision about a different piece of work.
   */
  const [userChose, setUserChose] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setUserChose(false);
    wasActive.current = active;
  }, [active]);
  const [openStep, setOpenStep] = useState<number | null>(defaultOpenStep ?? null);

  const running = steps.some((s) => s.status === 'running');
  /*
   * IT STAYS OPEN UNTIL IT IS DONE. the user: "no expanding/closing tool / think
   * blocks it stays open until it says done". `active` dips between tool calls,
   * so keying the auto-open on it alone made the chain snap shut and reopen on
   * every gap. A live turn — `active`, or anything running, or a prefill in
   * flight, or a caller that says the turn is not over — holds it open unless
   * the user has chosen otherwise.
   */
  /*
   * LIVE MEANS THIS CHAIN, NOT THIS TURN.
   *
   * `complete === false` was in here so a chain would not fold while the turn
   * was still going — but the turn is still going while the model TYPES ITS
   * REPLY, and while the NEXT chain runs, so a finished chain sat open through
   * both. the user: "thinking / tool chains need to collapse when they finish and
   * the model starts typing actual response, even if a new one starts right
   * after, the old one is then collapsed."
   *
   * The other three terms are all about this chain and stay: `active` (the
   * caller says this is the live one), `running` (a step of ITS own is going),
   * and a prefill in flight. `complete` keeps its real job, which is deciding
   * when "Done" may be printed — a claim about the work, not about who is on
   * screen.
   */
  const live = active || running || prefill !== undefined;
  const isExpanded = expanded ?? (userChose || !live ? internalExpanded : true);
  /* A PREFILLING turn is not a settled one. Without this the chain has no
   * running step, goes quiet, and prints "Done" over a model that is still
   * ingesting the prompt — the premature-completion family again, one layer
   * down. */
  /*
   * DONE IS FINAL, AND IT IS THE TURN THAT DECIDES IT — NOT QUIET ROWS.
   *
   * the user, three rounds of this: "the premature done just needs to be fixed now
   * though… it doesn't say done until it's truly totally done." Then: "done is
   * a final thing. This tool chain is DONE."
   *
   * `!running && !active` goes true in every gap between two tool calls and
   * across a long prefill, so Done printed, the next block erased it, and the
   * chain flapped. A 600ms debounce only delayed a decision whose inputs were
   * wrong.
   *
   * `complete` is the authoritative answer from whoever owns the turn. When it
   * is supplied, it is the ONLY thing that can show Done. When it is not (a
   * static render, a historical transcript), fall back to the old quiet test —
   * those are already over.
   *
   * And once shown, Done never retracts: latching is what makes it final rather
   * than a status that blinks.
   */
  const quiet = !running && !active && prefill === undefined;
  const settledGuess = useSettled(quiet);
  const [everDone, setEverDone] = useState(false);
  const doneNow = chainIsDone({ complete, quiet, settledGuess });
  /*
   * A FINISHED CHAIN FOLDS ITSELF AWAY. the user: "collapse thinking/tool chains
   * after they are finished (user can always reopen manually)."
   *
   * It stays open for the whole turn — that is the rule above, and it is the
   * one that matters while you are watching — but once the turn is genuinely
   * done the eight rows of it are history, and leaving them open pushes the
   * answer off the screen. Only when the user has not made their own choice:
   * someone who opened a step to read it keeps it open.
   */
  const foldedOnDone = useRef(false);
  useEffect(() => {
    if (!doneNow) {
      foldedOnDone.current = false;
      return;
    }
    if (foldedOnDone.current || userChose) return;
    foldedOnDone.current = true;
    setInternalExpanded(false);
    setOpenStep(null);
  }, [doneNow, userChose]);

  useEffect(() => {
    if (doneNow) {
      setEverDone(true);
      return;
    }
    /*
     * THE LATCH MUST NOT OUTLIVE THE TURN IT LATCHED ON.
     *
     * the user, reporting this for the FOURTH time with a screenshot: "premature
     * done is showing while thoughts/tools are still being written." A chain
     * that had legitimately settled — Done latched — then received more
     * thinking and another tool call, and went on showing Done underneath them
     * because latching was one-way.
     *
     * "Done is a final thing" was about not FLICKERING between two tool calls,
     * and `complete` already handles that: the turn's owner holds it false for
     * the whole turn, so quiet rows can never trip it. An owner that says
     * `complete === false` is making a positive statement that the turn is
     * live, and that has to be able to clear a stale latch — otherwise the one
     * signal we trust is outranked by a cached boolean.
     *
     * Only an explicit `false` clears it. `undefined` (a static render, a
     * replayed transcript) leaves the latch alone, because there is nobody
     * there to say otherwise.
     */
    if (complete === false) setEverDone(false);
  }, [doneNow, complete]);
  const settled = everDone || doneNow;
  const toggleChain = () => {
    const next = !isExpanded;
    if (expanded === undefined) {
      setInternalExpanded(next);
      if (active) setUserChose(true);
    }
    onExpandedChange?.(next);
  };
  const toggleStep = (index: number) => setOpenStep((cur) => (cur === index ? null : index));

  const summaryText = summary ?? activitySummary(steps);

  // Stable, index-free keys (dedupe repeated content with an occurrence suffix).
  const seen = new Map<string, number>();
  const renderSteps = steps.map((step, index) => {
    const base = step.id ?? `${step.kind}:${step.label}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { step, index, key: n === 0 ? base : `${base}#${n}` };
  });

  return (
    <div
      ref={ref}
      className={clsx('pd-chain', className)}
      data-expanded={isExpanded}
      data-running={running}
      {...rest}
    >
      <button
        type="button"
        className="pd-chain-summary pd-focusable"
        aria-expanded={isExpanded}
        onClick={toggleChain}
      >
        <span className="pd-chain-summary-text">
          {running ? <ShimmerText>{summaryText}</ShimmerText> : summaryText}
        </span>
        <span className="pd-chain-summary-chevron" data-expanded={isExpanded}>
          <IconChevronRight size={14} />
        </span>
      </button>

      {/* The step list rolls open/closed (grid-rows reveal) — steps stay mounted
       * so the collapse animates too. */}
      <div className="pd-chain-reveal" data-open={isExpanded}>
        <div className="pd-chain-reveal-inner">
          <div className="pd-chain-steps">
            {renderSteps.map(({ step, index, key }) => (
              <ActivityStep
                key={key}
                data={step}
                expanded={openStep === index}
                live={active}
                onToggle={() => toggleStep(index)}
                onOpenCanvas={() => onOpenCanvas?.(step, index)}
                {...(resolveAppIcon === undefined ? {} : { resolveAppIcon })}
                {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(step, index) } : {})}
              />
            ))}
            {/* PREFILL, as the chain's last step. Same ring the thread indicator
                uses, so one visual language means one thing; replaced by the real
                tool call or thought the moment tokens resume, because the prop is
                cleared then. */}
            {prefill !== undefined ? (
              <div className="pd-chain-step pd-chain-step--prefill">
                <div className="pd-chain-step-row">
                  <span className="pd-chain-step-icon">
                    <ContextGauge
                      value={prefill.percent === null ? 0 : Math.min(1, prefill.percent / 100)}
                      size={14}
                      className={`pd-processing-ring${prefill.percent === null ? ' pd-processing-ring--indeterminate' : ''}`}
                      label="processing"
                    />
                  </span>
                  <ShimmerText className="pd-chain-step-label">
                    {prefill.percent === null
                      ? `${prefill.label ?? 'Processing'}…`
                      : `${Math.round(prefill.percent)}% · ${prefill.label ?? 'processing the prompt'}`}
                  </ShimmerText>
                </div>
              </div>
            ) : null}
            {/* Terminal "Done" — shown only once the run has been finished for a
             * BEAT, never on the momentary inter-tool gap.
             *
             * `!running && !active` was not enough. Between two tool calls every
             * step is briefly settled AND `active` dips, so Done appeared, then
             * the next tool started and erased it — the user: "the bottom of the tool
             * chain will show 'done' prematurely but then it will get erased and
             * replaced constantly". Flapping a completion marker is worse than
             * showing nothing, because it is the one row that claims the run is
             * over. See {@link useSettled}. */}
            {settled ? (
              <div className="pd-chain-step pd-chain-done">
                <div className="pd-chain-step-row">
                  <span className="pd-chain-step-icon pd-chain-done-icon">
                    <IconCheck size={14} />
                  </span>
                  <span className="pd-chain-step-label">Done</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});
