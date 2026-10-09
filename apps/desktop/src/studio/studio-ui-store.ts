/**
 * Which studio panels are open.
 *
 * A store rather than component state because the two TOGGLES live in the top
 * bar — the app's own chrome, outside any studio — while the PANELS live inside
 * the studio surface. The user asked for the openers to sit in "the same place and
 * icon as canvas" and "the same place and icon as advanced settings", which is
 * exactly that top-right cluster, so the two halves cannot be the same
 * component and need somewhere to meet.
 *
 * Not persisted: which panel you had open is a property of the sitting, not of
 * the app. Reset on leaving so the next visit starts clean.
 */
import { create } from 'zustand';

interface StudioUiState {
  /** The right-hand settings rail — modes, presets, shape, the common knobs. */
  settingsOpen: boolean;
  /** The gears panel — sampling and step counts, for people who want them. */
  advancedOpen: boolean;
  setSettingsOpen(open: boolean): void;
  setAdvancedOpen(open: boolean): void;
  reset(): void;
}

export const useStudioUiStore = create<StudioUiState>()((set) => ({
  settingsOpen: false,
  advancedOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  reset: () => set({ settingsOpen: false, advancedOpen: false }),
}));
