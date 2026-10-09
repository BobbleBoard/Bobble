/**
 * THE SETTINGS SECTIONS, IN NAV ORDER — the one list (lane INT's; PLAN.md R1).
 *
 * Each section is its own file beside this one (./types.ts says what a section
 * is). Hidden ones are not listed in the nav: the Memory, Devices and Design
 * stubs until their lanes ship them, and the `models` / `engines` aliases
 * other surfaces address. Their places here are where they will appear:
 * Memory after Custom instructions, Devices after Computer use, Design between
 * Capabilities and Experimental (PLAN.md Q14's recommended default).
 */
import { agentSection } from './agent';
import { appearanceSection } from './appearance';
import { capabilitiesSection } from './capabilities';
import { computerUseSection } from './computer-use';
import { connectorsSection } from './connectors';
import { designSection } from './design';
import { devicesSection } from './devices';
import { enginesSection, experimentalSection, modelsSection } from './experimental';
import { harnessSection } from './harness';
import { interfaceSection } from './interface';
import { memorySection } from './memory';
import { personalizationSection } from './personalization';
import { quickPanelSection } from './quick-panel';
import { searchSection } from './search';
import type { SettingsSection, SettingsSectionDef } from './types';

export type { SettingsSection, SettingsSectionContext, SettingsSectionDef } from './types';

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  personalizationSection,
  memorySection,
  harnessSection,
  appearanceSection,
  interfaceSection,
  agentSection,
  computerUseSection,
  devicesSection,
  quickPanelSection,
  searchSection,
  connectorsSection,
  capabilitiesSection,
  designSection,
  experimentalSection,
  enginesSection,
  modelsSection,
];

const BY_ID = new Map<SettingsSection, SettingsSectionDef>(SETTINGS_SECTIONS.map((s) => [s.id, s]));

/** The section for an id. Every member of the union has one (see the test). */
export function settingsSection(id: SettingsSection): SettingsSectionDef {
  const def = BY_ID.get(id);
  if (def === undefined) throw new Error(`no settings section "${id}"`);
  return def;
}

/** The nav: every section that is not hidden, in order. */
export const SETTINGS_NAV: readonly SettingsSectionDef[] = SETTINGS_SECTIONS.filter(
  (s) => s.hidden !== true,
);

/** Is `item` the nav row that reads as current while `open` is the open section? */
export function isCurrentNav(item: SettingsSection, open: SettingsSection): boolean {
  return item === open || item === settingsSection(open).navId;
}
