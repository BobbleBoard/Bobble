import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { IconCheck, IconCopy, writeClipboardText } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import type { ArtifactContent } from '../model.ts';
import type { SurfaceProps } from '../registry.ts';
import { streamingUpdateSpec } from './code-append.ts';
import { languageExtension } from './languages.ts';

/*
 * SYNTAX COLOURS FOLLOW THE THEME, like everything else here.
 *
 * This surface was token-driven throughout EXCEPT its highlighting, which used
 * CodeMirror's `defaultHighlightStyle` — a palette designed for a LIGHT editor.
 * Rendered on the app's near-black code background, its navy and dark purple
 * became close to invisible. the user: "these text colors on this color scheme is
 * not viable, why all so dark, especially the dark blue, absolutely not."
 *
 * Every colour is a --pd-syntax-* variable now, so light, dark and all three
 * flavors resolve from the same place the rest of the UI does, and no palette
 * can go stale against a background it was never checked on.
 */
const pdHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword],
    color: 'var(--pd-syntax-keyword)',
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--pd-syntax-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--pd-syntax-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--pd-syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: 'var(--pd-syntax-function)',
  },
  { tag: [t.typeName, t.className, t.namespace, t.self], color: 'var(--pd-syntax-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--pd-syntax-property)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--pd-syntax-punctuation)' },
  { tag: [t.definition(t.variableName), t.variableName], color: 'var(--pd-text-primary)' },
  { tag: t.invalid, color: 'var(--pd-syntax-invalid)' },
]);

/** Base viewer theme — styled entirely through --pd-* tokens. */
const codeTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--pd-code-block-bg)',
    color: 'var(--pd-text-primary)',
    fontSize: 'var(--pd-font-size-code)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--pd-font-mono)',
    lineHeight: 'var(--pd-leading-code)',
    overflow: 'auto',
  },
  /*
   * THE GUTTER IS OPAQUE, and it has to be.
   *
   * CodeMirror pins the line-number gutter with `position: sticky; left: 0`, so
   * on a horizontal scroll the code slides UNDER it. Transparent, the two draw
   * on top of each other and the line numbers sit in the middle of the source —
   * the user, looking at a wide file: "the line numbers on the left side seem to
   * have transparent background and overlap with real text if hscroll occurs."
   *
   * The editor's own background is the right fill: it matches at rest, so this
   * is invisible until the moment it is needed.
   */
  '.cm-gutters': {
    /*
     * `--pd-code-block-bg` is a TINT (#ffffff0a here), not a fill, so setting it
     * alone left the gutter 96% see-through — the assertion "not transparent"
     * went green while the screen still showed code through the digits. The
     * layer under it is the canvas panel, `--pd-bg-raised`, which is what the
     * editor root is really sitting on; painting both in that order gives the
     * gutter the editor's own colour AND full opacity.
     */
    background:
      'linear-gradient(var(--pd-code-block-bg), var(--pd-code-block-bg)), var(--pd-bg-raised)',
    color: 'var(--pd-text-ghost)',
    border: 'none',
    /* Room for the rule to sit in, rather than against the code. */
    paddingRight: '12px',
  },
  /*
   * THE RULE BESIDE THE NUMBERS — the visible edge of the gutter, and the thing
   * you actually see when the code slides under it.
   *
   * the user: "for line nums, need a vertical line a little to the right connected
   * from first line to last line not top to bottom of them that acts as the
   * better border when hscrolling."
   *
   * "not top to bottom" is the whole specification. `.cm-gutters` is as tall as
   * the pane, not as tall as the file, so a plain `border-right` on it draws a
   * full-height stripe past the end of an eight-line file — a frame around empty
   * space. The height comes from the document instead (see `gutterRuleHeight`),
   * so the rule ends where the code does.
   *
   * `.cm-gutters` is `position: sticky`, which is a positioned element, so this
   * hangs off it directly and inherits the horizontal pinning for free.
   */
  '.cm-gutters::after': {
    content: '""',
    position: 'absolute',
    top: 'var(--pd-gutter-rule-top, 0px)',
    right: '7px',
    width: '1px',
    height: 'var(--pd-gutter-rule-height, 100%)',
    background: 'var(--pd-canvas-rule, var(--pd-border-default))',
    pointerEvents: 'none',
  },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
});

/**
 * Publish where the document starts and how tall it is, so the gutter rule can
 * span the FILE rather than the pane (see `.cm-gutters::after`).
 *
 * `contentHeight` is the rendered document height including `.cm-content`'s own
 * vertical padding, so the padding is read back off and subtracted — that is the
 * difference between "from the first line to the last" and "from four pixels
 * above the first line to four pixels below the last".
 *
 * Both halves go through `requestMeasure`, which is CodeMirror's own read/write
 * split: measuring inside `update` would read layout in the middle of a DOM
 * write and thrash on every keystroke of a streaming file.
 */
const gutterRuleHeight = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.measure(view);
    }
    update(u: ViewUpdate) {
      if (u.geometryChanged || u.docChanged) this.measure(u.view);
    }
    measure(view: EditorView) {
      view.requestMeasure({
        read: (v) => {
          const pad = Number.parseFloat(getComputedStyle(v.contentDOM).paddingTop);
          const top = Number.isFinite(pad) ? pad : 0;
          return { top, height: Math.max(0, v.contentHeight - top * 2) };
        },
        write: ({ top, height }, v) => {
          v.dom.style.setProperty('--pd-gutter-rule-top', `${Math.round(top)}px`);
          v.dom.style.setProperty('--pd-gutter-rule-height', `${Math.round(height)}px`);
        },
      });
    }
  },
);

/** Editable overlay: restore a visible caret + a subtle active-line tint so the
 * raw source reads like an editor, not a static viewer. Applied AFTER codeTheme
 * (later extensions win) only when `editable`. */
const editableTheme = EditorView.theme({
  '.cm-content': { caretColor: 'var(--pd-text-primary)' },
  '.cm-activeLine': { backgroundColor: 'var(--pd-code-active-line, rgba(127,127,127,0.08))' },
});

/** Structural ref type (version-agnostic across React 18/19 ref typings). */
type EditCallbackRef = { readonly current: ((text: string) => void) | undefined };

/**
 * The editability extensions, held in a Compartment so they can be reconfigured
 * WITHOUT rebuilding the editor. When `editable` is false the buffer is a strict
 * read-only viewer; when true it installs the ⌘/Ctrl-S save keymap and a
 * user-edit `updateListener`. Callbacks come from refs so a reconfigure never
 * captures a stale closure. Kept module-level (stable identity) so the reactive
 * `[editable]` effect can list it without re-running on every render.
 */
function editExtensionsFor(
  editable: boolean,
  onSaveRef: EditCallbackRef,
  onChangeRef: EditCallbackRef,
): Extension {
  if (!editable) return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  return [
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: (view) => {
          onSaveRef.current?.(view.state.doc.toString());
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // Only user edits (typing/paste/delete carry a userEvent); the
      // streaming/reconcile dispatches do not, so they don't echo.
      const userEdit = update.transactions.some(
        (tr) => tr.annotation(Transaction.userEvent) !== undefined,
      );
      if (userEdit) onChangeRef.current?.(update.state.doc.toString());
    }),
    editableTheme,
  ];
}

/** How well-known renderable kinds map to a highlight language when the artifact
 * omits `language` (an html/svg/markdown artifact routed to canvas). */
const RAW_LANGUAGE_BY_KIND: Record<string, string> = {
  html: 'html',
  svg: 'svg',
  markdown: 'markdown',
};

/**
 * Coerce any artifact content into a `code` payload for the RAW source editor,
 * resolving a highlight language from the content language or its kind. Shared by
 * the docked canvas + the standalone `<Canvas>` so both render "raw" identically.
 */
export function rawSourceContent(content: ArtifactContent): ArtifactContent {
  return {
    kind: 'code',
    text: content.text,
    language: content.language ?? RAW_LANGUAGE_BY_KIND[content.kind] ?? content.kind,
  };
}

export interface CodeSurfaceProps extends SurfaceProps {
  /** Allow editing the buffer. Defaults to false → a read-only source viewer. */
  editable?: boolean;
  /** Fired (on user edits only) with the full buffer text; never on streaming
   * appends or programmatic reconciliation. */
  onChange?: (text: string) => void;
  /** Fired on an explicit save (⌘/Ctrl-S) with the full buffer text. */
  onSave?: (text: string) => void;
}

/**
 * Code surface — a CodeMirror 6 viewer with STREAMING APPEND. New text is
 * reconciled as the minimal change over the shared prefix (`streamingUpdateSpec`),
 * so appended deltas never reset scroll or selection. Language comes from
 * `content.language` via the installed `lang-*` packages and is swapped through a
 * Compartment without rebuilding the editor.
 *
 * `editable` promotes it to a live editor: ⌘/Ctrl-S calls `onSave` with the
 * buffer and user edits emit `onChange`. The reconcile effect only fires when the
 * `content.text` PROP changes, so typing never triggers a revert (the prop is
 * unchanged); an external update that equals the buffer is a no-op prefix diff.
 */
export function CodeSurface({
  content,
  onCopy,
  editable = false,
  onChange,
  onSave,
}: CodeSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef<Compartment | null>(null);
  const editRef = useRef<Compartment | null>(null);
  // Latest callbacks read from refs so the mount-once editor never goes stale.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The editor is built once on mount; document/language/editability changes are
  // applied by the dedicated effects below (rebuilding the view per delta would
  // defeat streaming). content.* / editable are read only for the initial state
  // here — the reactive effect below reconfigures the edit Compartment when
  // `editable` flips (e.g. a tab finishing its stream), so no remount is needed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langCompartment = new Compartment();
    langRef.current = langCompartment;
    const editCompartment = new Compartment();
    editRef.current = editCompartment;
    const view = new EditorView({
      state: EditorState.create({
        doc: content.text,
        extensions: [
          lineNumbers(),
          gutterRuleHeight,
          syntaxHighlighting(pdHighlight, { fallback: true }),
          langCompartment.of(languageExtension(content.language)),
          codeTheme,
          editCompartment.of(editExtensionsFor(editable, onSaveRef, onChangeRef)),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Reactively toggle editability. A canvas tab that finishes streaming flips
  // `editable` false→true on the SAME mounted surface; reconfiguring the
  // Compartment makes it editable + ⌘S-saveable at once, WITHOUT a remount, so
  // scroll position and selection are preserved.
  useEffect(() => {
    const view = viewRef.current;
    const compartment = editRef.current;
    if (!view || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure(editExtensionsFor(editable, onSaveRef, onChangeRef)),
    });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const spec = streamingUpdateSpec(view.state, content.text);
    if (spec) view.dispatch(spec);
  }, [content.text]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = langRef.current;
    if (!view || !compartment) return;
    view.dispatch({ effects: compartment.reconfigure(languageExtension(content.language)) });
  }, [content.language]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const handleCopy = (): void => {
    if (onCopy) onCopy(content.text);
    else void writeClipboardText(content.text);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pd-canvas-code">
      <div className="pd-canvas-code-rail">
        <button
          type="button"
          className="pd-btn pd-btn--ghost pd-icon-btn pd-btn--sm"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={handleCopy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      <div ref={hostRef} className="pd-canvas-code-host" />
    </div>
  );
}
