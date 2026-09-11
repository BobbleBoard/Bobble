/**
 * THE REGISTRY'S MODE FOLLOWS THE INTERFACE FROM THE FIRST LAUNCH, not from the
 * first settings write. Found on a fresh profile: the CLI interface was the
 * default, the Connectors page said "Lite", and mcp-lite (which reads the
 * registry file) ran the JSON proxy — the mixed state the coupling exists to
 * prevent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = mkdtempSync(path.join(tmpdir(), 'startup-mode-'));
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => HOME };
});
vi.mock('../mac/overlay-controller', () => ({ macOverlay: { setPillEnabled: async () => {} } }));

const { applySettingsEnvFromDisk } = await import('./settings-main');
const DESKTOP = path.join(HOME, '.pi', 'desktop');
const REGISTRY = path.join(DESKTOP, 'mcp-connectors.json');
const SETTINGS = path.join(DESKTOP, 'settings.json');
const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

beforeEach(() => {
  rmSync(DESKTOP, { recursive: true, force: true });
  mkdirSync(DESKTOP, { recursive: true });
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('applySettingsEnvFromDisk', () => {
  it('puts a fresh install in the mode the default interface implies', () => {
    applySettingsEnvFromDisk();
    expect(registry().mode).toBe('bash-cli');
    // Still no settings.json: seeding stays read-only.
    expect(existsSync(SETTINGS)).toBe(false);
  });

  it('flips a registry left in lite when the interface is the CLI', () => {
    writeFileSync(
      REGISTRY,
      JSON.stringify({ version: 1, mode: 'lite', servers: [{ id: 'gmail', command: 'x' }] }),
    );
    applySettingsEnvFromDisk();
    expect(registry().mode).toBe('bash-cli');
    expect(registry().servers).toEqual([{ id: 'gmail', command: 'x' }]); // servers kept
  });

  it('respects a stored choice of the schema interface', () => {
    writeFileSync(SETTINGS, JSON.stringify({ toolInterface: 'schemas', mcpMode: 'lite' }));
    writeFileSync(REGISTRY, JSON.stringify({ version: 1, mode: 'lite', servers: [] }));
    applySettingsEnvFromDisk();
    expect(registry().mode).toBe('lite');
  });

  it('leaves native alone — that is an explicit choice', () => {
    writeFileSync(REGISTRY, JSON.stringify({ version: 1, mode: 'native', servers: [] }));
    applySettingsEnvFromDisk();
    expect(registry().mode).toBe('native');
  });

  it('does not rewrite a registry that already agrees', () => {
    writeFileSync(REGISTRY, JSON.stringify({ version: 1, mode: 'bash-cli', servers: [] }));
    const before = readFileSync(REGISTRY, 'utf8');
    applySettingsEnvFromDisk();
    expect(readFileSync(REGISTRY, 'utf8')).toBe(before); // byte-identical: no write
  });
});
