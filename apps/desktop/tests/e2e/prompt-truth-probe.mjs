/**
 * GROUND TRUTH: what does the model ACTUALLY receive?
 *
 * The user: "often the issue is that the instructions we for whatever reason
 * actually just [are] not appended to the system prompt."
 *
 * This drives the REAL app with the bash-CLI interface on, sends a fresh
 * message and then a FOLLOW-UP, and reads the harness's prompt tap — the
 * outgoing provider payload, recorded verbatim. It asserts nothing about the
 * source; it reports what went over the wire.
 *
 * The follow-up matters as much as the first message: the system prompt is
 * cached across turns, so an instruction can be present on turn 1 and gone on
 * turn 2 (or the reverse) without a line of code looking wrong.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/prompt-truth';
mkdirSync(OUT, { recursive: true });
const TAP = path.join(OUT, 'tap.jsonl');
writeFileSync(TAP, '');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const settingsPath = path.join(homedir(), '.pi/desktop/settings.json');
const backup = readFileSync(settingsPath, 'utf8');
const settings = JSON.parse(backup);
settings.modelSelection = { mode: 'model', modelId: MODEL };
settings.toolInterface = process.env.INTERFACE ?? 'bash-cli';
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log('[truth] toolInterface =', settings.toolInterface);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    // The EXISTING ground-truth seam (provider-llamacpp advanced-hook), not a
    // new one: PI_ADV_DEBUG_TOOLS has logged the active tool set per request for
    // a while; PI_ADV_DEBUG_PROMPT now adds the prompt itself.
    PI_ADV_DEBUG_TOOLS: path.join(OUT, 'tools.log'),
    PI_ADV_DEBUG_PROMPT: TAP,
  },
});

/*
 * WAIT FOR THE USER MESSAGE FIRST.
 *
 * The first version of this checked only for "an assistant message exists and
 * nothing is streaming", which is true the instant a RESTORED session loads —
 * so it returned immediately, twice, and recorded zero provider requests. The
 * empty tap looked like a broken tap and was a broken probe.
 */
const appLog = path.join(OUT, 'app.log');
writeFileSync(appLog, '');
for (const st of [app.process().stdout, app.process().stderr]) {
  st?.on('data', (d) => {
    try {
      appendFileSync(appLog, String(d));
    } catch {}
  });
}

const ask = async (win, text, capMs) => {
  const before = await win.evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0);
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(text);
  await win.keyboard.press('Enter');
  const landed = await win
    .waitForFunction(
      (n) =>
        (window.__pi_store?.().getState?.().messages ?? []).slice(n).some((m) => m.kind === 'user'),
      before,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  console.log(`[truth] asked (landed=${landed}):`, text);
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    const done = await win
      .evaluate((n) => {
        const ms = window.__pi_store?.().getState?.().messages ?? [];
        const after = ms.slice(n);
        const userAt = after.findIndex((m) => m.kind === 'user');
        if (userAt < 0) return false;
        if (!after.slice(userAt + 1).some((m) => m.kind === 'assistant')) return false;
        return !ms.some((m) => m.isStreaming === true);
      }, before)
      .catch(() => false);
    if (done) break;
    if (win.isClosed()) throw new Error('window closed mid-turn');
    await win.waitForTimeout(3000).catch(() => undefined);
  }
  const tail = await win.evaluate((k) => {
    const ms = window.__pi_store?.().getState?.().messages ?? [];
    // An assistant message is BLOCKS, not `text` — reading the wrong field
    // printed four empty replies and hid what the app was actually saying.
    return ms.slice(k).map((m) => ({
      kind: m.kind,
      stop: m.stopReason ?? null,
      error: m.errorMessage ?? null,
      text: (m.blocks ?? [])
        .map((b) =>
          b.type === 'text' ? b.text : b.type === 'toolCall' ? `«${b.name}»` : `[${b.type}]`,
        )
        .join(' ')
        .slice(0, 220),
    }));
  }, before);
  console.log(`[truth]   messages ${before} → ${before + tail.length}`);
  for (const t of tail) {
    const err = t.error !== null ? ` ERROR=${t.error}` : '';
    console.log(`[truth]     ${t.kind}[stop=${t.stop}]${err}: ${t.text.replace(/\n/g, ' ')}`);
  }
};

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  await win.waitForTimeout(2500);
  await ask(win, 'Make me a picture of a red fox asleep in tall grass.', 240000);
  await ask(win, 'Now make a short door slam sound effect for it.', 240000);
} finally {
  writeFileSync(settingsPath, backup);
  await app.close().catch(() => {});
}

// ── report what was actually sent ────────────────────────────────────────────
const rows = readFileSync(TAP, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const marks = rows.filter((r) => r.event !== undefined);
for (const m of marks) console.log(`[truth] marker: ${m.event} pid=${m.pid}`);
const reqs = rows.filter((r) => r.event === undefined);
console.log(`\n[truth] ${marks.length} markers, ${reqs.length} provider requests recorded\n`);
/** The dump writes the system prompt as a STRING; an early version wrote an
    array of blocks. Tolerate both so an old capture still reads. */
const systemOf = (r) => (typeof r.system === 'string' ? r.system : (r.system ?? []).join('\n'));

reqs.forEach((r, i) => {
  const sys = systemOf(r);
  console.log(`#${i} systemChars=${sys.length} tools=[${(r.tools ?? []).join(', ')}]`);
  console.log(
    `     preamble: abilities=${/These commands are your abilities/.test(sys)} ` +
      `only-way=${/ONLY way/.test(sys)} ` +
      `never-unable=${/Never tell the user you are unable/.test(sys)}`,
  );
});
writeFileSync(
  path.join(OUT, 'first-system.txt'),
  typeof reqs[0]?.system === 'string'
    ? reqs[0].system
    : (reqs[0]?.system ?? []).join('\n---\n') || '(none)',
);
console.log(`\n[truth] full first system prompt → ${path.join(OUT, 'first-system.txt')}`);

/*
 * A GATE, not a report.
 *
 * The bug this probe exists for — instructions that are correct in source and
 * absent on the wire — is invisible to every unit test in the repo, because
 * every unit test asks the code what it would do rather than asking the server
 * what it got. Exiting non-zero is what makes this catch a regression instead of
 * describing one.
 */
if ((process.env.INTERFACE ?? 'bash-cli') === 'bash-cli') {
  const CLAUSES = [
    /These commands are your abilities/,
    /ONLY way/,
    /Never tell the user you are unable/,
  ];
  const bad = reqs.filter((r) => !CLAUSES.every((re) => re.test(systemOf(r))));
  if (reqs.length === 0) {
    console.error('[truth] FAIL: no provider requests recorded — nothing reached a model.');
    process.exit(1);
  }
  if (bad.length > 0) {
    console.error(
      `[truth] FAIL: ${bad.length}/${reqs.length} requests missing the bash-CLI preamble.`,
    );
    process.exit(1);
  }
  console.log(`[truth] OK: all ${reqs.length} requests carry the bash-CLI preamble.`);
}
