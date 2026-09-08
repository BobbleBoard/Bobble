# Computer-use hardening — shared contract (round 21)

Three lanes build against this doc in parallel. It is the ONLY coupling point:
do not change a name here without saying so in your report.

Goal (the user): computer use goes from "half baked" to production grade —
(a) visual control works for AX-opaque apps AND for the app's own dialogs
    (a TextEdit save/open sheet is part of TextEdit, not Finder),
(b) the phantom cursor is always shown,
(c) a NEW canvas tab live-streams the controlled window + its dialogs, drawn
    at real size, centred, over the user's desktop wallpaper.

## Lane N — native (Swift, packages/pi-mac) — owned by the lead, already in flight

### New/changed NDJSON methods on `pi-mac --serve`

`windows` — every on-screen window the app owns.
```
params: { pid?: number, app?: string }
result: {
  ok: true, pid, app: string,
  windows: [{
    windowId: number,        // CGWindowID
    role: string,            // AXWindow | AXSheet | AXDialog | AXPopover…
    subrole: string,         // AXStandardWindow | AXDialog | AXSystemDialog | ""
    title: string,
    frame: { x, y, w, h },   // global screen points, top-left origin
    main: boolean, focused: boolean, modal: boolean, sheet: boolean,
  }],
  union: { x, y, w, h },     // bounding box of all of them
}
```

`snapshot` — unchanged shape PLUS:
- walks the focused window **and** every sheet/dialog/popover the app owns, so
  a save sheet's Save/Cancel/filename field get indices.
- each element gains `win` (the windowId it lives in) and the result gains
  `windows` (as above) + `dialog: { title, role } | null` for the frontmost
  modal surface. Indices stay pid-namespaced and stable.
- `screenshot: true` now returns a **composite** of all the app's windows
  (main + sheets + dialogs) in one image, cropped to `union`.

`screenshot` — same composite; `{ path, base64, mimeType, rect: union, windows: [...] }`.

`wallpaper` — `{ ok, path: string, screen: { w, h } }` — the desktop picture of
the main display (NSWorkspace.desktopImageURL).

### New process mode: `pi-mac --stream --pid <n> [--fps 12] [--max-width 1400]`

ScreenCaptureKit stream over exactly the app's windows. Length-prefixed frames
on **stdout**, NDJSON control on **stdin**, diagnostics on **stderr**.

```
frame := "PIMF" | uint32be headerLen | uint32be payloadLen | header(JSON utf8) | payload(JPEG)
header := {
  seq, t,                       // ms epoch
  w, h,                         // pixel size of the JPEG
  scale,                        // backing scale (2 on retina)
  rect: {x,y,w,h},              // union rect in screen POINTS — real size for the canvas
  display: {x,y,w,h},           // the DISPLAY the window is on, same global
                                //   top-left space as rect — the monitor's
                                //   "stage" (second monitors included)
  windows: [{ windowId, title, frame, sheet, modal }],
}
stdin: {"cmd":"fps","value":8} | {"cmd":"quit"}
```
Frames stop being emitted (not an error) when the app has no on-screen window;
a `{"seq":…, "windows":[]}` header with a 0-byte payload is sent once so the
consumer can show "no window".

## Lane A — Electron main + renderer canvas tab

**Main** (`apps/desktop/electron/mac/`): a `monitor.ts` that owns the
`--stream` child for the currently-controlled app, started when a computer-use
session takes control and stopped when it ends or no renderer is subscribed.

IPC (add to ipc-contract.ts):
- renderer→main `mac:monitor:subscribe` `{}` → `{ ok, state }`
- renderer→main `mac:monitor:unsubscribe`
- main→renderer `mac:monitor:state` `{ active, pid, appName, wallpaperPath,
  rect, display, statusText, cursor: {x,y}|null, cursorState }`
    – `cursor` is in the SAME screen-point space as `rect` (global), so the
      canvas maps it with the existing pure helpers in overlay-geometry.ts.
    – `cursorState`/`statusText` mirror what the real overlay bubble shows;
      reuse the overlay's existing state source rather than inventing one.
- main→renderer `mac:monitor:frame` `{ seq, t, jpeg: Uint8Array, w, h, rect,
  display, windows }`

**Renderer**: a new canvas surface kind `computer-use`, registered like the
other builtins, opened/focused automatically when a mac computer-use session
starts (mirror `browser-agent.ts`'s auto-open, keyed `mac-monitor`, title =
the controlled app's name). It renders:
- the user's wallpaper as the backdrop, cover-fit, dimmed slightly;
- the streamed window image at its REAL point size, centred, never upscaled,
  scaled DOWN only when the tab is too small (keep aspect, integer-ish);
- the phantom cursor drawn on top at the mapped point, matching overlay.html's
  gradient cursor + bubble so the two read as the same object;
- a quiet footer: app name, window title, "live" dot, fps.
Use `<canvas>` + `createImageBitmap(new Blob([jpeg]))`. Drop frames when the
tab is hidden (unsubscribe) — never queue.

Check `pd-file://` (or whatever scheme media uses) actually serves the
wallpaper path; wallpapers live under /System/Library/Desktop Pictures or the
user's Photos library, so the scheme's allowlist probably needs the path.

### Refinements since the first draft (all live in the helper now)

* JPEG has no alpha, so the composite arrives with black where the window is
  not. Do NOT paint the raw frame edge-to-edge: clip to the union of the
  windows' own rounded rects (`header.windows[].frame`, radius ~10pt, mapped
  into canvas space) and drop a soft shadow, so the wallpaper shows through the
  corners and around a dialog. That is also what makes it read as a real window
  on a real desktop.
* A frame can carry `error: "screen-recording-denied" | "no-shareable-window"`
  with a 0-byte payload. Render the denied case as a real, actionable state
  (System Settings > Privacy & Security > Screen Recording) — it is the single
  most likely reason a user sees nothing.
* New serve methods worth using: `windows`, `wallpaper`, `menus`, `menuClick`,
  `recordStart`/`recordStop`.
* `bounds` now returns the UNION of every surface (so the overlay covers
  dialogs) plus `active`/`dialog`; acts return `opened`/`closed`/`dialog` when
  the act put a dialog up.

## Lane B — Node tool layer (packages/mac-computer-use) + prompt

- surface `windows`/`dialog` in the snapshot text so the model SEES a dialog
  appeared ("⚠︎ a dialog is open: Save — the indices below are its controls").
- clicks/types must target the dialog's window; keep pid stamping.
- `visualOnly` apps: snapshot returns the composite screenshot + the
  "control this visually with coordinates" note, never an error.
- CLI `--help` text for every verb kept in sync with the new params.
- capability-prompt / group summary: say that dialogs and sheets are part of
  the app and are driven the same way.
