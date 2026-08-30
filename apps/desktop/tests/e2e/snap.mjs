/**
 * Look at the app, without the app looking back.
 *
 * Half of "testing" is not a test — it is wanting to SEE something: does the
 * palette look right, did that dialog land where I think, what does an empty
 * chat look like now. Writing a whole probe for that is friction, and running
 * the app normally puts a window over whatever the user is doing.
 *
 * So: one command that launches invisibly, optionally does a few things, and
 * writes a PNG.
 *
 *   node tests/e2e/snap.mjs
 *   node tests/e2e/snap.mjs --key Meta+k --wait 500 --out /tmp/palette.png
 *   node tests/e2e/snap.mjs --type "hello there" --key Enter --wait 3000
 *   node tests/e2e/snap.mjs --click '[data-testid=nav-connectors]' --shot connectors
 *   node tests/e2e/snap.mjs --eval "document.title"
 *
 * Steps run in the order given, so a sequence reads like the thing you would
 * have done by hand. `--shot <name>` mid-sequence captures without ending it.
 */

import path from 'node:path';
import { launchApp } from './harness.mjs';

const STEPS = new Set(['--click', '--type', '--key', '--wait', '--eval', '--shot', '--select']);

function parse(argv) {
  const steps = [];
  const opts = { out: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i] ?? null;
    else if (arg === '--keep') opts.keep = true;
    else if (STEPS.has(arg)) steps.push({ kind: arg.slice(2), value: argv[++i] ?? '' });
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else console.error(`snap: ignoring unknown argument ${arg}`);
  }
  return { steps, opts };
}

const HELP = `
snap — screenshot the app without it taking your screen

  --click <selector>   click it (waits for it first)
  --select <selector>  wait for it, without clicking
  --type <text>        type into whatever has focus
  --key <key>          press a key ("Enter", "Meta+k", "Escape")
  --wait <ms>          pause
  --eval <js>          run it in the page and print the result
  --shot <name>        capture here and keep going
  --out <path>         where the final screenshot goes
  --keep               leave the app running (for --eval poking)

Steps run in the order given. PI_E2E_VISIBLE=1 shows the window if you want to
watch it happen.
`.trim();

const { steps, opts } = parse(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const { page, shot, finish, shotDir } = await launchApp('snap');

for (const step of steps) {
  try {
    switch (step.kind) {
      case 'click':
        await page.waitForSelector(step.value, { timeout: 10_000 });
        await page.click(step.value);
        break;
      case 'select':
        await page.waitForSelector(step.value, { timeout: 10_000 });
        break;
      case 'type':
        await page.keyboard.type(step.value);
        break;
      case 'key':
        await page.keyboard.press(step.value);
        break;
      case 'wait':
        await page.waitForTimeout(Number(step.value) || 0);
        break;
      case 'eval':
        console.log(JSON.stringify(await page.evaluate(step.value), null, 2));
        break;
      case 'shot':
        console.log(`snap: ${await shot(step.value)}`);
        break;
      default:
        break;
    }
  } catch (error) {
    // Report and carry on: a sequence that half-worked is still worth seeing,
    // and the screenshot is usually what explains why the step failed.
    console.error(`snap: ${step.kind} ${step.value} — ${String(error).split('\n')[0]}`);
  }
}

// A beat for the last action to settle before capturing.
await page.waitForTimeout(400);
const final = await shot('snap');
const out = opts.out ?? final;
if (opts.out !== null) {
  const { copyFileSync } = await import('node:fs');
  copyFileSync(final, path.resolve(opts.out));
}
console.log(`snap: ${out}`);
console.log(`snap: shots in ${shotDir}`);

if (!opts.keep) await finish();
