/**
 * LOOK at the diagram card — every kind the `diagram` tool offers, in the chat,
 * light and dark, in each design kit.
 *
 * the user (2026-09-25): "custom mermaid arrows and box styling". The drawings are
 * made the way the app makes them — the repo's own diagram-page.ts (the
 * hidden window's page script and runDiagram) over the bundled Mermaid, in a
 * headless Chromium — and handed to the real app's thread as presented cards,
 * where each is photographed in both themes. No model: the card is the thing
 * under test, not the turn.
 *
 *   SHOT_DIR=/tmp/diagram-look node apps/desktop/tests/e2e/diagram-look.mjs
 *   KITS=paper-blue,fog SAMPLES=flow,sequence …   a subset
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTs, launchChromium } from '../../../../tools/visual-eval/lib/env.mjs';
import { APP_ROOT, launchApp } from './harness.mjs';
import { cropPng } from './png.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/diagram-look';
mkdirSync(SHOT_DIR, { recursive: true });
const KITS = (process.env.KITS ?? 'paper-blue').split(',');

/** One of each kind the task names, each with the parts a look must hold up in. */
export const DIAGRAM_SAMPLES = {
  flow: {
    title: 'Order fulfilment',
    subtitle: 'Checkout to delivery',
    source: `flowchart TD
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  E -. retry .-> B
  subgraph Warehouse
    C --> D{Quality ok?}
    D -- no, repack --> C
  end
  D -- yes --> F[Ship] --> G([Delivered])`,
  },
  flowLR: {
    title: 'Deploy pipeline',
    source: `flowchart LR
  A[Commit] --> B[Build] --> C{Tests pass?}
  C -- yes --> D[Stage] --> E([Release])
  C -- no --> F[Fix] --> A`,
  },
  sequence: {
    title: 'Checkout',
    source: `sequenceDiagram
  participant C as Customer
  participant S as Store
  participant P as Payments
  C->>S: Place order
  S->>P: Charge card
  alt approved
    P-->>S: Approved
    S-->>C: Confirmation email
  else declined
    P-->>S: Declined
    S-->>C: Payment failed
  end
  Note over S,P: Retries twice`,
  },
  state: {
    title: 'Article lifecycle',
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review: submit
  Review --> Draft: changes requested
  Review --> Approved: approve
  Approved --> Published: publish
  Published --> [*]`,
  },
  class: {
    title: 'Orders model',
    source: `classDiagram
  class Order {
    +String id
    +Date placed
    +total() Money
  }
  class LineItem {
    +int qty
    +Money price
  }
  class Customer {
    +String email
  }
  Customer "1" --> "*" Order : places
  Order *-- LineItem : contains
  Order <|-- RushOrder`,
  },
  er: {
    title: 'Shop data',
    source: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  PRODUCT ||--o{ LINE_ITEM : "is in"
  CUSTOMER {
    string email
    string name
  }
  ORDER {
    int id
    date placed
  }`,
  },
};
const SAMPLES = (process.env.SAMPLES ?? Object.keys(DIAGRAM_SAMPLES).join(',')).split(',');

/** The card payloads, drawn by the repo's own renderer (diagram-page.ts runDiagram). */
async function drawAll() {
  const dp = await importTs('apps/desktop/electron/gen/diagram-page.ts');
  const dk = await importTs('packages/design-kit/src/index.ts');
  const browser = await launchChromium();
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  await page.setContent(dp.PAGE_HTML);
  await page.addScriptTag({
    content: readFileSync(path.join(APP_ROOT, 'resources/mermaid/mermaid.min.js'), 'utf8'),
  });
  await page.addScriptTag({ content: dp.PAGE_SCRIPT });
  const api = {
    parse: (s) => page.evaluate((x) => window.__pdParse(x), s),
    render: (r) => page.evaluate((x) => window.__pdRender(x), r),
  };
  const out = [];
  try {
    for (const kitId of KITS) {
      const kit = dk.kitOrDefault(kitId);
      for (const name of SAMPLES) {
        const s = DIAGRAM_SAMPLES[name];
        const reply = await dp.runDiagram(api, {
          source: s.source,
          title: s.title,
          ...(s.subtitle ? { subtitle: s.subtitle } : {}),
          themes: {
            light: dk.diagramTheme(kit, 'light', 'mac'),
            dark: dk.diagramTheme(kit, 'dark', 'mac'),
          },
        });
        if (!reply.ok) throw new Error(`${kitId}/${name}: ${reply.error} (line ${reply.line})`);
        out.push({
          kit: kitId,
          name,
          notes: reply.notes,
          payload: {
            title: s.title,
            ...(s.subtitle ? { subtitle: s.subtitle } : {}),
            kind: reply.kind,
            kit: kit.id,
            source: reply.source,
            light: { ...reply.light, paper: kit.light.paper },
            dark: { ...reply.dark, paper: kit.dark.paper },
          },
        });
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

const drawn = await drawAll();
const { app, page, check, finish } = await launchApp('diagram-look', {
  waitFor: '[data-testid="composer-input"]',
});
// A top-down flow's card is taller than the default window's thread: grow the
// (hidden) window so every card is photographed whole.
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) =>
    /index\.html|localhost/.test(w.webContents.getURL()),
  );
  win?.setContentSize(1440, 1700);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (mode) =>
  page.evaluate((m) => {
    document.documentElement.setAttribute('data-mode', m);
    document.documentElement.style.colorScheme = m;
  }, mode);
/** A card cut out of a full-window shot (an element shot re-lays an Electron page out: a flash). */
async function cardShot(file) {
  const card = await page.$('[data-testid="presented-diagram"]');
  if (card === null) return check(false, `no card for ${file}`);
  await card.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await card.boundingBox();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const full = await page.screenshot();
  writeFileSync(
    path.join(SHOT_DIR, file),
    cropPng(full, {
      x: box.x * dpr - 8,
      y: box.y * dpr - 8,
      width: box.width * dpr + 16,
      height: box.height * dpr + 16,
    }),
  );
}

const report = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);
  await page.evaluate(() =>
    window.__pi_store().setState({
      session: { cwd: '/w/diagrams' },
      messages: [
        { kind: 'user', id: 'u1', text: 'draw it', timestamp: Date.now() },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [{ type: 'text', text: 'Here it is.' }],
          timestamp: Date.now(),
          isStreaming: false,
        },
      ],
    }),
  );
  for (const d of drawn) {
    await page.evaluate((p) => {
      const st = window.__present_store();
      st.getState().clear();
      st.getState().add({
        path: '/w/diagrams/look.svg',
        chat: '',
        afterMessageId: 'a1',
        diagram: p,
      });
    }, d.payload);
    for (const mode of ['light', 'dark']) {
      await setMode(mode);
      await sleep(500);
      const facts = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="presented-diagram"]');
        const svg = card?.querySelector('.pd-inline-widget-box svg');
        const box = svg?.getBoundingClientRect();
        // Each line's first and last 3 px: square to its box means level or upright.
        const aslant = [];
        for (const p of svg ? svg.querySelectorAll('g.edgePaths > path') : []) {
          const len = p.getTotalLength();
          if (!(len > 8)) continue;
          for (const [a, b] of [
            [0, 3],
            [len, len - 3],
          ]) {
            const u = p.getPointAtLength(a);
            const v = p.getPointAtLength(b);
            if (Math.abs(u.x - v.x) > 0.3 && Math.abs(u.y - v.y) > 0.3) {
              aslant.push(`${p.getAttribute('data-id')}@${Math.round(u.x)},${Math.round(u.y)}`);
            }
          }
        }
        return {
          width: box ? Math.round(box.width) : 0,
          height: box ? Math.round(box.height) : 0,
          texts: svg ? svg.querySelectorAll('text').length : 0,
          aslant,
        };
      });
      check(facts.texts > 0, `${d.kit}/${d.name} ${mode}: the card drew its words`);
      // the user (2026-09-25): "clean and curved path eg. elbow arrows" — a class
      // or ER line (its UML mark, its crow's foot) meets its box square too.
      if (d.name === 'class' || d.name === 'er') {
        check(
          facts.aslant.length === 0,
          `${d.kit}/${d.name} ${mode}: every line meets its boxes square (aslant: ${facts.aslant.join(' ') || 'none'})`,
        );
      }
      report.push({ kit: d.kit, name: d.name, mode, ...facts, notes: d.notes });
      await cardShot(`${d.kit}-${d.name}-${mode}.png`);
    }
  }
  writeFileSync(path.join(SHOT_DIR, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    JSON.stringify(report.map((r) => `${r.kit}/${r.name}/${r.mode} ${r.width}x${r.height}`)),
  );
} finally {
  await finish();
}
