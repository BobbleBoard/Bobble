import { IconPencil } from '@pi-desktop/ui';
import { PersonalizationPanel } from '../panels/PersonalizationPanel';
import type { SettingsSectionDef } from './types';

export const personalizationSection: SettingsSectionDef = {
  id: 'personalization',
  label: 'Custom instructions',
  title: 'Custom instructions',
  icon: <IconPencil />,
  render: () => <PersonalizationPanel />,
};
