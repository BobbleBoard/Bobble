/**
 * Onboarding wizard state: fetches the importable data once on mount, drives the
 * live auto-theme (writes the real theme store so the whole app re-skins as the
 * user chooses), tracks the per-step draft, and on finish applies the selected
 * imports + persists the choices via the onboarding IPC.
 */
import type { ClaudeImport } from '@pi-desktop/importers';
import { create } from 'zustand';
import type {
  CodexConfigImportResult,
  CodexSessionListEntry,
  GenerationCapabilities,
  OnboardingChoices,
} from '../../electron/import/import-contract';
import type { ComputerUseSettings } from '../../electron/settings/settings-contract';
import { loadInstalledApps } from '../computer-use/AppGrid';
import { useSettingsStore } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { useFirstRunSetup } from './first-run-setup';
import {
  DEFAULT_CAPABILITIES,
  type ExperienceLevel,
  flavorForSource,
  hasSomethingToImport,
  mapExperience,
  type OnboardingStepId,
  preselectSource,
  resolveMode,
  type SourceChoice,
  visibleSteps,
} from './onboarding-logic';

export { ONBOARDING_STEPS, type OnboardingStepId } from './onboarding-logic';

export interface ImportToggles {
  mcp: boolean;
  theme: boolean;
  sessions: boolean;
  skills: boolean;
}

interface OnboardingStore {
  step: OnboardingStepId;
  loading: boolean;
  finishing: boolean;

  claudeInstalled: boolean;
  codexInstalled: boolean;
  claude: ClaudeImport | null;
  codex: CodexConfigImportResult | null;
  sessions: CodexSessionListEntry[];

  source: SourceChoice;
  imports: ImportToggles;
  selectedSessions: Set<string>;
  selectedSkills: Set<string>;
  experience: ExperienceLevel | null;
  capabilities: GenerationCapabilities;
  /** Computer use on/off + the apps allowed without asking (the app grid). */
  computerUse: ComputerUseSettings;

  load: () => Promise<void>;
  setSource: (source: SourceChoice) => void;
  toggleImport: (key: keyof ImportToggles) => void;
  toggleSession: (file: string) => void;
  toggleSkill: (name: string) => void;
  setExperience: (level: ExperienceLevel) => void;
  toggleCapability: (key: keyof GenerationCapabilities) => void;
  setComputerUse: (next: ComputerUseSettings) => void;
  /** The pages this person walks: the import page only when there is something to bring. */
  steps: () => OnboardingStepId[];
  next: () => void;
  back: () => void;
  canProceed: () => boolean;
  finish: (onDone: () => void) => Promise<void>;
}

function prefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Push the auto-theme (flavor + mode) into the live theme store. */
function applyAutoTheme(source: SourceChoice, claude: ClaudeImport | null): void {
  const flavor = flavorForSource(source);
  const themeMode = source === 'claude' ? (claude?.theme.themeMode ?? null) : null;
  const theme = useThemeStore.getState();
  theme.setFlavor(flavor);
  theme.setMode(resolveMode(themeMode, prefersDark()));
}

function defaultToggles(
  source: SourceChoice,
  claude: ClaudeImport | null,
  codex: CodexConfigImportResult | null,
): ImportToggles {
  if (source === 'claude') {
    return {
      mcp: (claude?.mcpServers.length ?? 0) > 0,
      theme: claude?.theme.themeMode != null,
      sessions: false,
      skills: false,
    };
  }
  if (source === 'codex') {
    return {
      mcp: (codex?.mcpServers.length ?? 0) > 0,
      theme: true,
      sessions: false,
      skills: false,
    };
  }
  return { mcp: false, theme: false, sessions: false, skills: false };
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  step: 'welcome',
  loading: true,
  finishing: false,
  claudeInstalled: false,
  codexInstalled: false,
  claude: null,
  codex: null,
  sessions: [],
  source: 'neither',
  imports: { mcp: false, theme: false, sessions: false, skills: false },
  selectedSessions: new Set(),
  selectedSkills: new Set(),
  experience: null,
  capabilities: { ...DEFAULT_CAPABILITIES },
  // On by default with nothing pre-approved — the step is where a person
  // ticks the apps they are happy to hand over, or switches the whole thing off.
  computerUse: { enabled: true, apps: [] },

  load: async () => {
    // Start the slow lookups now so their pages open full: the computer-use
    // grid's app icons (the helper walks /Applications) and the last page's
    // engine and model check. Both cache; the pages read the same promise.
    void loadInstalledApps();
    void useFirstRunSetup.getState().check();
    const [detect, claude, codex, sessions] = await Promise.all([
      window.piDesktop.invoke('import:detect', undefined),
      window.piDesktop.invoke('import:claude', undefined),
      window.piDesktop.invoke('import:codex-config', undefined),
      window.piDesktop.invoke('import:codex-sessions-list', undefined),
    ]);
    const source = preselectSource({
      claude: detect.claude.installed,
      codex: detect.codex.installed,
    });
    applyAutoTheme(source, claude);
    set({
      loading: false,
      claudeInstalled: detect.claude.installed,
      codexInstalled: detect.codex.installed,
      claude,
      codex,
      sessions,
      source,
      imports: defaultToggles(source, claude, codex),
    });
  },

  setSource: (source) => {
    const { claude, codex } = get();
    applyAutoTheme(source, claude);
    set({ source, imports: defaultToggles(source, claude, codex) });
  },

  toggleImport: (key) => {
    const state = get();
    const next = !state.imports[key];
    const patch: Partial<OnboardingStore> = { imports: { ...state.imports, [key]: next } };
    if (key === 'sessions') {
      patch.selectedSessions = next ? new Set(state.sessions.map((s) => s.file)) : new Set();
    } else if (key === 'skills') {
      patch.selectedSkills = next ? new Set(state.codex?.skills ?? []) : new Set();
    } else if (key === 'theme') {
      // Re-seed the live theme: the source theme when on, the app default when off.
      if (next) applyAutoTheme(state.source, state.claude);
      else {
        useThemeStore.getState().setFlavor('claude');
        useThemeStore.getState().setMode(prefersDark() ? 'dark' : 'light');
      }
    }
    set(patch);
  },

  toggleSession: (file) =>
    set((s) => {
      const selectedSessions = new Set(s.selectedSessions);
      if (selectedSessions.has(file)) selectedSessions.delete(file);
      else selectedSessions.add(file);
      return { selectedSessions };
    }),

  toggleSkill: (name) =>
    set((s) => {
      const selectedSkills = new Set(s.selectedSkills);
      if (selectedSkills.has(name)) selectedSkills.delete(name);
      else selectedSkills.add(name);
      return { selectedSkills };
    }),

  setExperience: (experience) => set({ experience }),

  toggleCapability: (key) =>
    set((s) => ({ capabilities: { ...s.capabilities, [key]: !s.capabilities[key] } })),
  setComputerUse: (computerUse) => set({ computerUse }),

  steps: () => {
    const s = get();
    return visibleSteps(hasSomethingToImport(s.source, s.claude, s.codex, s.sessions.length));
  },
  next: () => {
    const steps = get().steps();
    const i = steps.indexOf(get().step);
    set({ step: steps[Math.min(i + 1, steps.length - 1)] ?? 'welcome' });
  },
  back: () => {
    const steps = get().steps();
    const i = steps.indexOf(get().step);
    set({ step: steps[Math.max(i - 1, 0)] ?? 'welcome' });
  },

  canProceed: () => {
    const s = get();
    if (s.step === 'hands-on') return s.experience !== null;
    return true;
  },

  finish: async (onDone) => {
    const s = get();
    set({ finishing: true });
    try {
      if (s.imports.mcp) {
        const servers =
          s.source === 'claude'
            ? (s.claude?.mcpServers ?? [])
            : s.source === 'codex'
              ? (s.codex?.mcpServers ?? [])
              : [];
        if (servers.length > 0) await window.piDesktop.invoke('import:apply-mcp', { servers });
      }

      let importedSessionCount = 0;
      if (s.imports.sessions && s.selectedSessions.size > 0) {
        const res = await window.piDesktop.invoke('import:codex-session-convert', {
          files: [...s.selectedSessions],
        });
        importedSessionCount = res.written;
      }

      if (s.imports.skills && s.selectedSkills.size > 0) {
        await window.piDesktop.invoke('import:apply-skills', { names: [...s.selectedSkills] });
      }

      const theme = useThemeStore.getState();
      const experience = s.experience ?? 'new';
      const { tutorial, permissionMode } = mapExperience(experience);
      const choices: OnboardingChoices = {
        source: s.source,
        imports: s.imports,
        theme: { flavor: theme.flavor, mode: theme.mode },
        experience,
        tutorial,
        permissionMode,
        capabilities: s.capabilities,
        importedSessionCount,
        computerUse: s.computerUse,
      };
      await window.piDesktop.invoke('onboarding:complete', { choices });
      // The standing policy lives in settings. A first run seeds it from the
      // choices; a redo (settings already exist) needs it written outright.
      await useSettingsStore.getState().update({ computerUse: s.computerUse });
    } finally {
      set({ finishing: false });
      onDone();
    }
  },
}));
