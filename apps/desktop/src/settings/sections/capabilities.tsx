import { IconSparkles } from '@pi-desktop/ui';
import { CapabilitiesPanel } from '../panels/CapabilitiesPanel';
import type { SettingsSectionDef } from './types';

export const capabilitiesSection: SettingsSectionDef = {
  id: 'capabilities',
  label: 'Capabilities',
  title: 'Capabilities',
  icon: <IconSparkles />,
  render: () => <CapabilitiesPanel />,
};
