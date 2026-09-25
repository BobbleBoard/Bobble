/**
 * EVERY METHOD THE TOOLS CAN ASK FOR HAS TO BE ANSWERED HERE.
 *
 * A helper verb needs three registrations to be reachable: the Swift dispatch,
 * this agent's method switch, and a tool. MEASURED, from a live run: mac_tabs
 * shipped with two of the three, so the CLI advertised `mac tabs`, a model
 * found it unaided, called it — and got "unknown method: tabs". A tool that is
 * advertised and cannot run is worse than one that does not exist, because the
 * model spends turns deciding it must be holding it wrong.
 *
 * The switch is a statement, so it cannot be enumerated at runtime; the source
 * can be. Crude, and it catches exactly the thing that went wrong.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MacAgentMethod } from '@pi-desktop/mac-computer-use/protocol';
import { describe, expect, it } from 'vitest';

/** Kept in step with the union in mac-computer-use/protocol.ts by the test below. */
const METHODS: MacAgentMethod[] = [
  'check',
  'promptGrants',
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'launch',
  'screenshot',
  'bounds',
  'frontmost',
  'windows',
  'wallpaper',
  'menus',
  'menuClick',
  'tabs',
  'tabSelect',
  'tabNew',
  'tabClose',
  'recordStart',
  'recordStop',
  'setDriving',
  'policy',
  'brake',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(path.join(here, 'mac-agent.ts'), 'utf8');
const protocolSrc = readFileSync(
  path.join(here, '../../../../packages/mac-computer-use/src/protocol.ts'),
  'utf8',
);

describe('mac agent method coverage', () => {
  it.each(METHODS)('handles %s', (method) => {
    expect(agentSrc).toContain(`case '${method}'`);
  });

  it('knows about every method the protocol declares', () => {
    const union = protocolSrc.slice(
      protocolSrc.indexOf('export type MacAgentMethod'),
      protocolSrc.indexOf(';', protocolSrc.indexOf('export type MacAgentMethod')),
    );
    const declared = [...union.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    // Anything the protocol adds must be listed above — and therefore checked.
    expect(declared.filter((d) => !METHODS.includes(d as MacAgentMethod))).toEqual([]);
  });
});
