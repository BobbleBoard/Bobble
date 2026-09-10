/**
 * NO TOOLS AT ALL — just the model, a passage, and a question.
 *
 * Every other demo here measures a model through a harness: shims, an app, a
 * screenshot, a verifier. This one takes all of that away, because "how good is
 * this model" and "how well does it drive our tooling" are different questions
 * and a small model can be strong at one and hopeless at the other.
 *
 * The passage is invented rather than quoted, so no model can have seen it, and
 * the question needs two facts joined — which is what separates reading from
 * pattern-matching a single line.
 */
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';

const PASSAGE = [
  'The Kelder Line opened in 1974 with eleven stations.',
  'Three more were added in 1982, and the depot at Harrow Vale closed the same year.',
  'In 1991 the line was extended north, adding four stations, and the Harrow Vale depot reopened.',
  'A fire in 2003 closed two stations permanently.',
].join(' ');

await demoRun({
  name: process.env.RUN_NAME ?? `recall-${MODEL}-${MODE}`,
  app: 'Finder',
  attach: true,
  model: MODEL,
  mode: MODE,
  /* One line, deliberately: the prompt is TYPED into the composer, so a newline
     is an Enter and sends the message half-written. */
  prompt:
    `Read this and answer in one short sentence. ${PASSAGE} ` +
    'How many stations does the Kelder Line have today, and in which year did the ' +
    'Harrow Vale depot reopen? Answer from the passage only.',
  verify: async (_dbg, last) => {
    const said = last.text.toLowerCase().replace(/[,\s_]/g, '');
    /* 11 + 3 + 4 − 2 = 16, and the depot reopened in 1991. Both are needed:
       either alone is available from a single sentence. */
    const count = said.includes('16') || last.text.toLowerCase().includes('sixteen');
    const year = said.includes('1991');
    return {
      verdict: count && year ? 'pass' : 'fail',
      expectedStations: 16,
      expectedYear: 1991,
      gotStations: count,
      gotYear: year,
    };
  },
});
