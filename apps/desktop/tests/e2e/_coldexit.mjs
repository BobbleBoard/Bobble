import { launchApp } from './harness.mjs';

const { app, page, finish, home } = await launchApp('cold-exit-diag', {
  env: { PI_BIN: undefined },
  realCache: true,
  timeout: 120_000,
});
const t0 = Date.now();
const keep = [];
const log = (tag) => (d) => {
  for (const l of String(d).split('\n'))
    if (l.trim())
      keep.push(`${String(Date.now() - t0).padStart(6)}ms [${tag}] ${l.trim().slice(0, 220)}`);
};
app.process().stdout?.on('data', log('out'));
app.process().stderr?.on('data', log('err'));
await page.click('[data-testid="composer-input"]');
await page.keyboard.type('In one sentence, what is the capital of France?');
await page.keyboard.press('Enter');
await page.waitForTimeout(9000);
console.log(`HOME=${home}`);
for (const l of keep)
  if (/pi |bridge|cwd|spawn|exit|ENOENT|Error|error|stderr/i.test(l)) console.log(l);
await finish();
