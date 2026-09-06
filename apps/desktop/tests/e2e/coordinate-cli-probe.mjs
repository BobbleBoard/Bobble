/**
 * IS `coordinate` ACTUALLY REACHABLE? — the registered/advertised/allowlisted trap.
 *
 * Four tools moved out of the advertised schemas and into a CLI group
 * (`coordinate`), which is only an improvement if the model can still reach
 * them. This repo has been burned by the difference before: a tool can be
 * REGISTERED, not advertised, and not allowlisted, and the three failures look
 * identical from outside — "the model chose not to delegate" is what a
 * completely unreachable tool looks like in a transcript.
 *
 * So this asks the app to run the command, through its OWN bash, with a REAL
 * model, and reads what came back.
 *
 *   MODEL=<id>   default qwen3.5-4b-mtp
 */
import { launchApp } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';

const { page, check, finish } = await launchApp('coordinate-cli', {
  realCache: true,
  env: { PI_BIN: undefined },
  timeout: 120_000,
});

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await page.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await page.waitForTimeout(4000);

  /*
   * `!` is the composer's bash prefix — the user's own shell, the same PATH the
   * model's `bash` tool gets. Running it this way takes the model's judgement
   * out of the question entirely: if the command is on PATH it answers, and if
   * the shim was never installed it says "command not found".
   */
  const runBash = async (cmd) => {
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(`!${cmd}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);
    return page.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      return m
        .slice(-4)
        .map((x) =>
          (x.blocks ?? [])
            .map((b) => b.text ?? b.output ?? '')
            .join('\n')
            .concat(x.text ?? '', x.output ?? ''),
        )
        .join('\n');
    });
  };

  const help = await runBash('coordinate --help');
  console.log('── coordinate --help ──\n', help.slice(0, 700));
  check(
    !/not found|No such file/i.test(help),
    'the `coordinate` command exists on the PATH bash gets',
  );
  for (const word of ['ask', 'plan', 'delegate', 'manager']) {
    check(help.includes(word), `--help lists \`${word}\``);
  }

  const bogus = await runBash('coordinate nonsense');
  console.log('\n── coordinate nonsense ──\n', bogus.slice(0, 400));
  check(
    /help|usage|command/i.test(bogus),
    'a wrong command points at --help rather than dead-ending',
  );
} finally {
  await finish();
}
