/**
 * ROWS A FEATURE ADDS TO A CHAT'S ⋯ MENU, AND BOXES IT ADDS TO "DELETE CHAT?".
 *
 * Memory wants "Forget what Bobble learned here" on a chat and a "also forget
 * what it learned from this chat" box when one is deleted (WP-M8); workflows
 * wants "Save as workflow…" (WF-12). Both register here from their own files
 * (the W0-A pre-wire, deliverables/research/PLAN.md §2.3) and the sidebar draws
 * them: menu rows after the built-in ones and before Delete, dialog boxes under
 * "Don't ask again". With nothing registered the menu and the dialog are
 * exactly what they were.
 *
 * A delete option runs whether or not the dialog was shown: skipped by "Don't
 * ask again", it runs with its default.
 */
import type { ReactNode } from 'react';
import { createUiRegistry } from '../state/ui-registry';

/** The chat a menu row or a delete option is about. */
export interface ThreadMenuContext {
  /** The session file. */
  readonly file: string;
  /** Its title as the sidebar shows it (renames included). */
  readonly title: string;
  readonly pinned: boolean;
  /** The project it is filed under, if any. */
  readonly projectId: string | undefined;
}

export interface ThreadMenuEntry {
  readonly id: string;
  readonly label: string | ((ctx: ThreadMenuContext) => string);
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  /** `data-testid`, given the chat (the sidebar's rows carry the title). */
  readonly testid?: (ctx: ThreadMenuContext) => string;
  /** Absent = on every chat. */
  readonly visible?: (ctx: ThreadMenuContext) => boolean;
  readonly onSelect: (ctx: ThreadMenuContext) => void;
}

export interface DeleteChatOption {
  readonly id: string;
  readonly label: string;
  /** Ticked when the dialog opens — and what runs when the dialog is skipped. */
  readonly defaultChecked: (ctx: ThreadMenuContext) => boolean;
  readonly testid?: string;
  readonly visible?: (ctx: ThreadMenuContext) => boolean;
  /** Runs as the chat is deleted, with whether the box was ticked. */
  readonly onDelete: (ctx: ThreadMenuContext, checked: boolean) => void | Promise<void>;
}

const menuEntries = createUiRegistry<ThreadMenuEntry>();
const deleteOptions = createUiRegistry<DeleteChatOption>();

export function registerThreadMenuEntry(entry: ThreadMenuEntry): () => void {
  return menuEntries.register(entry);
}

export function registerDeleteChatOption(option: DeleteChatOption): () => void {
  return deleteOptions.register(option);
}

/** React: the registered menu rows. */
export function useThreadMenuEntries(): readonly ThreadMenuEntry[] {
  return menuEntries.useItems();
}

/** React: the registered delete options. */
export function useDeleteChatOptions(): readonly DeleteChatOption[] {
  return deleteOptions.useItems();
}

/** The menu rows that apply to this chat. */
export function threadMenuEntriesFor(
  entries: readonly ThreadMenuEntry[],
  ctx: ThreadMenuContext,
): readonly ThreadMenuEntry[] {
  return entries.filter((e) => e.visible?.(ctx) ?? true);
}

/** The delete options that apply to this chat. */
export function deleteOptionsFor(ctx: ThreadMenuContext): readonly DeleteChatOption[] {
  return deleteOptions.list().filter((o) => o.visible?.(ctx) ?? true);
}

/**
 * Run every option for a chat being deleted, with the boxes as they were (or
 * the defaults, when the dialog was skipped). One that throws is reported and
 * does not stop the others — nor the delete, which has already happened.
 */
export async function runDeleteOptions(
  ctx: ThreadMenuContext,
  choices: Readonly<Record<string, boolean>> | undefined,
  onError?: (id: string, error: unknown) => void,
): Promise<void> {
  const options = deleteOptionsFor(ctx);
  if (options.length === 0) return;
  await Promise.all(
    options.map(async (o) => {
      try {
        await o.onDelete(ctx, choices?.[o.id] ?? o.defaultChecked(ctx));
      } catch (error) {
        onError?.(o.id, error);
      }
    }),
  );
}
