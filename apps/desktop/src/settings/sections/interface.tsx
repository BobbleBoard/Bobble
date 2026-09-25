import { IconSlider } from '../icons';
import { InterfacePanel } from '../panels/InterfacePanel';
import type { SettingsSectionDef } from './types';

export const interfaceSection: SettingsSectionDef = {
  id: 'interface',
  label: 'Interface',
  title: 'Interface',
  icon: <IconSlider />,
  render: (ctx) => (
    <InterfacePanel onOpenGallery={ctx.onOpenGallery} onRedoOnboarding={ctx.onRedoOnboarding} />
  ),
};
