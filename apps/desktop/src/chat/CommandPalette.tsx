/**
 * ⌘K — one way in, instead of a growing table of keys.
 *
 * The app had accumulated ⌘N, ⌘P, ⌘T, ⌘U and a sidebar of destinations, and the
 * only way to learn any of it was to already know. A palette is the shape that
 * scales: everything the app can do, searchable by what you would call it.
 *
 * ONE LIST, NOT FOUR. Chats, commands and actions are ranked together against
 * the same query, because a person typing "sett" does not first decide which
 * category "Settings" lives in. Sections label the results; they do not gate
 * them.
 *
 * NOT `Autocomplete`. That component is welded to the composer — `absolute
 * bottom-full`, a closed four-member kind union, a "tab to accept" footer — and
 * bending it into a centred modal would leave both worse.
 */

import { IconChat, IconSearch, IconTerminal } from '@pi-desktop/ui';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { displayTitle, useChatOrg } from '../state/chat-org';
import { getCommands, newSession, switchSession } from '../state/pi-connect';
import { ensureSessionList, useSessionListStore } from '../state/visible-projects';

export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void | Promise<void>;
}

interface Row {
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
  readonly section: 'Actions' | 'Chats' | 'Commands';
  readonly hint?: string;
  readonly run: () => void | Promise<void>;
}

/**
 * Subsequence match with a bias toward word starts.
 *
 * Deliberately not fuzzy-with-a-library: the corpus is a few hundred short
 * labels, and a person typing `nc` wants "New chat" — the initials — far more
 * than they want anything a scoring model would surface.
 */
export function paletteScore(label: string, query: string): number {
  if (query === '') return 1;
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (l === q) return 1000;
  if (l.startsWith(q)) return 500;

  // Initials: "nc" → "New chat".
  const initials = l
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w[0] ?? '')
    .join('');
  if (initials.startsWith(q)) return 400;
  if (l.includes(q)) return 300 - l.indexOf(q);

  // Subsequence, scored by how tightly the letters sit together.
  let i = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const at = l.indexOf(ch, i);
    if (at === -1) return 0;
    if (last !== -1) gaps += at - last - 1;
    last = at;
    i = at + 1;
  }
  return Math.max(1, 100 - gaps);
}

/**
 * Rank across every section, then present the winners in coherent blocks.
 *
 * The ranking has to be global — a person typing "set up" wants that CHAT, and
 * making them pick a category first is the thing a palette exists to remove.
 * But rendering the globally-ranked order directly interleaves the headers
 * (CHATS, ACTIONS, CHATS, ACTIONS…), which reads as a bug and is unscannable.
 *
 * So: rank, take the top N, then group — with each section ordered by its own
 * best row, so the section holding the strongest match still comes first.
 */
export function rankRows(rows: readonly Row[], query: string, limit = 12): Row[] {
  const ranked = rows
    .map((r) => ({ r, score: paletteScore(`${r.label} ${r.subtitle ?? ''}`, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.r.label.length - b.r.label.length)
    .slice(0, limit);

  const order: string[] = [];
  const bySection = new Map<string, Row[]>();
  for (const { r } of ranked) {
    const bucket = bySection.get(r.section);
    if (bucket === undefined) {
      order.push(r.section);
      bySection.set(r.section, [r]);
    } else {
      bucket.push(r);
    }
  }
  return order.flatMap((section) => bySection.get(section) ?? []);
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  onEnterChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Host-supplied actions — the things only the shell can do. */
  actions: readonly PaletteAction[];
  onEnterChat?: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionListStore((s) => s.sessions);
  // Renames live here, not in the session file — the palette must show what the
  // sidebar shows or the same chat has two names.
  const org = useChatOrg();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    void ensureSessionList();
    void getCommands()
      .then((res) => setCommands(res.success ? res.commands : []))
      .catch(() => setCommands([]));
    // Focus after paint so the caret lands in the field, not on the backdrop.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /*
   * ESCAPE BELONGS TO THE PALETTE, NOT TO ITS INPUT.
   *
   * It used to live on the input's `onKeyDown`, which works only while the
   * caret is in the field — and the caret is not always there. Opening the
   * palette over Settings hands focus to the field one tick after paint, and a
   * dialog underneath can take it straight back; clicking a row, or anywhere in
   * the palette that is not the field, does the same. Escape then reaches
   * nothing at all and the palette simply will not close.
   *
   * MEASURED as a probe that passed on its own and failed inside the suite —
   * the probes share a HOME, so whether Settings was left in a focus-trapping
   * state depended on a run forty probes earlier. That is the signature of a
   * handler that depends on where focus happens to be.
   *
   * On `document` in the CAPTURE phase, so it runs before anything underneath,
   * and only while this palette is the LAST `[data-escape-layer]` in the
   * document — whatever opens above it owns Escape instead.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const layers = document.querySelectorAll('[data-escape-layer]');
      if (layers[layers.length - 1] !== rootRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange]);

  const rows = useMemo((): Row[] => {
    const out: Row[] = actions.map((a) => ({
      id: `action:${a.id}`,
      label: a.label,
      section: 'Actions' as const,
      ...(a.hint !== undefined ? { hint: a.hint } : {}),
      run: a.run,
    }));
    for (const s of sessions.slice(0, 200)) {
      out.push({
        id: `chat:${s.file}`,
        label: displayTitle(s, org),
        subtitle: s.cwdLabel,
        section: 'Chats',
        run: async () => {
          onEnterChat?.();
          await switchSession(s.file);
        },
      });
    }
    for (const c of commands) {
      out.push({
        id: `cmd:${c.name}`,
        label: `/${c.name}`,
        ...(c.description !== undefined ? { subtitle: c.description } : {}),
        section: 'Commands',
        run: () => {
          if (c.name === 'new') void newSession();
        },
      });
    }
    return out;
  }, [actions, sessions, commands, onEnterChat, org]);

  const visible = useMemo(() => rankRows(rows, query), [rows, query]);

  if (!open) return null;

  const pick = (row: Row | undefined): void => {
    if (row === undefined) return;
    onOpenChange(false);
    void row.run();
  };

  let lastSection: string | undefined;
  return (
    // `data-escape-layer` is what tells the layers underneath — Settings, the
    // studios — that something is above them and owns Escape.
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside dismissal; Escape is the keyboard equivalent.
    <div
      ref={rootRef}
      className="pd-palette-backdrop"
      data-escape-layer
      data-testid="command-palette"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="pd-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="pd-palette-field">
          <IconSearch size={15} className="pd-palette-field-icon" />
          <input
            ref={inputRef}
            className="pd-palette-input"
            data-testid="command-palette-input"
            placeholder="Search chats, commands and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, Math.max(0, visible.length - 1)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(visible[selected]);
              }
            }}
          />
        </div>
        <div className="pd-palette-list" role="listbox">
          {visible.length === 0 ? (
            <div className="pd-palette-empty">Nothing matches that.</div>
          ) : (
            visible.map((row, i) => {
              const header = row.section !== lastSection;
              lastSection = row.section;
              return (
                <div key={row.id}>
                  {header ? <div className="pd-palette-section">{row.section}</div> : null}
                  {/* Focus deliberately STAYS in the input — that is what makes
                      typing and the arrow keys work at the same time — so the
                      rows are a listbox the input drives, not tab stops. */}
                  {/* biome-ignore lint/a11y/useFocusableInteractive: the input owns focus and drives selection. */}
                  <div
                    role="option"
                    aria-selected={i === selected}
                    data-selected={i === selected ? 'true' : undefined}
                    className="pd-palette-row"
                    onMouseEnter={() => setSelected(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(row);
                    }}
                  >
                    <span className="pd-palette-row-icon">
                      {row.section === 'Chats' ? (
                        <IconChat size={14} />
                      ) : row.section === 'Commands' ? (
                        <IconTerminal size={14} />
                      ) : (
                        <IconSearch size={14} />
                      )}
                    </span>
                    <span className="pd-palette-row-label">{row.label}</span>
                    {row.subtitle !== undefined ? (
                      <span className="pd-palette-row-sub">{row.subtitle}</span>
                    ) : null}
                    {row.hint !== undefined ? (
                      <span className="pd-palette-row-hint">{row.hint}</span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
