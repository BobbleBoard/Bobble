/**
 * THE PICTURES A CHAIN WORKED WITH — small, beside the chain, and big on request.
 *
 * The user (2026-10-08): "if there's an image/visuals of some sort worked with in
 * the thought/tool chain put on the right side of the chat area but vertically
 * in line with the tool chain a little preview of the image, hovering it shows
 * it a bit bigger and clicking on it shows it, if there's multiple, clicking on
 * it shows it with the others on the left and right" — and "in expanded tools
 * nothing should render at full size right there". Then, the same day: "hover
 * should show a larger version like shown in the image [the Claude app's
 * preview card] … the image to the left and right on the left and right greyed
 * out and cut off, just a sliver so you can click on it (hover, slight
 * highlight, click, scrolls to it as if you clicked the relevant arrow button)".
 *
 *  - `ChainThumbs` sits at the right end of the chain's summary row: up to four
 *    previews, the rest as "+N". `ChainRowThumbs` is what an expanded row shows
 *    for the pictures its call made: small previews, never the full card.
 *  - Hovering either opens `HoverPreview`: the picture large in a floating card
 *    under the thumbnail, right edges aligned, flipped above when there is no
 *    room below.
 *  - A click opens `ImageLightbox` (mounted once, App): a track with the picture
 *    in the middle and its neighbours peeking in at the window's edges, greyed
 *    and cut off. A sliver lifts under the pointer and, clicked, slides to the
 *    middle — the same move as ‹ › and the arrow keys. Esc or a click on the
 *    dim closes it.
 */
import { IconChevronLeft, IconChevronRight, IconClose } from '@pi-desktop/ui';
import {
  type FocusEvent,
  type JSX,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { pdFileUrl } from './canvas/file-preview';

export interface ChainVisual {
  /** Absolute path of the picture. */
  readonly path: string;
  /** Its file name, for the caption and the alt text. */
  readonly name: string;
}

/** Files a chain can show as a picture. */
export const VISUAL_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;

interface LightboxState {
  readonly items: readonly ChainVisual[];
  readonly index: number;
  readonly open: (items: readonly ChainVisual[], index: number) => void;
  readonly close: () => void;
  /** One picture along. Stops at either end: the track does not wrap. */
  readonly step: (by: 1 | -1) => void;
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  items: [],
  index: 0,
  open: (items, index) => set({ items, index: Math.max(0, Math.min(index, items.length - 1)) }),
  close: () => set({ items: [], index: 0 }),
  step: (by) => {
    const { items, index } = get();
    const next = index + by;
    if (next < 0 || next >= items.length) return;
    set({ index: next });
  },
}));

// ── Hover preview ─────────────────────────────────────────────────────────────

interface Hovered {
  readonly visual: ChainVisual;
  /** The thumbnail's box, in window coordinates. */
  readonly anchor: DOMRect;
  /** The picture's own size, read off the thumbnail's loaded image. */
  readonly natural: { readonly w: number; readonly h: number } | null;
}

interface HoverState {
  readonly hovered: Hovered | null;
  readonly show: (h: Hovered) => void;
  readonly hide: () => void;
}

const useHoverStore = create<HoverState>((set) => ({
  hovered: null,
  show: (hovered) => set({ hovered }),
  hide: () => set({ hovered: null }),
}));

/** How long the pointer rests on a thumbnail before the preview opens. */
const HOVER_IN_MS = 140;
/** How long a preview outlives the pointer leaving, so the next thumbnail can take it over. */
const HOVER_OUT_MS = 90;
/** The pending close, shared: leaving one thumbnail and entering the next is one gesture. */
let closing = 0;

/**
 * Pointer and focus handlers for one thumbnail. Moving from one thumbnail to
 * the next swaps the preview at once (no second wait); leaving closes it.
 */
function useHoverHandlers(visual: ChainVisual) {
  const timer = useRef(0);
  const show = useHoverStore((s) => s.show);
  const hide = useHoverStore((s) => s.hide);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const enter = useCallback(
    (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const img = el.querySelector('img');
      const natural =
        img !== null && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
      const open = () => show({ visual, anchor: el.getBoundingClientRect(), natural });
      window.clearTimeout(timer.current);
      window.clearTimeout(closing);
      if (useHoverStore.getState().hovered !== null) open();
      else timer.current = window.setTimeout(open, HOVER_IN_MS);
    },
    [show, visual],
  );
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(closing);
    closing = window.setTimeout(hide, HOVER_OUT_MS);
  }, [hide]);
  const leaveNow = useCallback(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(closing);
    hide();
  }, [hide]);
  return {
    onMouseEnter: enter,
    onMouseLeave: leave,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) enter(e);
    },
    onBlur: leave,
    leave: leaveNow,
  };
}

/** The biggest a hover preview gets. */
const PREVIEW_MAX = { w: 520, h: 380 };
const EDGE = 12;
const GAP = 8;

/** The hovered thumbnail's picture, large, in a card beside it. Mount once (App). */
export function HoverPreview(): JSX.Element | null {
  const hovered = useHoverStore((s) => s.hovered);
  const hide = useHoverStore((s) => s.hide);
  const lightboxOpen = useLightboxStore((s) => s.items.length > 0);
  // The card is placed from the thumbnail's box; a scroll moves the box.
  useEffect(() => {
    if (hovered === null) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [hovered, hide]);
  if (hovered === null || lightboxOpen) return null;
  const { visual, anchor, natural } = hovered;
  const aspect = natural === null ? 4 / 3 : natural.w / natural.h;
  const maxW = Math.min(PREVIEW_MAX.w, window.innerWidth - EDGE * 2);
  let w = maxW;
  let h = w / aspect;
  if (h > PREVIEW_MAX.h) {
    h = PREVIEW_MAX.h;
    w = h * aspect;
  }
  // Never larger than the picture itself.
  if (natural !== null && natural.w < w) {
    w = natural.w;
    h = natural.h;
  }
  const left = Math.max(EDGE, Math.min(anchor.right - w, window.innerWidth - EDGE - w));
  const below = anchor.bottom + GAP;
  const top = below + h <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - h);
  return createPortal(
    <div
      className="pd-chain-preview"
      data-testid="chain-hover-preview"
      data-side={top === below ? 'below' : 'above'}
      style={{ left, top, width: w, height: h }}
      aria-hidden="true"
    >
      <img src={pdFileUrl(visual.path)} alt="" draggable={false} />
    </div>,
    document.body,
  );
}

// ── Thumbnails ────────────────────────────────────────────────────────────────

const MAX_THUMBS = 4;

function Thumb({
  visual,
  className,
  onOpen,
  onError,
}: {
  visual: ChainVisual;
  className: string;
  onOpen: () => void;
  onError?: () => void;
}): JSX.Element {
  const { leave, ...hover } = useHoverHandlers(visual);
  return (
    <button
      type="button"
      className={`${className} pd-focusable`}
      data-testid={className === 'pd-chain-thumb' ? 'chain-thumb' : 'chain-row-thumb'}
      aria-label={`Show ${visual.name}`}
      title={visual.name}
      {...hover}
      onClick={() => {
        leave();
        onOpen();
      }}
    >
      <img
        src={pdFileUrl(visual.path)}
        alt={visual.name}
        draggable={false}
        {...(onError !== undefined ? { onError } : {})}
      />
    </button>
  );
}

/** The chain's pictures, small, at the right of its summary row. */
export function ChainThumbs({ items: all }: { items: readonly ChainVisual[] }): JSX.Element | null {
  const open = useLightboxStore((s) => s.open);
  // A picture that will not load (moved, deleted) is left out, not drawn broken.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const items = all.filter((v) => !failed.has(v.path));
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_THUMBS);
  const more = items.length - shown.length;
  return (
    <div className="pd-chain-thumbs" data-testid="chain-thumbs">
      {shown.map((v, i) => (
        <Thumb
          key={v.path}
          visual={v}
          className="pd-chain-thumb"
          onOpen={() => open(items, i)}
          onError={() => setFailed((f) => new Set(f).add(v.path))}
        />
      ))}
      {more > 0 ? (
        <button
          type="button"
          className="pd-chain-thumb pd-chain-thumb--more pd-focusable"
          aria-label={`Show all ${items.length} pictures`}
          onClick={() => open(items, MAX_THUMBS)}
        >
          +{more}
        </button>
      ) : null}
    </div>
  );
}

/** What an expanded row shows for the pictures its call made — small, never full size. */
export function ChainRowThumbs({
  items,
  all,
}: {
  items: readonly ChainVisual[];
  /** Every picture of the chain, so the lightbox can step through them all. */
  all: readonly ChainVisual[];
}): JSX.Element | null {
  const open = useLightboxStore((s) => s.open);
  if (items.length === 0) return null;
  return (
    <div className="pd-chain-row-thumbs" data-testid="chain-row-thumbs">
      {items.map((v) => (
        <Thumb
          key={v.path}
          visual={v}
          className="pd-chain-row-thumb"
          onOpen={() => {
            const at = all.findIndex((a) => a.path === v.path);
            open(at === -1 ? items : all, at === -1 ? items.indexOf(v) : at);
          }}
        />
      ))}
    </div>
  );
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

/** How much of a neighbour shows at the window's edge. */
const SLIVER = 64;
/** Room kept between the picture and a sliver. */
const SLIVER_GAP = 28;
/** Height kept for the close button above and the foot below. */
const CHROME_H = 140;

interface Size {
  readonly w: number;
  readonly h: number;
}

/** A picture fitted into the stage, never enlarged past its own size. */
function fitSize(natural: Size | undefined, maxW: number, maxH: number): Size {
  const n = natural ?? { w: maxH, h: maxH };
  const scale = Math.min(1, maxW / n.w, maxH / n.h);
  return { w: n.w * scale, h: n.h * scale };
}

/**
 * Where a picture's centre sits, from the window's centre, for its place along
 * the track: the current one in the middle, each neighbour pushed out until
 * only a sliver of it is left on screen, the rest beyond the edge.
 */
function slotX(slot: number, size: Size, vw: number): number {
  if (slot === 0) return 0;
  const side = Math.sign(slot);
  if (Math.abs(slot) === 1) return side * (vw / 2 - SLIVER + size.w / 2);
  return side * (vw / 2 + size.w / 2 + 40);
}

function useViewport(): Size {
  const [vp, setVp] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

/** The picture large, the chain's others peeking in at the edges. Mount once (App). */
export function ImageLightbox(): JSX.Element | null {
  const items = useLightboxStore((s) => s.items);
  const index = useLightboxStore((s) => s.index);
  const close = useLightboxStore((s) => s.close);
  const step = useLightboxStore((s) => s.step);
  const openNow = items.length > 0;
  const vp = useViewport();
  const [sizes, setSizes] = useState<Readonly<Record<string, Size>>>({});

  useEffect(() => {
    if (!openNow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openNow, close, step]);

  const current = items[index];
  if (!openNow || current === undefined) return null;
  // The stage: the window less the slivers either side and the chrome.
  const maxW = Math.max(160, vp.w - 2 * (SLIVER + SLIVER_GAP));
  const maxH = Math.max(160, vp.h - CHROME_H);
  const onLoad = (path: string) => (e: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w > 0 && sizes[path]?.w !== w) setSizes((s) => ({ ...s, [path]: { w, h } }));
  };
  // The current picture and two either side: enough for a step to slide in.
  const shown = items
    .map((v, i) => ({ v, slot: i - index }))
    .filter(({ slot }) => Math.abs(slot) <= 2);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the window
    <div
      className="pd-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      data-testid="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.dim === 'true')
          close();
      }}
    >
      <button
        type="button"
        className="pd-lightbox-close pd-focusable"
        aria-label="Close"
        data-testid="lightbox-close"
        onClick={close}
      >
        <IconClose size={18} />
      </button>
      <div className="pd-lightbox-track" data-dim="true">
        {shown.map(({ v, slot }) => {
          const size = fitSize(sizes[v.path], maxW, maxH);
          const x = slotX(slot, size, vp.w);
          const style = {
            width: size.w,
            height: size.h,
            transform: `translate(-50%, -50%) translateX(${x}px)`,
          };
          const near = Math.abs(slot) === 1;
          // One element in every slot, so a step slides the same node across
          // rather than swapping it for another; a neighbour within reach gets
          // a button laid over it.
          return (
            <div
              key={v.path}
              className={`pd-lightbox-slide${slot === 0 ? ' pd-lightbox-current' : ' pd-lightbox-peek'}`}
              data-slot={slot}
              data-testid={slot === 0 ? 'lightbox-current' : undefined}
              aria-hidden={slot !== 0 && !near ? true : undefined}
              style={style}
            >
              <img
                className={slot === 0 ? 'pd-lightbox-img' : undefined}
                src={pdFileUrl(v.path)}
                alt={slot === 0 ? v.name : ''}
                data-testid={slot === 0 ? 'lightbox-img' : undefined}
                draggable={false}
                onLoad={onLoad(v.path)}
              />
              {near ? (
                <button
                  type="button"
                  className="pd-lightbox-peek-hit"
                  data-testid={slot < 0 ? 'lightbox-peek-prev' : 'lightbox-peek-next'}
                  aria-label={`${slot < 0 ? 'Previous' : 'Next'} picture: ${v.name}`}
                  onClick={() => step(slot < 0 ? -1 : 1)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="pd-lightbox-foot">
        <span className="pd-lightbox-name">{current.name}</span>
        {items.length > 1 ? (
          <div className="pd-lightbox-nav">
            <button
              type="button"
              className="pd-lightbox-step pd-focusable"
              aria-label="Previous picture"
              data-testid="lightbox-prev"
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              <IconChevronLeft size={18} />
            </button>
            <span className="pd-lightbox-count" data-testid="lightbox-count">
              {index + 1} of {items.length}
            </span>
            <button
              type="button"
              className="pd-lightbox-step pd-focusable"
              aria-label="Next picture"
              data-testid="lightbox-next"
              disabled={index === items.length - 1}
              onClick={() => step(1)}
            >
              <IconChevronRight size={18} />
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
