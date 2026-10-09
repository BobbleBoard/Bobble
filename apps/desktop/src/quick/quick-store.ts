/**
 * The quick panel's own state — everything that is not the conversation (which
 * lives in the pi store, exactly as the main chat's does).
 */
import { create } from 'zustand';
import type { QuickContext, QuickTextAction } from '../../electron/quick/context';
import type { PanelSize } from '../../electron/quick/placement';
import type { QuickFrontApp, QuickProblem } from '../../electron/quick/quick-contract';
import type { TextFileAttachment } from '../chat/composer/agent-message';
import type { PanelProblem } from './quick-problem';

/** Which face the panel is showing. */
export type QuickView = 'home' | 'windows' | 'palette' | 'history';

/** A file dropped on the panel. */
export interface QuickAttachment extends TextFileAttachment {
  readonly id: string;
  /** A picture's pixels, as a data URI, when it is one. */
  readonly image?: string;
}

/** What a sent turn carried that its reply's buttons depend on. */
export interface TurnMeta {
  /** The reply is meant to replace the selection (Rewrite, Translate, Fix). */
  readonly replaces: boolean;
  /** The turn carried a selection from a field that takes text back. */
  readonly editableSelection: boolean;
  /** The app the selection came from, for the button's words. */
  readonly app?: string;
}

export interface QuickState {
  /** Shown, as far as the panel knows (main says so with quick:summoned / quick:hidden). */
  readonly shown: boolean;
  /** Increments per summon, so a component can react to "summoned again". */
  readonly summons: number;
  readonly front: QuickFrontApp | null;
  /** What is typed in the field. */
  readonly text: string;
  readonly contexts: readonly QuickContext[];
  readonly attachments: readonly QuickAttachment[];
  readonly view: QuickView;
  readonly size: PanelSize;
  readonly pinned: boolean;
  readonly capturing: 'region' | 'pick' | 'screen' | 'window' | null;
  /** The card above the composer: what could not happen, and its fix. */
  readonly problem: PanelProblem | null;
  /** What to run again when the card's Try again is pressed. */
  readonly retry: (() => void) | null;
  /** Something worth knowing about a read that worked. */
  readonly note: QuickProblem | null;
  /** The language Translate uses. */
  readonly language: string;
  readonly turnMeta: Readonly<Record<string, TurnMeta>>;
  /** When the thread was last used — a summon long after starts a fresh one. */
  readonly lastActivity: number;
  /** The global dictate key was pressed: the composer starts (or stops) listening. */
  readonly talkRequests: number;

  set(patch: Partial<Omit<QuickState, 'set'>>): void;
  addContext(c: QuickContext): void;
  removeContext(id: string): void;
  addAttachment(a: QuickAttachment): void;
  removeAttachment(id: string): void;
  showProblem(problem: PanelProblem | null, retry?: () => void): void;
}

/** The language a person reads, from the system locale; English when unknown. */
export function systemLanguage(): string {
  try {
    const tag = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const base = tag.split('-')[0] ?? 'en';
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
    return name !== undefined && name !== '' && base !== 'en' ? name : 'English';
  } catch {
    return 'English';
  }
}

export const useQuickStore = create<QuickState>((set) => ({
  shown: false,
  summons: 0,
  front: null,
  text: '',
  contexts: [],
  attachments: [],
  view: 'home',
  size: 'compact',
  pinned: false,
  capturing: null,
  problem: null,
  retry: null,
  note: null,
  language: systemLanguage(),
  turnMeta: {},
  lastActivity: 0,
  talkRequests: 0,
  set: (patch) => set(patch),
  addContext: (c) =>
    set((s) => {
      // One of each singular kind: a new selection or app replaces the old one.
      const singular = c.kind === 'selection' || c.kind === 'app' || c.kind === 'browser';
      const kept = singular ? s.contexts.filter((x) => x.kind !== c.kind) : s.contexts;
      return { contexts: [...kept, c], problem: null, retry: null };
    }),
  removeContext: (id) => set((s) => ({ contexts: s.contexts.filter((c) => c.id !== id) })),
  addAttachment: (a) => set((s) => ({ attachments: [...s.attachments, a] })),
  removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  showProblem: (problem, retry) => set({ problem, retry: retry ?? null }),
}));

/** The text actions offered on a selection, in the order they are shown. */
export const SELECTION_ACTIONS: readonly QuickTextAction[] = [
  'explain',
  'rewrite',
  'translate',
  'summarize',
  'fix',
];

/** A thread this long idle is not "the one you were in" any more. */
export const FRESH_THREAD_AFTER_MS = 10 * 60 * 1000;
