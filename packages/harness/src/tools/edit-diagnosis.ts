/*
 * WHY AN EDIT THAT DID NOT MATCH IS THE HARNESS'S PROBLEM.
 *
 * Run G, verbatim from the transcript: asked to fix a tkinter app, the model made
 * SIX `edit` calls over ten minutes. Every one failed. The file was never written
 * — it ended the run byte-identical to the fixture — and the thread summarised the
 * turn as "edited 6 files".
 *
 * What it got back each time was:
 *
 *   Could not find edits[1] in /Users/user/bobble-testbed/buggyapp/app.py.
 *   The oldText must match exactly including all whitespace and newlines.
 *
 * The actual defect in the last attempt was one character: it wrote
 * `TinyConvert v0.9_BETA` where the file says `TinyConvert v0.9 BETA` — an
 * underscore for a space, inside a 1165-character file. It re-read the file four
 * times looking for it and never saw it. It cannot see it; that is the whole
 * point. Nor can it see that edits[0] was FINE and only edits[1] was wrong,
 * because the batch is atomic — so it kept rewriting the parts that were already
 * correct and lost them again.
 *
 * The error asks the model to perform a diff. The harness has both strings. It
 * should perform the diff. That is the one pattern that has reliably moved this
 * model all session: don't ask for the check, run it and hand over the answer.
 *
 * Two things this produces, both of which the raw error withholds:
 *   1. the exact position and identity of the first differing character, with
 *      whitespace made visible, against the file's real line; and
 *   2. EVERY entry that will not match — not just the first. Attempts 5 and 6
 *      failed on edits[3] and then edits[1]: the model was discovering its
 *      mistakes one round-trip at a time, and each round cost minutes.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A rendering of one character that survives being printed in a tool result. */
function visible(ch: string | undefined): string {
  if (ch === undefined) return 'end of line';
  const code = ch.codePointAt(0) ?? 0;
  const point = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  if (ch === ' ') return `a space (${point})`;
  if (ch === '\t') return `a tab (${point})`;
  if (ch === '\n') return `a newline (${point})`;
  if (code < 0x20) return `a control character (${point})`;
  /* Non-ASCII look-alikes are the other half of this bug class: a curly quote or
   * a non-breaking space is invisible next to its ASCII twin. */
  if (code > 0x7e) return `"${ch}" (${point}, not ASCII)`;
  return `"${ch}" (${point})`;
}

/** Spaces shown as middle dots and tabs as arrows, so an indent mismatch reads. */
function showWhitespace(line: string): string {
  return line.replace(/ /g, '·').replace(/\t/g, '→');
}

/**
 * How alike two lines are, 0..1. Cheap on purpose: a normalized-equality check
 * first (catches the whole indent/trailing-space family), then a longest-common-
 * prefix ratio. Good enough to pick the intended line out of a source file.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.trim() === b.trim()) return 0.95;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 0.9;
  /* Same letters and digits, different punctuation — a curly quote for a straight
   * one, an underscore for a space. A prefix/suffix ratio scores these BELOW the
   * cutoff (the run G line came to 0.465) precisely because the difference sits
   * mid-string, which is exactly where an invisible substitution likes to hide. */
  const bare = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '');
  if (bare(a).length > 0 && bare(a) === bare(b)) return 0.85;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  let tail = 0;
  while (
    tail < a.length - shared &&
    tail < b.length - shared &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return (shared + tail) / longest;
}

export interface EditMiss {
  /** Index into `edits[]`, so the message names the same entry the tool does. */
  index: number;
  /** 1-based line in the file of the closest thing to what the model wrote. */
  line: number;
  /** 1-based column of the first difference on that line. */
  column: number;
  fileLine: string;
  modelLine: string;
  /** Human phrasing of the two characters that differ. */
  expected: string;
  actual: string;
  /** How close the anchor line was (1 = the line is identical, so the mismatch
   *  is further down the block rather than on the anchor itself). */
  confidence: number;
}

/**
 * Locate what the model probably MEANT to match, and where its text first
 * diverges from it. Returns null when nothing in the file is close enough to
 * point at — better to stay quiet than to send it to the wrong line.
 */
export function nearestMiss(fileText: string, oldText: string, index = 0): EditMiss | null {
  const wanted = oldText.split('\n');
  const firstWanted = wanted[0] ?? '';
  if (firstWanted.trim().length === 0) return null;
  const lines = fileText.split('\n');

  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i] ?? '', firstWanted);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  /* Below this the "closest line" is noise and pointing at it would mislead. */
  if (bestLine === -1 || bestScore < 0.5) return null;

  /*
   * The anchor may be identical while the mismatch sits on a LATER line of the
   * block (attempt 1's oldText spanned two lines). Walk the block and report the
   * first line that actually differs.
   */
  let offsetInBlock = 0;
  while (
    offsetInBlock < wanted.length &&
    (lines[bestLine + offsetInBlock] ?? undefined) === wanted[offsetInBlock]
  ) {
    offsetInBlock += 1;
  }
  if (offsetInBlock >= wanted.length) return null; // it all matches here

  const fileLine = lines[bestLine + offsetInBlock] ?? '';
  const modelLine = wanted[offsetInBlock] ?? '';
  let column = 0;
  while (
    column < fileLine.length &&
    column < modelLine.length &&
    fileLine[column] === modelLine[column]
  ) {
    column += 1;
  }
  return {
    index,
    line: bestLine + offsetInBlock + 1,
    column: column + 1,
    fileLine,
    modelLine,
    expected: visible(fileLine[column]),
    actual: visible(modelLine[column]),
    confidence: bestScore,
  };
}

/** Would this oldText be found, and found exactly once? Mirrors the tool's rule. */
function matchState(fileText: string, oldText: string): 'ok' | 'missing' | 'ambiguous' {
  if (oldText.length === 0) return 'missing';
  const first = fileText.indexOf(oldText);
  if (first === -1) return 'missing';
  return fileText.indexOf(oldText, first + 1) === -1 ? 'ok' : 'ambiguous';
}

export interface EditEntry {
  oldText?: unknown;
  newText?: unknown;
}

/**
 * The note appended to a failed `edit` result. Empty string when there is
 * nothing useful to add — a silent no-op is always better than noise.
 */
export function diagnoseEdit(fileText: string, edits: EditEntry[], fileName: string): string {
  const misses: string[] = [];
  const ambiguous: number[] = [];
  let matched = 0;

  for (let i = 0; i < edits.length; i++) {
    const oldText = edits[i]?.oldText;
    if (typeof oldText !== 'string') continue;
    const state = matchState(fileText, oldText);
    if (state === 'ok') {
      matched += 1;
      continue;
    }
    if (state === 'ambiguous') {
      ambiguous.push(i);
      continue;
    }
    const miss = nearestMiss(fileText, oldText, i);
    if (miss === null) {
      misses.push(`edits[${i}]: this text is not in the file at all.`);
      continue;
    }
    const caret = `${' '.repeat(Math.max(0, miss.column - 1))}^`;
    misses.push(
      [
        `edits[${i}] — closest match is line ${miss.line}:`,
        `  file : ${showWhitespace(miss.fileLine)}`,
        `  yours: ${showWhitespace(miss.modelLine)}`,
        `         ${caret}`,
        `  Column ${miss.column}: the file has ${miss.expected}, you wrote ${miss.actual}.`,
      ].join('\n'),
    );
  }

  if (misses.length === 0 && ambiguous.length === 0) return '';

  const out: string[] = ['', `Checked every entry against ${fileName}:`];
  /* Say what was RIGHT. The batch is atomic, so a correct entry is thrown away
   * with the bad one — without this the model rewrites (and re-breaks) the parts
   * it already had. Run G lost the same correct edits[0] six times. */
  if (matched > 0) {
    out.push(
      `  ${matched} of ${edits.length} would have matched — they were discarded only because the others failed, so send them again UNCHANGED.`,
    );
  }
  for (const m of misses) out.push(m);
  for (const i of ambiguous) {
    out.push(`edits[${i}]: appears more than once — include a surrounding line to make it unique.`);
  }
  out.push('Copy the text exactly as `read` printed it (· marks a space, → a tab).');
  return out.join('\n');
}

/**
 * The `tool_result` entry point: pull `path` + `edits` off the rejected call,
 * read the file back and diagnose. Returns '' on anything unexpected — a failed
 * edit is already a bad moment, and a thrown diagnostic would replace a real
 * error with a worse one.
 */
export function diagnoseEditFailure(
  input: Record<string, unknown>,
  cwd?: string,
  readText: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): string {
  try {
    const raw = input.path;
    const edits = input.edits;
    if (typeof raw !== 'string' || !Array.isArray(edits) || edits.length === 0) return '';
    /*
     * EXPAND `~` FIRST. The model writes `~/proj/app.py` constantly, and every
     * time something downstream forgot to expand it, the check silently did
     * nothing and read as a pass — the quoted-tilde py_compile, then present
     * showing an empty card. Same trap, third door.
     */
    const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    const file = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(cwd ?? process.cwd(), expanded);
    return diagnoseEdit(readText(file), edits as EditEntry[], path.basename(file));
  } catch {
    return '';
  }
}
