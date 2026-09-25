/**
 * The Lexical plain-text editor that lives inside the composer shell. Owns
 * text/selection sync (for autocomplete token detection), Enter-to-submit with
 * Shift+Enter newline, autocomplete keyboard nav, and an imperative API
 * (insert token / clear / focus) exposed to the parent through a ref.
 */
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { registerPillRenderer } from './PillRenderer';
import { pastedFiles } from './paste-files';
import { deleteAdjacentPill } from './pill-delete';
import { $createPillNode, $isPillNode, type PillData, PillNode } from './pill-node';
import { type AcToken, detectToken, EMPTY_TOKEN } from './tokens';

export interface ComposerEditorApi {
  /** Replace the active trigger token (offset within the current text node). */
  insertToken: (tokenStart: number, value: string) => void;
  /** Replace the whole editor content (suggestion chips, templates). */
  setText: (value: string) => void;
  /**
   * Drop a PILL at the caret — the shape everything inserted rather than typed
   * now takes. the user: "add blue pills with icons and X buttons for embedded files
   * and such, not just typing them … no raw text."
   */
  insertPill: (data: PillData) => void;
  /** Replace the active `@`/`/` token with a pill — the mention path. */
  replaceTokenWithPill: (tokenStart: number, data: PillData) => void;
  clear: () => void;
  focus: () => void;
}

export interface ComposerKeymap {
  isAcOpen: () => boolean;
  moveSelection: (delta: number) => void;
  /** Accept the highlighted autocomplete item; returns true if one was accepted. */
  acceptAc: () => boolean;
  /** Move the active suggestion (autocomplete closed); returns true if consumed. */
  moveSuggestion: (delta: number) => boolean;
  /** Tab with no autocomplete open: accept the ACTIVE suggestion if any. */
  acceptSuggestion: () => boolean;
  /** Esc with no autocomplete open: dismiss the suggestion overlay if shown. */
  dismissSuggestions: () => boolean;
  /**
   * Esc with nothing left to dismiss. The one key every terminal agent binds to
   * "stop", and here it did nothing at all — the only way to halt a reply was to
   * find and click the Stop button. Owned by the composer because the policy
   * (stop a running turn; a second press within a beat clears the draft) needs
   * state the editor does not have. Returns true when it consumed the key.
   */
  escape: () => boolean;
  close: () => void;
}

interface ComposerEditorProps {
  placeholder: string;
  disabled?: boolean;
  onTextChange: (text: string) => void;
  onTokenChange: (token: AcToken) => void;
  onSubmit: () => void;
  keymap: ComposerKeymap;
  apiRef: MutableRefObject<ComposerEditorApi | null>;
  /**
   * Offered a plain-text clipboard paste BEFORE it lands in the editor. Return
   * true to CONSUME it (the parent turned it into a "pasted content" attachment
   * so a large block doesn't flood the input); return false to let it paste
   * normally. Only fires when the paste's TEXT is its content (see onPasteFiles).
   */
  onLargePaste?: (text: string) => boolean;
  /**
   * Offered the FILES of a paste — a picture copied from a card, a screenshot,
   * files copied in Finder — when they are the content (paste-files.ts decides).
   * The plain-text editor below would read `text/plain` and drop them, which is
   * exactly how a copied picture used to vanish on ⌘V. Return true to consume.
   */
  onPasteFiles?: (files: File[]) => boolean;
}

/**
 * Where the caret is, horizontally, inside the composer — published as
 * `--pd-ac-x` so the `@` / `/` panel can open under it.
 *
 * the user: "@ and / menus should show right above where the user is typing, not
 * later." A panel pinned to the left edge of the box is a panel you have to look
 * away to read, and the further right you have typed the further away it is.
 */
function publishCaretX(): void {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return;
  const root = document.querySelector('.pd-composer-root');
  if (!(root instanceof HTMLElement)) return;
  const rects = sel.getRangeAt(0).getClientRects();
  const rect = rects.length > 0 ? rects[rects.length - 1] : undefined;
  // A collapsed caret at the start of an empty line has no rect; leave the last
  // known position rather than snapping the panel to 0.
  if (rect === undefined || (rect.width === 0 && rect.height === 0)) return;
  root.style.setProperty(
    '--pd-ac-x',
    `${Math.round(rect.left - root.getBoundingClientRect().left)}px`,
  );
}

function readSync(
  editorState: EditorState,
  onTextChange: (text: string) => void,
  onTokenChange: (token: AcToken) => void,
): void {
  editorState.read(() => {
    onTextChange($getRoot().getTextContent());
    publishCaretX();
    const selection = $getSelection();
    if ($isRangeSelection(selection) && selection.isCollapsed()) {
      const node = selection.anchor.getNode();
      const upTo = $isTextNode(node) ? node.getTextContent().slice(0, selection.anchor.offset) : '';
      onTokenChange(detectToken(upTo));
    } else {
      onTokenChange(EMPTY_TOKEN);
    }
  });
}

/** Wires the imperative API + command handlers to the live editor. */
function EditorBridge(props: Omit<ComposerEditorProps, 'placeholder' | 'disabled'>): null {
  const [editor] = useLexicalComposerContext();
  const cb = useRef(props);
  cb.current = props;

  // Imperative API for the parent (token insertion, clear, focus).
  useEffect(() => {
    props.apiRef.current = {
      insertToken: (tokenStart, value) => {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          if (!$isTextNode(node)) return;
          node.spliceText(tokenStart, selection.anchor.offset - tokenStart, `${value} `, true);
        });
      },
      setText: (value) => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          if (value.length > 0) paragraph.append($createTextNode(value));
          root.append(paragraph);
          paragraph.selectEnd();
        });
      },
      replaceTokenWithPill: (tokenStart, data) => {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          if (!$isTextNode(node)) return;
          // Cut the typed `@partial` out, then drop the pill where it was.
          const text = node.getTextContent();
          const before = text.slice(0, tokenStart);
          const after = text.slice(selection.anchor.offset);
          node.setTextContent(before);
          const pill = $createPillNode(data);
          node.insertAfter(pill);
          const tail = $createTextNode(after.length > 0 ? after : ' ');
          pill.insertAfter(tail);
          tail.select(0, 0);
        });
        editor.focus();
      },
      insertPill: (data) => {
        editor.update(() => {
          const selection = $getSelection();
          const pill = $createPillNode(data);
          if ($isRangeSelection(selection)) {
            selection.insertNodes([pill]);
          } else {
            // No caret yet (the chip was clicked before the box was touched) —
            // append rather than dropping the insertion on the floor.
            const root = $getRoot();
            const last = root.getLastChild();
            if (last === null) {
              const p = $createParagraphNode();
              p.append(pill);
              root.append(p);
            } else if ($isElementNode(last)) {
              last.append(pill);
            }
          }
          // A trailing space so the next thing typed is a word, not glued to it.
          pill.insertAfter($createTextNode(' '));
          pill.selectNext();
        });
        editor.focus();
      },
      clear: () => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      },
      focus: () => editor.focus(),
    };
    return () => {
      props.apiRef.current = null;
    };
  }, [editor, props.apiRef]);

  // Keyboard: submit / newline / autocomplete nav. Registered once; reads the
  // latest callbacks through the ref so it never re-subscribes.
  useEffect(() => {
    const unregister = [
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          const { keymap, onSubmit } = cb.current;
          if (keymap.isAcOpen() && keymap.acceptAc()) {
            event?.preventDefault();
            return true;
          }
          if (event?.shiftKey === true) {
            editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
            event.preventDefault();
            return true;
          }
          event?.preventDefault();
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          if (keymap.isAcOpen()) {
            keymap.moveSelection(1);
            event.preventDefault();
            return true;
          }
          // Suggestions open (autocomplete closed): navigate the overlay.
          if (keymap.moveSuggestion(1)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          if (keymap.isAcOpen()) {
            keymap.moveSelection(-1);
            event.preventDefault();
            return true;
          }
          if (keymap.moveSuggestion(-1)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event: KeyboardEvent) => {
          const { keymap } = cb.current;
          const handled = keymap.isAcOpen() ? keymap.acceptAc() : keymap.acceptSuggestion();
          if (handled) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          const { keymap } = cb.current;
          // Most-local first: an open autocomplete, then the suggestion overlay,
          // and only with nothing left to dismiss does Esc reach the turn.
          if (keymap.isAcOpen()) {
            keymap.close();
            return true;
          }
          if (keymap.dismissSuggestions()) return true;
          return keymap.escape();
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // A paste is offered to the parent BEFORE it enters the editor, in two
      // shapes. FILES (a copied picture, a screenshot, Finder files) become
      // attachments — the PlainTextPlugin that handles the paste otherwise reads
      // `text/plain` alone, so a picture used to land as nothing at all. A LARGE
      // plain-text block becomes a "pasted content" attachment so it never
      // floods the input. Anything else falls through to the normal paste.
      editor.registerCommand(
        PASTE_COMMAND,
        (event: ClipboardEvent | InputEvent | KeyboardEvent) => {
          const { onLargePaste, onPasteFiles } = cb.current;
          if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false;
          const data = event.clipboardData;
          // Read now: a DataTransfer is only readable while its event dispatches.
          const files = pastedFiles(
            Array.from(data.files),
            data.getData('text/plain'),
            data.getData('text/html'),
          );
          if (files.length > 0 && onPasteFiles !== undefined && onPasteFiles([...files])) {
            event.preventDefault();
            return true;
          }
          if (onLargePaste === undefined) return false;
          // The files lost to their text (paste-files.ts) — the text is the
          // paste now, and a big one is still better as an attachment.
          const pasted = data.getData('text/plain');
          if (pasted.length === 0) return false;
          if (onLargePaste(pasted)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      /*
       * A PILL DELETES LIKE A CHARACTER (see pill-delete.ts for why).
       *
       * The three shapes a caret can have beside a decorator are all here
       * because Lexical genuinely produces all three: inside a text node at its
       * edge, directly between two block children, or with the decorator itself
       * selected. Reading the neighbourhood here and deciding in a pure function
       * keeps this registration about the editor and the rule about the rule.
       */
      ...(['backward', 'forward'] as const).map((direction) =>
        editor.registerCommand(
          direction === 'backward' ? KEY_BACKSPACE_COMMAND : KEY_DELETE_COMMAND,
          () => {
            let handled = false;
            editor.update(() => {
              const selection = $getSelection();
              if ($isNodeSelection(selection)) {
                const node = selection.getNodes()[0];
                handled = deleteAdjacentPill(
                  { selected: $isPillNode(node) ? node : null },
                  direction,
                );
                return;
              }
              if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
              const { anchor } = selection;
              const node = anchor.getNode();
              let before: unknown = null;
              let after: unknown = null;
              if ($isTextNode(node)) {
                if (anchor.offset === 0) before = node.getPreviousSibling();
                if (anchor.offset === node.getTextContentSize()) after = node.getNextSibling();
              } else if ($isElementNode(node)) {
                before = node.getChildAtIndex(anchor.offset - 1);
                after = node.getChildAtIndex(anchor.offset);
              }
              handled = deleteAdjacentPill(
                {
                  before: $isPillNode(before as never) ? (before as PillNode) : null,
                  after: $isPillNode(after as never) ? (after as PillNode) : null,
                },
                direction,
              );
            });
            return handled;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
      // OnChangePlugin ignores selection-only updates; re-detect on caret move.
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          readSync(editor.getEditorState(), cb.current.onTextChange, cb.current.onTokenChange);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    ];
    return () => {
      for (const u of unregister) u();
    };
  }, [editor]);

  return null;
}

// Once, at module load: the node draws through this and cannot be created before
// the composer module has been imported.
registerPillRenderer();

export function ComposerEditor(props: ComposerEditorProps) {
  const { placeholder, disabled, onTextChange, onTokenChange } = props;
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'pi-composer',
        editable: disabled !== true,
        /* Everything inserted rather than typed is a PillNode — see pill-node. */
        nodes: [PillNode],
        onError: (error) => {
          console.error('[composer] lexical error', error);
        },
        theme: {},
      }}
    >
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className="pd-composer-input outline-none"
            aria-label="Message input"
            data-testid="composer-input"
          />
        }
        placeholder={
          <div className="pd-composer-placeholder pointer-events-none absolute text-text-muted">
            {placeholder}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin
        onChange={(editorState) => readSync(editorState, onTextChange, onTokenChange)}
      />
      <EditorBridge {...props} />
    </LexicalComposer>
  );
}
