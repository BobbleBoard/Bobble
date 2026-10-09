/**
 * A BLUE PILL IN THE INPUT, instead of raw text.
 *
 * The user: "add blue pills with icons and X buttons for embedded files and such,
 * not just typing them, including for buttons in the + menu no raw text."
 *
 * Everything that used to arrive by TYPING now arrives as an object: a starter
 * chip, a "+" menu action, a mentioned file. The difference is not decoration —
 * typed text is indistinguishable from what you wrote yourself, so it can be
 * half-deleted into nonsense by one backspace, and there is nothing to click to
 * take it back. A pill is one thing: it removes in one keystroke or one click,
 * and it cannot be left in a broken state.
 *
 * WHAT THE MODEL SEES IS UNCHANGED. `getTextContent()` returns the payload, and
 * the composer reads the message with `$getRoot().getTextContent()` — so a pill
 * is exactly the words it stands for by the time anything leaves this window.
 * That is the property that makes this safe to put in front of every insertion
 * path at once.
 */
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical';
import type { ReactNode } from 'react';

/** Which glyph the pill wears. Kept as a NAME rather than a component so the
 * node stays serializable and the icon set is resolved at render. */
export type PillIcon =
  | 'file'
  | 'image'
  | 'video'
  | 'motion'
  | 'search'
  | 'write'
  | 'sparkle'
  | 'connector';

export interface PillData {
  /** What the pill says. Short — it is a token, not a sentence. */
  readonly label: string;
  /** What the MODEL receives in its place. */
  readonly payload: string;
  readonly icon: PillIcon;
  /**
   * A real brand mark, for the things that HAVE one — a connector picked from
   * `/`. The user: "the / should be able to show installed connectors … and show
   * REAL ICONS to their left."
   *
   * Inline SVG rather than a URL because the app is offline and under a CSP that
   * blocks remote images; the markup comes from the in-repo connector catalog,
   * never from the network or from anything a user typed. When absent the
   * {@link PillIcon} name is used, which is every other pill.
   */
  readonly iconSvg?: string;
}

export type SerializedPillNode = SerializedLexicalNode & PillData;

/**
 * Render hook, set once by the composer so the node can draw React without
 * importing the icon set (which would drag the whole ui barrel into the node).
 *
 * It receives the node KEY rather than a remove callback: removing a node is
 * only legal inside `editor.update()`, and the only thing that can open one is a
 * component inside the Lexical context — which the renderer is and the node is
 * not. The first cut closed over a plain `remove()` and the X silently did
 * nothing, which is exactly the failure mode a decorator invites.
 */
let renderPill: ((data: PillData, nodeKey: NodeKey) => ReactNode) | null = null;

export function setPillRenderer(fn: (data: PillData, nodeKey: NodeKey) => ReactNode): void {
  renderPill = fn;
}

export class PillNode extends DecoratorNode<ReactNode> {
  __data: PillData;

  static override getType(): string {
    return 'pd-pill';
  }

  static override clone(node: PillNode): PillNode {
    return new PillNode(node.__data, node.__key);
  }

  constructor(data: PillData, key?: NodeKey) {
    super(key);
    this.__data = data;
  }

  /*
   * THE WHOLE SAFETY OF THIS FEATURE IS THIS METHOD. The composer builds the
   * outgoing message from `$getRoot().getTextContent()`, so a pill is its
   * payload everywhere it matters — the prompt, the prefill signature, the
   * attachment folding — without any of those learning what a pill is.
   */
  override getTextContent(): string {
    return this.__data.payload;
  }

  override createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'pd-pill-host';
    return span;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  /** Backspace beside it removes the WHOLE pill — it is one thing. */
  override isKeyboardSelectable(): boolean {
    return true;
  }

  override exportJSON(): SerializedPillNode {
    return { ...super.exportJSON(), ...this.__data, type: 'pd-pill', version: 1 };
  }

  static override importJSON(json: SerializedLexicalNode & Record<string, unknown>): PillNode {
    // Defensive: a serialized pill from an older shape must not throw on read.
    return new PillNode({
      label: typeof json.label === 'string' ? json.label : '',
      payload: typeof json.payload === 'string' ? json.payload : '',
      icon: (typeof json.icon === 'string' ? json.icon : 'file') as PillIcon,
      ...(typeof json.iconSvg === 'string' ? { iconSvg: json.iconSvg } : {}),
    });
  }

  override decorate(): ReactNode {
    return renderPill?.(this.__data, this.__key) ?? null;
  }
}

export function $createPillNode(data: PillData): PillNode {
  return new PillNode(data);
}

export function $isPillNode(node: LexicalNode | null | undefined): node is PillNode {
  return node instanceof PillNode;
}
