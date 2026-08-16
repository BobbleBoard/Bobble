/**
 * The harness catalog's job is to stop the picker lying. Two ways it could:
 * offering an agent that isn't installed, or implying an external agent can
 * drive Bobble's own chat when it can only be pointed at Bobble's server.
 */
import { describe, expect, it } from 'vitest';
import {
  canDriveChat,
  connectCommands,
  connectScript,
  HARNESSES,
  type HarnessSpec,
  type HarnessState,
  isSelectable,
  orderHarnessesForDisplay,
} from './harness-catalog';

const byId = (id: string): HarnessSpec => {
  const hit = HARNESSES.find((h) => h.id === id);
  if (hit === undefined) throw new Error(`no harness ${id}`);
  return hit;
};

describe('which harnesses can drive the chat', () => {
  it('only embedded ones can — the app has to speak their protocol', () => {
    expect(canDriveChat(byId('pi-bundled'))).toBe(true);
    expect(canDriveChat(byId('pi-system'))).toBe(true);
    expect(canDriveChat(byId('pi-custom'))).toBe(true);
    // Claude Code / Codex / OpenCode / Hermes are their own clients. Bobble
    // serves them a model; it cannot render their turns.
    expect(canDriveChat(byId('claude-code'))).toBe(false);
    expect(canDriveChat(byId('codex'))).toBe(false);
    expect(canDriveChat(byId('opencode'))).toBe(false);
    expect(canDriveChat(byId('hermes'))).toBe(false);
  });

  it('covers every harness the user asked for', () => {
    const ids = HARNESSES.map((h) => h.id);
    for (const wanted of ['codex', 'claude-code', 'hermes', 'opencode', 'pi-bundled']) {
      expect(ids).toContain(wanted);
    }
    // "system pi detected and put in also" + "any custom pi config".
    expect(ids).toContain('pi-system');
    expect(ids).toContain('pi-custom');
  });
});

describe('selectability never outruns what is installed', () => {
  const none: Record<string, HarnessState> = {};

  it('always allows the bundled harness — it ships with the app', () => {
    expect(isSelectable(byId('pi-bundled'), undefined)).toBe(true);
  });

  it('refuses an agent that is not on PATH', () => {
    expect(isSelectable(byId('claude-code'), none['claude-code'])).toBe(false);
    expect(isSelectable(byId('claude-code'), { id: 'claude-code', installed: true })).toBe(true);
  });

  it('refuses a system pi that was not detected', () => {
    expect(isSelectable(byId('pi-system'), { id: 'pi-system', installed: false })).toBe(false);
  });

  it('refuses a custom config until a path is actually given', () => {
    expect(isSelectable(byId('pi-custom'), undefined)).toBe(false);
    expect(isSelectable(byId('pi-custom'), undefined, '   ')).toBe(false);
    expect(isSelectable(byId('pi-custom'), undefined, '/Users/user/.pi/my.json')).toBe(true);
  });
});

describe('connect commands for external agents', () => {
  it('points Claude Code at the local server with its own env names', () => {
    const { exports, launch } = connectCommands(
      byId('claude-code'),
      'http://127.0.0.1:8080/v1',
      'qwen3.5-4b',
    );
    const names = exports.map((e) => e.name);
    expect(names).toContain('ANTHROPIC_BASE_URL');
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(exports.find((e) => e.name === 'ANTHROPIC_BASE_URL')?.value).toBe(
      'http://127.0.0.1:8080/v1',
    );
    expect(launch).toBe('claude');
  });

  it('uses OPENAI_* names for the OpenAI-compatible agents', () => {
    for (const id of ['codex', 'opencode', 'hermes']) {
      const names = connectCommands(byId(id), 'http://x/v1', 'm').exports.map((e) => e.name);
      expect(names).toContain('OPENAI_BASE_URL');
    }
  });

  it('produces nothing for an embedded harness — there is nothing to point', () => {
    expect(connectCommands(byId('pi-bundled'), 'http://x/v1', 'm')).toEqual({
      exports: [],
      launch: null,
    });
    expect(connectScript(byId('pi-bundled'), 'http://x/v1', 'm')).toBe('');
  });

  it('quotes values so a URL with odd characters cannot break the shell line', () => {
    const script = connectScript(byId('codex'), 'http://127.0.0.1:8080/v1', 'a b');
    expect(script).toContain('export OPENAI_BASE_URL="http://127.0.0.1:8080/v1"');
    expect(script).toContain('"a b"');
    expect(script.trim().endsWith('codex')).toBe(true);
  });
});

describe('display order', () => {
  it('puts embedded harnesses before external ones', () => {
    const order = orderHarnessesForDisplay({}).map((h) => h.attach);
    expect(order.indexOf('external')).toBeGreaterThan(order.lastIndexOf('embedded'));
  });

  it('surfaces installed agents above ones the user would have to install', () => {
    const states: Record<string, HarnessState> = {
      codex: { id: 'codex', installed: true },
    };
    const external = orderHarnessesForDisplay(states).filter((h) => h.attach === 'external');
    expect(external[0]?.id).toBe('codex');
  });

  it('never drops or duplicates a harness', () => {
    const ordered = orderHarnessesForDisplay({});
    expect(ordered).toHaveLength(HARNESSES.length);
    expect(new Set(ordered.map((h) => h.id)).size).toBe(HARNESSES.length);
  });
});
