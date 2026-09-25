import { IconTerminal } from '@pi-desktop/ui';
import { HarnessPanel } from '../panels/HarnessPanel';
import type { SettingsSectionDef } from './types';

export const harnessSection: SettingsSectionDef = {
  id: 'harness',
  label: 'Harness',
  title: 'Harness',
  icon: <IconTerminal />,
  render: () => <HarnessPanel />,
};
