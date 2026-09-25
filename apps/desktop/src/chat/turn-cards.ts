/**
 * WHERE A FINISHED CARD SITS — inside the activity chain that made it, or
 * beneath it.
 *
 * the user (2026-09-24): "generations/inline cards of any kind always seem to get
 * pinned to the bottom of the chat for quite some time, including during
 * working/iteration, eg. … I gave an image and asked for it edited in a certain
 * way, and the 4b qwen model has gone on and iterated visually over the
 * generated images improving each time toward the goal. however on each of it's
 * iterations the full image cards are presented at the very bottom of the chat
 * as if totally finished, these should be embedded in thinking blocks, not the
 * generating card, that stays out".
 *
 * Every card a turn made used to hang under the chain that made it (ThreadMedia)
 * or after the whole reply (present-store), so a turn that kept working stacked
 * each intermediate result at the foot of the conversation — a column of
 * finished-looking pictures while the model was three edits away from done.
 *
 * ONE QUESTION DECIDES EACH CARD: HAS THE WORK MOVED ON FROM IT?
 *
 *  - The newest thing a LIVE chain made sits beneath it, in the slot its
 *    generating card stood in. The reveal finishes where it started, and a
 *    result the model is about to talk about does not jump into the chain only
 *    to jump back out a second later when the reply begins (the chain folds the
 *    moment text starts — the user's rule — and a card that went in with it would
 *    have to come straight back).
 *  - The moment the chain calls ANYTHING after it, the work has moved on: the
 *    card files into the chain, under the row of the call that made it, and
 *    folds away with the chain. Thinking alone does not file it — a model that
 *    looks at its picture and then answers has not moved on from it.
 *  - Once a chain is no longer live (its reply began, a later chain took over,
 *    the turn ended) its DELIVERABLES come back out beneath it: everything it
 *    made that no later call went on to revise. A picture that a later
 *    `edit_image` took as its input was a draft of that later picture, so it
 *    stays in the chain and only the last version is outside — the answer
 *    shows its result without repeating every step of the iteration. A turn
 *    that made eight separate pictures (a children's book: one call per page)
 *    revised none of them, so all eight come out.
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

/**
 * The tools that make a NEW VERSION of a card of this kind out of an old one.
 * Only these can turn a card into a draft: a call that merely READS a picture
 * (the model looking at its own output) has not replaced it, and a video made
 * from a picture is a different thing the user may want both of.
 */
const REVISED_BY: Partial<Record<CardKind, ReadonlySet<string>>> = {
  image: new Set(['edit_image']),
  model: new Set(['refine_3d']),
};

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

/**
 * Where each card goes. `liveChain` is the chain the turn is working in right
 * now (the last segment of a streaming turn), or null when no chain is live.
 */
export function placeTurnCards(
  calls: readonly TurnCall[],
  cards: readonly TurnCard[],
  liveChain: number | null,
): Map<string, CardPlace> {
  const order = new Map(calls.map((c, i) => [c.id, i]));
  /* The same file from two calls — a picture saved over itself, a chart the
     model redrew in place — is ONE card, and it belongs to the newest call:
     that is the version on disk, which is what either card would show. */
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
    const later = calls.slice(at + 1);
    if (call.chain === liveChain) {
      const movedOn = later.some((c) => c.chain === call.chain);
      out.set(card.key, movedOn ? 'inside' : 'beneath');
      continue;
    }
    const revisers = REVISED_BY[card.kind];
    const revised =
      revisers !== undefined &&
      later.some(
        (c) => c.tool !== undefined && revisers.has(c.tool) && argsNamePath(c.args, card.path),
      );
    out.set(card.key, revised ? 'inside' : 'beneath');
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
