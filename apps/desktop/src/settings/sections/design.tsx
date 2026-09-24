/**
 * Settings → Design — STUB from the W0-A pre-wire, hidden until it ships.
 *
 * VQ-14 (lane VQ, W4) fills this file: the design kit, pictures in documents,
 * the lint policy, and its guide page `resources/help/guide/design.md`, and
 * `hidden` goes. Placed between Capabilities and Experimental in the nav
 * (PLAN.md Q14's default; deliverables/research/visual-quality.md §4.6). The
 * glyph is a placeholder from the batch until VQ picks one.
 */
import { Glyph } from '@pi-desktop/ui';
import type { SettingsSectionDef } from './types';

export const designSection: SettingsSectionDef = {
  id: 'design',
  label: 'Design',
  title: 'Design',
  icon: <Glyph name="brush" />,
  hidden: true,
  render: () => null,
};
