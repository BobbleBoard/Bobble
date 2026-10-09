/**
 * A PICTURE, OPENED — a small image studio around one image.
 *
 * the user: "clicking on a card (eg image once finished generating) does not
 * expand/open it", and then: "images clicked on/fullscreened should have the
 * new studio like ui with the left toolbar and such and a centered bottom 'edit
 * image' input bar aswell."
 *
 * The shape is the image editor he approved the direction of
 * (deliverables/ui-design/image-editor/proto-native), built from the app's own
 * parts rather than new ones: the tool rail is the 3D viewport's floating group
 * (`tp-float-group`), the history is its History card (`tp-history-rail`), the
 * bar is the studio composer (`pd-studio-composer` + an underbar picker), and a
 * running edit is the ordinary waiting card (PendingMediaCard). Hence the
 * import of tripo.css below: those classes live there, and this module is a
 * lazy chunk of its own, so the 3D stylesheet still loads only when something
 * that uses it opens.
 *
 * ONLY TOOLS THAT WORK. The prototype's rail also has Comment, Markup, Remove
 * BG, Erase, Resize and Upscale; none of them has an engine behind it yet, and
 * a button that does nothing teaches people the rail lies. So: Copy, Export,
 * Show in Finder, Send to chat, Open in Image Studio — and the Edit bar.
 *
 * WHERE AN EDIT LANDS. In the viewer, as a new version in its History, and NOT
 * in the conversation. The transcript is the record of the conversation with
 * the model, and a picture the model never saw appearing in it would misstate
 * what the model knows — the next "make it brighter" would be about a picture
 * it has no idea exists. The prototype makes the same call ("the chat's file
 * stays as it is"). The way into the conversation is deliberate: Send to chat
 * attaches the version on screen to the composer, where sending it puts it in
 * front of the model for real.
 */
import '../tripo/tripo.css';
import './image-viewer.css';
import { sayIfRaw } from '@pi-desktop/shared';
import {
  Button,
  IconChat,
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconFolder,
  IconImage,
  Spinner,
  Tooltip,
  useCopyFeedback,
} from '@pi-desktop/ui';
import {
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { pdFileUrl } from '../chat/canvas/file-preview';
import type { ThreadMediaItem } from '../chat/thread-media';
import { useGenStore } from '../state/gen-store';
import { useModalityStore } from '../state/modality-store';
import { useStudioHandoff } from '../state/studio-handoff';
import { StudioPicker } from '../studio/StudioShell';
import { ExpandedScrim } from './ExpandedScrim';
import {
  DEFAULT_EDIT_STRENGTH,
  EDIT_STRENGTHS,
  type EditStrength,
  editSize,
  type ImageVersion,
} from './image-edit';
import {
  clearEditError,
  finishReveal,
  runEdit,
  selectVersion,
  sessionOf,
  stopEdit,
  useImageEdits,
} from './image-edits-store';
import { ModuleCard } from './ModuleCard';
import { copyFile, exportFile, revealFile, startFileDrag } from './media-actions';
import { PendingMediaCard } from './PendingMediaCard';
import { sendToChat } from './send-to-chat';

export interface ImageViewerProps {
  readonly item: ThreadMediaItem;
  readonly onClose: () => void;
}

/** The bar's distance from the window's bottom edge (image-viewer.css). */
const BAR_BOTTOM = 14;
/**
 * Air between the bottom of the picture and the top of the bar — about the gap
 * the approved prototype leaves there, and room for anything the waiting card
 * hangs under its frame (its old bar and caption did: SEEN at 18px, the "20%"
 * ran under the Download card; ViewerStage measures whatever hangs there now).
 */
const BAR_AIR = 44;

export function ImageViewer({ item, onClose }: ImageViewerProps): JSX.Element {
  const original = useMemo<ImageVersion>(
    () => ({ path: item.path, name: item.name, label: 'Original' }),
    [item.path, item.name],
  );
  const stored = useImageEdits((s) => s.sessions[original.path]);
  const session = stored ?? sessionOf(original);
  const current = session.versions[session.index] ?? original;
  const job = session.job;
  /*
   * A RESULT JOINS THE HISTORY WHEN IT IS ON THE STAGE, not when it exists. It
   * is in the store the moment the run returns (so closing the viewer mid-reveal
   * cannot lose it), but listing it then made the History card appear while the
   * waiting card was still uncovering it — and the card opening moves the stage
   * over, which dragged the reveal sideways by 90px.
   */
  const pending = job?.result;
  const listed =
    pending === undefined ? session.versions : session.versions.filter((v) => v !== pending);
  const pictureRef = useRef<HTMLImageElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /*
   * THE PICTURE GETS WHAT THE BAR LEAVES. The bar is not one height: the image
   * module's Download card sits on top of it until the module is installed, and
   * an error line under it when a run fails. SEEN with a fixed reserve: the
   * Download card laid over the bottom of the picture. So the bar is measured
   * and the stage stops above it, whatever it holds.
   */
  useLayoutEffect(() => {
    const room = roomRef.current;
    const bar = barRef.current;
    if (room === null || bar === null) return;
    const fitStage = (): void => {
      const h = bar.getBoundingClientRect().height;
      room.style.setProperty('--pd-viewer-bottom', `${Math.ceil(h) + BAR_BOTTOM + BAR_AIR}px`);
    };
    fitStage();
    const ro = new ResizeObserver(fitStage);
    ro.observe(bar);
    // From the next frame on, changes animate (image-viewer.css `data-ready`).
    const id = requestAnimationFrame(() => room.setAttribute('data-ready', 'true'));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(id);
    };
  }, []);

  return (
    <ExpandedScrim label={item.name} onClose={onClose} testid="image-viewer" layout="room">
      <div
        ref={roomRef}
        className="pd-viewer"
        data-history={listed.length > 1 ? 'true' : undefined}
      >
        <ViewerTools item={item} current={current} onClose={onClose} />
        <ViewerStage original={original} current={current} pictureRef={pictureRef} />
        {listed.length > 1 ? (
          <ViewerHistory
            versions={listed}
            index={session.index}
            busy={job !== null}
            onSelect={(i) => selectVersion(original, i)}
          />
        ) : null}
        <EditBar original={original} picture={pictureRef} barRef={barRef} />
        <Tooltip label="Close" kbd="Esc" side="left">
          <button
            type="button"
            className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm pd-viewer-close"
            data-testid="viewer-close"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </Tooltip>
      </div>
    </ExpandedScrim>
  );
}

/**
 * THE RAIL — the 3D viewport's floating group, stood on the left edge.
 *
 * Every tool acts on the version ON SCREEN, so after an edit Copy copies the
 * edit and Send to chat sends it.
 */
function ViewerTools({
  item,
  current,
  onClose,
}: {
  item: ThreadMediaItem;
  current: ImageVersion;
  onClose: () => void;
}): JSX.Element {
  const { copied, copy } = useCopyFeedback();
  const setModality = useModalityStore((s) => s.setView);
  const view = useModalityStore((s) => s.view);
  const offerToStudio = useStudioHandoff((s) => s.offer);
  /* Standing in the Image Studio already, "open it there" is "work from it" —
     the same turn the card's own button makes (MediaCard: "Use as input"). */
  const inStudio = view === 'image';
  return (
    <div className="pd-viewer-tools" data-testid="viewer-tools">
      <div className="tp-float-group" role="toolbar" aria-label="Image tools">
        <Tool
          label={copied ? 'Copied' : 'Copy image'}
          testid="viewer-copy"
          onClick={() => {
            void copyFile(current.path).then((ok) => {
              if (ok) copy();
            });
          }}
        >
          {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
        </Tool>
        <Tool
          label="Export…"
          testid="viewer-export"
          onClick={() => exportFile(current.path, current.name)}
        >
          <IconDownload size={17} />
        </Tool>
        <Tool
          label="Show in Finder"
          testid="viewer-reveal"
          onClick={() => revealFile(current.path)}
        >
          <IconFolder size={17} />
        </Tool>
        <span className="tp-float-sep" aria-hidden="true" />
        <Tool
          label="Send to chat"
          testid="viewer-send-chat"
          onClick={() => {
            /* Handed over first, closed after: the composer drains the drop
               store when it renders, and it is mounted behind this dialog. */
            void sendToChat({ path: current.path, name: current.name, kind: 'image' }).then(
              onClose,
            );
          }}
        >
          <IconChat size={17} />
        </Tool>
        <Tool
          label={inStudio ? 'Use as input in Image Studio' : 'Open in Image Studio'}
          testid="viewer-open-studio"
          onClick={() => {
            offerToStudio('image', {
              path: current.path,
              name: current.name,
              kind: 'image',
              // The words that made the ORIGINAL; an edit's own words are only
              // a change to it, not a description of the picture.
              ...(current.path === item.path && item.prompt !== undefined
                ? { prompt: item.prompt }
                : {}),
              ...(current.path === item.path && item.seed !== undefined ? { seed: item.seed } : {}),
            });
            if (!inStudio) setModality('image');
            onClose();
          }}
        >
          <IconImage size={17} />
        </Tool>
      </div>
    </div>
  );
}

function Tool({
  label,
  testid,
  onClick,
  children,
}: {
  label: string;
  testid: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        className="tp-float-btn pd-focusable"
        data-testid={testid}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * THE PICTURE — or, while an edit runs, the waiting card in its place.
 *
 * The card is sized to the picture it replaces (measured when Edit is pressed),
 * so the result is uncovered in the same box and the swap back to a plain
 * picture has nothing left to move.
 */
function ViewerStage({
  original,
  current,
  pictureRef,
}: {
  original: ImageVersion;
  current: ImageVersion;
  pictureRef: RefObject<HTMLImageElement | null>;
}): JSX.Element {
  const job = useImageEdits((s) => s.sessions[original.path]?.job ?? null);
  const onRevealed = useCallback(() => finishReveal(original), [original]);
  const progress =
    job?.step !== undefined && job.total !== undefined && job.total > 0
      ? job.step / job.total
      : undefined;

  /*
   * THE FRAME WHERE THE PICTURE WAS — to the pixel.
   *
   * The waiting card is a frame with a bar and a line of words UNDER it, so
   * centred whole it sat half that tail higher than the picture had, and the
   * result would jump down by it at the swap. The tail is measured and taken
   * back out of the card's box (a negative bottom margin), so what the stage
   * centres is exactly the frame.
   *
   * And the card is GIVEN its width: in a flex row it is shrink-to-fit, its
   * frame's `100%` is circular, and it collapsed to the width of its "20%"
   * caption (SEEN: a 200px card at the top of a 724px stage).
   */
  const pendingRef = useRef<HTMLDivElement>(null);
  const waiting = job !== null;
  useLayoutEffect(() => {
    const host = pendingRef.current;
    if (!waiting || host === null) return;
    const measure = (): void => {
      const card = host.querySelector('.pd-media-card');
      const frame = host.querySelector('.pd-media-frame');
      if (card === null || frame === null) return;
      const tail = card.getBoundingClientRect().height - frame.getBoundingClientRect().height;
      host.style.setProperty('--pd-viewer-pending-tail', `${Math.max(0, Math.round(tail))}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [waiting]);

  return (
    <div
      className="pd-viewer-stage"
      data-testid="viewer-stage"
      style={
        job !== null
          ? ({ '--pd-media-max-h': `${Math.round(job.height)}px` } as CSSProperties)
          : undefined
      }
    >
      {job !== null ? (
        <div
          ref={pendingRef}
          className="pd-viewer-pending"
          /* +2: the frame is content-box with a 1px border either side, the
             same 1px the picture draws as its ring — so the frame's edge lands
             on the picture's edge, not a pixel inside it. */
          style={{ width: `${Math.round(job.width) + 2}px` }}
        >
          <PendingMediaCard
            kind="image"
            aspect={job.aspect}
            width={Math.round(job.width)}
            label="Editing image"
            edit
            /* The edit's own id keys its % — a viewer closed and reopened mid-run
               picks the number up where it was instead of starting at nothing. */
            progressKey={job.requestId}
            {...(progress !== undefined ? { progress } : {})}
            {...(job.total !== undefined && job.total > 0 ? { steps: job.total } : {})}
            {...(job.note !== undefined ? { note: job.note } : {})}
            {...(job.result !== undefined
              ? {
                  item: { path: job.result.path, kind: 'image' as const, name: job.result.name },
                }
              : {})}
            onRevealed={onRevealed}
          />
        </div>
      ) : (
        /* Dragging the picture out drops the real file in Finder, as the card
           does; Export in the rail is the same outcome by keyboard. */
        <img
          key={current.path}
          ref={pictureRef}
          className="pd-viewer-picture"
          data-testid="viewer-picture"
          src={pdFileUrl(current.path)}
          alt={current.label === 'Original' ? current.name : `${current.name} — ${current.label}`}
          draggable
          onDragStart={(e) => startFileDrag(e, current.path)}
        />
      )}
    </div>
  );
}

/**
 * THE HISTORY — the 3D studio's History card, listing this picture's versions.
 *
 * Appears once there is a second version: a list of one is not a history. The
 * current version is the blue dot with the white core, as in the studio.
 * Stepping back while an edit runs is allowed — the edit still edits the
 * version it started from, and lands as the newest one.
 */
function ViewerHistory({
  versions,
  index,
  busy,
  onSelect,
}: {
  versions: readonly ImageVersion[];
  index: number;
  busy: boolean;
  onSelect: (i: number) => void;
}): JSX.Element {
  return (
    <nav
      className="tp-history-rail pd-viewer-history"
      data-open="true"
      data-testid="viewer-history"
      aria-label="Versions"
    >
      <div className="tp-history-head pd-viewer-history-head">
        <span>
          History<span className="pd-viewer-count">{versions.length}</span>
        </span>
        {busy ? <Spinner size={12} /> : null}
      </div>
      <ol className="tp-history-list">
        {versions.map((v, i) => (
          <li key={v.path} className="tp-history-item">
            <button
              type="button"
              className="tp-history-node pd-focusable"
              data-testid={`viewer-version-${i}`}
              data-current={i === index ? 'true' : undefined}
              aria-current={i === index ? 'true' : undefined}
              title={v.label}
              onClick={() => onSelect(i)}
            >
              <span className="tp-history-dot" aria-hidden="true" />
              <span className="tp-history-label">{v.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * THE EDIT BAR — the studio composer, floated at the bottom centre.
 *
 * Typed words are the change; the one knob under the box is how far the
 * picture may travel (the studio's own Low / Medium / High). Enter runs, and
 * while it runs the button is Stop — the Image Studio's rules, on purpose.
 */
function EditBar({
  original,
  picture,
  barRef,
}: {
  original: ImageVersion;
  /** The picture on the stage, measured when Edit is pressed. */
  picture: { readonly current: HTMLImageElement | null };
  /** The bar itself, which the room measures to fit the picture above it. */
  barRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const job = useImageEdits((s) => s.sessions[original.path]?.job ?? null);
  const error = useImageEdits((s) => s.sessions[original.path]?.error ?? null);
  const [text, setText] = useState('');
  const [strength, setStrength] = useState<EditStrength>(DEFAULT_EDIT_STRENGTH);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The words of the last run, for Try again — the field is cleared on Edit. */
  const lastRef = useRef('');

  /*
   * The image module and the default model's weights, as the Image Studio shows
   * them: an edit waits at those gates for their Download buttons, and a gate
   * nobody can see is a run that hangs. Both render nothing once installed.
   */
  const loaded = useGenStore((s) => s.loaded);
  const refreshCatalog = useGenStore((s) => s.refreshCatalog);
  const catalog = useGenStore((s) => s.catalog);
  useEffect(() => {
    if (!loaded) void refreshCatalog().catch(() => undefined);
  }, [loaded, refreshCatalog]);
  const defaultModel = catalog.find((m) => m.modality === 'image')?.id;

  // The field is where the next keystroke goes when the viewer opens.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const busy = job !== null;
  const canRun = !busy && text.trim().length > 0;
  /* Only once main has named the job — before that there is nothing to cancel,
     and a Stop that does nothing is worse than none (StudioShell's rule). */
  const stoppable = busy && job?.result === undefined && job?.jobId !== undefined;

  const run = (words: string): void => {
    if (busy || words.trim() === '') return;
    /* The picture's box on screen is the waiting card's box. */
    const pic = picture.current;
    const r = pic?.getBoundingClientRect();
    const w = pic?.naturalWidth ?? 0;
    const h = pic?.naturalHeight ?? 0;
    lastRef.current = words;
    setText('');
    void runEdit(original, {
      instruction: words,
      strength,
      size: editSize(w, h),
      box: {
        aspect: w > 0 && h > 0 ? w / h : 1,
        width: r !== undefined && r.width > 0 ? r.width : 480,
        height: r !== undefined && r.height > 0 ? r.height : 480,
      },
    });
  };

  return (
    <div ref={barRef} className="pd-viewer-bar" data-testid="viewer-bar">
      <ModuleCard id="image" place="studio" />
      {defaultModel !== undefined ? (
        <ModuleCard id={`weights:${defaultModel}`} place="studio" />
      ) : null}
      <form
        className="pd-studio-composer pd-viewer-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canRun) run(text);
        }}
      >
        <input
          ref={inputRef}
          className="pd-studio-prompt pd-focusable"
          data-testid="viewer-edit-input"
          aria-label="Edit image"
          placeholder="Edit image"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type={stoppable ? 'button' : 'submit'}
          variant="accent"
          className="pd-studio-run-btn"
          data-testid="viewer-edit-run"
          disabled={!canRun && !stoppable}
          data-stop={stoppable ? 'true' : undefined}
          onClick={stoppable ? () => stopEdit(original) : undefined}
        >
          {busy ? (
            <span className="flex items-center gap-1.5">
              <Spinner size={12} /> {stoppable ? 'Stop' : 'Working…'}
            </span>
          ) : (
            'Edit'
          )}
        </Button>
      </form>
      <div className="pd-studio-underbar pd-viewer-underbar">
        <StudioPicker
          testid="viewer-strength"
          label="Change"
          value={strength}
          onChange={setStrength}
          options={EDIT_STRENGTHS.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))}
        />
      </div>
      {error !== null ? (
        /* The studio's error line, and its one-click recovery: most failures
           are transient (a runtime still installing, a model swapped out). */
        <p className="pd-studio-error pd-viewer-error" data-testid="viewer-edit-error">
          <span>{sayIfRaw(error, 'generate')}</span>
          <button
            type="button"
            className="pd-studio-error-retry pd-focusable"
            data-testid="viewer-edit-retry"
            onClick={() => {
              clearEditError(original);
              run(lastRef.current);
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
    </div>
  );
}
