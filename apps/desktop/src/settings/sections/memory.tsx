/**
 * Settings → Memory — STUB from the W0-A pre-wire, hidden until it ships.
 *
 * WP-M7 (lane MEM, W3) fills this file: the panel (what is remembered, forget
 * one or all, export, status), its guide page `resources/help/guide/memory.md`,
 * and `hidden` goes. Placed after Custom instructions in the nav (PLAN.md Q14's
 * default; deliverables/research/hindsight-memory.md §4.8).
 */
import { Glyph } from '@pi-desktop/ui';
import type { SettingsSectionDef } from './types';

export const memorySection: SettingsSectionDef = {
  id: 'memory',
  label: 'Memory',
  title: 'Memory',
  icon: <Glyph name="memory" />,
  hidden: true,
  render: () => null,
};
