/**
 * "+ › CONNECTORS": THE ONES THIS MAC HAS, EACH WITH ITS SWITCH.
 *
 * The user (2026-10-07), with Claude's own menu as the reference: "sample UI from
 * the + menu provided for how it should look to be able to turn (installed) on
 * and off … except replace the left icon with their actual app / connector
 * icon". So: Browse connectors, Manage connectors, a rule, then one row per
 * installed connector — its real mark, its name, a switch.
 *
 * What a switch can turn: an MCP server in the registry (its `enabled`) and a
 * module connector whose engine is on this Mac (Bobble 3D, its setting). The
 * built-ins are always on and have nothing to switch; a model connector's
 * "off" deletes its files, which is not a switch.
 *
 * A SWITCH APPLIES TO THIS CHAT. pi reads the registry when a session starts,
 * so a flip used to wait for the next chat. Here the chat's own session is
 * re-opened once the person stops flipping (debounced) and once no reply is
 * running — never under a reply. The prompt changes with it (connectors are
 * named there), so the next message reads the prompt once; that is the cost of
 * the model knowing what it now has.
 */
import { type AddMenuEntry, IconCompass, IconConnector, IconSettings } from '@pi-desktop/ui';
import { useEffect, useMemo } from 'react';
import { ConnectorIcon } from '../connectors/ConnectorIcon';
import { navigate } from '../state/app-nav-store';
import { useConnectorsStore } from '../state/connectors-store';
import { usePiStore } from '../state/pi-slice';

/** One switchable connector as the menu shows it. */
export interface SwitchableConnector {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  readonly icon?: string;
  readonly iconSvg?: string;
  readonly kind: 'server' | 'module';
}

/** The installed, switchable connectors, in registry order then modules. Pure. */
export function switchableConnectors(
  state: Pick<
    ReturnType<typeof useConnectorsStore.getState>,
    'registry' | 'catalog' | 'moduleConnectors'
  >,
): SwitchableConnector[] {
  const byId = new Map(state.catalog.map((c) => [c.id, c]));
  const servers = state.registry.servers.map((srv): SwitchableConnector => {
    const known = byId.get(srv.id);
    const iconSvg = known?.iconSvg;
    const icon = known?.icon ?? srv.icon;
    return {
      id: srv.id,
      name: known?.name ?? srv.name ?? srv.id,
      on: srv.enabled !== false,
      kind: 'server',
      ...(iconSvg !== undefined ? { iconSvg } : {}),
      ...(icon !== undefined ? { icon } : {}),
    };
  });
  const modules = Object.entries(state.moduleConnectors)
    .filter(([, m]) => m.ready)
    .map(([id, m]): SwitchableConnector => {
      const known = byId.get(id);
      return {
        id,
        name: known?.name ?? id,
        on: m.on,
        kind: 'module',
        ...(known?.iconSvg !== undefined ? { iconSvg: known.iconSvg } : {}),
        ...(known?.icon !== undefined ? { icon: known.icon } : {}),
      };
    });
  return [...servers, ...modules];
}

/* ── applying a flip to this chat ─────────────────────────────────────────── */

const SETTLE_MS = 800;
let applyTimer: ReturnType<typeof setTimeout> | null = null;
let waitingForIdle: (() => void) | null = null;

/** Re-open this chat's session so pi reads the registry again — when it is quiet. */
function applyToThisChat(): void {
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    const busy = () => {
      const s = usePiStore.getState();
      return s.agent.isStreaming || s.promptInFlight;
    };
    const run = async () => {
      const sessionFile = usePiStore.getState().session?.sessionFile;
      const { restartPi } = await import('../state/pi-connect');
      await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);
    };
    if (!busy()) {
      void run();
      return;
    }
    if (waitingForIdle !== null) return;
    waitingForIdle = usePiStore.subscribe(() => {
      if (busy()) return;
      waitingForIdle?.();
      waitingForIdle = null;
      void run();
    });
  }, SETTLE_MS);
}

async function flip(c: SwitchableConnector): Promise<void> {
  const store = useConnectorsStore.getState();
  if (c.kind === 'server') {
    await store.setEnabled(c.id, !c.on);
    applyToThisChat();
    return;
  }
  // A module connector's switch is its setting; the store respawns pi itself.
  if (c.on) await store.remove(c.id);
  else await store.install(c.id);
}

/** The "Connectors ›" row for the composer's + menu. */
export function useConnectorsMenuEntry(): AddMenuEntry {
  const loaded = useConnectorsStore((s) => s.loaded);
  const registry = useConnectorsStore((s) => s.registry);
  const catalog = useConnectorsStore((s) => s.catalog);
  const moduleConnectors = useConnectorsStore((s) => s.moduleConnectors);
  useEffect(() => {
    if (!loaded) void useConnectorsStore.getState().load();
  }, [loaded]);
  return useMemo(() => {
    const list = switchableConnectors({ registry, catalog, moduleConnectors });
    const children: AddMenuEntry[] = [
      {
        key: 'connectors-browse',
        label: 'Browse connectors',
        icon: <IconCompass size={16} />,
        testid: 'add-connectors-browse',
        onSelect: () => navigate({ kind: 'view', view: 'connectors' }),
      },
      {
        key: 'connectors-manage',
        label: 'Manage connectors',
        icon: <IconSettings size={16} />,
        testid: 'add-connectors-manage',
        onSelect: () => navigate({ kind: 'view', view: 'connectors' }),
      },
      ...(list.length > 0 ? [{ key: 'connectors-rule', label: '', separator: true } as const] : []),
      ...list.map(
        (c): AddMenuEntry => ({
          key: `connector-${c.id}`,
          label: c.name,
          icon: (
            <ConnectorIcon
              connector={{
                name: c.name,
                icon: c.icon ?? '',
                ...(c.iconSvg !== undefined ? { iconSvg: c.iconSvg } : {}),
              }}
              size={16}
            />
          ),
          switchOn: c.on,
          testid: `add-connector-${c.id}`,
          onSelect: () => void flip(c),
        }),
      ),
    ];
    return {
      key: 'connectors',
      label: 'Connectors',
      icon: <IconConnector size={16} />,
      testid: 'add-connectors',
      children,
    };
  }, [registry, catalog, moduleConnectors]);
}
