/**
 * THE TURN'S SOURCES, HANDED DOWN TO ITS MARKDOWN.
 *
 * A link becomes a chip only when it points at a page THIS turn saw, so the
 * markdown renderer needs the turn's sources — and it renders text segments
 * one at a time, several per turn, with no idea which turn they belong to.
 * AssistantGroup knows (it holds the turn's calls and their results), so it
 * provides them here and everything below — the chips in any of the turn's
 * text segments, and the Sources card at its end — reads the same list.
 *
 * Outside a turn (a thought, a user bubble, a corp brief) there is no provider,
 * no source is known, and every link stays an ordinary link.
 */
import type { AssistantMsg, ToolResultMsg } from '@pi-desktop/engine';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { CITE_TAG, rehypeCitations } from './rehype-citations';
import {
  collectTurnSources,
  linkedKeys,
  orderForCard,
  sourceKey,
  type TurnCall,
  type TurnSource,
} from './source-model';

export interface TurnSources {
  /** Every page the turn saw, in the Sources card's order. */
  readonly ordered: readonly TurnSource[];
  readonly byKey: ReadonlyMap<string, TurnSource>;
  /** Keys the answer links to, first citation first. */
  readonly cited: readonly string[];
}

const TurnSourcesContext = createContext<TurnSources | null>(null);

/** The sources of the turn being rendered, or null outside one. */
export function useTurnSources(): TurnSources | null {
  return useContext(TurnSourcesContext);
}

/** The turn's tool calls, each with its result, in the order they were made. */
export function turnCalls(
  group: readonly AssistantMsg[],
  resultFor: ReadonlyMap<string, ToolResultMsg>,
): TurnCall[] {
  const calls: TurnCall[] = [];
  for (const m of group) {
    for (const b of m.blocks) {
      if (b.type !== 'toolCall') continue;
      const r = resultFor.get(b.id);
      calls.push({ name: b.name, args: b.arguments, ...(r !== undefined ? { result: r } : {}) });
    }
  }
  return calls;
}

/** The answer's own words, every text block of the turn. */
function answerText(group: readonly AssistantMsg[]): string {
  return group
    .flatMap((m) => m.blocks)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
}

/** Work out a turn's sources. Pure apart from React's memo — see the provider. */
export function buildTurnSources(
  group: readonly AssistantMsg[],
  resultFor: ReadonlyMap<string, ToolResultMsg>,
): TurnSources {
  const sources = collectTurnSources(turnCalls(group, resultFor));
  const byKey = new Map(sources.map((s) => [s.key, s] as const));
  const cited = linkedKeys(answerText(group)).filter((k) => byKey.has(k));
  return { ordered: orderForCard(sources, cited), byKey, cited };
}

export function TurnSourcesProvider({
  group,
  resultFor,
  children,
}: {
  group: readonly AssistantMsg[];
  resultFor: ReadonlyMap<string, ToolResultMsg>;
  children: ReactNode;
}) {
  const built = buildTurnSources(group, resultFor);
  /*
   * ONE OBJECT PER DISTINCT SET. The group re-renders on every streamed token;
   * the sources change only when a result lands or a new link is written. Keyed
   * on that, so the chips below do not see a "new" list forty times a second.
   */
  const signature = `${built.ordered.map((s) => `${s.key}|${s.title ?? ''}`).join('\n')}#${built.cited.join(' ')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the content signature on purpose
  const value = useMemo(() => built, [signature]);
  return <TurnSourcesContext.Provider value={value}>{children}</TurnSourcesContext.Provider>;
}

/**
 * The rehype pass for the markdown renderer, bound to this turn's sources — or
 * undefined when the turn saw none (the renderer then runs exactly as before).
 */
export function useCitationRehype() {
  const sources = useTurnSources();
  return useMemo(() => {
    if (sources === null || sources.byKey.size === 0) return undefined;
    const keyOf = (href: string): string | null => {
      const key = sourceKey(href);
      return key !== null && sources.byKey.has(key) ? key : null;
    };
    return [[rehypeCitations, { keyOf }]] as [[typeof rehypeCitations, { keyOf: typeof keyOf }]];
  }, [sources]);
}

export { CITE_TAG };
