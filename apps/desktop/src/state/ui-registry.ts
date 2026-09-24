/**
 * ONE SHAPE FOR THE RENDERER'S EXTENSION POINTS.
 *
 * The W0-A pre-wire (deliverables/research/PLAN.md §2.3) turned the hot UI files
 * — the thread, the composer, the sidebar, the top bar — into registries that a
 * feature extends from its OWN file (R1): a thread card, a menu row, a top-bar
 * notice, a composer mode, a route's view. Every one of them is this: items
 * keyed by id, kept in registration order, readable from plain code and from
 * React.
 *
 * The React side is `useSyncExternalStore` over a snapshot array that changes
 * identity ONLY when the registry changes — never per read. A selector that
 * built a fresh array on every call is exactly the zustand thrash footgun
 * (memory `pi-desktop-child-agents`), and a subscribed component with no
 * registrations must render exactly as it did before the registry existed.
 */
import { useSyncExternalStore } from 'react';

export interface RegistryItem {
  readonly id: string;
}

export interface UiRegistry<T extends RegistryItem> {
  /** Add an item; the same id replaces the old one in place. Returns the removal. */
  register(item: T): () => void;
  /** The items, in registration order. The same array until something changes. */
  list(): readonly T[];
  get(id: string): T | undefined;
  /** "My items' state changed" — re-renders every subscriber without re-registering. */
  touch(): void;
  subscribe(listener: () => void): () => void;
  /** React: the items, re-rendering on a change. */
  useItems(): readonly T[];
  /** React: a counter that moves on every change, `touch` included. */
  useVersion(): number;
}

export function createUiRegistry<T extends RegistryItem>(): UiRegistry<T> {
  const items = new Map<string, T>();
  const listeners = new Set<() => void>();
  let snapshot: readonly T[] = [];
  let version = 0;

  const changed = (): void => {
    snapshot = [...items.values()];
    version += 1;
    for (const l of [...listeners]) l();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const list = (): readonly T[] => snapshot;
  const getVersion = (): number => version;

  return {
    register(item) {
      items.set(item.id, item);
      changed();
      return () => {
        if (items.get(item.id) !== item) return;
        items.delete(item.id);
        changed();
      };
    },
    list,
    get: (id) => items.get(id),
    touch() {
      version += 1;
      for (const l of [...listeners]) l();
    },
    subscribe,
    useItems: () => useSyncExternalStore(subscribe, list, list),
    useVersion: () => useSyncExternalStore(subscribe, getVersion, getVersion),
  };
}
