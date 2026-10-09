/**
 * WHAT IS ON SCREEN, FOR THE SIDEBAR TO LIGHT.
 *
 * the user (2026-10-08): "ensure the sidebar highlight applies correctly to
 * whatever's actually selected, currently I think it gets stuck on chats,
 * doesn't show connectors and such if they're selected maybe also something to
 * do with if they're not directly selected given there's multiple ways to get
 * to different places".
 *
 * The sidebar lit a chat row whenever that chat was the current one, and no
 * workspace or studio row ever — so Extensions, Models, Scheduled and the
 * studios showed with the chat still highlighted. The highlight is now read
 * from what App actually shows (its view and the studio), not from which row
 * was clicked: every door into a place — a row, the composer's + menu, the
 * model menu, a deep link, Settings — lands on the same state, so it lights
 * the same row.
 */
import { create } from 'zustand';
import type { MainView } from '../routes';
import type { Modality } from './modality-store';

export type Place =
  | { readonly kind: 'chat' }
  | { readonly kind: 'view'; readonly view: Exclude<MainView, 'chat'> }
  | { readonly kind: 'studio'; readonly studio: Exclude<Modality, 'chat'> };

/** The place a view and a studio add up to: a studio over everything, then a
 * workspace screen, else the chat. Pure. */
export function placeOf(view: MainView, studio: Modality): Place {
  if (studio !== 'chat') return { kind: 'studio', studio };
  if (view !== 'chat') return { kind: 'view', view };
  return { kind: 'chat' };
}

export const useActivePlace = create<{
  readonly place: Place;
  readonly set: (place: Place) => void;
}>((set) => ({ place: { kind: 'chat' }, set: (place) => set({ place }) }));
