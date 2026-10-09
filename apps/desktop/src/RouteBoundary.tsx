/**
 * ONE ROUTE'S ERROR BOUNDARY — so a screen that cannot draw is a screen, not
 * the app.
 *
 * The app-wide boundary (AppErrorBoundary) is the LAST resort and stays exactly
 * that. Everything lazily imported goes through {@link lazyRoute} instead, which
 * wraps the route in a boundary of its own: the failure is contained to the
 * frame that route was drawing in, the sidebar and the top bar and the chat keep
 * running, and the panel offers the one action that actually fixes the common
 * cause — fetch the file again.
 *
 * Why the retry has to build a NEW lazy component, which is the whole trick:
 * React caches a lazy's rejected promise on the component object forever. Render
 * the same `lazy()` again and it re-throws the SAME error without calling the
 * importer, so a retry button over one lazy component is a button that cannot
 * work. Each attempt therefore gets its own lazy (cached by attempt so a
 * StrictMode double-render cannot double-import).
 *
 * See route-chunk.ts for what the panel is allowed to say and why the secondary
 * button reloads the DOCUMENT for a missing chunk but soft-reloads for a render
 * throw.
 */
import {
  Component,
  type ComponentProps,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useState,
} from 'react';
import { hardReload, softReload } from './app-reload';
import { bustedChunkUrl, chunkUrlFromError, loadRouteChunk, routePanel } from './route-chunk';

/**
 * How the failure is drawn.
 *
 * `panel` fills the route's own frame with a card — right for a studio or a
 * workspace, which owns the whole content area.
 *
 * `inline` is for the handful of lazy pieces that are not screens: the 3D
 * studio's two top-bar buttons come out of the same chunk as its workspace, and
 * a full card in the title bar would be a worse failure than the one it is
 * reporting. It draws a single small "Retry" chip in the space the controls
 * would have taken.
 */
export type RouteVariant = 'panel' | 'inline';

interface BoundaryProps {
  readonly label: string;
  readonly variant: RouteVariant;
  /** Imports attempted so far, including the one that just failed. */
  readonly attempts: number;
  /** Handed the error, so the retry can dodge the poisoned module-map entry. */
  readonly onRetry: (error: unknown) => void;
  readonly children: ReactNode;
}

class RouteErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only, like the app-wide boundary: the point is that the rest of
    // the window survived, not that we ship a report.
    console.error(`Bobble route error (${this.props.label})`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null || error === undefined) return this.props.children;
    const { label, variant, attempts, onRetry } = this.props;
    const panel = routePanel({ label, error, attempts });
    const reload = panel.reload === 'document' ? () => hardReload() : softReload;

    if (variant === 'inline') {
      return (
        <span className="pd-route-inline" data-testid="route-error" data-route={label}>
          <span className="pd-route-inline-text" title={panel.detail}>
            {label} unavailable
          </span>
          {panel.canRetry ? (
            <button
              type="button"
              className="pd-route-inline-action pd-focusable"
              data-testid="route-error-retry"
              onClick={() => onRetry(error)}
            >
              Retry
            </button>
          ) : (
            <button
              type="button"
              className="pd-route-inline-action pd-focusable"
              data-testid="route-error-reload"
              onClick={reload}
            >
              {panel.reloadLabel}
            </button>
          )}
        </span>
      );
    }

    return (
      <div className="pd-route-error" data-testid="route-error" data-route={label}>
        <div className="pd-route-error-card">
          <h2 className="pd-route-error-title">{panel.title}</h2>
          <p className="pd-route-error-copy">{panel.copy}</p>
          {/* The error's own words, for a bug report — under Details, not as
              the message (2026-10-08). */}
          <details className="pd-route-error-more">
            <summary>Details</summary>
            <pre className="pd-route-error-detail" data-testid="route-error-detail">
              {panel.detail}
            </pre>
          </details>
          <div className="pd-route-error-actions">
            {panel.canRetry ? (
              <button
                type="button"
                className="pd-route-error-primary pd-focusable"
                data-testid="route-error-retry"
                onClick={() => onRetry(error)}
              >
                Try again
              </button>
            ) : null}
            {/*
              The existing recovery, never a second one. `hardReload` for a
              missing chunk (the document's module graph still names the file
              that is gone, so only re-reading index.html helps) and `softReload`
              for a route that loaded and then threw — see route-chunk.ts.
            */}
            <button
              type="button"
              className={
                panel.canRetry
                  ? 'pd-route-error-secondary pd-focusable'
                  : 'pd-route-error-primary pd-focusable'
              }
              data-testid="route-error-reload"
              onClick={reload}
            >
              {panel.reloadLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * The prop shape a route component may have.
 *
 * `any` deliberately, mirroring React's own `lazy<T extends ComponentType<any>>`:
 * a narrower constraint makes every prop-less route (which is most of them) fail
 * to infer, and `ComponentProps<T>` below cannot be formed at all.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above — this is React's own constraint
type AnyComponent = ComponentType<any>;

/**
 * One lazy component per (route, attempt).
 *
 * Held outside the component so that re-rendering — including StrictMode's
 * double render in development — cannot produce a second lazy for the same
 * attempt and therefore a second import. Bounded by MAX_ROUTE_RETRIES + 1
 * entries per route (route-chunk.ts).
 */
const byAttempt = new Map<string, LazyExoticComponent<AnyComponent>>();

function lazyForAttempt<T extends AnyComponent>(
  label: string,
  attempt: number,
  load: () => Promise<{ default: T }>,
): ComponentType<ComponentProps<T>> {
  const key = `${label}#${attempt}`;
  const cached = byAttempt.get(key);
  if (cached !== undefined) return cached as unknown as ComponentType<ComponentProps<T>>;
  const made = lazy(load) as unknown as LazyExoticComponent<AnyComponent>;
  byAttempt.set(key, made);
  return made as unknown as ComponentType<ComponentProps<T>>;
}

/**
 * WHERE EACH ROUTE HAS GOT TO, kept at module scope rather than in the
 * component.
 *
 * Two reasons, both learned the hard way. A retried route that recovered at
 * attempt 1 must not drop back to attempt 0 when you navigate away and return —
 * attempt 0's lazy is permanently poisoned (see chunkUrlFromError), so it would
 * flash the panel again on a route that is perfectly fine. And the retry budget
 * is about a person clicking a button, not about a component's lifetime: a
 * remount must not hand out a fresh set of attempts.
 */
interface RouteAttempt {
  readonly n: number;
  /** The URL that failed, so the next attempt can dodge the module map. */
  readonly url: string | null;
}
const FIRST_ATTEMPT: RouteAttempt = { n: 0, url: null };
const attemptByRoute = new Map<string, RouteAttempt>();

/**
 * Wrap a lazily-imported route in its own boundary.
 *
 * Call at module scope exactly where `lazy()` used to be called, and render the
 * result the same way. `label` is what the panel calls this route to the person
 * looking at it, and is also its `data-route` in the DOM.
 *
 * `pick` selects the component out of the imported module (`(m) => m.ImageStudio`,
 * or `(m) => m.default`). It is REQUIRED, and not for tidiness: a retry cannot
 * re-run the bundler's own specifier — that specifier is poisoned in the module
 * map — so it re-imports the failed URL with a cache-busting query and has to
 * apply the same selection to whatever comes back.
 */
export function lazyRoute<M, T extends AnyComponent>(
  label: string,
  importer: () => Promise<M>,
  options: {
    readonly pick: (module: M) => T;
    readonly variant?: RouteVariant;
    readonly fallback?: ReactNode;
  },
): ComponentType<ComponentProps<T>> {
  const variant = options.variant ?? 'panel';
  const { pick } = options;

  const load = (attempt: RouteAttempt): Promise<{ default: T }> => {
    /*
     * The FIRST load is the bundler's own import, so the chunk is discovered,
     * hashed and preloaded exactly as before. Only a retry goes near the URL —
     * and only when the failure named a script (a CSS preload failure names a
     * stylesheet, which must not be imported as a module).
     */
    return loadRouteChunk(label, () =>
      attempt.n > 0 && attempt.url !== null
        ? (import(/* @vite-ignore */ bustedChunkUrl(attempt.url, attempt.n)) as Promise<M>)
        : importer(),
    ).then((m) => ({ default: pick(m) }));
  };

  function Route(props: ComponentProps<T>): ReactNode {
    const [attempt, setAttempt] = useState<RouteAttempt>(
      () => attemptByRoute.get(label) ?? FIRST_ATTEMPT,
    );
    const retry = useCallback((error: unknown) => {
      setAttempt((current) => {
        const next: RouteAttempt = {
          n: current.n + 1,
          url: chunkUrlFromError(error) ?? current.url,
        };
        attemptByRoute.set(label, next);
        return next;
      });
    }, []);
    const Loaded = lazyForAttempt(label, attempt.n, () => load(attempt));
    return (
      /* Keyed on the attempt so a retry throws the failed subtree away —
         boundary state included, which is what clears the panel. */
      <RouteErrorBoundary
        key={attempt.n}
        label={label}
        variant={variant}
        attempts={attempt.n + 1}
        onRetry={retry}
      >
        {/* `null` by default — the same nothing these routes showed before, so
            adding a boundary does not also add a flash of "loading". */}
        <Suspense fallback={options.fallback ?? null}>
          <Loaded {...props} />
        </Suspense>
      </RouteErrorBoundary>
    );
  }
  Route.displayName = `LazyRoute(${label})`;
  return Route;
}
