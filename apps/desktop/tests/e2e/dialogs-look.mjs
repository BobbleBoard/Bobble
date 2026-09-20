/**
 * LOOK at every dialog the app can open without a model, in both themes.
 * the user (2026-09-20), on the task dialog: "that modal and all similar look
 * incredibly generic and lack hierarchy in the slightest, redesign them".
 *
 * Each dialog is opened the way a person opens it (or, for the ones the
 * harness raises — a permission prompt, a confirm, the queue explainer — by
 * seeding the store the way the event router would), photographed, and
 * measured: the title's size and weight against the labels' and the body's,
 * so the type steps the redesign promises are numbers, not an impression.
 *
 *   SHOT_DIR=/tmp/dialogs node apps/desktop/tests/e2e/dialogs-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/dialogs';
mkdirSync(SHOT_DIR, { recursive: true });
// Power mode, so the composer's Advanced panel (a dialog too) is on the page.
const home = probeHome('dialogs');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'tier', tier: 'balanced' } }, null, 2)}\n`,
);
const { page, check, finish } = await launchApp('dialogs', {
  waitFor: '[data-testid="composer-input"]',
  env: { HOME: home },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setTheme = async (mode) => {
  await page.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};

/** The open dialog's type steps and geometry. */
const measure = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('.pd-dialog[data-state="open"]');
    if (!dlg) return null;
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const title = cs(dlg.querySelector('.pd-dialog-title'));
    const desc = cs(dlg.querySelector('.pd-dialog-description'));
    const label = cs(dlg.querySelector('.pd-field-label'));
    const hero = cs(dlg.querySelector('.pd-field--hero .pd-textarea, .pd-field--hero .pd-input'));
    const summary = dlg.querySelector('.pd-dialog-summary');
    const footer = dlg.querySelector('.pd-dialog-footer');
    const primary = footer?.querySelector('.pd-btn--primary, .pd-btn--accent, .pd-btn-danger');
    const box = dlg.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      title: title ? `${title.fontSize}/${title.lineHeight} w${title.fontWeight}` : null,
      description: desc ? `${desc.fontSize} ${desc.color}` : null,
      label: label ? `${label.fontSize} w${label.fontWeight} ${label.color}` : null,
      hero: hero ? `${hero.fontSize}/${hero.lineHeight}` : null,
      summary: summary ? getComputedStyle(summary).backgroundColor : null,
      footerPad: footer ? getComputedStyle(footer).padding : null,
      primary: primary ? primary.textContent?.trim() : null,
      filledButtons: footer
        ? [...footer.querySelectorAll('.pd-btn--primary, .pd-btn--accent, .pd-btn-danger')].length
        : 0,
    };
  });

/** Photograph the open dialog with a margin of the scrim around it. */
const shoot = async (name) => {
  const box = await page.evaluate(() => {
    const dlg = document.querySelector('.pd-dialog[data-state="open"]');
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (box === null) {
    check(false, `${name}: a dialog is open`);
    return null;
  }
  const pad = 40;
  await page.screenshot({
    path: `${SHOT_DIR}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  const m = await measure();
  console.log(name, JSON.stringify(m));
  return m;
};
const closeDialog = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.pd-dialog[data-state="open"]'), {
    timeout: 5000,
  });
  await sleep(300);
};

const results = {};
try {
  for (const mode of ['dark', 'light']) {
    await setTheme(mode);
    await sleep(300);

    // 1. New task — empty, then with a sentence the parser reads.
    await page.click('[data-testid="nav-scheduled"]');
    await sleep(600);
    await page.click('[data-testid="sd-new"]');
    await page.waitForSelector('[data-testid="sd-editor"]');
    await sleep(500);
    results[`task-empty-${mode}`] = await shoot(`task-empty-${mode}`);
    await page.click('[data-testid="sd-editor-prompt"]');
    await page.keyboard.type(
      'Every friday at 4:30pm run the full test suite and tell me what failed',
    );
    await sleep(500);
    results[`task-typed-${mode}`] = await shoot(`task-typed-${mode}`);
    await closeDialog();

    // 2. Add a server.
    await page.click('[data-testid="nav-connectors"]');
    await sleep(800);
    const addRow = page.locator('[data-testid="connectors-add-server"]').first();
    if ((await addRow.count()) > 0) {
      await addRow.click();
      await page.waitForSelector('[data-testid="add-server-dialog"]');
      await sleep(500);
      results[`add-server-${mode}`] = await shoot(`add-server-${mode}`);
      await closeDialog();
    } else {
      check(false, `${mode}: the Add a server row is on the connectors page`);
    }

    // 3. The harness asking permission, and a plain confirm — seeded the way
    //    the event router seeds them.
    await page.click('[data-testid="nav-new-chat"], [data-testid="new-chat"]').catch(() => {});
    await sleep(500);
    await page.evaluate(() =>
      window.__pi_store().setState({
        uiRequests: [
          {
            id: 'perm-1',
            method: 'permission',
            permission: {
              v: 1,
              toolName: 'bash',
              reason: 'This command changes files outside the working folder.',
              args: { command: 'rm -rf ~/Library/Caches/old-build && git clean -fdx' },
            },
          },
        ],
      }),
    );
    await page.waitForSelector('[data-testid="permission-dialog"]');
    await sleep(500);
    results[`permission-${mode}`] = await shoot(`permission-${mode}`);
    await page.evaluate(() => window.__pi_store().setState({ uiRequests: [] }));
    await sleep(400);
    await page.evaluate(() =>
      window.__pi_store().setState({
        uiRequests: [
          {
            id: 'confirm-1',
            method: 'confirm',
            title: 'Replace the existing file?',
            message: 'notes.md already exists in this folder. Replacing it cannot be undone.',
          },
        ],
      }),
    );
    await page.waitForSelector('.pd-dialog[data-state="open"]');
    await sleep(500);
    results[`confirm-${mode}`] = await shoot(`confirm-${mode}`);
    await page.evaluate(() => window.__pi_store().setState({ uiRequests: [] }));
    await sleep(400);

    // 4. "Why isn't my message sending?" — a queued send, then its link.
    // A queue only holds while a turn is in flight; otherwise it drains at once.
    await page.evaluate(() =>
      window.__pi_store().setState({
        promptInFlight: true,
        queuedSends: [{ text: 'and one more thing', images: [], reason: 'model-loading' }],
      }),
    );
    await sleep(400);
    const why = page.locator('[data-testid="why-queued-link"]');
    if ((await why.count()) > 0) {
      await why.click();
      await page.waitForSelector('[data-testid="why-queued-modal"]');
      await sleep(500);
      results[`why-queued-${mode}`] = await shoot(`why-queued-${mode}`);
      await closeDialog();
    } else {
      check(false, `${mode}: the queued line shows its "why" link`);
    }
    await page.evaluate(() =>
      window.__pi_store().setState({ queuedSends: [], promptInFlight: false }),
    );

    // 5. Advanced parameters, from the composer's toggle.
    const adv = page.locator('[data-testid="advanced-params-toggle"]');
    if ((await adv.count()) > 0) {
      await adv.click();
      await page.waitForSelector('.pd-adv-panel[data-state="open"]');
      await sleep(600);
      results[`advanced-${mode}`] = await shoot(`advanced-${mode}`);
      await closeDialog();
    }
  }

  /*
   * THE STEPS. A dialog has a hierarchy when its title is a clear size AND
   * weight above its labels, its labels a weight above its body, and its
   * footer has exactly one filled button. Checked on the task dialog, the
   * one the user pointed at, in both themes.
   */
  for (const mode of ['dark', 'light']) {
    const m = results[`task-empty-${mode}`];
    check(m !== null && m !== undefined, `${mode}: the task dialog was measured`);
    if (!m) continue;
    const px = (s) => Number.parseFloat(String(s));
    check(m.title?.startsWith('20px/26px w600'), `${mode}: title 20/26 semibold (${m.title})`);
    check(m.description !== null, `${mode}: the dialog says what it is for`);
    check(
      px(m.label) === 13 && /w500/.test(m.label ?? ''),
      `${mode}: labels 13px medium (${m.label})`,
    );
    check(
      m.hero?.startsWith('15px/22px'),
      `${mode}: the instruction is the hero, 15/22 (${m.hero})`,
    );
    check(m.summary !== null, `${mode}: the consequence has its own surface`);
    check(
      m.filledButtons === 1 && m.primary === 'Schedule it',
      `${mode}: one filled button, the action (${m.primary})`,
    );
  }
  for (const name of ['add-server-dark', 'permission-dark', 'confirm-dark']) {
    const m = results[name];
    check(
      m?.title?.startsWith('20px/26px w600') && m.description !== null,
      `${name}: same title step and a description`,
    );
  }
} finally {
  await finish();
}
