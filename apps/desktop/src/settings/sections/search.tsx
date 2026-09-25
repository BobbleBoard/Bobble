import { IconSearch } from '@pi-desktop/ui';
import { SearchPanel } from '../panels/SearchPanel';
import type { SettingsSectionDef } from './types';

export const searchSection: SettingsSectionDef = {
  id: 'search',
  label: 'Web search',
  title: 'Web search',
  icon: <IconSearch />,
  render: () => <SearchPanel />,
};
