/**
 * The Codex-style connectors gallery — a full-window surface (like Settings)
 * with a Back-to-chat affordance, Plugins / Skills tabs, a "Create ▾" menu, and
 * a search field.
 *
 * The Plugins tab is a 2-column SECTIONED grid — By us / Recommended for you /
 * Official / Popular (see connector-sections.ts) — where each card carries a
 * "+" add button (or a Preinstalled / Installed state). Selecting a card opens a
 * real detail view (its tools + config), not a dead description. "Recommended
 * for you" is driven by the /Applications scan (Blender-installed ⇒ Blender
 * pinned). Search filters within every section.
 *
 * Install / enable / disable / remove round-trip through the connectors:* IPC
 * (which persists ~/.pi/desktop/mcp-connectors.json — the mcp-lite extension
 * re-reads it on the next pi session). The MCP mode control reuses the settings
 * store so lite / native / bash-cli stays single-sourced.
 */
import type { KnownConnector, McpMode } from '@pi-desktop/mcp-lite';
import {
  Button,
  IconPlus,
  ScrollArea,
  SearchInput,
  SegmentedControl,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import { installedServer, isEnabled, useConnectorsStore } from '../state/connectors-store';
import { useSettingsStore } from '../state/settings-store';
import { AddServerDialog } from './AddServerDialog';
import { ConnectorCard } from './ConnectorCard';
import { ConnectorDetail } from './ConnectorDetail';
import { ConnectorSection } from './ConnectorSection';
import { ConnectPermissionDialog } from './ConnectPermissionDialog';
import { buildConnectorSections } from './connector-sections';
import { SkillsTab } from './SkillsTab';

/** Renderer-safe mirror of mcp-lite's connectorNeedsConfig (kept local so the
 * renderer never imports the node-touching detect-apps module). */
function needsConfig(connector: KnownConnector): boolean {
  if (connector.requiresEnv !== undefined && connector.requiresEnv.length > 0) return true;
  return (connector.template.args ?? []).some((a) => /<[^>]+>/.test(a));
}

const MODE_OPTIONS: Array<{ value: McpMode; label: string }> = [
  { value: 'lite', label: 'Lite' },
  { value: 'native', label: 'Native' },
  { value: 'bash-cli', label: 'Bash CLI' },
];

/** One-line explanation of each connector run mode, shown under the toggle. */
const MODE_HINTS: Record<McpMode, string> = {
  lite: 'Compact proxy. Tools are summarized and fetched on demand, so many connectors fit a small context.',
  native: 'Every connector tool goes straight to the model. Most capable, uses the most context.',
  'bash-cli': 'Driven from the terminal through a discoverable `--help` surface.',
};

export function ConnectorsScreen() {
  const registry = useConnectorsStore((s) => s.registry);
  const upsert = useConnectorsStore((s) => s.upsert);
  const [addOpen, setAddOpen] = useState(false);
  const catalog = useConnectorsStore((s) => s.catalog);
  const recommended = useConnectorsStore((s) => s.recommended);
  const busyId = useConnectorsStore((s) => s.busyId);
  const load = useConnectorsStore((s) => s.load);
  const install = useConnectorsStore((s) => s.install);
  const setEnabled = useConnectorsStore((s) => s.setEnabled);
  const remove = useConnectorsStore((s) => s.remove);

  const mode = useSettingsStore((s) => s.settings.mcpMode);
  const updateSettings = useSettingsStore((s) => s.update);

  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<KnownConnector | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => catalog.find((c) => c.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  // Connect: connectors that need secrets/auth go through the permission popup;
  // plain local ones install straight away.
  const connect = (connector: KnownConnector) => {
    if (needsConfig(connector)) setPendingConnect(connector);
    else void install(connector.id);
  };
  const confirmConnect = (connector: KnownConnector) => {
    setPendingConnect(null);
    void install(connector.id);
  };

  const installedIds = new Set(registry.servers.map((s) => s.id));
  /*
   * A HAND-ADDED SERVER IS A CONNECTOR TOO. The gallery is built from the
   * catalog, so anything added through "Add MCP server" was live and invisible —
   * see the note on `addedByYou` in connector-sections.ts. The catalog's shape is
   * what the cards render, so a registry entry is dressed as one: what we truly
   * know is its name and the command that starts it, and that is what it says.
   */
  const catalogIds = useMemo(() => new Set(catalog.map((c) => c.id)), [catalog]);
  const addedByYou = useMemo(
    () =>
      registry.servers
        .filter((srv) => !catalogIds.has(srv.id))
        .map(
          (srv): KnownConnector => ({
            id: srv.id,
            name: srv.name,
            icon: srv.icon ?? '🔌',
            description:
              srv.description ??
              `Runs ${[srv.command, ...(srv.args ?? [])].join(' ').slice(0, 90)} · added by you`,
            category: 'dev',
            official: false,
            /* Its own configuration IS the template — re-adding it can only
               mean "the thing that is already there". */
            template: { ...srv, enabled: undefined } as KnownConnector['template'],
          }),
        ),
    [registry.servers, catalogIds],
  );
  const sections = useMemo(
    () =>
      buildConnectorSections(
        catalog,
        recommended.map((r) => r.id),
        query,
        addedByYou,
      ),
    [catalog, recommended, query, addedByYou],
  );

  return (
    <div
      className="pd-settings-enter flex h-full flex-col bg-bg-base"
      data-testid="connectors-screen"
    >
      {/*
        NO BACK BUTTON, NO TRAFFIC-LIGHT STRIP.
        This screen used to take the whole window, so it had to reinvent both —
        while the Model hub and Scheduled, one row away in the same sidebar
        section, rendered inside the chat shell and kept it. Three sibling
        screens, three navigation models; picking one row emptied the sidebar and
        the other two did not. It is a content route now, like them: the shell
        owns the chrome, and the way out is the sidebar you never lost.
      */}
      {selected !== null ? (
        <ScrollArea className="min-h-0 flex-1">
          <ConnectorDetail
            connector={selected}
            installed={installedServer(registry, selected.id)}
            busy={busyId === selected.id}
            onBack={() => setSelectedId(null)}
            onConnect={connect}
            onSetEnabled={(id, enabled) => void setEnabled(id, enabled)}
            onRemove={(id) => {
              void remove(id);
              setSelectedId(null);
            }}
          />
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Header: title + Create menu, tabs, then search. */}
          <div className="mx-auto w-full max-w-[880px] px-8 pt-1">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h1 className="text-title text-text-primary">Connectors</h1>
              {/*
                A MENU OF ONE IS A BUTTON.

                This was a "Create ▾" dropdown listing "Create plugin", "Add
                marketplace", "Record a skill" and "Request a plugin", every one
                of them `onSelect={() => undefined}`. The thing people actually
                want — point the app at an MCP server it does not know about —
                already had its IPC handler, its registry writer and a store
                action with zero callers, and no way in. The other three describe
                features that do not exist, so once they went there was one row
                left behind a chevron, which is a button wearing a costume.
              */}
              <Button
                variant="primary"
                size="sm"
                data-testid="connectors-add-server"
                onClick={() => setAddOpen(true)}
              >
                <IconPlus size={14} /> Add MCP server
              </Button>
              <AddServerDialog
                open={addOpen}
                onOpenChange={setAddOpen}
                onAdd={(server) => void upsert(server)}
              />
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as 'plugins' | 'skills')}>
              <TabsList className="w-fit">
                {/*
                  NOT "Plugins". The title says Connectors, the search says
                  connectors, the detail says MCP server, and this said plugins —
                  four names for the same thing on one screen, which is exactly
                  the confusion the user points at in the apps this is modelled on.
                  Bobble has tools and skills; there is no third thing, so there
                  is no third word.
                */}
                <TabsTrigger value="plugins" data-testid="connectors-tab-plugins">
                  Tools
                </TabsTrigger>
                <TabsTrigger value="skills" data-testid="connectors-tab-skills">
                  Skills
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tab === 'plugins' ? (
              <div className="mt-3">
                <SearchInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tools"
                  data-testid="connectors-search"
                />
              </div>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-[880px] px-8 py-5">
              {tab === 'skills' ? (
                <SkillsTab />
              ) : (
                <div className="flex flex-col gap-6">
                  {/* MCP mode control + a one-line explanation of the active mode. */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-footnote text-text-muted">How connectors run</span>
                      <SegmentedControl
                        aria-label="MCP mode"
                        data-testid="connectors-mcp-mode"
                        value={mode}
                        onValueChange={(v) => void updateSettings({ mcpMode: v as McpMode })}
                        options={MODE_OPTIONS}
                      />
                    </div>
                    <p
                      className="text-caption text-text-muted leading-relaxed"
                      data-testid="connectors-mode-hint"
                    >
                      {MODE_HINTS[mode]}
                    </p>
                  </div>

                  {/* Sectioned 2-column grid. */}
                  {sections.length === 0 ? (
                    <p className="text-footnote text-text-muted" data-testid="connectors-empty">
                      No connectors match your search.
                    </p>
                  ) : (
                    sections.map((section) => (
                      <ConnectorSection
                        key={section.id}
                        id={section.id}
                        title={section.title}
                        count={section.items.length}
                      >
                        {section.items.map((c) => (
                          <ConnectorCard
                            key={c.id}
                            connector={c}
                            isInstalled={installedIds.has(c.id)}
                            installedEnabled={isEnabled(registry, c.id)}
                            busy={busyId === c.id}
                            onOpen={() => setSelectedId(c.id)}
                            onAdd={() => connect(c)}
                            onRemove={() => void remove(c.id)}
                          />
                        ))}
                      </ConnectorSection>
                    ))
                  )}

                  {/* Trademark disclaimer: the gallery renders third-party brand
                      marks for identification only. */}
                  <footer
                    className="border-border-subtle border-t pt-4 text-caption text-text-muted leading-relaxed"
                    data-testid="connectors-disclaimer"
                  >
                    All third-party product names, logos, and brands are property of their
                    respective owners. All company, product, and service names used in this
                    interface are for identification purposes only. Use of these names, logos, and
                    brands does not imply endorsement.
                  </footer>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      <ConnectPermissionDialog
        connector={pendingConnect}
        onConfirm={confirmConnect}
        onOpenChange={(open) => {
          if (!open) setPendingConnect(null);
        }}
      />
    </div>
  );
}
