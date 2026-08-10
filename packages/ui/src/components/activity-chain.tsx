import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { DiffStat } from './activity.tsx';
import { type DiffFileData, DiffView } from './diff-view.tsx';
import { IconCheck, IconChevronRight, IconExternal } from './icons.tsx';
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
export type ActivityStatus = 'running' | 'done';

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
    })
  | (ActivityStepCommon & { kind: 'read' | 'file' | 'skill'; preview?: ReactNode })
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
  | (ActivityStepCommon & {
      kind: 'connector';
      /** The connector's inline brand SVG (mcp-lite connector-icons), if resolved. */
      iconSvg?: string;
      argsText?: string;
      output?: string;
    })
  | (ActivityStepCommon & { kind: 'image' | 'pdf' | 'canvas-open' });

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
  pdf: { verb: 'Created', singular: 'a PDF', plural: 'PDFs', attempt: 'PDF' },
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
  'pdf',
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
  pdf: 'Creating a PDF',
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
  return current ? RUNNING_PHRASE[current.kind] : 'Working…';
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
const PATH_DETAIL_KINDS = new Set<ActivityStepKind>(['read', 'edit', 'file', 'skill']);

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
const ARG_HEADER_KINDS = new Set<ActivityStepKind>(['read', 'file', 'skill', 'browser-read']);

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
}: {
  command?: string;
  output?: string;
  prompt?: string;
}) {
  const hasCmd = command !== undefined && command.length > 0;
  const hasOut = output !== undefined && output.length > 0;
  if (!hasCmd && !hasOut) return null;
  return (
    <div className="pd-chain-output pd-chain-termblock">
      <div className="pd-chain-output-frame">
        <pre className="pd-chain-output-body pd-scroll">
          {hasCmd ? (
            <span className="pd-term-cmd">
              <span className="pd-term-prompt">{prompt} </span>
              {command}
            </span>
          ) : null}
          {hasCmd && hasOut ? '\n' : null}
          {hasOut ? output : null}
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
              void navigator.clipboard?.writeText(text);
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
        />
      );
    case 'edit':
      return step.diff ? <DiffView files={step.diff} /> : null;
    case 'search':
      return step.results ? (
        <WebSearchResults
          query={step.query ?? step.label}
          results={step.results}
          emptyHint={step.note}
        />
      ) : null;
    case 'read':
    case 'file':
    case 'skill':
    case 'browser-read':
      return step.preview !== undefined ? (
        <div className="pd-chain-preview">{step.preview}</div>
      ) : null;
    // Generic tool / connector / tool_search: show ONLY the tool's result, as one
    // clean block — never the raw args JSON (that's the schema noise the user called
    // out). The row header already surfaces the tool name + its primary arg.
    case 'tool-search':
    case 'tool':
    case 'connector':
      return <TerminalBlock output={step.output} />;
    default:
      return null;
  }
}

/** Whether a step has inline content worth a reveal (pill) or inline render. */
function hasInlineContent(step: ActivityStepData): boolean {
  if (step.opensInCanvas) return false;
  switch (step.kind) {
    case 'thinking':
      return step.thought !== undefined;
    case 'bash':
    case 'python':
      return step.command !== undefined || step.output !== undefined;
    case 'edit':
      return step.diff !== undefined && step.diff.length > 0;
    case 'search':
      return step.results !== undefined;
    case 'read':
    case 'file':
    case 'skill':
    case 'browser-read':
      return step.preview !== undefined;
    case 'tool-search':
    case 'tool':
    case 'connector':
      // Only the result opens a reveal now — the raw args JSON is no longer shown,
      // so args alone must not produce an empty reveal.
      return step.output !== undefined && step.output.length > 0;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* ActivityStep                                                        */
/* ------------------------------------------------------------------ */

export interface ActivityStepProps {
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
function RunningFor({ since }: { since?: number }) {
  const [mounted] = useState(() => Date.now());
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
  { data, expanded = false, live = false, onToggle, onOpenCanvas, onOpenFile },
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
  const canOpen = onOpenFile !== undefined && SUBLINE_KINDS.has(data.kind) && detail !== undefined;

  const iconEl = (
    <span className="pd-chain-step-icon">
      {running ? (
        <Spinner size={14} />
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
  const elapsedEl = running ? <RunningFor since={data.startedAt} /> : null;
  // File-op rows read as a two-line stack (verb + filename subline); other rows
  // keep the verb + inline arg on one line.
  const contentEls =
    subline !== undefined ? (
      <span className="pd-chain-step-labels">
        <span className="pd-chain-step-label">
          {labelText}
          {elapsedEl}
        </span>
        <span className="pd-chain-step-subline" title={detail}>
          {subline}
        </span>
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
      </>
    );

  const editStatEl = editStat ? (
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
  prefill?: { percent: number | null };
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
    onExpandedChange,
    defaultOpenStep,
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
  const isExpanded = expanded ?? (userChose || !active ? internalExpanded : true);
  const [openStep, setOpenStep] = useState<number | null>(defaultOpenStep ?? null);

  const running = steps.some((s) => s.status === 'running');
  /* A PREFILLING turn is not a settled one. Without this the chain has no
   * running step, goes quiet, and prints "Done" over a model that is still
   * ingesting the prompt — the premature-completion family again, one layer
   * down. */
  const settled = useSettled(!running && !active && prefill === undefined);
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
                      ? 'Processing the prompt…'
                      : `${Math.round(prefill.percent)}% processing the prompt`}
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
