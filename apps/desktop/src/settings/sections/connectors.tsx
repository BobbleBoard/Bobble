import { Glyph } from '@pi-desktop/ui';
import { ConnectorsPanel } from '../panels/ConnectorsPanel';
import type { SettingsSectionDef } from './types';

export const connectorsSection: SettingsSectionDef = {
  id: 'connectors',
  // "Extensions" on screen (the user, 2026-09-20); the section id stays.
  label: 'Extensions',
  title: 'Extensions',
  icon: <Glyph name="extensions" />,
  render: (ctx) => <ConnectorsPanel onOpenConnectors={ctx.onOpenConnectors} />,
};
