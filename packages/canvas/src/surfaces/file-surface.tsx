import { type DiffFileData, DiffView, Markdown } from '@pi-desktop/ui';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ArtifactContent } from '../model.ts';
import type { FileViewMode } from '../tabs/tab-model.ts';
import { CodeSurface } from './code-surface.tsx';
import { HtmlSurface } from './html-surface.tsx';
import { SvgSurface } from './svg-surface.tsx';
import { type EditAnimationSpec, useEditAnimation } from './use-edit-animation.ts';

/** Content kinds that have a real RENDERED form (vs. raw source) — a file of one
 * of these gets the rendered↔raw toggle and defaults to Rendered (the user). */
function isRenderableKind(kind: ArtifactContent['kind']): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'svg';
}

/** Sensible default view for a file: renderable kinds (md/html/svg) render,
 * everything else is raw. */
export function defaultFileViewMode(content: ArtifactContent): FileViewMode {
  return isRenderableKind(content.kind) ? 'rendered' : 'raw';
}

/**
 * Stick-to-bottom that RESPECTS the user (round-9 free-scroll). While `active`
 * (the file is streaming in), the scroller is pinned to the newest line on each
 * delta — but ONLY when the user is already parked at the bottom. Any upward
 * intent (wheel up, ArrowUp/PageUp/Home, a downward touch-drag) releases the pin
 * so a burst of write deltas can never yank the reader back down; returning to
 * the bottom re-arms it. Mirrors ChatThread's app-side fix for canvas surfaces.
 *
 * Wheel/key/touch bubble to the stable `bodyRef` container, so one listener set
 * covers whichever scroller is mounted (CodeMirror's `.cm-scroller` or the
 * markdown pane); the non-bubbling `scroll` event is caught in the capture phase.
 */
function useStickToBottom(
  bodyRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  deltaKey: unknown,
  /** Set true the first time the reader moves this scroller by hand — the edit
   * animation reads it to decide whether an off-screen edit is worth playing. */
  intentRef?: RefObject<boolean>,
): void {
  const pinnedRef = useRef(true);

  const getScroller = useCallback((): HTMLElement | null => {
    const body = bodyRef.current;
    if (!body) return null;
    return (
      body.querySelector<HTMLElement>('.cm-scroller') ??
      body.querySelector<HTMLElement>('.pd-canvas-markdown') ??
      body.querySelector<HTMLElement>('.pd-canvas-diff')
    );
  }, [bodyRef]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const release = (): void => {
      pinnedRef.current = false;
    };
    // Any hand on the scroller counts as "I am reading somewhere"; only UPWARD
    // intent releases the stick-to-bottom pin.
    const touched = (): void => {
      if (intentRef !== undefined) intentRef.current = true;
    };
    const onWheel = (e: WheelEvent): void => {
      touched();
      if (e.deltaY < 0) release();
    };
    const onKey = (e: KeyboardEvent): void => {
      touched();
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') release();
    };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent): void => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent): void => {
      touched();
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastY + 1) release(); // finger drags down → content moves up
      lastY = y;
    };
    // Re-arm only when the CURRENT scroller is genuinely back at the bottom (tight
    // threshold so scrolling even slightly up stays released).
    const onScroll = (e: Event): void => {
      const el = e.target as HTMLElement | null;
      if (el === null || typeof el.scrollHeight !== 'number') return;
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    };
    body.addEventListener('wheel', onWheel, { passive: true });
    body.addEventListener('keydown', onKey);
    body.addEventListener('touchstart', onTouchStart, { passive: true });
    body.addEventListener('touchmove', onTouchMove, { passive: true });
    // `scroll` doesn't bubble → listen in the capture phase on the container.
    body.addEventListener('scroll', onScroll, true);
    return () => {
      body.removeEventListener('wheel', onWheel);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('touchstart', onTouchStart);
      body.removeEventListener('touchmove', onTouchMove);
      body.removeEventListener('scroll', onScroll, true);
    };
  }, [bodyRef, intentRef]);

  // Keep the newest content in view on each delta — ONLY while pinned. Child
  // effects (which apply the code/markdown delta) run before this parent effect,
  // so the scroller height already reflects the new content. `deltaKey`
  // (content.text) is the per-delta re-run trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each delta.
  useEffect(() => {
    if (!active || !pinnedRef.current) return;
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [deltaKey, active, getScroller]);
}

export interface FileSurfaceProps {
  content: ArtifactContent;
  filename?: string;
  /**
   * LIVE mode: the file is still being written. The underlying code viewer
   * reconciles appended text without resetting scroll, and the surface
   * auto-scrolls to the newest line on each delta WHILE the user is at the
   * bottom (see {@link useStickToBottom}).
   */
  streaming?: boolean;
  /**
   * Raw ↔ rendered view. `rendered` markdown goes through @pi-desktop/ui's
   * Markdown (katex + hex swatches + fenced code); everything else (and `raw`)
   * uses the CodeMirror source viewer. Defaults per file type via
   * {@link defaultFileViewMode}.
   */
  mode?: FileViewMode;
  /**
   * Show the filename header strip. Defaults to `true` for standalone use; the
   * tabbed canvas passes `false` because the operation-bar breadcrumb already
   * names the file (avoids a duplicate header — round-8 #12).
   */
  showFilename?: boolean;
  onCopy?: (text: string) => void;
  /**
   * Make the raw/code view an EDITABLE buffer (round-9 write-back). Ignored for
   * the rendered-markdown view (prose is not edited in place). Only enable for a
   * real, finalized on-disk file — pair with {@link onSave}.
   */
  editable?: boolean;
  /** Persist the edited buffer (⌘/Ctrl-S in the raw editor). */
  onSave?: (text: string) => void;
  /** Slot for future inline editing UI (overlaid below the viewer). */
  children?: ReactNode;
  className?: string;
  /**
   * Live line-diff counts (a corp worker writing this file NOW): a small +N/−N
   * badge overlays the surface. Both unset/zero → no badge (an ordinary chat file
   * tab shows nothing), so this stays inert outside a corp run.
   */
  addedLines?: number;
  removedLines?: number;
  /**
   * FALLBACK ONLY: a live edit rendered as a diff.
   *
   * An edit normally plays as {@link editAnim} — the file itself, with the
   * replaced text forward-deleting and the replacement typing in after it. This
   * is what is left when that is impossible: the file could not be read, or the
   * tool's `old_string` does not occur in it, so there is no place to stand the
   * caret. Then, and only then, the surface falls back to showing the hunk as a
   * diff. Reuses the shared {@link DiffView}/diff.css.
   */
  diff?: DiffFileData[];
  /**
   * A LIVE EDIT, ANIMATED AS AN EDIT.
   *
   * the user: "Editing a file shouldn't show the diff being written in real time it
   * should show that file and then the text as the negative part of the diff is
   * written being deleted … and then of course the replace part writing
   * animation same as when it's writing just in the file wherever it is."
   *
   * So the surface shows the FILE and plays the change into it: settle on the
   * edit site, forward-delete the replaced text, type the replacement from the
   * offset the delete finished at. The text goes through exactly the pipe a
   * streaming write goes through, so both feel like one hand. Takes precedence
   * over {@link diff}.
   */
  editAnim?: EditAnimationSpec;
}

/** Total renderable rows across a diff — the per-delta scroll trigger + the
 * "is there anything to show" gate for the live edit-diff view. */
function diffLineCount(diff: DiffFileData[] | undefined): number {
  return diff ? diff.reduce((n, file) => n + file.lines.length, 0) : 0;
}

/** The +N/−N diff badge shown while a file streams in (corp file tabs). Renders
 * nothing when there is no line delta to report. */
function FileDiffBadge({ added, removed }: { added?: number; removed?: number }) {
  const a = added ?? 0;
  const r = removed ?? 0;
  if (a <= 0 && r <= 0) return null;
  return (
    <div className="pd-file-diff-badge" data-testid="file-diff-badge" aria-hidden="true">
      {a > 0 ? <span className="pd-file-diff-add">+{a}</span> : null}
      {r > 0 ? <span className="pd-file-diff-del">−{r}</span> : null}
    </div>
  );
}

/**
 * FileSurface — a file viewer that reuses the existing renderers: markdown files
 * render as Prose, everything else as the CodeMirror viewer. It accepts STREAMING
 * content — a file tab can open empty and fill incrementally as the model writes
 * it (`controller.updateTab(id, { artifact, streaming })`) — and while
 * `streaming` it sticks to the newest content on each delta only while the user
 * is parked at the bottom (free-scroll). In `raw` view an on-disk file can be
 * made {@link editable} for save-back.
 */
export function FileSurface({
  content,
  filename,
  streaming = false,
  mode,
  showFilename = true,
  onCopy,
  editable = false,
  onSave,
  children,
  className,
  addedLines,
  removedLines,
  diff,
  editAnim,
}: FileSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const view = mode ?? defaultFileViewMode(content);
  // Rendered view for the renderable kinds: markdown → rich prose, html → the
  // sandboxed live frame (same surface + containment as an html artifact tab),
  // svg → the sanitized inline draw. Raw (and every non-renderable kind, e.g. a
  // .ts file) → the CodeMirror source viewer. (the user: html/svg files get the same
  // rendered↔raw toggle markdown already had; images stay always-rendered — they
  // never route here, they open on the media surface.)
  const rendered = view === 'rendered' && isRenderableKind(content.kind);

  // ── The live EDIT ─────────────────────────────────────────────────────────
  // The animation owns the buffer while it plays, so the surface renders the
  // frame's text rather than `content.text`. Two refs are all it needs from the
  // DOM: the outer box (is this laid out at all?) and, once CodeMirror is up,
  // a probe that can say whether a given offset is off screen.
  const offscreenProbe = useRef<((pos: number) => boolean) | null>(null);
  const userScrolled = useRef(false);
  const anim = useEditAnimation(editAnim, {
    hostRef: bodyRef,
    offscreenProbe,
    userScrolledRef: userScrolled,
  });
  const animating = anim?.playing === true;
  /*
   * WHAT TO SHOW WHEN THE MOTION IS OVER.
   *
   * Normally: the tab's own content, which by then is the file re-read from
   * disk — the same bytes the animation landed on, so the hand-over is
   * invisible. But the tool result can lag the motion, and in that window
   * `content.text` is still the file as it was BEFORE the edit. Falling through
   * to it there would undo the edit on screen and then redo it a beat later. So
   * while content is still the pre-edit text, hold the text we animated to.
   */
  const animText =
    anim === null
      ? undefined
      : anim.playing || content.text === editAnim?.plan.baseText
        ? anim.text
        : undefined;
  const shownContent = useMemo(
    () => (animText === undefined ? content : { ...content, text: animText }),
    [content, animText],
  );

  // A diff is now only the FALLBACK for an edit that cannot be animated (see
  // `diff` on the props): no base text to stand it in, or an `old_string` that
  // does not occur. An animation, when there is one, wins.
  const diffLines = diffLineCount(diff);
  const showDiff = diffLines > 0 && editAnim === undefined;

  // While diffing, stick to the newest diff row on each delta; otherwise track the
  // content text (a streaming whole-file write). Same free-scroll rules either way.
  // An edit is the exception: it has its own place to be — the edit site — and
  // being dragged to the bottom of the file mid-delete is exactly the yank the
  // free-scroll rules exist to prevent.
  useStickToBottom(
    bodyRef,
    streaming && !animating,
    showDiff ? diffLines : shownContent.text,
    userScrolled,
  );

  const rootClass = ['pd-file', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass} data-edit-phase={anim?.phase}>
      <FileDiffBadge added={addedLines} removed={removedLines} />
      {showFilename && filename ? <div className="pd-file-name">{filename}</div> : null}
      <div ref={bodyRef} className="pd-file-body">
        {showDiff && diff ? (
          <div className="pd-canvas-diff pd-scroll">
            <DiffView files={diff} />
          </div>
        ) : rendered ? (
          content.kind === 'html' ? (
            <HtmlSurface content={shownContent} streaming={streaming} />
          ) : content.kind === 'svg' ? (
            <SvgSurface content={shownContent} streaming={streaming} />
          ) : (
            <div className="pd-canvas-markdown pd-scroll">
              <Markdown>{shownContent.text}</Markdown>
            </div>
          )
        ) : (
          <CodeSurface
            content={shownContent}
            streaming={streaming || animating}
            onCopy={onCopy}
            // Editing is only meaningful on a static buffer — never mid-write,
            // and never with the buffer moving under the caret.
            editable={editable && !streaming && !animating}
            onSave={onSave}
            caret={anim?.caret}
            followCaret={animating}
            offscreenProbe={offscreenProbe}
          />
        )}
      </div>
      {children}
    </div>
  );
}
