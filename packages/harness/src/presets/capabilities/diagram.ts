/**
 * The `diagram` capability (VQ-10).
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const diagram: Capability = {
  name: 'diagram',
  /* MEASURED before this existed, the research's flow brief on the 4B ("Draw
     a flow diagram of our order fulfilment process …"): it ran `svg` —
     OmniSVG, which cannot write words — then typed an SVG by hand over it,
     then spent minutes presenting it (137 s; the 420 s cap twice). The line
     claims the ask in the words it arrives in — flowchart, process, diagram —
     and names the two wrong turns. The summary rides EVERY prompt in CLI mode
     (the command list), so it is one sentence; the how-to is in `guidance`
     and in `diagram --help`, which cost nothing until read. */
  summary:
    'Draw a flowchart, process, sequence, org chart, mind map or any diagram of steps and relationships in the chat, from Mermaid text — never hand-written SVG or the svg command.',
  guidance:
    'diagram takes a title and the Mermaid source — "flowchart TD" then one line per connection: ' +
    'A([Order placed]) --> B{Payment ok?}, B -- no --> C[Email customer], C -. retry .-> B. Every ' +
    'step, branch and loop you write is laid out and labelled for you, in the project’s design ' +
    'kit: where it starts, where it ends and the failure paths are coloured on their own, so write ' +
    'no colours or style lines. Short labels; quote one with brackets in it (A["Pick (and pack)"]); ' +
    'TD fits the chat, LR suits three or four steps. Also sequenceDiagram, classDiagram, ' +
    'stateDiagram-v2, erDiagram, mindmap, timeline, gantt, pie. It appears in the chat as a card; ' +
    'diagram_edit changes it (--source, --direction, --title, --kit). A line Mermaid cannot read ' +
    'comes back with the fix — correct that line and call again. Then say in one line what it shows.',
  /* Two tools: in CLI mode `diagram` IS the command (tool-cli.ts maps it to an
     empty path under this group) and the other is `diagram edit`. */
  tools: ['diagram', 'diagram_edit'],
};
