/**
 * Settings: a FLOATING, CENTERED panel over whatever view is behind it.
 *
 * It used to be a full-window surface that replaced the chat entirely. the user,
 * with a screenshot of Unsloth's settings dialog: "I want the settings to be a
 * not full window taking over thing, but instead floating panel center." So the
 * chat (or the models view) stays visible behind a dimmed backdrop, and closing
 * returns you exactly where you were rather than to a re-mounted chat.
 *
 * Model management is NOT in here any more — it is its own view that replaces
 * the chat area (see ModelsView). The `models` section id survives in the union
 * because the composer's model chip and the sidebar both address it; App routes
 * that id to the standalone view instead of opening this panel.
 */
import {
  Glyph,
  IconClose,
  IconPencil,
  IconSearch,
  IconSparkles,
  IconTerminal,
  ScrollArea,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../onboarding/cx';
import { IconShield, IconSlider, IconSun } from './icons';
import { AgentPanel } from './panels/AgentPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { CapabilitiesPanel } from './panels/CapabilitiesPanel';
import { ComputerUsePanel } from './panels/ComputerUsePanel';
import { ConnectorsPanel } from './panels/ConnectorsPanel';
import { ExperimentalPanel } from './panels/ExperimentalPanel';
import { HarnessPanel } from './panels/HarnessPanel';
import { InterfacePanel } from './panels/InterfacePanel';
import { PersonalizationPanel } from './panels/PersonalizationPanel';
import { SearchPanel } from './panels/SearchPanel';

export type SettingsSection =
  | 'models'
  | 'engines'
  | 'harness'
  | 'personalization'
  | 'appearance'
  | 'interface'
  | 'agent'
  | 'search'
  | 'connectors'
  | 'capabilities'
  | 'computer-use'
  | 'experimental';

/** Sections this panel renders. `models` is deliberately absent — it is a view. */
const NAV: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'personalization', label: 'Custom instructions', icon: <IconPencil /> },
  { id: 'harness', label: 'Harness', icon: <IconTerminal /> },
  { id: 'appearance', label: 'Appearance', icon: <IconSun /> },
  { id: 'interface', label: 'Interface', icon: <IconSlider /> },
  { id: 'agent', label: 'Agent', icon: <IconShield /> },
  // A window with its traffic lights and the agent's cursor (the user 2026-09-23).
  { id: 'computer-use', label: 'Computer use', icon: <Glyph name="computerUse" /> },
  { id: 'search', label: 'Web search', icon: <IconSearch /> },
  // "Extensions" on screen (the user, 2026-09-20); the section id stays.
  { id: 'connectors', label: 'Extensions', icon: <Glyph name="extensions" /> },
  { id: 'capabilities', label: 'Capabilities', icon: <IconSparkles /> },
  // The memory guard and the alternative inference engines — both experimental,
  // and marked the way everything experimental is: the flask.
  { id: 'experimental', label: 'Experimental', icon: <Glyph name="experimental" /> },
];

const TITLES: Record<SettingsSection, string> = {
  models: 'Models',
  engines: 'Engines',
  harness: 'Harness',
  personalization: 'Custom instructions',
  appearance: 'Appearance',
  interface: 'Interface',
  agent: 'Agent',
  search: 'Web search',
  connectors: 'Extensions',
  capabilities: 'Capabilities',
  'computer-use': 'Computer use',
  experimental: 'Experimental',
};

function SectionBody({
  section,
  onOpenGallery,
  onOpenConnectors,
  onRedoOnboarding,
}: {
  section: SettingsSection;
  onOpenGallery?: () => void;
  onOpenConnectors?: () => void;
  onRedoOnboarding?: () => void;
}) {
  switch (section) {
    // `engines` stays addressable (the composer's engine chip opens it) and
    // lands on the Experimental page, where the engines now live.
    case 'models':
    case 'engines':
    case 'experimental':
      return <ExperimentalPanel />;
    case 'harness':
      return <HarnessPanel />;
    case 'personalization':
      return <PersonalizationPanel />;
    case 'appearance':
      return <AppearancePanel />;
    case 'interface':
      return <InterfacePanel onOpenGallery={onOpenGallery} onRedoOnboarding={onRedoOnboarding} />;
    case 'agent':
      return <AgentPanel />;
    case 'search':
      return <SearchPanel />;
    case 'connectors':
      return <ConnectorsPanel onOpenConnectors={onOpenConnectors} />;
    case 'capabilities':
      return <CapabilitiesPanel />;
    case 'computer-use':
      return <ComputerUsePanel />;
  }
}

export function SettingsView({
  section,
  onSection,
  onClose,
  onOpenGallery,
  onOpenConnectors,
  onRedoOnboarding,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  /** Open the dev component gallery (round-5 #23: entry lives in Interface). */
  onOpenGallery?: () => void;
  /** Open the full Codex-style connectors gallery (its own top-level view). */
  onOpenConnectors?: () => void;
  /** Clear the first-run flag + re-open the onboarding wizard (Interface panel). */
  onRedoOnboarding?: () => void;
}) {
  const [query, setQuery] = useState('');
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * Escape closes, from anywhere in the panel — a floating dialog that can only
   * be dismissed by hitting a small X is the kind of thing that reads as broken.
   *
   * BUT NOT WHEN SOMETHING IS OVER IT. This listened on `document` and only
   * called `stopPropagation`, which does nothing to a listener already attached
   * to the same target — so one Escape dismissed the thing on top AND the
   * settings behind it. `defaultPrevented` plus the same "is a dialog open?"
   * check StudioShell already uses keeps the topmost layer the one that closes.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A palette, a menu or a nested dialog is above this panel and owns the key.
      if (document.querySelector('[data-escape-layer], [role="menu"]') !== null) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the dialog on open so Escape and tabbing work without a click.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const nav = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q.length === 0 ? NAV : NAV.filter((i) => i.label.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="pd-settings-enter fixed inset-0 z-50 flex items-center justify-center p-6">
      {/*
       * The backdrop is a real BUTTON sitting behind the panel, not a div with a
       * click handler. Same dismissal, but it is reachable and announced, and it
       * cannot swallow a click that merely bubbled out of the panel — which the
       * "is this my own event target" check was only approximating.
       */}
      {/* `--pd-bg-backdrop` / `--pd-blur-backdrop` are the same tokens the app's
          dialogs dim with (packages/ui/styles/dialog.css), so this scrim tracks
          the theme. A literal `bg-black/40` silently resolved to transparent in
          this Tailwind config — MEASURED as rgba(0,0,0,0) on the real screen. */}
      <button
        type="button"
        aria-label="Close settings"
        data-testid="settings-backdrop"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[var(--pd-bg-backdrop)] backdrop-blur-[var(--pd-blur-backdrop)]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="settings-view"
        className="relative flex h-[min(640px,100%)] w-[min(920px,100%)] overflow-hidden rounded-[var(--pd-radius-surface)] border border-border-default bg-bg-base shadow-[var(--pd-shadow-hairline),var(--pd-shadow-lg)] outline-none"
      >
        {/*
         * `bg-bg-sunken` was a class that does not exist: the @theme block in
         * global.css declares no `--color-bg-sunken`, so Tailwind emitted no
         * rule and the nav has been the same colour as the page beside it,
         * separated by its border alone. `bg-inset` is the real recessed token.
         */}
        <nav className="flex w-56 shrink-0 flex-col border-r border-border-default bg-bg-inset px-2 py-3">
          <div className="px-1 pb-2">
            <label className="sr-only" htmlFor={`${titleId}-search`}>
              Search settings
            </label>
            <input
              id={`${titleId}-search`}
              data-testid="settings-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              className="w-full rounded-lg border border-border-default bg-bg-base px-2.5 py-1.5 text-body text-text-primary placeholder:text-text-muted pd-focusable"
            />
          </div>

          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`settings-nav-${item.id}`}
              aria-current={
                item.id === section || (item.id === 'experimental' && section === 'engines')
                  ? 'page'
                  : undefined
              }
              onClick={() => onSection(item.id)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body',
                item.id === section || (item.id === 'experimental' && section === 'engines')
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              <span className="pd-chrome-icon shrink-0">{item.icon}</span>
              {item.label}
            </button>
          ))}
          {nav.length === 0 ? (
            <p className="px-3 py-2 text-footnote text-text-muted">No matching settings.</p>
          ) : null}

          <div
            className="mt-auto flex items-center gap-2.5 rounded-lg px-3 py-2"
            data-testid="settings-account"
          >
            <span className="pd-sidebar-avatar">B</span>
            <span className="min-w-0">
              <span className="block truncate text-body text-text-primary">Bobble</span>
              <span className="block text-footnote text-text-muted">Local · signed out</span>
            </span>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start justify-between gap-4 px-7 pt-6 pb-2">
            <h2 id={titleId} className="text-title text-text-primary">
              {TITLES[section]}
            </h2>
            <button
              type="button"
              data-testid="settings-back"
              aria-label="Close settings"
              onClick={onClose}
              className="-mr-1 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
            >
              <IconClose size={18} />
            </button>
          </div>

          <ScrollArea className="min-w-0 flex-1">
            <div className="px-7 pt-2 pb-7">
              <SectionBody
                section={section}
                onOpenGallery={onOpenGallery}
                onOpenConnectors={onOpenConnectors}
                onRedoOnboarding={onRedoOnboarding}
              />
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
