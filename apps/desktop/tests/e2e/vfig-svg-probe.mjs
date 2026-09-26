/**
 * VFIG IN THE APP — the real model behind `svg`, only the chat model scripted.
 *
 * The scripted model copies the kinetic-theory figure into the chat's folder,
 * runs `svg --figure --image fig31.png`, writes a logo, and runs `svg --edit
 * logo.svg "…"`. The app routes both jobs to VFIG (gen-tools svgEngineFor),
 * which runs as its own llama-server on the real weights (realCache). The
 * probe checks the replies the model got, that the figure came back as SVG
 * CODE with its words as <text>, that the edit changed the file in place, and
 * renders both for a person to look at.
 *
 *   OUT=/tmp/vfig-svg node ../../scripts/with-lock.mjs heavy -- node tests/e2e/vfig-svg-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIG = path.join(HERE, 'fixtures', 'stem', 'fig31.png');
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 210"><rect width="540" height="210" fill="#ffffff"/><path d="M40 170 V80 a50 50 0 0 1 100 0 V170 Z" fill="#2b2b2b"/><path d="M90 160 c-18 -14 -16 -34 0 -52 c16 18 18 38 0 52 Z" fill="#d9480f"/><text x="170" y="130" font-family="Georgia, serif" font-size="56" fill="#2b2b2b">Kiln &amp; Co</text></svg>\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockOpenAI({
  model: 'mock-4b',
  rules: [
    {
      name: 'done',
      match: { afterTool: 'Edited logo.svg' },
      reply: { content: 'Done: the figure is now SVG, and the flame is gold.' },
    },
    {
      name: 'edit',
      match: { afterTool: 'logo.svg' },
      reply: {
        toolCalls: [
          { name: 'bash', arguments: { command: 'svg --edit logo.svg "make the flame gold"' } },
        ],
      },
      times: 1,
    },
    {
      name: 'write-logo',
      match: { afterTool: 'Made 1 SVG' },
      reply: { toolCalls: [{ name: 'write', arguments: { path: 'logo.svg', content: LOGO } }] },
      times: 1,
    },
    {
      name: 'figure',
      match: { afterTool: 'fig31' },
      reply: {
        toolCalls: [{ name: 'bash', arguments: { command: 'svg --figure --image fig31.png' } }],
      },
      times: 1,
    },
    {
      name: 'copy',
      match: { lastUser: 'kinetic' },
      reply: {
        toolCalls: [
          { name: 'bash', arguments: { command: `cp "${FIG}" fig31.png && ls fig31.png` } },
        ],
      },
      times: 1,
    },
  ],
});

const home = probeHome('vfig-svg');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ modelSelection: { mode: 'tier', tier: 'balanced' }, loadVision: false }, null, 2)}\n`,
);
writeModelsJson(home, {
  provider: 'mock',
  api: 'llamacpp-stream',
  baseUrl: mock.baseUrl,
  model: 'mock-4b',
  name: 'Mock 4B',
  input: ['text', 'image'],
});

const { page, check, finish, shotDir } = await launchApp('vfig-svg', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1', PI_DESKTOP_GEN: '1' },
  timeout: 90_000,
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });

try {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(
    'Turn my kinetic theory figure into an SVG, then make the flame in the logo gold.',
  );
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  const ended = await page
    .waitForFunction(
      () => {
        const st = window.__pi_store().getState();
        const done = st.messages.some(
          (m) =>
            m.kind === 'assistant' &&
            (m.blocks ?? []).some((b) => (b.text ?? '').includes('flame is gold')),
        );
        return done && !st.messages.some((m) => m.isStreaming) && st.promptInFlight !== true;
      },
      undefined,
      { timeout: 600_000, polling: 1000 },
    )
    .then(() => true)
    .catch(() => false);
  console.log(
    `turn ${ended ? 'ended' : 'DID NOT END'} after ${Math.round((Date.now() - t0) / 1000)} s`,
  );
  check(ended, 'the turn ran to its answer');
  await sleep(1500);
  const results = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.filter((m) => m.kind === 'toolResult')
      .map((m) => ({ text: String(m.text ?? ''), error: m.isError === true })),
  );
  for (const r of results)
    console.log(`--- ${r.error ? 'ERROR ' : ''}result:\n${r.text.slice(0, 700)}`);
  const made = results.find((r) => r.text.startsWith('Made 1 SVG'));
  const edited = results.find((r) => r.text.startsWith('Edited logo.svg'));
  check(made !== undefined && /VFIG/.test(made.text), 'the figure went to VFIG');
  check(edited !== undefined && /VFIG/.test(edited.text), 'the edit went to VFIG');

  const bobble = path.join(home, 'Bobble');
  const folder = existsSync(bobble)
    ? readdirSync(bobble)
        .map((d) => path.join(bobble, d))
        .find((d) => existsSync(path.join(d, 'logo.svg')))
    : undefined;
  check(folder !== undefined, 'the chat folder holds the logo');
  const figPath = /\n {2}1\. (\S+\.svg)/.exec(made?.text ?? '')?.[1];
  const figSvg = figPath !== undefined && existsSync(figPath) ? readFileSync(figPath, 'utf8') : '';
  const texts = (figSvg.match(/<text\b/g) ?? []).length;
  console.log(`figure: ${figPath} — ${figSvg.length} chars, ${texts} <text>`);
  check(texts >= 2, `the figure is SVG code with its words as text (${texts} <text>)`);
  const logo = folder !== undefined ? readFileSync(path.join(folder, 'logo.svg'), 'utf8') : '';
  console.log(`logo after the edit: ${logo.length} chars`);
  check(
    logo !== LOGO && /<svg[\s>]/.test(logo) && /<\/svg>\s*$/.test(logo),
    'the edit changed logo.svg in place, and it is still whole',
  );
  check(/Kiln/.test(logo), 'the edit kept the logo’s words');
  // Render both, to look at.
  const render = (svg, name) => {
    if (svg === '') return;
    const src = path.join(OUT, `${name}.svg`);
    writeFileSync(src, svg);
    execFileSync('rsvg-convert', [
      '-w',
      '720',
      '-b',
      'white',
      src,
      '-o',
      path.join(OUT, `${name}.png`),
    ]);
  };
  render(figSvg, 'figure');
  render(LOGO, 'logo-before');
  render(logo, 'logo-after');
  await page.screenshot({ path: path.join(OUT, 'app.png') });
} finally {
  await finish();
  await mock.close?.();
}
