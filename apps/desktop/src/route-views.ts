/**
 * The screens of the PLANNED workspace routes — Training (TR-5) and Workflows
 * (WF-11) — registered by their lanes from their own files.
 *
 * Kept apart from ./routes.ts on purpose: routes.ts imports every shipped screen
 * (Model management, Extensions, Scheduled), and the sidebar, which only needs
 * to know WHETHER a planned screen exists to show its row, must not pull those
 * in. This module imports nothing heavy (the W0-A pre-wire,
 * deliverables/research/PLAN.md §2.3).
 */
import type { ComponentType } from 'react';
import { createUiRegistry } from './state/ui-registry';

/** Planned routes and their top-bar titles. */
export const PLANNED_ROUTES = {
  training: 'Training',
  workflows: 'Workflows',
} as const;

export type PlannedRoute = keyof typeof PLANNED_ROUTES;

/** What a route's screen may ask of the shell (see App's `routeContext`). */
export interface RouteContext {
  /**
   * Leave for a NEW chat with `prompt` in the composer — Extensions' "Try in
   * chat": pi reads the connector registry when a session starts, so the thing
   * just turned on is only certainly there in the next one.
   */
  readonly tryInChat: (prompt: string) => void;
}

interface RegisteredView {
  readonly id: PlannedRoute;
  readonly view: ComponentType<RouteContext>;
}

const views = createUiRegistry<RegisteredView>();

/** A planned route's screen, from its lane's own file. Returns the removal. */
export function registerRouteView(id: PlannedRoute, view: ComponentType<RouteContext>): () => void {
  return views.register({ id, view });
}

/** The registered screen for a planned route, if its lane has shipped one. */
export function routeView(id: PlannedRoute): ComponentType<RouteContext> | undefined {
  return views.get(id)?.view;
}

/** React: re-render when a planned route gains or loses its screen. */
export function useRouteViewsVersion(): number {
  return views.useVersion();
}
