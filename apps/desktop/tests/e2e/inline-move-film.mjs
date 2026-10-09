/**
 * THE INLINE ⇄ CANVAS MOVE, MEASURED — does the morph land where the element
 * ends up?
 *
 * The user (2026-10-08): "the moving inlines between canvas and chat is good but
 * the animation seems smooth mostly but theres some jitteriness both ways".
 *
 * A chart card seeded into a thread (no model). Its corner control lifts it
 * into the canvas; the tab's Show in chat drops it back. For each direction the
 * probe reads the View Transition's own plan — the moving group's last keyframe
 * (where the morph ends) — the moment it starts, and then where the element
 * actually is once everything has settled. A gap between the two is a jump at
 * the end of the morph: the jitter. It also films each move (CDP screencast) to
 * look at frame by frame, and logs how far the canvas rail's width moved after
 * the morph had captured it.
 *
 * SNAPS=1 instead takes real screenshots at fixed times after each click
 * (SNAP_AT=ms,ms,…) — the screencast drops and delays frames mid-transition.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/inline-move-film.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, check, shotDir, finish } = await launchApp('inline-move', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdp = await page.context().newCDPSession(page);

async function film(name, act) {
  const dir = path.join(shotDir, name);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const onFrame = async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  await sleep(150);
  const plan = await act();
  await sleep(900);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const t0 = frames[0]?.t ?? 0;
  for (const [i, f] of frames.entries()) {
    writeFileSync(
      path.join(dir, `${String(i).padStart(3, '0')}-${Math.round((f.t - t0) * 1000)}ms.jpg`),
      Buffer.from(f.data, 'base64'),
    );
  }
  return { frames: frames.length, plan };
}

/** Click `selector`, then read the morph's plan on the next frame. */
const clickAndReadPlan = (selector) =>
  page.evaluate(async (sel) => {
    const rail = () =>
      document.querySelector('.pd-canvas-rail')?.getBoundingClientRect().width ?? 0;
    const railBefore = rail();
    document.querySelector(sel)?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const groups = document
      .getAnimations()
      .filter((a) => /::view-transition-group\(pd-inline/.test(a.effect?.pseudoElement ?? ''));
    const last = (a) => {
      const k = a.effect.getKeyframes();
      return k[k.length - 1];
    };
    const plan = groups.map((a) => {
      const end = last(a);
      return {
        pseudo: a.effect.pseudoElement,
        width: end.width ?? null,
        height: end.height ?? null,
        transform: end.transform ?? null,
      };
    });
    // A moved chart arrives as it was: no entrance replaying in its new home.
    const reentering = document.querySelectorAll('.pd-chart[data-enter]').length;
    return { railBefore, railAtCapture: rail(), plan, reentering };
  }, selector);

/** Where a group's planned end box is, as x/y/w/h. */
function planBox(p) {
  const m = /matrix\(([^)]+)\)/.exec(p?.transform ?? '');
  const parts = m?.[1]?.split(',').map(Number) ?? [];
  return {
    x: parts[4] ?? null,
    y: parts[5] ?? null,
    w: Number.parseFloat(p?.width ?? 'NaN'),
    h: Number.parseFloat(p?.height ?? 'NaN'),
  };
}

try {
  await page.waitForFunction(
    () => typeof window.__pi_store === 'function' && typeof window.__present_store === 'function',
    { timeout: 15_000 },
  );
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'chart my units', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          blocks: [
            {
              type: 'toolCall',
              id: 'c1',
              name: 'chart',
              arguments: { type: 'bar', title: 'Units' },
            },
          ],
        },
        {
          kind: 'toolResult',
          id: 'tr-a1-c1',
          toolCallId: 'c1',
          assistantId: 'a1',
          toolName: 'chart',
          text: 'Drew a bar chart "Units" (4 points, look clean): /tmp/units.svg (the spec beside it: units.chart.json). Shown.',
          isError: false,
          timestamp: 3,
        },
        {
          kind: 'assistant',
          id: 'a2',
          timestamp: 4,
          blocks: [{ type: 'text', text: 'Here are the units by quarter.' }],
        },
      ],
    });
    const chat = window.__pi_store().getState().session?.sessionFile ?? '';
    window
      .__present_store()
      .getState()
      .add({
        path: '/tmp/units.svg',
        chat,
        afterMessageId: 'a1',
        callId: 'c1',
        chart: {
          type: 'bar',
          title: 'Units',
          labels: ['Q1', 'Q2', 'Q3', 'Q4'],
          values: [12, 19, 15, 24],
        },
      });
  });
  await page.waitForSelector('[data-testid="presented-chart"]', { timeout: 10_000 });
  await sleep(1200);

  if (process.env.SNAPS === '1') {
    // Real screenshots (CDP captureScreenshot) at fixed times after each click:
    // a screencast drops and delays frames mid-transition, these do not.
    const at = (process.env.SNAP_AT ?? '60,120,180,240,300,420').split(',').map(Number);
    for (const [name, sel] of [
      ['to-canvas', '[data-testid="inline-chart-move"]'],
      ['to-chat', '.pd-canvas-show-inline'],
    ]) {
      const t0 = Date.now();
      await page.evaluate((s) => document.querySelector(s)?.click(), sel);
      for (const ms of at) {
        await sleep(Math.max(0, ms - (Date.now() - t0)));
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
        writeFileSync(
          path.join(shotDir, `${name}-${String(Date.now() - t0).padStart(4, '0')}ms.jpg`),
          Buffer.from(data, 'base64'),
        );
      }
      await sleep(800);
    }
  } else {
    // ── into the canvas ───────────────────────────────────────────────────────
    const out = await film('1-to-canvas', () =>
      clickAndReadPlan('[data-testid="inline-chart-move"]'),
    );
    const panel = await page.evaluate(() => {
      const el =
        document.querySelector('[id="pd-canvas-tabpanel"]') ??
        document.querySelector('.pd-canvas-tabpanel');
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    });
    const p1 = planBox(out.plan.plan[0]);
    console.log(
      'to canvas: frames',
      out.frames,
      'rail',
      out.plan.railBefore,
      '→',
      out.plan.railAtCapture,
    );
    console.log('  planned end', JSON.stringify(p1), ' settled', JSON.stringify(panel));
    check(out.plan.plan.length > 0, 'the move runs as a view transition');
    check(
      out.plan.reentering === 0,
      `into the canvas the chart does not rebuild (${out.plan.reentering})`,
    );
    if (panel !== null && p1.x !== null) {
      const dx = Math.abs(p1.x - panel.x);
      const dw = Math.abs(p1.w - panel.w);
      console.log(`  end jump: dx ${dx.toFixed(1)} dw ${dw.toFixed(1)}`);
      check(
        dx <= 2 && dw <= 2,
        `the morph lands where the panel settles (dx ${dx.toFixed(1)}, dw ${dw.toFixed(1)})`,
      );
    }

    // ── back into the chat ────────────────────────────────────────────────────
    await sleep(600);
    const back = await film('2-to-chat', () => clickAndReadPlan('.pd-canvas-show-inline'));
    const card = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="presented-chart"]')?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    });
    const p2 = planBox(back.plan.plan[0]);
    check(
      back.plan.reentering === 0,
      `back in the chat the card does not rebuild (${back.plan.reentering})`,
    );
    console.log(
      'to chat: frames',
      back.frames,
      'rail',
      back.plan.railBefore,
      '→',
      back.plan.railAtCapture,
    );
    console.log('  planned end', JSON.stringify(p2), ' settled', JSON.stringify(card));
    if (card !== null && p2.x !== null) {
      const dx = Math.abs(p2.x - card.x);
      const dy = Math.abs(p2.y - card.y);
      console.log(`  end jump: dx ${dx.toFixed(1)} dy ${dy.toFixed(1)}`);
      check(
        dx <= 2 && dy <= 2,
        `the morph lands where the card settles (dx ${dx.toFixed(1)}, dy ${dy.toFixed(1)})`,
      );
    }
  }
} finally {
  await finish();
}
