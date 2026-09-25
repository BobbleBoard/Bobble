/**
 * WHERE A FINISHED CARD SITS — inside the activity chain that made it, or
 * beneath it.
 *
 * the user (2026-09-24, first): "generations/inline cards of any kind always seem to
 * get pinned to the bottom of the chat for quite some time, including during
 * working/iteration … on each of it's iterations the full image cards are
 * presented at the very bottom of the chat as if totally finished, these should
 * be embedded in thinking blocks, not the generating card, that stays out".
 *
 * the user (2026-09-24, later): "have generated stuff go inside a thought process at
 * first and only show outside the thought process if present is called on it,
 * still clickable within the thought process embed it smaller than full inside
 * the work/think block where it was generated, just no hover buttons and such
 * when it's not presented and shown in the full big card."
 *
 * ONE QUESTION DECIDES EACH CARD: DID THE MODEL HAND IT OVER?
 *
 *  - Whatever a call MAKES — a picture, a chart, a drawing, a mesh, a clip — is
 *    part of the work, and files into the chain under the row of the call that
 *    made it, small, clickable, without the card's controls (global.css
 *    `.pd-chain-step-attachment`). It folds away with the chain.
 *  - Whatever the model PRESENTS is the answer: the `present` call's card stands
 *    beneath the chain, full size, with its controls. Presenting is the model's
 *    one deliberate act of showing — the tool that also hands it a look at what
 *    the user will see — so the answer is exactly what it chose to show, and an
 *    iteration's drafts never pose as results.
 *  - The generating card is neither: it stands beneath the live chain while the
 *    job runs (the wait is the one thing a folding chain must never hide), plays
 *    its reveal there, and the result then files in.
 *
 * (The earlier rule brought a chain's "deliverables" back out when it went quiet
 * — everything no later call had revised. It guessed at what the answer was; the
 * model knows, and says so by presenting.)
 *
 * Pure: no React, no store. AssistantGroup gathers the facts and renders what
 * this decides.
 */
import { pdFilePath } from './thread-media';

/** A card's family — which later tools could be making a new version of it. */
export type CardKind = 'image' | 'video' | 'audio' | 'model' | 'record';

/** One tool call of the turn, in the order it was written. */
export interface TurnCall {
  readonly id: string;
  /** The chain (segment index in the group) the call sits in. */
  readonly chain: number;
  /** The tool behind the call — a `bash media edit image …` is `edit_image`. */
  readonly tool: string | undefined;
  readonly args: unknown;
}

/** One finished thing a call made. */
export interface TurnCard {
  /** Unique within the turn. */
  readonly key: string;
  readonly callId: string;
  /** Absolute path of the file the card shows. */
  readonly path: string;
  readonly kind: CardKind;
}

/**
 * `inside` — under its call's row in the chain; `beneath` — outside the chain,
 * right under it; `none` — not drawn here because a LATER call in the turn shows
 * the very same file (one card per file, at the newest call that made it).
 */
export type CardPlace = 'inside' | 'beneath' | 'none';

/** The words of a command line, unquoted: `--image_path="/a b.png"` → `/a b.png`. */
function wordsOf(text: string): string[] {
  return (
    text
      .match(/"[^"]*"|'[^']*'|[^\s"'=]+/g)
      ?.map((w) => w.replace(/^["']|["']$/g, '').replace(/[.,;:)]+$/, '')) ?? []
  );
}

/** Does this one string refer to the file at `absPath`? */
function stringNames(value: string, absPath: string): boolean {
  if (value.includes(absPath)) return true;
  for (const word of wordsOf(value)) {
    if (word === '') continue;
    if (word.startsWith('pd-file://')) {
      if (pdFilePath(word) === absPath) return true;
      continue;
    }
    // A path relative to the working folder — the way a model is told to name
    // its files (workspace-relative.ts) — names the file whose path it ends.
    const rel = word.replace(/^\.\//, '');
    if (rel !== '' && absPath.endsWith(`/${rel}`)) return true;
  }
  return false;
}

/**
 * Do these tool arguments name the file at `absPath` — as a value, inside a
 * command line (`media edit image --image_path=…` through bash), or as a path
 * relative to the working folder?
 */
export function argsNamePath(args: unknown, absPath: string): boolean {
  if (typeof args === 'string') return stringNames(args, absPath);
  if (Array.isArray(args)) return args.some((v) => argsNamePath(v, absPath));
  if (args !== null && typeof args === 'object') {
    return Object.values(args as Record<string, unknown>).some((v) => argsNamePath(v, absPath));
  }
  return false;
}

/** The tool whose card is the answer — see the header. */
const PRESENT = 'present';

/** Where each card goes: beneath the chain if the model presented it, else in it. */
export function placeTurnCards(
  calls: readonly TurnCall[],
  cards: readonly TurnCard[],
): Map<string, CardPlace> {
  const order = new Map(calls.map((c, i) => [c.id, i]));
  /* The same file from two calls — a picture saved over itself, a chart the
     model redrew in place, a picture it then presented — is ONE card, and it
     belongs to the newest call: that is the version on disk, and a present of
     it is the model saying this one is the answer. */
  const newestCall = new Map<string, number>();
  for (const card of cards) {
    const at = order.get(card.callId) ?? -1;
    const seen = newestCall.get(card.path);
    if (seen === undefined || at > seen) newestCall.set(card.path, at);
  }
  const out = new Map<string, CardPlace>();
  for (const card of cards) {
    const at = order.get(card.callId);
    const call = at === undefined ? undefined : calls[at];
    // A card whose call is not in any chain has nowhere inside to go.
    if (at === undefined || call === undefined) {
      out.set(card.key, 'beneath');
      continue;
    }
    if ((newestCall.get(card.path) ?? at) > at) {
      out.set(card.key, 'none');
      continue;
    }
    out.set(card.key, call.tool === PRESENT ? 'beneath' : 'inside');
  }
  return out;
}

/* ── which call made a presented card ─────────────────────────────────── */

/** A tool result, reduced to what attribution reads. */
export interface CallResultFacts {
  readonly id: string;
  /** The tool behind the call (effective name). */
  readonly tool: string | undefined;
  readonly text: string | undefined;
  readonly isError: boolean;
}

/**
 * Tools whose result HANDS a file over — the ones a presented card comes from.
 * The chart and svg tools present what they draw (present-inline, gen-stream);
 * `present` is the model saying "this one". A `read` of the same file afterwards
 * names it too, and must not take the card away from the call that made it.
 */
const HANDS_OVER = new Set([
  'present',
  'chart',
  'chart_edit',
  'generate_svg',
  'generate_image',
  'edit_image',
  'generate_video',
  'generate_speech',
  'generate_music',
  'generate_sfx',
  'generate_3d',
  'refine_3d',
]);
/** The same hand-over as a CLI line through bash: the tools' own first words. */
const HANDS_OVER_TEXT = /^(?:Drew|Changed|Presented|Made \d+ SVGs?)\b/;

/**
 * Does this tool result name the file at `absPath`? Absolute, or relative to the
 * working folder — the chart tool has said `Drew …: units.svg` since 2026-09-17,
 * and `present` says `Presented draw/bicycle.svg to the user.`
 */
export function resultNamesPath(text: string, absPath: string): boolean {
  return stringNames(text, absPath);
}

/**
 * Pin each presented card to the call that made it. Cards no call in the turn
 * can account for — presented by hand, or from a turn that has been edited away
 * — come back as `loose`, and are drawn where they always were.
 */
export function attributeRecords<R extends { readonly path: string }>(
  calls: readonly CallResultFacts[],
  records: readonly R[],
): { byCall: Map<string, R[]>; loose: R[] } {
  const byCall = new Map<string, R[]>();
  const loose: R[] = [];
  for (const record of records) {
    let pick: CallResultFacts | undefined;
    let fallback: CallResultFacts | undefined;
    for (const call of calls) {
      if (call.isError || typeof call.text !== 'string' || call.text === '') continue;
      if (!resultNamesPath(call.text, record.path)) continue;
      // The LAST call that names it: a chart redrawn in place was last touched
      // by the edit, and that is where its card belongs.
      fallback = call;
      if (
        (call.tool !== undefined && HANDS_OVER.has(call.tool)) ||
        HANDS_OVER_TEXT.test(call.text)
      ) {
        pick = call;
      }
    }
    const owner = pick ?? fallback;
    if (owner === undefined) {
      loose.push(record);
      continue;
    }
    const list = byCall.get(owner.id);
    if (list === undefined) byCall.set(owner.id, [record]);
    else list.push(record);
  }
  return { byCall, loose };
}
