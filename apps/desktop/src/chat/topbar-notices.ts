/**
 * WHAT A FEATURE SAYS IN THE MIDDLE OF THE TOP BAR — the training chip
 * ("Training · 42%", TR-6), "Sharing with 2 devices" (DEV-7), the words for a
 * model loading on another computer (DEV-8) — without editing the bar.
 *
 * The centre of the top bar is ONE slot where the most urgent thing wins (the
 * chain in ChatApp: a chat waiting for the person, then the machine's own state,
 * then this bar's status). TopBarStatus now draws registered notices around its
 * own model status (the W0-A pre-wire, deliverables/research/PLAN.md §2.3):
 *
 *   priority > 0   wins over the model status ("Starting up…")
 *   priority ≤ 0   shows only when there is no model status to show
 *
 * higher first within each band. A notice is a component handed a `fallback`:
 * it draws itself when it has something to say, and otherwise returns the
 * fallback untouched — the same idiom as InputNeededBanner and GuardianBanner,
 * so a notice that is off costs the chain nothing. With nothing registered the
 * bar is exactly what it was.
 */
import type { ComponentType, ReactNode } from 'react';
import { createUiRegistry } from '../state/ui-registry';

export interface TopBarNoticeProps {
  /** What to render when this notice has nothing to say. */
  readonly fallback: ReactNode;
}

export interface TopBarNotice {
  readonly id: string;
  readonly priority: number;
  readonly Component: ComponentType<TopBarNoticeProps>;
}

const notices = createUiRegistry<TopBarNotice>();

/** Add a notice to the chain. Same id replaces. Returns the removal. */
export function registerTopBarNotice(notice: TopBarNotice): () => void {
  return notices.register(notice);
}

/** React: the registered notices, most urgent first (ties keep registration order). */
export function useTopBarNotices(): readonly TopBarNotice[] {
  return sortNotices(notices.useItems());
}

export function sortNotices(list: readonly TopBarNotice[]): readonly TopBarNotice[] {
  if (list.length < 2) return list;
  return list
    .map((n, i) => ({ n, i }))
    .sort((a, b) => b.n.priority - a.n.priority || a.i - b.i)
    .map((x) => x.n);
}
