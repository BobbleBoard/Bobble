/**
 * THE PICTURES A CHAIN WORKED WITH — small, beside the chain, and big on request.
 *
 * the user (2026-10-08): "if there's an image/visuals of some sort worked with in
 * the thought/tool chain put on the right side of the chat area but vertically
 * in line with the tool chain a little preview of the image, hovering it shows
 * it a bit bigger and clicking on it shows it, if there's multiple, clicking on
 * it shows it with the others on the left and right" — and "in expanded tools
 * nothing should render at full size right there".
 *
 *  - `ChainThumbs` sits at the right end of the chain's summary row: up to four
 *    previews, the rest as "+N". Hovering one lifts it to a bigger preview.
 *  - `ChainRowThumbs` is what an expanded row shows for the pictures its call
 *    made: small previews, never the full card.
 *  - Either opens `ImageLightbox` (mounted once, App): the picture large on a
 *    dimmed window, the others of the chain a step left or right (‹ ›, the arrow
 *    keys), Esc or a click outside to close.
 */
import { IconChevronLeft, IconChevronRight, IconClose } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
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
  readonly step: (by: 1 | -1) => void;
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  items: [],
  index: 0,
  open: (items, index) => set({ items, index: Math.max(0, Math.min(index, items.length - 1)) }),
  close: () => set({ items: [], index: 0 }),
  step: (by) => {
    const { items, index } = get();
    if (items.length < 2) return;
    set({ index: (index + by + items.length) % items.length });
  },
}));

const MAX_THUMBS = 4;

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
        <button
          key={v.path}
          type="button"
          className="pd-chain-thumb pd-focusable"
          data-testid="chain-thumb"
          aria-label={`Show ${v.name}`}
          title={v.name}
          onClick={() => open(items, i)}
        >
          <img
            src={pdFileUrl(v.path)}
            alt={v.name}
            draggable={false}
            onError={() => setFailed((f) => new Set(f).add(v.path))}
          />
        </button>
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
        <button
          key={v.path}
          type="button"
          className="pd-chain-row-thumb pd-focusable"
          aria-label={`Show ${v.name}`}
          title={v.name}
          onClick={() => {
            const at = all.findIndex((a) => a.path === v.path);
            open(at === -1 ? items : all, at === -1 ? items.indexOf(v) : at);
          }}
        >
          <img src={pdFileUrl(v.path)} alt={v.name} draggable={false} />
        </button>
      ))}
    </div>
  );
}

/** The picture large, the chain's others a step away. Mount once (App). */
export function ImageLightbox(): JSX.Element | null {
  const items = useLightboxStore((s) => s.items);
  const index = useLightboxStore((s) => s.index);
  const close = useLightboxStore((s) => s.close);
  const step = useLightboxStore((s) => s.step);
  const openNow = items.length > 0;

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
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the window
    <div
      className="pd-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      data-testid="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
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
      <img
        key={current.path}
        className="pd-lightbox-img"
        src={pdFileUrl(current.path)}
        alt={current.name}
        data-testid="lightbox-img"
        draggable={false}
      />
      <div className="pd-lightbox-foot">
        <span className="pd-lightbox-name">{current.name}</span>
        {items.length > 1 ? (
          <div className="pd-lightbox-nav">
            <button
              type="button"
              className="pd-lightbox-step pd-focusable"
              aria-label="Previous picture"
              data-testid="lightbox-prev"
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
