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
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { registerPillRenderer } from './PillRenderer';
import { $createPillNode, type PillData, PillNode } from './pill-node';
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
   * normally. Only fires for plain-text pastes with no clipboard files.
   */
  onLargePaste?: (text: string) => boolean;
}

function readSync(
  editorState: EditorState,
  onTextChange: (text: string) => void,
  onTokenChange: (token: AcToken) => void,
): void {
  editorState.read(() => {
    onTextChange($getRoot().getTextContent());
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
      // Large plain-text paste → offer it to the parent BEFORE it enters the
      // editor. If the parent consumes it (turns it into a "pasted content"
      // attachment), swallow the paste so a huge block never floods the input;
      // otherwise fall through to the normal plain-text paste. File/image pastes
      // and non-clipboard paste events are left untouched.
      editor.registerCommand(
        PASTE_COMMAND,
        (event: ClipboardEvent | InputEvent | KeyboardEvent) => {
          const { onLargePaste } = cb.current;
          if (onLargePaste === undefined) return false;
          if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false;
          if (event.clipboardData.files.length > 0) return false;
          const pasted = event.clipboardData.getData('text/plain');
          if (pasted.length === 0) return false;
          if (onLargePaste(pasted)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
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
