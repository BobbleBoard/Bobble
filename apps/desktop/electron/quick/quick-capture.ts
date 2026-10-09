/**
 * PICTURES OF OTHER APPS, for the quick panel — and stand-ins for test runs.
 *
 * Captured from ELECTRON, not the `pi-mac` helper, for the reason
 * ../mac/window-capture.ts gives: macOS keys Screen Recording to the binary
 * that asks, and the binary a person switches on in System Settings is Bobble.
 * Chromium's `desktopCapturer` runs as Bobble, so that grant is the one used.
 *
 * Window sources are `window:<CGWindowID>:0`, the same number the window server
 * (and so the helper's `screenWindows`) uses — which is how "the window in
 * front" and "the window you clicked" become pixels with no guessing.
 *
 * Nothing here is called without the grant: on a Mac that has not decided,
 * asking `desktopCapturer` is what puts up the system prompt, and the panel
 * must only ever cause that from a button the person pressed (the fix button's
 * `registerForScreenRecording`), never from a hotkey.
 *
 * Under PI_E2E the provider is FAKE: pictures drawn from HTML in an offscreen
 * window, so a probe exercises every path with no permission and no picture of
 * anyone's screen.
 */
import { app, BrowserWindow, desktopCapturer, type NativeImage, nativeImage } from 'electron';
import { openStillWindow } from '../gen/hyperframes-window';
import { screenCaptureGrant } from '../mac/window-capture';
import type { Grant } from './quick-mac';
import { capturePixelSize, type DisplayGeometry } from './region-math';

export interface WindowSource {
  readonly windowId: number;
  readonly title: string;
  readonly icon: NativeImage | null;
  readonly thumbnail: NativeImage | null;
}

export interface QuickCapture {
  grant(): Grant;
  /** One window's pixels (and title), at up to `maxEdge` on its long side. Null when it is gone. */
  windowImage(
    windowId: number,
    maxEdge?: number,
  ): Promise<{ image: NativeImage; title: string } | null>;
  /** One display's pixels, at its full pixel size. */
  displayImage(display: DisplayGeometry): Promise<NativeImage | null>;
  /** Every window the picker can offer, with icons and thumbnails. */
  windowSources(): Promise<WindowSource[]>;
}

/** The media ids of Bobble's own windows — never offered, never captured. */
function ownSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      ids.add(w.getMediaSourceId());
    } catch {
      /* a window torn down mid-call */
    }
  }
  return ids;
}

function windowIdOf(sourceId: string): number | null {
  const m = /^window:(\d+):\d+$/.exec(sourceId);
  return m === null ? null : Number(m[1]);
}

export function createRealCapture(): QuickCapture {
  return {
    grant: () => screenCaptureGrant(),
    async windowImage(windowId, maxEdge = 2400) {
      if (screenCaptureGrant() !== 'granted') return null;
      const own = ownSourceIds();
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: maxEdge, height: maxEdge },
        fetchWindowIcons: false,
      });
      const hit = sources.find((s) => windowIdOf(s.id) === windowId && !own.has(s.id));
      return hit === undefined || hit.thumbnail.isEmpty()
        ? null
        : { image: hit.thumbnail, title: hit.name };
    },
    async displayImage(display) {
      if (screenCaptureGrant() !== 'granted') return null;
      const size = capturePixelSize(display);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: size,
        fetchWindowIcons: false,
      });
      const hit =
        sources.find((s) => s.display_id === String(display.id)) ??
        (sources.length === 1 ? sources[0] : undefined);
      return hit === undefined || hit.thumbnail.isEmpty() ? null : hit.thumbnail;
    },
    async windowSources() {
      if (screenCaptureGrant() !== 'granted') return [];
      const own = ownSourceIds();
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 480, height: 300 },
        fetchWindowIcons: true,
      });
      const out: WindowSource[] = [];
      for (const s of sources) {
        const windowId = windowIdOf(s.id);
        if (windowId === null || own.has(s.id)) continue;
        out.push({
          windowId,
          title: s.name,
          icon: s.appIcon !== null && !s.appIcon.isEmpty() ? s.appIcon : null,
          thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail,
        });
      }
      return out;
    },
  };
}

// ── the stand-in ────────────────────────────────────────────────────────────

/** Where the fake windows' REAL icons come from — the system draws them. */
const FAKE_APP_PATHS: Readonly<Record<string, string>> = {
  TextEdit: '/System/Applications/TextEdit.app',
  Safari: '/Applications/Safari.app',
  Notes: '/System/Applications/Notes.app',
};

const FAKE_DOC = `
  <div class="doc">
    <h1>Launch checklist</h1>
    <p>Ship the quick panel once the hotkey, the area capture and the window picker
    all pass on two displays. The release notes go out on Thursday; the support
    page needs the new screenshots before then.</p>
    <ul><li>Confirm the default shortcut</li><li>Write the permission guide</li>
    <li>Record the walkthrough</li></ul>
    <p class="muted">Owner: design · Due: Thursday</p>
  </div>`;

function fakeWindowHtml(title: string, w: number, h: number): string {
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;font-family:-apple-system,system-ui,sans-serif;background:#fff;color:#1d1d1f">
  <style>
    .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#ececec;border-bottom:1px solid #d6d6d6}
    .dot{width:12px;height:12px;border-radius:50%;background:#c9c9c9}
    .t{flex:1;text-align:center;font-size:13px;color:#555;margin-right:60px}
    .doc{padding:28px 40px;font-size:15px;line-height:1.55}
    h1{font-size:22px;margin:0 0 12px} .muted{color:#888;font-size:13px}
  </style>
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="t">${title}</span></div>
  ${FAKE_DOC}</body></html>`;
}

function fakeDesktopHtml(w: number, h: number): string {
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;background:linear-gradient(135deg,#1f4f5a 0%,#2f7d84 45%,#b8d7d2 100%)">
  <style>
    .win{position:absolute;background:#fff;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden}
    .bar{height:30px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#ececec;border-bottom:1px solid #d6d6d6;font-size:12px;color:#555}
    .dot{width:11px;height:11px;border-radius:50%;background:#c9c9c9}
    .doc{padding:20px 28px;font-size:13px;line-height:1.5;color:#1d1d1f} h1{font-size:18px;margin:0 0 8px}
    .menu{position:absolute;left:0;top:0;right:0;height:24px;background:rgba(255,255,255,.55);backdrop-filter:blur(20px)}
    .chart{display:flex;align-items:flex-end;gap:10px;height:150px;padding:10px 28px}
    .chart i{display:block;width:34px;background:#2f7d84;border-radius:4px 4px 0 0}
  </style>
  <div class="menu"></div>
  <div class="win" style="left:60px;top:300px;width:600px;height:480px"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>&nbsp; Notes</div>
    <div class="doc"><h1>Groceries</h1><p>Oat milk, lemons, rye bread, coffee beans, basil.</p></div></div>
  <div class="win" style="left:180px;top:120px;width:760px;height:520px"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>&nbsp; Launch checklist.txt</div>${FAKE_DOC}</div>
  <div class="win" style="left:${Math.min(w - 920, 760)}px;top:220px;width:900px;height:600px"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>&nbsp; Quarterly report</div>
    <div class="doc"><h1>Visitors by month</h1><p>Up 18% on the last quarter, led by the new guides.</p></div>
    <div class="chart"><i style="height:40%"></i><i style="height:55%"></i><i style="height:48%"></i><i style="height:70%"></i><i style="height:82%"></i><i style="height:95%"></i></div></div>
  </body></html>`;
}

async function render(html: string, w: number, h: number): Promise<NativeImage> {
  const still = await openStillWindow(w, h);
  try {
    await still.load(html, w, h);
    return nativeImage.createFromBuffer(await still.capture());
  } finally {
    await still.dispose().catch(() => undefined);
  }
}

export function createFakeCapture(state: {
  grant: Grant;
  windows: () => ReadonlyArray<{ windowId: number; app: string }>;
}): QuickCapture & { desktop(display: DisplayGeometry): Promise<NativeImage> } {
  const windowCache = new Map<number, NativeImage>();
  let desktopCache: { key: string; img: NativeImage } | null = null;
  const desktop = async (display: DisplayGeometry): Promise<NativeImage> => {
    const w = Math.round(display.bounds.width);
    const h = Math.round(display.bounds.height);
    const key = `${w}x${h}`;
    if (desktopCache?.key !== key)
      desktopCache = { key, img: await render(fakeDesktopHtml(w, h), w, h) };
    return desktopCache.img;
  };
  const titleOf = (app: string): string =>
    app === 'TextEdit'
      ? 'Launch checklist.txt'
      : app === 'Safari'
        ? 'Quarterly report'
        : 'Groceries';
  const windowImage = async (windowId: number): Promise<NativeImage | null> => {
    const known = state.windows().find((w) => w.windowId === windowId);
    if (known === undefined) return null;
    const cached = windowCache.get(windowId);
    if (cached !== undefined) return cached;
    const img = await render(fakeWindowHtml(titleOf(known.app), 1100, 720), 1100, 720);
    windowCache.set(windowId, img);
    return img;
  };
  return {
    desktop,
    grant: () => state.grant,
    async windowImage(windowId) {
      if (state.grant !== 'granted') return null;
      const image = await windowImage(windowId);
      const known = state.windows().find((w) => w.windowId === windowId);
      return image === null ? null : { image, title: titleOf(known?.app ?? '') };
    },
    async displayImage(display) {
      if (state.grant !== 'granted') return null;
      return desktop(display);
    },
    async windowSources() {
      if (state.grant !== 'granted') return [];
      const out: WindowSource[] = [];
      for (const w of state.windows()) {
        const path = FAKE_APP_PATHS[w.app];
        let icon: NativeImage | null = null;
        if (path !== undefined) {
          try {
            const got = await app.getFileIcon(path, { size: 'large' });
            icon = got.isEmpty() ? null : got;
          } catch {
            icon = null;
          }
        }
        const img = await windowImage(w.windowId);
        out.push({
          windowId: w.windowId,
          title: titleOf(w.app),
          icon,
          thumbnail: img === null ? null : img.resize({ width: 480 }),
        });
      }
      return out;
    },
  };
}
