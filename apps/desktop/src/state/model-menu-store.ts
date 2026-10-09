/**
 * The composer's model menu, openable from elsewhere: TierPickerMenu is the
 * menu and reads this; a card that offers another model (TurnProblemCard's
 * "Choose a smaller model") opens it.
 */
import { create } from 'zustand';

export const useModelMenuStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));
