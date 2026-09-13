import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ── AX attribute readers (all total: a failed copy → nil) ────────────────────

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
  var ref: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(el, attr as CFString, &ref)
  return err == .success ? ref : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  guard let v = axCopy(el, attr) else { return nil }
  return v as? String
}

/// An attribute's DISPLAYED value, whatever type AX chose to hand it back in.
///
/// `axString` is `v as? String`, which is nil for a number — and AX returns
/// numbers wherever a value is numeric. MEASURED on Calculator: the display's
/// AXValue is an NSNumber, so reading it as a string failed and the name fell
/// through to the role description, "Edit field". The one number on screen was
/// unreadable, and the app looked like it had nothing to say.
///
/// Booleans are spelled out rather than rendered as CFNumber's 1/0, since a
/// checkbox reading "1" is worse than one reading "true".
func axValueText(_ el: AXUIElement, _ attr: String) -> String? {
  guard let v = axCopy(el, attr) else { return nil }
  if let s = v as? String { return s }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return (v as? Bool) == true ? "true" : "false" }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

/// An AXURL attribute, which comes back as a CFURL and so is nil through both
/// `axString` (`as? String`) and `axValueText`.
func axURLText(_ el: AXUIElement, _ attr: String) -> String? {
  guard let v = axCopy(el, attr) else { return nil }
  if let u = v as? URL { return u.absoluteString }
  if CFGetTypeID(v) == CFURLGetTypeID() {
    return (unsafeBitCast(v, to: CFURL.self) as URL).absoluteString
  }
  if let s = v as? String { return s }
  return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
  guard let v = axCopy(el, attr) else { return nil }
  return v as? Bool
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
  guard let v = axCopy(el, kAXChildrenAttribute) else { return [] }
  return (v as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let arr = names else { return [] }
  return (arr as? [String]) ?? []
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  // swiftlint:disable:next force_cast
  let axv = v as! AXValue
  var pt = CGPoint.zero
  guard AXValueGetValue(axv, .cgPoint, &pt) else { return nil }
  return pt
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  // swiftlint:disable:next force_cast
  let axv = v as! AXValue
  var sz = CGSize.zero
  guard AXValueGetValue(axv, .cgSize, &sz) else { return nil }
  return sz
}

func axSettable(_ el: AXUIElement, _ attr: String) -> Bool {
  var settable: DarwinBoolean = false
  let err = AXUIElementIsAttributeSettable(el, attr as CFString, &settable)
  return err == .success && settable.boolValue
}

// Private (but decades-stable) CoreGraphics↔AX bridge: map an AXUIElement WINDOW
// to its CGWindowID. That id lets us screenshot exactly that window
// (`screencapture -l <id>`) even when it is occluded or NOT frontmost — the
// focus-free perception surface for a background app. Declared via its C symbol.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>)
  -> AXError

/// The CGWindowID for an AX window element, or nil if it isn't a window / the
/// bridge fails.
func axWindowID(_ el: AXUIElement) -> CGWindowID? {
  var wid: CGWindowID = 0
  return _AXUIElementGetWindow(el, &wid) == .success && wid != 0 ? wid : nil
}

// ── target resolution ────────────────────────────────────────────────────────

/// The app in front RIGHT NOW.
///
/// `NSWorkspace.shared.frontmostApplication` is a cached value refreshed by
/// workspace notifications on the main run loop — and `--serve` has no run
/// loop, it blocks in readLine. MEASURED: with Chrome activated for two
/// seconds, a loop-less process read "Claude" the whole time. Every "did the
/// app take the front?" check in this helper read that stale value, which is
/// why "activate() does nothing" and "focus cannot be handed back" measured
/// the way they did. Pumping the loop for a few milliseconds delivers the
/// pending notification; the CG window order agrees with it afterwards.
func frontmostApplicationNow() -> NSRunningApplication? {
  RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.006))
  return NSWorkspace.shared.frontmostApplication
}

/// A snapshot target the caller can name: the frontmost app, a specific pid, or
/// an app matched by (case-insensitive) localized name / bundle id.
enum SnapshotTarget {
  case frontmost
  case pid(pid_t)
  case app(String)
}

func resolveTargetPid(_ target: SnapshotTarget) -> (pid: pid_t, name: String)? {
  switch target {
  case .frontmost:
    guard let app = frontmostApplicationNow() else { return nil }
    return (app.processIdentifier, app.localizedName ?? "frontmost")
  case .pid(let pid):
    let running = NSRunningApplication(processIdentifier: pid)
    return (pid, running?.localizedName ?? "pid \(pid)")
  case .app(let query):
    let q = query.lowercased()
    for app in NSWorkspace.shared.runningApplications {
      let name = (app.localizedName ?? "").lowercased()
      let bundle = (app.bundleIdentifier ?? "").lowercased()
      if name == q || bundle == q || name.contains(q) {
        return (app.processIdentifier, app.localizedName ?? query)
      }
    }
    return nil
  }
}

// ── snapshot ─────────────────────────────────────────────────────────────────

/// One indexed AX element as the model sees it (mirror of browser-use's
/// SnapshotElement). Coordinates are SCREEN points (top-left origin) — the same
/// space CGEvent mouse posts use — so an index resolves to a click with no
/// coordinate math on the Node side.
struct SnapEl {
  let index: Int
  let role: String
  let name: String
  let x: Int
  let y: Int
  let w: Int
  let h: Int
  let editable: Bool
  let enabled: Bool
  let focused: Bool
  let value: String
  let actions: [String]
  let element: AXUIElement
  /// The surface (window / sheet / dialog) this element lives in, and the pid
  /// that really owns that surface. A sandboxed app's Open/Save panel is hosted
  /// by another process, so a coordinate act aimed at the app's own pid would
  /// miss it — acts follow `hostPid`, not the snapshot's pid.
  let win: CGWindowID?
  let hostPid: pid_t
  /// Non-empty when the element is NOT in the app's main window: "Open" for a
  /// dialog titled Open, so the model can tell at a glance which surface an
  /// index belongs to.
  let surface: String
  /// This element is its surface's DEFAULT button (AXDefaultButton). macOS gives
  /// a save sheet no AXTitle at all, so the default button's name is the only
  /// thing in the whole snapshot that can name it.
  let isDefault: Bool
}

/// Roles worth surfacing even when they expose no AX action (so a text area the
/// model must type into is never dropped). Mirrors browser perception's
/// interactive-selector set.
private let INTERACTIVE_ROLES: Set<String> = [
  "AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXMenuButton",
  "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXSlider",
  "AXIncrementor", "AXTab", "AXTabGroup", "AXDisclosureTriangle", "AXSearchField", "AXCell",
  "AXRow", "AXColorWell", "AXStepper", "AXSegmentedControl", "AXToolbarButton",
]

/// Chrome/decoration roles that are never useful action targets — dropping them
/// keeps the indexed list focused on things the model can meaningfully click or
/// type into (TextEdit alone exposes ~30 ruler markers otherwise).
private let NOISE_ROLES: Set<String> = [
  "AXRuler", "AXRulerMarker", "AXScrollBar", "AXGrowArea", "AXSplitter", "AXValueIndicator",
  "AXIncrementorArrow", "AXLayoutItem", "AXLayoutArea", "AXUnknown",
]

/// Roles that DISPLAY something rather than accept an action.
///
/// WHAT AN APP SAYS BACK IS NOT CLICKABLE. Every snapshot until now listed only
/// what could be pressed or typed into, so a model could drive an app and never
/// read the consequence: Calculator's answer, an alert's message, the validation
/// error under a field, a status line, a computed total. MEASURED — a snapshot of
/// Calculator returns 25 buttons and not the display, so "what is 37 × 24" is
/// unanswerable by the app that just computed it.
///
/// These do NOT join the indexed list. Indices address things you act on, and
/// every caller, doc and monitor overlay depends on them not shifting. The read
/// text rides alongside in its own block.
private let TEXT_ROLES: Set<String> = [
  "AXStaticText", "AXHeading",
]

private let NAME_MAX = 120
private let MAX_NODES = 4000
/// Read text is a summary, not a transcript — enough to see what the app is
/// saying, capped so a document-shaped window cannot flood the result. The cap
/// is on LINES, after the runs on each line have been joined: a web page is
/// thousands of one-word runs and forty of those is not a sentence.
private let TEXT_MAX_ITEMS = 200
private let TEXT_ITEM_MAX = 200
/// Raw runs collected before joining. Generous, because they collapse hard.
private let TEXT_MAX_RUNS = 2500
/// Total characters of read text in one snapshot. MEASURED: a full Apple
/// product page is 23,555 characters, which is worth more than a screenshot but
/// not worth four of them — this keeps the top of the page and leaves the rest
/// to `find`. Lowered from 4,000 after a run: the whole snapshot went past the
/// bash tool's own output limit and arrived TRIMMED, and the model spent two
/// turns saving it to a file to read it back.
private let TEXT_TOTAL_MAX = 2600

func cleanText(_ s: String) -> String {
  let collapsed = s.replacingOccurrences(
    of: "\\s+", with: " ", options: .regularExpression)
  return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
}

func truncate(_ s: String, _ max: Int) -> String {
  if s.count <= max { return s }
  return String(s.prefix(max - 1)) + "…"
}

private func accessibleName(_ el: AXUIElement, role: String) -> String {
  if let t = axString(el, kAXTitleAttribute), !cleanText(t).isEmpty { return cleanText(t) }
  if let d = axString(el, kAXDescriptionAttribute), !cleanText(d).isEmpty { return cleanText(d) }
  // A value is a decent name for buttons/links whose title is empty.
  if let v = axValueText(el, kAXValueAttribute), !cleanText(v).isEmpty {
    return cleanText(v)
  }
  if let placeholder = axString(el, kAXPlaceholderValueAttribute), !cleanText(placeholder).isEmpty {
    return cleanText(placeholder)
  }
  /*
   * AXRoleDescription NAMES THE ROLE, NOT THE THING.
   *
   * MEASURED on Maps: five AXStaticText elements came back named "text", and a
   * button named "button". Those are macOS's role descriptions surfacing because
   * the element publishes no title, description, value or placeholder — so the
   * snapshot printed `[3] AXStaticText "text"` five times, which reads to a
   * model like five pieces of content called "text" rather than five elements
   * with nothing in them. A fake name is worse than no name: it costs a line,
   * it invites a click, and the role is already printed beside it.
   *
   * So it is kept ONLY when it says something the role does not. "text" for an
   * AXStaticText and "button" for an AXButton are restatements and go; a genuine
   * app-specific description ("map view" on an AXGroup) survives, because that
   * is the case this fallback was worth having for.
   */
  if let rd = axString(el, kAXRoleDescriptionAttribute) {
    let described = cleanText(rd)
    let flat = described.lowercased().replacingOccurrences(of: " ", with: "")
    let roleWord = role.lowercased().replacingOccurrences(of: "ax", with: "")
    if !described.isEmpty, !flat.isEmpty, !roleWord.contains(flat) {
      return described
    }
  }
  return ""
}

private func isEditable(_ el: AXUIElement, role: String) -> Bool {
  if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox"
    || role == "AXSearchField"
  {
    return true
  }
  return axSettable(el, kAXValueAttribute)
}

/// Whole main-display bounds, used only to prefer on-screen elements first.
private func mainDisplayBounds() -> CGRect {
  if let screen = NSScreen.main { return screen.frame }
  return CGRect(x: 0, y: 0, width: 100_000, height: 100_000)
}

/// Pick the window subtree to walk: focused window, else main window, else the
/// first window, else the whole app element (menus, sheets).
func rootFor(app: AXUIElement) -> AXUIElement {
  if let w = axCopy(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }  // swiftlint:disable:this force_cast
  if let w = axCopy(app, kAXMainWindowAttribute) { return (w as! AXUIElement) }  // swiftlint:disable:this force_cast
  let windows = axChildren(app)
  return windows.first ?? app
}

struct SnapshotResult {
  let elements: [SnapEl]
  let appName: String
  let windowTitle: String
  let truncated: Bool
  let total: Int
  /// How many candidates the `find` filter matched (== `total` when none was
  /// asked for). The paging line needs the size of the pool it is capping, not
  /// the size of the app.
  let matched: Int
  /// Where this page starts in the app's own tree order.
  let offset: Int
  /// The `find` substring this page was filtered by, echoed back.
  let find: String
  /// PID of the resolved target app. The serve loop namespaces its index→element
  /// map by this so concurrent sessions driving DIFFERENT apps never clobber each
  /// other's indices (concurrency-safe across apps).
  let pid: pid_t
  /// CGWindowID of the snapshotted window (when the root is a window), so a
  /// focus-free per-window screenshot can target exactly it.
  let windowId: CGWindowID?
  /// The snapshotted window's frame in GLOBAL screen points (top-left origin),
  /// when the root is a real window — the cursor overlay positions itself over
  /// exactly this rect. Nil when the root fell back to the app element.
  let windowBounds: CGRect?
  /// Every surface the app is presenting, front-to-back — windows, sheets,
  /// dialogs, popovers. The monitor streams their union; the model is told when
  /// one of them is modal.
  let windows: [AppWindow]
  /// The frontmost modal surface, when the app is blocked behind one. Acting
  /// anywhere else while this is non-nil does nothing, so the tool layer says
  /// so out loud rather than letting the model click into a dead window.
  let dialog: AppWindow?
  /// Read-only text the app is showing: the calculator's answer, the alert's
  /// message, the error under the field. Not indexed — see TEXT_ROLES.
  let text: [ReadLine]
}

/**
 * ASK A CHROMIUM APP TO TURN ITS ACCESSIBILITY TREE ON.
 *
 * Chrome, Electron and everything else built on Chromium build their AX tree
 * LAZILY: with no assistive client watching, the whole app is one empty
 * rectangle. MEASURED on Bobble itself — an Electron app — a snapshot returned
 * 0 elements, which is the same nothing Blender gives, for an entirely
 * different and fixable reason.
 *
 * `AXManualAccessibility` is the attribute Chromium watches for exactly this.
 * Setting it is what an assistive technology does, it needs no cooperation from
 * the app, no launch flag, no restart and no Apple Events — so it works on an
 * app that is ALREADY OPEN, which a `--remote-debugging-port` approach can
 * never do.
 *
 * Set on every target and ignored by everything that is not Chromium, so there
 * is no need to know in advance what kind of app this is (and no list of app
 * names to keep up to date, which is the version of this that rots).
 */
/** Apps already asked this session, so only the first look pays the wake-up. */
private var chromiumPrimed = Set<pid_t>()
private let chromiumPrimeLock = NSLock()

/**
 * Wake a Chromium app's accessibility tree, and wait the first time.
 *
 * Returns true when this pid was primed just now (so the caller knows to give
 * the tree a beat to appear).
 */
@discardableResult
func enableChromiumAccessibility(_ app: AXUIElement, pid: pid_t) -> Bool {
  let ok = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  // The older spelling, still honoured by some Chromium builds and by Java/SWT.
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  if ProcessInfo.processInfo.environment["PI_MAC_DEBUG_AX"] == "1" {
    FileHandle.standardError.write(
      "AXManualAccessibility=\(ok.rawValue) pid=\(pid)\n".data(using: .utf8)!)
  }
  guard ok == .success else { return false }
  chromiumPrimeLock.lock()
  defer { chromiumPrimeLock.unlock() }
  return chromiumPrimed.insert(pid).inserted
}

/// Walk the AX tree of `target` and return a COMPACT, INDEXED element list
/// (default cap 60). Deterministic document-order traversal; on-screen elements
/// sort first. Returns nil only when the target app cannot be resolved; an empty
/// list (AX not granted → every copy fails) is a valid, non-nil result.
/// Case-insensitive substring test used by `find`. Deliberately not a regex:
/// the model is typing a word it read, and a bad pattern must never be the
/// reason a snapshot comes back empty.
private func matchesFind(_ el: SnapEl, _ needle: String) -> Bool {
  let n = needle.lowercased()
  return el.name.lowercased().contains(n) || el.role.lowercased().contains(n)
    || el.value.lowercased().contains(n)
}

func collectSnapshot(
  target: SnapshotTarget, cap: Int, find: String = "", from: Int = 0
) -> SnapshotResult? {
  guard let resolved = resolveTargetPid(target) else { return nil }
  let app = AXUIElementCreateApplication(resolved.pid)
  /*
   * A Chromium app publishes NOTHING until an assistive client asks, and it
   * builds the tree asynchronously — so the very first look after the ask comes
   * back with the window and an empty element list. Pay the wait once, here,
   * rather than making every caller take two snapshots to see an app.
   */
  if enableChromiumAccessibility(app, pid: resolved.pid) {
    Thread.sleep(forTimeInterval: 0.45)
  }
  // Walk EVERY surface the app is presenting, front-to-back — its window and
  // any sheet, dialog or file panel on top of it. A save panel is part of the
  // app the user is looking at, so its controls have to be in the same indexed
  // list as the window's; walking only the focused window is what made the
  // model click into a window that was blocked behind a dialog.
  let surfaces = appWindows(pid: resolved.pid)
  let active = activeSurface(surfaces)
  let fallbackRoot = rootFor(app: app)
  let roots: [(el: AXUIElement, win: AppWindow?)] =
    surfaces.isEmpty
    ? [(fallbackRoot, nil)]
    : surfaces.compactMap { w in w.element.map { (el: $0, win: w) } }
  let mainWindowId = surfaces.first(where: { !$0.isModal })?.windowId
  let windowTitle = active?.title ?? (axString(fallbackRoot, kAXTitleAttribute) ?? "")
  let windowId = active?.windowId ?? axWindowID(fallbackRoot)
  let windowBounds = active?.frame ?? windowFrame(fallbackRoot)
  let bounds = mainDisplayBounds()

  struct Cand {
    let el: AXUIElement
    let role: String
    let name: String
    let rect: CGRect
    let editable: Bool
    let enabled: Bool
    let focused: Bool
    let value: String
    let actions: [String]
    let onScreen: Bool
    let win: CGWindowID?
    let hostPid: pid_t
    let surface: String
    let isDefault: Bool
  }

  var cands: [Cand] = []
  var visited = 0
  var seenElements = Set<AXUIElement>()
  /// What the app is DISPLAYING, in document order — see TEXT_ROLES. Kept with
  /// its frame so a label can be told from a control by WHERE it is.
  var readText: [(rect: CGRect, text: String)] = []
  // The DEFAULT button of every surface the app is presenting. A save sheet has
  // no title, so this is the only thing in the payload that can name it.
  var defaultButtons = Set<AXUIElement>()
  for root in roots {
    for host in [root.el] + axChildren(root.el).filter({
      axString($0, kAXRoleAttribute) == "AXWindow"
    }) {
      if let def = axCopy(host, kAXDefaultButtonAttribute) {
        defaultButtons.insert(unsafeBitCast(def, to: AXUIElement.self))
      }
    }
  }
  for root in roots {
  let surfaceWin = root.win
  let surfaceLabel: String = {
    guard let w = surfaceWin, w.windowId != mainWindowId else { return "" }
    if !w.title.isEmpty { return w.title }
    return w.isSheet ? "sheet" : (w.isModal ? "dialog" : "window")
  }()
  var stack: [AXUIElement] = [root.el]

  while let el = stack.popLast() {
    if visited >= MAX_NODES { break }
    visited += 1
    // Push children (reversed so pop order == document order).
    let kids = axChildren(el)
    for kid in kids.reversed() { stack.append(kid) }

    let role = axString(el, kAXRoleAttribute) ?? ""
    if role.isEmpty || NOISE_ROLES.contains(role) { continue }
    let actions = axActions(el)
    let editable = isEditable(el, role: role)
    let pressable = actions.contains("AXPress") || actions.contains("AXConfirm")
    let interactive = INTERACTIVE_ROLES.contains(role)
    if !editable && !pressable && !interactive {
      // Not something to act on — but possibly something the app is SAYING.
      if TEXT_ROLES.contains(role), readText.count < TEXT_MAX_RUNS {
        /*
         * FOR A LABEL, THE VALUE IS THE TEXT. `accessibleName` prefers title,
         * then description — right for a control, wrong here: Calculator's
         * display carries AXDescription "Edit field" and AXValue "888", so the
         * generic order reported the furniture and hid the answer.
         */
        let shown = cleanText(axValueText(el, kAXValueAttribute) ?? "").isEmpty
          ? accessibleName(el, role: role)
          : cleanText(axValueText(el, kAXValueAttribute) ?? "")
        if !shown.isEmpty {
          let pos = axPoint(el, kAXPositionAttribute) ?? CGPoint(x: -1, y: -1)
          let size = axSize(el, kAXSizeAttribute) ?? CGSize(width: 0, height: 0)
          /*
           * A RUN WITH NO HEIGHT IS STILL TEXT ON THE SCREEN.
           *
           * This used to require both dimensions > 1, on the reasoning that a
           * zero-sized label is laid out but not shown. MEASURED against
           * Chrome: of 850 text runs on an Apple product page, 799 come back
           * with a real width and a height of ZERO — "Storage. [95x0]", "How
           * much space do you need? [314x0]", "$1999 [36x0]". They are exactly
           * the words the user is reading. The old rule threw 94% of the page
           * away, which is the whole reason Chrome looked like it had nothing
           * in it and every model reached for a screenshot instead.
           *
           * So: reject only the genuinely unlaid-out (both dimensions gone),
           * and let being ON SCREEN decide the rest — which is what the rule
           * was really trying to ask.
           */
          if size.width > 1 || size.height > 1 {
            let r = CGRect(
              x: pos.x, y: pos.y, width: max(size.width, 1), height: max(size.height, 1))
            if r.intersects(bounds) {
              readText.append((r, truncate(shown, TEXT_ITEM_MAX)))
            }
          }
        }
      }
      continue
    }

    let name = accessibleName(el, role: role)
    if name.isEmpty && !editable { continue }  // nameless non-field control → skip
    /*
     * A BOX IS NOT A BUTTON.
     *
     * Chrome reports its layout boxes as AXGroup, named "group", and marks them
     * EDITABLE — so they sailed past the nameless-control test and filled a
     * sixteenth of the indexed list with `[3] AXGroup "group" (editable)`. There
     * is nothing a model can do with one, and on a page whose real controls are
     * already truncated they cost the things it could have used.
     */
    if role == "AXGroup", !pressable, name.isEmpty || name.lowercased() == "group" { continue }

    let pos = axPoint(el, kAXPositionAttribute) ?? CGPoint(x: -1, y: -1)
    let size = axSize(el, kAXSizeAttribute) ?? CGSize(width: 0, height: 0)
    /*
     * A CONTROL BELOW THE FOLD IS STILL A CONTROL.
     *
     * the user: "controlling through dom shouldn't need scroll right? why would it?
     * especially if you can read the full page and then have a snapshot with an
     * optional search <keyword> argument, scrolling should only be necessary if
     * using visually." Exactly right, and the reason it was not true here was
     * this line: it required BOTH dimensions, and Chrome reports everything
     * outside the viewport with a real width and a height of ZERO.
     *
     * MEASURED with the page scrolled to the very top: all four storage radio
     * buttons are already in the tree at 329x0. They were being thrown away, so
     * `find:"2TB"` answered "not on this page" and the only way left was to
     * scroll until they rendered — which is a VISUAL workflow, imposed on a
     * text one by a filter.
     *
     * They keep their index and their element reference, so a click reaches
     * them by AXPress with no coordinate involved. What they do NOT get is a
     * believable position: `onScreen` is false, so they sort after everything
     * visible and nothing aims a pointer at them.
     */
    if size.width <= 1 && size.height <= 1 { continue }
    let rect = CGRect(origin: pos, size: max(size.height, 1) == size.height
      ? size : CGSize(width: size.width, height: 1))
    let value = editable ? (axValueText(el, kAXValueAttribute) ?? "") : ""
    let enabled = axBool(el, kAXEnabledAttribute) ?? true
    let focused = axBool(el, kAXFocusedAttribute) ?? false
    let onScreen = rect.intersects(bounds)

    if seenElements.contains(el) { continue }
    seenElements.insert(el)

    cands.append(
      Cand(
        el: el, role: role, name: truncate(name, NAME_MAX), rect: rect, editable: editable,
        enabled: enabled, focused: focused, value: truncate(cleanText(value), NAME_MAX),
        actions: actions, onScreen: onScreen, win: surfaceWin?.windowId,
        hostPid: surfaceWin?.hostPid ?? resolved.pid, surface: surfaceLabel,
        isDefault: defaultButtons.contains(el)))
  }
  }

  // On-screen first, then document order (traversal already document order, so a
  // stable partition preserves it).
  let onScreenCands = cands.filter { $0.onScreen }
  let offScreenCands = cands.filter { !$0.onScreen }
  let ordered = onScreenCands + offScreenCands

  /*
   * INDICES ARE POSITIONS IN THE WHOLE TREE, NOT IN THE PAGE.
   *
   * `find` and `from` exist because the cap used to be a dead end: 60 of 812
   * shown, and no way to see the other 752. They are only useful if a control
   * the model finds on page two can then be clicked — so an element's number is
   * its position in the FULL ordered walk, and filtering or paging never
   * renumbers it. `find:"save"` returning `[7] AXButton "Save"` means index 7 is
   * the same control an unfiltered snapshot would have called 7.
   */
  let all: [SnapEl] = ordered.enumerated().map { (i, c) in
    SnapEl(
      index: i + 1, role: c.role, name: c.name,
      x: Int(c.rect.midX.rounded()), y: Int(c.rect.midY.rounded()),
      w: Int(c.rect.width.rounded()), h: Int(c.rect.height.rounded()),
      editable: c.editable, enabled: c.enabled, focused: c.focused, value: c.value,
      actions: c.actions, element: c.el, win: c.win, hostPid: c.hostPid,
      surface: c.surface, isDefault: c.isDefault)
  }

  let needle = find.trimmingCharacters(in: .whitespaces)
  let pool = needle.isEmpty ? all : all.filter { matchesFind($0, needle) }
  let start = max(0, min(from, pool.count))
  let limit = cap > 0 ? cap : pool.count
  let page = Array(pool[start..<min(pool.count, start + limit)])

  return SnapshotResult(
    elements: page, appName: resolved.name, windowTitle: windowTitle,
    truncated: pool.count > start + page.count, total: all.count,
    matched: pool.count, offset: start, find: needle,
    pid: resolved.pid, windowId: windowId, windowBounds: windowBounds, windows: surfaces,
    dialog: surfaces.first(where: { $0.isModal }),
    /*
     * Deduplicated against the controls, because a button's label is usually its
     * own child AXStaticText and listing both says the same thing twice. What
     * survives is the text that belongs to no control — which is exactly the
     * part the model could not see.
     */
    text: dedupeReadText(readText, against: all, find: needle, viewport: windowBounds))
}

/// Read text minus the labels that BELONG to a listed control.
///
/// Dedupe by string alone was wrong in the first app it met: Calculator's
/// display reads "0" and Calculator also has a button labelled "0", so the one
/// number the model needed was the one thing dropped. A control's label is its
/// own child, so it sits INSIDE the control's frame — and the display, which
/// belongs to no control, does not. Geometry tells them apart; a matching string
/// does not.
///
/// Order is preserved: an app's static text reads top-to-bottom, and that order
/// is most of its meaning ("Total:" then "48.20").
/**
 * Join runs that sit on one visual line before anything else looks at them.
 *
 * A native label is one run. A web page is not: Chrome hands back "256", "GB",
 * "Buy from", "$1999" as four separate elements on the same baseline, and a
 * list of those reads like shredded paper. Same baseline and touching
 * horizontally means it was one sentence to the person reading it, so it is one
 * line here.
 */
func joinTextRuns(_ runs: [(rect: CGRect, text: String)]) -> [(
  rect: CGRect, text: String, anchor: CGPoint
)] {
  /* Band the rows FIRST, then sort inside a band. Comparing "close enough in y"
     pairwise is not a valid ordering — a < b and b < c without a < c — and Swift
     is entitled to return anything at all for one. */
  func band(_ r: CGRect) -> Int { Int((r.minY / 6).rounded(.down)) }
  let sorted = runs.sorted {
    band($0.rect) == band($1.rect) ? $0.rect.minX < $1.rect.minX : band($0.rect) < band($1.rect)
  }
  var out: [(rect: CGRect, text: String, anchor: CGPoint)] = []
  for run in sorted {
    if var last = out.last, band(last.rect) == band(run.rect),
      run.rect.minX >= last.rect.minX, run.rect.minX - last.rect.maxX <= 40,
      last.text.count + run.text.count < TEXT_ITEM_MAX * 3
    {
      last.text += (last.text.hasSuffix(" ") || run.text.hasPrefix(" ") ? "" : " ") + run.text
      last.rect = last.rect.union(run.rect)
      out[out.count - 1] = last
      continue
    }
    /* The anchor is the FIRST run's centre, not the joined line's. MEASURED: the
       joined line "Buy from $3199 or $133.29 per month for 24 months Footnote †"
       centres on "$133.29", which is not the link — clicking it does nothing.
       A line's clickable part is almost always where it starts. */
    out.append((rect: run.rect, text: run.text, anchor: CGPoint(x: run.rect.midX, y: run.rect.midY)))
  }
  return out
}

/// A line of text the app is showing, and where it is — the WHERE is what makes
/// it actionable. Reading "Buy from $3199" off a page and having no way to click
/// it is half a capability.
struct ReadLine {
  let text: String
  let x: Int
  let y: Int
}

func dedupeReadText(
  _ text: [(rect: CGRect, text: String)], against controls: [SnapEl], find needle: String = "",
  viewport: CGRect? = nil
) -> [ReadLine] {
  // Spelled out rather than inlined: the one-line version defeats the Swift
  // type checker (SnapEl's Ints and CGFloat in one CGRect literal).
  let frames: [CGRect] = controls.map { (c: SnapEl) -> CGRect in
    let w = CGFloat(c.w)
    let h = CGFloat(c.h)
    let x = CGFloat(c.x) - w / 2
    let y = CGFloat(c.y) - h / 2
    return CGRect(x: x, y: y, width: w, height: h)
  }
  let labels = Set(controls.map { $0.name.lowercased() }.filter { !$0.isEmpty })
  var seen = Set<String>()
  var out: [ReadLine] = []
  var chars = 0
  /*
   * `find` HAS TO SEARCH THE WORDS, not just the controls.
   *
   * MEASURED in a run: the model read "Storage. How much space do you need?" off
   * the page, asked `mac snapshot find:"2TB"`, and got nothing — because find
   * filtered the indexed control list, and a storage option that Chrome exposes
   * only as text is not in it. It had done exactly the right thing and the tool
   * told it the page did not contain the word.
   *
   * Filtering happens BEFORE the character cap, so a match far down a long page
   * is reachable — which is the whole point of asking for one.
   */
  let wanted = needle.trimmingCharacters(in: .whitespaces).lowercased()
  for item in joinTextRuns(text) {
    if !wanted.isEmpty, !item.text.lowercased().contains(wanted) { continue }
    /* A whole web page of text is worth having, an entire legal appendix is
       not. Document order means the cap keeps the top of the page, which is
       what the person is looking at; `find` reaches the rest. */
    if out.count >= TEXT_MAX_ITEMS || chars >= TEXT_TOTAL_MAX { break }
    let key = item.text.lowercased()
    if key.isEmpty || seen.contains(key) { continue }
    /*
     * A CONTROL'S OWN LABEL MEANS THE SAME WORDS, not merely the same corner of
     * the screen. Containment alone dropped an entire web page: one page-sized
     * AXGroup is listed as a control, and every line of text is inside it, so
     * all 62 lines of an Apple product page were discarded as "already listed"
     * when nothing listed them at all.
     */
    if labels.contains(key), frames.contains(where: { $0.insetBy(dx: -1, dy: -1).contains(item.rect) })
    { continue }
    seen.insert(key)
    chars += item.text.count
    /*
     * A POINT THAT IS A LIE IS WORSE THAN NO POINT.
     *
     * Chrome does not report off-screen text as off-screen: it CLAMPS it to the
     * window's bottom edge. MEASURED on an 867pt window, every line below the
     * fold comes back at y=901 — so "How much space do you need?", which is a
     * scroll away, sits at the same coordinate as everything else down there,
     * and clicking it presses whatever really is at the bottom of the window.
     *
     * The words are still worth having (they are what the page says, and `find`
     * is how you learn the page HAS a storage section). The coordinate is not,
     * so it does not get one, and the formatter prints the line without a point.
     */
    let onScreen =
      viewport.map { v in
        item.anchor.y > v.minY + 1 && item.anchor.y < v.maxY - 1 && item.anchor.x > v.minX - 1
          && item.anchor.x < v.maxX + 1
      } ?? true
    out.append(
      ReadLine(
        text: item.text,
        x: onScreen ? Int(item.anchor.x.rounded()) : -1,
        y: onScreen ? Int(item.anchor.y.rounded()) : -1))
  }
  return out
}

/// Frame of an AX window element in global screen points, or nil when the
/// element has no position/size (an app element with no window yet).
func windowFrame(_ el: AXUIElement) -> CGRect? {
  guard let pos = axPoint(el, kAXPositionAttribute), let size = axSize(el, kAXSizeAttribute),
    size.width > 1, size.height > 1
  else { return nil }
  return CGRect(origin: pos, size: size)
}

/// Live window-geometry probe for one target: frame + windowId + whether the
/// app is frontmost. This is what the app's overlay polls to TRACK the
/// controlled window (moves/resizes) and what the no-focus-steal probe asserts
/// on. Returns nil when the target has no resolvable window (not running / no
/// window yet — the launch poller treats that as "keep waiting").
func windowBoundsInfo(target: SnapshotTarget) -> [String: Any]? {
  guard let resolved = resolveTargetPid(target) else { return nil }
  let app = AXUIElementCreateApplication(resolved.pid)
  // The overlay has to cover EVERY surface the app is presenting, not just its
  // window: when a save sheet or a file panel is up, that is where the model is
  // clicking, and a phantom cursor that stops at the window edge would be
  // pointing at nothing. So x/y/w/h is the UNION, while `active` reports the
  // surface an act would actually land in.
  let surfaces = appWindows(pid: resolved.pid)
  let active = activeSurface(surfaces)
  let root = active?.element ?? rootFor(app: app)
  let ownFrame = active?.frame ?? windowFrame(root)
  guard let frame = unionFrame(surfaces) ?? ownFrame else { return nil }
  var d: [String: Any] = [
    "ok": true,
    "app": resolved.name,
    "pid": Int(resolved.pid),
    "x": Int(frame.origin.x.rounded()),
    "y": Int(frame.origin.y.rounded()),
    "w": Int(frame.width.rounded()),
    "h": Int(frame.height.rounded()),
    "frontmost": frontmostApplicationNow()?.processIdentifier == resolved.pid,
    "windowTitle": active?.title ?? (axString(root, kAXTitleAttribute) ?? ""),
    "surfaces": surfaces.count,
  ]
  if let a = active {
    d["active"] = windowDict(a)
    if a.isModal { d["dialog"] = windowDict(a) }
  }
  if let wid = active?.windowId ?? axWindowID(root) {
    d["windowId"] = Int(wid)
    // Z-order truth for the overlay's app-scoping (one cheap window-server
    // read): is the window on the CURRENT space, and how much of it is covered
    // by OTHER apps' windows above it? The overlay hides while occluded — the
    // phantom must never paint on top of whatever covers the controlled app.
    // Surfaces the app itself presents (its own sheets, its own file panel —
    // even when that panel is hosted by another process) must NOT count as
    // occluders, or the overlay would hide exactly when a dialog opens.
    let ownPids = Set(surfaces.map { $0.hostPid })
    let z = zOrderInfo(windowId: wid, pid: resolved.pid, fallbackFrame: frame)
    /*
     * A surface of the app's hosted by ANOTHER process (a sandboxed Open/Save
     * panel) is the app's own, not an occluder. It used to be recognised by
     * its ORIGIN falling inside one of the app's windows — and so was every
     * other app's window whose top-left corner happened to be over ours.
     * MEASURED (2026-09-13): Bobble at 36,33 over Safari at 0,33 → reported
     * covered 0, occluders [] — the whole Node-side visibility fallback fed a
     * lie. A hosted panel is the same WINDOW as one of the surfaces, so match
     * frames (to the point), not corners.
     */
    let foreign = z.occluders.filter { r in
      !surfaces.contains { sfc in
        abs(sfc.frame.minX - r.minX) <= 2 && abs(sfc.frame.minY - r.minY) <= 2
          && abs(sfc.frame.width - r.width) <= 2 && abs(sfc.frame.height - r.height) <= 2
      }
    }
    let covered = ownFrame.map { own -> Double in
      let area = own.width * own.height
      guard area > 0 else { return 0 }
      let hit = foreign.map { $0.intersection(own) }.filter { !$0.isEmpty }
      return min(1, max(0, Double(unionArea(hit) / area)))
    } ?? z.coveredFraction
    d["onScreen"] = z.onScreen || !surfaces.isEmpty
    d["occluded"] = covered >= OCCLUSION_FRACTION
    d["covered"] = (covered * 100).rounded() / 100
    /*
     * THE OCCLUDERS THEMSELVES, not just how much they add up to.
     *
     * Whole-window coverage answers "is this app buried", which is the wrong
     * question for a phantom cursor: the overlay floats ABOVE everything, so a
     * cursor sitting on an uncovered part of a background window still paints on
     * top of whatever window happens to be between them. the user, watching a run:
     * "the fake cursor is an always on top invisible window, so i'm seeing the
     * fake cursor even when maps correctly open in the background."
     *
     * With the rects in hand the overlay can ask the precise question instead —
     * is anything on top of the exact point I am about to draw on.
     */
    /* Capped, because this rides every bounds sample: a desktop with fifty
       windows would otherwise send fifty rects several times a second, and the
       phantom only needs the ones that could be over it. */
    d["occluders"] = foreign.prefix(OCCLUDER_REPORT_CAP).map(rectDict)
    d["hostPids"] = ownPids.map { Int($0) }.sorted()
  }
  return d
}

/// Find the scroll area to target for a scroll at `pt`: the DEEPEST
/// AXScrollArea whose frame contains the point (DFS visits descendants after
/// ancestors, so the last hit is the innermost), else the largest scroll area
/// in the window. Nil when the window exposes none (AX-opaque surface).
func findScrollArea(in root: AXUIElement, containing pt: CGPoint) -> AXUIElement? {
  var bestContaining: AXUIElement?
  var largest: AXUIElement?
  var largestArea: CGFloat = 0
  var stack: [AXUIElement] = [root]
  var visited = 0
  while let el = stack.popLast() {
    visited += 1
    if visited > 1500 { break }
    if (axString(el, kAXRoleAttribute) ?? "") == "AXScrollArea",
      let pos = axPoint(el, kAXPositionAttribute), let size = axSize(el, kAXSizeAttribute)
    {
      let rect = CGRect(origin: pos, size: size)
      if rect.contains(pt) { bestContaining = el }
      let area = rect.width * rect.height
      if area > largestArea {
        largestArea = area
        largest = el
      }
    }
    for kid in axChildren(el) { stack.append(kid) }
  }
  return bestContaining ?? largest
}

/// The scroll area's scroll bar for the given axis, when it exposes one.
func scrollBarOf(_ scrollArea: AXUIElement, horizontal: Bool) -> AXUIElement? {
  let attr = horizontal ? kAXHorizontalScrollBarAttribute : kAXVerticalScrollBarAttribute
  guard let ref = axCopy(scrollArea, attr) else { return nil }
  return (ref as! AXUIElement)  // swiftlint:disable:this force_cast
}

/// A scroll bar's normalized 0…1 value — the scroll ladder's VERIFICATION
/// signal ("did content actually move?") and its last-resort actuator.
func scrollBarValue(_ bar: AXUIElement) -> Double? {
  guard let ref = axCopy(bar, kAXValueAttribute) else { return nil }
  return (ref as? NSNumber)?.doubleValue
}

/// Set a scroll bar's normalized value directly (background, focus-free) —
/// the ladder's final rung when no synthetic wheel event moves the content.
func setScrollBarValue(_ bar: AXUIElement, _ value: Double) -> Bool {
  let clamped = min(1.0, max(0.0, value))
  return AXUIElementSetAttributeValue(
    bar, kAXValueAttribute as CFString, NSNumber(value: clamped) as CFTypeRef) == .success
}

/// Move the target's window to a new top-left position (AX position write).
/// Powers the `moveWindow` serve method — the deterministic "drag" the live
/// probes use to measure overlay tracking latency.
func moveWindowTo(target: SnapshotTarget, x: Double, y: Double) -> Bool {
  guard let resolved = resolveTargetPid(target) else { return false }
  let app = AXUIElementCreateApplication(resolved.pid)
  let root = rootFor(app: app)
  var pt = CGPoint(x: x, y: y)
  guard let value = AXValueCreate(.cgPoint, &pt) else { return false }
  return AXUIElementSetAttributeValue(root, kAXPositionAttribute as CFString, value) == .success
}

/// Serialize a snapshot element (minus the live AXUIElement) for the wire.
func elementDict(_ el: SnapEl) -> [String: Any] {
  var d: [String: Any] = [
    "index": el.index,
    "role": el.role,
    "name": el.name,
    "bbox": ["x": el.x, "y": el.y, "w": el.w, "h": el.h],
    "enabled": el.enabled,
  ]
  if el.editable { d["editable"] = true }
  if el.focused { d["focused"] = true }
  if !el.value.isEmpty { d["value"] = el.value }
  if !el.actions.isEmpty { d["actions"] = el.actions }
  if !el.surface.isEmpty { d["surface"] = el.surface }
  if el.isDefault { d["isDefault"] = true }
  if let w = el.win { d["win"] = Int(w) }
  return d
}

/// The summary block. `matched`/`offset`/`find` only ride along when a `find`
/// or `from` was actually asked for, so an ordinary snapshot's wire shape (and
/// the text rendered from it) is byte-for-byte what it always was.
private func summaryDict(_ snap: SnapshotResult) -> [String: Any] {
  var d: [String: Any] = [
    "app": snap.appName,
    "window": snap.windowTitle,
    "elementCount": snap.total,
    "truncated": snap.truncated,
  ]
  if !snap.find.isEmpty {
    d["find"] = snap.find
    d["matched"] = snap.matched
  }
  if snap.offset > 0 { d["offset"] = snap.offset }
  return d
}

func snapshotResultDict(_ snap: SnapshotResult, screenshot: [String: Any]?) -> [String: Any] {
  var result: [String: Any] = [
    "app": snap.appName,
    "pid": Int(snap.pid),
    "window": snap.windowTitle,
    "elements": snap.elements.map(elementDict),
    "summary": summaryDict(snap),
  ]
  if let wid = snap.windowId { result["windowId"] = Int(wid) }
  if let wb = snap.windowBounds {
    result["windowBounds"] = [
      "x": Int(wb.origin.x.rounded()), "y": Int(wb.origin.y.rounded()),
      "w": Int(wb.width.rounded()), "h": Int(wb.height.rounded()),
    ]
  }
  if !snap.windows.isEmpty {
    result["windows"] = snap.windows.map(windowDict)
    if let u = unionFrame(snap.windows) { result["union"] = rectDict(u) }
  }
  if let d = snap.dialog {
    result["dialog"] = windowDict(d)
  }
  if !snap.text.isEmpty {
    result["text"] = snap.text.map { ["text": $0.text, "x": $0.x, "y": $0.y] }
  }
  // The menu bar is a third of a real app's capability and appears in no
  // window, so the top-level titles ride along with every snapshot. Titles
  // only — a whole menu bar is hundreds of entries; naming one lists it. The
  // system (Apple) menu is not the app's and is not offered.
  let menus = listableMenuTitles(pid: snap.pid)
  if !menus.isEmpty { result["menus"] = menus }
  if let shot = screenshot { result["screenshot"] = shot }
  return result
}

// ── browser tabs ─────────────────────────────────────────────────────────────

/**
 * THE TAB STRIP IS IN THE TREE, and nothing else can reach it.
 *
 * the user: "for chrome, we need tab handling so it can read open tabs, switch tab,
 * make new tab and close tab — the dom wouldn't let it drive that, or for
 * example profiles, settings, top bar. So we should possibly have some
 * dedicated chrome tools."
 *
 * He is right that the DOM cannot: a page's JavaScript sees its own document
 * and nothing about the window around it. But this needs no Apple Events and no
 * Chrome-specific anything either — Chrome publishes its tab strip as an
 * ordinary AXTabGroup whose children are one AXRadioButton per tab (AXValue
 * "true" on the active one) each followed by its Close button, with a New Tab
 * button at the end. Safari and other Chromium browsers are the same shape, so
 * this is written against the SHAPE rather than against Chrome.
 */
struct BrowserTab {
  let index: Int
  let title: String
  let url: String
  let active: Bool
  let element: AXUIElement
  let close: AXUIElement?
}

/**
 * BREADTH-first, deliberately.
 *
 * Depth-first spends its whole budget inside the page — a Chrome window is two
 * thousand nodes of web content and about forty of browser — so the first
 * attempt reported "not showing a tab strip" for a window with two tabs open in
 * it. The strip is three or four levels from the window root; the page is
 * twenty. Breadth-first reaches it in dozens of nodes instead of thousands.
 */
private func findByRole(_ root: AXUIElement, _ want: (AXUIElement, String) -> Bool) -> AXUIElement?
{
  var queue: [AXUIElement] = [root]
  var seen = 0
  var head = 0
  while head < queue.count, seen < 900 {
    let el = queue[head]
    head += 1
    seen += 1
    let role = axString(el, kAXRoleAttribute) ?? ""
    if want(el, role) { return el }
    /* Never descend into the page itself: it cannot contain browser furniture
       and it is where all the nodes are. */
    if role == "AXWebArea" { continue }
    queue.append(contentsOf: axChildren(el))
  }
  return nil
}

private func findTabGroup(_ root: AXUIElement) -> AXUIElement? {
  findByRole(root) { _, role in role == "AXTabGroup" }
}

/// The New Tab button, which lives beside the strip rather than inside it.
/**
 * The New Tab button is the tab strip's NEXT SIBLING.
 *
 * Searching for it by name does not work: MEASURED, Chrome gives that button an
 * empty AXTitle and an empty AXDescription — a full snapshot only calls it "New
 * Tab" because it falls back to attributes the search did not read. Its
 * POSITION, though, is not ambiguous: it is the button immediately after the
 * AXTabGroup in the same parent, exactly where it is on screen.
 *
 * This matters more than tidiness. The alternative was ⌘T, and MEASURED, Chrome
 * brings itself to the front when it handles that — and a background process
 * cannot put the user back (NSRunningApplication.activate() and AXFrontmost
 * both return success and do nothing). So a keystroke here costs the user their
 * screen permanently; pressing the button costs nothing.
 */
private func findNewTabButton(_ root: AXUIElement) -> AXUIElement? {
  guard let group = findTabGroup(root),
    let parentRef = axCopy(group, kAXParentAttribute)
  else { return nil }
  let parent = unsafeBitCast(parentRef, to: AXUIElement.self)
  let siblings = axChildren(parent)
  guard let at = siblings.firstIndex(where: { CFEqual($0, group) }) else { return nil }
  for sib in siblings[(at + 1)...] where axString(sib, kAXRoleAttribute) == "AXButton" {
    return sib
  }
  return nil
}

/// The window's address bar, which is where the ACTIVE tab's URL actually is —
/// Chrome does not populate AXURL on the tab elements themselves.
private func addressBarURL(_ root: AXUIElement) -> String? {
  let field = findByRole(root) { el, role in
    guard role == "AXTextField" else { return false }
    let name = (axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute) ?? "")
    return name.lowercased().contains("address")
  }
  return field.flatMap { axValueText($0, kAXValueAttribute) }
}

func browserTabs(pid: pid_t) -> [BrowserTab] {
  let root = rootFor(app: AXUIElementCreateApplication(pid))
  guard let group = findTabGroup(root) else { return [] }
  let barURL = addressBarURL(root)
  var out: [BrowserTab] = []
  var pendingTitle = ""
  var pendingURL = ""
  var pendingActive = false
  var pendingEl: AXUIElement?
  func flush(close: AXUIElement?) {
    guard let el = pendingEl else { return }
    out.append(
      BrowserTab(
        index: out.count + 1, title: pendingTitle, url: pendingURL, active: pendingActive,
        element: el, close: close))
    pendingEl = nil
  }
  for kid in axChildren(group) {
    let role = axString(kid, kAXRoleAttribute) ?? ""
    if role == "AXRadioButton" {
      flush(close: nil)
      /*
       * MEASURED on Chrome 141: a tab's page title is its AXDescription, and its
       * AXTitle is present but EMPTY — so `title ?? description` never reached
       * the description and every tab came back nameless. And the selected flag
       * is AXValue "1"/"0", not "true"/"false". Both of those are the kind of
       * thing you only learn by printing the attributes.
       */
      let title = axString(kid, kAXTitleAttribute) ?? ""
      let raw = title.isEmpty ? (axString(kid, kAXDescriptionAttribute) ?? "") : title
      /* Chrome appends its own tooltip to the tab's description — "Shop iPhone
         Duo - Apple - Memory usage - 191 MB". The memory reading is Chrome
         talking about itself, not the page. */
      pendingTitle = raw.replacingOccurrences(
        of: " - Memory usage - [^-]*$", with: "", options: .regularExpression)
      /* AXURL is an NSURL, and AXValue a number — `axString` is `as? String`
         and nil for both, which is why the first pass had no URLs and no
         active tab. axValueText handles the number; the URL needs its own. */
      /* Chrome populates neither AXURL on the tab nor, reliably, a readable
         address-bar value from here — both came back empty every time. The
         title is what a tab strip actually knows, and the URL of the tab you
         are ON is one ordinary snapshot away, so this does not pretend. */
      pendingURL = axURLText(kid, "AXURL") ?? (barURL ?? "")
      let v = (axValueText(kid, kAXValueAttribute) ?? "").lowercased()
      pendingActive = v == "1" || v == "true"
      pendingEl = kid
    } else if role == "AXButton", pendingEl != nil {
      let name = (axString(kid, kAXTitleAttribute) ?? axString(kid, kAXDescriptionAttribute) ?? "")
      if name.lowercased().contains("close") { flush(close: kid) }
    }
  }
  flush(close: nil)
  return out
}

/// Press an element the way a person would, without moving the pointer or
/// taking focus — the same AXPress the indexed click uses.
@discardableResult
func pressElement(_ el: AXUIElement) -> Bool {
  AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
}

/// New tab: the window's own button when it publishes one, else ⌘T posted to
/// the app. MEASURED: Chrome lists a "New Tab" AXButton in a full snapshot but
/// it is not reachable from the window root by a bounded breadth-first walk, so
/// the keystroke is not a fallback for exotic browsers — it is the normal path.
func newBrowserTab(pid: pid_t) -> Bool {
  let root = rootFor(app: AXUIElementCreateApplication(pid))
  if let button = findNewTabButton(root), pressElement(button) { return true }
  postKeyToPid(pid, flags: .maskCommand, key: 17)  // t
  usleep(220_000)
  return true
}
