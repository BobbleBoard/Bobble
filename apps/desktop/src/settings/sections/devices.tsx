/**
 * Settings → Devices — STUB from the W0-A pre-wire, hidden until it ships.
 *
 * DEV-7 (lane DEV, W3) fills this file: the tailnet status, pairing, trusted
 * devices and "Share this computer's models", its guide page
 * `resources/help/guide/devices.md`, and `hidden` goes. Placed after Computer
 * use in the nav (PLAN.md Q14's default; deliverables/research/devices-tailscale.md
 * §4.13).
 */
import { Glyph } from '@pi-desktop/ui';
import type { SettingsSectionDef } from './types';

export const devicesSection: SettingsSectionDef = {
  id: 'devices',
  label: 'Devices',
  title: 'Devices',
  icon: <Glyph name="devices" />,
  hidden: true,
  render: () => null,
};
