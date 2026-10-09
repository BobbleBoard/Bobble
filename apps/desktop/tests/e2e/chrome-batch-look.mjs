/**
 * LOOK at the user's 2026-09-17 batch: the empty screen (one line, the block high,
 * ~45% of the window under the composer), the 16px input, a prose code block
 * and an inline svg card wearing the reference's head (type left; rendered ⇄
 * raw, copy, canvas right; a drawn border), and the Connectors and Scheduled
 * cards (drawn borders, a subtler wash, the add control tall on the right).
 *
 *   SHOT_DIR=/tmp/chrome-batch node apps/desktop/tests/e2e/chrome-batch-look.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/chrome-batch';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish } = await launchApp('chrome-batch', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
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
const shot = (label) => page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
const clip = async (label, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box) {
    await page.screenshot({
      path: `${SHOT_DIR}/${label}.png`,
      clip: {
        x: Math.max(0, box.x - 16),
        y: Math.max(0, box.y - 16),
        width: box.width + 32,
        height: box.height + 32,
      },
    });
  } else await shot(label);
};
const measure = () =>
  page.evaluate(() => {
    const px = (el, prop) => (el ? Number.parseFloat(getComputedStyle(el)[prop]) : null);
    const input = document.querySelector('.pd-composer-input');
    const composer = document.querySelector('.pd-composer');
    const lead = document.querySelector('[data-testid="home-lead"]');
    const h = window.innerHeight;
    const cb = composer?.getBoundingClientRect();
    return {
      inputPx: px(input, 'fontSize'),
      leadPx: px(lead, 'fontSize'),
      leadText: lead?.querySelector('.pd-home-lead-name')?.textContent ?? null,
      leadHasMark: lead?.querySelector('svg') !== null,
      privacy: document.querySelector('[data-testid="privacy-line"]') !== null,
      belowComposerFrac: cb ? Math.round(((h - cb.bottom) / h) * 100) / 100 : null,
    };
  });

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64"><rect x="1" y="1" width="218" height="62" rx="10" fill="#3d6b64"/><text x="110" y="39" font-size="16" text-anchor="middle" fill="#fff" font-family="-apple-system">drop zone</text></svg>';
const REPLY = [
  'The badge for the drop zone:',
  '',
  '```svg',
  SVG,
  '```',
  '',
  'And the function that greets:',
  '',
  '```ts',
  'function greet(name: string) {',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a line of TypeScript source, shown as text
  '  return `Hello, ${name}!`;',
  '}',
  '```',
  '',
  'Originals stay where they are — nothing touches them.',
].join('\n');

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);

  // 1. The empty screen, light and dark.
  await setTheme('light');
  await sleep(400);
  const m = await measure();
  await shot('1-home-light');
  check(m.inputPx === 16, `the input is 16px (${m.inputPx})`);
  check(
    m.leadHasMark && m.leadText === 'Bobble' && (m.leadPx ?? 0) >= 40 && !m.privacy,
    `one lead line, the mark and the name, larger: ${JSON.stringify(m)}`,
  );
  check(
    m.belowComposerFrac !== null && m.belowComposerFrac >= 0.4 && m.belowComposerFrac <= 0.5,
    `~45% of the window under the composer (${m.belowComposerFrac})`,
  );
  await setTheme('dark');
  await sleep(400);
  await shot('2-home-dark');

  // 2. A reply with an svg fence and a code fence.
  await set({
    session: { cwd: '/w' },
    messages: [
      { kind: 'user', id: 'u1', text: 'make a drop zone badge', timestamp: 1 },
      {
        kind: 'assistant',
        id: 'a1',
        blocks: [{ type: 'text', text: REPLY }],
        timestamp: 2,
        isStreaming: false,
      },
    ],
  });
  await sleep(1200);
  const cards = () =>
    page.evaluate(() => {
      const w = document.querySelector('[data-testid="inline-widget"]');
      const cb = document.querySelector('.pd-code-block');
      const col =
        document.querySelector('.pd-msg--assistant') ?? document.querySelector('.pd-prose');
      const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
      const border = (el) => (el ? getComputedStyle(el).borderTopColor : null);
      return {
        widget: w
          ? {
              kind: w.querySelector('.pd-inline-widget-kind')?.textContent,
              toggle: w.querySelectorAll('.pd-inline-widget-toggle-btn').length,
              copy: w.querySelector('[aria-label="Copy"]') !== null,
              expand: w.querySelector('[aria-label="Open in canvas"]') !== null,
              width: width(w),
              border: border(w),
              view: w.getAttribute('data-view'),
            }
          : null,
        code: cb
          ? {
              lang: cb.querySelector('.pd-code-block-lang')?.textContent,
              copyVisible: cb.querySelector('.pd-code-block-copy')
                ? getComputedStyle(cb.querySelector('.pd-code-block-copy')).opacity
                : null,
              width: width(cb),
              border: border(cb),
              strip: cb.querySelector('.pd-code-block-lang')
                ? getComputedStyle(cb.querySelector('.pd-code-block-lang').parentElement)
                    .backgroundColor
                : null,
            }
          : null,
        column: width(col),
      };
    });
  let c = await cards();
  await shot('3-cards-dark');
  check(
    c.widget !== null &&
      c.widget.kind === 'svg' &&
      c.widget.toggle === 2 &&
      c.widget.copy &&
      c.widget.expand,
    `the svg card has the head: ${JSON.stringify(c.widget)}`,
  );
  check(
    c.widget !== null && c.column !== null && c.widget.width >= c.column - 8,
    `the svg card is full width (${c.widget?.width} of ${c.column})`,
  );
  check(
    c.code !== null && c.code.lang === 'ts' && c.code.copyVisible === '1',
    `the code block: type at the left, copy visible at rest: ${JSON.stringify(c.code)}`,
  );
  // A chart card in the same reply: the same drawn border as the other two.
  // The user (2026-09-18): "same card borders for dataviz please".
  await page.evaluate(() => {
    window
      .__present_store()
      .getState()
      .add({
        path: '/w/units.svg',
        chat: '',
        afterMessageId: 'a1',
        chart: {
          type: 'bar',
          title: 'Units sold',
          labels: ['2021', '2022', '2023', '2024'],
          values: ['Units: 12, 19, 23, 31'],
          look: 'clean',
        },
      });
  });
  await sleep(900);
  const chart = await page.evaluate(() => {
    const el = document.querySelector('.pd-inline-chart');
    const code = document.querySelector('.pd-code-block');
    const cs = el ? getComputedStyle(el) : null;
    const r = el?.getBoundingClientRect();
    const c = code?.getBoundingClientRect();
    const chain = (node) => {
      const out = [];
      let n = node?.parentElement ?? null;
      for (let i = 0; n && i < 6; i += 1) {
        const b = n.getBoundingClientRect();
        const st = getComputedStyle(n);
        out.push(
          `${n.className.toString().slice(0, 40)}|${Math.round(b.left)}-${Math.round(b.right)}|p${st.paddingLeft}/${st.paddingRight}|mw${st.maxWidth}`,
        );
        n = n.parentElement;
      }
      return out;
    };
    return el && code && r && c
      ? {
          chartChain: chain(el),
          codeChain: chain(code),
          border: cs.borderTopColor,
          radius: cs.borderTopLeftRadius,
          codeBorder: getComputedStyle(code).borderTopColor,
          codeRadius: getComputedStyle(code).borderTopLeftRadius,
          left: Math.round(r.left),
          right: Math.round(r.right),
          codeLeft: Math.round(c.left),
          codeRight: Math.round(c.right),
        }
      : null;
  });
  await shot('3b-cards-with-chart-dark');
  check(
    chart !== null && chart.border === chart.codeBorder && chart.radius === chart.codeRadius,
    `the chart card wears the code block's border and corner: ${JSON.stringify(chart)}`,
  );
  check(
    chart !== null &&
      Math.abs(chart.left - chart.codeLeft) <= 2 &&
      Math.abs(chart.right - chart.codeRight) <= 2,
    `…and its edges are the code block's edges: ${JSON.stringify(chart)}`,
  );
  // Raw view of the svg card.
  await page.click('[data-testid="inline-widget"] [aria-label="Raw"]');
  await sleep(400);
  c = await cards();
  await shot('4-cards-raw-dark');
  check(c.widget?.view === 'raw', `the svg card shows its markup on Raw (${c.widget?.view})`);
  await page.click('[data-testid="inline-widget"] [aria-label="Rendered"]');
  await setTheme('light');
  await sleep(500);
  c = await cards();
  await shot('5-cards-light');
  console.log('cards light', JSON.stringify(c));

  // 3. Connectors: the list with its add controls.
  await page.click('[data-testid="nav-connectors"]');
  await sleep(1500);
  const readAdd = () =>
    page.evaluate(() => {
      const row = document.querySelector('.pdc-row');
      const add = document.querySelector('.pdc-ctl--add');
      const rb = row?.getBoundingClientRect();
      const ab = add?.getBoundingClientRect();
      const cs = add ? getComputedStyle(add) : null;
      return {
        rows: document.querySelectorAll('.pdc-row').length,
        border: row ? getComputedStyle(row).borderTopColor : null,
        rowH: rb ? Math.round(rb.height) : null,
        addH: ab ? Math.round(ab.height) : null,
        addW: ab ? Math.round(ab.width) : null,
        addBorder: cs ? cs.borderTopWidth : null,
        addBg: cs ? cs.backgroundColor : null,
        addRadius: cs ? cs.borderTopLeftRadius : null,
        addCentred:
          rb && ab ? Math.abs(rb.top + rb.height / 2 - (ab.top + ab.height / 2)) < 2 : null,
      };
    });
  const conn = await readAdd();
  await shot('6-connectors-light');
  check(conn.rows > 0, `connector rows on screen (${conn.rows})`);
  /* The user (2026-09-18): "+ buttons … must be square and not bordered, just a
     rounded-corner box on hover". */
  check(
    conn.addH !== null &&
      conn.addW === conn.addH &&
      conn.addBorder === '0px' &&
      /rgba\(0, 0, 0, 0\)|transparent/.test(conn.addBg ?? '') &&
      conn.addCentred === true,
    `the add control is a square, unbordered and unfilled at rest, centred: ${JSON.stringify(conn)}`,
  );
  // The card's own hover must not light the + (the user, 2026-09-18: "separate
  // hover than the whole card").
  await page.hover('.pdc-row .pdc-row-name');
  await sleep(400);
  const connCardHover = await readAdd();
  check(
    connCardHover.addBg === conn.addBg,
    `the card's hover leaves the add alone (${connCardHover.addBg})`,
  );
  await page.hover('.pdc-ctl--add');
  await sleep(400);
  const connHover = await readAdd();
  await clip('6b-connectors-add-hover', '.pdc-row');
  check(
    connHover.addBg !== conn.addBg && Number.parseFloat(connHover.addRadius ?? '0') >= 8,
    `…and a rounded box appears under the pointer: ${JSON.stringify({ rest: conn.addBg, hover: connHover.addBg, radius: connHover.addRadius })}`,
  );

  // 4. Scheduled: the templates with their + (on the Templates page now).
  await page.click('[data-testid="nav-scheduled"]');
  await sleep(1500);
  await page.click('[data-testid="sd-view-templates"]');
  await sleep(600);
  const readPlus = () =>
    page.evaluate(() => {
      const row = document.querySelector('.sd-row');
      const plus = document.querySelector('.sd-row-plus');
      const rb = row?.getBoundingClientRect();
      const pb = plus?.getBoundingClientRect();
      const cs = plus ? getComputedStyle(plus) : null;
      return {
        rows: document.querySelectorAll('.sd-row').length,
        border: row ? getComputedStyle(row).borderTopColor : null,
        rowH: rb ? Math.round(rb.height) : null,
        plusH: pb ? Math.round(pb.height) : null,
        plusW: pb ? Math.round(pb.width) : null,
        plusBorder: cs ? cs.borderTopWidth : null,
        plusBg: cs ? cs.backgroundColor : null,
        plusRadius: cs ? cs.borderTopLeftRadius : null,
        plusCentred:
          rb && pb ? Math.abs(rb.top + rb.height / 2 - (pb.top + pb.height / 2)) < 2 : null,
      };
    });
  await page.mouse.move(2, 2);
  await sleep(300);
  const sched = await readPlus();
  await shot('7-scheduled-light');
  check(sched.rows > 0, `scheduled rows on screen (${sched.rows})`);
  check(
    sched.plusH !== null &&
      sched.plusW === sched.plusH &&
      sched.plusBorder === '0px' &&
      /rgba\(0, 0, 0, 0\)|transparent/.test(sched.plusBg ?? '') &&
      sched.plusCentred === true,
    `the + is a square, unbordered and unfilled at rest, centred: ${JSON.stringify(sched)}`,
  );
  /* Hovering the CARD must not light the +; hovering the + itself does
     (The user, 2026-09-18: "separate hover than the whole card"). */
  await page.hover('.sd-row .sd-row-name');
  await sleep(400);
  const cardHover = await readPlus();
  check(
    cardHover.plusBg === sched.plusBg,
    `the card's hover leaves the + alone (${cardHover.plusBg})`,
  );
  await page.hover('.sd-row-plus');
  await sleep(400);
  const schedHover = await readPlus();
  await clip('7b-scheduled-plus-hover', '.sd-row');
  check(
    schedHover.plusBg !== sched.plusBg && Number.parseFloat(schedHover.plusRadius ?? '0') >= 8,
    `…and a rounded box appears under the pointer on the + itself: ${JSON.stringify({ rest: sched.plusBg, hover: schedHover.plusBg, radius: schedHover.plusRadius })}`,
  );
  await setTheme('dark');
  await sleep(400);
  await shot('8-scheduled-dark');
  await page.click('[data-testid="nav-connectors"]');
  await sleep(1200);
  await shot('9-connectors-dark');
  console.log(JSON.stringify({ home: m, conn, sched }, null, 1));
} finally {
  await finish();
}
