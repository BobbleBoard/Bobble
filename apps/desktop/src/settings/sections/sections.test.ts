// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  isCurrentNav,
  SETTINGS_NAV,
  SETTINGS_SECTIONS,
  type SettingsSection,
  settingsSection,
} from './index';

/*
 * The registry replaced SettingsView's NAV, TITLES and SectionBody (the W0-A
 * pre-wire). These are the old tables, verbatim from 6eb58aaf, and the
 * registry must reproduce them — the nav, its order and words, every title,
 * and the one alias rule (Engines lights Experimental).
 */
const OLD_NAV: Array<[SettingsSection, string]> = [
  ['personalization', 'Custom instructions'],
  ['harness', 'Harness'],
  ['appearance', 'Appearance'],
  ['interface', 'Interface'],
  ['agent', 'Agent'],
  ['computer-use', 'Computer use'],
  ['search', 'Web search'],
  ['connectors', 'Extensions'],
  ['capabilities', 'Capabilities'],
  ['experimental', 'Experimental'],
];

const OLD_TITLES: Record<string, string> = {
  models: 'Models',
  engines: 'Engines',
  harness: 'Harness',
  personalization: 'Custom instructions',
  appearance: 'Appearance',
  interface: 'Interface',
  agent: 'Agent',
  search: 'Web search',
  connectors: 'Extensions',
  capabilities: 'Capabilities',
  'computer-use': 'Computer use',
  experimental: 'Experimental',
};

describe('the settings section registry', () => {
  it('lists exactly the old nav, in the old order, with the old words', () => {
    expect(SETTINGS_NAV.map((s) => [s.id, s.label])).toEqual(OLD_NAV);
  });

  it('titles every old section as before', () => {
    for (const [id, title] of Object.entries(OLD_TITLES)) {
      expect(settingsSection(id as SettingsSection).title).toBe(title);
    }
  });

  it('holds the planned sections hidden, in their places', () => {
    const hidden = SETTINGS_SECTIONS.filter((s) => s.hidden === true).map((s) => s.id);
    expect(hidden).toEqual(['memory', 'devices', 'design', 'engines', 'models']);
    const order = SETTINGS_SECTIONS.map((s) => s.id);
    expect(order.indexOf('memory')).toBe(order.indexOf('personalization') + 1);
    expect(order.indexOf('devices')).toBe(order.indexOf('computer-use') + 1);
    expect(order.indexOf('design')).toBe(order.indexOf('capabilities') + 1);
    expect(order.indexOf('experimental')).toBe(order.indexOf('design') + 1);
  });

  it('keeps one id per section', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lights the same nav row as before for every open section', () => {
    for (const open of SETTINGS_SECTIONS.map((s) => s.id)) {
      for (const [item] of OLD_NAV) {
        const before = item === open || (item === 'experimental' && open === 'engines');
        expect(isCurrentNav(item, open), `${item} while ${open} is open`).toBe(before);
      }
    }
  });
});
