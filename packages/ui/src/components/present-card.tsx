import { fileTypeOf } from './file-type.ts';
import { FileTypeGlyph } from './file-type-glyph.tsx';
import { OpenSplitButton, type OpenWithChoice } from './open-split-button.tsx';
/**
 * The card `present` puts in the thread: here is the finished thing.
 *
 * Modelled on the reference the user gave — an icon tile, the artefact's name, a
 * quiet `Kind · EXT` line under it, and the action on the right. The reference
 * is a DOWNLOAD list; ours is not, because the file is already on this machine.
 * The useful verbs here are OPEN (in the canvas, beside the conversation, where
 * a page renders and a game runs) and REVEAL (in Finder), so those are the
 * actions and Open is the primary one.
 *
 * One row per artefact, and the row itself is the open affordance — the same
 * shape as the web-search result rows, which is the pattern this app already
 * teaches people.
 */

import clsx from 'clsx';
import { forwardRef, type HTMLAttributes } from 'react';

/** What kind of thing was presented — drives the glyph and the `Kind · EXT` line. */
export type PresentKind =
  | 'image'
  | 'page'
  | 'code'
  | 'document'
  | 'project'
  | 'media'
  | 'file'
  // A data visual: the thread renders its interactive card; a plain row is
  // the fallback when the card cannot.
  | 'chart';

export interface PresentedItem {
  /** Absolute path — the identity, and the tooltip. */
  path: string;
  /** Display name; defaults to the basename of `path`. */
  name?: string;
  kind: PresentKind;
  /** One line from the model about what this is. */
  note?: string;
  /** A thumbnail (data URI) when we have one — an image, a rendered page. */
  thumbnailUrl?: string;
  /* The applications that can open this artefact — the same data the canvas
   * operation bar uses, so the card's Open control offers the same choices.
   * Absent → the button still opens with the OS default and shows no caret. */
  defaultApp?: OpenWithChoice;
  openApps?: readonly OpenWithChoice[];
}

const KIND_LABEL: Record<PresentKind, string> = {
  image: 'Image',
  page: 'Page',
  code: 'Code',
  document: 'Document',
  project: 'Project',
  media: 'Media',
  file: 'File',
  chart: 'Chart',
};

/** Every application that can open it, the OS default first. */
export function openWithApps(item: PresentedItem): OpenWithChoice[] {
  const apps = [...(item.openApps ?? [])];
  const def = item.defaultApp;
  if (def === undefined) return apps;
  return [def, ...apps.filter((a) => a.id !== def.id)];
}

/** basename without assuming a platform separator. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * `Slides · PPTX` — the second line, from the file's own identity.
 *
 * The family's word rather than the coarse present-kind: "File · PPTX" said
 * nothing the extension did not; "Slides · PPTX" is what a person calls it.
 * A project (no extension) keeps the present-kind's word.
 */
export function kindLine(item: PresentedItem): string {
  const base = baseName(item.path);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toUpperCase() : '';
  if (ext === '') return KIND_LABEL[item.kind];
  const type = fileTypeOf(item.path, { folder: item.kind === 'project' });
  const label = type.family === 'file' ? KIND_LABEL[item.kind] : type.label;
  return `${label} · ${ext}`;
}

/*
 * The folder on the "Show" button — it reveals the artefact in the OS file
 * manager, and the word alone did not say that ("Reveal" said even less).
 * Inline for the same reason as the kind glyphs: the card carries no icon
 * dependency.
 */
function FolderGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pd-icon"
      aria-hidden="true"
    >
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.4 1.5h5.3A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

export interface PresentCardProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  item: PresentedItem;
  /**
   * The Open button — the canvas, beside the conversation. the user: "by default it
   * opens in the canvas or it should". The same thing the card body does.
   */
  onOpen?: (item: PresentedItem) => void;
  /** Show it in Finder. Secondary. */
  onReveal?: (item: PresentedItem) => void;
  /** An application chosen from the "Open with" dropdown. */
  onOpenWith?: (item: PresentedItem, appId: string) => void;
  /** The card BODY was clicked — bring the artefact into the canvas. */
  onActivate?: (item: PresentedItem) => void;
}

/**
 * One presented artefact.
 *
 * The whole row is the Open affordance so the target is large and obvious;
 * Reveal is a separate, quieter button beside it. `title` carries the full path,
 * because the name alone is not enough to know WHICH file this is.
 */
export const PresentCard = forwardRef<HTMLDivElement, PresentCardProps>(function PresentCard(
  { item, onActivate, onOpen, onOpenWith, onReveal, className, ...rest },
  ref,
) {
  const name = item.name ?? baseName(item.path);
  const type = fileTypeOf(item.path, { folder: item.kind === 'project' });
  return (
    <div ref={ref} className={clsx('pd-present-card', className)} {...rest}>
      {/*
       * the user: "clicking anywhere on the card besides the 'open' button [should]
       * open it in canvas ... it wouldn't make sense for the open button to open
       * in canvas because this button is the same one shown when something IS
       * open in canvas."
       *
       * So the two are deliberately different verbs and must not share a
       * handler: the BODY brings the artefact into the canvas, the split button
       * hands it to an application.
       */}
      <button
        type="button"
        className="pd-present-main pd-focusable"
        title={item.path}
        onClick={onActivate === undefined ? undefined : () => onActivate(item)}
      >
        {/*
         * THE TILE IS THE FILE'S COLOUR. the user: "more color and unique icons
         * for file types, not just the generic and not anything that just has
         * the generic with 'pptx' under it." A deck is vermilion with a chart,
         * a document blue with lines, a sheet green with a grid — read before
         * the name is, the way every file browser does it.
         */}
        <span
          className="pd-present-thumb"
          data-family={type.family}
          /* The glyph is white on every tile, whatever the flavour's on-accent
           * colour is — these are the file's colours, not the theme's. */
          style={
            item.thumbnailUrl === undefined ? { background: type.color, color: '#fff' } : undefined
          }
          aria-hidden
        >
          {item.thumbnailUrl !== undefined ? (
            <img className="pd-present-thumb-img" src={item.thumbnailUrl} alt="" />
          ) : (
            <FileTypeGlyph family={type.family} />
          )}
        </span>
        <span className="pd-present-text">
          <span className="pd-present-name">{name}</span>
          {/*
           * The note shares the meta LINE rather than adding a third one. With
           * it stacked, a list of four artefacts rendered at three different
           * heights and read as ragged — the reference is uniform, and uniform
           * is what makes a list scannable. Two lines, always.
           */}
          <span className="pd-present-meta">
            {kindLine(item)}
            {item.note !== undefined && item.note !== '' ? (
              <span className="pd-present-note"> · {item.note}</span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="pd-present-actions">
        {onReveal !== undefined ? (
          <button
            type="button"
            className="pd-present-action pd-focusable"
            onClick={() => onReveal(item)}
          >
            <FolderGlyph />
            Show
          </button>
        ) : null}
        {/*
         * the user: "I want it to just be a rounded corner open button that has the
         * same thing as the 'open' button inside the canvas when you have a file
         * open. with the little dropdown also." Literally the same component the
         * canvas operation bar renders — not a lookalike.
         *
         * Then: "open could be blue also that open should have a dropdown
         * that's open with (because by default it opens in the canvas or it
         * should)." So here the primary segment is the accent colour and opens
         * the canvas; every application — the OS default included — lives in
         * the "Open with" dropdown.
         */}
        {onOpen !== undefined ? (
          <OpenSplitButton
            tone="primary"
            menuHeading="Open with"
            apps={openWithApps(item)}
            onOpen={() => onOpen(item)}
            {...(onOpenWith !== undefined
              ? { onOpenWith: (appId: string) => onOpenWith(item, appId) }
              : {})}
          />
        ) : null}
      </div>
    </div>
  );
});
