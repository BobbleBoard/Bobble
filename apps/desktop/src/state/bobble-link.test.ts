import { describe, expect, it } from 'vitest';
import { bobbleLink, type NavAllowList, type NavTarget, parseBobbleLink } from './bobble-link';

const allow: NavAllowList = {
  settingsSections: ['personalization', 'appearance', 'experimental'],
  views: { models: ['discover', 'device', 'storage'], connectors: [], scheduled: [] },
  studios: ['image', 'video', 'audio', '3d'],
};

describe('parseBobbleLink', () => {
  it.each<[string, NavTarget]>([
    [
      'bobble://settings/appearance#theme.mode',
      { kind: 'settings', section: 'appearance', settingId: 'theme.mode' },
    ],
    ['bobble://settings/appearance', { kind: 'settings', section: 'appearance' }],
    [
      'settings:appearance#theme.mode',
      { kind: 'settings', section: 'appearance', settingId: 'theme.mode' },
    ],
    ['bobble://view/models?tab=storage', { kind: 'view', view: 'models', tab: 'storage' }],
    ['view:connectors', { kind: 'view', view: 'connectors' }],
    ['bobble://studio/3d', { kind: 'studio', studio: '3d' }],
    ['bobble://guide/getting-started', { kind: 'guide', id: 'getting-started' }],
    ['bobble://chat', { kind: 'chat' }],
    ['chat', { kind: 'chat' }],
  ])('%s', (link, target) => {
    expect(parseBobbleLink(link, allow)).toEqual(target);
    // …and the link it names parses back to the same place.
    expect(parseBobbleLink(bobbleLink(target), allow)).toEqual(target);
  });

  it.each([
    'bobble://settings/memory', // not listed (a hidden stub)
    'bobble://settings/appearance#Theme', // setting ids start lower-case
    'bobble://settings/appearance#theme.mode;rm', // nothing but an id
    'bobble://settings/appearance?x=1',
    'bobble://view/training', // no screen registered
    'bobble://view/models?tab=secret',
    'bobble://view/models?tab=storage&then=delete',
    'bobble://view/models#x',
    'bobble://studio/photoshop',
    'bobble://guide/../../etc/passwd',
    'bobble://guide/Getting Started',
    'bobble://settings/appearance/extra',
    'bobble://settings//appearance',
    'bobble://evil/thing',
    'https://example.com',
    'javascript:alert(1)',
    'bobble://settings/app%65arance',
    '',
    `bobble://guide/${'a'.repeat(300)}`,
  ])('refuses %s', (link) => {
    expect(parseBobbleLink(link, allow)).toBeNull();
  });
});
