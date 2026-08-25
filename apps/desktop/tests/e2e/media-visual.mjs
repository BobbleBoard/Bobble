/**
 * THE GENERATED-MEDIA THREAD, LOOKED AT.
 *
 * Stages a real tool RESULT naming a real file into the live store and
 * photographs what the thread does with it — the components, the real decode,
 * the real waveform, at the real sizes. Faster than driving a model to generate
 * something on every styling change, and it exercises the same code path.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/media-visual';
mkdirSync(OUT, { recursive: true });
const WAV = process.env.WAV ?? path.join(homedir(), 'bobble-testbed/run19/door-slam.wav');

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 25000 });
await win.waitForTimeout(2500);

await win.evaluate(
  ({ wav }) => {
    const store = window.__pi_store();
    const now = Date.now();
    store.setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'make me a door slam sound effect', timestamp: now },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: now,
          blocks: [
            { type: 'text', text: 'Here is a door slam.' },
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'generate_sfx',
              arguments: { prompt: 'door slam' },
            },
          ],
          isStreaming: false,
        },
        {
          kind: 'toolResult',
          id: 'tr1',
          toolCallId: 'tc1',
          toolName: 'generate_sfx',
          text: `Generated 1 audio file:\n  1. ${wav} (seed 11)\nModel: stable-audio-open-small`,
          isError: false,
          timestamp: now,
        },
      ],
    });
  },
  { wav: WAV },
);
await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT, '1-audio.png'), fullPage: true });

const probe = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="thread-audio"]');
  const wave = document.querySelector('[data-testid="thread-audio-wave"]');
  const card = document.querySelector('[data-testid="thread-file-card"]');
  const bars = document.querySelectorAll('.pd-thread-audio-bar');
  const r = (n) => (n === null ? null : {
    w: Math.round(n.getBoundingClientRect().width),
    h: Math.round(n.getBoundingClientRect().height),
  });
  return {
    audio: r(el),
    wave: r(wave),
    card: r(card),
    bars: bars.length,
    cardText: card?.textContent ?? null,
  };
});
console.log('MEDIA:', JSON.stringify(probe, null, 1));
const rowText = await win.evaluate(() => {
  const media = document.querySelector('[data-testid="thread-media"]');
  const group = media?.closest('div')?.parentElement;
  const texts = [...(group?.querySelectorAll('*') ?? [])]
    .filter((n) => n.children.length === 0 && (n.textContent ?? '').trim().length > 0)
    .map((n) => `${n.tagName}.${String(n.className).slice(0, 28)}: ${(n.textContent ?? '').trim().slice(0, 40)}`);
  return texts.slice(0, 10);
});
console.log('ACTIVITY ROWS:', JSON.stringify(rowText));

// Hover the reveal button + press play, so the interactive states are in a shot.
await win.hover('[data-testid="thread-file-reveal"]').catch(() => {});
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(OUT, '2-reveal-hover.png') });
await win.click('[data-testid="thread-audio-play"]').catch(() => {});
await win.waitForTimeout(1200);
await win.screenshot({ path: path.join(OUT, '3-playing.png') });
const playState = await win.evaluate(() => {
  const on = document.querySelectorAll('.pd-thread-audio-bar[data-on="true"]').length;
  const a = document.querySelector('audio');
  return { litBars: on, currentTime: a?.currentTime ?? 0, paused: a?.paused ?? true };
});
console.log('PLAYING:', JSON.stringify(playState));
await app.close();
console.log('shots in', OUT);
