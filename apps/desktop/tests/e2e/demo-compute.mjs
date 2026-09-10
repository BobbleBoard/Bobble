/**
 * A COMPUTATION THE MODEL CANNOT ANSWER FROM MEMORY.
 *
 * The computer-use demos measure whether a model can drive an app. This one
 * measures the other half of the same harness — can it reach for the shell,
 * write a correct program, run it, and report what came back — with no app, no
 * Accessibility tree and no screenshot anywhere in the loop.
 *
 * The task is chosen so that the ANSWER is the evidence. "Sum of the squares of
 * the first 100 primes" is 8,384,727: a number no model has memorised and none
 * can arrive at by reasoning in-context, so a correct reply is proof it actually
 * executed something. A model that guesses is wrong by millions, and a model
 * that describes how it WOULD compute it scores exactly as it should — zero.
 */
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
const ANSWER = '8384727';

await demoRun({
  name: process.env.RUN_NAME ?? `compute-${MODEL}-${MODE}`,
  app: 'Finder',
  attach: true, // no app is being driven; Finder is here so nothing gets quit
  model: MODEL,
  mode: MODE,
  prompt:
    'Compute the sum of the squares of the first 100 prime numbers. ' +
    'Write and run a program to do it — do not try to work it out in your head. ' +
    'Tell me the single number you got.',
  verify: async (_dbg, last) => {
    /* Digits only, so "8,384,727" and "8384727" both count — the formatting is
       not what is being measured. */
    const said = last.text.replace(/[,\s_]/g, '');
    const correct = said.includes(ANSWER);
    /* A near miss is worth seeing: it separates "ran something slightly wrong"
       from "made a number up", and those are different failures. */
    const numbers = (last.text.match(/\d[\d,_]{4,}/g) ?? []).map((n) => n.replace(/[,_]/g, ''));
    return {
      verdict: correct ? 'pass' : 'fail',
      expected: ANSWER,
      numbersSaid: numbers.slice(0, 6),
      correct,
    };
  },
});
