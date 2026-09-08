/**
 * Adding a server by hand is one button and one form that a person can
 * actually type into.
 *
 * The Connectors "Create" menu used to list four rows ("Create plugin", "Add
 * marketplace", "Record a skill", "Request a plugin"), every one wired to
 * `onSelect={() => undefined}`, while the path for adding an MCP server by
 * hand already existed with no way in. Then the dialog that replaced it was
 * a 320px unpadded column that Enter could not submit.
 *
 * Drives the real app: opens the dialog, submits it EMPTY (the error appears
 * in place, nothing closes), fills the two fields plus an env line, submits
 * with Enter, and asserts the server reaches the registry — the actual round
 * trip — and that the keyboard lands back on the Add button. Headless.
 */
import { launchApp } from './harness.mjs';

const { page, check, finish } = await launchApp('add-server-probe', {
  waitFor: '[data-testid="nav-connectors"]',
});

const active = () =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? 'body');

try {
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });

  /*
   * The button, not a menu. This probe used to assert the menu had exactly
   * one item — now it asserts there is no menu to open.
   */
  const menus = await page.evaluate(
    () => document.querySelectorAll('[data-testid="connectors-create-menu"]').length,
  );
  check(menus === 0, 'the one-item Create menu is back');

  await page.click('[data-testid="connectors-add-server"]');
  await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  check((await active()) === 'add-server-name', 'focus lands in the Name field on open');

  // The form is a form: its fields sit inside the dialog's padded body, level
  // with the title — not flush to the glass.
  const [dialog, title, name] = await page.evaluate(() =>
    [
      '[data-testid="add-server-dialog"]',
      '[data-testid="add-server-dialog"] h2',
      '#add-server-name',
    ].map((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r === undefined ? null : { x: Math.round(r.x), w: Math.round(r.width) };
    }),
  );
  check(dialog !== null && dialog.w >= 460, `the dialog has a width of its own (${dialog?.w}px)`);
  check(
    title !== null && name !== null && Math.abs(title.x - name.x) <= 1,
    'the Name field is level with the title',
  );

  // Submitting empty says what is missing, in place; the primary stays live.
  const disabled = await page.evaluate(
    () => document.querySelector('[data-testid="add-server-submit"]')?.disabled ?? null,
  );
  check(disabled === false, 'the primary is not disabled as a substitute for an error');
  await page.click('[data-testid="add-server-submit"]');
  await page.waitForTimeout(250);
  check(await page.$('[data-testid="add-server-name-error"]'), 'an inline error under Name');
  check(await page.$('[data-testid="add-server-command-error"]'), 'an inline error under Command');
  check(await page.$('[data-testid="add-server-dialog"]'), 'the dialog stays open');
  check((await active()) === 'add-server-name', 'focus moves to the first missing field');

  // Two visible fields; the environment sits behind "More options".
  await page.fill('[data-testid="add-server-name"]', 'Probe Weather');
  await page.fill('[data-testid="add-server-command"]', 'npx -y @acme/weather-mcp');
  await page.click('[data-testid="add-server-more"]');
  await page.waitForSelector('[data-testid="add-server-env"]', { timeout: 3000 });
  await page.fill('[data-testid="add-server-env"]', 'WEATHER_KEY=abc123');

  // Enter submits from a single-line field.
  await page.focus('[data-testid="add-server-name"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check(!(await page.$('[data-testid="add-server-dialog"]')), 'Enter submitted the form');

  // The round trip that matters: it is in the registry main wrote.
  const server = await page.evaluate(async () => {
    const { registry } = await window.piDesktop.invoke('connectors:list', undefined);
    return (registry?.servers ?? []).find((s) => s.id === 'probe-weather') ?? null;
  });
  if (check(server !== null, 'the server never reached the registry')) {
    console.log(`[mcp] registry has it (${JSON.stringify(server)})`);
    check(server.command === 'npx', `command wrong: ${server.command}`);
    check(
      JSON.stringify(server.args) === JSON.stringify(['-y', '@acme/weather-mcp']),
      `args wrong: ${JSON.stringify(server.args)}`,
    );
    check(server.env?.WEATHER_KEY === 'abc123', `env wrong: ${JSON.stringify(server.env)}`);
    check(server.enabled === true, 'a hand-added server lands on');
  }

  // Its detail opened on it — a hand-added server is a first-class item.
  await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
  check(
    ((await page.textContent('[data-testid="connector-detail"] h2')) ?? '').startsWith(
      'Probe Weather',
    ),
    'the detail opened on the new server',
  );
  check(
    await page.$('[data-testid="connector-card-custom:probe-weather"]'),
    'the new server has a card of its own',
  );

  // And the keyboard is somewhere: Cancel and Escape both return it to the button.
  await page.keyboard.press('Escape');
  await page.click('[data-testid="connectors-add-server"]');
  await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
  await page.click('[data-testid="add-server-cancel"]');
  await page.waitForTimeout(300);
  check((await active()) === 'connectors-add-server', `focus after Cancel: ${await active()}`);
  await page.click('[data-testid="connectors-add-server"]');
  await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await active()) === 'connectors-add-server', `focus after Escape: ${await active()}`);
} finally {
  await finish();
}
