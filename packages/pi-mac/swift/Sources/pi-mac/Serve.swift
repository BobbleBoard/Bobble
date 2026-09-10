import AppKit
import ApplicationServices
import Foundation

/// The index→element map from the last snapshot, NAMESPACED BY PID and kept
/// alive for the life of the serve process so `click/type` can resolve a [index]
/// the model saw. Mirrors the browser bridge's `data-pi-idx` stamp +
/// `resolveByIndex` contract; a missing index → `{ found: false }`, which the
/// Node tool turns into an auto re-snapshot + single retry.
///
/// Namespacing by pid is the concurrency guarantee: two sessions (e.g. two
/// subagents) driving DIFFERENT apps each snapshot into their own pid bucket, so
/// one session's snapshot never clobbers the other's indices. Each session passes
/// the app's `pid` (or `app`) on click/type; only the no-hint case falls back to
/// the most-recently-snapshotted pid.
private var elementsByPid: [pid_t: [Int: SnapEl]] = [:]
private var lastSnapshotPid: pid_t?

private let DEFAULT_CAP = 60

// ── param helpers ────────────────────────────────────────────────────────────

private func intOf(_ v: Any?) -> Int? {
  if let i = v as? Int { return i }
  if let n = v as? NSNumber { return n.intValue }
  if let s = v as? String { return Int(s) }
  return nil
}
private func doubleOf(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let n = v as? NSNumber { return n.doubleValue }
  if let s = v as? String { return Double(s) }
  return nil
}
private func stringOf(_ v: Any?) -> String? { v as? String }
private func boolOf(_ v: Any?) -> Bool {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.boolValue }
  return false
}

private func targetFrom(_ params: [String: Any]) -> SnapshotTarget {
  if let pid = intOf(params["pid"]) { return .pid(pid_t(pid)) }
  if let app = stringOf(params["app"]), !app.isEmpty { return .app(app) }
  return .frontmost
}

// ── snapshot (shared by --serve and --snapshot) ──────────────────────────────

private func doSnapshot(_ params: [String: Any]) -> [String: Any]? {
  let cap = intOf(params["cap"]) ?? DEFAULT_CAP
  let find = stringOf(params["find"]) ?? ""
  let from = intOf(params["from"]) ?? 0
  guard
    let snap = collectSnapshot(target: targetFrom(params), cap: cap, find: find, from: from)
  else { return nil }
  // Refresh this pid's resolve-by-index map (leaving other pids' maps intact so
  // concurrent sessions on other apps keep their indices).
  //
  // A FILTERED OR PAGED LOOK MERGES; A PLAIN ONE REPLACES. `find:"save"` and
  // `from:60` are continuations of one look at one app, so page two must not
  // make page one's indices stop resolving — the model would click a button it
  // can still see in its own transcript and be told the index does not exist.
  // A plain snapshot is a fresh look and replaces the map outright, which is
  // what keeps a stale index stale.
  var map: [Int: SnapEl] =
    (find.isEmpty && from <= 0) ? [:] : (elementsByPid[snap.pid] ?? [:])
  for el in snap.elements { map[el.index] = el }
  elementsByPid[snap.pid] = map
  lastSnapshotPid = snap.pid
  // When a screenshot is requested, prefer a focus-free PER-WINDOW capture of
  // the snapshotted window (works occluded / non-frontmost); fall back to the
  // whole screen only if the window id / grant is unavailable.
  // A COMPOSITE of every surface the app is presenting — the window plus any
  // sheet or dialog on top of it. Capturing the single focused window is what
  // made a save panel invisible to the model while it was the only thing it
  // could act on.
  var shot: [String: Any]?
  if boolOf(params["screenshot"]) {
    shot = captureAppSurfaces(pid: snap.pid, withBase64: true)
    if shot == nil, let wid = snap.windowId {
      shot = captureWindow(windowID: wid, withBase64: true)
    }
    if shot == nil { shot = captureScreenshot(withBase64: true) }
  }
  var result = snapshotResultDict(snap, screenshot: shot)
  // Say WHY a snapshot is empty. A missing grant produces a perfectly
  // well-formed result with zero elements and no pixels, which reads as "this
  // app has nothing in it" — the single most misleading thing this surface can
  // return, and the reason a revoked permission went unnoticed for so long.
  let tcc = readTccStatus()
  if !tcc.accessibility || !tcc.screenRecording {
    result["permissions"] = [
      "accessibility": tcc.accessibility, "screenRecording": tcc.screenRecording,
      "hint":
        "macOS has not granted this app "
        + [
          tcc.accessibility ? nil : "Accessibility",
          tcc.screenRecording ? nil : "Screen Recording",
        ].compactMap { $0 }.joined(separator: " and ")
        + ". Until it does, apps read as empty and screenshots are blank. "
        + "Enable them in System Settings > Privacy & Security.",
    ]
  }
  return result
}

/// Resolve a snapshot element by index within the caller's app namespace: an
/// explicit `pid`/`app` (concurrency-safe across apps), else the most recent
/// snapshot's pid. Also returns WHICH pid owned the resolved element, so acts
/// can deliver their fallback events to exactly that app (postToPid).
private func resolveElement(_ params: [String: Any], _ index: Int) -> (el: SnapEl, pid: pid_t)? {
  if let pid = intOf(params["pid"]), let map = elementsByPid[pid_t(pid)] {
    return map[index].map { ($0, pid_t(pid)) }
  }
  if let appName = stringOf(params["app"]), !appName.isEmpty,
    let resolved = resolveTargetPid(.app(appName)), let map = elementsByPid[resolved.pid]
  {
    return map[index].map { ($0, resolved.pid) }
  }
  if let pid = lastSnapshotPid, let map = elementsByPid[pid] {
    return map[index].map { ($0, pid) }
  }
  return nil
}

/// The pid an index-less act should be DELIVERED to (postToPid — background):
/// an explicit `pid`, else a resolvable `app`. Deliberately no lastSnapshotPid
/// fallback — the tool layer stamps the controlled pid explicitly; an
/// unstamped act keeps the legacy foreground (frontmost) behavior.
private func actTargetPid(_ params: [String: Any]) -> pid_t? {
  if let pid = intOf(params["pid"]) { return pid_t(pid) }
  if let app = stringOf(params["app"]), !app.isEmpty, let r = resolveTargetPid(.app(app)) {
    return r.pid
  }
  return nil
}

/// The pid a background act must be DELIVERED to, once the app's presented
/// surfaces are taken into account.
///
/// A sandboxed app's Open/Save panel is a window owned by another process, so
/// "send it to the app's pid" silently drops every event aimed at the one
/// surface the model can actually act on. With a point, the frontmost surface
/// containing that point wins; without one, the frontmost modal wins, because
/// that is what the app is blocked behind.
private func deliveryPid(_ params: [String: Any], at point: CGPoint? = nil) -> pid_t? {
  guard let base = actTargetPid(params) else { return nil }
  let surfaces = appWindows(pid: base)
  if surfaces.isEmpty { return base }
  if let p = point {
    if let hit = surfaces.first(where: { $0.frame.contains(p) }) { return hit.hostPid }
    return base
  }
  return activeSurface(surfaces)?.hostPid ?? base
}

/// A short settle after an act, then a report of which surfaces appeared or
/// disappeared.
///
/// Pressing Save puts up a sheet a few hundred milliseconds later. Without this
/// the model gets back "clicked" and has no reason to look again, so it acts
/// next on a window that is now blocked behind a dialog it never saw. Telling it
/// in the act's own result costs one settle and saves a wasted turn — and a
/// wasted turn here means clicking into a dead window, which looks to the user
/// like the model is broken.
private func surfaceDelta(pid: pid_t?, before: [AppWindow], settleMs: Int = 500) -> [String: Any] {
  guard let pid else { return [:] }
  // Poll rather than sleep the whole window: a sheet takes its time to animate
  // in (MEASURED around 600ms for TextEdit's save sheet, far past a fixed
  // 220ms), but the common act opens nothing at all and should not pay for the
  // rare one. Early exit on the first change keeps the cost proportional.
  let beforeIdsEarly = Set(before.compactMap { $0.windowId })
  var after = before
  let step = 70
  var waited = 0
  while waited < settleMs {
    usleep(UInt32(step) * 1000)
    waited += step
    after = appWindows(pid: pid)
    if Set(after.compactMap { $0.windowId }) != beforeIdsEarly { break }
  }
  let beforeIds = Set(before.compactMap { $0.windowId })
  let afterIds = Set(after.compactMap { $0.windowId })
  var d: [String: Any] = [:]
  let opened = after.filter { w in w.windowId.map { !beforeIds.contains($0) } ?? false }
  let closed = before.filter { w in w.windowId.map { !afterIds.contains($0) } ?? false }
  if !opened.isEmpty { d["opened"] = opened.map(windowDict) }
  if !closed.isEmpty { d["closed"] = closed.map(windowDict) }
  if let dialog = after.first(where: { $0.isModal }) { d["dialog"] = windowDict(dialog) }
  return d
}

/// macOS silently DROPS input aimed at a window a modal is covering. The act
/// reports success, nothing happens, and the model spends the rest of the run
/// re-clicking a dead window. So refuse it here, at the only place that can see
/// both the element's surface and the modal — and say which control to use
/// instead.
private func blockedByDialog(_ el: SnapEl, pid: pid_t) -> [String: Any]? {
  guard let elementWindow = el.win else { return nil }
  let surfaces = appWindows(pid: pid)
  guard let modal = surfaces.first(where: { $0.isModal }), let modalId = modal.windowId,
    modalId != elementWindow
  else { return nil }
  let name = modal.title.isEmpty ? (modal.isSheet ? "a sheet" : "a dialog") : "\"\(modal.title)\""
  return [
    "found": false,
    "blocked": true,
    "dialog": windowDict(modal),
    "error":
      "\(name) is open in front of that window, and macOS drops input to a window behind a "
      + "modal — this act would have done nothing. Snapshot again and act on the dialog's own "
      + "controls, or close it first.",
  ]
}

private func surfacesNow(_ params: [String: Any]) -> (pid: pid_t?, windows: [AppWindow]) {
  guard let pid = actTargetPid(params) else { return (nil, []) }
  return (pid, appWindows(pid: pid))
}

// ── act dispatch (shared) ────────────────────────────────────────────────────

private func doClick(_ params: [String: Any]) -> [String: Any] {
  let pre = surfacesNow(params)
  return doClickInner(params).merging(
    surfaceDelta(pid: pre.pid, before: pre.windows), uniquingKeysWith: { a, _ in a })
}

private func doClickInner(_ params: [String: Any]) -> [String: Any] {
  // Explicit coordinates (AX-opaque surfaces). With a target pid the click is
  // DELIVERED to that app only (postToPid — background, no focus steal); with
  // no pid it falls back to the legacy shared-cursor foreground click.
  if let x = doubleOf(params["x"]), let y = doubleOf(params["y"]) {
    if let pid = deliveryPid(params, at: CGPoint(x: x, y: y)) {
      postClickToPid(pid, x: x, y: y)
      return [
        "found": true, "mode": "coordToPid", "background": true, "x": x, "y": y,
        "deliveredTo": Int(pid),
      ]
    }
    withCoordinateLock { postClick(x: x, y: y) }
    return ["found": true, "mode": "coord", "background": false, "x": x, "y": y]
  }
  guard let index = intOf(params["index"]) else {
    return ["found": false, "error": "click needs an index or x,y"]
  }
  guard let (el, elPid) = resolveElement(params, index) else { return ["found": false] }
  if let blocked = blockedByDialog(el, pid: elPid) { return blocked }
  // Deliver to the pid that owns the element's SURFACE: a sandboxed app's
  // Open/Save panel is hosted by another process, so the app's own pid would
  // never see the event.
  let (mode, background) = performPress(
    el.element, x: Double(el.x), y: Double(el.y), targetPid: el.hostPid)
  // x,y echo the acted-on point (element centre, screen points) so the app can
  // animate the phantom cursor to where the click actually landed.
  return ["found": true, "mode": mode, "background": background, "x": el.x, "y": el.y]
}

private func doType(_ params: [String: Any]) -> [String: Any] {
  let pre = surfacesNow(params)
  // Typing almost never puts up a dialog, and it is the act a model does most
  // often, so it barely waits.
  return doTypeInner(params).merging(
    surfaceDelta(pid: pre.pid, before: pre.windows, settleMs: 200),
    uniquingKeysWith: { a, _ in a })
}

private func doTypeInner(_ params: [String: Any]) -> [String: Any] {
  let text = stringOf(params["text"]) ?? ""
  let submit = boolOf(params["submit"])
  // Typing with no index. An app that exposes nothing to Accessibility has no
  // index to give, so this is the ONLY path into it — and it does not have to
  // be the foreground one. `postToPid` puts the keystrokes in one process's own
  // event queue, so a named target is typed into wherever ITS key window has
  // focus, while the user keeps whatever they were doing. Only a call with no
  // target at all falls back to the system focus, which is the genuine
  // "type into the frontmost field" case.
  guard let index = intOf(params["index"]) else {
    if params["pid"] != nil || params["app"] != nil, let pid = deliveryPid(params) {
      typeTextToPid(pid, text)
      if submit { postKeyToPid(pid, flags: [], key: 36) }
      return [
        "found": true, "mode": "keystrokesToPid", "background": true, "submitted": submit,
        "deliveredTo": Int(pid),
      ]
    }
    withCoordinateLock {
      typeText(text)
      if submit { postKey(flags: [], key: 36) }
    }
    return ["found": true, "mode": "keystrokes", "background": false, "submitted": submit]
  }
  guard let (el, elPid) = resolveElement(params, index) else { return ["found": false] }
  if let blocked = blockedByDialog(el, pid: elPid) { return blocked }
  let pid = el.hostPid

  // AX-FIRST: set the field's value directly (background, no focus, no
  // keystrokes). If the element rejects a value set (or `append` asks for
  // keystrokes so text is added rather than replaced), focus the element
  // app-internally and deliver the keystrokes to ITS pid only — still no focus
  // steal from the user's app. Only a pid-less legacy call types foreground.
  var mode: String
  var background: Bool
  if !boolOf(params["append"]), setValue(el.element, text) {
    mode = "setValue"
    background = true
  } else {
    focusElement(el.element)
    typeTextToPid(pid, text)
    mode = "keystrokesToPid"
    background = true
  }

  if submit {
    // Prefer a background AX confirm (targets THIS element — safe for a
    // non-frontmost app); else a Return delivered to the app's own pid.
    if confirmElement(el.element) {
      mode += "+confirm"
    } else {
      focusElement(el.element)
      postKeyToPid(pid, flags: [], key: 36)
      mode += "+returnToPid"
    }
  }
  return [
    "found": true, "mode": mode, "background": background, "submitted": submit,
    "x": el.x, "y": el.y,
  ]
}

private func doKey(_ params: [String: Any]) -> [String: Any] {
  let pre = surfacesNow(params)
  // A key chord is the likeliest thing to summon a dialog (⌘S, ⌘O, ⌘P), so it
  // gets the longest look before answering.
  return doKeyInner(params).merging(
    surfaceDelta(pid: pre.pid, before: pre.windows, settleMs: 900),
    uniquingKeysWith: { a, _ in a })
}

private func doKeyInner(_ params: [String: Any]) -> [String: Any] {
  guard let combo = stringOf(params["combo"]) ?? stringOf(params["key"]) else {
    return ["ok": false, "error": "key needs a combo"]
  }
  guard let parsed = parseCombo(combo) else {
    return ["ok": false, "error": "unrecognized key combo: \(combo)"]
  }
  // With a target pid the chord is delivered to that app only (background —
  // the user's focus is untouched). Pid delivery also honors the event's own
  // modifier flags, so ⌘-chords land correctly.
  if let pid = deliveryPid(params) {
    postKeyToPid(pid, flags: parsed.flags, key: parsed.key)
    return ["ok": true, "background": true, "deliveredTo": Int(pid)]
  }
  // Legacy pid-less path: chords hit the SYSTEM focus (foreground).
  withCoordinateLock { postKey(flags: parsed.flags, key: parsed.key) }
  return ["ok": true, "background": false]
}

private func doScroll(_ params: [String: Any]) -> [String: Any] {
  var dx = 0
  var dy = 0
  // Prefer explicit signed pixel deltas from the tool layer (pure + unit-tested
  // sign/magnitude — see mac-computer-use/scroll.ts). Fall back to computing
  // them from direction/amount for legacy/one-shot callers.
  if let edx = intOf(params["dx"]), let edy = intOf(params["dy"]), edx != 0 || edy != 0 {
    dx = edx
    dy = edy
  } else {
    let amount = intOf(params["amount"]) ?? 600
    let dir = (stringOf(params["direction"]) ?? "down").lowercased()
    switch dir {
    case "down": dy = -amount
    case "up": dy = amount
    case "left": dx = amount
    case "right": dx = -amount
    default: dy = -amount
    }
  }
  // With a target pid: pin the event inside the target window and deliver to
  // that app only — background scrolling of a non-frontmost window — through
  // the VERIFIED fallback ladder (see doScrollLadder).
  if let pid = actTargetPid(params),
    let info = windowBoundsInfo(target: .pid(pid)),
    let x = info["x"] as? Int, let y = info["y"] as? Int,
    let w = info["w"] as? Int, let h = info["h"] as? Int
  {
    let rect = CGRect(x: Double(x), y: Double(y), width: Double(w), height: Double(h))
    let windowId = (info["windowId"] as? Int).map { CGWindowID($0) }
    return doScrollLadder(params, pid: pid, rect: rect, windowId: windowId, dx: dx, dy: dy)
  }
  // Legacy pid-less path: posts at the shared cursor position (foreground).
  withCoordinateLock { postScroll(dx: dx, dy: dy) }
  return ["ok": true, "background": false]
}

/// How long to let the target app apply a posted scroll before reading the
/// scroll bar back to VERIFY content actually moved (per ladder rung).
private let SCROLL_VERIFY_DELAY_US: UInt32 = 130_000
/// Heuristic pixels→scroll-bar-fraction mapping for the AX last resort (a
/// 600px ask moves ~20% of the document — coarse, but actually moves).
private let AX_SCROLL_PIXELS_PER_UNIT = 3000.0

/// Background scroll with a VERIFIED fallback ladder. A wheel burst posted to
/// a pid is dropped by some apps — and by AppKit itself when the event's
/// location hit-tests to ANOTHER app's window covering ours (the System
/// Settings "scroll did nothing" field failure). So: pin the location to an
/// UNOBSTRUCTED point of the target window, then try the stepped pixel burst
/// → phased gesture → line wheel, verifying each against the scroll bar's AX
/// value when one exists, and finally set the scroll bar value directly.
private func doScrollLadder(
  _ params: [String: Any], pid: pid_t, rect: CGRect, windowId: CGWindowID?, dx: Int, dy: Int
) -> [String: Any] {
  // Preferred location: a snapshot element's centre when given, else centre.
  var preferred = CGPoint(x: rect.midX, y: rect.midY)
  if let index = intOf(params["index"]), let (el, _) = resolveElement(params, index) {
    preferred = CGPoint(x: Double(el.x), y: Double(el.y))
  }
  let pt = unobstructedPoint(windowId: windowId, pid: pid, preferred: preferred, rect: rect)
  let fullyCovered = pt == nil
  let at = pt ?? preferred

  // The verification signal: the targeted scroll area's scroll bar value.
  let axApp = AXUIElementCreateApplication(pid)
  let root = rootFor(app: axApp)
  let scrollArea = findScrollArea(in: root, containing: at)
  let bar = scrollArea.flatMap { scrollBarOf($0, horizontal: dx != 0) }
  func barValue() -> Double? { bar.flatMap { scrollBarValue($0) } }

  func result(_ mode: String, moved: Bool?) -> [String: Any] {
    var d: [String: Any] = [
      "ok": true, "background": true, "mode": mode,
      "x": Int(at.x.rounded()), "y": Int(at.y.rounded()),
    ]
    if let moved = moved { d["moved"] = moved }
    if fullyCovered { d["coveredByOtherWindows"] = true }
    return d
  }

  let rungs: [(name: String, fire: () -> Void)] = [
    ("pixelBurstToPid", { postScrollToPid(pid, dx: dx, dy: dy, at: at) }),
    ("gestureToPid", { postScrollGestureToPid(pid, dx: dx, dy: dy, at: at) }),
    ("lineToPid", { postLineScrollToPid(pid, dx: dx, dy: dy, at: at) }),
  ]

  // A forced mode (live-tuning seam for the probes) fires exactly one rung.
  let forced = stringOf(params["mode"])
  if let forced = forced, forced != "axValue" {
    guard let rung = rungs.first(where: { $0.name == forced }) else {
      return ["ok": false, "error": "unknown scroll mode: \(forced)"]
    }
    let v0 = barValue()
    rung.fire()
    guard let v0 = v0 else { return result(rung.name, moved: nil) }
    usleep(SCROLL_VERIFY_DELAY_US)
    return result(rung.name, moved: barValue().map { abs($0 - v0) > 1e-6 })
  }

  if let v0 = barValue() {
    // Verified ladder: stop at the first rung that actually moves content.
    for rung in rungs {
      rung.fire()
      usleep(SCROLL_VERIFY_DELAY_US)
      if let v1 = barValue(), abs(v1 - v0) > 1e-6 {
        return result(rung.name, moved: true)
      }
    }
  } else if forced != "axValue" {
    // No scroll bar to verify against: fire the burst blind (stacking rungs
    // unverified would multi-scroll a working app).
    rungs[0].fire()
    return result(rungs[0].name, moved: nil)
  }

  // Last resort (or forced axValue): drive the scroll bar's value directly.
  if let bar = bar, let v0 = scrollBarValue(bar) {
    let sign = (dy < 0 || dx < 0) ? 1.0 : -1.0
    let delta = Double(max(abs(dx), abs(dy))) / AX_SCROLL_PIXELS_PER_UNIT
    if setScrollBarValue(bar, v0 + sign * delta) {
      usleep(SCROLL_VERIFY_DELAY_US)
      return result("axValue", moved: barValue().map { abs($0 - v0) > 1e-6 })
    }
  }
  return result("exhausted", moved: false)
}

/// Activate a running app (bring to front) by name — a lightweight focus that
/// doesn't need osascript. Launching a NOT-running app stays the bridge's job
/// (osascript `open -a`), so this only focuses.
private func doFocus(_ params: [String: Any]) -> [String: Any] {
  guard let name = stringOf(params["app"]), !name.isEmpty else {
    return ["ok": false, "error": "focus needs an app name"]
  }
  let q = name.lowercased()
  for app in NSWorkspace.shared.runningApplications {
    let ln = (app.localizedName ?? "").lowercased()
    let bid = (app.bundleIdentifier ?? "").lowercased()
    if ln == q || bid == q || ln.contains(q) {
      app.activate()
      return ["ok": true, "app": app.localizedName ?? name]
    }
  }
  return ["ok": false, "error": "app not running: \(name)"]
}

// ── serve loop ───────────────────────────────────────────────────────────────

private func dispatch(method: String, params: [String: Any]) -> [String: Any]? {
  switch method {
  case "check": return tccStatusDict()
  case "promptGrants": return promptTccGrants()
  case "snapshot": return doSnapshot(params)  // nil → target unresolved
  case "click": return doClick(params)
  case "type": return doType(params)
  case "key": return doKey(params)
  case "scroll": return doScroll(params)
  case "focus": return doFocus(params)
  case "screenshot": return doScreenshot(params)
  case "bounds": return doBounds(params)
  case "frontmost": return doFrontmost()
  case "appIcon": return doAppIcon(params)
  case "moveWindow": return doMoveWindow(params)
  case "windows": return doWindows(params)
  case "wallpaper": return doWallpaper(params)
  case "menus": return doMenus(params)
  case "focusWindow", "raiseWindow": return doFocusWindow(params)
  case "menuClick": return doMenuClick(params)
  case "recordStart": return recordStart(params)
  case "recordStop": return recordStop()
  default: return nil
  }
}

/**
 * THE APP'S REAL ICON, as a PNG.
 *
 * the user: "you can get the real app icon of any program being used right? so just
 * use that no emoji." macOS already has it — every bundle carries one and
 * NSWorkspace hands it over — so a row that says what was done to an app can
 * show the app, not a stand-in that looks the same for Chrome and Blender.
 *
 * By pid when the app is running (which is the case that matters: we are
 * driving it), or by name as a fallback. 64pt, which is two Retina pixels per
 * point at the size a chat row draws it.
 */
func doAppIcon(_ params: [String: Any]) -> [String: Any] {
  let side = CGFloat(intOf(params["size"]) ?? 64)
  var icon: NSImage?
  if let pid = intOf(params["pid"]),
    let app = NSRunningApplication(processIdentifier: pid_t(pid))
  {
    icon = app.icon
  }
  if icon == nil, let name = params["app"] as? String, !name.isEmpty {
    let ws = NSWorkspace.shared
    if let url = ws.urlForApplication(withBundleIdentifier: name)
      ?? ws.runningApplications.first(where: { $0.localizedName == name })?.bundleURL
    {
      icon = ws.icon(forFile: url.path)
    }
  }
  guard let image = icon else { return ["ok": false, "error": "no icon for that app"] }

  let box = NSRect(x: 0, y: 0, width: side, height: side)
  guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    return ["ok": false, "error": "icon has no bitmap"]
  }
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  guard let bitmap = rep, let ctx = NSGraphicsContext(bitmapImageRep: bitmap) else {
    return ["ok": false, "error": "could not rasterise the icon"]
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = ctx
  ctx.cgContext.draw(cg, in: box)
  NSGraphicsContext.restoreGraphicsState()
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    return ["ok": false, "error": "could not encode the icon"]
  }
  return ["ok": true, "base64": png.base64EncodedString(), "mimeType": "image/png", "size": Int(side)]
}

/// `moveWindow` method: AX-reposition the target's window. The deterministic
/// "drag" the live probes use to measure overlay tracking latency.
private func doMoveWindow(_ params: [String: Any]) -> [String: Any] {
  guard let x = doubleOf(params["x"]), let y = doubleOf(params["y"]) else {
    return ["ok": false, "error": "moveWindow needs x,y"]
  }
  let moved = moveWindowTo(target: targetFrom(params), x: x, y: y)
  return moved ? ["ok": true] : ["ok": false, "error": "could not move the target window"]
}

/// `bounds` method: the target window's live frame (+ windowId + whether its
/// app is frontmost). The launch poller spins on this until the window exists;
/// the cursor overlay polls it to track moves/resizes; the no-focus-steal
/// probe asserts on `frontmost`.
private func doBounds(_ params: [String: Any]) -> [String: Any] {
  if let info = windowBoundsInfo(target: targetFrom(params)) { return info }
  return ["ok": false, "error": "no resolvable window for target"]
}

/// `windows` method: EVERY surface the app is presenting, front-to-back — its
/// windows and the sheets, dialogs and file panels on top of them. This is what
/// the monitor stream points at and what tells the tool layer a dialog is up.
private func doWindows(_ params: [String: Any]) -> [String: Any] {
  guard let resolved = resolveTargetPid(targetFrom(params)) else {
    return ["ok": false, "error": "no such app"]
  }
  let windows = appWindows(pid: resolved.pid, includeOffScreen: boolOf(params["all"]))
  var d: [String: Any] = [
    "ok": true, "pid": Int(resolved.pid), "app": resolved.name,
    "windows": windows.map(windowDict),
  ]
  if let u = unionFrame(windows) { d["union"] = rectDict(u) }
  if let a = activeSurface(windows) { d["active"] = windowDict(a) }
  if let dlg = windows.first(where: { $0.isModal }) { d["dialog"] = windowDict(dlg) }
  return d
}

/// `focusWindow` method: give the app a main window so its menus can validate,
/// without activating it or moving the user's focus.
private func doFocusWindow(_ params: [String: Any]) -> [String: Any] {
  guard let resolved = resolveTargetPid(targetFrom(params)) else {
    return ["ok": false, "error": "no such app"]
  }
  let ok = makeWindowMain(pid: resolved.pid)
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
  return ["ok": ok, "frontmostUnchanged": front != resolved.pid]
}

/// `menus` method: the app's menu bar. With no `path` it lists the top-level
/// menus; with one it lists that menu's items. A whole menu bar is hundreds of
/// entries, so the default is deliberately shallow.
private func doMenus(_ params: [String: Any]) -> [String: Any] {
  guard let resolved = resolveTargetPid(targetFrom(params)) else {
    return ["ok": false, "error": "no such app"]
  }
  let path = (stringOf(params["path"]) ?? "").split(separator: ">").map {
    $0.trimmingCharacters(in: .whitespaces)
  }.filter { !$0.isEmpty }
  let levels = intOf(params["levels"]) ?? 1
  // The system menu is never OFFERED (see Menus.swift): at top level it is
  // filtered out, and asking for it by name lists nothing.
  if path.first?.caseInsensitiveCompare(APPLE_MENU_TITLE) == .orderedSame {
    return [
      "ok": true, "app": resolved.name, "pid": Int(resolved.pid),
      "path": path.joined(separator: " > "), "items": [],
    ]
  }
  let entries = menuEntries(pid: resolved.pid, under: path, levels: levels)
    .filter { path.isEmpty ? $0.title != APPLE_MENU_TITLE : true }
  return [
    "ok": true, "app": resolved.name, "pid": Int(resolved.pid),
    "path": path.joined(separator: " > "),
    "items": entries.map(menuEntryDict),
  ]
}

/// `menuClick` method: press a menu item by path. Accessibility presses the item
/// directly, so the menu never opens on screen and the app never has to come to
/// the front — the same background guarantee every other act keeps.
private var result0FocusWarning = false

private func doMenuClick(_ params: [String: Any]) -> [String: Any] {
  result0FocusWarning = false
  guard let resolved = resolveTargetPid(targetFrom(params)) else {
    return ["ok": false, "error": "no such app"]
  }
  guard let path = stringOf(params["path"]), !path.isEmpty else {
    return ["ok": false, "error": "menuClick needs a path like \"File > New\""]
  }
  // Naming a menu rather than an item LISTS it. One parameter then does both
  // jobs — discovery and action — so the model never has to know a second verb
  // exists, and "Format" is a useful thing to say rather than an error.
  if let entry = findMenuItem(pid: resolved.pid, path: path), entry.hasSubmenu {
    let items = menuEntries(pid: resolved.pid, under: entry.path, levels: 1)
    return [
      "ok": true, "listed": true, "path": entry.path.joined(separator: " > "),
      "items": items.map(menuEntryDict),
    ]
  }
  guard let entry = findMenuItem(pid: resolved.pid, path: path) else {
    return [
      "ok": false, "error": "no menu item matching \(path)",
      "menus": listableMenuTitles(pid: resolved.pid),
    ]
  }
  // THE HARD FENCE ON "SHUT DOWN…". The tool layer asks the user first and only
  // then stamps `confirmDestructive`; without it this never fires, whatever the
  // session-wide consent says. A guard that lives only in copy is not a guard.
  if isDestructiveMenuPath(entry.path), !boolOf(params["confirmDestructive"]) {
    return [
      "ok": false, "destructive": true,
      "item": entry.path.joined(separator: " > "),
      "error":
        "\(entry.path.joined(separator: " > ")) ends the user's session or destroys data, "
        + "so it is not pressed on a model's say-so. Ask the user for it in words.",
    ]
  }
  // Do NOT refuse a menu item that reports itself disabled.
  //
  // AppKit only revalidates its menus when the app is ACTIVE or a menu is
  // actually opened, so for the background app this whole surface exists to
  // drive, "enabled" is routinely stale — File > Save read as disabled on a
  // dirty, unsaved document. Refusing on that would make the menu bar unusable
  // exactly where it is most useful. Pressing a genuinely disabled item does
  // nothing, so trying costs nothing; the result says what it looked like and
  // what actually happened.
  // A stale "disabled" almost always means the app has no main window to
  // validate against. Give it one and re-resolve, so the model does not have to
  // know any of this — it asked for File > Save and it should get File > Save.
  var item = entry
  if !item.enabled {
    makeWindowMain(pid: resolved.pid)
    usleep(120_000)
    if let refreshed = findMenuItem(pid: resolved.pid, path: path) { item = refreshed }
  }
  let before = appWindows(pid: resolved.pid)

  // If it STILL reads as disabled, press it the way a person would: send the
  // item's own keyboard shortcut to the app.
  //
  // AppKit revalidates on the key-equivalent path at the moment the event
  // arrives, so ⌘S lands on a document an inactive app's menu still describes
  // as unsavable. MEASURED on TextEdit: File > Save and File > Close both read
  // disabled with a dirty document open, AXPress on them did nothing, and the
  // same command sent as its shortcut opened the save sheet. The event goes to
  // this app's pid only, so the user's focus is still untouched.
  var mode = "axPress"
  var err = AXError.success
  var borrowedFocus = false
  if boolOf(params["activate"]) {
    // The caller asked for the focus to be borrowed, because the item is one
    // macOS will only run for the active app. Take it, run the command, hand it
    // straight back.
    let outcome = withBorrowedFocus(pid: resolved.pid) { () -> AXError in
      guard let fresh = findMenuItem(pid: resolved.pid, path: path) else { return .cannotComplete }
      let pressed = AXUIElementPerformAction(fresh.element, kAXPressAction as CFString)
      if pressed != .success, !fresh.shortcut.isEmpty, let chord = parseCombo(fresh.shortcut) {
        postKeyToPid(resolved.pid, flags: chord.flags, key: chord.key)
        return .success
      }
      return pressed
    }
    err = outcome.value
    borrowedFocus = true
    mode = "activated"
    if !outcome.restored { result0FocusWarning = true }
  } else if !item.enabled, !item.shortcut.isEmpty, let chord = parseCombo(item.shortcut) {
    postKeyToPid(resolved.pid, flags: chord.flags, key: chord.key)
    mode = "shortcutToPid"
  } else {
    err = AXUIElementPerformAction(item.element, kAXPressAction as CFString)
  }
  var result: [String: Any] = [
    "ok": err == .success, "path": item.path.joined(separator: " > "),
    "background": !borrowedFocus,
    "mode": mode,
    "shortcut": item.shortcut,
  ]
  if borrowedFocus {
    result["focusBorrowed"] = true
    result["focusRestored"] = !result0FocusWarning
  }
  // A menu item is the most likely thing in the whole surface to put up a
  // dialog (Open…, Save As…, Print…), so the settle matters most here.
  let delta = surfaceDelta(pid: resolved.pid, before: before, settleMs: 900)
  for (k, v) in delta { result[k] = v }

  if !item.enabled {
    result["lookedDisabled"] = true
    // Nothing happened, and the item read as disabled. For a background app
    // that is the documented case, not a guess: macOS validates document
    // commands only for the ACTIVE app, so Save, Bold and friends are inert
    // until someone is looking at the app. Say so, and say what to do instead —
    // an error the model cannot act on is worth nothing.
    if delta.isEmpty && !borrowedFocus {
      result["ok"] = false
      result["error"] =
        "\(item.path.joined(separator: " > ")) did nothing: macOS only runs a document command "
        + "like this for the app that is FRONTMOST, and this app is being driven in the "
        + "background. Either use the app's own on-screen controls (a snapshot lists them — "
        + "TextEdit's ruler has bold/italic, most apps put their common commands in a toolbar), "
        + "or pass activate:true to borrow the user's focus for just this one command and hand "
        + "it straight back."
    }
  }
  return result
}

/// `wallpaper` method: the user's desktop picture, which the canvas monitor
/// paints behind the streamed window so an unsized window still sits on a real
/// desktop rather than on a void.
private func doWallpaper(_ params: [String: Any]) -> [String: Any] {
  var rect: CGRect?
  if let resolved = resolveTargetPid(targetFrom(params)) {
    rect = unionFrame(appWindows(pid: resolved.pid))
  }
  return desktopWallpaper(rect: rect)
}

/// `frontmost` method: which app currently owns the user's focus.
private func doFrontmost() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    return ["ok": false, "error": "no frontmost application"]
  }
  return [
    "ok": true,
    "app": app.localizedName ?? "",
    "pid": Int(app.processIdentifier),
    "bundleId": app.bundleIdentifier ?? "",
  ]
}

/// `screenshot` method: a focus-free per-window capture when a `windowId` (or a
/// resolvable `app`/`pid` whose window id we can look up) is given, else the
/// whole screen. Never nil — a failure returns a structured error.
private func doScreenshot(_ params: [String: Any]) -> [String: Any] {
  var windowId = intOf(params["windowId"]).map { CGWindowID($0) }
  // No explicit window id → composite EVERY surface the app is presenting.
  if windowId == nil, params["app"] != nil || params["pid"] != nil {
    if let resolved = resolveTargetPid(targetFrom(params)),
      let composite = captureAppSurfaces(
        pid: resolved.pid, withBase64: true, maxWidth: intOf(params["maxWidth"]))
    {
      return composite
    }
    if let resolved = resolveTargetPid(targetFrom(params)) {
      let root = rootFor(app: AXUIElementCreateApplication(resolved.pid))
      windowId = axWindowID(root)
    }
  }
  if let wid = windowId, let shot = captureWindow(windowID: wid, withBase64: true) {
    return shot
  }
  return captureScreenshot(withBase64: true) ?? ["path": "", "error": "capture failed"]
}

/// Persistent NDJSON pump: one `{ id, method, params }` request per stdin line,
/// one `{ id, ok, result|error }` response per line. Single-threaded, so the
/// index map needs no locking. EOF (bridge closed) ends the loop → clean exit.
func runServe() {
  while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    guard let data = line.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      emitError(id: nil, message: "malformed request")
      continue
    }
    let id = intOf(obj["id"])
    guard let method = obj["method"] as? String else {
      emitError(id: id, message: "missing method")
      continue
    }
    let params = (obj["params"] as? [String: Any]) ?? [:]
    if let result = dispatch(method: method, params: params) {
      emitResult(id: id, result: result)
    } else if method == "snapshot" {
      emitError(id: id, message: "could not resolve target app for snapshot")
    } else {
      emitError(id: id, message: "unknown method: \(method)")
    }
  }
}

// ── one-shot subcommands (CLI testing / capability probe) ─────────────────────

/// `--snapshot [--frontmost|--pid N|--app NAME] [--screenshot]` → bare result.
func runSnapshotCommand(_ argv: [String]) {
  var params: [String: Any] = [:]
  var i = 0
  while i < argv.count {
    switch argv[i] {
    case "--frontmost": break
    case "--pid":
      i += 1
      if i < argv.count, let pid = Int(argv[i]) { params["pid"] = pid }
    case "--app":
      i += 1
      if i < argv.count { params["app"] = argv[i] }
    case "--screenshot": params["screenshot"] = true
    default: break
    }
    i += 1
  }
  if let result = doSnapshot(params) {
    emit(result)
  } else {
    emitError(id: nil, message: "could not resolve target app for snapshot")
  }
}

/// `--act '<json>'` → perform one raw act (no index map in one-shot mode; use
/// x,y / type / key / scroll). Emits a bare ack.
func runActCommand(_ argv: [String]) {
  guard let json = argv.first, let data = json.data(using: .utf8),
    let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    emitError(id: nil, message: "usage: pi-mac --act '{\"kind\":\"click\",\"x\":10,\"y\":20}'")
    return
  }
  let kind = (params["kind"] as? String) ?? "click"
  var result: [String: Any]
  switch kind {
  case "click": result = doClick(params)
  case "type": result = doType(params)
  case "key": result = doKey(params)
  case "scroll": result = doScroll(params)
  case "focus": result = doFocus(params)
  default: result = ["ok": false, "error": "unknown act kind: \(kind)"]
  }
  emit(result)
}
