import { describe, expect, it } from 'vitest';
import type { OnboardingChoices } from '../import/import-contract';
import {
  clampSettings,
  DEFAULT_SETTINGS,
  mergeSettingsPatch,
  seedFromOnboarding,
} from './settings-logic';
import { effectiveMcpMode } from './settings-main';

describe('clampSettings', () => {
  it('returns defaults for junk input', () => {
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and falls back per-field on invalid ones', () => {
    const s = clampSettings({
      theme: { flavor: 'codex', mode: 'purple' },
      permissionMode: 'bypass',
      effort: 'max',
      search: { brave: 'abc', tavily: 123 },
      mcpMode: 'native',
      capabilities: { image: true, video: 'yes' },
    });
    expect(s.theme.flavor).toBe('codex');
    expect(s.theme.mode).toBe(DEFAULT_SETTINGS.theme.mode); // 'purple' rejected
    expect(s.permissionMode).toBe('bypass');
    expect(s.effort).toBe('max');
    expect(s.search).toEqual({ brave: 'abc', tavily: '' }); // non-string rejected
    expect(s.mcpMode).toBe('native');
    // Per-field fallback: `video: 'yes'` is not a boolean, so it takes the
    // DEFAULT rather than poisoning the object. Stated against DEFAULT_SETTINGS
    // rather than against literals — the defaults moved (all four are on now
    // that something finally reads them) and a literal made this test assert
    // the old value rather than the rule.
    expect(s.capabilities).toEqual({
      image: true,
      video: DEFAULT_SETTINGS.capabilities.video,
      audio: DEFAULT_SETTINGS.capabilities.audio,
      threeD: DEFAULT_SETTINGS.capabilities.threeD,
      training: DEFAULT_SETTINGS.capabilities.training,
    });
  });

  it('always stamps version 1', () => {
    expect(clampSettings({ version: 99 }).version).toBe(1);
  });

  it('normalizes chat organization + drops malformed entries', () => {
    const s = clampSettings({
      chatOrg: {
        projects: [
          { id: 'p1', name: 'Research' },
          { id: '', name: 'no id' }, // dropped
          { id: 'p2' }, // no name → dropped
          'junk', // not an object → dropped
        ],
        assignments: { 'a.jsonl': 'p1', 'b.jsonl': 42 }, // non-string value dropped
        pinned: ['a.jsonl', '', 'a.jsonl'], // empty + dupe removed
        titles: { 'a.jsonl': 'Renamed' },
      },
      hideDeleteChatConfirm: true,
    });
    expect(s.chatOrg.projects).toEqual([{ id: 'p1', name: 'Research' }]);
    expect(s.chatOrg.assignments).toEqual({ 'a.jsonl': 'p1' });
    expect(s.chatOrg.pinned).toEqual(['a.jsonl']);
    expect(s.chatOrg.titles).toEqual({ 'a.jsonl': 'Renamed' });
    expect(s.hideDeleteChatConfirm).toBe(true);
  });

  it('preserves a project working folder (cwd) and omits an empty one', () => {
    const s = clampSettings({
      chatOrg: {
        projects: [
          { id: 'p1', name: 'With folder', cwd: '/Users/user/work/app' },
          { id: 'p2', name: 'No folder', cwd: '' }, // empty cwd → omitted, project kept
        ],
      },
    });
    expect(s.chatOrg.projects).toEqual([
      { id: 'p1', name: 'With folder', cwd: '/Users/user/work/app' },
      { id: 'p2', name: 'No folder' },
    ]);
  });

  it('defaults chat organization to empty', () => {
    expect(clampSettings({}).chatOrg).toEqual({
      projects: [],
      assignments: {},
      pinned: [],
      titles: {},
    });
    expect(clampSettings({}).hideDeleteChatConfirm).toBe(false);
  });

  it('defaults userMode to user and rejects an invalid one', () => {
    expect(DEFAULT_SETTINGS.userMode).toBe('user');
    expect(clampSettings({}).userMode).toBe('user');
    expect(clampSettings({ userMode: 'wizard' }).userMode).toBe('user');
    expect(clampSettings({ userMode: 'power' }).userMode).toBe('power');
  });

  it('defaults enginePreference to llamacpp and rejects an invalid one', () => {
    expect(DEFAULT_SETTINGS.enginePreference).toBe('llamacpp');
    expect(clampSettings({}).enginePreference).toBe('llamacpp');
    expect(clampSettings({ enginePreference: 'cuda' }).enginePreference).toBe('llamacpp');
    expect(clampSettings({ enginePreference: 'mlx' }).enginePreference).toBe('mlx');
  });

  it('defaults sidebarScale/menuScale to 1.0 and clamps out-of-range values', () => {
    expect(DEFAULT_SETTINGS.sidebarScale).toBe(1.0);
    expect(DEFAULT_SETTINGS.menuScale).toBe(1.0);
    expect(clampSettings({}).sidebarScale).toBe(1.0);
    expect(clampSettings({}).menuScale).toBe(1.0);
    // Below the floor clamps up to 0.8; above the ceiling clamps down to 1.5.
    expect(clampSettings({ sidebarScale: 0.5 }).sidebarScale).toBe(0.8);
    expect(clampSettings({ sidebarScale: 3 }).sidebarScale).toBe(1.5);
    expect(clampSettings({ menuScale: 0.5 }).menuScale).toBe(0.8);
    expect(clampSettings({ menuScale: 3 }).menuScale).toBe(1.5);
    // A valid in-range value is kept; junk falls back to the default.
    expect(clampSettings({ sidebarScale: 1.25 }).sidebarScale).toBe(1.25);
    expect(clampSettings({ menuScale: 'big' }).menuScale).toBe(1.0);
    expect(clampSettings({ sidebarScale: Number.NaN }).sidebarScale).toBe(1.0);
  });

  it('moves a file saved under the old 1.25 default to 1px, once (the user, 2026-10-08: "I like the 1px stroke")', () => {
    // A file from before: the old default, written as if chosen, and no rev.
    expect(clampSettings({ iconStroke: 1.25 }).iconStroke).toBe(1);
    expect(clampSettings({ iconStroke: 1.25 }).iconStrokeRev).toBe(2);
    // A choice made before the move that was not the old default is kept.
    expect(clampSettings({ iconStroke: 1.5 }).iconStroke).toBe(1.5);
    // After the move, 1.25 is the person's own choice and stays.
    expect(clampSettings({ iconStroke: 1.25, iconStrokeRev: 2 }).iconStroke).toBe(1.25);
  });

  it('icon thickness stops at 1.75 px and icon size at 0.85–1.25× — the range a person cannot make look bad (the user, 2026-09-20)', () => {
    expect(DEFAULT_SETTINGS.iconStroke).toBe(1);
    expect(DEFAULT_SETTINGS.iconScale).toBe(1.0);
    // An older file with the old 2.5 ceiling comes back inside the new one.
    expect(clampSettings({ iconStroke: 2.5 }).iconStroke).toBe(1.75);
    expect(clampSettings({ iconStroke: 0.2 }).iconStroke).toBe(1);
    expect(clampSettings({ iconStroke: 1.5 }).iconStroke).toBe(1.5);
    expect(clampSettings({ iconScale: 2 }).iconScale).toBe(1.25);
    expect(clampSettings({ iconScale: 0.1 }).iconScale).toBe(0.85);
    expect(clampSettings({ iconScale: 'huge' }).iconScale).toBe(1.0);
    // The generation toggle is retired: the flag parses, and is simply on.
    expect(clampSettings({ experimentalGeneration: false }).experimentalGeneration).toBe(false);
    expect(DEFAULT_SETTINGS.experimentalGeneration).toBe(true);
  });

  it('defaults modelSelection to auto and effortMode to auto', () => {
    expect(DEFAULT_SETTINGS.modelSelection).toEqual({ mode: 'auto' });
    expect(DEFAULT_SETTINGS.effortMode).toBe('auto');
    expect(clampSettings({}).modelSelection).toEqual({ mode: 'auto' });
    expect(clampSettings({}).effortMode).toBe('auto');
  });

  it('clamps a valid modelSelection tier / model / auto and rejects junk', () => {
    expect(
      clampSettings({ modelSelection: { mode: 'tier', tier: 'intelligent' } }).modelSelection,
    ).toEqual({ mode: 'tier', tier: 'intelligent' });
    expect(
      clampSettings({ modelSelection: { mode: 'model', modelId: 'gemma-4-e2b-it' } })
        .modelSelection,
    ).toEqual({ mode: 'model', modelId: 'gemma-4-e2b-it' });
    expect(clampSettings({ modelSelection: { mode: 'auto' } }).modelSelection).toEqual({
      mode: 'auto',
    });
    // Invalid tier / empty model id / missing fields / junk → default auto.
    expect(
      clampSettings({ modelSelection: { mode: 'tier', tier: 'wizard' } }).modelSelection,
    ).toEqual({
      mode: 'auto',
    });
    expect(
      clampSettings({ modelSelection: { mode: 'model', modelId: '' } }).modelSelection,
    ).toEqual({
      mode: 'auto',
    });
    expect(clampSettings({ modelSelection: 'nope' }).modelSelection).toEqual({ mode: 'auto' });
    expect(clampSettings({ modelSelection: { mode: 'bogus' } }).modelSelection).toEqual({
      mode: 'auto',
    });
  });

  it('clamps effortMode to auto|level, rejecting invalid values', () => {
    expect(clampSettings({ effortMode: 'level' }).effortMode).toBe('level');
    expect(clampSettings({ effortMode: 'auto' }).effortMode).toBe('auto');
    expect(clampSettings({ effortMode: 'turbo' }).effortMode).toBe('auto');
  });
});

describe('mergeSettingsPatch', () => {
  it('merges nested objects one level deep and re-clamps', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      theme: { flavor: 'codex' },
      search: { brave: 'k' },
      effort: 'high',
    });
    expect(next.theme.flavor).toBe('codex');
    expect(next.theme.mode).toBe(DEFAULT_SETTINGS.theme.mode); // untouched key preserved
    expect(next.search).toEqual({ brave: 'k', tavily: '' });
    expect(next.effort).toBe('high');
  });

  it('rejects an invalid patch value, keeping the current one', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      permissionMode: 'yolo' as never,
    });
    expect(next.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
  });

  it('persists a userMode patch (round-trips power)', () => {
    const powered = mergeSettingsPatch(DEFAULT_SETTINGS, { userMode: 'power' });
    expect(powered.userMode).toBe('power');
    // and back to user
    expect(mergeSettingsPatch(powered, { userMode: 'user' }).userMode).toBe('user');
  });

  it('replaces the modelSelection union wholesale and re-clamps effortMode', () => {
    const pinned = mergeSettingsPatch(DEFAULT_SETTINGS, {
      modelSelection: { mode: 'tier', tier: 'fast' },
      effortMode: 'level',
    });
    expect(pinned.modelSelection).toEqual({ mode: 'tier', tier: 'fast' });
    expect(pinned.effortMode).toBe('level');
    // back to auto
    expect(mergeSettingsPatch(pinned, { modelSelection: { mode: 'auto' } }).modelSelection).toEqual(
      {
        mode: 'auto',
      },
    );
  });

  /* The module connectors (Bobble 3D): a per-id map, off by default, patched
     by id — turning one on must not forget another, and junk values drop. */
  it('module connectors default off, merge by id, and keep only booleans', () => {
    expect(DEFAULT_SETTINGS.moduleConnectors).toEqual({});
    const on = mergeSettingsPatch(DEFAULT_SETTINGS, { moduleConnectors: { '3d': true } });
    expect(on.moduleConnectors).toEqual({ '3d': true });
    const two = mergeSettingsPatch(on, { moduleConnectors: { audio: true } });
    expect(two.moduleConnectors).toEqual({ '3d': true, audio: true });
    const off = mergeSettingsPatch(two, { moduleConnectors: { '3d': false } });
    expect(off.moduleConnectors).toEqual({ '3d': false, audio: true });
    expect(
      clampSettings({ moduleConnectors: { '3d': 'yes', comfy: true, '': true } }).moduleConnectors,
    ).toEqual({ comfy: true });
  });
});

describe('seedFromOnboarding', () => {
  const choices: OnboardingChoices = {
    source: 'claude',
    imports: { mcp: false, theme: true, sessions: false, skills: false },
    theme: { flavor: 'codex', mode: 'light' },
    experience: 'new',
    tutorial: true,
    permissionMode: 'review-all',
    capabilities: { image: true, video: false, audio: false, threeD: true },
    importedSessionCount: 0,
  };

  it('carries theme, permission mode and capabilities forward', () => {
    const s = seedFromOnboarding(choices, null);
    expect(s.theme).toEqual({ flavor: 'codex', mode: 'light' });
    expect(s.permissionMode).toBe('review-all');
    // Onboarding never asks about training (the pre-wire added the key), so it
    // arrives at its default: off.
    expect(s.capabilities).toEqual({
      image: true,
      video: false,
      audio: false,
      threeD: true,
      training: false,
    });
    expect(s.mcpMode).toBe('lite'); // no registry → default
  });

  it('respects an existing mcp registry mode', () => {
    expect(seedFromOnboarding(choices, 'native').mcpMode).toBe('native');
    expect(seedFromOnboarding(null, 'native').mcpMode).toBe('native');
  });

  it('returns pure defaults when there is no onboarding record', () => {
    expect(seedFromOnboarding(null, null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('quick menu settings', () => {
  it('treats a missing quick menu as "never customised", not as an empty one', () => {
    // The renderer falls back to the shipped defaults on undefined; returning
    // {favourites: [], slots: []} instead would render a menu with no tiers.
    expect(clampSettings({}).modelQuickMenu).toBeUndefined();
    expect(clampSettings({ modelQuickMenu: 'nonsense' }).modelQuickMenu).toBeUndefined();
    expect(
      clampSettings({ modelQuickMenu: { favourites: [], slots: [] } }).modelQuickMenu,
    ).toBeUndefined();
  });

  it('keeps a real config through a round trip', () => {
    const cfg = {
      favourites: ['qwen/Qwen3-27B'],
      slots: [{ id: 'balanced', label: 'Daily', modelId: 'google/gemma-4-12b', tier: 'balanced' }],
    };
    expect(clampSettings({ modelQuickMenu: cfg }).modelQuickMenu).toEqual(cfg);
  });

  it('drops slots that could not be rendered or selected', () => {
    const got = clampSettings({
      modelQuickMenu: {
        favourites: ['ok', 42, ''],
        slots: [
          { id: '', label: 'no id', modelId: null },
          { id: 'blank', label: '   ', modelId: null },
          { id: 'good', label: 'Good', modelId: null },
        ],
      },
    }).modelQuickMenu;
    expect(got?.favourites).toEqual(['ok']);
    expect(got?.slots.map((s) => s.id)).toEqual(['good']);
  });

  it('refuses a tier it does not recognise rather than persisting it', () => {
    const got = clampSettings({
      modelQuickMenu: {
        favourites: [],
        slots: [{ id: 'x', label: 'X', modelId: null, tier: 'wildly-wrong' }],
      },
    }).modelQuickMenu;
    expect(got?.slots[0]?.tier).toBeUndefined();
  });
});

describe('the tool interface a fresh install gets', () => {
  /* The user: "I want cli mode to be by default". Pinned so that changing it back
     has to be a decision someone makes on purpose, not a merge artefact. */
  it('is the bash CLI', () => {
    expect(DEFAULT_SETTINGS.toolInterface).toBe('bash-cli');
  });

  /* The two settings are coupled on purpose — the user: "all capabilities / mcp
     when in bash mode should be translated" — so the default connector mode
     has to follow the default interface, or a fresh install is the mixed state
     that comment warns about: a model that can see one JSON tool reaches for it
     and never learns the commands. */
  it('leaves connectors in their CLI translation too', () => {
    expect(effectiveMcpMode(DEFAULT_SETTINGS.mcpMode, DEFAULT_SETTINGS.toolInterface)).toBe(
      'bash-cli',
    );
  });

  /* A stored choice still wins — this changes what a NEW install starts with,
     not what anyone who has already picked gets. */
  it('does not overwrite a user who chose schemas', () => {
    expect(clampSettings({ toolInterface: 'schemas' }).toolInterface).toBe('schemas');
  });
});

describe('code appearance', () => {
  const house = { light: 'bobble-light', dark: 'bobble-dark' };

  it('defaults to the house pair and no custom font', () => {
    expect(DEFAULT_SETTINGS.codeTheme).toEqual(house);
    expect(DEFAULT_SETTINGS.codeFont).toBe('');
    expect(clampSettings({}).codeTheme).toEqual(house);
  });

  it('keeps a real theme per slot and refuses one of the wrong mode', () => {
    const real = { light: 'github-light', dark: 'dracula' };
    expect(clampSettings({ codeTheme: real }).codeTheme).toEqual(real);
    // A dark theme in the light slot was never checked on a light ground.
    const swapped = { light: 'dracula', dark: 'github-light' };
    expect(clampSettings({ codeTheme: swapped }).codeTheme).toEqual(house);
    expect(clampSettings({ codeTheme: { light: 42, dark: 'vaporwave' } }).codeTheme).toEqual(house);
    expect(clampSettings({ codeTheme: 'nord' }).codeTheme).toEqual(house);
  });

  it('merges one slot at a time', () => {
    const current = clampSettings({ codeTheme: { light: 'one-light', dark: 'nord' } });
    expect(mergeSettingsPatch(current, { codeTheme: { dark: 'monokai' } }).codeTheme).toEqual({
      light: 'one-light',
      dark: 'monokai',
    });
    expect(mergeSettingsPatch(current, { codeTheme: { light: 'min-light' } }).codeTheme).toEqual({
      light: 'min-light',
      dark: 'nord',
    });
  });

  it('keeps a font NAME and nothing that could escape a font-family value', () => {
    expect(clampSettings({ codeFont: 'JetBrains Mono' }).codeFont).toBe('JetBrains Mono');
    expect(clampSettings({ codeFont: '  Fira   Code  ' }).codeFont).toBe('Fira Code');
    expect(clampSettings({ codeFont: 'Menlo"; } body { display: none' }).codeFont).toBe(
      'Menlo body display: none',
    );
    expect(clampSettings({ codeFont: 42 }).codeFont).toBe('');
    expect(clampSettings({ codeFont: 'x'.repeat(200) }).codeFont).toHaveLength(80);
    const withFont = clampSettings({ codeFont: 'Menlo' });
    expect(mergeSettingsPatch(withFont, { codeFont: '' }).codeFont).toBe('');
  });
});
