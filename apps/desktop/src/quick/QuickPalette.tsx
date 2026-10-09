/**
 * ⌘K in the quick panel — everything it can reach, searchable by what you
 * would call it: what to attach, the panel's own actions, Bobble's chats,
 * studios and settings, skills and commands, and the extensions to ask with.
 *
 * One ranked list (the chat palette's own scoring), grouped for reading.
 */
import {
  Glyph,
  IconAppWindow,
  IconAreaSelect,
  IconChat,
  IconClipboard,
  IconClock,
  IconCommand,
  IconExpand,
  IconExternal,
  IconFolderOpen,
  IconGlobe,
  IconImage,
  IconMonitor,
  IconPickWindow,
  IconPin,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconShrink,
  IconSparkles,
} from '@pi-desktop/ui';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { isReadableBrowser } from '../../electron/quick/browsers';
import { paletteScore } from '../chat/CommandPalette';
import { switchableConnectors } from '../chat/composer-connectors';
import { SETTINGS_NAV } from '../settings/sections';
import { displayTitle, useChatOrg } from '../state/chat-org';
import { useConnectorsStore } from '../state/connectors-store';
import { getCommands } from '../state/pi-connect';
import { ensureSessionList, useSessionListStore } from '../state/visible-projects';
import {
  attachFrontApp,
  captureInto,
  newThread,
  openInMain,
  openThreadInBobble,
  readInto,
  requestSize,
} from './quick-panel';
import { useQuickStore } from './quick-store';

interface Row {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

const SECTION_ORDER = [
  'Ask about',
  'This panel',
  'Chats',
  'Studios',
  'Skills and commands',
  'Extensions',
  'Bobble',
  'Settings',
];

/** Rank every row against the query, keep the best, then group by section. */
export function rankPaletteRows<R extends { section: string; label: string }>(
  rows: readonly R[],
  query: string,
  limit = 40,
): R[] {
  const ranked = rows
    .map((r) => ({ r, score: paletteScore(r.label, query.trim()) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
  if (query.trim() !== '') return ranked;
  return [...ranked].sort(
    (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
  );
}

export function QuickPalette(): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<
    Array<{ name: string; description?: string; source?: string }>
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useQuickStore();
  const sessions = useSessionListStore((s) => s.sessions);
  const org = useChatOrg();
  const connectors = useConnectorsStore();

  useEffect(() => {
    inputRef.current?.focus();
    void ensureSessionList();
    if (!useConnectorsStore.getState().loaded)
      void useConnectorsStore
        .getState()
        .load()
        .catch(() => undefined);
    void getCommands()
      .then((r) => setCommands(r.success ? r.commands : []))
      .catch(() => setCommands([]));
  }, []);

  const front = q.front;
  const draft = q.text.trim();
  const close = () => q.set({ view: 'home' });
  const insert = (text: string) => q.set({ view: 'home', text });

  // Built every render: a few dozen rows, and every input is store state.
  const rows: Row[] = (() => {
    const out: Row[] = [
      ...(front !== null && front.isBobble !== true
        ? [
            {
              id: 'window',
              section: 'Ask about',
              label: `The ${front.name} window`,
              hint: '⌘1',
              icon: <IconAppWindow size={15} />,
              run: () => void captureInto('front-window'),
            },
            {
              id: 'use-app',
              section: 'Ask about',
              label: `Do something in ${front.name}`,
              icon: <Glyph name="computerUse" size={15} />,
              run: () => {
                attachFrontApp();
                close();
              },
            },
          ]
        : []),
      {
        id: 'pick',
        section: 'Ask about',
        label: 'A window you pick',
        hint: '⌘2',
        icon: <IconPickWindow size={15} />,
        run: () => q.set({ view: 'windows' }),
      },
      {
        id: 'area',
        section: 'Ask about',
        label: 'An area of the screen',
        hint: '⌘3',
        icon: <IconAreaSelect size={15} />,
        run: () => void captureInto('region'),
      },
      {
        id: 'screen',
        section: 'Ask about',
        label: 'The whole screen',
        hint: '⌘4',
        icon: <IconMonitor size={15} />,
        run: () => void captureInto('screen'),
      },
      {
        id: 'clipboard',
        section: 'Ask about',
        label: 'What is on the clipboard',
        icon: <IconClipboard size={15} />,
        run: () => void readInto('clipboard'),
      },
      {
        id: 'finder',
        section: 'Ask about',
        label: 'The files selected in Finder',
        icon: <IconFolderOpen size={15} />,
        run: () => void readInto('finder'),
      },
      ...(front !== null && isReadableBrowser(front.name)
        ? [
            {
              id: 'browser',
              section: 'Ask about',
              label: `The page open in ${front.name}`,
              icon: <IconGlobe size={15} />,
              run: () => void readInto('browser'),
            },
          ]
        : []),
      {
        id: 'new',
        section: 'This panel',
        label: 'New thread',
        hint: '⌘N',
        icon: <Glyph name="newChat" size={15} />,
        run: () => void newThread(),
      },
      {
        id: 'recent',
        section: 'This panel',
        label: 'Recent threads',
        hint: '⌘Y',
        icon: <IconClock size={15} />,
        run: () => q.set({ view: 'history' }),
      },
      {
        id: 'size',
        section: 'This panel',
        label: q.size === 'large' ? 'Make the panel smaller' : 'Make the panel bigger',
        hint: '⌘E',
        icon: q.size === 'large' ? <IconShrink size={15} /> : <IconExpand size={15} />,
        run: () => {
          requestSize(q.size === 'large' ? 'expanded' : 'large');
          close();
        },
      },
      {
        id: 'pin',
        section: 'This panel',
        label: q.pinned ? 'Unpin the panel' : 'Pin the panel (stays open)',
        hint: '⌘⇧P',
        icon: <IconPin size={15} />,
        run: () => {
          const pinned = !q.pinned;
          q.set({ pinned, view: 'home' });
          void window.piDesktop.invoke('quick:set-pinned', { pinned });
        },
      },
      {
        id: 'open',
        section: 'This panel',
        label: 'Open this thread in Bobble',
        hint: '⌘↩',
        icon: <IconExternal size={15} />,
        run: () => void openThreadInBobble(q.text),
      },
      {
        id: 'new-chat',
        section: 'Bobble',
        label: draft !== '' ? `New chat in Bobble: “${draft}”` : 'New chat in Bobble',
        icon: <IconChat size={15} />,
        run: () => openInMain({ kind: 'new-chat', ...(draft !== '' ? { prompt: draft } : {}) }),
      },
      {
        id: 'image',
        section: 'Studios',
        label: draft !== '' ? `Make a picture: “${draft}”` : 'Make a picture in the Image studio',
        icon: <IconImage size={15} />,
        run: () =>
          draft !== ''
            ? openInMain({ kind: 'image-studio', prompt: draft })
            : openInMain({ kind: 'navigate', target: 'studio:image' }),
      },
      ...(['video', 'audio', '3d'] as const).map((studio) => ({
        id: `studio-${studio}`,
        section: 'Studios',
        label: `Open the ${studio === '3d' ? '3D' : studio[0]?.toUpperCase() + studio.slice(1)} studio`,
        icon: <IconSparkles size={15} />,
        run: () => openInMain({ kind: 'navigate', target: `studio:${studio}` }),
      })),
      {
        id: 'quick-settings',
        section: 'Settings',
        label: 'Quick panel settings and hotkeys',
        icon: <IconSettings size={15} />,
        run: () => openInMain({ kind: 'navigate', target: 'settings:quick-panel' }),
      },
      ...SETTINGS_NAV.filter((s) => s.id !== 'quick-panel').map((s) => ({
        id: `settings-${s.id}`,
        section: 'Settings',
        label: `Settings: ${s.label}`,
        icon: <IconSettings size={15} />,
        run: () => openInMain({ kind: 'navigate', target: `settings:${s.id}` }),
      })),
      {
        id: 'extensions',
        section: 'Bobble',
        label: 'Manage extensions',
        icon: <IconPuzzle size={15} />,
        run: () => openInMain({ kind: 'navigate', target: 'view:connectors' }),
      },
      ...commands.map((c) => ({
        id: `cmd-${c.name}`,
        section: 'Skills and commands',
        label: `/${c.name}`,
        ...(c.description !== undefined ? { hint: c.description.slice(0, 48) } : {}),
        icon: <IconCommand size={15} />,
        run: () => insert(`/${c.name} `),
      })),
      ...switchableConnectors(connectors)
        .filter((c) => c.on)
        .map((c) => ({
          id: `ext-${c.id}`,
          section: 'Extensions',
          label: `Ask with ${c.name}`,
          icon: <IconPuzzle size={15} />,
          run: () => insert(`Use ${c.name} to `),
        })),
      ...sessions.slice(0, 60).map((s) => ({
        id: `chat-${s.file}`,
        section: 'Chats',
        label: displayTitle(s, org),
        hint: 'Open in Bobble',
        icon: <IconChat size={15} />,
        run: () => openInMain({ kind: 'open-session', file: s.file }),
      })),
    ];
    return out;
  })();

  // Chats only when searching: twelve of them by default would bury the actions.
  const pool = query.trim() === '' ? rows.filter((r) => r.section !== 'Chats') : rows;
  const visible = rankPaletteRows(pool, query, query.trim() === '' ? 24 : 30);

  const runAt = (i: number) => {
    const row = visible[i];
    if (row === undefined) return;
    row.run();
  };

  let lastSection = '';
  return (
    <div data-testid="quick-palette">
      <div className="qp-view-head">
        <h2 className="pd-display-s">Commands</h2>
      </div>
      <div className="qp-search">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search actions, chats, studios, settings"
          aria-label="Search commands"
          data-testid="quick-palette-input"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(visible.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runAt(active);
            }
          }}
        />
      </div>
      <div className="qp-list" role="listbox" aria-label="Commands">
        {visible.length === 0 ? <p className="qp-empty">Nothing matches that.</p> : null}
        {visible.map((r, i) => {
          const head = r.section !== lastSection ? r.section : null;
          lastSection = r.section;
          return (
            <div key={r.id} className="contents">
              {head !== null ? <div className="qp-list-section">{head}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className="qp-list-row"
                data-active={i === active ? 'true' : 'false'}
                data-testid={`quick-palette-row-${r.id}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
              >
                {r.icon}
                <span className="qp-list-label">{r.label}</span>
                {r.hint !== undefined ? <span className="qp-list-hint">{r.hint}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
