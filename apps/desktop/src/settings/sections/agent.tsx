import { IconShield } from '../icons';
import { AgentPanel } from '../panels/AgentPanel';
import type { SettingsSectionDef } from './types';

export const agentSection: SettingsSectionDef = {
  id: 'agent',
  label: 'Agent',
  title: 'Agent',
  icon: <IconShield />,
  render: () => <AgentPanel />,
};
