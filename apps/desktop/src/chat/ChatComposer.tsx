/**
 * The real chat composer: a Lexical editor inside the design-system composer
 * shell, wired to pi. Enter submits (Shift+Enter newline), `@` fuzzy-file
 * mentions (fs:list-files), `/` slash commands (pi get_commands), `!` bash mode
 * (PiBridge.bash), image drop/paste attachments (with thumbnail previews), and
 * the model/TPS/context footer. Honors the claude flavor rule (hide send while
 * empty, no top tray).
 *
 * Round-3: the rule-based suggestion overlay was removed (#A7 — the user disliked
 * it); the `@`/`/` autocomplete stays. Drag-drop attach is handled by the
 * window-level fullscreen overlay (#A8) which feeds files through `useDropStore`.
 */
import type { Model } from '@pi-desktop/engine';
import { CAPABILITIES } from '@pi-desktop/harness/presets/capabilities';
import {
  ComposerAddMenu,
  type GenActionKey,
  IconArrowUp,
  IconButton,
  IconClose,
  Spinner,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExpandedScrim } from '../media/ExpandedScrim';
import { IconMic, IconPause, IconPlay, IconStop } from '../settings/icons';
import { useConnectorsStore } from '../state/connectors-store';
import { abortCorpTask } from '../state/corp-connect';
import { useCorpStore } from '../state/corp-store';
import { useImagesUnsupported } from '../state/local-model';
import {
  abortPi,
  compactSession,
  getCommands,
  newSession,
  pausePi,
  resumePausedChat,
  runBash,
  sendPrompt,
} from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { assessCurrentSend, useQueueExplainer } from '../state/running-chats';
import { corpForceEnabled, productionHarnessEnabled, useWorkMode } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { AttachedFileCard } from './AttachedFileCard';
import { ComposerBar } from './ComposerBar';
import { ComposerFooter } from './ComposerFooter';
import { ComposerPill } from './ComposerPill';
import { type AcItem, Autocomplete } from './composer/Autocomplete';
import { type ActivatableConnector, buildAgentMessage } from './composer/agent-message';
import { PREFILL_MIN_CHARS, useAttachmentPrefill } from './composer/attachment-prefill';
import {
  attachmentMeta,
  EMPTY_SELECTION,
  pruneSelection,
  type SelectionState,
  selectClick,
} from './composer/attachment-view';
import {
  ComposerEditor,
  type ComposerEditorApi,
  type ComposerKeymap,
} from './composer/ComposerEditor';
import { useDropStore } from './composer/drop-store';
import type { PillData } from './composer/pill-node';
import { type AcToken, EMPTY_TOKEN } from './composer/tokens';
import { GEN_ACTION_PLANS } from './composer-gen-actions';
import { DictationBar } from './DictationBar';
import { IconWarning } from './icons-pill';
import { StarterChips } from './StarterChips';
import { HELP_TEXT, parseSlashCommand } from './slash-commands';
import { usePrefillPill } from './use-prefill-pill';
import { useDictation } from './useDictation';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * How long the first Escape stays armed before a second one clears the draft.
 *
 * Long enough to be a deliberate double-press, short enough that an Escape now
 * and another a minute later cannot combine to delete a paragraph someone was
 * still writing.
 */
const DOUBLE_ESCAPE_MS = 1000;

/**
 * How long `@` typing settles before the file walk runs.
 *
 * The walk is synchronous on the main process, so a request per keystroke is a
 * stall per keystroke — and it grows with the size of the tree.
 */
const MENTION_DEBOUNCE_MS = 90;

interface SlashCommand {
  name: string;
  description?: string;
}

interface Attachment {
  id: string;
  name: string;
  /** Original file size in bytes — shown on the chip's hover detail. Absent for
   * a pasted block, which never was a file. */
  bytes?: number;
  /** Image attachments carry a data URI (sent to pi as ImageContent); text
   * attachments carry their decoded contents (folded into the prompt text). */
  kind: 'image' | 'text';
  dataUri?: string;
  text?: string;
  /** True for a large paste captured as an attachment — rendered as a text
   * preview card with a "PASTED" badge rather than a filename chip. */
  pasted?: boolean;
  /**
   * The `@`-mention token this attachment came from, when it came from one.
   *
   * A mentioned file is ALREADY on screen — it is the pill sitting in the
   * sentence you are writing. the user: "at mentions should appear just the inline,
   * no attachment shown above." So these carry the file's text into the message
   * exactly like a dropped file, and draw nothing.
   *
   * Storing the token rather than a boolean is what keeps that honest: the pill
   * is the only visible trace, so when the pill goes, the file has to go with
   * it, and the token is how the reconcile below recognises its own pill.
   */
  mention?: string;
}

/** Text files we accept + read into the prompt (by MIME or extension). */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'rst',
  'json',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'log',
  'gitignore',
  'dockerfile',
  'makefile',
  'gradle',
  'properties',
]);
/** Cap the per-file size we inline into a prompt (256 KB). */
const TEXT_MAX_BYTES = 256 * 1024;
/**
 * A pasted plain-text block at/above this many characters becomes a "pasted
 * content" attachment instead of flooding the editor (the user) — and, being an
 * attachment, it feeds attachment prefill. Below it, paste behaves normally so a
 * sentence or short snippet still lands inline where you'd expect.
 */
const PASTE_AS_FILE_MIN_CHARS = 1000;

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : file.name.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** Built-in commands shown unconditionally — so `/` always offers something,
 * even before pi's session RPC is live enough to answer `get_commands`. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'What you can do here' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'compact', description: 'Summarise the history to free up context' },
];

async function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** `foo.tar.gz` → `GZ`; `README` → `FILE`. */
function extLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext || 'file').toUpperCase().slice(0, 4);
}

/**
 * An attachment chip: a BOX, which opens to the right when you point at it.
 *
 * the user's brief, verbatim: "no name shown, just a box … a bit bigger, and then
 * slide to the right open when it's hovered over (the individual file/image)
 * this should be less colored in and have a more visible border … show name a
 * bit smaller and higher, truncate name if too long, show centered dot, file
 * extension, then below it, size eg. 10.1 MB <centered dot> N tokens replace n
 * with a loading spinner if prefilling still while hovered."
 *
 * The collapsed state carries no words at all, which is the point: three
 * attachments used to be three filename chips wide enough to push the composer
 * around. Three boxes are three boxes, and the one you are pointing at tells you
 * everything about itself.
 */
function AttachmentPreview({
  name,
  dataUri,
  bytes,
  text,
  kind,
  onRemove,
  blind = false,
  selected = false,
  prefilling = false,
  onSelect,
}: {
  name: string;
  dataUri?: string;
  bytes?: number;
  text?: string;
  kind: 'image' | 'text';
  onRemove: () => void;
  /** The selected model cannot read images — badge this one. */
  blind?: boolean;
  /** Clicked: blue fill, blue border, and part of a copy/cut selection. */
  selected?: boolean;
  /** Its contents are still being primed into the model — the token count is
   * a spinner until they are. */
  prefilling?: boolean;
  onSelect?: (mods: { shift?: boolean; meta?: boolean }) => void;
}) {
  const isImage = (dataUri ?? '').startsWith('data:image/');
  const [open, setOpen] = useState(false);
  const meta = attachmentMeta({
    name,
    kind,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(text !== undefined ? { text } : {}),
  });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the chip's own buttons are focusable; this is a mouse affordance over them
    // biome-ignore lint/a11y/noStaticElementInteractions: same — selecting a chip by clicking its body, with every action inside it a real button
    <div
      className="pd-attach"
      data-selected={selected || undefined}
      data-testid="attach-chip"
      onClick={(e) => {
        // A click on the remove button or the thumbnail is that control's, not
        // the chip's — selection is the click on everything else.
        if ((e.target as HTMLElement).closest('button') !== null) return;
        onSelect?.({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      }}
    >
      {isImage ? (
        // Clickable, like every other piece of media in the app (the user asked for
        // the expanded view on input media too) — a 20px chip is not a preview.
        <span className="pd-blind-host">
          {/*
            SINGLE CLICK SELECTS, DOUBLE CLICK OPENS.
            The thumbnail used to be a button whose click opened the expanded
            view, which made it the one part of the chip you could not select by
            clicking — and it is the biggest part. The file-list idiom is the
            right one here: click picks, double-click opens.
          */}
          {/* biome-ignore lint/a11y/useAltText: the chip's label describes it */}
          <img
            className="pd-attach-thumb"
            src={dataUri}
            title={`${name} — double-click to open`}
            onDoubleClick={() => setOpen(true)}
          />
          {/* The fact travels WITH the picture, so it is still there when the
              pill has gone. the user: "a yellow circle + ! on images both in chat
              input and when sent". */}
          {blind ? (
            <span
              className="pd-blind-badge"
              data-testid="attach-blind-badge"
              title="The selected model cannot read images"
            >
              <IconWarning size={14} />
            </span>
          ) : null}
        </span>
      ) : (
        <span className="pd-attach-ext">{extLabel(name)}</span>
      )}
      {open && dataUri !== undefined ? (
        <ExpandedScrim label={name} testid="attachment-expanded" onClose={() => setOpen(false)}>
          {/* biome-ignore lint/a11y/useAltText: the dialog carries the label */}
          <img src={dataUri} className="pd-media-image" />
        </ExpandedScrim>
      ) : null}
      {/* THE SLIDE-OUT. Zero width until hovered (CSS grid 0fr → 1fr), so the
          row of boxes is the resting state and the detail is on demand. */}
      <div className="pd-attach-detail" aria-hidden={!open ? undefined : undefined}>
        <div className="pd-attach-detail-inner">
          <div className="pd-attach-name" title={name}>
            {/* The NAME truncates; the dot and the extension never do. They were
                in the same clipping box at first, so a long filename pushed the
                extension off the end — which is the one part of that row that is
                the same width every time and therefore always has room. */}
            <span className="pd-attach-name-text">{name}</span>
            <span className="pd-attach-dot">·</span>
            <span className="pd-attach-ext-label">{meta.ext}</span>
          </div>
          <div className="pd-attach-meta">
            {meta.size !== '' ? <span>{meta.size}</span> : null}
            {meta.size !== '' && (meta.tokens !== null || prefilling) ? (
              <span className="pd-attach-dot">·</span>
            ) : null}
            {prefilling ? (
              <span className="pd-attach-tokens" data-testid="attach-prefilling">
                <Spinner size={10} />
              </span>
            ) : meta.tokens !== null ? (
              <span className="pd-attach-tokens">{meta.tokens}</span>
            ) : null}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="pd-attach-remove pd-focusable"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

export function ChatComposer({
  piModels,
  onOpenModels,
  onCorpSubmit,
  onCorpFollowUp,
}: {
  piModels: Model[];
  onOpenModels?: () => void;
  /** EXPERIMENTAL: when the production-harness flag is on, a submitted prompt is
   * routed here (the CorpEngine + situation room) instead of the normal pi turn.
   * Absent / flag off ⇒ the composer behaves exactly as it does today. */
  onCorpSubmit?: (echo: string, imageUris: string[]) => void;
  /** A1/A4 — route a follow-up (a corp task already exists) to the CEO for an answer
   * instead of starting a fresh production. */
  onCorpFollowUp?: (question: string) => void;
}) {
  // Which half of the app is on screen — the ledge below the card follows it.
  const workMode = useWorkMode();
  /*
   * CAN THE SELECTED MODEL READ A PICTURE? Asked here so the answer arrives
   * before the mistake rather than after it — the send path asks the same
   * question (ensureVisionReady) and could only ever answer once it was too
   * late to matter.
   */
  const blindToImages = useImagesUnsupported();
  /*
   * SELECTION, UNDO AND THE CLIPBOARD for attachments — the user: "cmd/ctrl Z needs
   * to be able to undo accidental file removals, clicking a file needs to
   * highlight it blue and blue border and then allow for user to press ctrl
   * c/x/v or shift click other files to do so."
   *
   * The rules themselves are pure (composer/attachment-view.ts); this holds the
   * state and binds the keys.
   */
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  /** Removed attachments, newest last — the undo stack. Each entry remembers
   * WHERE it was, so undo puts it back in its place rather than at the end. */
  const removedRef = useRef<{ at: number; items: Attachment[] }[]>([]);
  const clipboardRef = useRef<Attachment[]>([]);
  const flavor = useThemeStore((s) => s.flavor);
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  // A corp/hierarchy run is live from start to its terminal `done` — its Stop
  // halts every subagent (cooperative abort), distinct from a plain chat Stop.
  const corpRunning = useCorpStore((s) => s.corpRunning);
  const corpTaskId = useCorpStore((s) => s.taskId);
  const cwd = usePiStore((s) => s.session?.cwd ?? '');
  // The pre-first-token dispatch window: true from send until the turn produces
  // its first token. Part of "the backend is busy" for the button, so the send↔stop
  // flip doesn't blink back to Send during the dispatch gap.
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  // A DIFFERENT chat is streaming in the background. While it runs, `isStreaming`
  // is true but it isn't THIS view's turn — so the composer shows Send (not Stop),
  // and a send here queues (pi is busy) rather than dispatching into that chat.
  const bgStreaming = usePiStore((s) => s.bgRun?.streaming === true);
  // A token-exact resume is streaming a paused reply's continuation. It isn't a pi
  // turn (agent.isStreaming stays false), so it drives the composer's busy state
  // (Pause/Stop) on its own — Pause/Stop route to the resume abort.
  const resuming = usePiStore((s) => s.resuming);
  // Whether this chat has any message waiting to send — drives the "Queued · Why
  // isn't my message sending?" hint below the input.
  const hasQueued = usePiStore((s) => s.queuedSends.length > 0);
  const openQueueExplainer = useQueueExplainer((s) => s.setOpen);

  const apiRef = useRef<ComposerEditorApi | null>(null);
  const [text, setText] = useState('');
  // Dictation APPENDS rather than replaces: a user who typed half a sentence
  // and then reached for the mic means "and also this", not "throw that away".
  // The composer's text lives in `text` state, but this callback is created
  // once and would close over the value at mount. A ref keeps it current
  // without re-creating the recorder every keystroke.
  const textRef = useRef('');
  textRef.current = text;
  // What was already typed when the mic opened. Live partials are written into
  // the editor as they arrive, so `text` itself is no longer a stable base to
  // append to — it already contains the last partial.
  const dictationBaseRef = useRef('');
  const applyDictated = (base: string, spoken: string): void => {
    const joined = base.trim() === '' ? spoken : `${base.replace(/\s+$/, '')} ${spoken}`;
    apiRef.current?.setText(joined);
    setText(joined);
  };
  const dictation = useDictation((spoken) => {
    // Dictation APPENDS rather than replaces: a user who typed half a sentence
    // and then reached for the mic means "and also this", not "throw that away".
    applyDictated(dictationBaseRef.current, spoken);
  });
  const dictating = dictation.phase !== 'idle' && dictation.phase !== 'error';
  // Words appear in the composer WHILE you speak. They are provisional — the
  // final full-context transcript replaces them wholesale when you confirm.
  //
  // An effect, not a render-phase write: this touches the Lexical editor, and
  // React may render a component twice before committing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: writes the editor on new partials only
  useEffect(() => {
    if (dictation.phase !== 'recording' || dictation.partial === '') return;
    applyDictated(dictationBaseRef.current, dictation.partial);
  }, [dictation.partial, dictation.phase]);
  const startDictation = (): void => {
    dictationBaseRef.current = textRef.current;
    dictation.start();
  };
  const cancelDictation = (): void => {
    // Cancel puts the composer back exactly as it was, partials and all.
    applyDictated(dictationBaseRef.current, '');
    dictation.cancel();
  };
  const [token, setToken] = useState<AcToken>(EMPTY_TOKEN);
  const [items, setItems] = useState<AcItem[]>([]);
  /*
   * INSTALLED CONNECTORS, AS `/` COMMANDS. the user: "slash commands should just be
   * able to reference any connector installed, eg. /gmail if a gmail connector
   * is installed should just change to the blue thing with the icon."
   *
   * Only what is actually installed — the catalog supplies the name and the real
   * brand mark for each one, the registry supplies which of them exist on this
   * Mac. Loaded lazily, the first time a `/` is typed, so opening a chat does not
   * pay for a screen the user may never visit.
   */
  const registryServers = useConnectorsStore((s) => s.registry.servers);
  const connectorCatalog = useConnectorsStore((s) => s.catalog);
  const connectorsLoaded = useConnectorsStore((s) => s.loaded);
  const installedConnectors = useMemo(() => {
    const byId = new Map(connectorCatalog.map((c) => [c.id, c]));
    return registryServers.map((srv) => {
      const known = byId.get(srv.id);
      return {
        slug: srv.id,
        name: known?.name ?? srv.id,
        ...(known?.iconSvg !== undefined ? { iconSvg: known.iconSvg } : {}),
        description: known?.description ?? 'Installed connector',
        enabled: srv.enabled !== false,
      };
    });
  }, [registryServers, connectorCatalog]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  /*
   * NO WEB-SEARCH TOGGLE, until it does something.
   *
   * It was a checkbox the user could tick, held in state here, and read by
   * nothing — `submit()` never looked at it, so turning it on changed no
   * request and no tool set. A control that reports a preference the system
   * does not act on is worse than no control: it makes the user believe they
   * asked for something.
   *
   * Bringing it back means deciding what it MEANS — pin `web_search` into the
   * turn's advertised tools, or bias the model toward it — and plumbing that to
   * the harness per message. The menu renders the row again the moment an
   * `onWebSearchChange` handler is passed.
   */
  // #19: whether the (empty-state) placeholder overflows the visible editor and
  // must fade at the bottom rather than hard-clip. Measured below.
  const [phClipped, setPhClipped] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Composer overflow (round-5 #3/#8): the editor never shows a hard scrollbar
  // (hidden in CSS). When typed content overflows the max height and the caret
  // scrolls it, mark the scroll container so a top gradient MASK fades the text
  // sliding under the top edge instead of a harsh cut. At rest (scrollTop 0) the
  // mask is off, so the placeholder and first line never fade.
  const onEditorScroll = () => {
    const el = editorScrollRef.current;
    if (el !== null) el.dataset.scrolled = el.scrollTop > 1 ? 'true' : 'false';
  };

  // Apply composer text pushed from elsewhere: a message's Edit action and pi's
  // extension `setComposerText` both land in the store; drain it into the editor.
  const composerText = usePiStore((s) => s.composerText);
  useEffect(() => {
    if (composerText.length === 0) return;
    apiRef.current?.setText(composerText);
    apiRef.current?.focus();
    usePiStore.setState({ composerText: '' });
  }, [composerText]);

  // The same drain, for a PILL pushed from outside (a starter chip).
  const composerPill = usePiStore((s) => s.composerPill);
  useEffect(() => {
    if (composerPill === null) return;
    apiRef.current?.insertPill({
      label: composerPill.label,
      payload: composerPill.payload,
      icon: composerPill.icon as PillData['icon'],
    });
    usePiStore.setState({ composerPill: null });
  }, [composerPill]);

  /**
   * Remove attachments and REMEMBER where they were.
   *
   * the user: "cmd/ctrl Z needs to be able to undo accidental file removals." An
   * attachment is often a thing you dragged in from somewhere you have since
   * closed, so losing one to a mis-click can cost more than the message.
   */
  const removeAttachments = (ids: readonly string[]): void => {
    if (ids.length === 0) return;
    /*
     * THE UNDO ENTRY IS RECORDED HERE, NOT INSIDE THE UPDATER.
     *
     * the user: "cmd z seems to have at some point added a duplicate file when I
     * removed it initially to test, I don't really know what happened there."
     * This is what happened: React may invoke a state updater more than once for
     * the same update — it is required to be pure — so pushing onto the undo
     * stack from inside one recorded the same removal twice, and a single cmd-z
     * put the file back twice.
     *
     * Reading `attachments` from the closure is right here: this only runs from
     * a click or a keystroke, both of which render first.
     */
    const removed = attachments.map((a, i) => ({ a, i })).filter(({ a }) => ids.includes(a.id));
    if (removed.length === 0) return;
    // The index of the FIRST removed one, so undo restores the group where it
    // was rather than appending it to the end.
    removedRef.current = [
      ...removedRef.current.slice(-9),
      { at: removed[0]?.i ?? attachments.length, items: removed.map(({ a }) => a) },
    ];
    setAttachments((prev) => prev.filter((a) => !ids.includes(a.id)));
    setSelection(EMPTY_SELECTION);
  };

  const undoRemoval = (): boolean => {
    const last = removedRef.current.pop();
    if (last === undefined) return false;
    setAttachments((prev) => {
      const next = prev.slice();
      next.splice(Math.min(last.at, next.length), 0, ...last.items);
      return next;
    });
    return true;
  };

  /*
   * THE ATTACHMENT KEYBOARD — undo, copy, cut, paste.
   *
   * the user: "cmd/ctrl Z needs to be able to undo accidental file removals,
   * clicking a file needs to highlight it blue and blue border and then allow
   * for user to press ctrl c/x/v."
   *
   * WHY IT IS ON THE WINDOW AND NOT THE CHIPS. A chip is not focused when you
   * click it — the editor keeps the caret, which is what you want, because the
   * next thing you do is almost always keep typing. So the shortcut has to be
   * heard at the window and then decide whether it is FOR the attachments: it is
   * only when something is selected (copy/cut) or when there is a removal to
   * undo AND the editor has no edit of its own to undo, which is why the undo
   * arm checks the draft is untouched before claiming the key.
   */
  const draftEmptyRef = useRef(true);
  draftEmptyRef.current = text.length === 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === 'z' && !e.shiftKey) {
        // Never steal undo from a draft the user is editing — theirs first.
        if (!draftEmptyRef.current) return;
        if (undoRemoval()) e.preventDefault();
        return;
      }
      /*
       * PASTE IS NOT A SELECTION ACTION. It was behind the same guard as copy
       * and cut, which made cut-then-paste impossible: cutting clears the
       * selection, so by the time you press V there is nothing selected and the
       * handler had already returned.
       */
      if (key === 'v' && clipboardRef.current.length > 0) {
        // New ids: pasting is a COPY, so the original stays where it is and the
        // two can be removed independently.
        setAttachments((prev) => [
          ...prev,
          ...clipboardRef.current.map((a) => ({ ...a, id: crypto.randomUUID() })),
        ]);
        e.preventDefault();
        return;
      }
      if (selection.ids.length === 0) return;
      if (key === 'c' || key === 'x') {
        clipboardRef.current = attachments.filter((a) => selection.ids.includes(a.id));
        if (key === 'x') removeAttachments(selection.ids);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A file removed while selected must not stay "selected" in a ghostly way.
  useEffect(() => {
    setSelection((prev) =>
      pruneSelection(
        prev,
        attachments.map((a) => a.id),
      ),
    );
  }, [attachments]);

  const hasImageAttached = attachments.some((a) => (a.dataUri ?? '').startsWith('data:image/'));
  const canSend = text.trim().length > 0 || attachments.length > 0;
  const bashMode = text.trim().startsWith('!');

  // ATTACHMENT PREFILL: the fixed START of the next message is its text
  // attachments (folded exactly as submit() will fold them — no typed text). Prime
  // that as soon as it's attached so the real turn reuses it and only prefills the
  // short typed tail. `abortPrefill` is called in submit() so the dispatched turn
  // never queues behind an in-flight prefill on the single slot.
  const attachmentPrefix = buildAgentMessage(
    '',
    attachments.filter((a) => a.kind === 'text'),
  );
  /** The shape `buildAgentMessage` needs — slug + name, nothing about the UI. */
  const activatable: ActivatableConnector[] = useMemo(
    () => installedConnectors.map((c) => ({ slug: c.slug, name: c.name })),
    [installedConnectors],
  );
  const {
    abortPrefill,
    inFlight: prefillInFlight,
    estimatedMs: prefillEstimateMs,
  } = useAttachmentPrefill(attachmentPrefix);
  /*
   * ...and SAY SO when it takes long enough to matter. the user's rule for all of
   * this is "when I don't see anything I get an instant response", which only
   * holds if every window where a send would not be instant says something.
   */
  usePrefillPill(prefillInFlight, prefillEstimateMs);
  /*
   * WHICH CHIPS SHOW A SPINNER INSTEAD OF A TOKEN COUNT. Only a text attachment
   * gets primed, and only one over the threshold — the same rule the prefill
   * hook applies, read from the one place that owns it so the two cannot say
   * different things about the same file.
   */
  const prefillingIds = prefillInFlight
    ? attachments
        .filter((a) => a.kind === 'text' && (a.text ?? '').length >= PREFILL_MIN_CHARS)
        .map((a) => a.id)
    : [];

  // Accept images (sent to pi as ImageContent) AND text files (read + folded
  // into the prompt text on send). Anything else — binary the prompt can't carry
  // (pdf, zip, …) — is NOT silently dropped: its name shows in an inline note.
  const addFiles = async (files: File[]) => {
    const added: Attachment[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        added.push({
          bytes: f.size,
          id: crypto.randomUUID(),
          name: f.name,
          kind: 'image',
          dataUri: await fileToDataUri(f),
        });
      } else if (isTextFile(f) && f.size <= TEXT_MAX_BYTES) {
        added.push({
          bytes: f.size,
          id: crypto.randomUUID(),
          name: f.name,
          kind: 'text',
          text: await f.text(),
        });
      } else {
        rejected.push(f.name);
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (rejected.length > 0) {
      setSkipped(rejected);
      if (skipTimer.current !== null) clearTimeout(skipTimer.current);
      skipTimer.current = setTimeout(() => setSkipped([]), 6000);
    }
  };

  /**
   * Resolve an `@`-mentioned path into a text attachment.
   *
   * Silent on every failure — a binary, a file too large, an unreadable path.
   * The mention already put the path in the message, so the model can still
   * read it itself; turning a picker click into an error toast would be worse
   * than the turn it saves.
   */
  const attachMentionedFile = async (absPath: string, token: string): Promise<void> => {
    const name = absPath.split('/').pop() ?? absPath;
    if (attachments.some((a) => a.name === name && a.kind === 'text')) return;
    const res = await window.piDesktop
      .invoke('fs:read-file', { path: absPath, maxBytes: TEXT_MAX_BYTES })
      .catch(() => null);
    if (res === null || res.binary || res.tooLarge || typeof res.text !== 'string') return;
    setAttachments((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name, kind: 'text', text: res.text as string, mention: token },
    ]);
  };

  /*
   * A MENTION'S FILE LIVES AND DIES WITH ITS PILL.
   *
   * The chip above the box used to be the visible trace of a mentioned file, and
   * removing it removed the file. Now the pill is that trace — so if the pill is
   * deleted and nothing notices, the file is still riding along inside the next
   * message, invisibly, and the user has no way to find out. That is a worse bug
   * than the duplication the user asked me to remove.
   *
   * Reconciling against the editor's own text covers every way a pill can leave:
   * backspace, select-all, undo, a cleared composer. It runs on text change,
   * which is exactly when the answer can have changed.
   */
  useEffect(() => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.mention === undefined || text.includes(a.mention));
      return next.length === prev.length ? prev : next;
    });
  }, [text]);

  /** What the chip row draws: everything except the mentions, which are pills. */
  const visibleAttachments = attachments.filter((a) => a.mention === undefined);

  // A large plain-text paste (the user): rather than dumping a wall of text into the
  // editor, capture it as a "pasted content" text attachment — same model as a
  // dropped .txt, so it echoes as a tidy chip AND feeds predictive prefill. Returns
  // true when consumed so ComposerEditor swallows the paste; false lets it paste
  // inline (short snippets stay where you'd expect them).
  const handleLargePaste = (pasted: string): boolean => {
    if (pasted.length < PASTE_AS_FILE_MIN_CHARS) return false;
    setAttachments((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: 'pasted content', kind: 'text', text: pasted, pasted: true },
    ]);
    return true;
  };

  // Drain files dropped on the window-level fullscreen overlay (#A8b) into our
  // attachment list, then clear the hand-off store.
  const droppedFiles = useDropStore((s) => s.files);
  // biome-ignore lint/correctness/useExhaustiveDependencies: droppedFiles is the trigger; addFiles reads only setState
  useEffect(() => {
    if (droppedFiles.length === 0) return;
    void addFiles(droppedFiles);
    useDropStore.getState().clear();
  }, [droppedFiles]);

  // Fetch slash commands whenever the session becomes ready. get_commands
  // resolves `{success:false}` until pi's RPC is live, so the original
  // mount-only fetch silently lost the race and `/` showed nothing. Re-fetch on
  // model readiness, retry on failure, and always keep the built-ins so `/`
  // works from the first keystroke.
  const modelReady = usePiStore((s) => s.agent.model !== null || s.session !== null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelReady is a re-fetch trigger, not read in the effect
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const merge = (fetched: SlashCommand[]): void => {
      const seen = new Set(BUILTIN_COMMANDS.map((b) => b.name));
      setCommands([...BUILTIN_COMMANDS, ...fetched.filter((c) => !seen.has(c.name))]);
    };
    const scheduleRetry = (): void => {
      if (cancelled || attempts >= 6) return;
      attempts += 1;
      setTimeout(load, 400 * attempts);
    };
    const load = (): void => {
      getCommands()
        .then((res) => {
          if (cancelled) return;
          if (res.success) merge(res.commands);
          else scheduleRetry();
        })
        .catch(() => {
          if (!cancelled) scheduleRetry();
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [modelReady]);

  /*
   * Resolve autocomplete suggestions for the active token.
   *
   * DEBOUNCED for `@`: the file walk is synchronous on the main process, so a
   * request per keystroke is a stall per keystroke. Slash commands are answered
   * from memory and stay instant.
   */
  useEffect(() => {
    if ((token.mode === 'slash' || token.mode === 'connector') && !connectorsLoaded) {
      void useConnectorsStore.getState().load();
    }
  }, [token.mode, connectorsLoaded]);

  useEffect(() => {
    let cancelled = false;
    setSelectedIndex(0);
    if (token.mode === null) {
      setItems([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (token.mode === 'mention') {
        const files = await window.piDesktop
          .invoke('fs:list-files', { cwd, query: token.query, limit: 12 })
          .catch(() => []);
        if (cancelled) return;
        setItems(
          files.map(
            (f): AcItem => ({
              id: `@${f.rel}`,
              label: f.rel.split('/').pop() ?? f.rel,
              subtitle: f.rel,
              section: 'Files',
              kind: 'file',
              path: f.path,
            }),
          ),
        );
      } else {
        const q = token.query.toLowerCase();
        /*
         * A `/` MID-SENTENCE CAN ONLY MEAN A CONNECTOR. A command owns the whole
         * message (pi's rule), so offering the command list from inside a
         * sentence would be a menu of things that cannot run from there.
         */
        const commandItems =
          token.mode === 'connector'
            ? []
            : commands
                .filter(
                  (c) =>
                    c.name.toLowerCase().includes(q) ||
                    (c.description ?? '').toLowerCase().includes(q),
                )
                .slice(0, 12)
                .map(
                  (c): AcItem => ({
                    id: `/${c.name} `,
                    label: `/${c.name}`,
                    subtitle: c.description,
                    section: 'Commands',
                    kind: 'command',
                  }),
                );
        /*
         * ...AND THE CAPABILITIES. the user: "the / should be able to show installed
         * connectors or reference specific capabilities."
         *
         * A capability is the app's own bundling of tools the way a person asks
         * for them ("personal" is calendar + mail + reminders + contacts +
         * messages), so `/personal` is a reference in the same sense `/gmail`
         * is. The list is the harness's own — imported from the module that
         * defines it rather than restated here, so it cannot drift.
         */
        const capabilityItems = CAPABILITIES.filter(
          (c) => c.name.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q),
        )
          .slice(0, 6)
          .map(
            (c): AcItem => ({
              id: `/${c.name} `,
              label: `/${c.name}`,
              subtitle: c.summary,
              section: 'Capabilities',
              kind: 'connector',
            }),
          );
        // Connectors come FIRST: they are the answer to "what can this thing
        // reach", which is what a `/` is usually being pressed to find out.
        const connectorItems = installedConnectors
          .filter((c) => c.slug.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
          .slice(0, 8)
          .map(
            (c): AcItem => ({
              id: `/${c.slug} `,
              label: `/${c.slug}`,
              subtitle: c.enabled ? c.description : `${c.description} · off — picking turns it on`,
              section: 'Connectors',
              kind: 'connector',
              ...(c.iconSvg !== undefined ? { iconSvg: c.iconSvg } : {}),
            }),
          );
        setItems([...connectorItems, ...capabilityItems, ...commandItems]);
      }
    };
    // A file walk waits for typing to settle; commands come from memory.
    if (token.mode === 'mention') timer = setTimeout(() => void run(), MENTION_DEBOUNCE_MS);
    else void run();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [token.mode, token.query, cwd, commands, installedConnectors]);

  /*
   * What Escape needs, through refs, because the keymap object is stable and
   * `isBusy` / `stopBusy` are derived further down the component.
   */
  /**
   * ACCEPTING A SUGGESTION — one implementation, whichever way you accept it.
   *
   * Reads the live token through `tokenRef` rather than the render's `token` so
   * the keyboard path (which runs from a stable keymap object) and the mouse
   * path see the same one. `tokenRef` is declared further down; that is fine
   * because nothing here runs during render — only on an actual pick.
   */
  const pickItem = (item: AcItem): void => {
    const picked = tokenRef.current.mode;
    const tokenStart = tokenRef.current.tokenStart;
    /*
     * A MENTIONED FILE ARRIVES AS A PILL, not as a typed path. the user: "add blue
     * pills with icons … not just typing them."
     *
     * The payload is the same path the model always received, but a path typed
     * into the box can be half-deleted into one that does not exist.
     */
    if (picked === 'mention' && item.path !== undefined) {
      apiRef.current?.replaceTokenWithPill(tokenStart, {
        label: item.label ?? item.id,
        payload: item.id,
        icon: 'file',
      });
    } else if (item.kind === 'connector') {
      /*
       * A CONNECTOR IS A PILL WITH ITS OWN FACE. The payload is the literal
       * `/gmail` the user meant to type — so it still reads as a sentence to the
       * model, and `activatedConnectors` can find it again to append the one
       * activation line (agent-message.ts).
       */
      apiRef.current?.replaceTokenWithPill(tokenStart, {
        label: item.label,
        payload: `${item.id.trim()} `,
        icon: 'connector',
        ...(item.iconSvg !== undefined ? { iconSvg: item.iconSvg } : {}),
      });
      /*
       * ...AND IT IS ON. the user asked the pick to "add this cli tool to the set if
       * not already there": naming a connector you have installed but switched
       * off should turn it on, not fail silently when the model reaches for it.
       */
      const slug = item.id.trim().replace(/^\//, '');
      if (installedConnectors.some((c) => c.slug === slug && !c.enabled)) {
        void useConnectorsStore.getState().setEnabled(slug, true);
      }
    } else {
      apiRef.current?.insertToken(tokenStart, item.id);
    }
    setToken(EMPTY_TOKEN);
    apiRef.current?.focus();
    /*
     * AN `@` MENTION BRINGS THE FILE WITH IT — folded into pi's copy of the
     * message and primed by the predictive prefill while the rest is still being
     * typed, so by the time it is sent the file is already resident. It draws no
     * chip: the pill in the sentence IS the file (see Attachment.mention).
     */
    if (picked === 'mention' && item.path !== undefined) {
      void attachMentionedFile(item.path, item.id);
    }
  };

  const busyRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const hasDraftRef = useRef(false);
  const lastEscapeRef = useRef(0);
  hasDraftRef.current = text.trim().length > 0;

  // Stable keymap object: methods read the latest state through refs so the
  // editor never has to re-register its commands.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selRef = useRef(selectedIndex);
  selRef.current = selectedIndex;

  const keymap = useRef<ComposerKeymap>({
    isAcOpen: () => tokenRef.current.mode !== null && itemsRef.current.length > 0,
    moveSelection: (delta) =>
      setSelectedIndex((i) => clamp(i + delta, 0, Math.max(0, itemsRef.current.length - 1))),
    acceptAc: () => {
      const item = itemsRef.current[selRef.current];
      if (item === undefined) return false;
      /*
       * THE SAME PICK THE MOUSE MAKES.
       *
       * This used to call `insertToken` on its own, so accepting a suggestion
       * with Enter or Tab typed the raw text while clicking the row inserted a
       * pill — and, for an `@` mention, only the click attached the file. Two
       * ways to accept one suggestion, doing two different things, with the
       * keyboard (the way anyone actually uses an autocomplete) getting the
       * worse one. Found by driving Enter in a probe after the mouse path had
       * been passing for a week.
       */
      pickItem(item);
      return true;
    },
    // Suggestion overlay removed (#A7): these keymap hooks are inert no-ops so
    // arrow/Tab/Esc fall through to the editor's native behavior.
    moveSuggestion: () => false,
    acceptSuggestion: () => false,
    dismissSuggestions: () => false,
    /*
     * ESC STOPS THE TURN; ESC ESC CLEARS THE DRAFT.
     *
     * The key every terminal agent binds to "stop" did nothing here — halting a
     * reply meant finding and clicking the Stop button, which is a long way to
     * reach for the most reflexive gesture there is.
     *
     * Stop takes precedence when something is running, because that is the
     * urgent case and a draft is not going anywhere. When nothing is running,
     * one press arms and a second within the window clears — a single stray Esc
     * must never silently delete a paragraph someone was writing.
     */
    escape: () => {
      if (busyRef.current) {
        stopRef.current();
        lastEscapeRef.current = 0;
        return true;
      }
      const now = Date.now();
      if (now - lastEscapeRef.current <= DOUBLE_ESCAPE_MS) {
        lastEscapeRef.current = 0;
        if (!hasDraftRef.current) return false;
        apiRef.current?.clear();
        return true;
      }
      lastEscapeRef.current = now;
      return hasDraftRef.current;
    },
    close: () => setToken(EMPTY_TOKEN),
  }).current;

  // A composer "+" modality force-action: (a) prefill the tiny prompt scaffold
  // and focus, and (b) pin the harness class for the next send — eagerly over the
  // `/harness preset` seam (so the toolset preset loads and the active-class UI
  // reflects it now) AND by stashing the class for submit() to feed the Auto-route
  // classify. Deterministic: "+ → Generate video" ⇒ advanced-video regardless of
  // what the user then types.
  const onGenAction = (key: GenActionKey) => {
    const plan = GEN_ACTION_PLANS[key];
    /*
     * A PILL, NOT A TYPED SCAFFOLD. the user: "including for buttons in the + menu
     * no raw text." The words the model receives are the same — the pill's
     * payload IS the scaffold — but in the box it is one object: it removes with
     * one click or one backspace, and a stray keystroke cannot leave "Generate
     * an imag" behind.
     */
    apiRef.current?.insertPill({ label: plan.pill, payload: plan.scaffold, icon: plan.icon });
  };

  const submit = async () => {
    const raw = text.trim();
    if (raw === '' && attachments.length === 0) return;
    const imageUris = attachments
      .filter((a) => a.kind === 'image')
      .map((a) => a.dataUri)
      .filter((uri): uri is string => uri !== undefined);
    const textFiles = attachments.filter((a) => a.kind === 'text');
    /*
     * Hand the prefill the body we are about to send. A prime this turn BEGINS
     * WITH is left running — the tokens it is reading are the turn's own — and
     * only a prime for something else (a removed attachment, another chat) is
     * cancelled so it stops competing for the single slot. See abortPrefill.
     */
    abortPrefill({ body: buildAgentMessage(raw, textFiles, activatable) });
    apiRef.current?.clear();
    setAttachments([]);
    setToken(EMPTY_TOKEN);
    // Keep focus in the editor after a send (adversarial finding): with the
    // composer now mounted across the empty→thread transition, this refocus makes
    // the caret sticky even if the browser blurred on submit.
    apiRef.current?.focus();
    if (raw.startsWith('!')) {
      await runBash(raw.slice(1).trim());
      return;
    }
    /*
     * THE THREE SLASH COMMANDS THE MENU HAS ALWAYS OFFERED.
     *
     * `/help`, `/new` and `/compact` were listed unconditionally so that `/`
     * always had something to show, and picking one sent the literal text
     * "/compact" to the model — which answered as if asked about compaction.
     * `/compact` in particular is the one that matters on a 32k window.
     *
     * Handled here rather than passed to pi: pi's own slash handling would
     * bypass the app's session bookkeeping (the sidebar, the per-chat
     * snapshots), and `newSession()` already owns the streaming-safe path.
     */
    const slash = parseSlashCommand(raw);
    if (slash !== null) {
      if (slash.name === 'help') {
        usePiStore.getState().appendAssistantText(HELP_TEXT);
        return;
      }
      if (slash.name === 'new') {
        await newSession();
        return;
      }
      // `/compact` — refused while a reply is streaming (pi aborts first), and
      // its outcome is SAID, because a silent no-op on a 30–120 s operation is
      // indistinguishable from a broken command.
      const res = await compactSession();
      usePiStore
        .getState()
        .appendAssistantText(
          res.ok
            ? 'Compacted. The history so far is a summary.'
            : `Not compacted: ${res.error ?? 'unknown reason'}.`,
        );
      return;
    }
    // INSTANT stop button (the user #11): flip to Stop NOW, before the async
    // dispatch makes promptInFlight/streaming true. The reconcile effect drops it
    // the instant the real turn goes live; the timeout is a safety net so a send
    // that somehow never starts a turn can't strand the button on Stop.
    setPendingStop(false);
    setPendingStart(true);
    window.setTimeout(() => setPendingStart(false), 5000);
    // Fold attached text-file contents into pi's copy of the message (the send
    // path is otherwise images-only); the visible bubble echoes only the typed
    // text (or the filenames when nothing was typed). Shared with predictive
    // prefill so the prefilled draft byte-matches this exact body.
    const agentMessage = buildAgentMessage(raw, textFiles, activatable);
    const echo =
      raw.length > 0 ? raw : textFiles.length > 0 ? textFiles.map((a) => a.name).join(', ') : raw;

    /*
     * THE CORP IS SOMETHING THE MODEL ASKS FOR — NOT WHERE EVERY MESSAGE GOES.
     *
     * This used to route EVERY submit into the corporation whenever the harness
     * flag was on, so "create a file called notes.txt with three lines in it"
     * stood up a manager, four engineers and eight specialists, and took two and
     * a half minutes to write three lines. the user, watching it: "shouldn't be
     * always doing this whole mesh system."
     *
     * The design already says so, in promote-tool.ts: the corp is "an OPTION the
     * model opts into at high/max effort — still just a tool — not a mode that
     * hijacks every prompt". `create_production_hierarchy` is in the normal chat
     * toolset at those levels; when the model decides a job needs a team it calls
     * it, and ChatApp's promote listener launches the run. A small ask just gets
     * answered.
     *
     * What remains here is the FOLLOW-UP case: once a production exists in this
     * chat, the next message is answered by the CEO from its retained context
     * rather than starting a fresh vision ceremony.
     */
    if (
      onCorpFollowUp !== undefined &&
      productionHarnessEnabled() &&
      useCorpStore.getState().taskId !== null
    ) {
      onCorpFollowUp(echo);
      return;
    }
    // Testing only: force a corporation for the very first message, so a run can
    // be driven deterministically without relying on the model choosing to
    // promote. Never set in a normal launch.
    if (onCorpSubmit !== undefined && productionHarnessEnabled() && corpForceEnabled()) {
      onCorpSubmit(echo, imageUris);
      return;
    }

    // While a turn is in-flight (streaming OR still in the dispatch→agent_start
    // gap), QUEUE this message rather than inject it into the running turn.
    // Appending a 2nd user echo mid-turn — as a steer OR a fresh send — lands it
    // ahead of the first turn's reply (the assistant row is created only at
    // turn_start and streams in at the end), which is the "response pushed below
    // my new message" reorder. Queued messages drain as their own sequential
    // turns once the current one ends → [msg1, reply1, msg2, reply2].
    const piState = usePiStore.getState();
    // Queue ONLY during the pre-first-token window — the dispatch→agent_start gap
    // (promptInFlight) or the current turn's assistant existing but still EMPTY.
    // That's the only place a 2nd send reorders ahead of the reply. Once the turn
    // has produced content (or paused on a question), the send goes THROUGH — so it
    // can never get stuck behind a turn that never goes idle (ask_user pause / a
    // long multi-step turn where isStreaming stays true).
    const streamingAssistant = piState.messages.find(
      (m) => m.kind === 'assistant' && m.isStreaming === true,
    );
    const streamEmpty =
      streamingAssistant !== undefined &&
      streamingAssistant.kind === 'assistant' &&
      !streamingAssistant.blocks.some((b) =>
        b.type === 'text'
          ? b.text.length > 0
          : b.type === 'thinking'
            ? b.thinking.length > 0
            : true,
      );
    // A DIFFERENT chat streaming in the background also means pi is busy — this send
    // must queue (and drain once that chat finishes + pi switches here), never
    // dispatch into the background session.
    const bgBusy = piState.bgRun?.streaming === true;
    if (piState.promptInFlight || streamEmpty || bgBusy) {
      // Snapshot WHY it's waiting (same-model wait vs a model swap vs a model that
      // won't fit) so the faded queued line + the "Why isn't my message sending?"
      // modal can explain it instead of leaving a non-technical user on a silent
      // cooldown. A turn is in flight here, so turnInFlight = true.
      const { reason } = assessCurrentSend(true);
      piState.enqueueSend({
        text: echo,
        images: imageUris,
        agentMessage,
        reason,
      });
      return;
    }
    await sendPrompt(echo, imageUris, agentMessage);
  };

  // THEME 4 click-target fix: clicking any blank area of the composer focuses
  // the editor. Skip when the press lands on an interactive control (the send
  // button, add-menu, model picker) or on the editor itself (let Lexical place
  // the caret). preventDefault keeps focus from bouncing off the blank target.
  const focusEditorFromBlank = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]',
      ) !== null
    ) {
      return;
    }
    e.preventDefault();
    apiRef.current?.focus();
  };

  // INSTANT send↔stop (the user #11): the button must snap the MOMENT the user acts,
  // never wait on the backend. Two optimistic overrides bracket the real busy
  // signals: `pendingStart` shows Stop the instant Enter is pressed (before
  // promptInFlight/streaming even flips), and `pendingStop` shows Send the instant
  // Stop is pressed (even while the backend is still tearing the turn down). Each
  // clears itself the moment the REAL state catches up, so they only ever cover
  // the perceptible gap — the button can never get stuck in the optimistic state.
  // `isStreaming` counts only when it's THIS view's turn — a background chat's turn
  // (bgStreaming) must not make the viewed chat's composer show Stop.
  const realBusy = (isStreaming && !bgStreaming) || corpRunning || promptInFlight || resuming;
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingStop, setPendingStop] = useState(false);
  useEffect(() => {
    if (realBusy) {
      setPendingStart(false); // the real turn is live now — hand off to it
    } else {
      // Settled idle: drop both optimistic overrides so the button is Send.
      setPendingStart(false);
      setPendingStop(false);
    }
  }, [realBusy]);
  const isBusy = (realBusy || pendingStart) && !pendingStop;
  const showSend = flavor === 'codex' || canSend || isBusy;
  // Stop routes to the right abort: a corp run cooperatively halts its subagents;
  // a plain chat aborts the pi turn. Flip the button to Send INSTANTLY (pendingStop)
  // before the async abort has propagated.
  const stopBusy = (): void => {
    setPendingStop(true);
    setPendingStart(false);
    if (corpRunning && corpTaskId !== null) void abortCorpTask(corpTaskId);
    else void abortPi();
  };
  // Escape reads these (see the keymap's `escape`), and they are only known here.
  busyRef.current = isBusy;
  stopRef.current = stopBusy;

  /*
   * ⌘U, which the + menu has been printing all along.
   *
   * "Add files or photos ⌘U" was a hint for a binding that did not exist. Opens
   * the same hidden file input the menu row clicks, so there is one path.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'u' && e.key !== 'U') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      fileInputRef.current?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Pause (plain chat only; left of Stop): halt the reply to free the model but
  // keep it resumable + let any queued message through. Flip the button back to
  // Send instantly — the turn is ending.
  const pauseBusy = (): void => {
    setPendingStop(true);
    setPendingStart(false);
    void pausePi();
  };
  // A chat whose turn the user paused — drives the paused control cluster (the
  // Pause button becomes a Resume ▶, an X stays to discard) shown once the chat
  // has settled idle (nothing is streaming to interrupt).
  const pausedChat = usePiStore((s) => s.pausedChat);
  // Discard a paused turn: drop the resume affordance (the turn is already
  // halted; the frozen partial reply stays in the thread as-is).
  const discardPaused = (): void => {
    usePiStore.setState({ pausedChat: null });
  };
  // the user #12: the primary placeholder is friendly for a first-timer — the
  // developer-jargon @ / ! hints were demoted to the subtle helper line below
  // (home only), not baked into the placeholder. A single short line also stops
  // the empty composer from looking oversized (the old 3-line jargon overflowed
  // and faded, inflating the card).
  const placeholder =
    isStreaming && !bgStreaming
      ? 'Send after this reply…'
      : bashMode
        ? 'Run a shell command…'
        : 'Ask anything…';
  // Only the empty home screen (no messages yet) shows the shortcut helper line.
  const isHome = usePiStore((s) => s.messages.length === 0);

  // #19: fade the placeholder's bottom rather than slicing it. We flip the fade
  // ON only when the empty-state placeholder actually overflows the visible
  // editor box — a single-line placeholder stays crisp. Re-measured on composer
  // resize (window / canvas) and whenever the placeholder text changes, so the
  // now-1.18x-scaled text that wraps at narrow widths melts out cleanly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placeholder is a re-measure trigger (its text drives wrap height), not read in the effect
  useEffect(() => {
    const container = editorScrollRef.current;
    if (container === null) return;
    // Only the empty composer shows the placeholder; typed content hides it (and
    // owns the scrolled top-mask instead), so never fade once the user types.
    if (text.trim().length > 0) {
      setPhClipped(false);
      return;
    }
    const measure = () => {
      const ph = container.querySelector<HTMLElement>('.pd-composer-placeholder');
      if (ph === null) {
        setPhClipped(false);
        return;
      }
      // Natural placeholder height vs the room below its top offset.
      const visible = container.clientHeight - ph.offsetTop;
      setPhClipped(ph.scrollHeight > visible + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, placeholder]);

  return (
    // Round-12 W2: the input group reserves a little room at the bottom so the
    // sticking-out ComposerBar (mounted below the input card) protrudes cleanly
    // — the whole input bar reads as nudged up to make room for the thin ledge.
    <div className="mx-auto w-full max-w-[700px] pb-1.5">
      <div className="pd-composer-root relative">
        {/*
          THE PILL FLOATS ABOVE THE INPUT BAR — see ComposerPill. Inside the
          relative root so it anchors to the card, and absolutely positioned so
          appearing never moves the card.
        */}
        <ComposerPill imageOnBlindModel={blindToImages && hasImageAttached} />
        <Autocomplete
          items={token.mode !== null ? items : []}
          selectedIndex={selectedIndex}
          onPick={pickItem}
          onHover={setSelectedIndex}
        />

        {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus target; the editor owns keyboard entry */}
        <div
          className="pd-composer"
          data-bash={bashMode ? '' : undefined}
          onMouseDown={focusEditorFromBlank}
        >
          {visibleAttachments.length > 0 ? (
            <div className="pd-composer-attachments" data-testid="composer-attachments">
              {visibleAttachments.map((a) =>
                a.pasted === true ? (
                  <AttachedFileCard
                    key={a.id}
                    name={a.name}
                    text={a.text ?? ''}
                    /* A large paste is the case that takes SECONDS to prime, and
                       it was the one chip with nowhere to say so — pasted
                       content renders as this card, which had no prefill state
                       at all while the boxes beside it did. */
                    prefilling={prefillingIds.includes(a.id)}
                    onRemove={() => removeAttachments([a.id])}
                  />
                ) : (
                  <AttachmentPreview
                    key={a.id}
                    name={a.name}
                    dataUri={a.dataUri}
                    kind={a.kind}
                    {...(a.bytes !== undefined ? { bytes: a.bytes } : {})}
                    {...(a.text !== undefined ? { text: a.text } : {})}
                    blind={blindToImages && (a.dataUri ?? '').startsWith('data:image/')}
                    selected={selection.ids.includes(a.id)}
                    prefilling={prefillingIds.includes(a.id)}
                    onSelect={(mods) =>
                      setSelection((prev) =>
                        selectClick(
                          prev,
                          attachments.map((x) => x.id),
                          a.id,
                          mods,
                        ),
                      )
                    }
                    onRemove={() => removeAttachments([a.id])}
                  />
                ),
              )}
            </div>
          ) : null}

          {skipped.length > 0 ? (
            <div
              className="px-3 pt-2 text-footnote text-text-muted"
              data-testid="composer-skipped-note"
            >
              Images and text files only. Skipped {skipped.join(', ')}.
            </div>
          ) : null}

          {/* A refusal has to be VISIBLE. useDictation can fail before any
              recording exists — a denied microphone, no device, a transcription
              that came back empty — and with only the waveform rendered those
              all looked like a button that does nothing. */}
          {dictation.phase === 'error' && dictation.error !== null ? (
            <div className="pd-dictation-error" role="alert" data-testid="dictation-error">
              {dictation.error}
            </div>
          ) : null}
          {/* The editor STAYS VISIBLE while dictating — it is where the words
              land, and hiding it would hide the whole point. */}
          <div
            ref={editorScrollRef}
            className="pd-composer-editor pd-scroll"
            data-ph-clip={phClipped ? 'true' : undefined}
            onScroll={onEditorScroll}
          >
            <ComposerEditor
              placeholder={placeholder}
              onTextChange={setText}
              onTokenChange={setToken}
              onSubmit={() => void submit()}
              onLargePaste={handleLargePaste}
              keymap={keymap}
              apiRef={apiRef}
            />
          </div>

          {/* While the mic is open this row IS the dictation row: X, waveform,
              confirm, standing exactly where +/mic/model/send normally are
              (the user). One row, one purpose at a time. */}
          {dictating ? (
            <div className="pd-composer-footer">
              <DictationBar
                phase={dictation.phase}
                levels={dictation.levels}
                onStop={dictation.stop}
                onCancel={cancelDictation}
              />
            </div>
          ) : null}
          <div className="pd-composer-footer" hidden={dictating}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*"
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <ComposerAddMenu
              variant="full"
              side="top"
              align="start"
              onAddFiles={() => fileInputRef.current?.click()}
              onGenerateImage={() => onGenAction('image')}
              onGenerateVideo={() => onGenAction('video')}
              onGenerateMotion={() => onGenAction('motion')}
              onPerception={() => onGenAction('perception')}
            />
            <IconButton
              aria-label="Dictate a message"
              variant="secondary"
              circle
              data-testid="composer-mic"
              onClick={startDictation}
            >
              <IconMic size={14} />
            </IconButton>
            <div className="pd-composer-footer-spacer" />
            <ComposerFooter piModels={piModels} onOpenModels={onOpenModels} />
            {isBusy ? (
              // Streaming: Pause (left) + a SQUARE Stop (right). The Stop's
              // per-flavor look (bobble = blue button, white square) comes from
              // the primary variant + .pd-stop-btn.
              <div className="flex items-center gap-1.5">
                {!corpRunning ? (
                  <IconButton
                    aria-label="Pause — keep this reply to resume later"
                    variant="secondary"
                    circle
                    onClick={() => pauseBusy()}
                    data-testid="composer-pause"
                  >
                    <IconPause size={16} />
                  </IconButton>
                ) : null}
                <IconButton
                  aria-label={corpRunning ? 'Stop — halt all agents' : 'Stop'}
                  variant="accent"
                  circle
                  onClick={() => stopBusy()}
                  data-testid="composer-stop"
                >
                  <IconStop size={16} />
                </IconButton>
              </div>
            ) : pausedChat !== null ? (
              // Paused: the Pause button became a Resume ▶ IN PLACE, with text
              // asking to resume; the X stays to discard (the user).
              <div className="flex items-center gap-1.5" data-testid="composer-paused">
                <span className="mr-0.5 text-caption text-text-muted">Paused</span>
                <IconButton
                  aria-label="Resume this reply"
                  variant="accent"
                  circle
                  onClick={() => void resumePausedChat()}
                  data-testid="composer-resume"
                >
                  <IconPlay size={16} />
                </IconButton>
                <IconButton
                  aria-label="Discard — don't resume this reply"
                  variant="secondary"
                  circle
                  onClick={() => discardPaused()}
                  data-testid="composer-discard"
                >
                  <IconClose size={14} />
                </IconButton>
              </div>
            ) : showSend ? (
              <IconButton
                aria-label="Send message"
                variant="primary"
                circle
                disabled={!canSend}
                onClick={() => void submit()}
                data-testid="composer-send"
              >
                <IconArrowUp size={17} />
              </IconButton>
            ) : null}
          </div>
        </div>

        {/* Round-12 W2: the sticking-out bar — fused to the input card's bottom
            edge (the card, z-index 1, overlaps its tucked top) and protruding
            below it: project chip · active tier · effort slider. */}
        {/*
          THE WORKING LEDGE, WHICH IS NOT ALWAYS THERE.

          the user: "have that bottom bar that has the context model and project
          slide down and slide up when we want it, by default … slid down."
          The top-left Chat|Work control owns the choice (ModeToggle); this only
          renders the slide. It stays MOUNTED in chat mode rather than being
          removed, so the project picker and the effort dial keep their state
          across a toggle and the transition has something to animate.
        */}
        <div
          className="pd-composer-ledge"
          data-open={workMode === 'work'}
          data-testid="composer-ledge"
          /*
           * A CLOSED PANEL MUST NOT KEEP ITS CONTROLS IN THE TAB ORDER.
           *
           * It stays mounted so the project picker and effort dial keep their
           * state across a toggle and the transition has something to animate —
           * but a control you cannot see and can still tab to is the same defect
           * the closed settings rail had. `inert` takes the whole subtree out of
           * focus, hit-testing and the accessibility tree in one attribute.
           */
          inert={workMode !== 'work'}
        >
          <div>
            <ComposerBar />
          </div>
        </div>
      </div>

      {/* the user: when a message is queued, a small line UNDER the input — a plain
          "Queued" prefix + the blue explainer link (no per-bubble reason text). */}
      {hasQueued ? (
        <div
          className="mt-1.5 flex items-center gap-1.5 px-1 text-caption"
          data-testid="composer-queued-hint"
        >
          <span className="text-text-muted">Queued</span>
          <button
            type="button"
            className="text-text-link hover:underline"
            onClick={() => openQueueExplainer(true)}
            data-testid="why-queued-link"
          >
            Why isn't my message sending?
          </button>
        </div>
      ) : null}

      {/*
        THE STARTERS MOVED DOWN HERE. the user: "put that stuff below the input bar
        but above the special command instructions."

        They were above the composer, between the greeting and the box, which put
        the app's four suggestions in the way of the thing someone opened it to
        use. Below the box they read as an offer beside the keyboard shortcuts
        rather than an obstacle in front of the cursor — and the two rows are the
        same KIND of thing: here is what you can ask for, here is how to reach it.
      */}
      {isHome && !isStreaming ? (
        <div className="pd-composer-starters">
          <StarterChips />
        </div>
      ) : null}

      {/* the user #12: the @ / / ! shortcuts, demoted out of the placeholder to a
          subtle helper line under the composer — shown only on the empty home
          screen so a first-timer discovers them without jargon in the input. */}
      {isHome && !isStreaming ? (
        <div className="pd-composer-hints" data-testid="composer-hints">
          <span className="pd-composer-hint">
            <kbd>@</kbd> files
          </span>
          <span className="pd-composer-hint">
            <kbd>/</kbd> commands
          </span>
          <span className="pd-composer-hint">
            <kbd>!</kbd> bash
          </span>
        </div>
      ) : null}
    </div>
  );
}
