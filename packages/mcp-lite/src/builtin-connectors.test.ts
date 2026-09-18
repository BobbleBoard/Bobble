import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CONNECTOR_IDS,
  BUILTIN_CONNECTORS,
  MAC_CONNECTORS,
  MODEL_CONNECTORS,
  MODULE_CONNECTORS,
} from './builtin-connectors';
import { BRANDED_CONNECTOR_IDS } from './connector-icons';
import { isBuiltinConnector, KNOWN_CONNECTORS, KNOWN_CONNECTORS_BY_ID } from './detect-apps';

describe('built-in connectors', () => {
  it('ships HyperFrames, Video editing, and the first-party macOS connectors', () => {
    expect(BUILTIN_CONNECTOR_IDS).toEqual([
      'cli-tools',
      'hyperframes',
      'data-visuals',
      'video-editing',
      'mac-calendar',
      'mac-mail',
      'mac-messages',
      'mac-contacts',
      'mac-reminders',
    ]);
  });

  it('marks each builtin as kind:builtin with a sentinel empty command', () => {
    for (const c of BUILTIN_CONNECTORS) {
      expect(c.kind).toBe('builtin');
      // A sentinel empty command — a builtin never spawns a server.
      expect(c.template.command).toBe('');
    }
  });

  it('scopes "By us" (firstParty) to our OWN tool, not the bundled third-party one', () => {
    // Owner correction: HyperFrames is HeyGen's tool — bundled/preinstalled and
    // "Official", but NEVER "By us". Video editing is genuinely ours.
    const hf = KNOWN_CONNECTORS_BY_ID.hyperframes;
    const ve = KNOWN_CONNECTORS_BY_ID['video-editing'];
    expect(hf?.firstParty).toBe(false);
    expect(hf?.official).toBe(true);
    expect(hf?.homepage).toContain('heygen');
    expect(ve?.firstParty).toBe(true);
    expect(ve?.official).toBe(true);
  });

  it('carries a static tool list for the detail view', () => {
    const hf = KNOWN_CONNECTORS_BY_ID.hyperframes;
    expect(hf?.tools?.map((t) => t.name)).toEqual(['motion_graphics_render']);
    const ve = KNOWN_CONNECTORS_BY_ID['video-editing'];
    expect(ve?.tools?.map((t) => t.name)).toEqual(['video_edit', 'extract_frames', 'probe']);
    // Every tool has a one-line description.
    for (const c of BUILTIN_CONNECTORS) {
      for (const t of c.tools ?? []) expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('is merged to the FRONT of the exported catalog', () => {
    expect(KNOWN_CONNECTORS[0]?.id).toBe('cli-tools');
    expect(KNOWN_CONNECTORS[1]?.id).toBe('hyperframes');
    expect(KNOWN_CONNECTORS[2]?.id).toBe('data-visuals');
    expect(KNOWN_CONNECTORS[3]?.id).toBe('video-editing');
  });

  it('renders a neutral (non-brand) inline SVG mark, in a hue of its own', () => {
    // the user (2026-09-17): "a bit more colorful … simple still but with a bit of
    // color, not so simple thin white lines only" — two tones of one mid-tone
    // hue (the strokes, and a 16% wash on the closed shapes).
    for (const id of BUILTIN_CONNECTOR_IDS) {
      expect(BRANDED_CONNECTOR_IDS).not.toContain(id);
      const svg = KNOWN_CONNECTORS_BY_ID[id]?.iconSvg ?? '';
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toMatch(/stroke="#[0-9a-f]{6}"/);
      expect(svg).toContain('fill-opacity="0.16"');
    }
  });

  it('isBuiltinConnector is true only for the builtins', () => {
    expect(isBuiltinConnector('hyperframes')).toBe(true);
    expect(isBuiltinConnector('video-editing')).toBe(true);
    expect(isBuiltinConnector('mac-calendar')).toBe(true);
    expect(isBuiltinConnector('github')).toBe(false);
    expect(isBuiltinConnector('memory')).toBe(false);
    expect(isBuiltinConnector('does-not-exist')).toBe(false);
  });

  it('surfaces the first-party macOS connectors as discoverable "By us" builtins', () => {
    const macIds = ['mac-calendar', 'mac-mail', 'mac-messages', 'mac-contacts', 'mac-reminders'];
    expect(MAC_CONNECTORS.map((c) => c.id)).toEqual(macIds);
    for (const id of macIds) {
      const c = KNOWN_CONNECTORS_BY_ID[id];
      // Present in the gallery catalog + marked as our always-on preinstalled tool.
      expect(c, `${id} missing from catalog`).toBeDefined();
      expect(c?.kind).toBe('builtin');
      expect(c?.firstParty).toBe(true); // → the "By us" section
      expect(c?.template.command).toBe(''); // never spawns a server
      expect(isBuiltinConnector(id)).toBe(true);
      // Every card advertises the real tools it exposes (drives the detail view).
      expect(c?.tools?.length ?? 0).toBeGreaterThan(0);
      for (const t of c?.tools ?? []) expect(t.description.length).toBeGreaterThan(0);
    }
    // The real mac-connector tool names are advertised, so the model's calendar/
    // mail/etc. capability is discoverable rather than invisible.
    const advertised = MAC_CONNECTORS.flatMap((c) => (c.tools ?? []).map((t) => t.name));
    for (const name of [
      'calendar_list_events',
      'mail_search',
      'messages_send',
      'contacts_search',
      'reminders_create',
    ]) {
      expect(advertised).toContain(name);
    }
  });
});

describe('model connectors', () => {
  /* The edit that put this in the catalog was once asserted, replaced, and
     never written to disk — three ships went out without the card, and the
     Connectors page said "Nothing matches OmniSVG". This is the test that
     would have caught it in the first minute. */
  it('OmniSVG is in the exported catalog, as an installable model connector', () => {
    const c = KNOWN_CONNECTORS.find((k) => k.id === 'omnisvg');
    expect(c).toBeDefined();
    expect(c?.kind).toBe('model');
    expect(c?.modelId).toBe('omnisvg-1.1-4b');
    expect(c?.tools?.map((t) => t.name)).toEqual(['generate_svg']);
  });

  it('is NOT a builtin: it must be installable', () => {
    expect(BUILTIN_CONNECTOR_IDS).not.toContain('omnisvg');
    expect(MODEL_CONNECTORS.map((c) => c.id)).toEqual(['omnisvg']);
  });
});

describe('module connectors', () => {
  /* the user (2026-09-17): "3d should be a connector that gets recommended for
     install upon installing the 3d studio module". The card is the chat's use
     of the studio's engine: its own kind, so the app can answer install /
     state / recommendation from the module rather than from a model file or
     a server in the registry. */
  it('Bobble 3D is in the exported catalog, as a module connector on the 3d module', () => {
    const c = KNOWN_CONNECTORS.find((k) => k.id === 'bobble-3d');
    expect(c).toBeDefined();
    expect(c?.kind).toBe('module');
    expect(c?.moduleId).toBe('3d');
    expect(c?.firstParty).toBe(true);
    expect(c?.tools?.map((t) => t.name)).toEqual(['generate_3d', 'refine_3d']);
    expect(c?.iconSvg).toContain('<svg');
  });

  it('is neither a builtin nor a model connector: it is installable and switchable', () => {
    expect(BUILTIN_CONNECTOR_IDS).not.toContain('bobble-3d');
    expect(MODEL_CONNECTORS.map((c) => c.id)).not.toContain('bobble-3d');
    expect(MODULE_CONNECTORS.map((c) => c.id)).toEqual(['bobble-3d']);
    expect(isBuiltinConnector('bobble-3d')).toBe(false);
  });
});
