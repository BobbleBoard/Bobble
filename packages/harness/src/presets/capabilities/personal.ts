/**
 * The `personal` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import { MAC_CONNECTOR_TOOLS } from '@pi-desktop/mac-connectors/tool-names';
import type { Capability } from './types.js';

export const personal: Capability = {
  name: 'personal',
  summary: "The user's Calendar, Mail, Reminders, Contacts and Messages.",
  guidance:
    'Call these DIRECTLY for "what\'s on my calendar", "remind me to…", "email…", "text…", ' +
    "or anything needing today's date. Never read a file to work out the date, and never " +
    'drive the Calendar or Mail UI with computer use when a connector answers.',
  tools: [...MAC_CONNECTOR_TOOLS],
};
