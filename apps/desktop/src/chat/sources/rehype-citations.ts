/**
 * LINKS THAT SIT TOGETHER BECOME ONE CITATION.
 *
 * The model cites the way every model already writes a link — `[Site](url)`
 * right after the sentence it supports — and three of them in a row read, as
 * plain links, like "Brain Atlas Project Neuro Journal National Health
 * Research": one run-on blue phrase (SEEN in the first render of this). Google's
 * overview shows the same thing as ONE chip, "Brain Atlas Project +2".
 *
 * This is the tree pass that decides the grouping, before anything renders: a
 * run of links to THIS TURN's sources, joined only by spaces, commas,
 * semicolons or "and", becomes one `pd-cite` element carrying their keys. The
 * parentheses around a run that fills them go with it — "(A, B)" is a citation,
 * not a parenthetical — and runs split by a closing and an opening bracket
 * ("(A) (B)") join up once their brackets are gone. A link to a page the turn
 * did not see is never touched: it breaks a run and stays an ordinary link.
 *
 * Working on the parsed tree is what keeps code spans, fences and maths out of
 * it for free: a URL in a code block is text there, not a link.
 */

/** The element a run becomes; `citation-markdown.tsx` maps it to the chip. */
export const CITE_TAG = 'pd-cite';

/** The hast shape this pass reads — kept local rather than depending on @types/hast. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

export interface RehypeCitationOptions {
  /** A link's source key when it points at one of this turn's sources, else null. */
  readonly keyOf: (href: string) => string | null;
}

/** Text allowed BETWEEN two links of one run. */
const JOINER = /^[\s,;&·]*(?:(?:\band\b|\bor\b)[\s,;&·]*)?$/i;

function linkKey(node: HNode | undefined, keyOf: RehypeCitationOptions['keyOf']): string | null {
  if (node?.type !== 'element' || node.tagName !== 'a') return null;
  const href = node.properties?.href;
  return typeof href === 'string' ? keyOf(href) : null;
}

function isText(node: HNode | undefined): node is HNode & { value: string } {
  return node?.type === 'text' && typeof node.value === 'string';
}

function textOf(node: HNode): string {
  if (isText(node)) return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function citeElement(keys: string[], label: string): HNode {
  return {
    type: 'element',
    tagName: CITE_TAG,
    properties: { dataKeys: [...new Set(keys)].join(' '), dataLabel: label },
    children: [],
  };
}

/** Group one parent's children in place. */
function groupChildren(parent: HNode, keyOf: RehypeCitationOptions['keyOf']): void {
  const kids = parent.children;
  if (kids === undefined) return;

  // Pass 1: runs of source links → one cite each.
  for (let i = 0; i < kids.length; i += 1) {
    const first = linkKey(kids[i], keyOf);
    if (first === null) continue;
    const keys = [first];
    let end = i;
    for (let j = i + 1; j < kids.length; ) {
      const k = linkKey(kids[j], keyOf);
      if (k !== null) {
        keys.push(k);
        end = j;
        j += 1;
        continue;
      }
      const next = linkKey(kids[j + 1], keyOf);
      if (isText(kids[j]) && JOINER.test(kids[j]?.value ?? '') && next !== null) {
        keys.push(next);
        end = j + 1;
        j += 2;
        continue;
      }
      break;
    }
    // The brackets a run fills belong to it — and a full stop after them
    // belongs to the SENTENCE: "…the result ([A], [B])." reads "…the result."
    // then the chip, the way a citation follows the claim it supports.
    const before = kids[i - 1];
    const after = kids[end + 1];
    const bracketed =
      isText(before) && isText(after) && /\(\s*$/.test(before.value) && /^\s*\)/.test(after.value);
    if (bracketed) {
      before.value = before.value.replace(/\s*\(\s*$/, ' ');
      after.value = after.value.replace(/^\s*\)/, '');
    }
    /*
     * A link glued to the word before it ("…after manual verification[Nature](…).")
     * is a citation too — nobody glues a link into their own sentence — and the
     * same goes for its full stop. SEEN on a real research turn: the chip sat
     * between the claim and its period.
     */
    const glued = isText(before) && /\S$/.test(before.value);
    if ((bracketed || glued) && isText(before) && isText(after)) {
      const stop = /^[.!?]+/.exec(after.value);
      if (stop !== null) {
        before.value = `${before.value.trimEnd()}${stop[0]} `;
        after.value = after.value.slice(stop[0].length);
      }
    }
    const label = textOf(kids[i] as HNode).trim();
    kids.splice(i, end - i + 1, citeElement(keys, label));
  }

  // Pass 2: cites that ended up side by side (their brackets gone) are one run.
  for (let i = 0; i < kids.length; i += 1) {
    const a = kids[i];
    if (a?.type !== 'element' || a.tagName !== CITE_TAG) continue;
    const gap = kids[i + 1];
    const b = isText(gap) && JOINER.test(gap.value) ? kids[i + 2] : gap;
    if (b?.type !== 'element' || b.tagName !== CITE_TAG) continue;
    const keys = `${a.properties?.dataKeys ?? ''} ${b.properties?.dataKeys ?? ''}`
      .trim()
      .split(/\s+/);
    kids.splice(i, b === gap ? 2 : 3, citeElement(keys, String(a.properties?.dataLabel ?? '')));
    i -= 1;
  }

  // A citation that is the whole of its paragraph or list item is a
  // reference-list line, not a claim's chip — say so, the renderer draws it
  // with its words (the model's own label) rather than as a bare site name.
  const meaningful = kids.filter((k) => !(isText(k) && /^[\s.,;:–—-]*$/.test(k.value)));
  const only = meaningful[0];
  if (
    meaningful.length === 1 &&
    only?.type === 'element' &&
    only.tagName === CITE_TAG &&
    (parent.tagName === 'p' || parent.tagName === 'li') &&
    String(only.properties?.dataKeys ?? '').split(' ').length === 1
  ) {
    only.properties = { ...only.properties, dataStandalone: 'true' };
  }

  /*
   * AN ORDINARY LINK GLUED TO A WORD GETS ITS SPACE. A link to a page this turn
   * never read stays a link (above) — and glued to the word before it,
   * "Neuroglancer[Cell](…)" read "NeuroglancerCell" (SEEN on a real 4B research
   * turn). Nobody glues a link into the middle of a word in prose.
   */
  for (let i = 1; i < kids.length; i += 1) {
    const link = kids[i];
    const before = kids[i - 1];
    if (link?.type !== 'element' || link.tagName !== 'a') continue;
    if (isText(before) && /[\p{L}\p{N}]$/u.test(before.value)) before.value = `${before.value} `;
  }

  for (const child of kids) {
    if (child.type === 'element' && child.tagName !== CITE_TAG && child.tagName !== 'code') {
      groupChildren(child, keyOf);
    }
  }
}

/** The rehype plugin: `[[rehypeCitations, { keyOf }]]`. */
export function rehypeCitations(options: RehypeCitationOptions) {
  return (tree: HNode): void => {
    groupChildren(tree, options.keyOf);
  };
}
