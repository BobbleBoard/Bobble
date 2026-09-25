/**
 * A CHAT'S GENERATING CARD SHOWS ITS OWN JOB'S FRAMES — not a studio's clip.
 *
 * From the review of the 2026-09-23 wave (renderer-ui): the card took every
 * decoded frame on both streams with one high-water mark. A HyperFrames render
 * in the Video studio, running beside the chat's picture, swept the picture's
 * card away onto a motion-graphics frame; its frame numbers (~100) then
 * outnumbered every denoise step the picture would ever send.
 *
 * Staged in the real app, no engine: the chat's generate_image card is up, its
 * job announced the way main announces an agent's (`gen3d:agent-job`); then a
 * studio clip's frame arrives (`gen:update`, video, with the studio's request
 * id, a magenta PNG on disk), then the picture's own step 3 (`gen3d:job`,
 * an evening sky).
 *
 *   a-foreign-frame   after the studio's frame: the card should still be waiting
 *   b-own-step        after its own step: the card should show the evening sky
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/live-frames-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { launchApp } from './harness.mjs';
import { cropPng, eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, check, finish, home, shotDir } = await launchApp('live-frames', {
  waitFor: '[data-testid="composer-input"]',
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });

/** A flat magenta PNG with a white bar — unmistakably not the evening sky. */
function magenta(w = 384, h = 216) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const bar = y > h * 0.45 && y < h * 0.55;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = bar ? 255 : 220;
      raw[o + 1] = bar ? 255 : 30;
      raw[o + 2] = bar ? 255 : 200;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const clipDir = path.join(home, 'Bobble', 'generated', 'studio-clip');
mkdirSync(clipDir, { recursive: true });
const FRAME = path.join(clipDir, 'frame_0100.png');
writeFileSync(FRAME, magenta());

const send = (channel, payload) =>
  app.evaluate(
    ({ BrowserWindow }, [channel, payload]) => {
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('pi-desktop:event', { channel, payload });
    },
    [channel, payload],
  );
const card = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="pending-media-card"]');
    return {
      revealing: el?.getAttribute('data-revealing') ?? null,
      preview: el?.querySelector('[data-testid="pending-preview"]')?.getAttribute('src') ?? null,
    };
  });
const cardShot = async (label) => {
  const buf = await page.screenshot();
  const box = await page.locator('[data-testid="pending-media-card"]').first().boundingBox();
  if (box === null) return writeFileSync(path.join(OUT, `${label}.png`), buf);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  writeFileSync(
    path.join(OUT, `${label}.png`),
    cropPng(buf, {
      x: Math.max(0, Math.round((box.x - 24) * dpr)),
      y: Math.max(0, Math.round((box.y - 48) * dpr)),
      width: Math.round((box.width + 48) * dpr),
      height: Math.round((box.height + 72) * dpr),
    }),
  );
};

try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
  await page.evaluate(() => {
    window.__pi_theme?.()?.setFlavor?.('bobble');
    window.__pi_theme?.()?.setMode?.('dark');
  });
  await sleep(800);
  await page.evaluate(() =>
    window.__pi_store().setState({
      session: { sessionFile: '/probe/chat.jsonl', cwd: '/probe' },
      agent: { isStreaming: true },
      messages: [
        { kind: 'user', id: 'u1', text: 'an evening sky over hills', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [
            {
              type: 'toolCall',
              id: 'g1',
              name: 'generate_image',
              arguments: { prompt: 'an evening sky over hills' },
            },
          ],
          timestamp: 2,
          isStreaming: true,
        },
      ],
      runningToolCalls: ['g1'],
    }),
  );
  await page.waitForSelector('[data-testid="pending-media-card"] canvas', { timeout: 10_000 });
  // The chat's picture, as main announces an agent's job the moment it has an id.
  await send('gen3d:agent-job', { jobId: 'img-chat-1' });
  await sleep(1200);

  // A clip rendering in the Video studio meanwhile: its 100th frame.
  await send('gen:update', {
    tabId: 'pi:gen-hf-studio-1',
    payload: {
      modality: 'video',
      model: { id: 'hyperframes', label: 'HyperFrames', license: 'Apache-2.0' },
      prompt: 'a kinetic title card',
      requestId: 'studio-video-1',
      candidates: [{ status: 'generating', previewSrc: `pd-file://f${FRAME}` }],
      progress: { candidate: 0, step: 100, total: 121 },
      status: 'generating',
    },
  });
  await sleep(2200);
  const a = await card();
  await cardShot('a-foreign-frame');
  console.log('after the studio clip frame:', JSON.stringify(a));
  check(
    a.revealing === null && a.preview === null,
    `the chat's picture card ignores a studio clip's frame (${JSON.stringify(a)})`,
  );

  // The picture's own third step.
  await send('gen3d:job', {
    jobId: 'img-chat-1',
    stage: 'image',
    message: '',
    stagePercent: 30,
    overallPercent: 30,
    done: false,
    preview: {
      dataUri: `data:image/png;base64,${eveningPng().toString('base64')}`,
      step: 3,
      totalSteps: 8,
      width: 384,
      height: 384,
    },
  });
  await sleep(2200);
  const b = await card();
  await cardShot('b-own-step');
  console.log('after its own step 3:', JSON.stringify({ ...b, preview: b.preview?.slice(0, 40) }));
  check(
    (b.preview ?? '').startsWith('data:image/png'),
    `…and shows its own step when it lands (${(b.preview ?? 'none').slice(0, 40)})`,
  );
} finally {
  await finish();
}
