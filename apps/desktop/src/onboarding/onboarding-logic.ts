/**
 * Pure onboarding mappings — kept separate from React so the auto-theme and
 * experience-gauge rules are unit-testable and can't drift silently.
 */
import type { ClaudeImport, ClaudeThemeMode } from '@pi-desktop/importers';
import type {
  CodexConfigImportResult,
  GenerationCapabilities,
  OnboardingChoices,
} from '../../electron/import/import-contract';
import type { EngineSpec } from '../settings/engine-catalog';
import type { ThemeFlavor, ThemeMode } from '../store/theme';

export type SourceChoice = 'claude' | 'codex' | 'neither';
export type ExperienceLevel = 'new' | 'knows-llamacpp' | 'no-tutorial';

/** Auto-pick the UI flavor from the source app (swappable on the theme step).
 * Users coming from neither app get Bobble — the app's own identity. */
export function flavorForSource(source: SourceChoice): ThemeFlavor {
  if (source === 'codex') return 'codex';
  if (source === 'claude') return 'claude';
  return 'bobble';
}

/**
 * Claude's `userThemeMode` → our two-value mode. `system`/absent resolves via
 * the OS preference (Codex ships no light/dark setting, so it lands here too).
 */
export function resolveMode(themeMode: ClaudeThemeMode | null, prefersDark: boolean): ThemeMode {
  if (themeMode === 'light') return 'light';
  if (themeMode === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

export interface ExperienceMapping {
  tutorial: boolean;
  permissionMode: OnboardingChoices['permissionMode'];
}

/**
 * Experience gauge → tutorial flag + starting permission mode. Newer users get
 * the guided tutorial and the safest (review-all) permissions; power users opt
 * into faster, looser modes.
 */
export function mapExperience(level: ExperienceLevel): ExperienceMapping {
  switch (level) {
    case 'new':
      return { tutorial: true, permissionMode: 'review-all' };
    case 'knows-llamacpp':
      return { tutorial: false, permissionMode: 'reviewer' };
    case 'no-tutorial':
      return { tutorial: false, permissionMode: 'bypass' };
  }
}

export const DEFAULT_CAPABILITIES: GenerationCapabilities = {
  image: false,
  video: false,
  audio: false,
  threeD: false,
};

/** Preselect the source app that has config on disk (Claude wins a tie). */
export function preselectSource(detected: { claude: boolean; codex: boolean }): SourceChoice {
  if (detected.claude) return 'claude';
  if (detected.codex) return 'codex';
  return 'neither';
}

/*
 * THE STEPS. Four for someone starting fresh, five when there is something to
 * carry over. The review that set this (2026-10-09) walked seven: an import
 * page that said "Nothing to import", guidance and computer use on separate
 * pages though both answer "how much does Bobble do without asking", and the
 * generation switches a page away from the model they come with.
 */
export const ONBOARDING_STEPS = ['welcome', 'import', 'look', 'hands-on', 'get-running'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** Whether the import page has anything on it for this source. Codex's theme
 * is not counted: picking its look is the next page's job. */
export function hasSomethingToImport(
  source: SourceChoice,
  claude: Pick<ClaudeImport, 'mcpServers' | 'theme'> | null,
  codex: Pick<CodexConfigImportResult, 'mcpServers' | 'skills'> | null,
  sessionCount: number,
): boolean {
  if (source === 'claude') {
    return (claude?.mcpServers.length ?? 0) > 0 || claude?.theme.themeMode != null;
  }
  if (source === 'codex') {
    return (
      (codex?.mcpServers.length ?? 0) > 0 || (codex?.skills.length ?? 0) > 0 || sessionCount > 0
    );
  }
  return false;
}

/** The pages this person walks, in order. */
export function visibleSteps(withImport: boolean): OnboardingStepId[] {
  return ONBOARDING_STEPS.filter((id) => id !== 'import' || withImport);
}

/** The look page's line under its title: "matched to your app" only when there is one. */
export function lookSubtitle(source: SourceChoice): string {
  if (source === 'claude') return 'Matched to Claude. Change it anytime.';
  if (source === 'codex') return 'Matched to Codex. Change it anytime.';
  return "Bobble's own look. Change it anytime.";
}

/** "4.6 GB", "770 MB": a size a person reads, one decimal under 10 GB. */
export function formatBytes(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export interface SetupPlan {
  /** Engines still to install, in install order. */
  readonly engines: readonly EngineSpec[];
  readonly engineBytes: number;
  /** 0 when the model is already on this Mac. */
  readonly modelBytes: number;
  readonly totalBytes: number;
}

/**
 * What one "Download" fetches. Pure. An engine that arrives with its first
 * model (`autoInstalls`, llama.cpp) or is already installed costs nothing here.
 */
export function setupPlan(input: {
  readonly engine: EngineSpec;
  readonly prerequisites: readonly EngineSpec[];
  readonly installedEngineIds: ReadonlySet<string>;
  readonly modelBytes: number;
  readonly modelPresent: boolean;
}): SetupPlan {
  const engines = [...input.prerequisites, input.engine].filter(
    (e) => e.autoInstalls !== true && !input.installedEngineIds.has(e.id),
  );
  const engineBytes = engines.reduce((n, e) => n + (e.approxBytes ?? 0), 0);
  const modelBytes = input.modelPresent ? 0 : input.modelBytes;
  return { engines, engineBytes, modelBytes, totalBytes: engineBytes + modelBytes };
}
