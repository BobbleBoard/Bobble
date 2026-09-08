/**
 * Round-9 adversarial E2E — CONNECTORS: SKILLS + BASH-CLI MODE (failure points
 * #9, #10). Isolated HOME so all persistence is deterministic. Headless.
 *
 *  #10 BASH-CLI MODE: switching the MCP mode to "Bash CLI" persists to
 *      settings.json (mcpMode) AND rewrites the connector registry
 *      (mcp-connectors.json .mode) AND is reflected in the renderer settings
 *      store (window.__settings_store). [The tool-registry wiring itself — the
 *      generated pi-tool shim dir + socket + PATH injection — lives in the pi
 *      child via @pi-desktop/mcp-lite and is covered by that package's unit
 *      tests, out of reach of a mock-pi desktop probe.]
 *  #9  SKILLS: skills are rows in the one list, under their own section; a
 *      skill's "+" COPIES it into the isolated skills dir
 *      (~/.pi/agent/skills/<id>/SKILL.md); "Turn off" in its "···" menu
 *      removes it. (There is no Skills pill any more: the screen has no filter
 *      pills at all, by design — the sections are the grouping.)
 *
 * Also: the two bundled tools are BUILT IN — no "+", no menu — and installing
 * a builtin over IPC is a rejected no-op that never seeds a phantom server.
 * Run `pnpm build` first.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';

const fixture = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

const { page, check, finish, home } = await launchApp('round9-connectors-probe', {
  fixture,
  waitFor: '[data-testid="composer-input"]',
});

const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const mcpPath = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
const skillFile = path.join(home, '.pi', 'agent', 'skills', 'code-review', 'SKILL.md');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function waitFor(predicate, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return check(false, `timed out waiting for ${label}`);
}

const search = async (q) => {
  await page.fill('[data-testid="connectors-search"]', q);
  await page.waitForTimeout(250);
};

try {
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });

  // ── BUILT IN: our own tool (Video editing) and HeyGen's HyperFrames are both
  // in the "Built in" section, with nothing to press — no "+", no menu. ──
  for (const id of ['video-editing', 'hyperframes']) {
    await search(id === 'video-editing' ? 'video' : 'hyperframes');
    await page.waitForSelector(
      `[data-testid="connectors-section-builtin"] [data-testid="connector-card-${id}"]`,
      { timeout: 8000 },
    );
    check(!(await page.$(`[data-testid="connector-add-${id}"]`)), `${id} has no "+"`);
    check(!(await page.$(`[data-testid="connector-menu-${id}"]`)), `${id} has no menu`);
    check(
      !(await page.$(
        `[data-testid="connectors-section-dev"] [data-testid="connector-card-${id}"], [data-testid="connectors-section-media"] [data-testid="connector-card-${id}"]`,
      )),
      `${id} is not listed among the servers`,
    );
  }
  await search('');

  // ── BUILTIN INSTALL IS A REJECTED NO-OP (never seeds a phantom server) ───────
  const builtinInstall = await page.evaluate(() =>
    window.piDesktop.invoke('connectors:install', { id: 'hyperframes' }),
  );
  check(
    typeof builtinInstall.error === 'string',
    'installing a builtin should return an error (no-op)',
  );
  check(
    !builtinInstall.registry.servers.some((s) => s.id === 'hyperframes'),
    'a builtin must never be seeded into the connector registry',
  );

  // ── #10 BASH-CLI MODE reaches settings + the connector registry + the store ──
  // Add a plain connector (the "+") so the registry file exists, then flip mode.
  await search('memory');
  await page.click('[data-testid="connector-add-memory"]');
  await waitFor(() => readJson(mcpPath).servers.some((s) => s.id === 'memory'), 'memory installed');
  await search('');
  await page.click('[data-testid="connectors-mcp-mode"] >> text=Bash CLI');
  await waitFor(
    () => readJson(settingsPath).mcpMode === 'bash-cli',
    'mcpMode persisted to settings.json',
  );
  await waitFor(
    () => readJson(mcpPath).mode === 'bash-cli',
    'mode rewritten in the connector registry (mcp-connectors.json)',
  );
  const storeMode = await page.evaluate(
    () => window.__settings_store?.().getState().settings.mcpMode,
  );
  check(
    storeMode === 'bash-cli',
    `renderer settings store should reflect bash-cli, got ${JSON.stringify(storeMode)}`,
  );

  // ── #9 SKILLS: a row under Skills; its "+" → copied into the skills dir ──
  await page.waitForSelector(
    '[data-testid="connectors-section-skills"] [data-testid="connector-card-skill:code-review"]',
    { timeout: 8000 },
  );
  check(!(await page.$('[data-testid^="connectors-filter-"]')), 'no filter pills anywhere');
  check(!existsSync(skillFile), 'the skill should not be installed before toggling');
  await page.click('[data-testid="connector-add-skill:code-review"]');
  await waitFor(
    () => existsSync(skillFile),
    'skill copied into ~/.pi/agent/skills/code-review/SKILL.md',
  );
  // On, its control is the "···" menu; Turn off removes it from the skills dir.
  await page.waitForSelector('[data-testid="connector-menu-skill:code-review"]', {
    timeout: 8000,
  });
  await page.click('[data-testid="connector-menu-skill:code-review"]');
  await page.waitForSelector('[data-testid="connector-menu-toggle-skill:code-review"]', {
    timeout: 4000,
  });
  await page.click('[data-testid="connector-menu-toggle-skill:code-review"]');
  await waitFor(() => !existsSync(skillFile), 'skill removed from the skills dir on Turn off');

  console.log(
    'round9-connectors-probe: Video editing and HyperFrames under Built in with nothing to press; ' +
      'builtin install is a rejected no-op; the "+" added memory; Bash CLI mode persisted to ' +
      'settings.json + rewrote the registry + reflected in the store; the Skills section lists the ' +
      'bundled skills, a row "+" installed one (SKILL.md copied) and its menu removed it again',
  );
} finally {
  await finish();
}
