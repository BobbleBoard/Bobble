/**
 * THE TAB THAT IS ALREADY OPEN.
 *
 * the user: "on low power mode while i'm using the computer a video produced for
 * one of the models doing computer use, let's say using an already open chrome
 * session. here's a task, configure the apple product on screen with 2tb of
 * storage in the already open tab there."
 *
 * So this one deliberately does LESS than demo-chrome: it does not clear the
 * profile picker, does not navigate, and never quits Chrome. His session is the
 * subject, and the run has to leave it exactly as it found it apart from the one
 * change it was asked to make.
 *
 * It also runs with no LIVE flag, because he is AT the machine — Bobble opens in
 * the background and the recording comes off the window over CDP, so nothing
 * appears in front of him.
 *
 * Verified by a picture, because that is the only honest check here: Chrome
 * refuses JavaScript from Apple Events on this Mac, so the page cannot be read.
 * The window title and a screenshot of the tab go next to the video.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.8-27b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
const NAME = process.env.RUN_NAME ?? `apple-${MODEL}-${MODE}`;

await demoRun({
  name: NAME,
  app: 'Google Chrome',
  // His browser, his tab, his session — never relaunched, never quit.
  attach: true,
  model: MODEL,
  mode: MODE,
  /*
   * "navigate anywhere else" was doing damage. MEASURED on the first run: the
   * open tab is Apple's iPhone LANDING page, where storage is not offered at
   * all — you reach it by pressing the page's own Buy button. The model read
   * "do not navigate" as "do not follow links either", made 14 tool calls, and
   * finished with nothing chosen. The intent was never "don't move", it was
   * "stay in the user's tab", so say that.
   */
  prompt:
    'In the Google Chrome tab that is already open on this Mac, configure the ' +
    'Apple product shown on screen with 2TB of storage. Stay in that tab — do ' +
    "not open a new tab or a new window — but following the page's own links " +
    'and buttons to reach the storage options is exactly right. Tell me what ' +
    'you selected when you are done.',
  verify: async (dbg, last) => {
    const snap = await dbg('snapshot', { app: 'Google Chrome' });
    const shot = await dbg('screenshot', { app: 'Google Chrome' }).catch(() => null);
    let shotPath = null;
    if (shot?.base64) {
      const dir = path.join('/Users/user/Desktop/OSS-harness/scratchpad/demos', NAME);
      mkdirSync(dir, { recursive: true });
      shotPath = path.join(dir, 'chrome-final.png');
      writeFileSync(shotPath, Buffer.from(shot.base64, 'base64'));
    }
    const titles = (snap.windows ?? []).map((w) => w.title ?? '').filter((t) => t !== '');

    /*
     * THE PAGE'S OWN ANSWER, not the model's.
     *
     * MEASURED on the first pass: the model finished with "Done ... I selected
     * 2TB" while the page still had nothing selected, and a check that only read
     * `last.text` called that a pass. Apple renders each storage option as an
     * AXRadioButton whose value is "1" when chosen and "0" when not, so the
     * choice can be read straight out of the tree — no Apple Events needed,
     * which matters because Chrome refuses those on this Mac.
     */
    /*
     * WHAT ACCESSIBILITY CAN AND CANNOT SETTLE HERE.
     *
     * MEASURED, sweeping the whole page 26 scrolls from the top: Chrome exposes
     * about SIXTY Accessibility elements for an Apple configure page and they
     * barely change as it scrolls — there is no DOM behind this, just a sparse
     * summary of what the browser felt like publishing. So when the storage
     * radios happen to be in it, they are a real and cheap answer; when they are
     * not, no amount of scrolling produces them, and scrolling the user's page
     * to hunt for them is a side effect with nothing to show for it.
     *
     * Hence: read what is there, and when it cannot answer, say so and let the
     * screenshot settle it. For Chrome the picture IS the ground truth.
     */
    const radios = (snap.elements ?? []).filter(
      (e) => e.role === 'AXRadioButton' && /\b\d+\s*(GB|TB)\b/i.test(e.name ?? ''),
    );
    const chosen = radios
      .filter((e) => String(e.value ?? '0') !== '0')
      .map((e) => (e.name ?? '').match(/\b\d+\s*(?:GB|TB)\b/i)?.[0] ?? '?');

    /*
     * THREE ANSWERS, NOT TWO — because "I cannot see it" is not "it failed".
     *
     * MEASURED: a run that genuinely selected 2TB in the already-open "Shop
     * iPhone Duo" tab was scored a FAILURE, because by verification time a
     * different tab was frontmost and a Chrome window only exposes its ACTIVE
     * tab to Accessibility. A false failure is worse than no answer: across a
     * twelve-run matrix it would quietly mark good models as bad.
     *
     * So the verdict is `pass` only on evidence, `fail` only on evidence
     * (the options are right there and 2TB is not the chosen one), and
     * `unseen` when the page that would answer is not on screen — which the
     * saved screenshot then settles by eye.
     */
    const verdict =
      radios.length === 0 ? 'unseen' : chosen.some((c) => /2\s*TB/i.test(c)) ? 'pass' : 'fail';

    return {
      finalScreenshot: shotPath,
      window: snap.window,
      windowTitles: titles,
      axElements: (snap.elements ?? []).length,
      // What the PAGE says — the verdict, and why it says that.
      verdict,
      storageOffered: radios.length,
      storageSelected: chosen,
      selected2TB: verdict === 'pass',
      // What the MODEL said, kept beside it so the two can disagree in the log.
      modelSaidSomething: last.text.trim().length > 0,
      modelMentions2TB: /2\s*tb/i.test(last.text),
    };
  },
});
