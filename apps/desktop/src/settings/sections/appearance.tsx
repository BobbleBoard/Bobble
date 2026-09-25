import { IconSun } from '../icons';
import { AppearancePanel } from '../panels/AppearancePanel';
import type { SettingsSectionDef } from './types';

export const appearanceSection: SettingsSectionDef = {
  id: 'appearance',
  label: 'Appearance',
  title: 'Appearance',
  icon: <IconSun />,
  render: () => <AppearancePanel />,
};
