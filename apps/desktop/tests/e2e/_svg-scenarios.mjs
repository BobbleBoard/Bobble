/**
 * DOES THE MODEL REACH FOR `svg` WHEN NOBODY SAID "SVG"?
 *
 * the user: "it should be able to if asked to make a website of some sort utilize
 * the svgs firsthand instead of writing its own or if asked for simple
 * illustrations even without 'svg' mentioned". Each scenario is a fresh chat;
 * the verdict comes from the session (which commands ran, what was refused)
 * and from the files (is every graphic on disk one OmniSVG drew?).
 *
 *   DEV=1 MAC_CU_MODEL=minicpm5-2b node tests/e2e/_svg-scenarios.mjs /tmp/svg-scn [names…]
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const SCENARIOS = {
  website:
    'Make me a simple one-page website for a coffee shop called Bean There: a logo, a hero section, and three feature icons (fresh beans, fast wifi, cozy seats). Save it in a folder called beanthere.',
  illustration: 'Draw me a simple illustration of a cat sitting on a crescent moon.',
  icon: 'I need an icon of a gear for the settings button in my app.',
  inline: 'Create an HTML page with an inline SVG logo of a mountain at the top.',
  negative: 'Write a Python function that reverses a string and save it as rev.py.',
};
const DEV = process.env.DEV === '1';
const CHAT_MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const OUT = process.argv[2] ?? '/tmp/svg-scenarios';
const names = process.argv.slice(3).length > 0 ? process.argv.slice(3) : Object.keys(SCENARIOS);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

/* A scratch cache: the real models linked in, OmniSVG from the parked copy. */
const HOME = mkdtempSync(path.join(tmpdir(), 'svg-scn-home-'));
const CACHE = path.join(HOME, 'cache');
const real = path.join(homedir(), '.cache/bobble');
mkdirSync(path.join(CACHE, 'models'), { recursive: true });
for (const e of readdirSync(real))
  if (e !== 'models') symlinkSync(path.join(real, e), path.join(CACHE, e));
for (const e of readdirSync(path.join(real, 'models'))) {
  if (e.startsWith('.')) continue;
  symlinkSync(path.join(real, 'models', e), path.join(CACHE, 'models', e));
}
const parked = path.join(real, 'models', '.omnisvg-1.1-4b.staged');
symlinkSync(
  existsSync(parked) ? parked : path.join(real, 'models', 'omnisvg-1.1-4b'),
  path.join(CACHE, 'models', 'omnisvg-1.1-4b'),
);

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const app = await electron.launch({
  executablePath: DEV
    ? createRequire(import.meta.url)('electron')
    : '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: DEV
    ? [appRoot, `--user-data-dir=${path.join(HOME, 'udd')}`]
    : [`--user-data-dir=${path.join(HOME, 'udd')}`],
  env: { ...process.env, HOME, PI_DESKTOP_CACHE_DIR: CACHE, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

function walk(root, pred, depth = 0, out = []) {
  if (depth > 6 || !existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (
      e.name.startsWith('.') ||
      e.name === 'udd' ||
      e.name === 'cache' ||
      e.name === 'node_modules'
    )
      continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, pred, depth + 1, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}
const INLINE_DRAWN =
  /<svg[\s>][\s\S]*?<(?:path|circle|rect|polygon|ellipse|line|polyline)\b[\s\S]*?<\/svg>/gi;

function newestSession() {
  const files = walk(path.join(HOME, '.pi', 'agent', 'sessions'), (p) => p.endsWith('.jsonl'));
  return files.map((p) => ({ p, t: statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.p;
}
function readSession(file) {
  const calls = [];
  const results = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    if (!m || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === 'toolCall') calls.push({ name: c.name, args: c.arguments });
      if (c.type === 'toolResult' || m.role === 'toolResult') {
        const txt = Array.isArray(c.content)
          ? c.content.map((x) => x.text ?? '').join('')
          : (c.text ?? '');
        if (txt) results.push(txt);
      }
    }
    if (m.role === 'toolResult' && Array.isArray(m.content)) {
      for (const c of m.content) if (c.type === 'text') results.push(c.text);
    }
  }
  return { calls, results };
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const up = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    CHAT_MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  await page.evaluate(
    (id) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ modelSelection: { mode: 'model', modelId: id } }),
    CHAT_MODEL,
  );
  const capacity = () =>
    page.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });

  const report = [];
  for (const name of names) {
    const prompt = SCENARIOS[name];
    if (prompt === undefined) throw new Error(`unknown scenario ${name}`);
    const before = new Set(walk(HOME, () => true));
    await page.getByText('New chat', { exact: true }).first().click();
    await page.waitForTimeout(2000);
    for (let i = 0; i < 40 && !(await capacity()); i += 1) await sleep(500);
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.type(prompt, { delay: 8 });
    await sleep(300);
    await page.keyboard.press('Enter');
    const started = Date.now();
    say(`[${name}] sent`);
    const deadline = Date.now() + Number(process.env.SCENARIO_MS ?? 420_000);
    let n = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      const s = await page.evaluate(() => {
        const st = window.__pi_store().getState();
        return { n: st.messages.length, streaming: st.agent.isStreaming };
      });
      n = s.n;
      if (!s.streaming && s.n > 1 && (await capacity())) {
        await sleep(2500);
        if (await capacity()) break;
      }
    }
    const took = ((Date.now() - started) / 1000).toFixed(0);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const session = newestSession();
    const { calls, results } = session ? readSession(session) : { calls: [], results: [] };
    /* `svg` anywhere in a command chain (`cd x && svg …`), not `svg --help` and
       not a path that merely contains "svg". */
    const isSvgRun = (cmd) => /(^|[;&|]|\s)svg\s+(?!--help\b|-h\b)\S/.test(String(cmd));
    const svgCalls = calls
      .filter((c) => c.name === 'generate_svg' || (c.name === 'bash' && isSvgRun(c.args?.command)))
      .map((c) => (c.name === 'bash' ? c.args.command : JSON.stringify(c.args)));
    const refusals = results.filter((r) => /^Not (written|edited):/.test(r)).length;
    const files = walk(HOME, (p) => !before.has(p) && /\.(html?|svg|py|css|js)$/i.test(p));
    /* OmniSVG's decoder writes a DECIMAL viewBox ("0.0 0.0 200.0 200.0"); a
       hand-drawn one is integer ("0 0 100 100"). That signature tells a drawn
       file from an invented one wherever it landed. */
    const isOmniSvg = (t) => /viewBox="[^"]*\.\d/.test(t);
    const newSvgs = files.filter((p) => p.endsWith('.svg'));
    const drawn = newSvgs.filter((p) => isOmniSvg(readFileSync(p, 'utf8')));
    const handwrittenSvgs = newSvgs.filter(
      (p) => !p.includes('/Bobble/generated/') && !isOmniSvg(readFileSync(p, 'utf8')),
    );
    const pages = files.filter((p) => /\.html?$/i.test(p));
    const inlineDrawn = pages.reduce(
      (acc, p) => acc + (readFileSync(p, 'utf8').match(INLINE_DRAWN) ?? []).length,
      0,
    );
    const imgRefs = pages.flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(/<img[^>]+src="([^"]+\.svg)"/gi)].map((m) => ({
        page: p,
        src: m[1],
        exists: existsSync(path.resolve(path.dirname(p), m[1])),
      })),
    );
    const finalText = await page.evaluate(() => {
      const st = window.__pi_store().getState();
      const last = [...st.messages].reverse().find((m) => m.kind === 'assistant');
      return (
        last?.text ??
        last?.blocks
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('') ??
        ''
      ).slice(0, 300);
    });
    const row = {
      name,
      took: `${took}s`,
      msgs: n,
      svgCalls,
      drawn: drawn.length,
      refusals,
      files: files.map((f) => path.relative(HOME, f)),
      handwrittenSvgs: handwrittenSvgs.map((f) => path.relative(HOME, f)),
      inlineDrawn,
      imgRefs: imgRefs.map((r) => `${r.src}${r.exists ? '' : ' (MISSING)'}`),
      finalText,
    };
    report.push(row);
    console.log(JSON.stringify(row, null, 1));
  }
  console.log('SUMMARY');
  for (const r of report) {
    /* A pass DRAWS its graphics (an OmniSVG file appeared) and hand-writes none,
       inline or as a file. The negative must leave svg untouched entirely. */
    const ok =
      r.name === 'negative'
        ? r.svgCalls.length === 0 && r.drawn === 0 && r.refusals === 0
        : r.drawn > 0 && r.handwrittenSvgs.length === 0 && r.inlineDrawn === 0;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${r.name.padEnd(13)} drawn=${r.drawn} svgCmd=${r.svgCalls.length} refused=${r.refusals} handwritten=${r.handwrittenSvgs.length} inline=${r.inlineDrawn} imgRefs=${r.imgRefs.length} ${r.took}`,
    );
  }
  console.log(`HOME=${HOME}`);
} finally {
  await app.close().catch(() => {});
}
