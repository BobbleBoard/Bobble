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
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.5-9b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';
const TOPIC = process.env.TOPIC ?? 'wikipedia.org';

await demoRun({
  name: process.env.RUN_NAME ?? `chrome-${MODEL}-${MODE}`,
  app: 'Google Chrome',
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
