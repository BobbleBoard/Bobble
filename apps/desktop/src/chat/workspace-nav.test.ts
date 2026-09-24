// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRouteView } from '../route-views';
import { WORKSPACE_NAV, type WorkspaceNavContext, workspaceNavRows } from './workspace-nav';

const caps = (training: boolean) => ({
  capabilities: { image: true, video: true, audio: true, threeD: true, training },
});

let off: Array<() => void> = [];
afterEach(() => {
  for (const f of off) f();
  off = [];
});

describe('the workspace nav registry', () => {
  it('draws the three rows the sidebar had, in order, with the same words, glyphs and test ids', () => {
    expect(workspaceNavRows(caps(true)).map((r) => [r.id, r.label, r.glyph, r.testid])).toEqual([
      ['models', 'Model management', 'models', 'nav-model-management'],
      ['connectors', 'Extensions', 'extensions', 'nav-connectors'],
      ['scheduled', 'Scheduled', 'scheduled', 'nav-scheduled'],
    ]);
  });

  it('wires each row to the handler the sidebar used', () => {
    const ctx: WorkspaceNavContext = {
      onOpenSettings: vi.fn(),
      onOpenConnectors: vi.fn(),
      onOpenScheduled: vi.fn(),
      navigate: vi.fn(() => true),
    };
    const byId = Object.fromEntries(WORKSPACE_NAV.map((r) => [r.id, r]));
    byId.models?.onClick(ctx);
    byId.connectors?.onClick(ctx);
    byId.scheduled?.onClick(ctx);
    expect(ctx.onOpenSettings).toHaveBeenCalledWith('models');
    expect(ctx.onOpenConnectors).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenScheduled).toHaveBeenCalledTimes(1);
    byId.training?.onClick(ctx);
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: 'view', view: 'training' });
  });

  it('shows Training once its screen exists AND the capability is on; Workflows once its screen exists', () => {
    off.push(registerRouteView('training', () => null));
    expect(workspaceNavRows(caps(false)).map((r) => r.id)).not.toContain('training');
    expect(workspaceNavRows(caps(true)).map((r) => r.id)).toContain('training');
    expect(workspaceNavRows(caps(true)).map((r) => r.id)).not.toContain('workflows');
    off.push(registerRouteView('workflows', () => null));
    expect(workspaceNavRows(caps(true)).map((r) => r.id)).toEqual([
      'models',
      'connectors',
      'scheduled',
      'training',
      'workflows',
    ]);
  });
});
