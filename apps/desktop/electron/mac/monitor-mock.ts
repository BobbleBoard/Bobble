/**
 * A DEV-ONLY frame source for the computer-use monitor, so the whole Lane A
 * pipeline can be built and LOOKED AT before the native `pi-mac --stream`
 * (Lane N) exists.
 *
 * It is not a stub of the surface — it is a stub of the HELPER. It produces
 * real PIMF bytes (encodePimf), hands them to the real parser through the real
 * spawn seam, drives the real overlay controller so the phantom cursor and
 * bubble come from the same state source production uses, and points the real
 * wallpaper cache at a real desktop picture. Everything downstream of the Swift
 * process is exercised exactly as it will be in production.
 *
 * Strictly env-gated (`PI_MAC_MONITOR_MOCK=1`) and never referenced from a
 * production path: with the flag unset `startMacMonitorMock()` returns
 * immediately and nothing here runs.
 *
 * The synthetic "window" is rasterized by hand into RGBA, PNG-encoded, and
 * handed to Electron's own JPEG encoder — no image library, no fixture file. It
 * animates (a caret, a scrolling document, a save SHEET that slides in and out)
 * because a still picture would not prove the surface is streaming.
 */
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createLogger } from '@pi-desktop/shared';
import { BrowserWindow, nativeImage } from 'electron';
import { macMonitor, type StreamChild } from './monitor';
import { macOverlay } from './overlay-controller';
import { encodePimf, type PimfHeader } from './pimf';

const log = createLogger('desktop:mac-monitor-mock');

const MOCK_PID = 909090;
const MOCK_APP = 'TextEdit';
const FPS = 12;
/** The synthetic window's frame in "screen points". */
const WINDOW = { x: 306, y: 168, w: 900, h: 620 };
const DISPLAY = { w: 1512, h: 982 };
/** Retina: the JPEG is 2× the point size, exactly like a real capture. */
const SCALE = 2;

/** Real desktop pictures, most-likely first. */
const WALLPAPER_CANDIDATES = [
  '/System/Library/CoreServices/DefaultDesktop.heic',
  '/System/Library/Desktop Pictures/Sonoma Horizon.heic',
  '/System/Library/Desktop Pictures/Ventura Graphic.heic',
  '/System/Library/Desktop Pictures/Solid Colors/Stone.png',
];

export function macMonitorMockEnabled(): boolean {
  return process.env.PI_MAC_MONITOR_MOCK === '1';
}

/** Does the synthetic app currently have an on-screen window? */
let windowsPresent = true;
/** Hold the first frame back this long, so the "waiting" state can be SEEN. */
let firstFrameDelayMs = 0;
/**
 * Pretend macOS has not granted Screen Recording — the state a fresh Mac is in
 * by default, and the one this mock cannot otherwise reach on a machine where
 * the grant IS present. Flips the synthetic helper to emitting the contract's
 * `screen-recording-denied` status frame, which is what puts the surface onto
 * the Accessibility fallback below.
 */
let captureDenied = false;

/**
 * Dev-only control over the synthetic source, reachable from the E2E debug
 * channel. It exists so the states that are hard to catch in a running stream —
 * "the app has no window", "connecting, no frame yet" — can be driven
 * deliberately and looked at, rather than being the two screens nobody ever
 * sees until a user hits them.
 */
export function macMonitorMockControl(params: {
  windows?: boolean;
  restart?: boolean;
  delayMs?: number;
  deny?: boolean;
}): void {
  if (!macMonitorMockEnabled()) return;
  if (typeof params.windows === 'boolean') windowsPresent = params.windows;
  if (typeof params.deny === 'boolean') captureDenied = params.deny;
  if (typeof params.delayMs === 'number') firstFrameDelayMs = Math.max(0, params.delayMs);
  if (params.restart === true) {
    macOverlay.hide();
    macMonitor.clearSession();
    void (async () => {
      await wait(150);
      await macOverlay.debugShow(WINDOW);
      macMonitor.setSession(MOCK_PID, MOCK_APP);
      await macOverlay.thinking();
    })();
  }
}

/**
 * Arm the mock: replace the capture spawn with the synthetic source, engage the
 * overlay over the synthetic window, and start a choreography of cursor moves,
 * clicks, typing and key presses so every bubble state gets drawn.
 */
export function startMacMonitorMock(): void {
  if (!macMonitorMockEnabled()) return;
  log.info('mac monitor MOCK source armed (PI_MAC_MONITOR_MOCK=1)');

  const wallpaper = WALLPAPER_CANDIDATES.find((p) => existsSync(p)) ?? null;
  if (wallpaper !== null) macMonitor.setWallpaperReader(async () => ({ path: wallpaper }));

  macMonitor.setSpawnFn(() => new MockStreamChild());
  // This mock IS a stubbed helper, so it has to be the helper that gets used:
  // on a machine where the app holds the Screen Recording grant the preferred
  // (Electron) path never spawns a child at all, and the mock would sit unused
  // while the monitor quietly captured the real desktop instead.
  //
  // Unless a probe has explicitly asked for the preferred path (which it can
  // only do under PI_E2E — see window-capture.ts). That is the one case where
  // being bypassed is the point: it is how the Electron path, the real
  // Chromium enumeration and the fallback back to this mock get exercised on a
  // machine that has no capture grant to test them with.
  if (process.env.PI_MAC_FORCE_CAPTURE_GRANT === undefined) macMonitor.disableElectronCapture();
  // The ACCESSIBILITY half of the same synthetic app, so the fallback path is
  // exercised end to end with no TCC and no real app: same window, same frame,
  // same save sheet on the same 14-second cycle, described the way the helper's
  // `snapshot` describes a real one.
  //
  // Scoped to the SYNTHETIC PID and delegating everything else to the real
  // reader: a mock that answered for every pid would quietly serve made-up
  // furniture for a real app someone was actually driving — which is how a
  // probe ends up screenshotting the mock and calling it a live TextEdit.
  const realAx = macMonitor.axReader();
  macMonitor.setAxReader(async (pid, cap) =>
    pid === MOCK_PID ? mockAxSnapshot() : ((await realAx?.(pid, cap)) ?? null),
  );
  // Engage the REAL overlay controller over the synthetic frame: everything the
  // monitor publishes about the phantom then comes from production code.
  void (async () => {
    // AFTER the app's own window exists. `debugShow` creates a BrowserWindow,
    // and this runs on app-ready — win the race and the overlay becomes the
    // app's FIRST window, which is what Playwright's `firstWindow()` hands a
    // probe. (Measured: a probe timed out waiting for the composer because it
    // was driving a 1012×732 transparent overlay.) In production nothing calls
    // the overlay this early, so the wait is the mock's alone.
    await waitForAppWindow();
    await macOverlay.debugShow(WINDOW);
    macMonitor.setSession(MOCK_PID, MOCK_APP);
    await macOverlay.thinking();
    void choreography();
  })();
}

/** Resolve once the app has created at least one window (bounded, so a headless
 * run without one still arms the rest of the mock). */
async function waitForAppWindow(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (BrowserWindow.getAllWindows().length === 0 && Date.now() < deadline) {
    await wait(100);
  }
  // One more beat so the window is not merely constructed but loading.
  await wait(250);
}

/** A slow, deliberate loop through every state the bubble can show. */
async function choreography(): Promise<void> {
  const pt = (fx: number, fy: number): [number, number] => [
    WINDOW.x + WINDOW.w * fx,
    WINDOW.y + WINDOW.h * fy,
  ];
  for (;;) {
    try {
      await macOverlay.moveCursor(...pt(0.32, 0.36));
      await wait(700);
      await macOverlay.clickAt(...pt(0.32, 0.36));
      await wait(900);
      await macOverlay.typing('The quick brown fox jumps over the lazy dog');
      await wait(2400);
      await macOverlay.moveCursor(...pt(0.68, 0.58));
      await macOverlay.keyPress('cmd+s');
      await wait(1600);
      await macOverlay.moveCursor(...pt(0.5, 0.62));
      await macOverlay.scrolling();
      await wait(1400);
      await macOverlay.thinking();
      await wait(2200);
    } catch {
      return; // overlay disposed (app quitting)
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/**
 * The fake `pi-mac --stream` child. Emits PIMF frames on a timer for as long as
 * the monitor keeps it alive — so the "no subscriber → no capture" gate is a
 * real gate here too, not something only production would exercise.
 */
class MockStreamChild implements StreamChild {
  readonly pid = MOCK_PID;
  #dataCb: ((chunk: Buffer) => void) | null = null;
  #closeCb: ((code: number | null) => void) | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #seq = 0;
  #alive = true;
  #startedAt = 0;
  #sentNoWindow = false;
  #sentDenied = false;

  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer) => void): void => {
      this.#dataCb = cb;
      this.#start();
    },
  };
  readonly stderr = {
    on: (): void => {
      /* the mock is quiet */
    },
  };

  on(event: 'error' | 'close', cb: (arg: never) => void): void {
    if (event === 'close') this.#closeCb = cb as unknown as (code: number | null) => void;
  }

  #start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.#tick(), Math.round(1000 / FPS));
    this.#timer.unref?.();
    // Emit one immediately so the surface never sits on "starting" for a frame
    // — unless a probe asked for exactly that (see `firstFrameDelayMs`).
    if (firstFrameDelayMs <= 0) this.#tick();
    else this.#startedAt = Date.now();
  }

  #tick(): void {
    if (!this.#alive) return;
    const cb = this.#dataCb;
    if (cb === null) return;
    if (firstFrameDelayMs > 0 && Date.now() - this.#startedAt < firstFrameDelayMs) return;
    // "Screen Recording is off": the contract's status frame — a header that
    // carries a REASON and no picture. Sent once, like the helper does.
    if (captureDenied) {
      if (this.#sentDenied) return;
      this.#sentDenied = true;
      this.#seq += 1;
      cb(
        encodePimf(
          {
            seq: this.#seq,
            t: Date.now(),
            w: 0,
            h: 0,
            scale: 1,
            rect: { x: 0, y: 0, w: 0, h: 0 },
            display: { x: 0, y: 0, w: 0, h: 0 },
            windows: [],
            error: 'screen-recording-denied',
          },
          new Uint8Array(0),
        ),
      );
      return;
    }
    this.#sentDenied = false;
    // "No window": the contract's once-only zero-payload frame with an empty
    // window list. Sent ONCE, exactly as the helper does — a stream of them
    // would let a consumer paper over the fact that it is a single event.
    if (!windowsPresent) {
      if (this.#sentNoWindow) return;
      this.#sentNoWindow = true;
      this.#seq += 1;
      cb(
        encodePimf(
          {
            seq: this.#seq,
            t: Date.now(),
            w: 0,
            h: 0,
            scale: SCALE,
            rect: { ...WINDOW },
            display: { ...DISPLAY },
            windows: [],
          },
          new Uint8Array(0),
        ),
      );
      return;
    }
    this.#sentNoWindow = false;
    this.#seq += 1;
    const t = Date.now();
    // A save SHEET appears for ~4s out of every 14s so the surface is seen
    // rendering a dialog as part of the app, which is the whole point.
    const phase = (t / 1000) % 14;
    const sheet = phase > 9 ? Math.min(1, (phase - 9) / 0.35) : 0;
    const pixels = renderMockWindow(WINDOW.w * SCALE, WINDOW.h * SCALE, SCALE, this.#seq, sheet);
    const jpeg = toJpeg(pixels, WINDOW.w * SCALE, WINDOW.h * SCALE);
    const header: PimfHeader = {
      seq: this.#seq,
      t,
      w: WINDOW.w * SCALE,
      h: WINDOW.h * SCALE,
      scale: SCALE,
      rect: { ...WINDOW },
      display: { ...DISPLAY },
      windows: [
        {
          windowId: 4242,
          title: 'Untitled 2 — Edited',
          frame: { ...WINDOW },
          sheet: false,
          modal: false,
        },
        ...(sheet > 0
          ? [
              {
                windowId: 4243,
                title: 'Save',
                frame: {
                  x: WINDOW.x + WINDOW.w / 2 - 230,
                  y: WINDOW.y + 40,
                  w: 460,
                  h: 260,
                },
                sheet: true,
                modal: true,
              },
            ]
          : []),
      ],
    };
    try {
      cb(encodePimf(header, jpeg));
    } catch {
      /* consumer went away */
    }
  }

  kill(): void {
    this.#alive = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#closeCb?.(0);
  }
}

// ── the synthetic ACCESSIBILITY tree ────────────────────────────────────────

/** Title bar height of the synthetic window, in points (matches the raster). */
const TITLE_H = 38;
/** How far into the 14s cycle the save sheet is up. Shared with the raster so
 * the two sources of the same app agree about what is on screen. */
function sheetPhase(now = Date.now()): number {
  const phase = (now / 1000) % 14;
  return phase > 9 ? Math.min(1, (phase - 9) / 0.35) : 0;
}

/** `bbox` in the pi-mac wire's space: x,y are the element's CENTRE. */
function box(
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2), w, h };
}

/**
 * The synthetic app as Accessibility would describe it — the same shape the
 * helper's `snapshot` returns, so `axSceneFrom` and the surface's renderer are
 * exercised on a real reply rather than on a shape written to please them.
 */
function mockAxSnapshot(): Record<string, unknown> {
  const sheetUp = sheetPhase() > 0;
  const win = { x: WINDOW.x, y: WINDOW.y, w: WINDOW.w, h: WINDOW.h };
  const sheet = { x: WINDOW.x + WINDOW.w / 2 - 230, y: WINDOW.y + TITLE_H + 20, w: 460, h: 260 };
  const bodyTop = WINDOW.y + TITLE_H + 26;
  const elements: Record<string, unknown>[] = [
    {
      index: 1,
      role: 'AXTextArea',
      name: 'document',
      bbox: box(WINDOW.x + 30, bodyTop + 14, WINDOW.w - 60, WINDOW.h - (TITLE_H + 26) - 34),
      editable: true,
      focused: !sheetUp,
      enabled: true,
      value:
        'The quick brown fox jumps over the lazy dog.\n\n' +
        'Bobble is driving this window. Screen Recording is off, so the monitor is ' +
        'drawing it from the Accessibility tree instead of from pixels — the same ' +
        'tree the model itself is reading and acting on.\n\n' +
        'Everything here is something Accessibility reported: the window frame, the ' +
        'title, the controls, and this text.',
      win: 4242,
    },
    {
      index: 2,
      role: 'AXCheckBox',
      name: 'bold',
      bbox: box(WINDOW.x + 40, WINDOW.y + TITLE_H + 4, 22, 20),
      enabled: true,
      win: 4242,
    },
    {
      index: 3,
      role: 'AXCheckBox',
      name: 'italic',
      bbox: box(WINDOW.x + 64, WINDOW.y + TITLE_H + 4, 22, 20),
      enabled: true,
      win: 4242,
    },
    {
      index: 4,
      role: 'AXCheckBox',
      name: 'underline',
      bbox: box(WINDOW.x + 88, WINDOW.y + TITLE_H + 4, 22, 20),
      enabled: true,
      win: 4242,
    },
    {
      index: 5,
      role: 'AXPopUpButton',
      name: 'Helvetica',
      bbox: box(WINDOW.x + 128, WINDOW.y + TITLE_H + 3, 130, 22),
      enabled: true,
      win: 4242,
    },
    {
      index: 6,
      role: 'AXComboBox',
      name: 'font size',
      bbox: box(WINDOW.x + 268, WINDOW.y + TITLE_H + 3, 56, 22),
      editable: true,
      enabled: true,
      value: '12',
      win: 4242,
    },
    {
      index: 7,
      role: 'AXButton',
      name: 'text color',
      bbox: box(WINDOW.x + 336, WINDOW.y + TITLE_H + 3, 22, 22),
      enabled: true,
      win: 4242,
    },
  ];
  const windows: Record<string, unknown>[] = [
    {
      windowId: 4242,
      role: 'AXWindow',
      subrole: 'AXStandardWindow',
      title: 'Untitled 2 — Edited',
      frame: win,
      main: true,
      focused: !sheetUp,
      sheet: false,
      modal: false,
    },
  ];
  if (sheetUp) {
    windows.unshift({
      windowId: 4243,
      role: 'AXSheet',
      subrole: '',
      title: '',
      frame: sheet,
      main: false,
      focused: true,
      sheet: true,
      modal: true,
    });
    elements.push(
      {
        index: 8,
        role: 'AXTextField',
        name: 'Save As:',
        bbox: box(sheet.x + 130, sheet.y + 54, 250, 26),
        editable: true,
        focused: true,
        enabled: true,
        value: 'Untitled 2',
        win: 4243,
      },
      {
        index: 9,
        role: 'AXPopUpButton',
        name: 'Documents',
        bbox: box(sheet.x + 130, sheet.y + 96, 250, 26),
        enabled: true,
        win: 4243,
      },
      {
        index: 10,
        role: 'AXPopUpButton',
        name: 'Rich Text Document',
        bbox: box(sheet.x + 130, sheet.y + 136, 250, 26),
        enabled: true,
        win: 4243,
      },
      {
        index: 11,
        role: 'AXButton',
        name: 'Cancel',
        bbox: box(sheet.x + 248, sheet.y + 200, 88, 26),
        enabled: true,
        win: 4243,
      },
      {
        index: 12,
        role: 'AXButton',
        name: 'Save',
        bbox: box(sheet.x + 344, sheet.y + 200, 88, 26),
        enabled: true,
        win: 4243,
      },
    );
  }
  return {
    app: MOCK_APP,
    pid: MOCK_PID,
    window: 'Untitled 2 — Edited',
    windowId: sheetUp ? 4243 : 4242,
    windowBounds: sheetUp ? sheet : win,
    windows,
    elements,
  };
}

// ── the synthetic window raster ─────────────────────────────────────────────

/** A tiny RGBA framebuffer with just enough primitives to fake an app window. */
class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }

  fill(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a = 1) {
    const xa = Math.max(0, Math.round(x0));
    const ya = Math.max(0, Math.round(y0));
    const xb = Math.min(this.w, Math.round(x1));
    const yb = Math.min(this.h, Math.round(y1));
    for (let y = ya; y < yb; y++) {
      let i = (y * this.w + xa) * 4;
      for (let x = xa; x < xb; x++) {
        this.data[i] = Math.round((this.data[i] as number) * (1 - a) + r * a);
        this.data[i + 1] = Math.round((this.data[i + 1] as number) * (1 - a) + g * a);
        this.data[i + 2] = Math.round((this.data[i + 2] as number) * (1 - a) + b * a);
        this.data[i + 3] = 255;
        i += 4;
      }
    }
  }

  round(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a = 1,
  ) {
    const rr = Math.min(radius, w / 2, h / 2);
    for (let row = 0; row < Math.round(h); row++) {
      const dy = row < rr ? rr - row : row > h - rr ? row - (h - rr) : 0;
      const inset = dy === 0 ? 0 : rr - Math.sqrt(Math.max(0, rr * rr - dy * dy));
      this.fill(x + inset, y + row, x + w - inset, y + row + 1, r, g, b, a);
    }
  }

  dot(cx: number, cy: number, radius: number, r: number, g: number, b: number) {
    for (let y = -radius; y <= radius; y++) {
      const span = Math.sqrt(Math.max(0, radius * radius - y * y));
      this.fill(cx - span, cy + y, cx + span, cy + y + 1, r, g, b);
    }
  }
}

/**
 * Draw a plausible macOS document window: title bar with traffic lights, a
 * scrolling page of "text", a caret that blinks, and an optional save sheet.
 * `sheet` is 0…1 so the sheet slides rather than pops.
 */
function renderMockWindow(
  w: number,
  h: number,
  scale: number,
  seq: number,
  sheet: number,
): Uint8Array {
  const r = new Raster(w, h);
  const s = (n: number) => n * scale;
  const titleH = s(38);

  // Title bar + body.
  r.fill(0, 0, w, titleH, 236, 236, 238);
  r.fill(0, titleH - scale, w, titleH, 208, 208, 212);
  r.fill(0, titleH, w, h, 255, 255, 255);

  // Traffic lights.
  r.dot(s(20), titleH / 2, s(6), 237, 106, 94);
  r.dot(s(40), titleH / 2, s(6), 245, 191, 79);
  r.dot(s(60), titleH / 2, s(6), 98, 197, 84);
  // Title placeholder.
  r.round(w / 2 - s(70), titleH / 2 - s(4.5), s(140), s(9), s(4.5), 150, 150, 156);

  // Ruler.
  r.fill(0, titleH, w, titleH + s(26), 246, 246, 248);
  for (let i = 1; i < 14; i++) {
    r.fill(s(40) * i, titleH + s(15), s(40) * i + scale, titleH + s(22), 176, 176, 182);
  }

  // A page of "text": bars whose widths vary, scrolling slowly.
  const top = titleH + s(46);
  const lineGap = s(26);
  const scroll = (seq * 0.7) % lineGap;
  let lineIndex = 0;
  for (let y = top - scroll; y < h - s(30); y += lineGap) {
    const seed = Math.abs(Math.sin((lineIndex + Math.floor(seq / 200)) * 12.9898) * 43758.5453) % 1;
    const width = lineIndex % 7 === 6 ? 0.34 + seed * 0.2 : 0.55 + seed * 0.38;
    const shade = lineIndex % 7 === 0 ? 44 : 92;
    r.round(s(48), y, (w - s(96)) * width, s(9), s(4), shade, shade, shade + 6);
    lineIndex += 1;
  }

  // Caret, blinking at ~1Hz.
  if (Math.floor(seq / (FPS / 2)) % 2 === 0) {
    r.fill(s(48) + s(212), top + s(52), s(48) + s(212) + s(2), top + s(52) + s(16), 30, 30, 34);
  }

  // The save sheet: a rounded card sliding down from the title bar.
  if (sheet > 0) {
    const sw = s(460);
    const sh = s(260);
    const sx = (w - sw) / 2;
    const sy = titleH - sh * (1 - sheet) * 0.35 + s(20) * sheet;
    // Dim the document behind it, as macOS does.
    r.fill(0, titleH, w, h, 12, 12, 16, 0.18 * sheet);
    // Shadow.
    r.round(sx - s(6), sy + s(8), sw + s(12), sh, s(20), 0, 0, 0, 0.16 * sheet);
    r.round(sx, sy, sw, sh, s(14), 246, 246, 248);
    // Sheet title + field.
    r.round(sx + s(24), sy + s(24), s(120), s(10), s(5), 60, 60, 66);
    r.round(sx + s(24), sy + s(56), sw - s(48), s(30), s(6), 255, 255, 255);
    r.round(sx + s(34), sy + s(66), s(160), s(10), s(5), 120, 120, 128);
    // Buttons: Cancel + a filled Save (neutral blue-grey, never purple).
    r.round(sx + sw - s(212), sy + sh - s(56), s(92), s(30), s(7), 255, 255, 255);
    r.round(sx + sw - s(110), sy + sh - s(56), s(92), s(30), s(7), 60, 116, 196);
    r.round(sx + sw - s(184), sy + sh - s(46), s(36), s(10), s(5), 90, 90, 98);
    r.round(sx + sw - s(82), sy + sh - s(46), s(36), s(10), s(5), 255, 255, 255);
  }
  return r.data;
}

// ── RGBA → PNG → JPEG ───────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** Minimal RGBA8 PNG — enough for `nativeImage` to decode and re-encode. */
function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function toJpeg(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const png = encodePng(rgba, w, h);
  return new Uint8Array(nativeImage.createFromBuffer(png).toJPEG(78));
}
