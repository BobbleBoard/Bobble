/**
 * THE MONITOR RIDES THE ACTIVITY TAB (2026-09-13). The user: "activity tab should be
 * computer use page if the latest command is something like 'mac snapshot'".
 * The tab no longer opens on a session by itself — it opens on the model's own
 * `mac …` call, newest wins. A probe that only starts the mock session has to
 * SAY that call happened: one assistant turn with a `mac snapshot` through
 * bash, through the store every probe drives.
 */

/** Seed the thread with a `mac snapshot` call so the Activity tab becomes the monitor. */
export async function driveMacThroughActivity(page) {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
  await page.evaluate(() => {
    const now = Date.now();
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u-mac', text: 'open textedit and type', timestamp: now },
        {
          kind: 'assistant',
          id: 'a-mac',
          blocks: [
            {
              type: 'toolCall',
              id: 'c-mac',
              name: 'bash',
              arguments: { command: 'mac snapshot' },
            },
          ],
          timestamp: now,
          isStreaming: false,
        },
        {
          kind: 'toolResult',
          id: 'tr-c-mac',
          toolCallId: 'c-mac',
          toolName: 'bash',
          text: 'You are controlling TextEdit',
          isError: false,
          timestamp: now,
        },
      ],
    });
  });
}

/** The Activity tab while it is the monitor, or null. */
export const monitorTab = (page) =>
  page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const t = c?.getState().tabs.find((x) => x.kind === 'computer-use');
    return t === undefined
      ? null
      : { id: t.id, key: t.key, kind: t.kind, title: t.title, subtitle: t.subtitle };
  });

/** Wait for the Activity tab to become the monitor. */
export async function waitForMonitorTab(page, timeout = 15_000) {
  try {
    await page.waitForFunction(
      () => {
        const c = window.__pi_canvas?.();
        return c?.getState().tabs.some((t) => t.kind === 'computer-use') === true;
      },
      undefined,
      { timeout, polling: 120 },
    );
    return true;
  } catch {
    return false;
  }
}
