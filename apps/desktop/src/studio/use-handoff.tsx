import { IconClose } from '@pi-desktop/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { pdFileUrl } from '../chat/canvas/file-preview';
import type { MediaKind } from '../chat/thread-media';
import { type StudioHandoff, type StudioTarget, useStudioHandoff } from '../state/studio-handoff';

/**
 * What a room will take off the desktop.
 *
 * Deliberately narrower than "anything the OS calls an image": these are the
 * containers the generation engines actually read, and a file that is refused
 * at the drop is far kinder than one accepted here and rejected forty seconds
 * into a run. Kept beside the room that uses it rather than in a shared media
 * module, because it is a statement about the ENGINES, not about the app's
 * ability to display something.
 */
const ACCEPTS: Record<StudioTarget, { readonly kind: MediaKind; readonly ext: readonly string[] }> =
  {
    image: { kind: 'image', ext: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff'] },
    video: { kind: 'video', ext: ['mp4', 'mov', 'webm', 'm4v'] },
    audio: { kind: 'audio', ext: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac'] },
    '3d': { kind: 'model', ext: ['glb', 'gltf', 'obj', 'stl'] },
  };

/** True when this room can work from that file. */
export function studioAccepts(target: StudioTarget, name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ACCEPTS[target].ext.includes(ext);
}

/**
 * RECEIVING MEDIA, from wherever it came.
 *
 * Three routes end here and they are the same arrival: a card in the transcript
 * pressed "Open in studio", a file was dropped on the room, or the room was
 * opened with something already waiting for it. The user, round 2: "all types of
 * media handoff into studios and editing."
 *
 * The hook owns the whole arrival:
 *
 *   - takes the pending handoff ONCE on mount (see the store's `take`) so
 *     returning to a room later does not silently reload what you were handed
 *     twenty minutes ago, discarding whatever you did in between;
 *   - seeds the composer with the prompt that made it, because "again, but at
 *     sunset" is the actual reason anyone opens a result in a studio, and
 *     retyping the sentence is the whole friction;
 *   - renders the card that says what the run is working from, with a way to
 *     drop it — an input you cannot remove is a mode you cannot leave.
 */
export function useStudioInput(
  target: StudioTarget,
  onPrompt?: (prompt: string) => void,
): {
  readonly input: StudioHandoff | null;
  readonly clear: () => void;
  readonly card: ReactNode;
  /**
   * Take a dropped file as this room's input. Returns false when nothing in the
   * drop was usable, so the shell can say so instead of swallowing it.
   */
  readonly acceptFiles: (files: readonly File[]) => boolean;
} {
  const [input, setInput] = useState<StudioHandoff | null>(null);

  /*
   * SUBSCRIBED, not read once on mount.
   *
   * Mount is one moment an offer can arrive — walking in from the transcript —
   * but not the only one: a result card inside this very room offers itself
   * back as the next input, which IS the iterate loop ("that, but at sunset",
   * then again, then again) and happens with the room already open. A mount-only
   * read made the second click of that loop do nothing at all.
   *
   * `take` still clears, so the "consumed exactly once" guarantee is unchanged:
   * leaving and returning shows what you left rather than silently reloading
   * something you were handed twenty minutes ago.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: onPrompt is a seed for each arrival, not a subscription
  useEffect(() => {
    const consume = (): void => {
      const media = useStudioHandoff.getState().take(target);
      if (media === null) return;
      setInput(media);
      if (media.prompt !== undefined && media.prompt.length > 0) onPrompt?.(media.prompt);
    };
    consume();
    return useStudioHandoff.subscribe(consume);
  }, [target]);

  /*
   * A FILE FROM THE DESKTOP IS THE SAME ARRIVAL AS A CARD FROM THE TRANSCRIPT.
   *
   * It has to become a real disk PATH, not a blob URL: the thing that reads it
   * is a Python worker in another process, and an object URL means nothing
   * there. `pathForFile` is the same bridge the 3D workspace's drop already
   * uses. A file with no path (dragged out of another app's memory rather than
   * off the disk) is refused rather than accepted into a run that would fail.
   */
  const acceptFiles = useCallback(
    (files: readonly File[]): boolean => {
      const file = files.find((f) => studioAccepts(target, f.name));
      if (file === undefined) return false;
      const path = window.piDesktop.pathForFile(file);
      if (path.length === 0) return false;
      const kind = ACCEPTS[target].kind;
      setInput({
        path,
        name: file.name,
        kind,
        // Only pictures are DRAWN in the card, so only pictures need a URL that
        // works outside the served roots. See StudioHandoff.previewUrl.
        ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
      return true;
    },
    [target],
  );

  /* Object URLs pin their blob until revoked. One is alive at a time here, so
     the previous one goes as the next arrives, and the last goes on unmount. */
  const preview = input?.previewUrl;
  useEffect(() => {
    if (preview === undefined) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const card =
    input === null ? undefined : (
      <>
        {input.kind === 'image' ? (
          // biome-ignore lint/a11y/useAltText: the name is stated beside it
          <img className="pd-studio-from-thumb" src={input.previewUrl ?? pdFileUrl(input.path)} />
        ) : (
          <span className="pd-studio-from-thumb" aria-hidden />
        )}
        <span className="pd-studio-from-body">
          <span className="pd-studio-from-label">Working from</span>
          <span className="pd-studio-from-name" title={input.path}>
            {input.name}
          </span>
        </span>
        <button
          type="button"
          className="pd-studio-from-drop pd-focusable"
          aria-label="Use nothing as input"
          data-testid="studio-input-clear"
          onClick={() => setInput(null)}
        >
          <IconClose size={12} />
        </button>
      </>
    );

  return { input, clear: () => setInput(null), card, acceptFiles };
}
