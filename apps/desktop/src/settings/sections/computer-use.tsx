import { Glyph } from '@pi-desktop/ui';
import { ComputerUsePanel } from '../panels/ComputerUsePanel';
import type { SettingsSectionDef } from './types';

export const computerUseSection: SettingsSectionDef = {
  id: 'computer-use',
  label: 'Computer use',
  title: 'Computer use',
  // A window with its traffic lights and the agent's cursor (the user 2026-09-23).
  icon: <Glyph name="computerUse" />,
  render: () => <ComputerUsePanel />,
};
