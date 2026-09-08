import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ── every surface an app owns ────────────────────────────────────────────────
//
// the user's field report: "if it clicks open and a finder window pops up (but a
// dialog window not real finder app, still part of textedit) it needs to be
// able to interact with and do that."
//
// So the unit of computer use is NOT "the focused window" — it is EVERY
// window-like surface the app is currently presenting: its windows, the sheets
// attached to them, the modal dialogs it put up, its popovers. Two of those
// carry a trap:
//
//   * A sandboxed app's Open/Save panel is hosted by a DIFFERENT process
//     (com.apple.appkit.xpc.openAndSavePanelService). Accessibility bridges the
//     panel into the app's own tree, so the elements are reachable from the
//     app's AXUIElement — but the WINDOW belongs to the service's pid, so a
//     capture or a pid-targeted CGEvent aimed at the app's pid misses it
//     entirely. Every surface therefore records `hostPid`, the pid that really
//     owns its window.
//   * A panel AX does not bridge would be invisible here. So the enumeration
//     also sweeps the window server for windows that sit ABOVE the app's front
//     window and overlap it — an attached surface by geometry — and includes
//     them for capture even with no AX element behind them.

/// One on-screen window as the window server sees it.
struct CGWinInfo {
  let windowId: CGWindowID
  let ownerPid: pid_t
  let bounds: CGRect
  let layer: Int
  /// Front-to-back index in the window server's list (0 == frontmost).
  let z: Int
  let alpha: Double
}

/// Every on-screen window, front-to-back. One window-server round trip.
func onScreenWindows() -> [CGWinInfo] {
  guard
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
      as? [[String: Any]]
  else { return [] }
  var out: [CGWinInfo] = []
  out.reserveCapacity(list.count)
  for (i, w) in list.enumerated() {
    guard let num = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
      let owner = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      let b = w[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: b)
    else { continue }
    out.append(
      CGWinInfo(
        windowId: num,
        ownerPid: pid_t(owner),
        bounds: r,
        layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        z: i,
        alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1))
  }
  return out
}

/// A window-like surface the controlled app is presenting.
struct AppWindow {
  /// The AX element, when Accessibility exposes one (nil for a geometry-only
  /// surface found in the window server sweep).
  let element: AXUIElement?
  let windowId: CGWindowID?
  /// The pid that actually owns the window — the app's own pid for a normal
  /// window, the panel service's pid for a sandboxed Open/Save panel.
  let hostPid: pid_t
  let role: String
  let subrole: String
  let title: String
  let frame: CGRect
  let isMain: Bool
  let isFocused: Bool
  let isModal: Bool
  let isSheet: Bool
  /// Front-to-back index from the window server; Int.max when off-screen.
  let z: Int
}

/// Roles that are a presented surface in their own right rather than content.
private let SURFACE_ROLES: Set<String> = ["AXSheet", "AXDrawer", "AXPopover"]
/// Subroles that mark a window as a SYSTEM dialog. Deliberately not "AXDialog":
/// MEASURED on macOS 27, every one of TextEdit's ordinary document windows
/// reports subrole AXDialog, so treating that as modal marked eight open
/// documents as eight modals and would have refused every legitimate act on
/// them. Modality is read from AXModal and from the AXSheet role, which are the
/// two signals that mean it.
private let DIALOG_SUBROLES: Set<String> = ["AXSystemDialog"]
/// Processes that host UI on another app's behalf. Their windows belong to the
/// app the user is looking at, so control has to follow them.
let PANEL_HOST_BUNDLES: Set<String> = [
  "com.apple.appkit.xpc.openAndSavePanelService",
  "com.apple.print.PrintCenter",
  "com.apple.ColorSyncCalibrator",
  "com.apple.quicklook.QuickLookUIService",
  "com.apple.dt.CommandLineTools.installondemand",
]

private func isPanelHost(_ pid: pid_t) -> Bool {
  guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
  if let bundle = app.bundleIdentifier {
    if PANEL_HOST_BUNDLES.contains(bundle) { return true }
    // The service is versioned/renamed across releases; the family name is the
    // stable part, so match it rather than pinning an exact identifier.
    if bundle.contains("openAndSavePanelService") || bundle.contains("xpc.") { return true }
  }
  return false
}

/// Recursively pull sheets/drawers/popovers out of a window subtree. Depth is
/// capped because these nest at most a couple of levels in practice and the
/// walk must stay cheap enough to run on every snapshot.
private func attachedSurfaces(_ el: AXUIElement, depth: Int = 0) -> [AXUIElement] {
  if depth > 2 { return [] }
  var found: [AXUIElement] = []
  for kid in axChildren(el) {
    let role = axString(kid, kAXRoleAttribute) ?? ""
    if SURFACE_ROLES.contains(role) {
      found.append(kid)
      found.append(contentsOf: attachedSurfaces(kid, depth: depth + 1))
    }
  }
  return found
}

private func windowRecord(
  _ el: AXUIElement, appPid: pid_t, focusedId: CGWindowID?, byId: [CGWindowID: CGWinInfo]
) -> AppWindow? {
  let role = axString(el, kAXRoleAttribute) ?? ""
  let subrole = axString(el, kAXSubroleAttribute) ?? ""
  let wid = axWindowID(el)
  let cg = wid.flatMap { byId[$0] }
  guard let frame = windowFrame(el) ?? cg?.bounds else { return nil }
  let isSheet = role == "AXSheet"
  return AppWindow(
    element: el,
    windowId: wid,
    hostPid: cg?.ownerPid ?? appPid,
    role: role,
    subrole: subrole,
    title: truncate(cleanText(axString(el, kAXTitleAttribute) ?? ""), 120),
    frame: frame,
    isMain: axBool(el, kAXMainAttribute) ?? false,
    isFocused: wid != nil && wid == focusedId,
    isModal: isSheet || DIALOG_SUBROLES.contains(subrole) || (axBool(el, "AXModal") ?? false),
    isSheet: isSheet,
    z: cg?.z ?? Int.max)
}

/// Every surface `pid` is presenting, front-to-back (frontmost first).
///
/// `includeOffScreen` keeps windows the window server is not currently
/// compositing (other space / minimized): the model may still want to know they
/// exist, but nothing can be captured from them.
func appWindows(pid: pid_t, includeOffScreen: Bool = false) -> [AppWindow] {
  let app = AXUIElementCreateApplication(pid)
  let screen = onScreenWindows()
  var byId: [CGWindowID: CGWinInfo] = [:]
  for w in screen { byId[w.windowId] = w }
  // Without the Screen Recording grant the window server can hand back a list
  // with none of this app's windows in it. That is missing INFORMATION, not
  // evidence that the app has no windows — and treating it as the latter is
  // what made a whole app (dialogs included) enumerate as empty while
  // Accessibility was happily returning its elements. When the window server
  // tells us nothing about this pid, trust Accessibility alone.
  let cgKnowsThisApp = screen.contains { $0.ownerPid == pid }

  let focusedEl = axCopy(app, kAXFocusedWindowAttribute).map { unsafeBitCast($0, to: AXUIElement.self) }
  let focusedId = focusedEl.flatMap { axWindowID($0) }

  var roots: [AXUIElement] = []
  if let list = axCopy(app, kAXWindowsAttribute) as? [AXUIElement] { roots = list }
  if roots.isEmpty, let f = focusedEl { roots = [f] }

  var out: [AppWindow] = []
  var seenIds = Set<CGWindowID>()
  for root in roots {
    for el in [root] + attachedSurfaces(root) {
      guard let rec = windowRecord(el, appPid: pid, focusedId: focusedId, byId: byId) else {
        continue
      }
      if let id = rec.windowId {
        if seenIds.contains(id) { continue }
        seenIds.insert(id)
      }
      if !includeOffScreen, cgKnowsThisApp, let id = rec.windowId, byId[id] == nil { continue }
      out.append(rec)
    }
  }

  // Window-server completion pass. An app that exposes nothing to Accessibility
  // — an Electron/Java/game canvas, the user's AX-opaque case — still has real
  // windows, and those windows are exactly what the visual control path has to
  // capture and stream. Without this the whole visual surface would be empty
  // for precisely the apps that need it most.
  for w in screen where w.ownerPid == pid && w.layer == 0 && w.alpha > 0.05 {
    guard !seenIds.contains(w.windowId), w.bounds.width > 40, w.bounds.height > 40 else {
      continue
    }
    seenIds.insert(w.windowId)
    out.append(
      AppWindow(
        element: nil, windowId: w.windowId, hostPid: pid, role: "AXWindow", subrole: "",
        title: "", frame: w.bounds, isMain: out.isEmpty, isFocused: false, isModal: false,
        isSheet: false, z: w.z))
  }

  // Geometry sweep: a panel-service window sitting above the app's front window
  // and overlapping it is part of this app's presentation even when nothing in
  // the AX tree pointed at it.
  let ownFront = out.filter { $0.z != Int.max }.min(by: { $0.z < $1.z })
  if let front = ownFront {
    for w in screen where w.layer == 0 && w.alpha > 0.05 && w.ownerPid != pid {
      guard !seenIds.contains(w.windowId), w.z < front.z else { continue }
      guard isPanelHost(w.ownerPid) else { continue }
      guard w.bounds.intersects(front.frame) else { continue }
      seenIds.insert(w.windowId)
      let panelApp = AXUIElementCreateApplication(w.ownerPid)
      let panelEl = (axCopy(panelApp, kAXFocusedWindowAttribute))
        .map { unsafeBitCast($0, to: AXUIElement.self) }
      out.append(
        AppWindow(
          element: panelEl, windowId: w.windowId, hostPid: w.ownerPid,
          role: "AXWindow", subrole: "AXDialog",
          title: panelEl.flatMap { axString($0, kAXTitleAttribute) } ?? "",
          frame: w.bounds, isMain: false, isFocused: true, isModal: true, isSheet: false,
          z: w.z))
    }
  }

  return out.sorted { $0.z < $1.z }
}

/// Bounding box of a set of surfaces, in global screen points.
func unionFrame(_ windows: [AppWindow]) -> CGRect? {
  let rects = windows.map { $0.frame }.filter { $0.width > 1 && $0.height > 1 }
  guard var u = rects.first else { return nil }
  for r in rects.dropFirst() { u = u.union(r) }
  return u
}

/// The surface the model's next act should be aimed at: the frontmost modal
/// (sheet / dialog / panel) if one is up, else the focused window, else the
/// frontmost window. When this is a dialog, the app is BLOCKED behind it and
/// acting anywhere else is a mistake — the tool layer says so out loud.
func activeSurface(_ windows: [AppWindow]) -> AppWindow? {
  if let modal = windows.first(where: { $0.isModal }) { return modal }
  if let focused = windows.first(where: { $0.isFocused }) { return focused }
  return windows.first
}

func windowDict(_ w: AppWindow) -> [String: Any] {
  var d: [String: Any] = [
    "role": w.role, "subrole": w.subrole, "title": w.title,
    "frame": ["x": w.frame.minX, "y": w.frame.minY, "w": w.frame.width, "h": w.frame.height],
    "main": w.isMain, "focused": w.isFocused, "modal": w.isModal, "sheet": w.isSheet,
    "hostPid": Int(w.hostPid),
  ]
  if let id = w.windowId { d["windowId"] = Int(id) }
  return d
}

func rectDict(_ r: CGRect) -> [String: Any] {
  ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height]
}


/// Make an app's front document window its MAIN window, without activating the
/// app.
///
/// AppKit only validates its menus against the responder chain of the main
/// window, and an inactive app can have none — which is why File > Save reads
/// as disabled on a dirty, unsaved document and pressing it does nothing. This
/// gives the menu something to validate against while leaving the user's focus
/// exactly where it was.
@discardableResult
func makeWindowMain(pid: pid_t) -> Bool {
  let surfaces = appWindows(pid: pid)
  // Never steal main-ness from a modal — that is the surface the app is
  // deliberately blocked behind.
  guard let target = surfaces.first(where: { !$0.isModal && $0.role == "AXWindow" }),
    let el = target.element
  else { return false }
  // AXRaise reorders the window WITHIN its own app, which is what gives an
  // inactive app a main window to validate its menus against — unlike setting
  // AXFrontmost, it does not activate the app or move the user's focus.
  let raised = AXUIElementPerformAction(el, kAXRaiseAction as CFString)
  let main = AXUIElementSetAttributeValue(el, kAXMainAttribute as CFString, kCFBooleanTrue)
  let focused = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  return raised == .success || main == .success || focused == .success
}


/// Run `body` with the target app momentarily frontmost, then give the user's
/// app back the focus.
///
/// MEASURED on macOS 27: AppKit only validates document-scoped menu commands
/// against the main window of the ACTIVE app, and an inactive app has none. So
/// File > Save and Format > Font > Bold read as disabled on a dirty, open
/// document, AXPress on them does nothing, and ⌘S delivered to the app's own
/// queue does nothing either. AXRaise, AXMain and AXFocused were all tried
/// first: raise succeeds and changes nothing about validation.
///
/// Borrowing the focus for the length of one command is therefore the only way
/// those commands run at all. It is never done silently — the caller asks for
/// it, and the result says the focus was borrowed and returned.
func withBorrowedFocus<T>(pid: pid_t, _ body: () -> T) -> (value: T, restored: Bool) {
  let previous = NSWorkspace.shared.frontmostApplication
  let target = NSRunningApplication(processIdentifier: pid)
  target?.activate(options: [])
  // Activation is asynchronous; a command sent before it lands validates
  // against the old state and is silently dropped, which is the whole bug.
  var waited = 0
  while waited < 900,
    NSWorkspace.shared.frontmostApplication?.processIdentifier != pid
  {
    usleep(50_000)
    waited += 50
  }
  let value = body()
  usleep(150_000)
  var restored = true
  if let previous, previous.processIdentifier != pid {
    restored = previous.activate(options: [])
  }
  return (value, restored)
}
