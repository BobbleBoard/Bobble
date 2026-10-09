/**
 * THE QUICK PANEL'S WINDOW — what a global hotkey brings up over any app.
 *
 * Two faces. COMPACT is a launcher: the field, what will go with the question
 * (chips), what can be attached in one press, and a foot saying which app is in
 * front. It hugs its content, so it is as small as it can be. Once there is a
 * conversation the panel becomes the THREAD face: a small chat, header on top,
 * answer in the middle, composer at the foot.
 *
 * Keys: ↩ ask · ⇧↩ new line · esc back or close · ⌘K commands · ⌘N new thread
 * · ⌘Y recent · ⌘↩ open in Bobble · ⌘1 this window · ⌘2 pick a window · ⌘3 an
 * area · ⌘4 the screen · ⌘E bigger/smaller · ⌘⇧P pin.
 */
import { CanvasProvider, createCanvasController } from '@pi-desktop/canvas';
import {
  Glyph,
  IconAppWindow,
  IconAreaSelect,
  IconArrowUp,
  IconBulb,
  IconButton,
  IconChevronLeft,
  IconClipboard,
  IconClock,
  IconClose,
  IconCommand,
  IconExpand,
  IconExternal,
  IconFolderOpen,
  IconGlobe,
  IconListBullet,
  IconMic,
  IconMonitor,
  IconPickWindow,
  IconPin,
  IconQuill,
  IconShrink,
  IconSpellCheck,
  IconStop,
  IconTranslate,
  ToastProvider,
  Tooltip,
  TooltipProvider,
} from '@pi-desktop/ui';
import {
  type DragEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isReadableBrowser } from '../../electron/quick/browsers';
import { QUICK_TEXT_ACTION_LABELS, type QuickTextAction } from '../../electron/quick/context';
import { AskCard } from '../chat/AskCard';
import { BobbleMark } from '../chat/BobbleMark';
import { attachPlan } from '../chat/composer/incoming-files';
import { DictationBar } from '../chat/DictationBar';
import { HeldSendCard } from '../chat/HeldSendCard';
import { useDictation } from '../chat/useDictation';
import { ModuleCard } from '../media/ModuleCard';
import { abortPi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { ContextChips } from './ContextChips';
import { markInputActivity } from './input-activity';
import { QuickHistory } from './QuickHistory';
import { QuickPalette } from './QuickPalette';
import { QuickProblemCard } from './QuickProblemCard';
import { QuickThread } from './QuickThread';
import {
  attachFrontApp,
  captureInto,
  connectQuickPanel,
  dismiss,
  newThread,
  openThreadInBobble,
  readInto,
  requestSize,
  sendFromPanel,
} from './quick-panel';
import { type QuickAttachment, SELECTION_ACTIONS, useQuickStore } from './quick-store';
import { WindowPicker } from './WindowPicker';
import './quick-panel.css';

const ACTION_ICONS: Record<QuickTextAction, (p: { size?: number }) => JSX.Element> = {
  explain: IconBulb,
  rewrite: IconQuill,
  translate: IconTranslate,
  summarize: IconListBullet,
  fix: IconSpellCheck,
};

/** One pill-shaped action. */
function Act({
  icon,
  label,
  keys,
  onClick,
  primary = false,
  disabled = false,
  testid,
}: {
  icon: ReactNode;
  label: string;
  keys?: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  testid: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="qp-act pd-focusable"
      data-primary={primary ? 'true' : 'false'}
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
      {keys !== undefined ? <span className="qp-act-key">{keys}</span> : null}
    </button>
  );
}

/** An icon-only tool with its name on hover. */
function Tool({
  label,
  keys,
  onClick,
  children,
  testid,
  on,
}: {
  label: string;
  keys?: string;
  onClick: () => void;
  children: ReactNode;
  testid: string;
  /** A toggle's state: on draws it in the accent, and says so to assistive tech. */
  on?: boolean;
}): JSX.Element {
  return (
    <Tooltip label={label} {...(keys !== undefined ? { kbd: keys } : {})}>
      <IconButton
        aria-label={label}
        size="sm"
        onClick={onClick}
        data-testid={testid}
        {...(on !== undefined ? { 'aria-pressed': on, 'data-on': on ? 'true' : 'false' } : {})}
        className={on === true ? 'qp-tool-on' : undefined}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

/** The selection's text actions: the reason most people summon over selected text. */
function SelectionActions({
  onAction,
}: {
  onAction: (a: QuickTextAction) => void;
}): JSX.Element | null {
  const selection = useQuickStore((s) => s.contexts.find((c) => c.kind === 'selection'));
  const language = useQuickStore((s) => s.language);
  if (selection === undefined) return null;
  return (
    <div className="qp-row" data-testid="quick-selection-actions">
      {SELECTION_ACTIONS.map((a) => {
        const Icon = ACTION_ICONS[a];
        const label = a === 'translate' ? `Translate to ${language}` : QUICK_TEXT_ACTION_LABELS[a];
        return (
          <Act
            key={a}
            icon={<Icon size={15} />}
            label={label}
            primary={a === 'explain'}
            onClick={() => onAction(a)}
            testid={`quick-text-${a}`}
          />
        );
      })}
    </div>
  );
}

/** What can be attached in one press, labelled (the compact face). */
function AttachRow(): JSX.Element {
  const front = useQuickStore((s) => s.front);
  const set = useQuickStore((s) => s.set);
  const acting = useQuickStore((s) => s.contexts.some((c) => c.kind === 'app'));
  const hasPage = useQuickStore((s) => s.contexts.some((c) => c.kind === 'browser'));
  const hasFiles = useQuickStore((s) => s.contexts.some((c) => c.kind === 'files'));
  const other = front !== null && front.isBobble !== true ? front : null;
  const appIcon = other?.icon !== undefined ? <img src={other.icon} alt="" /> : null;
  return (
    <div className="qp-row" data-testid="quick-attach-row">
      {other !== null ? (
        <Act
          icon={<IconAppWindow size={15} />}
          label="This window"
          keys="⌘1"
          onClick={() => void captureInto('front-window')}
          testid="quick-act-window"
        />
      ) : null}
      <Act
        icon={<IconPickWindow size={15} />}
        label="Pick a window"
        keys="⌘2"
        onClick={() => set({ view: 'windows' })}
        testid="quick-act-pick"
      />
      <Act
        icon={<IconAreaSelect size={15} />}
        label="Area"
        keys="⌘3"
        onClick={() => void captureInto('region')}
        testid="quick-act-area"
      />
      <Act
        icon={<IconMonitor size={15} />}
        label="Screen"
        keys="⌘4"
        onClick={() => void captureInto('screen')}
        testid="quick-act-screen"
      />
      {other !== null && !acting ? (
        <Act
          icon={appIcon ?? <Glyph name="computerUse" size={15} />}
          label={`Use ${other.name}`}
          onClick={() => attachFrontApp()}
          testid="quick-act-use-app"
        />
      ) : null}
      {other !== null && isReadableBrowser(other.name) && !hasPage ? (
        <Act
          icon={<IconGlobe size={15} />}
          label="This page"
          onClick={() => void readInto('browser')}
          testid="quick-act-page"
        />
      ) : null}
      {other?.name === 'Finder' && !hasFiles ? (
        <Act
          icon={<IconFolderOpen size={15} />}
          label="Selected files"
          onClick={() => void readInto('finder')}
          testid="quick-act-finder"
        />
      ) : null}
      <Act
        icon={<IconClipboard size={15} />}
        label="Clipboard"
        onClick={() => void readInto('clipboard')}
        testid="quick-act-clipboard"
      />
    </div>
  );
}

/** The same, as icons beside the thread's composer. */
function AttachTools(): JSX.Element {
  const front = useQuickStore((s) => s.front);
  const set = useQuickStore((s) => s.set);
  const other = front !== null && front.isBobble !== true ? front : null;
  return (
    <div className="qp-tool-icons" data-testid="quick-attach-tools">
      {other !== null ? (
        <Tool
          label={`The ${other.name} window`}
          keys="⌘1"
          onClick={() => void captureInto('front-window')}
          testid="quick-tool-window"
        >
          <IconAppWindow size={15} />
        </Tool>
      ) : null}
      <Tool
        label="Pick a window"
        keys="⌘2"
        onClick={() => set({ view: 'windows' })}
        testid="quick-tool-pick"
      >
        <IconPickWindow size={15} />
      </Tool>
      <Tool
        label="An area of the screen"
        keys="⌘3"
        onClick={() => void captureInto('region')}
        testid="quick-tool-area"
      >
        <IconAreaSelect size={15} />
      </Tool>
      <Tool
        label="The whole screen"
        keys="⌘4"
        onClick={() => void captureInto('screen')}
        testid="quick-tool-screen"
      >
        <IconMonitor size={15} />
      </Tool>
      {other !== null ? (
        <Tool
          label={`Do something in ${other.name}`}
          onClick={() => attachFrontApp()}
          testid="quick-tool-use-app"
        >
          <Glyph name="computerUse" size={15} />
        </Tool>
      ) : null}
      <Tool
        label="Clipboard"
        onClick={() => void readInto('clipboard')}
        testid="quick-tool-clipboard"
      >
        <IconClipboard size={15} />
      </Tool>
    </div>
  );
}

/** Read dropped files the way the chat's composer does. */
async function dropFiles(files: FileList): Promise<void> {
  markInputActivity('drop');
  const add = useQuickStore.getState().addAttachment;
  const list = [...files];
  const paths = list.map((f) => window.piDesktop.pathForFile(f));
  const inspected = await window.piDesktop
    .invoke('attachments:inspect', { paths: paths.filter((p) => p !== '') })
    .catch(() => ({ items: [] }));
  const disk = new Map(inspected.items.map((i) => [i.path, i]));
  for (const [i, file] of list.entries()) {
    const path = paths[i] ?? '';
    const onDisk = disk.get(path) ?? null;
    const plan = attachPlan(file, path, onDisk);
    const id = `drop-${Date.now()}-${i}`;
    const base = { id, name: file.name, ...(path !== '' ? { path } : {}), bytes: file.size };
    if (plan.as === 'image') {
      const image = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (image !== '') add({ ...base, kind: 'image', image } as QuickAttachment);
    } else if (plan.as === 'text') {
      add({ ...base, kind: 'text', text: await file.text() } as QuickAttachment);
    } else if (plan.as === 'file' || plan.as === 'folder') {
      add({ ...base, kind: plan.as } as QuickAttachment);
    }
  }
}

export function QuickPanelApp(): JSX.Element {
  const [controller] = useState(() => createCanvasController());
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider swipeDirection="right">
        <CanvasProvider controller={controller}>
          <QuickPanel />
        </CanvasProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

function QuickPanel(): JSX.Element {
  const view = useQuickStore((s) => s.view);
  const size = useQuickStore((s) => s.size);
  const pinned = useQuickStore((s) => s.pinned);
  const front = useQuickStore((s) => s.front);
  const text = useQuickStore((s) => s.text);
  const actingIn = useQuickStore((s) => {
    const app = s.contexts.find((c) => c.kind === 'app');
    return app?.kind === 'app' ? app.app : null;
  });
  const summons = useQuickStore((s) => s.summons);
  const talkRequests = useQuickStore((s) => s.talkRequests);
  const set = useQuickStore((s) => s.set);
  const hasThread = usePiStore((s) => s.messages.length > 0);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const sessionTitle = usePiStore((s) => s.windowTitle);
  const firstAsk = usePiStore((s) => s.messages.find((m) => m.kind === 'user'));
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => connectQuickPanel(), []);

  const face: 'compact' | 'thread' = hasThread || view !== 'home' ? 'thread' : 'compact';

  // Compact hugs its content; the thread face takes a size of its own.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    if (face === 'thread') {
      if (size === 'compact') requestSize('expanded');
      return;
    }
    const hug = () => requestSize('compact', el.getBoundingClientRect().height);
    hug();
    const ro = new ResizeObserver(hug);
    ro.observe(el);
    return () => ro.disconnect();
  }, [face, size]);

  // Every summon puts the caret in the field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the summon count
  useEffect(() => {
    if (view === 'home') setTimeout(() => inputRef.current?.focus(), 0);
  }, [summons, view]);

  const dictation = useDictation((spoken) => {
    const now = useQuickStore.getState().text;
    set({ text: now.trim() === '' ? spoken : `${now.replace(/\s+$/, '')} ${spoken}` });
    inputRef.current?.focus();
  });
  const listening =
    dictation.phase === 'starting' ||
    dictation.phase === 'recording' ||
    dictation.phase === 'transcribing';

  const talk = useCallback(() => {
    if (listening) {
      dictation.stop();
      return;
    }
    markInputActivity('talk');
    dictation.start();
  }, [listening, dictation]);

  /*
   * PUT AWAY MEANS THE MICROPHONE IS OFF. A recording left running behind a
   * hidden panel would keep the Mac's microphone light on with nothing on
   * screen to stop it; a Download card or a problem from last time does not
   * belong to the next opening either.
   */
  const shown = useQuickStore((s) => s.shown);
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  useEffect(() => {
    if (!shown && dictationRef.current.phase !== 'idle') dictationRef.current.cancel();
  }, [shown]);

  // The global "talk" key: start listening, or stop if already listening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the request count
  useEffect(() => {
    if (talkRequests > 0) talk();
  }, [talkRequests]);

  // Push-to-talk: hold the mic, speak, let go.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);

  const send = useCallback(
    async (action?: QuickTextAction) => {
      const sent = await sendFromPanel(useQuickStore.getState().text, action);
      if (sent) set({ text: '' });
    },
    [set],
  );

  // The panel's keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const q = useQuickStore.getState();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (q.view !== 'home') {
          q.set({ view: 'home' });
          return;
        }
        if (listening) {
          dictation.cancel();
          return;
        }
        dismiss();
        return;
      }
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (k === 'k') run(() => q.set({ view: q.view === 'palette' ? 'home' : 'palette' }));
      else if (k === 'n') run(() => void newThread());
      else if (k === 'y') run(() => q.set({ view: q.view === 'history' ? 'home' : 'history' }));
      else if (k === 'enter' || k === 'o') run(() => void openThreadInBobble(q.text));
      else if (k === '1') run(() => void captureInto('front-window'));
      else if (k === '2') run(() => q.set({ view: 'windows' }));
      else if (k === '3') run(() => void captureInto('region'));
      else if (k === '4') run(() => void captureInto('screen'));
      else if (k === 'e') run(() => requestSize(q.size === 'large' ? 'expanded' : 'large'));
      else if (k === 'p' && e.shiftKey) {
        run(() => {
          const next = !q.pinned;
          q.set({ pinned: next });
          void window.piDesktop.invoke('quick:set-pinned', { pinned: next });
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening, dictation]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void dropFiles(e.dataTransfer.files);
  };

  const field = (
    <div className="qp-field">
      {face === 'compact' ? (
        <span className="qp-field-mark qp-drag" aria-hidden="true">
          <BobbleMark size={22} />
        </span>
      ) : null}
      <textarea
        ref={inputRef}
        className="qp-input"
        rows={1}
        value={text}
        placeholder={
          actingIn !== null
            ? `What should Bobble do in ${actingIn}?`
            : front !== null && front.isBobble !== true
              ? `Ask Bobble, or tell it what to do in ${front.name}`
              : 'Ask Bobble anything'
        }
        aria-label="Ask Bobble"
        data-testid="quick-input"
        onChange={(e) => {
          markInputActivity('key');
          set({ text: e.target.value });
          const el = e.target;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
        }}
        onPaste={() => markInputActivity('paste')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!busy) void send();
          }
        }}
      />
      <div className="qp-field-actions">
        <Tooltip label={listening ? 'Stop listening' : 'Talk, or hold to talk'}>
          <IconButton
            aria-label={listening ? 'Stop listening' : 'Talk'}
            size="sm"
            data-testid="quick-mic"
            data-listening={listening ? 'true' : 'false'}
            onPointerDown={() => {
              holding.current = false;
              holdTimer.current = setTimeout(() => {
                holding.current = true;
                if (!listening) {
                  markInputActivity('talk');
                  dictation.start();
                }
              }, 350);
            }}
            onPointerUp={() => {
              if (holdTimer.current !== null) clearTimeout(holdTimer.current);
              if (holding.current) {
                holding.current = false;
                dictation.stop();
                return;
              }
              talk();
            }}
          >
            <IconMic size={15} />
          </IconButton>
        </Tooltip>
        {busy ? (
          <IconButton
            aria-label="Stop"
            variant="secondary"
            circle
            size="sm"
            data-testid="quick-stop"
            onClick={() => void abortPi()}
          >
            <IconStop size={13} />
          </IconButton>
        ) : (
          <IconButton
            aria-label="Ask"
            variant="accent"
            circle
            size="sm"
            data-testid="quick-send"
            onClick={() => void send()}
          >
            <IconArrowUp size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );

  const dictationRow = listening ? (
    <div className="qp-dictation" style={{ padding: face === 'compact' ? '0 16px 10px 56px' : 0 }}>
      <DictationBar
        phase={dictation.phase}
        levels={dictation.levels}
        onStop={dictation.stop}
        onCancel={dictation.cancel}
      />
    </div>
  ) : dictation.phase === 'needs-module' ? (
    <div className="qp-module" data-testid="quick-dictation-module">
      <ModuleCard
        id="dictation"
        place="chat"
        why="Talk to Bobble instead of typing; nothing leaves this Mac."
      />
    </div>
  ) : dictation.phase === 'error' && dictation.problem !== null ? (
    <div className="qp-card" role="status" data-testid="quick-dictation-problem">
      <div className="qp-card-text">
        <p className="qp-card-body">{dictation.problem.text}</p>
      </div>
    </div>
  ) : null;

  const sub =
    view === 'windows' ? (
      <WindowPicker />
    ) : view === 'palette' ? (
      <QuickPalette />
    ) : view === 'history' ? (
      <QuickHistory />
    ) : null;

  const otherApp = front !== null && front.isBobble !== true ? front : null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Bobble quick panel"
      className="qp"
      data-face={face}
      data-testid="quick-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {face === 'compact' ? (
        <>
          {field}
          <ContextChips />
          {dictationRow}
          <SelectionActions onAction={(a) => void send(a)} />
          <QuickProblemCard />
          <AttachRow />
          <div className="qp-foot qp-drag" data-testid="quick-foot">
            <span className="qp-foot-app">
              {otherApp !== null ? (
                <>
                  {otherApp.icon !== undefined ? <img src={otherApp.icon} alt="" /> : null}
                  {otherApp.name} is in front
                </>
              ) : (
                'Bobble is in front'
              )}
            </span>
            <span className="qp-foot-keys">
              <button
                type="button"
                onClick={() => set({ view: 'palette' })}
                data-testid="quick-open-palette"
              >
                <span className="qp-key">⌘K</span> Commands
              </button>
              <button
                type="button"
                onClick={() => set({ view: 'history' })}
                data-testid="quick-open-history"
              >
                <span className="qp-key">⌘Y</span> Recent
              </button>
              <span>
                <span className="qp-key">esc</span> Close
              </span>
            </span>
          </div>
        </>
      ) : (
        <>
          <header className="qp-head qp-drag" data-testid="quick-head">
            <BobbleMark size={18} />
            <span className="qp-head-title">
              {view === 'home' ? (sessionTitle ?? firstAsk?.text ?? 'Quick thread') : 'Bobble'}
            </span>
            <span className="qp-head-tools">
              {view !== 'home' ? (
                <Tool
                  label="Back"
                  keys="esc"
                  onClick={() => set({ view: 'home' })}
                  testid="quick-back"
                >
                  <IconChevronLeft size={15} />
                </Tool>
              ) : null}
              <Tool
                label="New thread"
                keys="⌘N"
                onClick={() => void newThread()}
                testid="quick-new-thread"
              >
                <Glyph name="newChat" size={15} />
              </Tool>
              <Tool
                label="Recent threads"
                keys="⌘Y"
                onClick={() => set({ view: 'history' })}
                testid="quick-recent"
              >
                <IconClock size={15} />
              </Tool>
              <Tool
                label="Commands"
                keys="⌘K"
                onClick={() => set({ view: 'palette' })}
                testid="quick-commands"
              >
                <IconCommand size={15} />
              </Tool>
              <Tool
                label="Open in Bobble"
                keys="⌘↩"
                onClick={() => void openThreadInBobble(text)}
                testid="quick-head-open"
              >
                <IconExternal size={15} />
              </Tool>
              <Tool
                on={pinned}
                label={pinned ? 'Pinned: stays open. Click to unpin' : 'Pin (stays open)'}
                keys="⌘⇧P"
                onClick={() => {
                  set({ pinned: !pinned });
                  void window.piDesktop.invoke('quick:set-pinned', { pinned: !pinned });
                }}
                testid="quick-pin"
              >
                <IconPin size={15} />
              </Tool>
              <Tool
                label={size === 'large' ? 'Smaller' : 'Bigger'}
                keys="⌘E"
                onClick={() => requestSize(size === 'large' ? 'expanded' : 'large')}
                testid="quick-size"
              >
                {size === 'large' ? <IconShrink size={15} /> : <IconExpand size={15} />}
              </Tool>
              <Tool label="Close" keys="esc" onClick={() => dismiss()} testid="quick-close">
                <IconClose size={15} />
              </Tool>
            </span>
          </header>
          <div className="qp-body">{sub ?? <QuickThread />}</div>
          {sub === null ? (
            <div className="qp-dock" data-testid="quick-dock">
              <QuickProblemCard />
              <AskCard />
              <HeldSendCard />
              <ContextChips />
              {dictationRow}
              <SelectionActions onAction={(a) => void send(a)} />
              {field}
              <AttachTools />
            </div>
          ) : null}
        </>
      )}
      {dragging ? (
        <div className="qp-drop" data-testid="quick-drop">
          Drop to ask about it
        </div>
      ) : null}
    </div>
  );
}
