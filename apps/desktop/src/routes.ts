/**
 * THE WORKSPACE SCREENS — the content routes the chat shell can show in place
 * of the conversation, with their top-bar titles.
 *
 * App.tsx used to spell these out as two parallel ternary chains (one for the
 * title, one for the screen), which every new screen would have had to edit in
 * both places. They are a registry now (the W0-A pre-wire,
 * deliverables/research/PLAN.md §2.3): the three that exist, and two planned
 * ones — Training (TR-5) and Workflows (WF-11) — whose screens are registered
 * by their lanes from their own files with {@link registerRouteView}. A planned
 * route with no view registered does not exist as far as the app is concerned:
 * no title, no screen, no link to it.
 *
 * The studios are NOT here: they are modalities (state/modality-store.ts), shown
 * first when one is open, exactly as before.
 */
import { createElement, type ReactNode } from 'react';
import { ConnectorsScreen } from './connectors/ConnectorsScreen';
import { ModelsView } from './models/ModelsView';
import { PLANNED_ROUTES, type RouteContext, routeView, useRouteViewsVersion } from './route-views';
import { ScheduledView } from './scheduled/ScheduledView';

export {
  PLANNED_ROUTES,
  type PlannedRoute,
  type RouteContext,
  registerRouteView,
} from './route-views';

/**
 * Which view the shell shows. `chat` is the conversation; `gallery` is the dev
 * component gallery (a window takeover, not a content route); the rest are
 * content routes.
 */
export type MainView =
  | 'chat'
  | 'gallery'
  | 'models'
  | 'connectors'
  | 'scheduled'
  | 'training'
  | 'workflows';

export interface ContentRoute {
  readonly id: MainView;
  /** The top bar's title while the route is shown (in place of the chat's name). */
  readonly title: string;
  readonly render: (ctx: RouteContext) => ReactNode;
}

/** The routes that ship today. */
const BUILT_IN: Partial<Record<MainView, ContentRoute>> = {
  models: {
    id: 'models',
    title: 'Models',
    render: () => createElement(ModelsView),
  },
  scheduled: {
    id: 'scheduled',
    title: 'Scheduled',
    render: () => createElement(ScheduledView),
  },
  connectors: {
    id: 'connectors',
    title: 'Extensions',
    render: (ctx) => createElement(ConnectorsScreen, { onTryInChat: ctx.tryInChat }),
  },
};

/** The content route for a view, or undefined (the chat, the gallery, a planned route with no screen). */
export function contentRoute(view: MainView): ContentRoute | undefined {
  const built = BUILT_IN[view];
  if (built !== undefined) return built;
  if (view === 'training' || view === 'workflows') {
    const screen = routeView(view);
    if (screen === undefined) return undefined;
    return {
      id: view,
      title: PLANNED_ROUTES[view],
      render: (ctx) => createElement(screen, ctx),
    };
  }
  return undefined;
}

/** React: the content route for a view, following registrations. */
export function useContentRoute(view: MainView): ContentRoute | undefined {
  useRouteViewsVersion();
  return contentRoute(view);
}

/** The content routes a link may open right now (for the `bobble:` allow-list). */
export function availableRoutes(): MainView[] {
  return (['models', 'connectors', 'scheduled', 'training', 'workflows'] as const).filter(
    (v) => contentRoute(v) !== undefined,
  );
}
