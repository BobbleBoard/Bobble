/**
 * ONE WAY TO OPEN A PICTURE, wherever it is drawn.
 *
 * the user (2026-09-24): "images clicked on/fullscreened should have the new studio
 * like ui with the left toolbar and such and a centered bottom 'edit image'
 * input bar aswell." The image viewer (ImageViewer.tsx) is that room, and it
 * works on a FILE: Copy, Export, Show in Finder and Edit all need a path. A
 * generated card always had one. A picture in your own message had only pixels
 * (a data URL), so it opened in the old plain overlay — and so did the picture
 * chip in the composer, and a picture in a reply opened on the canvas.
 *
 * {@link viewablePath} finds the file: the picture's own, when the message
 * named it (main hands that one file to pd-file://, which otherwise serves only
 * the app's folders), else its pixels saved once under ~/Bobble/attachments by
 * content hash — so an old message opened twice is still one file.
 */

import { type ReactNode, useCallback, useState } from 'react';
import type { ThreadMediaItem } from '../chat/thread-media';
import { lazyRoute } from '../RouteBoundary';

/*
 * Lazy, because it brings the 3D studio's stylesheet for the rail and the
 * History card, and a transcript of six pictures should not pay for that until
 * one is opened. Every surface opens this one.
 */
export const ImageViewer = lazyRoute('Image viewer', () => import('./ImageViewer'), {
  pick: (m) => m.ImageViewer,
  variant: 'inline',
});

/** Where a picture's pixels are known to be: its path, its data URL, or both. */
export interface PictureSource {
  readonly path?: string;
  readonly dataUrl?: string;
}

/** Pixels already saved this session → the file they were saved as. */
const savedFor = new Map<string, string>();

/**
 * The file to open a picture from, or null when there is none to be had.
 *
 * The path first and on its own: when the file is still there, sending its
 * pixels across would only be thrown away. Only if it is gone (or was never
 * named) do the pixels go, to be written once.
 */
export async function viewablePath(source: PictureSource): Promise<string | null> {
  const ask = (req: { path?: string; dataUrl?: string }) =>
    window.piDesktop.invoke('attachments:view-image', req).catch(() => ({
      ok: false as const,
      path: undefined,
    }));
  if (source.path !== undefined && source.path !== '') {
    const own = await ask({ path: source.path });
    if (own.ok && own.path !== undefined) return own.path;
  }
  const url = source.dataUrl;
  if (url === undefined || !url.startsWith('data:image/')) return null;
  const known = savedFor.get(url);
  if (known !== undefined) return known;
  const saved = await ask({ dataUrl: url });
  if (!saved.ok || saved.path === undefined) return null;
  savedFor.set(url, saved.path);
  return saved.path;
}

/**
 * Open pictures in the viewer from a component: `open` finds the file and
 * mounts the viewer on it, resolving false when there was no file to be had
 * (the caller keeps whatever it did before); `viewer` is what to render.
 */
export function usePictureViewer(): {
  open: (source: PictureSource, name: string) => Promise<boolean>;
  viewer: ReactNode;
} {
  const [item, setItem] = useState<ThreadMediaItem | null>(null);
  const open = useCallback(async (source: PictureSource, name: string): Promise<boolean> => {
    const path = await viewablePath(source);
    if (path === null) return false;
    setItem({ path, kind: 'image', name });
    return true;
  }, []);
  const close = useCallback(() => setItem(null), []);
  return { open, viewer: item !== null ? <ImageViewer item={item} onClose={close} /> : null };
}
