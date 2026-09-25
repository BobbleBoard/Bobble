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
 */
import { Markdown as UiMarkdown, widenUrlTransform } from '@pi-desktop/ui';
import type { ComponentPropsWithoutRef } from 'react';
import { usePiStore } from '../state/pi-slice';
import { pdFileUrl } from './canvas/file-preview';
import { CITATION_COMPONENTS, useCitationRehype } from './sources/citation-markdown';

/** Kept by the sanitiser so the image component below can see them. */
const URL_TRANSFORM = widenUrlTransform(/^(?:pd-file:|file:)/i);

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
  const local =
    typeof src === 'string' && !src.startsWith('pd-file:') ? localImagePath(src, cwd) : null;
  const resolved = local === null ? src : pdFileUrl(local);
  const img = <img {...rest} src={resolved} alt={alt ?? ''} className="pd-md-image" />;
  if (local === null) return img;
  const open = () => {
    void Promise.all([import('../state/canvas-store'), import('./canvas/file-tabs')]).then(
      ([canvas, tabs]) => tabs.openFileInCanvas(canvas.getCanvasController() as never, local, cwd),
    );
  };
  /* A button, not an onClick on the img: it is an action (open on the canvas),
     so it is reachable from the keyboard and announced as one. */
  return (
    <button
      type="button"
      className="pd-md-image-open"
      onClick={open}
      title="Open on the canvas"
      data-local-path={local}
    >
      {img}
    </button>
  );
}

/* Links to the turn's sources become citation chips (./sources). */
const COMPONENTS = { img: LocalImage, ...CITATION_COMPONENTS };

export function Markdown({ text }: { text: string }) {
  const rehypePlugins = useCitationRehype();
  return (
    <UiMarkdown components={COMPONENTS} urlTransform={URL_TRANSFORM} rehypePlugins={rehypePlugins}>
      {text}
    </UiMarkdown>
  );
}
