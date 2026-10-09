/**
 * CHROME, driven through its real DOM.
 *
 * The middle of the difficulty scale, and the one with a mechanism of its own:
 * Chrome is AX-opaque like Blender, but it answers Apple Events, so
 * `chrome_snapshot` reads the actual page and clicks land on real elements
 * rather than guessed coordinates. This measures whether a model reaches for
 * that route at all — the tools are named in its list either way.
 *
 * The evidence is the page Chrome ends up on, asked of Chrome.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { demoRun } from './demo-run.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CLEAR THE PROFILE PICKER BEFORE ATTACHING.
 *
 * REPORTED by the user twice: "chrome profile screen taking focus", and then every
 * Chrome run in the batch verified as `windowTitles: ["Who's using Chrome?"]`.
 * A Chrome sitting on the picker has no profile loaded — no tabs, no history, no
 * keychain — so attaching to it measures nothing, and the run cannot recover
 * because dismissing the picker is a click the task never asked for.
 *
 * The user, on this exact screen: "i'm ok hardcoding this one case". The least
 * presumptuous form of that is to reopen the profile CHROME ITSELF last used,
 * read out of its own Local State, rather than choosing one for them. Only ever
 * when the picker is the sole window — a Chrome the user is actually using is left
 * alone.
 */
async function clearProfilePicker() {
  const titles = await execFileAsync('osascript', [
    '-e',
    'tell application "System Events" to tell process "Google Chrome" to get name of windows',
  ]).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (titles === '' || !titles.includes("Who's using Chrome?")) return false;
  if (titles.split(', ').length > 1) return false;

  let profile = 'Default';
  try {
    const state = JSON.parse(
      readFileSync(
        `${process.env.HOME}/Library/Application Support/Google/Chrome/Local State`,
        'utf8',
      ),
    );
    profile = state?.profile?.last_used ?? 'Default';
  } catch {
    /* a fresh Chrome has no Local State yet; Default is right for that one */
  }
  await execFileAsync('osascript', ['-e', 'tell application "Google Chrome" to quit']).catch(
    () => {},
  );
  await sleep(2500);
  // -g so restoring his browser does not take the screen the run must not take.
  await execFileAsync('open', [
    '-g',
    '-a',
    'Google Chrome',
    '--args',
    `--profile-directory=${profile}`,
  ]);
  await sleep(4000);
  return true;
}

if (await clearProfilePicker()) console.log('cleared the Chrome profile picker');

const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.5-9b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
/* A different destination per run, for the same reason the Maps place varies: a
   tab already open on the target is not a navigation. */
const SITES = ['wikipedia.org', 'example.com', 'openstreetmap.org', 'archive.org'];
const TOPIC = process.env.TOPIC ?? SITES[Math.floor(Math.random() * SITES.length)] ?? 'example.com';

await demoRun({
  name: process.env.RUN_NAME ?? `chrome-${MODEL}-${MODE}`,
  app: 'Google Chrome',
  // Their real browser, as they left it — see demo-run's note on attaching.
  attach: true,
  model: MODEL,
  mode: MODE,
  prompt:
    `Use Google Chrome on this Mac — my own browser, not the built-in one — to open ${TOPIC}. ` +
    `Then tell me the title of the page that loaded.`,
  verify: async (dbg, last) => {
    const snap = await dbg('snapshot', { app: 'Google Chrome' });
    const wins = snap.windows ?? [];
    const titles = wins.map((w) => w.title ?? '').filter((t) => t !== '');
    const all = [snap.window ?? '', ...titles].join(' | ').toLowerCase();
    const host = TOPIC.replace(/^https?:\/\//, '').split('/')[0] ?? TOPIC;
    const word = host.split('.')[0] ?? host;
    return {
      windowTitles: titles,
      chromeOnTopic: all.includes(word),
      modelNamedATitle: last.text.length > 0,
      windows: wins.length,
    };
  },
});
