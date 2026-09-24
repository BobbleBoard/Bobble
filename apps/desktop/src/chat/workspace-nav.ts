/**
 * THE SIDEBAR'S WORKSPACE ROWS — Model management, Extensions, Scheduled, and
 * the ones the push adds — as one ordered list (the W0-A pre-wire,
 * deliverables/research/PLAN.md §2.3; lane INT owns the list).
 *
 * The planned rows are here already, in their places, and show themselves when
 * the screen they open exists: Training once TRAIN registers its view
 * (`registerRouteView('training', …)`, TR-5) AND the Training capability is on;
 * Workflows once WF registers its (WF-11). So a lane never edits the sidebar
 * to add its row — it ships its screen, and the row follows.
 *
 * The glyphs are the set's (packages/ui glyph.tsx — the user's 2026-09-20 picks):
 * the circuit board, the puzzle piece, the calendar; the dumbbell for Training
 * (PLAN.md Q14's default). "Extensions" is what the connectors are called on
 * screen (the user); ids and test ids keep the old name, the way pi's internals
 * keep theirs.
 */
import type { GlyphName } from '@pi-desktop/ui';
import type { GenerationCapabilities } from '../../electron/settings/settings-contract';
import { routeView } from '../route-views';
import type { SettingsSection } from '../settings/SettingsView';
import type { navigate } from '../state/app-nav-store';

/** What a row's click may reach — the sidebar's own props, plus `navigate`. */
export interface WorkspaceNavContext {
  readonly onOpenSettings: (section: SettingsSection) => void;
  readonly onOpenConnectors: () => void;
  readonly onOpenScheduled: () => void;
  readonly navigate: typeof navigate;
}

export interface WorkspaceNavRow {
  readonly id: string;
  readonly label: string;
  readonly glyph: GlyphName;
  readonly testid: string;
  readonly onClick: (ctx: WorkspaceNavContext) => void;
  /** Absent = always shown. */
  readonly visible?: (state: WorkspaceNavState) => boolean;
}

/** What a row's visibility may depend on — the settings the sidebar already reads. */
export interface WorkspaceNavState {
  readonly capabilities: GenerationCapabilities;
}

export const WORKSPACE_NAV: readonly WorkspaceNavRow[] = [
  {
    id: 'models',
    label: 'Model management',
    glyph: 'models',
    testid: 'nav-model-management',
    // `models` is the settings-section id App routes to the Model management view.
    onClick: (ctx) => ctx.onOpenSettings('models'),
  },
  {
    id: 'connectors',
    label: 'Extensions',
    glyph: 'extensions',
    testid: 'nav-connectors',
    onClick: (ctx) => ctx.onOpenConnectors(),
  },
  {
    id: 'scheduled',
    label: 'Scheduled',
    glyph: 'scheduled',
    testid: 'nav-scheduled',
    onClick: (ctx) => ctx.onOpenScheduled(),
  },
  {
    id: 'training',
    label: 'Training',
    glyph: 'training',
    testid: 'nav-training',
    onClick: (ctx) => ctx.navigate({ kind: 'view', view: 'training' }),
    visible: (s) => s.capabilities.training && routeView('training') !== undefined,
  },
  {
    id: 'workflows',
    label: 'Workflows',
    // A placeholder from the set until WF-11 picks one (Scheduled may become
    // Workflows — PLAN.md Q14).
    glyph: 'scheduled',
    testid: 'nav-workflows',
    onClick: (ctx) => ctx.navigate({ kind: 'view', view: 'workflows' }),
    visible: () => routeView('workflows') !== undefined,
  },
];

/** The rows to draw, in order. */
export function workspaceNavRows(state: WorkspaceNavState): readonly WorkspaceNavRow[] {
  return WORKSPACE_NAV.filter((row) => row.visible?.(state) ?? true);
}
