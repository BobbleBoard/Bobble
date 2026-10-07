/**
 * Assistant text runs render through the design-system `Markdown` (round-3 #A13):
 * react-markdown + remark-gfm + remark-math + rehype-katex, with hex swatches,
 * boxed inline code/paths, and fenced code delegated to the shared CodeBlock.
 *
 * `segmentGroup`/`segmentMessageText` peel out the artifact fences (```svg /
 * ```html) BEFORE this renders, so each call receives one plain markdown string
 * (regular code fences still land here and box correctly). The UI `Markdown`
 * renders its OWN `.pd-prose` container — it is NOT wrapped in `<Prose>`.
 *
 * LOCAL IMAGES. A model that has just made a picture writes
 * `![Red Heart](/Users/…/generated/…/01.svg)` — every one of them does — and
 * the design-system renderer, which knows nothing of this machine, drew a
 * broken-image glyph with the alt text beside it (SEEN on the first OmniSVG
 * run). The file is right there: an absolute path, a `file://` URL or a path
 * relative to the session's folder becomes the app's `pd-file://` URL, which
 * main serves fenced to the app's own roots, so the picture shows in the reply
 * and a click opens it on the canvas like any other file.
 *
 * A PICTURE OPENS IN THE IMAGE VIEWER, like a picture anywhere else in the app
 * (the user, 2026-09-24: "images clicked on/fullscreened should have the new studio
 * like ui") — by its path or by its `pd-file://` URL alike. An SVG still opens
 * on the canvas, whose source/rendered toggle is the right room for a drawing
 * made of text; so does anything the viewer cannot open. A remote http(s)
 * picture never gets this far: the renderer's CSP (vite.config.ts `img-src`)
 * refuses it, so there is nothing drawn to open.
 */
import { Markdown as UiMarkdown, widenUrlTransform } from '@pi-desktop/ui';
import { type ComponentPropsWithoutRef, createContext, useContext } from 'react';
import { usePictureViewer } from '../media/picture-viewer';
import { usePiStore } from '../state/pi-slice';
import { baseName } from './attached-files';
import { pdFileUrl } from './canvas/file-preview';
import { CITATION_COMPONENTS, useCitationRehype } from './sources/citation-markdown';
import { pdFilePath } from './thread-media';

/** What the image viewer opens (the pictures pd-file:// serves as pictures). */
const RASTER = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

/** Kept by the sanitiser so the image component below can see them. */
const URL_TRANSFORM = widenUrlTransform(/^(?:pd-file:|file:)/i);

/**
 * THE FILES THIS TURN ALREADY SHOWS AS CARDS, outside its chain.
 *
 * The prompt tells the model to `present` what it makes — its card, full size,
 * beneath the chain — and a model that has just made a picture also writes it
 * into its reply (see the header): the answer showed the same picture twice,
 * one above the other (STATUS, from the thread track). The card is the fuller
 * of the two (full size, its controls), so the reply's copy of a file the turn
 * presented is not drawn again. AssistantGroup provides the set; a picture the
 * turn did not present keeps the reply's copy, which is then the only one.
 */
export const TurnCardsContext = createContext<ReadonlySet<string>>(new Set());

/** The absolute path a markdown image source names on this machine, or null. */
export function localImagePath(src: string, cwd: string | undefined): string | null {
  const s = src.trim();
  if (/^file:\/\//i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null; // a real URL
  if (s.startsWith('/')) return s;
  if (cwd !== undefined && s !== '' && !s.startsWith('#')) {
    return `${cwd.replace(/\/+$/, '')}/${s.replace(/^\.\//, '')}`;
  }
  return null;
}

function LocalImage({
  src,
  alt,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);
  const { open: openPicture, viewer } = usePictureViewer();
  const shownAsCard = useContext(TurnCardsContext);
  const served = typeof src === 'string' && src.startsWith('pd-file:');
  const local =
    typeof src === 'string'
      ? served
        ? (pdFilePath(src) ?? null)
        : localImagePath(src, cwd)
      : null;
  if (local !== null && shownAsCard.has(local)) return null;
  const resolved = local === null || served ? src : pdFileUrl(local);
  const img = <img {...rest} src={resolved} alt={alt ?? ''} className="pd-md-image" />;
  if (local === null) return img;
  const onCanvas = () => {
    void Promise.all([import('../state/canvas-store'), import('./canvas/file-tabs')]).then(
      ([canvas, tabs]) => tabs.openFileInCanvas(canvas.getCanvasController() as never, local, cwd),
    );
  };
  const inViewer = RASTER.test(local);
  const open = () => {
    if (!inViewer) {
      onCanvas();
      return;
    }
    void openPicture({ path: local }, baseName(local)).then((opened) => {
      if (!opened) onCanvas();
    });
  };
  /* A button, not an onClick on the img: it is an action (open the picture),
     so it is reachable from the keyboard and announced as one. */
  return (
    <>
      <button
        type="button"
        className="pd-md-image-open"
        onClick={open}
        title={inViewer ? 'Open' : 'Open on the canvas'}
        data-local-path={local}
      >
        {img}
      </button>
      {viewer}
    </>
  );
}

/* Links to the turn's sources become citation chips (./sources). */
const COMPONENTS = { img: LocalImage, ...CITATION_COMPONENTS };

/** `streaming`: this is the text still being written (see the UI Markdown's prop). */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const rehypePlugins = useCitationRehype();
  return (
    <UiMarkdown
      components={COMPONENTS}
      urlTransform={URL_TRANSFORM}
      rehypePlugins={rehypePlugins}
      streaming={streaming}
    >
      {text}
    </UiMarkdown>
  );
}
