/**
 * THE RETURN TRIP: a result going back to the conversation.
 *
 * "Open in studio" carries media OUT of the chat. Nothing carried it back, so a
 * picture you made in the Image studio and wanted to ask a question about had
 * to be found in Finder and dragged onto the window — leaving the app to get
 * something from the app.
 *
 * ## Two behaviours, because there are two kinds of file
 *
 * A picture the model can actually SEE becomes an image attachment: the same
 * object a drop makes, drained by the composer through the same store, so it
 * chips up in the composer and feeds attachment prefill exactly as a dropped
 * PNG would.
 *
 * A clip, a sound or a mesh cannot be seen by any local chat model we ship.
 * What the model CAN do with those is operate on them with tools — so the path
 * goes into the composer instead, ready for "trim this to ten seconds" or
 * "what's the poly count here". Naming the file honestly beats pretending it
 * was understood.
 */
import { pdFileUrl } from '../chat/canvas/file-preview';
import { useDropStore } from '../chat/composer/drop-store';
import { withPath } from '../chat/composer/file-paths';
import type { MediaKind } from '../chat/thread-media';
import { exitModality } from '../state/modality-store';
import { usePiStore } from '../state/pi-slice';

/** Best-effort MIME from the extension — `File` needs one to be recognised as
 * an image, and a blob fetched from `pd-file://` may arrive as octet-stream. */
function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

export interface SendToChatItem {
  readonly path: string;
  readonly name: string;
  readonly kind: MediaKind;
}

/**
 * Hand a result to the conversation and go there.
 *
 * BOTH cases hand the media over BEFORE changing the view, for the same reason:
 * the receiving end drains what is waiting for it when it mounts, so anything
 * pushed after the change races a composer that has already read. The image
 * case additionally does its fetch first, so a view change never turns out to
 * carry nothing.
 *
 * Returns whether the media went as an attachment (an image the model can see)
 * or as a path (everything else — see the file header).
 */
export async function sendToChat(item: SendToChatItem): Promise<'attached' | 'path'> {
  if (item.kind === 'image') {
    try {
      const res = await fetch(pdFileUrl(item.path));
      if (res.ok) {
        const blob = await res.blob();
        /* The picture IS a file already: the composer attaches it by that path
           (file-paths.ts) rather than saving its pixels a second time. */
        const file = withPath(new File([blob], item.name, { type: mimeOf(item.name) }), item.path);
        useDropStore.getState().push([file]);
        exitModality();
        return 'attached';
      }
    } catch {
      /* Falls through to the path, which always works and says something true. */
    }
  }
  /*
   * `composerText` is the app's existing hand-off channel into the editor — the
   * same one a message's Edit action and pi's own `setComposerText` use. The
   * composer drains it on mount and clears it, so it is set BEFORE the view
   * changes: setting it after would race a composer that has already read.
   */
  usePiStore.setState({ composerText: `${item.path} ` });
  exitModality();
  return 'path';
}
