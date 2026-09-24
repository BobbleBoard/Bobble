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
 *      moves to a fresh chat if it was on screen), its subagents and team, and
 *      every generation it started (chat-jobs.ts);
 *   3. the files go, in the background. A failure brings the row back.
 */
import type { SessionSummary } from '../../electron/ipc-contract';
import { cancelJobsOf } from './chat-jobs';
import { deleteChat } from './chat-org';
import { useChildAgentStore } from './child-agent-store';
import { abortCorpTask } from './corp-connect';
import { useCorpStore } from './corp-store';
import { useDeletedChats } from './deleted-chats';
import { abandonChats } from './pi-connect';
import { usePiStore } from './pi-slice';

export async function deleteChatNow(
  chat: Pick<SessionSummary, 'file' | 'supersedes'>,
): Promise<{ ok: boolean; error?: string }> {
  const files = [chat.file, ...chat.supersedes];

  // 1. Gone from the screen.
  useDeletedChats.getState().hide(files);

  // 2. Stopped. Read BEFORE the view moves: a new chat drops the team pointer.
  const onScreen = files.includes(usePiStore.getState().session?.sessionFile ?? '');
  const corp = useCorpStore.getState();
  const team = onScreen && corp.corpRunning ? corp.taskId : null;
  const kids = useChildAgentStore.getState();
  const children = Object.values(kids.children).filter((c) => files.includes(c.parentId));
  if (children.some((c) => c.childId === kids.viewedChildId)) kids.setViewedChild(null);

  const stopping = Promise.allSettled([
    abandonChats(files),
    cancelJobsOf(files),
    team !== null ? abortCorpTask(team) : Promise.resolve(),
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
