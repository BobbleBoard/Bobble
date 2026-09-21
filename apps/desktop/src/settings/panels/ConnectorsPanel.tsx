/**
 * MCP mode: lite (one generic proxy tool + tool-search, schemas kept out of
 * context) vs native (every server tool registered directly). Writes the `mode`
 * field of the mcp-lite registry (~/.pi/desktop/mcp-connectors.json), preserving
 * any configured servers.
 */
import { Button, SegmentedControl } from '@pi-desktop/ui';
import type { McpMode } from '../../../electron/settings/settings-contract';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

const MODE_HINT: Record<McpMode, string> = {
  lite: 'Servers are proxied through one lightweight tool; schemas load on demand.',
  native: 'Every MCP tool is registered directly (heavier context, full fidelity).',
  'bash-cli': 'Extensions run as a `pi-tool` shell command in bash (best for small models).',
};

export function ConnectorsPanel({ onOpenConnectors }: { onOpenConnectors?: () => void }) {
  const mode = useSettingsStore((s) => s.settings.mcpMode);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingSection description="How extension (MCP) tools are exposed to the agent.">
      <SettingRow label="MCP mode" hint={MODE_HINT[mode]}>
        <SegmentedControl
          aria-label="MCP mode"
          data-testid="settings-mcp-mode"
          value={mode}
          onValueChange={(v) => void update({ mcpMode: v as McpMode })}
          options={[
            { value: 'lite', label: 'Lite' },
            { value: 'native', label: 'Native' },
            { value: 'bash-cli', label: 'Bash CLI' },
          ]}
        />
      </SettingRow>
      {onOpenConnectors !== undefined ? (
        <SettingRow label="Browse extensions" hint="Install and manage MCP extensions.">
          <Button
            variant="secondary"
            data-testid="settings-open-connectors"
            onClick={onOpenConnectors}
          >
            Open extensions
          </Button>
        </SettingRow>
      ) : null}
    </SettingSection>
  );
}
