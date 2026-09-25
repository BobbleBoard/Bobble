/**
 * CARDS A FEATURE HANGS UNDER A TURN — help's settings cards, a workflow's run
 * card, memory's "Remembered N things" chip — without editing the thread.
 *
 * ChatThread already anchors cards to a turn: a presented artefact is drawn
 * under the message it followed (`slotsFor`, present-store's `afterMessageId`).
 * This is the same seam opened to features (the W0-A pre-wire,
 * deliverables/research/PLAN.md §2.3): a feature registers a slot component
 * from its own file, the thread renders every registered slot after every row
 * (after that row's presented cards), and the slot decides — from the row it is
 * handed — whether it has anything to draw there. With nothing registered, the
 * thread renders exactly as it did.
 *
 * A slot must return null for the rows it has nothing for, and must be cheap
 * when it does: it renders once per row of the thread.
 */
import type { ComponentType } from 'react';
import { createUiRegistry } from '../state/ui-registry';

/** The row a slot is rendered under. */
export interface ThreadSlotProps {
  readonly kind: 'user' | 'assistant' | 'notice' | 'bash' | 'orphanTool';
  /** The id cards anchor to: the row's message, or an assistant group's LAST message. */
  readonly anchorId: string;
  /** Every message id the row draws (one, or an assistant group's). */
  readonly messageIds: readonly string[];
  /** The row is the thread's latest. */
  readonly isLast: boolean;
}

export interface ThreadSlot {
  readonly id: string;
  readonly Component: ComponentType<ThreadSlotProps>;
}

const slots = createUiRegistry<ThreadSlot>();

/** Hang a slot under every row. Same id replaces. Returns the removal. */
export function registerThreadSlot(slot: ThreadSlot): () => void {
  return slots.register(slot);
}

/** React: the registered slots, in registration order. */
export function useThreadSlots(): readonly ThreadSlot[] {
  return slots.useItems();
}

export function threadSlots(): readonly ThreadSlot[] {
  return slots.list();
}
