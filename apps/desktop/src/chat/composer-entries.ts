/**
 * THE COMPOSER'S EXTENSION POINTS — what a feature adds to the `+` menu, how it
 * takes a send, and the chip that says a mode is on — so no lane edits
 * ChatComposer to add a mode (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3).
 *
 * 1. `+` MENU ROWS. The planned rows are listed here, in their order, as the
 *    menu's last group: Bobble help (a mode, a checkbox — bobble-help.md §4.3),
 *    Research (workflows WF-07), Workflows › (a submenu of saved workflows,
 *    WF-11), Temporary chat (a mode — memory WP-M8). A row shows only once its
 *    lane registers what it does (`registerComposerAction`), the same rule the
 *    menu itself lives by: a row exists only if it can act. So the menu is
 *    unchanged until then.
 * 2. SUBMIT INTERCEPTORS. Help mode sends to the help pi, not the chat; a
 *    workflow dispatch starts a run with no model turn (PLAN.md Q21). An
 *    interceptor sees every send after the composer has cleared, and either
 *    takes it (returns true: nothing else happens) or passes. With none
 *    registered the send path is exactly what it was — not even an await.
 * 3. MODE CHIPS. "Bobble help ×" beside the + while help mode is on: a chip
 *    component renders itself when its mode is on and null otherwise.
 */
import type { AddMenuEntry, GlyphName } from '@pi-desktop/ui';
import type { ComponentType } from 'react';
import { createUiRegistry } from '../state/ui-registry';

// ── 1. + menu rows ──────────────────────────────────────────────────────────

export interface ComposerEntryRow {
  readonly id: 'bobble-help' | 'research' | 'workflows' | 'temporary-chat';
  readonly label: string;
  readonly glyph?: GlyphName;
  readonly testid: string;
}

/** The planned rows, in menu order. Each shows once its action is registered. */
export const COMPOSER_ENTRY_ROWS: readonly ComposerEntryRow[] = [
  { id: 'bobble-help', label: 'Bobble help', glyph: 'help', testid: 'add-bobble-help' },
  { id: 'research', label: 'Research', testid: 'add-research' },
  { id: 'workflows', label: 'Workflows', testid: 'add-workflows' },
  { id: 'temporary-chat', label: 'Temporary chat', testid: 'add-temporary-chat' },
];

/** What a row does, registered by the lane that owns it. */
export interface ComposerAction {
  readonly id: ComposerEntryRow['id'];
  /** Picked (for a checkbox row, flip the mode). */
  readonly onSelect?: () => void;
  /** A mode's current state — makes the row a checkbox. Read when the menu renders. */
  readonly checked?: () => boolean;
  /** A submenu's rows (Workflows ›), read when the menu renders. */
  readonly items?: () => readonly AddMenuEntry[];
  /** Absent = shown whenever registered. */
  readonly visible?: () => boolean;
}

const actions = createUiRegistry<ComposerAction>();

export function registerComposerAction(action: ComposerAction): () => void {
  return actions.register(action);
}

/**
 * "My row's state changed" (a mode turned on elsewhere): re-render the
 * composer so the next menu shows it.
 */
export function touchComposerActions(): void {
  actions.touch();
}

/** React: re-render when an action is registered, removed or touched. */
export function useComposerActionsVersion(): number {
  return actions.useVersion();
}

/**
 * The rows to draw, as menu entries — rows without a registered action are
 * absent, so with none registered this is empty and the menu is unchanged.
 * `icon` turns a row's glyph name into the element the menu draws.
 */
export function composerMenuEntries(
  icon: (glyph: GlyphName) => AddMenuEntry['icon'],
): AddMenuEntry[] {
  const out: AddMenuEntry[] = [];
  for (const row of COMPOSER_ENTRY_ROWS) {
    const action = actions.get(row.id);
    if (action === undefined || !(action.visible?.() ?? true)) continue;
    out.push({
      key: row.id,
      label: row.label,
      testid: row.testid,
      ...(row.glyph !== undefined ? { icon: icon(row.glyph) } : {}),
      ...(action.checked !== undefined ? { checked: action.checked() } : {}),
      ...(action.items !== undefined ? { children: action.items() } : {}),
      ...(action.onSelect !== undefined ? { onSelect: action.onSelect } : {}),
    });
  }
  return out;
}

// ── 2. submit interceptors ──────────────────────────────────────────────────

/** A send, as the composer is about to make it. */
export interface ComposerSubmission {
  /** What was typed, trimmed. */
  readonly text: string;
  /** What pi would be sent: the text with attached files folded in. */
  readonly agentMessage: string;
  /** Attached pictures (data URIs). */
  readonly images: readonly string[];
}

export interface SubmitInterceptor {
  readonly id: string;
  /** True = taken; the composer does nothing more with this send. */
  readonly intercept: (submission: ComposerSubmission) => boolean | Promise<boolean>;
}

const interceptors = createUiRegistry<SubmitInterceptor>();

export function registerSubmitInterceptor(interceptor: SubmitInterceptor): () => void {
  return interceptors.register(interceptor);
}

export function hasSubmitInterceptors(): boolean {
  return interceptors.list().length > 0;
}

/**
 * Offer a send to each interceptor in registration order; the first to take
 * it wins. One that throws is treated as passing — a broken mode must not eat
 * the person's message.
 */
export async function interceptSubmit(
  submission: ComposerSubmission,
  onError?: (id: string, error: unknown) => void,
): Promise<boolean> {
  for (const i of interceptors.list()) {
    try {
      if (await i.intercept(submission)) return true;
    } catch (error) {
      onError?.(i.id, error);
    }
  }
  return false;
}

// ── 3. mode chips ───────────────────────────────────────────────────────────

export interface ComposerModeChip {
  readonly id: string;
  /** Renders the chip while its mode is on, null otherwise. */
  readonly Component: ComponentType;
}

const chips = createUiRegistry<ComposerModeChip>();

export function registerComposerModeChip(chip: ComposerModeChip): () => void {
  return chips.register(chip);
}

/** React: the registered chips, in registration order. */
export function useComposerModeChips(): readonly ComposerModeChip[] {
  return chips.useItems();
}
