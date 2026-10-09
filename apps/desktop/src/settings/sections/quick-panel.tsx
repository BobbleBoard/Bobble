import { IconCommand } from '@pi-desktop/ui';
import { QuickPanelPanel } from '../panels/QuickPanelPanel';
import type { SettingsSectionDef } from './types';

export const quickPanelSection: SettingsSectionDef = {
  id: 'quick-panel',
  label: 'Quick panel',
  title: 'Quick panel',
  icon: <IconCommand />,
  render: () => <QuickPanelPanel />,
};
