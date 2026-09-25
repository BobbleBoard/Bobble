/**
 * The `connectors` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const connectors: Capability = {
  name: 'connectors',
  summary: 'Anything reachable over MCP — Notion, Slack, Jira, and whatever else is installed.',
  guidance:
    'List what is connected first, read the schema of the one you want, then call it. The set ' +
    'depends on what this user has installed, so never assume a particular service is there.',
  tools: ['mcp_list', 'mcp_schema', 'mcp_call'],
};
