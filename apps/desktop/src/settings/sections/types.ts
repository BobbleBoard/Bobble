/**
 * A Settings section, as the floating Settings panel draws it: its nav row, its
 * page title and its body. One file per section beside this one; the ORDER of
 * the nav is the list in ./index.tsx (lane INT's). A lane that adds a section
 * fills its own file — the Memory, Devices and Design stubs exist from the
 * W0-A pre-wire, hidden — and never edits SettingsView.tsx
 * (deliverables/research/PLAN.md §2.3, R1). A section that ships also ships its
 * guide page, `resources/help/guide/<id>.md` (R7).
 */
import type { ReactNode } from 'react';

export type SettingsSection =
  | 'models'
  | 'engines'
  | 'harness'
  | 'personalization'
  | 'memory'
  | 'appearance'
  | 'interface'
  | 'agent'
  | 'search'
  | 'connectors'
  | 'capabilities'
  | 'computer-use'
  | 'quick-panel'
  | 'devices'
  | 'design'
  | 'experimental';

/** What a section's body may reach outside Settings. */
export interface SettingsSectionContext {
  /** Open the dev component gallery (round-5 #23: entry lives in Interface). */
  readonly onOpenGallery?: () => void;
  /** Open the full Codex-style connectors gallery (its own top-level view). */
  readonly onOpenConnectors?: () => void;
  /** Clear the first-run flag + re-open the onboarding wizard (Interface panel). */
  readonly onRedoOnboarding?: () => void;
}

export interface SettingsSectionDef {
  readonly id: SettingsSection;
  /** The nav row's words — what the Settings search matches. */
  readonly label: string;
  /** The page's heading. */
  readonly title: string;
  readonly icon: ReactNode;
  /**
   * Not in the nav: a stub whose page has not shipped, or an alias (`models`,
   * `engines`) that other surfaces address. Still openable by id.
   */
  readonly hidden?: boolean;
  /** The nav row that reads as current while this section is open (an alias's home). */
  readonly navId?: SettingsSection;
  readonly render: (ctx: SettingsSectionContext) => ReactNode;
}
