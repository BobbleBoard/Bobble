/**
 * cursor-parity-look — the user's 2026-09-21 list, photographed.
 *
 *   1. The built-in browser's cursor IS the computer-use cursor (one shared
 *      drawing, @pi-desktop/shared agent-cursor): the page is driven over the
 *      real bridge socket and its screenshot — cursor, typing pill — is taken.
 *      On the way: typing into a field that is NOT a native input (a maths
 *      editor's expression line) lands as keystrokes, and a page that refuses
 *      to unload cannot hold the tab.
 *   2. The Activity tab follows CLI browsing: `open <url>` and `browser click`
 *      through bash make it a browser and keep it one.
 *   7. The canvas monitor's phantom wears the same cursor, its pill parked by
 *      the overlay's rule (11×15 from the tip).
 *   3b. The svg tool's drawing streams into a live inline card — the REAL
 *      OmniSVG over the gen bridge (realCache), photographed mid-draw.
 *
 * Artifacts → $TMPDIR/pd-shots/cursor-parity (override with SHOT_DIR).
 */
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { driveMacThroughActivity, waitForMonitorTab } from './_macmon-open.mjs';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockPath = path.join(tmpdir(), `pi-bua-look-${process.pid}.sock`);
const genSock = path.join(tmpdir(), `pi-gen-look-${process.pid}.sock`);
const token = 'look-token';
const REAL_SVG = process.env.REAL_SVG !== '0';

const { app, page, shot, check, finish, shotDir } = await launchApp('cursor-parity', {
  env: {
    PI_MAC_MONITOR_MOCK: '1',
    PI_BROWSER_AGENT_SOCK: sockPath,
    PI_BROWSER_AGENT_TOKEN: token,
    PI_GEN_SOCK: genSock,
    PI_GEN_TOKEN: token,
  },
  args: ['--', '--piE2E=1'],
  realCache: REAL_SVG,
  timeout: 60_000,
});

function connect(socketPath, retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        if (left <= 0) return reject(err);
        setTimeout(() => attempt(left - 1), 150);
      });
    };
    attempt(retries);
  });
}
function makeRpc(socket, timeoutMs = 25_000) {
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'bridge error'));
    }
  });
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      socket.write(`${JSON.stringify({ id, token, method, params })}\n`);
    });
}

/* A white page with: a native input; a maths-editor-shaped field — a
   role=textbox span over a hidden textarea, the way Desmos's expression line
   is built (mathquill), whose keystrokes are echoed into a span; and a
   beforeunload that would keep the page. */
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><title>PARITY</title><body style="margin:0;background:#fff;font:16px -apple-system,sans-serif;padding:40px">' +
      '<h1 style="font-size:22px">Cursor parity</h1>' +
      '<p>A page for the phantom to point at.</p>' +
      '<input id="q" type="text" placeholder="Native input" style="font-size:16px;padding:6px;width:220px"/>' +
      '<div style="margin-top:24px">Expression 1: ' +
      '<span id="mq" role="textbox" aria-label="Expression 1" tabindex="0" style="display:inline-block;min-width:200px;border:1px solid #888;padding:6px;font-family:ui-monospace">' +
      '<span style="position:absolute;clip:rect(1px,1px,1px,1px)"><textarea id="mqta" aria-label="Math Input" style="width:1px;height:1px"></textarea></span>' +
      '<span id="mqout"></span></span></div>' +
      '<button id="go" style="margin-top:24px;font-size:16px;padding:6px 14px">Run</button>' +
      '<script>' +
      "var ta=document.getElementById('mqta'),out=document.getElementById('mqout'),mq=document.getElementById('mq');" +
      "mq.addEventListener('mousedown',function(e){e.preventDefault();ta.focus();});" +
      "mq.addEventListener('focus',function(){ta.focus();});" +
      "ta.addEventListener('input',function(){out.textContent=ta.value;});" +
      "window.addEventListener('beforeunload',function(e){e.preventDefault();e.returnValue='stay';return 'stay';});" +
      '</script></body>',
  );
const NEXT = `data:text/html,${encodeURIComponent('<title>NEXT</title><h1>Second page</h1>')}`;

const pageShot = async (rpc, label) => {
  const res = await rpc('screenshot', {});
  const b64 = typeof res === 'string' ? res : (res?.base64 ?? res?.dataUrl?.split(',')[1] ?? '');
  const file = path.join(shotDir, `${label}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  check(b64.length > 2000, `page screenshot "${label}" is not blank`);
  return file;
};

try {
  /* Leaving a page with a beforeunload handler: Electron (will-prevent-unload)
     dismisses the would-be dialog and lets the unload through; Playwright's own
     auto-dismiss then races it and throws from its internals. A listener that
     does nothing keeps Playwright's hands off. */
  app.context().on('dialog', () => {});
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20_000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));

  // ── 1. the page cursor ────────────────────────────────────────────────────
  const socket = await connect(sockPath);
  const rpc = makeRpc(socket);
  const tab = await rpc('ensureTab');
  check(typeof tab?.tabId === 'string', 'ensureTab returned a tab');
  const nav = await rpc('navigate', { url: PAGE });
  check(nav?.title === 'PARITY' && nav.navigated === true, `navigate landed (${nav?.title})`);

  // The Activity tab is the browser now — the bridge adopted it.
  const tabsNow = await page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => ({ key: t.key, kind: t.kind, title: t.title })),
  );
  check(
    tabsNow.some((t) => t.key === 'pi:activity' && t.kind === 'browser'),
    `browsing goes to the Activity tab, as a browser: ${JSON.stringify(tabsNow)}`,
  );
  check(!tabsNow.some((t) => t.title === 'Pi Browser'), 'no separate "Pi Browser" tab');

  await rpc('click', { x: 160, y: 96 });
  await sleep(450);
  const cursorSvg = await rpc('evaluate', {
    script:
      "(function(){var c=document.getElementById('pi-agent-cursor');if(!c)return null;var s=c.querySelector('svg');var ps=s?s.querySelectorAll('path'):[];return {left:c.style.left,top:c.style.top,w:c.style.width,h:c.style.height,svg:s?s.outerHTML:null,fill:ps[2]?ps[2].getAttribute('fill'):null,ring:!!document.getElementById('pi-agent-ring')};})()",
  });
  check(cursorSvg !== null, 'the cursor overlay is in the page');
  check(
    cursorSvg?.h === '25.3px',
    `the page cursor is drawn 25.3px tall like the overlay (${cursorSvg?.h})`,
  );
  check(cursorSvg?.fill === '#0a0b0f', `black body under the keyline (${cursorSvg?.fill})`);
  check(/#2769ef/i.test(cursorSvg?.svg ?? ''), 'the blue edge glow is the pill blue');
  check(
    !/78BFE5|95F9E5|linearGradient/i.test(cursorSvg?.svg ?? ''),
    'not the old frosted / blue dart',
  );
  check(
    cursorSvg?.left === '160px' && cursorSvg?.top === '96px',
    `the tip sits on the click point (${cursorSvg?.left}, ${cursorSvg?.top})`,
  );
  check(cursorSvg?.ring === false, 'no click ring — the overlay has none');
  await pageShot(rpc, '1-page-cursor-after-click');

  // Typing into the maths field: index the page, find the role=textbox.
  const { perceptionScript } = await import(
    new URL('../../../../packages/browser-use/src/perception.ts', import.meta.url).href
  );
  const snap = await rpc('evaluate', { script: perceptionScript(60) });
  const mq = snap.elements.find((e) => /Expression 1/.test(e.name) && e.role === 'textbox');
  check(
    mq !== undefined && mq.editable === true,
    `the expression line is listed as editable: ${JSON.stringify(mq)}`,
  );
  const typed = await rpc('type', { index: mq.index, text: 'x^2+y^2=25', submit: false });
  check(typed?.found === true, 'type accepted the expression line');
  await sleep(300);
  const echoed = await rpc('evaluate', {
    script: "(function(){return document.getElementById('mqout').textContent;})()",
  });
  check(
    echoed === 'x^2+y^2=25',
    `keystrokes reached the maths field's hidden textarea (got "${echoed}")`,
  );
  // The typing pill, photographed while it is up: a native field types over
  // six animated steps (270 ms), long enough to catch.
  const native = snap.elements.find((e) => /Native input/.test(e.name));
  check(native !== undefined, 'the native input is listed');
  const long = rpc('type', {
    index: native.index,
    text: 'a sentence long enough to be caught mid-type',
    submit: false,
  });
  // The glide to the field takes the overlay's 300 ms first; the pill is up
  // for the 270 ms of typing after that.
  await sleep(420);
  await pageShot(rpc, '2-page-typing-pill');
  await long;
  const pillNow = await rpc('evaluate', {
    script:
      "(function(){var t=document.getElementById('pi-agent-typing');return t?{text:t.textContent,bg:t.style.background,display:t.style.display}:null;})()",
  });
  check(
    pillNow?.text === 'Typing',
    `the pill says the action, not its contents (${pillNow?.text})`,
  );
  check(/39, 105, 239/.test(pillNow?.bg ?? ''), `the pill is the overlay's blue (${pillNow?.bg})`);

  // A page that refuses to unload cannot hold the tab.
  const away = await rpc('navigate', { url: NEXT });
  check(
    away?.title === 'NEXT' && away.navigated === true,
    `left a beforeunload page (${away?.title}, navigated=${away?.navigated})`,
  );

  // ── 2. the Activity tab follows CLI browsing ──────────────────────────────
  await page.evaluate(() => {
    const now = Date.now();
    const bash = (id, command) => ({
      kind: 'assistant',
      id: `a-${id}`,
      blocks: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
      timestamp: now,
      isStreaming: false,
    });
    const result = (id, text) => ({
      kind: 'toolResult',
      id: `tr-${id}`,
      toolCallId: id,
      toolName: 'bash',
      text,
      isError: false,
      timestamp: now,
    });
    window.__pi_store().setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'show me desmos', timestamp: now },
        bash('c1', 'ls -la'),
        result('c1', 'a.ts'),
        bash('c2', 'open https://www.desmos.com/calculator'),
        result(
          'c2',
          'open <url> hands the page to another browser… Opening it in the app own browser instead (browser navigate).',
        ),
        bash('c3', 'browser snapshot'),
        result('c3', 'Page: "Desmos" — https://www.desmos.com/calculator'),
        bash('c4', 'browser click 4'),
        result('c4', 'Clicked element [4].'),
      ],
    });
  });
  await sleep(400);
  const activity = await page.evaluate(() => {
    const t = window
      .__pi_canvas()
      .getState()
      .tabs.find((x) => x.key === 'pi:activity');
    return t ? { kind: t.kind, subtitle: t.subtitle } : null;
  });
  check(
    activity?.kind === 'browser',
    `after open/browser lines the Activity tab is a browser, not a terminal (${JSON.stringify(activity)})`,
  );
  check(
    activity?.subtitle === 'Clicking',
    `…subtitled by the newest browser act (${activity?.subtitle})`,
  );
  await shot('3-activity-tab-browser');

  // ── 7. the monitor's phantom ─────────────────────────────────────────────
  await driveMacThroughActivity(page);
  check(await waitForMonitorTab(page), 'the Activity tab became the monitor');
  await sleep(1800);
  // Thinking, so the pill reads a word — and parked by the new rule.
  await page.evaluate(() => {
    const s = window.__pi_store?.();
    return s;
  });
  await sleep(600);
  const canvasBox = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="macmon-stage"], .pd-macmon-stage, canvas.pd-macmon-canvas, .pd-computer-use canvas',
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await shot('4-monitor-phantom');
  check(canvasBox !== null, 'the monitor stage is on screen');

  // ── 3b. the drawing, live ────────────────────────────────────────────────
  if (REAL_SVG) {
    await page.evaluate(() => {
      const now = Date.now();
      window.__pi_store().setState({
        messages: [
          { kind: 'user', id: 'u2', text: 'draw me a red heart icon', timestamp: now },
          {
            kind: 'assistant',
            id: 'a-svg',
            blocks: [
              {
                type: 'toolCall',
                id: 'c-svg',
                name: 'bash',
                arguments: { command: 'svg --prompt="a red heart icon, flat"' },
              },
            ],
            timestamp: now,
            isStreaming: true,
          },
        ],
        runningToolCalls: ['c-svg'],
        agent: { ...window.__pi_store().getState().agent, isStreaming: true },
      });
    });
    const gsock = await connect(genSock);
    const grpc = makeRpc(gsock, 240_000);
    const job = grpc('generateSvg', { prompt: 'a red heart icon, flat', candidates: 3 });
    // Photograph the card as it draws.
    let drewFrames = 0;
    let firstNote = '';
    const polls = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 200_000) {
      // A small icon draws in about a second per sample; poll fast enough to
      // see it, and count the DRAWING's paths — the card's head has icons too.
      await sleep(200);
      const state = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="live-svg"]');
        const note = document.querySelector('[data-testid="live-svg-note"]')?.textContent ?? '';
        const paths = card ? card.querySelectorAll('.pd-inline-widget-box svg path').length : -1;
        return { has: !!card, status: card?.getAttribute('data-status'), note, paths };
      });
      polls.push(
        `${Math.round((Date.now() - t0) / 100) / 10}s:${state.status ?? '-'}/${state.paths}`,
      );
      if (state.has && state.status === 'drawing' && state.paths > 0) {
        drewFrames += 1;
        if (firstNote === '') firstNote = state.note;
        if (drewFrames === 1 || drewFrames === 3) await shot(`5-live-drawing-${drewFrames}`);
      }
      if (state.status === 'done' || !state.has) {
        let settled = false;
        try {
          await Promise.race([
            job,
            sleep(100).then(() => {
              throw new Error('pending');
            }),
          ]);
          settled = true;
        } catch {
          settled = false;
        }
        if (settled || !state.has) break;
      }
    }
    const result = await job.catch((e) => ({ error: String(e) }));
    console.log(`live polls: ${polls.join(' ')}`);
    check(!('error' in result), `OmniSVG ran (${result?.error ?? 'ok'})`);
    check(drewFrames >= 2, `the card drew live — ${drewFrames} frames with shapes seen`);
    check(/shape/.test(firstNote), `the note counts shapes (${firstNote})`);
    // The finished drawing is presented in the thread as its card.
    await page.evaluate(() => {
      window.__pi_store().setState({ runningToolCalls: [] });
    });
    await sleep(800);
    const presented = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="presented-svg"]');
      return card ? card.querySelectorAll('svg path').length : -1;
    });
    check(presented > 0, `the finished drawing is a presented card with ${presented} paths`);
    await shot('6-drawing-done');
    gsock.end();
  }

  socket.end();
} finally {
  await finish();
}
