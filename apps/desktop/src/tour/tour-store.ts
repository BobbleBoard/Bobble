/**
 * Whether the quick tour is open, and on which screen. The steps themselves are
 * resolved against the page when it opens (GuidedTour), so a step whose control
 * is not on screen never appears.
 */
import { create } from 'zustand';
import type { TourScreen } from './tour-steps';

interface TourState {
  /** The screen the tour is walking, or null when it is closed. */
  readonly screen: TourScreen | null;
  readonly start: (screen: TourScreen) => void;
  readonly close: () => void;
}

export const useTourStore = create<TourState>((set) => ({
  screen: null,
  start: (screen) => set({ screen }),
  close: () => set({ screen: null }),
}));
