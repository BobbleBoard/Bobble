/**
 * CHATS THE USER JUST DELETED — hidden this frame, whatever the disk is doing.
 *
 * The user (2026-09-23): "clicking delete on a chat should … immediately remove it
 * from the user interface, to the user it gets instantly deleted, super snappy
 * and responsive even if deletion on disk takes a while." The sidebar used to
 * wait for the file to go, the org record to be rewritten and the whole
 * session list to be read back before the row moved.
 *
 * Every file of the chat's chain goes in (a row stands for several files), and
 * stays for the life of the app: main keeps its own record so the listing
 * never returns them, and this one covers the moment before it does. A delete
 * that FAILS takes its files back out, and the row returns.
 *
 * Standalone on purpose — pi-connect reads it, and the delete flow reads
 * pi-connect.
 */
import { create } from 'zustand';

interface DeletedChatsState {
  readonly files: ReadonlySet<string>;
  readonly hide: (files: readonly string[]) => void;
  readonly restore: (files: readonly string[]) => void;
}

export const useDeletedChats = create<DeletedChatsState>((set) => ({
  files: new Set<string>(),
  hide: (files) =>
    set((s) => {
      const next = new Set(s.files);
      for (const f of files) next.add(f);
      return { files: next };
    }),
  restore: (files) =>
    set((s) => {
      const next = new Set(s.files);
      for (const f of files) next.delete(f);
      return { files: next };
    }),
}));

/** Was this chat file deleted in this run of the app? */
export function isChatDeleted(file: string | null | undefined): boolean {
  return typeof file === 'string' && useDeletedChats.getState().files.has(file);
}
