/**
 * DELETE A CHAT — instantly, and everything it was doing stops.
 *
 * the user (2026-09-23): "clicking delete on a chat should instantly terminate any
 * generation of any kind happening and immediately remove it from the user
 * interface, to the user it gets instantly deleted, super snappy and
 * responsive even if deletion on disk takes a while."
 *
 * What it used to do: wait for the file to be removed, then for the org record
 * to be rewritten, then for the whole session list to be read back — and only
 * then did the row move. Nothing was stopped: a chat deleted mid-reply kept
 * generating (and wrote itself back to disk), its subagents kept working, and
 * a picture it had asked for kept the GPU for minutes.
 *
 * Now, in this order:
 *   1. the row is hidden — this frame;
 *   2. everything the chat owns is stopped, all at once: its pi turn (the view
 *      moves to a fresh chat if it was on screen), its subagents, and every
 *      generation and team it started (chat-jobs.ts);
 *   3. the files go, in the background. A failure brings the row back, and
 *      says why on the error toast.
 */

import { plainError } from '@pi-desktop/shared';
import type { SessionSummary } from '../../electron/ipc-contract';
import { cancelJobsOf } from './chat-jobs';
import { deleteChat } from './chat-org';
import { useChildAgentStore } from './child-agent-store';
import { useDeletedChats } from './deleted-chats';
import { abandonChats } from './pi-connect';
import { usePiStore } from './pi-slice';

/**
 * The sentence a refused delete is shown with: which chat, and why in words
 * rather than the errno and path main's `rm` failed with.
 */
export function deleteFailureMessage(title: string | undefined, error: string | undefined): string {
  const name = title !== undefined && title.trim() !== '' ? `“${title.trim()}”` : 'that chat';
  const raw = (error ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
    .trim();
  const why = /EACCES|EPERM|permission denied|operation not permitted/i.test(raw)
    ? 'The Mac would not let Bobble remove its file (permission denied).'
    : /EBUSY|resource busy/i.test(raw)
      ? 'Its file is in use by another program.'
      : /^refused: not a session file/.test(raw)
        ? "Its file is not in Bobble's chat folder."
        : raw === ''
          ? 'The Mac did not say why.'
          : plainError(raw);
  return `Couldn't delete ${name}, so it is back in the list. ${why}`;
}

let toastSeq = 0;

/** The app's error toast (ToastHost) — raised the way open-outcome.ts and
 * pi-connect's "Could not open that chat" raise theirs. */
function toast(message: string, action?: { label: string; run: () => void }): void {
  toastSeq += 1;
  const id = `delete-${Date.now()}-${toastSeq}`;
  usePiStore.setState((s) => ({
    notifications: [
      ...s.notifications.slice(-3),
      {
        id,
        level: 'error' as const,
        message,
        timestamp: Date.now(),
        ...(action !== undefined ? { action } : {}),
      },
    ],
  }));
}

export async function deleteChatNow(
  /** `title` is what the row showed, for the sentence if the delete fails. */
  chat: Pick<SessionSummary, 'file' | 'supersedes'> & { readonly title?: string },
): Promise<{ ok: boolean; error?: string }> {
  const files = [chat.file, ...chat.supersedes];

  // 1. Gone from the screen.
  useDeletedChats.getState().hide(files);

  // 2. Stopped.
  const kids = useChildAgentStore.getState();
  const children = Object.values(kids.children).filter((c) => files.includes(c.parentId));
  if (children.some((c) => c.childId === kids.viewedChildId)) kids.setViewedChild(null);

  const stopping = Promise.allSettled([
    abandonChats(files),
    cancelJobsOf(files),
    ...children.map(async (c) => {
      await window.piDesktop
        .invoke('pi:child-dispose', { childId: c.childId })
        .catch(() => undefined);
      useChildAgentStore.getState().removeChild(c.childId);
    }),
  ]);

  // 3. Off the disk. Main remembers the files first, so a listing racing this
  //    never shows them, and a file the dying turn writes back is swept away.
  const res = await deleteChat(chat.file, chat.supersedes).catch((e: unknown) => ({
    ok: false,
    error: e instanceof Error ? e.message : String(e),
  }));
  if (!res.ok) {
    useDeletedChats.getState().restore(files);
    /* The row coming back is not an explanation. Every caller used to drop
       this result, so a refused delete put the chat back without a word. */
    toast(deleteFailureMessage(chat.title, res.error), {
      label: 'Try again',
      run: () => void deleteChatNow(chat),
    });
    return res;
  }
  /* Once pi has let go of the file, delete once more: whatever the aborted turn
     wrote in the meantime goes too, without waiting for main's timed sweeps. */
  void stopping.then(() =>
    window.piDesktop
      .invoke('fs:delete-session', { file: chat.file, chain: chat.supersedes })
      .catch(() => undefined),
  );
  return res;
}
