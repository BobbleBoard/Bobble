import AppKit
import CoreGraphics
import Foundation
import ImageIO
import QuartzCore
import UniformTypeIdentifiers

// ── the phantom cursor overlay, natively ─────────────────────────────────────
//
// `pi-mac --overlay` is the ONLY thing the user perceives while a model drives
// a Mac app in the background: a phantom pointer and a status pill painted over
// whatever the model is touching. It used to be an Electron BrowserWindow, and
// two field reports killed that design outright:
//
//   1. "mission control still shows blank window" — an Electron window is a
//      first-class, MANAGED window, so Mission Control/Exposé laid the overlay
//      out as a tile of its own, right next to the app it was supposed to be
//      painted ON. The two visibly came apart. The cure is
//      NSWindowCollectionBehavior.transient, which Electron does not expose.
//   2. "the window is sized directly to the app window size and thus causing
//      cut off if the mouse cursor goes even a little bit off the screen to the
//      right especially" — the old window was the tracked app's frame plus a
//      56pt margin, so a cursor placed past that margin was clipped by the
//      window itself.
//
// So the overlay is now ONE NSPanel sized to the UNION OF EVERY SCREEN, drawn
// with CALayers, that NEVER MOVES. Both problems dissolve rather than being
// worked around: nothing can be clipped because the canvas is the whole desktop,
// and there is no reposition-on-drag path at all because we draw in screen
// coordinates. It is `.transient` (Mission Control ignores it entirely),
// `.nonactivatingPanel` + `ignoresMouseEvents` (it can never take a click or the
// key window), and `.floating` level.
//
// COST OF THE SCREEN-SIZED CANVAS: the panel carries a full-desktop backing
// store — on this M5 Pro's single 1512×982pt Retina display that is
// 1512×982×4bytes×(2×2 backing) ≈ 23.7 MB, and it grows with each attached
// display. That is the price of never clipping; it is paid once, stays constant
// (the panel never resizes except on a display change), and the layer tree
// above it is a dozen shapes, so the per-frame cost while a model drives is
// what matters and that is nil.
//
// The process talks the same NDJSON dialect as `--serve` ({id, method, params}
// in, {id, ok, result|error} out) so the Node side reuses MacHelperClient
// verbatim. Unlike `--serve` it needs a live runloop for CoreAnimation, so
// stdin is pumped on a background thread that hands each command to the main
// queue synchronously — which also keeps responses in request order.

// ── the pointer glyph ────────────────────────────────────────────────────────
//
// the user, on the old frosted send-dart: "downsize and extra extra smooth and round
// the fake cursor … it's tiny and it has a noticable glow around it. we don't
// need such glow I don't think, but sizing down and making ours cleaner and more
// rounded without such protruding 'fins'".
//
// THE GLYPH IS THE USER'S ARTWORK NOW, not a polygon we tuned. He sent the SVG —
// a single path, a blue body (#78BFE5) under a white keyline, with a teal glow
// behind it — so the shape lives in pointerGlyph() as his own curves and these
// constants only say how big it is drawn and how it is painted.
/// Body fill and keyline, straight off his SVG.
private let GLYPH_BODY = cgColor(0x78 / 255.0, 0xBF / 255.0, 0xE5 / 255.0, 1)
private let GLYPH_KEYLINE = cgColor(1, 1, 1, 1)
/// The glow colour behind it (#95F9E5), at his two opacities.
private let GLYPH_GLOW = cgColor(0x95 / 255.0, 0xF9 / 255.0, 0xE5 / 255.0, 1)
/// His stroke width, in the 291-wide viewBox the path is written in — so it
/// scales WITH the glyph rather than going fat as the cursor shrinks.
private let GLYPH_STROKE_W: CGFloat = 13.79
/// How tall the drawn cursor is, in points. the user, after seeing it on screen:
/// "size cursor up maybe 15%" — 22.0 x 1.15.
private let OVERLAY_GLYPH_HEIGHT: CGFloat = 25.3

/// Travel time for a cursor glide, mirrored by CURSOR_TRAVEL_MS on the Node
/// side so a tool act can wait the animation out before it fires.
private let DEFAULT_TRAVEL_MS: Double = 300

/// Reduce Motion (System Settings › Accessibility › Display). The CSS overlay
/// honoured prefers-reduced-motion, so the native one honours the same
/// preference behind it: the cursor teleports instead of gliding and the
/// looping "still alive" animations (the pill's breathing, the dot wave) stay
/// still. Read live — the user can flip it mid-run.
private func reduceMotion() -> Bool {
  NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
}

// ── geometry helpers ─────────────────────────────────────────────────────────

/// Every incoming point is a GLOBAL macOS SCREEN POINT with a top-left origin —
/// the space AX positions, CGEvent posts and CGWindowList bounds all share.
/// Cocoa's global space has its origin at the bottom-left of the PRIMARY screen
/// (the one whose frame origin is (0,0)), so the flip base is that screen's top
/// edge. Computed per call: a display change moves it.
private func cocoaFlipBase() -> CGFloat {
  NSScreen.screens.first?.frame.maxY ?? 0
}

/// The union of every attached screen, in Cocoa global coordinates — the panel's
/// frame, and the reason nothing can ever be clipped.
private func screensUnionFrame() -> CGRect {
  let screens = NSScreen.screens
  guard var union = screens.first?.frame else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
  for s in screens.dropFirst() { union = union.union(s.frame) }
  return union
}

/// A Cocoa rect as the top-left-origin screen rect the Node side speaks.
private func axRect(_ r: CGRect, flipBase: CGFloat) -> [String: Any] {
  [
    "x": Double(r.minX), "y": Double(flipBase - r.maxY),
    "w": Double(r.width), "h": Double(r.height),
  ]
}

private func doubleValue(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let n = v as? NSNumber { return n.doubleValue }
  if let s = v as? String { return Double(s) }
  return nil
}

private func boolValue(_ v: Any?) -> Bool? {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.boolValue }
  if let s = v as? String { return s == "true" || s == "1" }
  return nil
}

private func cgColor(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> CGColor {
  CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

/// A closed outline through `pts` with every corner rounded by the matching
/// radius. Works for reflex corners too (the curve simply bulges the other way),
/// which is what draws the pointer's concave waist. Each radius is clamped to
/// half its shorter adjacent edge so neighbouring corners can never overrun each
/// other on a small glyph.
private func smoothPolygonPath(_ pts: [CGPoint], radii: [CGFloat], k: CGFloat) -> CGPath {
  let n = pts.count
  guard n >= 3, radii.count == n else { return CGMutablePath() }
  var entry: [CGPoint] = []  // tangent point on the incoming edge
  var exit: [CGPoint] = []  // tangent point on the outgoing edge
  for i in 0..<n {
    let prev = pts[(i + n - 1) % n]
    let cur = pts[i]
    let next = pts[(i + 1) % n]
    let dIn = hypot(prev.x - cur.x, prev.y - cur.y)
    let dOut = hypot(next.x - cur.x, next.y - cur.y)
    let r = min(radii[i], dIn * 0.5, dOut * 0.5)
    entry.append(
      CGPoint(x: cur.x + (prev.x - cur.x) / max(dIn, 0.0001) * r,
              y: cur.y + (prev.y - cur.y) / max(dIn, 0.0001) * r))
    exit.append(
      CGPoint(x: cur.x + (next.x - cur.x) / max(dOut, 0.0001) * r,
              y: cur.y + (next.y - cur.y) / max(dOut, 0.0001) * r))
  }
  let path = CGMutablePath()
  path.move(to: exit[0])
  for i in 0..<n {
    let j = (i + 1) % n
    path.addLine(to: entry[j])
    let v = pts[j]
    path.addCurve(
      to: exit[j],
      control1: CGPoint(
        x: entry[j].x + (v.x - entry[j].x) * k, y: entry[j].y + (v.y - entry[j].y) * k),
      control2: CGPoint(x: exit[j].x + (v.x - exit[j].x) * k, y: exit[j].y + (v.y - exit[j].y) * k))
  }
  path.closeSubpath()
  return path
}

/// The pointer outline in LAYER space (y up), scaled, with the tip at the top.
/// Returned alongside the box it lives in and the tip's position inside that
/// box, so the cursor layer can anchor exactly on the hotspot.
private func pointerGlyph() -> (path: CGPath, box: CGSize, tip: CGPoint, strokeWidth: CGFloat) {
  /*
   * THE USER'S CURSOR, traced exactly.
   *
   * He sent the SVG; this is its single path with the elliptical arcs converted
   * to cubics (W3C F.6 endpoint parameterisation), in the artwork's own y-down
   * viewBox coordinates. Keeping his numbers rather than re-drawing something
   * "equivalent" means the shape on screen is the shape he approved, and a
   * future tweak is a re-run of the same conversion.
   *
   * The keyline is his too — a white 13.79 stroke in a 291-wide viewBox — so it
   * scales with the glyph instead of being a fixed hairline that goes fat as the
   * cursor shrinks.
   */
  let art = CGMutablePath()
  do {
    let p = art
    p.move(to: CGPoint(x: 58.480, y: 87.060))
    p.addCurve(to: CGPoint(x: 67.563, y: 62.329), control1: CGPoint(x: 56.394, y: 77.528), control2: CGPoint(x: 59.944, y: 67.863))
    p.addCurve(to: CGPoint(x: 93.890, y: 61.340), control1: CGPoint(x: 75.182, y: 56.795), control2: CGPoint(x: 85.470, y: 56.409))
    p.addLine(to: CGPoint(x: 223.670, y: 137.270))
    p.addCurve(to: CGPoint(x: 233.247, y: 156.770), control1: CGPoint(x: 230.500, y: 141.260), control2: CGPoint(x: 234.323, y: 149.043))
    p.addCurve(to: CGPoint(x: 218.850, y: 171.890), control1: CGPoint(x: 232.171, y: 164.498), control2: CGPoint(x: 226.425, y: 170.533))
    p.addCurve(to: CGPoint(x: 131.290, y: 247.950), control1: CGPoint(x: 177.831, y: 179.267), control2: CGPoint(x: 144.559, y: 208.170))
    p.addCurve(to: CGPoint(x: 111.340, y: 260.923), control1: CGPoint(x: 128.454, y: 256.445), control2: CGPoint(x: 120.294, y: 261.751))
    p.addCurve(to: CGPoint(x: 92.880, y: 244.400), control1: CGPoint(x: 102.386, y: 260.096), control2: CGPoint(x: 94.836, y: 253.337))
    p.closeSubpath()
  }

  /* The stroke straddles the outline, so the visual bounds are the path's
     bounds grown by half the line width; anything less shaves the keyline. */
  let half = GLYPH_STROKE_W / 2
  let b = art.boundingBox.insetBy(dx: -half, dy: -half)
  let scale = OVERLAY_GLYPH_HEIGHT / b.height

  /* Design space is y-down (it reads like the artwork); layer space is y-up, so
     mirror on the way into the box. */
  var t = CGAffineTransform(scaleX: scale, y: -scale)
    .concatenating(CGAffineTransform(translationX: -b.minX * scale, y: b.maxY * scale))
  let path = art.copy(using: &t) ?? art

  /*
   * THE HOT SPOT: the point of the pointer, which is the rounded corner between
   * the first arc's ends — the extreme along the up-left diagonal the glyph
   * points down. Measured off his own anchors rather than guessed: (67.56,
   * 62.33) is the apex, pulled out along the diagonal by half the keyline so the
   * tip is the tip of what is DRAWN, not of the centre line.
   */
  let apex = CGPoint(x: 67.563 - half * 0.7, y: 62.329 - half * 0.7)
  let tip = CGPoint(x: (apex.x - b.minX) * scale, y: (b.maxY - apex.y) * scale)

  return (path, CGSize(width: b.width * scale, height: b.height * scale), tip, GLYPH_STROKE_W * scale)
}

// ── the panel ────────────────────────────────────────────────────────────────

/**
 * THE ONE PART OF THE OVERLAY THAT TAKES A CLICK.
 *
 * the user: "hovering the pill should show an X on the right red circle highlight
 * on hover, a pause button to the left of it, and a hide button to the left of
 * that, blurring whatever's actually in the pill."
 *
 * The phantom panel is click-through end to end and must stay that way — it is
 * paint, and paint that eats a mouse event meant for the app underneath is a
 * bug. So the controls live on their own small panel, parked exactly over the
 * pill, which is the only surface in the overlay that is allowed to be UI.
 *
 * It is still non-activating: clicking it must not pull focus away from
 * whatever the user is doing.
 */
final class OverlayControlsPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/**
 * The three controls, drawn over a blur of whatever the pill was saying.
 *
 * Order is the user's, right to left: ✕ (red on hover), pause, hide. They appear
 * only while the pointer is over the pill, so the resting state is still just
 * a small pill with a bouncing "…".
 */
final class OverlayControlsView: NSView {
  var onStop: (() -> Void)?
  var onPause: (() -> Void)?
  var onHide: (() -> Void)?
  private var hovered: Int?
  private var tracking: NSTrackingArea?
  /// True while the pointer is inside — the pill asks, so it can blur itself.
  private(set) var isHovered = false
  var onHoverChange: ((Bool) -> Void)?

  override var isFlipped: Bool { false }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(
      rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways], owner: self)
    addTrackingArea(t)
    tracking = t
  }

  /**
   * Two round buttons at the right end, and Hide taking everything else.
   *
   * the user: "i'd like the hide button to literally just be a button taking up the
   * rest of the left space no [icon] ... just shows 'Hide' no icon and then the
   * pause button and X next to it." So Hide is not a third circle competing for
   * a glance — it is the wide, obvious, word-labelled way out, and the two
   * glyph buttons keep the corner.
   */
  private func slots() -> [NSRect] {
    let side = min(bounds.height - 6, 18)
    let gap: CGFloat = 4
    let pad: CGFloat = 5
    let y = (bounds.height - side) / 2
    let stop = NSRect(x: bounds.maxX - pad - side, y: y, width: side, height: side)
    let pause = NSRect(x: stop.minX - gap - side, y: y, width: side, height: side)
    let hide = NSRect(x: pad, y: y, width: max(0, pause.minX - gap - pad), height: side)
    return [stop, pause, hide]
  }

  private func slotAt(_ p: NSPoint) -> Int? {
    for (i, r) in slots().enumerated() where r.insetBy(dx: -3, dy: -3).contains(p) { return i }
    return nil
  }

  /// Probe seam: pretend the pointer is over the pill (optionally over one
  /// button), so the controls can be LOOKED at without moving the user's mouse.
  func previewHover(_ on: Bool, hot: Int?) {
    isHovered = on
    hovered = hot
    onHoverChange?(on)
    needsDisplay = true
  }

  override func mouseEntered(with event: NSEvent) {
    isHovered = true
    onHoverChange?(true)
    needsDisplay = true
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    hovered = nil
    onHoverChange?(false)
    needsDisplay = true
  }

  override func mouseMoved(with event: NSEvent) {
    let next = slotAt(convert(event.locationInWindow, from: nil))
    if next != hovered {
      hovered = next
      needsDisplay = true
    }
  }

  override func mouseDown(with event: NSEvent) {
    switch slotAt(convert(event.locationInWindow, from: nil)) {
    case 0: onStop?()
    case 1: onPause?()
    case 2: onHide?()
    default: break
    }
  }

  /// Only the buttons swallow a click; the rest of the pill stays click-through
  /// so the app underneath still gets the event.
  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    return slotAt(local) == nil && !bounds.contains(local) ? nil : self
  }

  override func draw(_ dirty: NSRect) {
    guard isHovered, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let rects = slots()
    drawHide(rects[2], hot: hovered == 2, ctx: ctx)
    for (i, r) in rects.enumerated() where i < 2 {
      let on = hovered == i
      // The ✕ is the destructive one, so its hover is red; the others go white.
      let bg: CGColor =
        on
        ? (i == 0
          ? CGColor(srgbRed: 0.91, green: 0.27, blue: 0.29, alpha: 1)
          : CGColor(gray: 1, alpha: 0.26))
        : CGColor(gray: 1, alpha: 0.12)
      ctx.setFillColor(bg)
      ctx.fillEllipse(in: r)

      ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.95))
      ctx.setLineWidth(1.6)
      ctx.setLineCap(.round)
      let inset = r.insetBy(dx: r.width * 0.32, dy: r.height * 0.32)
      switch i {
      case 0:  // ✕
        ctx.move(to: CGPoint(x: inset.minX, y: inset.minY))
        ctx.addLine(to: CGPoint(x: inset.maxX, y: inset.maxY))
        ctx.move(to: CGPoint(x: inset.minX, y: inset.maxY))
        ctx.addLine(to: CGPoint(x: inset.maxX, y: inset.minY))
        ctx.strokePath()
      case 1:  // pause
        let w = inset.width * 0.3
        ctx.setFillColor(CGColor(gray: 1, alpha: 0.95))
        ctx.fill(CGRect(x: inset.minX, y: inset.minY, width: w, height: inset.height))
        ctx.fill(CGRect(x: inset.maxX - w, y: inset.minY, width: w, height: inset.height))
      default:
        break
      }
    }
  }

  /// The wide left-hand button: a rounded slab with the word on it, nothing
  /// else. Skipped entirely when the pill is too narrow to hold a legible word,
  /// so a short pill degrades to the two glyph buttons rather than to a smear.
  private func drawHide(_ r: NSRect, hot: Bool, ctx: CGContext) {
    guard r.width >= 34 else { return }
    let path = CGPath(roundedRect: r, cornerWidth: r.height / 2, cornerHeight: r.height / 2,
      transform: nil)
    ctx.addPath(path)
    ctx.setFillColor(CGColor(gray: 1, alpha: hot ? 0.26 : 0.12))
    ctx.fillPath()

    let label = NSAttributedString(
      string: "Hide",
      attributes: [
        .font: NSFont.systemFont(ofSize: min(12, r.height - 5), weight: .semibold),
        .foregroundColor: NSColor(white: 1, alpha: 0.95),
      ])
    let size = label.size()
    label.draw(
      at: NSPoint(x: r.midX - size.width / 2, y: r.midY - size.height / 2))
  }
}

/*
 * WATCHING THE TARGET INSTEAD OF ASKING IT.
 *
 * the user: "why can't you pin it literally one level on top of the window you want
 * to target and pin it such that dragging the window ... mirrors the movements
 * of the target at all times and mirroring the layering so it's always one level
 * above the target."
 *
 * Half of that is not available. `addChildWindow:` — the API that makes macOS
 * move one window with another and keep it exactly one level above — only works
 * between windows of the SAME process; a window belonging to Chrome cannot be
 * given ours as a child. Ordering relative to a window we do not own needs
 * SkyLight's private CGSOrderWindow with the universal-owner privilege, which we
 * do not have. So the LAYERING has to stay a mask (see setOccluders).
 *
 * The MOVEMENT half is available, and this is it. Accessibility will push a
 * notification the instant a window moves or resizes, so the phantom can ride a
 * drag exactly rather than sampling for it every 16ms — and an app activating
 * changes the z-order, which is the "clicking on the window then off it" case
 * where a stale mask let the phantom paint over something on top of the app.
 */
private var axObserver: AXObserver?
private var axWatchedPid: pid_t = 0

private let axChanged: AXObserverCallback = { _, element, _, _ in
  /*
   * RIDE THE DRAG HERE, NOT IN NODE.
   *
   * the user, after the layering was fixed: "dragging/resizing still has a little
   * lag and cursor snappying". Same disease as the mask was: the notification
   * went to Node, Node polled the frame back over the pipe, then pushed a shift
   * — three hops behind the window, and the shift's delta was computed against
   * whatever Node last believed, so a late one moved the cursor twice and
   * yanked it back. The notification already carries the window that moved, so
   * read its frame right here and move with it in the same turn.
   *
   * MEASURED after: 44ms from asking a window to move to the phantom being at
   * the new position, of which 5ms is the probe's own round trip — about two
   * display frames. And the snap is gone outright, because there is no second,
   * later shift computed against a frame that has already moved.
   */
  var pos: CFTypeRef?
  var size: CFTypeRef?
  var p = CGPoint.zero
  var sz = CGSize.zero
  if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos) == .success,
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
    AXValueGetValue(pos as! AXValue, .cgPoint, &p),
    AXValueGetValue(size as! AXValue, .cgSize, &sz), sz.width > 1, sz.height > 1
  {
    followLiveController?(CGRect(origin: p, size: sz), axWindowID(element).map { Int($0) })
  }
  // Node still keeps its own copy of the frame; this is what tells it to.
  emitEvent("overlay-retrack")
}

/// Move the phantom with the window that just moved or resized.
var followLiveController: ((CGRect, Int?) -> Void)?

/// Re-assert the pin. Ordering is a position, not a property: anything that
/// changes the stack — an app activating, a window raising — drops us wherever
/// the window server felt like putting us, so it has to be re-applied.
var repinLiveController: (() -> Void)?

/// Start (or move) the Accessibility watch to `pid`. Idempotent per pid.
func watchWindowChanges(pid: pid_t) {
  if pid == axWatchedPid { return }
  stopWatchingWindowChanges()
  guard pid > 0 else { return }
  var obs: AXObserver?
  guard AXObserverCreate(pid, axChanged, &obs) == .success, let observer = obs else { return }
  let app = AXUIElementCreateApplication(pid)
  for name in [
    kAXWindowMovedNotification, kAXWindowResizedNotification,
    kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
  ] {
    AXObserverAddNotification(observer, app, name as CFString, nil)
  }
  CFRunLoopAddSource(
    CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
  axObserver = observer
  axWatchedPid = pid
}

func stopWatchingWindowChanges() {
  if let observer = axObserver {
    CFRunLoopRemoveSource(
      CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
  }
  axObserver = nil
  axWatchedPid = 0
}

/// A different app coming forward changes the z-order — the mask is stale the
/// moment it happens, which is the "inexplicably on top again" report.
func watchActivationChanges() {
  NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
  ) { _ in
    repinLiveController?()
    emitEvent("overlay-retrack")
  }
}

/*
 * SITTING EXACTLY ONE ABOVE THE APP, which turns out to be possible.
 *
 * the user: "there's no way it's impossible to do this overlay window stacking
 * thing, oai were able to do it so we can too." He was right and I was wrong —
 * I had reasoned that ordering relative to a window we do not own needs a
 * privilege we lack, and never measured it. MEASURED, on this Mac:
 *
 *   before:  WindowServer, Dock, [pi-mac layer 3], Steam, Claude, Maps, Chrome
 *   after:   WindowServer, Dock, Steam, Claude, [pi-mac layer 0], Maps, Chrome
 *
 * SLSOrderWindow returned 0 and the window server really did sandwich us
 * between Claude and Maps. That is the whole feature: the phantom is above the
 * app it is driving and below everything else, so it cannot paint over a window
 * the user brought forward — no mask, no all-or-nothing hide, no "inexplicably
 * on top again".
 *
 * Looked up by dlsym, because this is private: a missing or renamed symbol
 * degrades to the old floating behaviour rather than failing to launch.
 */
private let slsHandle = dlopen(
  "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)

private typealias SLSMainConnectionIDFn = @convention(c) () -> Int32
private typealias SLSOrderWindowFn = @convention(c) (Int32, Int32, Int32, Int32) -> Int32

private let slsMainConnectionID: SLSMainConnectionIDFn? = slsHandle
  .flatMap { dlsym($0, "SLSMainConnectionID") }
  .map { unsafeBitCast($0, to: SLSMainConnectionIDFn.self) }

private let slsOrderWindow: SLSOrderWindowFn? = slsHandle
  .flatMap { dlsym($0, "SLSOrderWindow") }
  .map { unsafeBitCast($0, to: SLSOrderWindowFn.self) }

private typealias SLSSetWindowLevelFn = @convention(c) (Int32, Int32, Int32) -> Int32

private let slsSetWindowLevel: SLSSetWindowLevelFn? = slsHandle
  .flatMap { dlsym($0, "SLSSetWindowLevel") }
  .map { unsafeBitCast($0, to: SLSSetWindowLevelFn.self) }

/**
 * THE TRAP THAT MADE THIS LOOK IMPOSSIBLE.
 *
 * Ordering only ever happens WITHIN a level band, so the phantom has to join
 * the app's band first. `NSWindow.level = .normal` does that — but only on the
 * next runloop turn. Ordering in the same turn is therefore a silent no-op: the
 * call returns 0, the window server moves nothing, and the panel keeps floating
 * over everything. That is the whole reason the first attempt "proved" you
 * cannot sandwich a foreign window.
 *
 * Setting the level through SkyLight instead lands immediately, so the order
 * that follows it lands too.
 */
@discardableResult
func slsSetLevel(_ ours: Int, _ level: Int) -> Bool {
  guard let cid = slsMainConnectionID?(), let set = slsSetWindowLevel, ours > 0 else { return false }
  return set(cid, Int32(ours), Int32(level)) == 0
}

/// The raw window-server answer, so a failure can be told apart from a call we
/// never made.
func slsOrderRC(_ ours: Int, _ target: Int) -> Int32 {
  guard let cid = slsMainConnectionID?(), let order = slsOrderWindow, target > 0, ours > 0 else {
    return -1
  }
  return order(cid, Int32(ours), 1, Int32(target))
}

/// True when the window server let us order relative to a foreign window.
@discardableResult
func slsOrderAbove(_ ours: Int, _ target: Int) -> Bool {
  return slsOrderRC(ours, target) == 0
}

/**
 * THE UNION OF THE HOLES, AS RECTS THAT DO NOT OVERLAP.
 *
 * the user, 2026-09-12, with a screenshot of the phantom drawn over Bobble while
 * Notes sat behind it: "can confirm visually that the bug is NOT FIXED. fake
 * cursor frequently appears on top of undesired apps." The mask was one path —
 * the whole panel plus one rect per covering window — filled EVEN-ODD. Even-odd
 * counts crossings: a point under ONE covering window is inside two rects
 * (panel + hole) → even → cut out, correct; a point under TWO covering windows
 * is inside three → odd → PAINTED. Every hole that overlapped another hole
 * flipped the cursor back on. And one hole overlaps everything: the Dock owns a
 * screen-sized window (layer 20, hollow) that is on every desktop's list, so
 * with it in the set the parity of every point was off by one — visible under
 * exactly one real window, invisible under none. That is "randomly on top".
 *
 * MEASURED on this desktop (Notes under Safari, Claude, Bobble and the Dock's
 * window): the rect arithmetic said covered, the path said visible, and the
 * shipped 61b45ee7 proof only ever asked the rects.
 *
 * So the holes are first reduced to a set of rects that cannot overlap (a
 * vertical band sweep: every x-edge starts a band, the y-intervals of the
 * rects spanning a band are merged), and only then cut. Even-odd over disjoint
 * holes is exact, whatever the window list looks like.
 */
func disjointUnion(_ rects: [CGRect]) -> [CGRect] {
  let rs = rects.filter { !$0.isNull && $0.width > 0 && $0.height > 0 }
  if rs.count <= 1 { return rs }
  var xs = Set<CGFloat>()
  for r in rs {
    xs.insert(r.minX)
    xs.insert(r.maxX)
  }
  let edges = xs.sorted()
  /* Per band, the merged y-intervals; consecutive bands with the same
     intervals are then joined, so a hole inside another hole costs nothing and
     two overlapping windows become three rects rather than a picket fence of
     seams. */
  var bands: [(x0: CGFloat, x1: CGFloat, ys: [(lo: CGFloat, hi: CGFloat)])] = []
  for i in 0..<(edges.count - 1) {
    let x0 = edges[i]
    let x1 = edges[i + 1]
    if x1 <= x0 { continue }
    var ys = rs.filter { $0.minX <= x0 && $0.maxX >= x1 }.map { (lo: $0.minY, hi: $0.maxY) }
    if ys.isEmpty { continue }
    ys.sort { $0.lo < $1.lo }
    var merged: [(lo: CGFloat, hi: CGFloat)] = []
    var cur = ys[0]
    for y in ys.dropFirst() {
      if y.lo <= cur.hi {
        cur.hi = max(cur.hi, y.hi)
      } else {
        merged.append(cur)
        cur = y
      }
    }
    merged.append(cur)
    if let last = bands.last, last.x1 == x0, last.ys.count == merged.count,
      zip(last.ys, merged).allSatisfy({ $0.lo == $1.lo && $0.hi == $1.hi })
    {
      bands[bands.count - 1].x1 = x1
    } else {
      bands.append((x0: x0, x1: x1, ys: merged))
    }
  }
  var out: [CGRect] = []
  for b in bands {
    for y in b.ys { out.append(CGRect(x: b.x0, y: y.lo, width: b.x1 - b.x0, height: y.hi - y.lo)) }
  }
  return out
}

/**
 * WHERE THE DOCK ACTUALLY IS, in AX screen points.
 *
 * The Dock's window is the size of the screen and empty except for its tiles,
 * so taking its bounds as a hole would blank the whole phantom. The tiles live
 * in the strip the screen reserves for them — the part of `frame` that is not
 * `visibleFrame` — and that strip is the hole. With the Dock auto-hidden the
 * strip is empty and a Dock sliding in is painted under the phantom for the
 * moment it is there, which is the right side to be wrong on.
 */
func dockStrips() -> [CGRect] {
  let flipBase = NSScreen.screens.first?.frame.maxY ?? 0
  var out: [CGRect] = []
  for s in NSScreen.screens {
    let f = s.frame
    let v = s.visibleFrame
    // Left / right / bottom of the screen, outside the visible area. The top is
    // the menu bar, which is a window of its own in the list.
    if v.minX > f.minX {
      out.append(CGRect(x: f.minX, y: flipBase - f.maxY, width: v.minX - f.minX, height: f.height))
    }
    if v.maxX < f.maxX {
      out.append(CGRect(x: v.maxX, y: flipBase - f.maxY, width: f.maxX - v.maxX, height: f.height))
    }
    if v.minY > f.minY {
      out.append(CGRect(x: f.minX, y: flipBase - v.minY, width: f.width, height: v.minY - f.minY))
    }
  }
  return out
}

/// A panel that can never become key or main. `.nonactivatingPanel` already
/// stops a click from activating us — but nothing is ever going to click it
/// (`ignoresMouseEvents`), and this makes the guarantee structural rather than
/// a property somebody can flip later.
final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// ── the controller ───────────────────────────────────────────────────────────

final class OverlayController: NSObject {
  private let panel: OverlayPanel
  private let root = CALayer()
  /// Everything the user sees hangs off `stage`, so the occlusion mask has ONE
  /// place to bite.
  private let stage = CALayer()
  private let cursorGroup = CALayer()
  private let glyphFill = CAShapeLayer()
  private let glyphGlowSoft = CAShapeLayer()
  private let glyphStroke = CAShapeLayer()
  /*
   * THE PILL'S LOOK, in one place because the user specified it in one breath:
   * "blue background white text grey % bar, just not a purple gradient", solid,
   * "no noticable border", and small — "really small width and just show a
   * bouncing ... by default".
   */
  private let PILL_BLUE = cgColor(0.153, 0.412, 0.937, 0.96)
  private let PILL_RADIUS: CGFloat = 13

  private let bubble = CALayer()
  private let bubbleFill = CAGradientLayer()
  private let progressTrack = CALayer()
  private let progressFill = CALayer()
  /** 0...1 while an image is being ingested; nil when nothing is prefilling. */
  private var prefillFraction: Double?
  /*
   * THE WINDOW THE PILL BELONGS TO, in AX (top-left) screen points.
   *
   * the user: "always on top isuse is not solved" — with a screenshot of the pill
   * sitting on top of a DIFFERENT app. It was parked below-right of the cursor
   * and only flipped at the edge of the SCREEN, so a cursor near the controlled
   * window's right edge threw the pill clean over whatever was beside it. The
   * phantom is allowed to say what it is doing to the app it is driving; it is
   * not allowed to write on somebody else's window.
   */
  private var windowAX: CGRect?
  /** The app window the phantom belongs to — what the mask is computed against. */
  private var trackedWindow: Int = 0
  /// The pid that owns the tracked window: its OWN windows — a popup, a sheet,
  /// a suggestion list — are never occluders (see refreshOcclusion).
  private var trackedPid: pid_t = 0
  /// Whether the number we were told is in the current desktop's z-order at
  /// all — false means it is stale and the pid is doing the anchoring.
  private var trackedNumberOnScreen = false
  /// Where in the last on-screen list the anchor sat (front-to-back), for `info`.
  private var anchorIndex: Int?
  private var occlusionTimer: Timer?
  /** False once the window server refuses — we fall back to floating + mask. */

  private let bubbleText = CATextLayer()
  private let bubbleSub = CATextLayer()
  private var bubbleDots: [CALayer] = []
  /// Probe-only solid backdrop: the panel is transparent, so a rendered PNG of
  /// a white glyph on nothing is unreadable. Painted behind `stage`.
  private let backdrop = CALayer()

  private let glyph: (path: CGPath, box: CGSize, tip: CGPoint, strokeWidth: CGFloat)
  private var cursorAX: CGPoint?
  private var bubbleStatus = ""
  /** The pill's collapsed width — dots only, no words. */
  private var collapsedWidth: CGFloat = 0
  private var bubbleTextValue = ""
  private var bubbleSubValue = ""
  private var bubbleFlipX = false
  private var bubbleFlipY = false
  private var maskHoles = 0
  /// How many non-overlapping rects the holes reduced to (see disjointUnion).
  private var maskRects = 0
  /// The holes as last cut, in AX (top-left) screen points — reported by `info`
  /// so a probe can say whether the cursor's own point is under one.
  private var lastOccluders: [CGRect] = []
  /// Press animations in flight — the observable signal a probe can assert on,
  /// now that there is no ring to count.
  private var livePress = 0
  private var displayVerified = false
  /* The controls live on their own tiny panel — see OverlayControlsPanel. */
  private var controls: OverlayControlsPanel?
  private var controlsView: OverlayControlsView?
  /** Blurs the pill's own contents while the controls are showing. */
  private let bubbleBlur = CALayer()
  var onBrake: ((String) -> Void)?

  override init() {
    glyph = pointerGlyph()
    panel = OverlayPanel(
      contentRect: screensUnionFrame(),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    super.init()
    configurePanel()
    buildLayers()
    buildControls()
    NotificationCenter.default.addObserver(
      self, selector: #selector(screensChanged),
      name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  /// The hit-testable panel that carries the pill's three buttons. Separate
  /// from the phantom because the phantom must stay click-through.
  private func buildControls() {
    let win = OverlayControlsPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    win.isOpaque = false
    win.backgroundColor = .clear
    win.hasShadow = false
    /* THE SAME LEVEL AS THE PHANTOM, or the buttons are never seen.
       `order(.above, relativeTo:)` only orders within a level band: a window at
       `.floating` (3) cannot be put above the phantom at popUpMenu + 1 (102),
       so the controls panel sat BEHIND the phantom's pill — its tracking area
       still took the hover, the pill hid its words and showed its solid body,
       and the ✕ / pause / Hide drawn underneath never reached the screen.
       the user (2026-09-13): "the pill when hovered should show hide/pause/stop
       buttons however currently it just makes it solid blue". The probe's
       render never caught it because it composites the controls view into the
       image itself. Mirrored again in syncControls, since the phantom's level
       changes in the ordering experiments. */
    win.level = panel.level
    win.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]
    win.hidesOnDeactivate = false
    win.ignoresMouseEvents = false
    win.acceptsMouseMovedEvents = true
    let view = OverlayControlsView(frame: .zero)
    view.onStop = { [weak self] in self?.onBrake?("stop") }
    view.onPause = { [weak self] in self?.onBrake?("pause") }
    view.onHide = { [weak self] in
      self?.setPillEnabled(false)
      self?.onBrake?("hide-pill")
    }
    view.onHoverChange = { [weak self] on in self?.setBubbleBlurred(on) }
    win.contentView = view
    controls = win
    controlsView = view
  }

  /// Park the controls exactly over the pill, and show them only when there IS
  /// a pill to put them on.
  private func syncControls() {
    guard let win = controls, let view = controlsView else { return }
    /* THE BUTTONS ARE A WINDOW, AND A WINDOW HAS NO MASK.
       The phantom's pill is cut out where another app covers it; its buttons
       live on this separate, hit-testable, floating panel — which stayed
       ordered in over that other app, transparent, eating its clicks, and
       drawing ✕/pause over it on hover. So the controls exist only while the
       pill is actually being shown: on this Space, and not under any hole. */
    let showing = pillEnabled && bubble.opacity > 0.4 && panel.isVisible && !offSpace && !pillCovered
    if !showing {
      if win.isVisible { win.orderOut(nil) }
      return
    }
    /* The pill's frame in Cocoa screen points — the same conversion info()
       reports it with, so the controls sit exactly on it. */
    let local = (bubble.presentation() ?? bubble).frame
    let f = local.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
    // Called on every mask tick now, so only a moved pill costs a relayout.
    if win.frame != f {
      win.setFrame(f, display: false)
      view.frame = CGRect(origin: .zero, size: f.size)
      view.needsDisplay = true
    }
    // Level first, then order: relative ordering is meaningless across bands.
    if win.level != panel.level { win.level = panel.level }
    if !win.isVisible {
      win.order(.above, relativeTo: panel.windowNumber)
    }
  }

  /// While the controls are up, whatever the pill was saying goes soft — the
  /// buttons are the subject then, not the words behind them.
  /// Re-park the controls on every frame of a pill width animation. Short-lived
  /// by design: it stops as soon as the pill stops moving.
  private func followBubbleWidth() {
    widthFollowTimer?.invalidate()
    let deadline = Date().addingTimeInterval(0.34)
    let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] timer in
      guard let self = self else { return timer.invalidate() }
      self.syncControls()
      if Date() > deadline {
        timer.invalidate()
        self.widthFollowTimer = nil
      }
    }
    RunLoop.main.add(t, forMode: .common)
    widthFollowTimer = t
  }
  private var widthFollowTimer: Timer?

  private func setBubbleBlurred(_ on: Bool) {
    if controlsHovered != on {
      controlsHovered = on
      layoutBubbleContents(dots: dotsVisible)
      layoutBubble()
      syncControls()
    }
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.16)
    /* All the way out, not merely dimmed. At 0.18 the old status was still
       legible and sat directly under the word "Hide" — two things saying
       different words in the same 50 points. The frosted panel behind the
       buttons is what keeps it from looking like a different pill. */
    bubbleText.opacity = on ? 0 : 1
    bubbleSub.opacity = on ? 0 : 1
    /* isHidden, not opacity: the dots carry a repeating opacity animation, and
       an animation OVERRIDES the model value — setting it to 0 changed nothing
       on screen, which is why the wave was still bouncing under the word. */
    for d in bubbleDots {
      d.isHidden = on || !dotsVisible
      d.opacity = on ? 0 : (dotsVisible ? 0.45 : 0)
    }
    bubbleBlur.opacity = on ? 1 : 0
    CATransaction.commit()
  }

  private func configurePanel() {
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    // Click-through, absolutely: the overlay is paint, not UI. It must never
    // eat a mouse event meant for the app underneath — which is also why the
    // pill has no ✕ brake here (see the note in overlay-controller.ts).
    panel.ignoresMouseEvents = true
    panel.acceptsMouseMovedEvents = false
    // ONE ABOVE THE POP-UP MENU LEVEL. macOS window levels are global bands,
    // not per-app, so nothing at any level can be truly z-sandwiched between
    // the controlled app and the rest of the desktop — the occluder mask (see
    // refreshOcclusion) is what scopes the cursor to the app it drives. The
    // level only decides which of the APP'S OWN surfaces the cursor can paint
    // over: at `.floating` it sat under the app's menus and pop-ups (level
    // 101), so a cursor aimed at a context-menu item disappeared behind the
    // menu it was pointing at. Every other app's window above the target, at
    // any level, is cut out by the mask — the user: the cursor is on top of the
    // controlled app only, never of what he is using while it works.
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
    // `.transient` is the whole point of going native: it is what excludes the
    // panel from Mission Control and Exposé, so the overlay stops being laid
    // out as a window of its own beside the app it is painted on. The rest:
    // ride along to every space including a fullscreen app, stay out of ⌘-tab
    // and the window cycle, and be allowed on a fullscreen app's space.
    panel.collectionBehavior = [
      .canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary,
    ]
    // NSPanel defaults hidesOnDeactivate to true; we are NEVER active, so
    // leaving it would hide the overlay permanently.
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.isMovable = false
    panel.displaysWhenScreenProfileChanges = true

    let view = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
    view.wantsLayer = true
    view.layer = root
    panel.contentView = view
  }

  private var scale: CGFloat { panel.backingScaleFactor > 0 ? panel.backingScaleFactor : 2 }

  private func buildLayers() {
    root.backgroundColor = nil
    root.masksToBounds = true
    root.contentsScale = scale

    backdrop.frame = root.bounds
    backdrop.backgroundColor = nil
    backdrop.isHidden = true
    root.addSublayer(backdrop)

    stage.frame = root.bounds
    stage.contentsScale = scale
    root.addSublayer(stage)

    // ── pointer ──
    cursorGroup.bounds = CGRect(origin: .zero, size: glyph.box)
    cursorGroup.anchorPoint = CGPoint(
      x: glyph.tip.x / glyph.box.width, y: glyph.tip.y / glyph.box.height)
    cursorGroup.contentsScale = scale
    cursorGroup.opacity = 0
    // One soft neutral shadow instead of the old three-stop blue halo — that
    // halo is the "noticable glow" the user asked us to drop. shadowPath keeps it
    // free (no offscreen rasterization of the children).
    cursorGroup.shadowPath = glyph.path
    cursorGroup.shadowColor = cgColor(0.05, 0.06, 0.13, 1)
    // Measured on rendered crops: at 0.38/2.6 the pointer all but vanished on a
    // white app — the old design leaned on its blue halo for that contrast, and
    // dropping the halo means the shadow has to carry it alone.
    cursorGroup.shadowOpacity = 0.5
    cursorGroup.shadowRadius = 3.2
    cursorGroup.shadowOffset = CGSize(width: 0, height: -1.4)

    let fillMask = CAShapeLayer()
    fillMask.path = glyph.path
    fillMask.fillColor = CGColor(gray: 0, alpha: 1)
    /*
     * HIS PAINT, NOT OURS: a solid #78BFE5 body under a white #FFFFFF keyline,
     * with the #95F9E5 glow behind. The old pearl gradient and dark hairline
     * were tuned for a glyph that no longer exists — keeping them would have
     * made his artwork a different picture.
     */
    glyphGlowSoft.frame = cursorGroup.bounds
    glyphGlowSoft.contentsScale = scale
    glyphGlowSoft.path = glyph.path
    glyphGlowSoft.fillColor = GLYPH_GLOW
    glyphGlowSoft.strokeColor = GLYPH_GLOW
    glyphGlowSoft.lineWidth = glyph.strokeWidth * 1.42
    glyphGlowSoft.lineJoin = .round
    glyphGlowSoft.opacity = 0.383
    glyphGlowSoft.shadowColor = GLYPH_GLOW
    glyphGlowSoft.shadowOpacity = 1
    glyphGlowSoft.shadowRadius = glyph.strokeWidth * 1.0
    glyphGlowSoft.shadowOffset = .zero
    cursorGroup.addSublayer(glyphGlowSoft)

    glyphFill.frame = cursorGroup.bounds
    glyphFill.contentsScale = scale
    glyphFill.path = glyph.path
    glyphFill.fillColor = GLYPH_BODY
    glyphFill.strokeColor = GLYPH_KEYLINE
    glyphFill.lineWidth = glyph.strokeWidth
    glyphFill.lineJoin = .round
    cursorGroup.addSublayer(glyphFill)

    glyphStroke.frame = cursorGroup.bounds
    glyphStroke.contentsScale = scale
    glyphStroke.path = glyph.path
    glyphStroke.fillColor = nil
    glyphStroke.strokeColor = GLYPH_KEYLINE
    glyphStroke.lineWidth = glyph.strokeWidth * 0.34
    glyphStroke.lineJoin = .round
    cursorGroup.addSublayer(glyphStroke)

    stage.addSublayer(cursorGroup)

    // ── status pill ──
    /*
     * SOLID, NOT A GRADIENT, AND NO BORDER YOU CAN SEE.
     *
     * the user, looking at it on his screen: "color should be styled, but solid
     * color no noticable border, eg. blue background white text grey % bar, just
     * not a purple gradient." It was a blue-to-purple gradient with a white
     * hairline; both are gone. The shadow stays — it is what separates the pill
     * from whatever it is floating over — but quieter and neutral, since a
     * coloured glow reads as the gradient's sibling.
     */
    bubble.contentsScale = scale
    bubble.cornerRadius = PILL_RADIUS
    bubble.masksToBounds = false
    bubble.opacity = 0
    bubble.borderWidth = 0
    bubble.shadowColor = cgColor(0, 0, 0, 1)
    bubble.shadowOpacity = 0.26
    bubble.shadowRadius = 7
    bubble.shadowOffset = CGSize(width: 0, height: 1)

    bubbleFill.contentsScale = scale
    bubbleFill.colors = [PILL_BLUE, PILL_BLUE]
    bubbleFill.startPoint = CGPoint(x: 0, y: 1)
    bubbleFill.endPoint = CGPoint(x: 1, y: 0)
    bubbleFill.cornerRadius = PILL_RADIUS
    bubbleFill.masksToBounds = true
    bubble.addSublayer(bubbleFill)

    /* The prefill bar: a grey track with a white fill, inside the pill's own
       rounded bottom. Only shown while an image is being ingested. */
    progressTrack.contentsScale = scale
    progressTrack.backgroundColor = cgColor(1, 1, 1, 0.22)
    progressTrack.cornerRadius = 1.5
    progressTrack.opacity = 0
    bubble.addSublayer(progressTrack)
    progressFill.contentsScale = scale
    progressFill.backgroundColor = cgColor(1, 1, 1, 0.92)
    progressFill.cornerRadius = 1.5
    progressFill.opacity = 0
    bubble.addSublayer(progressFill)

    for _ in 0..<3 {
      let dot = CALayer()
      dot.bounds = CGRect(x: 0, y: 0, width: 4, height: 4)
      dot.cornerRadius = 2
      dot.backgroundColor = cgColor(1, 1, 1, 1)
      dot.opacity = 0.5
      dot.contentsScale = scale
      bubbleDots.append(dot)
      bubble.addSublayer(dot)
    }

    bubbleText.contentsScale = scale
    bubbleText.font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
    bubbleText.fontSize = 12.5
    bubbleText.foregroundColor = cgColor(1, 1, 1, 1)
    bubbleText.alignmentMode = .left
    bubble.addSublayer(bubbleText)

    bubbleSub.contentsScale = scale
    bubbleSub.font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium)
    bubbleSub.fontSize = 11.5
    bubbleSub.foregroundColor = cgColor(1, 1, 1, 0.78)
    bubbleSub.alignmentMode = .left
    bubble.addSublayer(bubbleSub)

    stage.addSublayer(bubble)
  }

  @objc private func screensChanged() {
    // A display added/removed/rearranged changes the union AND the flip base,
    // so re-frame the panel and re-place whatever the cursor was on.
    let frame = screensUnionFrame()
    panel.setFrame(frame, display: false)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.frame = CGRect(origin: .zero, size: frame.size)
    stage.frame = root.bounds
    backdrop.frame = root.bounds
    CATransaction.commit()
    if let p = cursorAX { placeCursor(p, travelMs: 0) }
  }

  // ── coordinate mapping ───────────────────────────────────────────────────

  /// Top-left-origin screen point → panel-local layer point (y up). Clamped
  /// into the panel so a wild coordinate parks at the edge instead of vanishing
  /// — the panel IS the desktop, so this only ever bites on a point genuinely
  /// off every display.
  /// An AX (top-left) RECT in panel-local coordinates. Cocoa's y grows upward,
  /// so the rect's top-left corner becomes its bottom-left here.
  private func local(_ ax: CGRect) -> CGRect {
    let bottomLeft = local(CGPoint(x: ax.minX, y: ax.maxY))
    return CGRect(x: bottomLeft.x, y: bottomLeft.y, width: ax.width, height: ax.height)
  }

  private func local(_ ax: CGPoint) -> CGPoint {
    let frame = panel.frame
    let cocoaY = cocoaFlipBase() - ax.y
    let x = min(max(ax.x - frame.minX, 0), frame.width)
    let y = min(max(cocoaY - frame.minY, 0), frame.height)
    return CGPoint(x: x, y: y)
  }

  // ── commands ─────────────────────────────────────────────────────────────

  func show() {
    // Structural guarantee that the probe backdrop can never reach a real
    // screen: it is a full-desktop opaque layer, so a probe that forgot to clear
    // it before ordering the panel in would black out the user's display. Making
    // `show` clear it means no caller can get that wrong.
    setBackdrop(nil)
    if !panel.isVisible {
      // orderFrontRegardless, never makeKeyAndOrderFront: showing the overlay
      // must not touch who owns the user's focus.
      panel.orderFrontRegardless()
    }
    /* Cut the mask before the first frame is on screen, not after: showing the
       phantom over a window that is already covered, even for one frame, is the
       flash that reads as "it's on top again". */
    refreshOcclusion()
    startOcclusionTimer()
    verifyDisplayedOnce()
  }

  /// Did the window server actually take the panel? Checked ONCE, a runloop turn
  /// after the first show.
  ///
  /// We run at `.prohibited`, which is the strongest guarantee available that
  /// the overlay can never steal focus — a prohibited app cannot be activated at
  /// all, by us or by the system. Apple's own documentation says a prohibited
  /// app "may not create windows", though, and MEASURED on macOS 26 that is not
  /// what happens: the panel is ordered in and appears in
  /// CGWindowListCopyWindowInfo's on-screen list exactly like any other window.
  /// Since the documented behaviour and the real behaviour disagree, a future
  /// release could start enforcing the docs and silently leave every run with no
  /// overlay at all. So: if the window server does NOT have the panel, drop to
  /// `.accessory` (the weakest policy that is unambiguously allowed a window,
  /// and still no Dock tile, no menu bar, not in the app switcher) and order it
  /// in again. Focus is then protected structurally instead — non-activating
  /// panel, canBecomeKey/Main false, click-through, and we never call activate().
  private func verifyDisplayedOnce() {
    guard !displayVerified else { return }
    displayVerified = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      guard let self = self, self.panel.isVisible, !self.windowServerSeesPanel() else { return }
      NSApplication.shared.setActivationPolicy(.accessory)
      self.panel.orderFrontRegardless()
    }
  }

  func hide() {
    stopOcclusionTimer()
    if panel.isVisible { panel.orderOut(nil) }
    // The controls are a window of their own; a hidden phantom must not leave
    // an invisible click-eating panel behind over whatever is there.
    syncControls()
  }

  /// Put the phantom away entirely: hidden panel, no cursor, no pill. The next
  /// `cursor` fades it back in from wherever it is sent.
  func reset() {
    hide()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    setPulsing(false)
    cursorGroup.opacity = 0
    bubble.opacity = 0
    cursorAX = nil
    bubbleStatus = ""
    bubbleTextValue = ""
    bubbleSubValue = ""
    CATransaction.commit()
  }

  /// Set a layer's opacity WITHOUT CALayer's default implicit animation, so the
  /// explicit fade we add next is the only thing animating the property. Two
  /// animations on one key otherwise race, and the presentation layer ends up
  /// somewhere neither of them asked for.
  private func setModelOpacity(_ layer: CALayer, _ value: Float) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.opacity = value
    CATransaction.commit()
  }

  func placeCursor(_ ax: CGPoint, travelMs: Double) {
    cursorAX = ax
    let p = local(ax)
    let appearing = cursorGroup.opacity < 0.5
    let travelMs = reduceMotion() ? 0 : travelMs
    CATransaction.begin()
    // A first placement must not glide in from wherever the layer happened to
    // sit (usually the panel's bottom-left corner) — it teleports, then fades.
    CATransaction.setDisableActions(appearing || travelMs <= 0)
    if !appearing && travelMs > 0 {
      CATransaction.setAnimationDuration(travelMs / 1000)
      // The same spring-ish ease with a hair of overshoot the CSS overlay used:
      // the phantom GLIDES to a target, it never teleports.
      CATransaction.setAnimationTimingFunction(
        CAMediaTimingFunction(controlPoints: 0.22, 0.9, 0.32, 1.1))
    }
    cursorGroup.position = p
    CATransaction.commit()
    if appearing {
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0
      fade.toValue = 1
      fade.duration = 0.28
      setModelOpacity(cursorGroup, 1)
      cursorGroup.add(fade, forKey: "appear")
    }
    layoutBubble()
  }

  /// Follow the controlled window: shift the phantom by the same delta the
  /// window just moved, with NO travel animation. The old overlay got this for
  /// free (the window moved and carried its contents); a screen-coordinate
  /// canvas has to do it explicitly, and it is worth doing — the cursor marks a
  /// place INSIDE the app, so it must ride a window drag rather than sit at a
  /// stale absolute point.
  func shiftCursor(dx: Double, dy: Double) {
    guard let p = cursorAX else { return }
    placeCursor(CGPoint(x: p.x + dx, y: p.y + dy), travelMs: 0)
  }

  func click(at ax: CGPoint) {
    placeCursor(ax, travelMs: 0)
    pressPop()
    setStatus("clicking", text: "")
  }

  /*
   * THE CLICK IS THE CURSOR, NOT A RING AROUND IT.
   *
   * the user: "remove the circle pulsa animation and instead have a quick scale down
   * scale up for a click animation". The two expanding rings were also the last
   * purple left on this layer — stroke (0.478, 0.424, 1) — on a UI whose standing
   * rule is no purple, and they drew attention to a spot the cursor was already
   * sitting on.
   *
   * So the whole gesture is the glyph itself: down and straight back, 150ms,
   * anchored on the tip so it presses INTO the point it is clicking rather than
   * shrinking toward its own middle. No overshoot — a bounce reads as a bouncy
   * button, and what is being shown here is a press.
   */
  private func pressPop() {
    livePress += 1
    let pop = CAKeyframeAnimation(keyPath: "transform.scale")
    pop.values = [1.0, 0.78, 1.0]
    pop.keyTimes = [0, 0.45, 1]
    pop.duration = 0.15
    pop.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    // The group is anchored on the tip, so the press lands on the hotspot.
    cursorGroup.add(pop, forKey: "press")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
      self?.livePress = max(0, (self?.livePress ?? 1) - 1)
    }
  }


  // ── status pill ──────────────────────────────────────────────────────────


  /// `status` is the state name (thinking/clicking/typing/pressing/scrolling/
  /// opening/reading); `text` is the already-prettified label the Node side
  /// built (a key-combo glyph run, a typing preview, an app name).
  func setStatus(_ status: String, text: String) {
    bubbleStatus = status
    switch status {
    case "typing":
      bubbleTextValue = "Typing"
      bubbleSubValue = text
    case "pressing":
      bubbleTextValue = text.isEmpty ? "Pressing" : "Pressing \(text)"
      bubbleSubValue = ""
    case "opening":
      bubbleTextValue = text.isEmpty ? "Opening" : text
      bubbleSubValue = ""
    case "clicking":
      bubbleTextValue = "Clicking"
      bubbleSubValue = ""
    case "scrolling":
      bubbleTextValue = "Scrolling"
      bubbleSubValue = ""
    case "reading":
      bubbleTextValue = "Reading the screen"
      bubbleSubValue = ""
    default:
      bubbleTextValue = text.isEmpty ? "Thinking" : text
      bubbleSubValue = ""
    }
    /*
     * WHAT THE PILL SAYS, in the user's order:
     *
     *   default        — really small, just a bouncing "..."
     *   prefilling     — expands, a % bar and "Processing"
     *   thinking       — "Thinking..."
     *   anything else  — the tool call actually running
     *
     * so the dots are the resting state and every word has to earn the width it
     * costs. `prefillFraction` outranks the status because ingesting a picture
     * is the one thing that takes long enough to be worth explaining.
     */
    if let fraction = prefillFraction {
      bubbleTextValue = "Processing"
      bubbleSubValue = "\(Int((fraction * 100).rounded()))%"
    }
    let dots = status == "thinking" || status == "typing" || status == "scrolling"
      || status == "opening" || status == "reading" || prefillFraction != nil
    layoutBubbleContents(dots: dots)
    setPulsing(status == "thinking" && prefillFraction == nil)
    guard pillEnabled else {
      setModelOpacity(bubble, 0)
      return
    }
    if bubble.opacity < 0.5 {
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0
      fade.toValue = 1
      fade.duration = 0.22
      setModelOpacity(bubble, 1)
      bubble.add(fade, forKey: "bubble-in")
    }
    layoutBubble()
  }

  /// An image is being ingested: `fraction` 0...1, or nil when it is done. The
  /// pill expands to explain the wait and collapses again when it ends.
  /// Draw the pill at all. The cursor is unaffected — it is the part that shows
  /// WHERE something is happening, and only the pill puts words on the screen.
  /// The controlled window's frame, so the pill can stay inside it.
  /// Try to park directly above `targetWindowNumber` and report the truth.
  ///
  /// the user: "there's no way it's impossible to do this overlay window stacking
  /// thing, oai were able to do it so we can too." He is right that I asserted
  /// it rather than measured it. This measures it, one step at a time, and
  /// reports which step the window server actually honoured — the first attempt
  /// HUNG the main thread for four seconds, which is itself a finding.
  func orderRelativeTest(targetWindowNumber: Int, mode: String) -> [String: Any] {
    func zOrder() -> [[String: Any]] {
      let list =
        (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
          as? [[String: Any]]) ?? []
      return list.map {
        [
          "num": ($0[kCGWindowNumber as String] as? Int) ?? -1,
          "owner": ($0[kCGWindowOwnerName as String] as? String) ?? "?",
          "layer": ($0[kCGWindowLayer as String] as? Int) ?? -1,
        ]
      }
    }
    let ours = panel.windowNumber
    let before = zOrder()
    let idx = { (list: [[String: Any]], num: Int) -> Int in
      list.firstIndex { ($0["num"] as? Int) == num } ?? -1
    }
    var note = "none"
    switch mode {
    case "sls-owner":
      /*
       * Can we borrow the TARGET's connection to order relative to its window?
       * SLSOrderWindow's relativeTo is ignored for a window we do not own (two
       * clean samples: asking for "above Chrome", which sits at the BACK of the
       * band, lands us at the FRONT of it). SLSGetWindowOwner hands back the
       * owning connection, so this asks the window server the same question
       * with the owner's cid instead of ours.
       */
      panel.level = .normal
      _ = slsSetLevel(panel.windowNumber, 0)
      guard let handle = slsHandle, let ownerSym = dlsym(handle, "SLSGetWindowOwner"),
        let orderSym = dlsym(handle, "SLSOrderWindow"),
        let cidSym = dlsym(handle, "SLSMainConnectionID")
      else {
        note = "SLSGetWindowOwner / SLSOrderWindow not found"
        break
      }
      typealias GetOwner = @convention(c) (Int32, Int32, UnsafeMutablePointer<Int32>) -> Int32
      typealias Order = @convention(c) (Int32, Int32, Int32, Int32) -> Int32
      typealias MainCID = @convention(c) () -> Int32
      let getOwner = unsafeBitCast(ownerSym, to: GetOwner.self)
      let order = unsafeBitCast(orderSym, to: Order.self)
      let cid = unsafeBitCast(cidSym, to: MainCID.self)()
      var owner: Int32 = 0
      let orc = getOwner(cid, Int32(targetWindowNumber), &owner)
      let rc = order(owner, Int32(ours), 1, Int32(targetWindowNumber))
      note = "owner(rc \(orc)) = \(owner); SLSOrderWindow(ownerCid) returned \(rc)"
    case "sls-below":
      /* The mirror question: order BELOW the window sitting directly above the
         target. If relativeTo is honoured in this direction it is honoured at
         all, and "just above the target" is reachable the long way round. */
      panel.level = .normal
      _ = slsSetLevel(panel.windowNumber, 0)
      let list = zOrder()
      let ti = idx(list, targetWindowNumber)
      let aboveNum = ti > 0 ? ((list[ti - 1]["num"] as? Int) ?? 0) : 0
      guard let handle = slsHandle, let orderSym = dlsym(handle, "SLSOrderWindow"),
        let cidSym = dlsym(handle, "SLSMainConnectionID")
      else {
        note = "SLSOrderWindow not found"
        break
      }
      typealias Order2 = @convention(c) (Int32, Int32, Int32, Int32) -> Int32
      typealias MainCID2 = @convention(c) () -> Int32
      let order2 = unsafeBitCast(orderSym, to: Order2.self)
      let cid2 = unsafeBitCast(cidSym, to: MainCID2.self)()
      let rc2 = order2(cid2, Int32(ours), -1, Int32(aboveNum))
      note = "below window \(aboveNum) returned \(rc2)"
    case "sls", "sls-normal":
      /* Ordering only happens WITHIN a level band, so a panel still sitting at
         .floating cannot be moved next to a .normal window at all — the first
         "sls works" reading was really the previous mode's level change plus a
         target that happened to be frontmost. `sls-normal` joins the band first,
         which is what the real pin does. */
      if mode == "sls-normal" { panel.level = .normal }
      fallthrough
    case "sls-order":
      /*
       * The private route, measured rather than assumed. SkyLight's
       * SLSOrderWindow takes a connection id and orders one window relative to
       * another; the question is whether it honours a window belonging to a
       * DIFFERENT connection, which is what "one level above Chrome" would need.
       * Looked up by dlsym so a missing or renamed symbol degrades to a report
       * instead of a link error.
       */
      let handle = dlopen(
        "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
      guard let handle else {
        note = "SkyLight could not be opened"
        break
      }
      typealias MainConnectionID = @convention(c) () -> Int32
      typealias OrderWindow = @convention(c) (Int32, Int32, Int32, Int32) -> Int32
      guard let cidSym = dlsym(handle, "SLSMainConnectionID"),
        let orderSym = dlsym(handle, "SLSOrderWindow")
      else {
        note = "SLSMainConnectionID / SLSOrderWindow not found"
        break
      }
      let mainCID = unsafeBitCast(cidSym, to: MainConnectionID.self)
      let slsOrder = unsafeBitCast(orderSym, to: OrderWindow.self)
      let cid = mainCID()
      // mode 1 = above, relative to the given window.
      let rc = slsOrder(cid, Int32(ours), 1, Int32(targetWindowNumber))
      note = "SLSOrderWindow(cid: \(cid)) returned \(rc)"
    
    case "order-only":
      panel.order(.above, relativeTo: targetWindowNumber)
      note = "ordered at the current level"
    case "level-then-order":
      panel.level = .normal
      panel.order(.above, relativeTo: targetWindowNumber)
      note = "dropped to .normal then ordered"
    default:
      note = "read only"
    }
    let after = zOrder()
    let ourIdx = idx(after, ours)
    let targetIdx = idx(after, targetWindowNumber)
    return [
      "ok": true,
      "mode": mode,
      "note": note,
      "ourWindowNumber": ours,
      "targetWindowNumber": targetWindowNumber,
      "level": panel.level.rawValue,
      "indexBefore": idx(before, ours),
      "indexAfter": ourIdx,
      "targetIndexAfter": targetIdx,
      "directlyAbove": ourIdx >= 0 && targetIdx >= 0 && targetIdx - ourIdx == 1,
      "stillVisible": panel.isVisible,
      "frontToBack": Array(after.prefix(8)),
    ]
  }

  func setWindowRect(_ rect: CGRect?) {
    windowAX = rect
    if bubble.opacity > 0 { layoutBubble() }
  }

  /// Whether a window rect is held — the precondition for riding a move.
  var hasWindowRect: Bool { windowAX != nil }

  /// True when `number` names a window other than the one being tracked (a
  /// known-on-screen number); a stale or unknown tracked number never counts.
  func isTrackingOtherWindow(than number: Int) -> Bool {
    trackedWindow > 0 && trackedNumberOnScreen && number != trackedWindow
  }

  /**
   * The window moved or resized: carry the phantom the same distance.
   *
   * The cursor is meant to be ON the window, so a drag has to move it by the
   * window's own delta — not re-derive a position, which is what produced the
   * snap when a stale delta landed. A resize moves nothing but re-clamps the
   * pill, which layoutBubble does off the new rect.
   */
  func followWindow(to rect: CGRect, windowNumber: Int?) {
    /* Only the tracked window's moves move the cursor — unless the number we
       were told is not on this desktop (stale), in which case any window of
       the app is a better guide than none. */
    if let n = windowNumber, trackedWindow > 0, trackedNumberOnScreen, n != trackedWindow { return }
    let prev = windowAX
    windowAX = rect
    if let prev = prev {
      let dx = rect.minX - prev.minX
      let dy = rect.minY - prev.minY
      if dx != 0 || dy != 0 {
        shiftCursor(dx: dx, dy: dy)
      } else if bubble.opacity > 0 {
        layoutBubble()
      }
    } else if bubble.opacity > 0 {
      layoutBubble()
    }
    refreshOcclusion()
  }

  /**
   * TRACK THE APP'S WINDOW AND CUT OUT WHATEVER COVERS IT.
   *
   * the user: "why can't you pin it literally one level on top of the window you
   * want to target ... mirroring the layering so it's always one level above
   * the target", and later "there's no way it's impossible to do this overlay
   * window stacking thing, oai were able to do it so we can too." He was right
   * to make me measure instead of assert, so I measured — and the window server
   * says no, in a way worth writing down because it looks like a yes:
   *
   *   SLSOrderWindow(cid, ours, 1, foreignWindow) RETURNS 0 AND MOVES NOTHING.
   *
   * Asking to sit above Chrome, which was at the BACK of the level-0 band, put
   * us at the FRONT of it. Ordering BELOW the window directly above Chrome:
   * same, rc 0, no movement. Borrowing Chrome's own connection id (via
   * SLSGetWindowOwner) to ask on its behalf: rc 0x10000003, refused. The
   * relativeTo argument is only honoured for windows on the calling connection;
   * for a foreign one it degrades to "front of my band" and reports success. My
   * first reading of this said it worked — that was the user clicking between the
   * two samples and raising two windows over us by hand.
   *
   * So the layering stays a mask, and the thing that was actually WRONG with
   * the mask gets fixed instead: it was computed in Node, one poll and one pipe
   * round trip away from the truth. the user: "when an app switches away from focus
   * there's a ~1s delay until the cursor disappears as well, this breaks the
   * immersion that it's actually part of, actually on the window." Reading the
   * z-order HERE, at display rate, turns that second into a frame — and no rule
   * has to decide to hide anything, which is what made it late in the first
   * place.
   */
  func trackWindow(number: Int, pid: pid_t = 0) {
    trackedWindow = number
    trackedPid = pid
    refreshOcclusion()
    startOcclusionTimer()
  }

  func untrackWindow() {
    trackedWindow = 0
    trackedPid = 0
    stopOcclusionTimer()
    setOccluders([])
  }

  /// True once we are cutting the mask ourselves, which is what lets the Node
  /// side stop sampling occlusion and stop hiding the whole overlay.
  var masksNatively: Bool { trackedWindow > 0 || trackedPid > 0 }

  private func startOcclusionTimer() {
    guard occlusionTimer == nil, trackedWindow > 0 || trackedPid > 0 else { return }
    /* 30 Hz. MEASURED at 0.48 ms per CGWindowListCopyWindowInfo call on this
       Mac with 11 on-screen windows, so ~1.4% of one core while an app is being
       driven and nothing at all when it is not — the panel stops the timer when
       it hides. Cheap enough to be honest about next to a model doing prefill. */
    let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      self?.refreshOcclusion()
    }
    RunLoop.main.add(t, forMode: .common)
    occlusionTimer = t
  }

  private func stopOcclusionTimer() {
    occlusionTimer?.invalidate()
    occlusionTimer = nil
  }

  /**
   * Every window stacked above the controlled one becomes a hole in the phantom.
   *
   * Only windows BELOW our own level band matter: anything at or above it is
   * already drawn over us by the window server. Our own two windows are skipped
   * for the obvious reason. If the controlled window is not in the on-screen
   * list at all (another space, minimised) there is nothing to reason about, so
   * the mask is cleared and the Node side's own appVisible rule takes it from
   * there.
   */
  /// "x,y wxh" — short enough to sit in a log line.
  private func rectText(_ r: CGRect) -> String {
    "\(Int(r.origin.x)),\(Int(r.origin.y)) \(Int(r.width))x\(Int(r.height))"
  }

  /// The last reason the phantom could not be masked, so the log fires on a
  /// CHANGE rather than 30 times a second.
  private var unmaskedReason: String?

  /// the user: "you need to log whenever that's happening". Reports on transition
  /// only, and says which window is over the cursor so the next person does not
  /// have to guess.
  private func noteUnmasked(_ why: String) {
    if unmaskedReason == why { return }
    unmaskedReason = why
    writeStderr("overlay: UNMASKED — \(why)\n")
  }

  private func clearUnmasked() {
    guard let was = unmaskedReason else { return }
    unmaskedReason = nil
    writeStderr("overlay: masked again (was: \(was))\n")
  }

  private var hollowNoted: Set<String> = []
  private func noteHollow(_ owner: String, layer: Int) {
    let key = "\(owner)@\(layer)"
    if hollowNoted.contains(key) { return }
    hollowNoted.insert(key)
    writeStderr("overlay: not cutting \(owner)'s screen-sized window at level \(layer) — hollow\n")
  }

  /// A window that spans (nearly) a whole display.
  private func coversAScreen(_ r: CGRect) -> Bool {
    let flipBase = cocoaFlipBase()
    for s in NSScreen.screens {
      let f = s.frame
      let ax = CGRect(x: f.minX, y: flipBase - f.maxY, width: f.width, height: f.height)
      let inter = ax.intersection(r)
      if !inter.isNull, inter.width * inter.height >= 0.9 * ax.width * ax.height { return true }
    }
    return false
  }

  /// Is the phantom actually being drawn right now? An invisible cursor cannot
  /// be on top of anything, and reporting it would drown the real cases.
  private var phantomShowing: Bool {
    panel.isVisible && panel.alphaValue > 0.01
      && (cursorGroup.presentation() ?? cursorGroup).opacity > 0.5
  }

  func refreshOcclusion() {
    /* Reported BEFORE the guard, because the guard is itself one of the ways
       this goes wrong: with no tracked window there is nothing to sit behind,
       native masking is off, and the phantom is left to the Node poll — the
       slow path whose lag the user reported in the first place. */
    if trackedWindow <= 0 && trackedPid <= 0 && phantomShowing {
      noteUnmasked("no tracked app — nothing to sit behind, so nothing can be cut out")
    } else if (trackedWindow > 0 || trackedPid > 0) && phantomShowing && occlusionTimer == nil {
      /* The mask is only as fresh as this timer. Without it the holes are
         whatever they were when it stopped, which is a mask that describes a
         z-order from some earlier moment. */
      noteUnmasked("the occlusion timer is not running — the mask is frozen")
    }
    guard trackedWindow > 0 || trackedPid > 0, panel.isVisible else { return }
    let ours: Set<Int> = [panel.windowNumber, controls?.windowNumber ?? -1]
    let list =
      (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    /*
     * WHAT COVERS THE CURSOR: every window ABOVE the tracked one (front-to-back
     * order, any level) that belongs to SOMEONE ELSE. The app's own windows
     * never do, whatever their level.
     *
     * SEEN (the user, Chrome): the fake cursor went under the address bar. Chrome's
     * suggestion list is a second window of Chrome's, ordered above the main
     * one, at the normal level — so the old rule ("anything above the tracked
     * window that is below our level") cut a hole for it and the cursor
     * vanished behind the app it was driving. An app's own popups, sheets,
     * tooltips and menus are part of the app; the cursor paints over them.
     * Another app's window over the target, at any level — the user's browser
     * dragged across, a menu of theirs — still cuts a hole, which is the rule
     * that keeps the cursor off what the user is looking at.
     */
    /*
     * WHICH WINDOW THE PHANTOM SITS BEHIND — the app's, by PID, not by number.
     *
     * the user, 2026-09-12: "the fake cursor … seems to be only drawn on the bobble
     * app window now instead of on top of the app being used … it's appearing
     * on the claude app and sometimes bobble." The anchor was the window NUMBER
     * the Node side handed over, and a number is only as good as the moment it
     * was read: the app opens another window, the number now names a utility
     * window of the app's that sits at a higher level than the user's windows,
     * and everything the user is looking at falls BELOW the anchor — no holes,
     * a cursor painted over every app on the desktop. The controlled app's pid
     * cannot go stale that way, so the anchor is now the app's frontmost real
     * window (level 0, big enough to be a window) found by pid, with the number
     * we were told as the fallback when the app has no such window on this
     * desktop. A wrong anchor now needs a wrong pid, and a wrong pid is the
     * Node side's whole notion of which app it is driving.
     */
    /*
     * …BUT THE NUMBER FIRST WHEN IT NAMES A REAL WINDOW. (2026-09-13.) Anchoring
     * on the pid's FRONTMOST window has its own failure, and it is the one the user
     * describes as "the cursor being on top while the window is behind": the
     * app has two ordinary windows — the one being driven, behind Bobble, and
     * another the user opened in front of Bobble — so the frontmost-by-pid
     * anchor is the window in front, Bobble falls BELOW the anchor, and the
     * phantom (sitting on the window behind) is painted straight over Bobble.
     * The Node side re-reads the app's focused window every tick and re-sends
     * its number, so the number is fresh; what made it unsafe was only the case
     * where it names a utility window at a higher level. So: the number when
     * it is a layer-0 window of real size, the pid's frontmost real window
     * otherwise, and the bare number as the last resort.
     */
    var rects: [CGRect] = []
    var anchor: Int?
    var byNumber: Int?
    var byRealNumber: Int?
    for (i, w) in list.enumerated() {
      let num = (w[kCGWindowNumber as String] as? Int) ?? -1
      let owner = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
      let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
      let real: Bool = {
        guard layer == 0, let raw = w[kCGWindowBounds as String] as? NSDictionary,
          let r = CGRect(dictionaryRepresentation: raw)
        else { return false }
        return r.width >= 64 && r.height >= 64
      }()
      if num == trackedWindow {
        byNumber = i
        if real { byRealNumber = i }
        // The owner is the truth about which pid this is, whatever we were told.
        if trackedPid <= 0, owner > 0 { trackedPid = pid_t(owner) }
      }
      if anchor == nil, trackedPid > 0, pid_t(owner) == trackedPid, !ours.contains(num), real {
        anchor = i
      }
    }
    let at = byRealNumber ?? anchor ?? byNumber
    let found = at != nil
    trackedNumberOnScreen = byNumber != nil
    anchorIndex = at
    /*
     * What a window above the anchor contributes to the mask — nil when it is
     * not an occluder at all. ONE rule, used both to cut the holes and to check
     * the cut afterwards, so the check cannot disagree with the cut.
     *
     * Anything at or above our own level is drawn over us by the window server
     * and needs no hole (the lock screen at 2004, the camera dot at the top of
     * the level range); it used to be cut anyway, which was harmless for the
     * mask and a false alarm for the check.
     */
    let ourLevel = panel.level.rawValue
    let holeRects: ([String: Any]) -> [CGRect]? = { w in
      let num = (w[kCGWindowNumber as String] as? Int) ?? -1
      if ours.contains(num) { return nil }
      if let owner = (w[kCGWindowOwnerPID as String] as? Int), pid_t(owner) == self.trackedPid {
        return nil
      }
      if let alpha = (w[kCGWindowAlpha as String] as? Double), alpha < 0.05 { return nil }
      guard let raw = w[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: raw)
      else { return nil }
      let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
      if layer >= ourLevel { return nil }
      let ownerName = (w[kCGWindowOwnerName as String] as? String) ?? ""
      /* The Dock's screen-sized window covers nothing but its tiles — see
         dockStrips. Only the screen-sized one is hollow; a smaller Dock
         window (an app switcher, a bounce) is what it says it is. */
      if ownerName == "Dock", self.coversAScreen(r) {
        return dockStrips().compactMap { strip -> CGRect? in
          let cut = strip.intersection(r)
          return (!cut.isNull && cut.width > 0 && cut.height > 0) ? cut : nil
        }
      }
      /* Any OTHER screen-sized window above the normal band is an overlay of
         someone's (a screen-share border, a recorder's frame, a window
         manager's hints) — hollow by construction, since a real fullscreen
         app lives at layer 0 on a Space of its own. Cutting it would blank
         the phantom on the whole display. Said once per owner. */
      if layer > 0, self.coversAScreen(r) {
        self.noteHollow(ownerName, layer: layer)
        return nil
      }
      return [r]
    }
    if let at = at {
      for w in list.prefix(at) {
        if let hs = holeRects(w) { rects.append(contentsOf: hs) }
      }
    }
    /*
     * NEVER CLEAR THE MASK BECAUSE WE LOST THE WINDOW.
     *
     * `found ? rects : []` cleared every hole the moment the tracked window
     * dropped out of the z-order — which is exactly the moment the phantom is
     * most likely to be over something it does not belong to. The old mask is
     * stale by then, but stale-and-covering is strictly safer than none, and it
     * only has to hold for the frame or two before the hide below takes over.
     */
    if found { setOccluders(rects) }
    /*
     * DID THE MASK ACTUALLY COVER THE CURSOR? — the symptom, checked directly.
     *
     * the user, twice: the phantom draws on top of a window that is above the one
     * it belongs to. Everything else here is a proxy for that; this is the
     * thing itself. The cursor's own point is tested against every window that
     * is ABOVE the anchor in the z-order and belongs to someone else, and if
     * one of them contains the tip while the mask PATH (what the compositor
     * fills) does not cut it out, the phantom is being painted over somebody
     * else's window right now — so say so, and name the window, so the next
     * report carries the culprit instead of a guess.
     */
    var caught = false
    if found, phantomShowing, let at = at, let tip = cursorAX, !cursorMaskedByPath() {
      for w in list.prefix(at) {
        guard let hs = holeRects(w), let r = hs.first(where: { $0.contains(tip) }) else { continue }
        let num = (w[kCGWindowNumber as String] as? Int) ?? -1
        let ownerName = (w[kCGWindowOwnerName as String] as? String) ?? "?"
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        noteUnmasked(
          "tip \(Int(tip.x)),\(Int(tip.y)) is over \(ownerName)'s window #\(num) (level \(layer), \(rectText(r))) and the mask has no hole there — holes=\(rects.count)"
        )
        caught = true
        break
      }
    }
    if caught {
      // said above
    } else if found {
      clearUnmasked()
    } else if phantomShowing {
      /*
       * The tracked window is not in the z-order at all. Either it is on
       * another desktop (handled just below by hiding) or the number is STALE —
       * the app closed that window and opened another, and we are still masking
       * against a window that no longer exists. Both leave the phantom with
       * nothing to sit behind, which is the state the user keeps seeing, so both
       * get said out loud with the number that failed to resolve.
       */
      noteUnmasked("tracked window \(trackedWindow) is not in this desktop's z-order")
    }
    /*
     * THE WINDOW IS ON ANOTHER DESKTOP, SO THE PHANTOM MUST NOT BE ON THIS ONE.
     *
     * the user: "when I switch desktops I notice a new bug where the mouse cursor
     * follows instead of staying on the window in the other desktop and redoes
     * the on top of wrong window bug."
     *
     * The panel carries `.canJoinAllSpaces`, which it needs — the controlled
     * window can be on any Space and the phantom has to be able to reach it.
     * The cost is that the panel is on EVERY Space, including ones the tracked
     * window is not on.
     *
     * `optionOnScreenOnly` lists only the current Space, so `found == false`
     * already means "not here" — and the old answer to that was to clear the
     * occluders, i.e. paint the phantom at FULL strength over whatever the user
     * switched to. Exactly backwards, and it is the same failure as the
     * wrong-window layering because it has the same cause: no window of ours to
     * be behind.
     *
     * Two consecutive misses before hiding: at 30Hz that is 66ms, enough that a
     * momentarily incomplete window list cannot make the phantom blink during a
     * normal drag.
     */
    /*
     * ASYMMETRIC ON PURPOSE: hide at once, come back slowly.
     *
     * The hysteresis was symmetric — two ticks either way — which meant that on
     * a desktop switch the phantom stayed on screen, unmasked, for 66ms before
     * hiding. 66ms of a cursor sitting on top of the wrong window is exactly
     * what the user keeps reporting, and it is a flash nobody can screenshot.
     *
     * Being wrong in the two directions costs very different things: hiding a
     * frame too early is invisible, showing a frame too late is the bug. So
     * hiding is immediate and only the RETURN waits for two consecutive ticks,
     * which is what stops an incomplete window list from making it blink.
     */
    if found {
      onSpaceStreak = min(onSpaceStreak + 1, 3)
      if onSpaceStreak >= 2 { setOffSpace(false) }
    } else {
      onSpaceStreak = 0
      setOffSpace(true)
    }
  }

  /// The pill's frame in AX (top-left) screen points, as drawn right now.
  private var pillAXFrame: CGRect {
    let f = (bubble.presentation() ?? bubble).frame.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
    return CGRect(x: f.minX, y: cocoaFlipBase() - f.maxY, width: f.width, height: f.height)
  }

  /// Whether any hole touches the pill — the controls window must not exist then.
  private var pillCovered: Bool {
    guard bubble.opacity > 0.4 else { return false }
    let f = pillAXFrame
    return lastOccluders.contains { $0.intersects(f) }
  }

  /// Consecutive occlusion ticks on which the tracked window WAS on this Space.
  /// Only the return is debounced — see refreshOcclusion.
  private var onSpaceStreak = 0
  private var offSpace = false

  /// Hide the whole phantom while the window it belongs to is on another Space,
  /// and bring it back untouched when the user returns. Alpha rather than
  /// `orderOut`, because ordering out drops the panel's place in the window
  /// server's stack and the layering has to be re-established on the way back.
  private func setOffSpace(_ away: Bool) {
    if away == offSpace { return }
    offSpace = away
    panel.alphaValue = away ? 0 : 1
    // The controls are ordered out rather than faded: an alpha-0 window still
    // takes the clicks meant for the app under it.
    syncControls()
  }

  /// Probe seam: see previewHover. Lays the controls out first, because a pill
  /// that has never been hovered has never been widened to hold them.
  func previewControlsHover(_ on: Bool, hot: Int?) {
    setBubbleBlurred(on)
    syncControls()
    controlsView?.previewHover(on, hot: hot)
    syncControls()
  }

  func setPillEnabled(_ on: Bool) {
    pillEnabled = on
    if !on { hideBubble() } else if !bubbleStatus.isEmpty { setStatus(bubbleStatus, text: "") }
  }
  private var pillEnabled = true

  func setPrefill(_ fraction: Double?) {
    let was = prefillFraction
    prefillFraction = fraction
    if was == nil && fraction == nil { return }
    setStatus(bubbleStatus.isEmpty ? "thinking" : bubbleStatus, text: "")
  }

  func hideBubble() {
    setPulsing(false)
    syncControls()
    guard bubble.opacity > 0 else { return }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = bubble.opacity
    fade.toValue = 0
    fade.duration = 0.22
    setModelOpacity(bubble, 0)
    bubble.add(fade, forKey: "bubble-out")
  }

  private var dotsVisible = false
  private var pulsing = false

  /// The resting "Thinking" pill breathes — a slow swell of its own glow. It is
  /// the only signal that a turn is still in flight while nothing on screen is
  /// moving, so it is worth the one repeating animation; every other state is
  /// transient and carries its own motion.
  private func setPulsing(_ on: Bool) {
    let want = on && !reduceMotion()
    if want == pulsing { return }
    pulsing = want
    bubble.removeAnimation(forKey: "breathe")
    guard want else { return }
    let breathe = CAKeyframeAnimation(keyPath: "shadowOpacity")
    breathe.values = [0.42, 0.62, 0.42]
    breathe.keyTimes = [0, 0.5, 1]
    breathe.duration = 2.1
    breathe.repeatCount = .infinity
    breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    bubble.add(breathe, forKey: "breathe")
  }

  /// Narrowest pill that still fits Hide + pause + ✕ with room to breathe.
  private let CONTROLS_MIN_W: CGFloat = 134
  /// True while the pointer is over the pill, which is also what makes it wide
  /// enough to hold the buttons.
  private var controlsHovered = false

  private func layoutBubbleContents(dots: Bool) {
    dotsVisible = dots
    let padX: CGFloat = 13
    let padY: CGFloat = 7
    let gap: CGFloat = 7
    let mainFont = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
    let subFont = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium)
    let mainSize = (bubbleTextValue as NSString).size(withAttributes: [.font: mainFont])
    let subSize = bubbleSubValue.isEmpty
      ? .zero
      : (" \(bubbleSubValue)" as NSString).size(withAttributes: [.font: subFont])
    /* Collapsed: the dots carry no trailing gap, because there is nothing after
       them — that gap is what made a "just thinking" pill look padded. */
    let bare = bubbleTextValue.isEmpty
    let dotsWidth: CGFloat = dots ? (4 * 3 + 3 * 2) + (bare ? 0 : gap) : 0
    let contentW = dotsWidth + ceil(mainSize.width) + ceil(subSize.width)
    let h = ceil(max(mainSize.height, max(subSize.height, 15))) + padY * 2
    /* Hovering has to leave room for the buttons. A "Thinking" pill is narrower
       than Hide + pause + ✕, so it grows to hold them — the same width
       animation the status changes already use, which is why hovering reads as
       the pill opening rather than as a popover appearing. */
    let w = max(contentW + (bare ? padY * 2 : padX * 2), controlsHovered ? CONTROLS_MIN_W : 0)

    /*
     * THE WIDTH CHANGE IS THE ANIMATION.
     *
     * the user: "it should be a smooth expanding and collapsing animation." Bounds
     * were set inside a disabled-actions transaction, so the pill used to snap
     * between sizes. Everything INSIDE it still moves without animating — text
     * sliding to a new x while the pill grows around it reads as jitter — so
     * only the pill's own bounds, fill and shadow are allowed to animate.
     */
    let grew = abs(bubble.bounds.width - w) > 0.5
    /* The buttons live on a separate window, so they do not come along for the
       width animation for free — without this they snap to the new width a beat
       late and the Hide slab is briefly the wrong size. */
    if grew { followBubbleWidth() }
    if grew && !reduceMotion() {
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.24)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
      bubble.bounds = CGRect(x: 0, y: 0, width: w, height: h)
      bubbleFill.frame = CGRect(x: 0, y: 0, width: w, height: h)
      CATransaction.commit()
    }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bubble.bounds = CGRect(x: 0, y: 0, width: w, height: h)
    bubbleFill.frame = bubble.bounds
    bubble.shadowPath = CGPath(
      roundedRect: bubble.bounds, cornerWidth: h / 2, cornerHeight: h / 2, transform: nil)
    bubble.cornerRadius = h / 2
    bubbleFill.cornerRadius = h / 2

    var x = padX
    for (i, dot) in bubbleDots.enumerated() {
      dot.isHidden = !dots
      dot.position = CGPoint(x: x + 2 + CGFloat(i) * 7, y: h / 2)
      dot.removeAnimation(forKey: "wave")
      if dots {
        // The three-dot wave: a staggered lift + brighten, the same 1.25s cycle
        // the CSS overlay ran, so "Thinking" still reads as alive rather than
        // stuck.
        let wave = CAKeyframeAnimation(keyPath: "opacity")
        wave.values = [0.45, 0.45, 1.0, 0.45, 0.45]
        wave.keyTimes = [0, 0.18, 0.3, 0.6, 1]
        wave.duration = 1.25
        wave.repeatCount = .infinity
        wave.timeOffset = Double(i) * 0.16
        dot.add(wave, forKey: "wave")
      }
    }
    if dots { x += dotsWidth }
    bubbleText.frame = CGRect(
      x: x, y: (h - ceil(mainSize.height)) / 2, width: ceil(mainSize.width) + 1,
      height: ceil(mainSize.height))
    bubbleText.string = NSAttributedString(
      string: bubbleTextValue, attributes: [.font: mainFont, .foregroundColor: NSColor.white])
    x += ceil(mainSize.width)
    bubbleSub.isHidden = bubbleSubValue.isEmpty
    bubbleSub.frame = CGRect(
      x: x, y: (h - ceil(subSize.height)) / 2, width: ceil(subSize.width) + 1,
      height: ceil(subSize.height))
    bubbleSub.string = NSAttributedString(
      string: bubbleSubValue.isEmpty ? "" : " \(bubbleSubValue)",
      attributes: [.font: subFont, .foregroundColor: NSColor.white.withAlphaComponent(0.78)])

    /* The prefill bar hugs the pill's bottom edge, inset so the rounded ends do
       not clip it. Grey track, white fill — the user's "grey % bar". */
    if let fraction = prefillFraction {
      let inset: CGFloat = h / 2 * 0.55
      let barW = max(0, w - inset * 2)
      let barY = h - padY * 0.62
      progressTrack.frame = CGRect(x: inset, y: barY, width: barW, height: 3)
      progressFill.frame = CGRect(
        x: inset, y: barY, width: barW * CGFloat(min(1, max(0, fraction))), height: 3)
      progressTrack.opacity = 1
      progressFill.opacity = 1
    } else {
      progressTrack.opacity = 0
      progressFill.opacity = 0
    }
    CATransaction.commit()
  }

  /// Park the pill below-right of the cursor, flipping to the other side near a
  /// screen edge so it is never sheared off. The panel spans the whole desktop,
  /// so "edge" here means the edge of the SCREEN the cursor is on — not, as
  /// before, the edge of a window-sized canvas.
  private func layoutBubble() {
    // No cursor placed yet (a status arrived before the first act): park the
    // pill in the middle of the main screen rather than at the panel's origin,
    // which is the desktop's bottom-left CORNER. The Node side normally beats
    // this by seeding the cursor on the controlled window's centre; this is the
    // floor under that.
    let ax =
      cursorAX
      ?? {
        let s = NSScreen.main?.frame ?? screensUnionFrame()
        return CGPoint(x: s.midX, y: cocoaFlipBase() - s.midY)
      }()
    let p = local(ax)
    let w = bubble.bounds.width
    let h = bubble.bounds.height
    /* the user: "bring pill a bit closer to it". */
    let dx: CGFloat = 11
    let dy: CGFloat = 15
    // The screen under the cursor, in panel-local coordinates.
    let frame = panel.frame
    let cocoa = CGPoint(x: ax.x, y: cocoaFlipBase() - ax.y)
    let screen = NSScreen.screens.first { $0.frame.contains(cocoa) } ?? NSScreen.screens.first
    let screenLocal = (screen?.frame ?? frame).offsetBy(dx: -frame.minX, dy: -frame.minY)
    /* Inside the controlled window when we know where it is, and inside the
       screen otherwise. The window is the tighter box and the one that matters:
       spilling past it is spilling onto another app. */
    let sf = windowAX.map { local($0) } ?? screenLocal
    bubbleFlipX = p.x + dx + w > sf.maxX - 8
    bubbleFlipY = p.y - dy - h < sf.minY + 8
    var bx = bubbleFlipX ? p.x - dx : p.x + dx
    var by = bubbleFlipY ? p.y + dy : p.y - dy
    /* Flipping alone is not enough for a cursor sitting in a corner, or for a
       window narrower than the pill — clamp the resulting box into the same
       bounds so no part of it lands outside. */
    let leftEdge = bubbleFlipX ? bx - w : bx
    if leftEdge < sf.minX + 4 { bx += sf.minX + 4 - leftEdge }
    let rightEdge = bubbleFlipX ? bx : bx + w
    if rightEdge > sf.maxX - 4 { bx -= rightEdge - (sf.maxX - 4) }
    let topEdge = bubbleFlipY ? by : by - h
    if topEdge < sf.minY + 4 { by += sf.minY + 4 - topEdge }
    let bottomEdge = bubbleFlipY ? by + h : by
    if bottomEdge > sf.maxY - 4 { by -= bottomEdge - (sf.maxY - 4) }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bubble.anchorPoint = CGPoint(x: bubbleFlipX ? 1 : 0, y: bubbleFlipY ? 0 : 1)
    bubble.position = CGPoint(x: bx, y: by)
    CATransaction.commit()
    syncControls()
  }

  // ── occlusion mask ───────────────────────────────────────────────────────

  /// Punch a hole in the overlay for every window stacked ABOVE the controlled
  /// one (the helper's CGWindowList z-order truth, delivered with each bounds
  /// sample).
  ///
  /// This is the honest answer to "always on top cursor seems to be back". A
  /// floating panel genuinely IS above everything — window levels are global
  /// bands, so no public API can slot it between the controlled window and the
  /// window the user just dragged over it. What we CAN do is refuse to paint
  /// where those windows are: even-odd fill over the panel rect plus each
  /// occluder rect leaves the phantom visible everywhere except on top of them.
  /// Cheap (a handful of rects, one CAShapeLayer, no rasterization) and exact,
  /// where the old whole-overlay hide was all-or-nothing at 15% coverage.
  /// Whether the cursor's tip is CUT OUT by the mask as it will be composited:
  /// false when there is no mask or the tip lies in the mask's filled region.
  func cursorMaskedByPath() -> Bool {
    guard let c = cursorAX, let mask = stage.mask as? CAShapeLayer, let path = mask.path else {
      return false
    }
    let p = local(c)
    return !path.contains(p, using: mask.fillRule == .evenOdd ? .evenOdd : .winding)
  }

  func setOccluders(_ rects: [CGRect]) {
    maskHoles = rects.count
    lastOccluders = rects
    guard !rects.isEmpty else {
      stage.mask = nil
      maskRects = 0
      syncControls()
      return
    }
    let path = CGMutablePath()
    path.addRect(stage.bounds)
    let flipBase = cocoaFlipBase()
    let frame = panel.frame
    /* Disjoint first — see disjointUnion for the parity trap that made
       overlapping holes paint the cursor back on. */
    let holes = disjointUnion(rects)
    maskRects = holes.count
    for r in holes {
      // Occluder rects arrive top-left-origin like everything else on the wire.
      let cocoaY = flipBase - (r.origin.y + r.height)
      path.addRect(
        CGRect(x: r.minX - frame.minX, y: cocoaY - frame.minY, width: r.width, height: r.height))
    }
    let mask = (stage.mask as? CAShapeLayer) ?? CAShapeLayer()
    mask.frame = stage.bounds
    mask.fillRule = .evenOdd
    mask.fillColor = CGColor(gray: 0, alpha: 1)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    mask.path = path
    stage.mask = mask
    CATransaction.commit()
    syncControls()
  }

  // ── probe seams ──────────────────────────────────────────────────────────

  /// Paint a solid colour behind the overlay. Probe-only: a transparent PNG of
  /// a white-on-nothing pointer tells a human reviewer nothing, and the cursor
  /// has to be judged against BOTH a light and a dark app.
  /// Largest a backdrop may ever be. the user's rule stands whatever the caller
  /// asks for: "I just saw the whole screen turn blank for a second" — so an
  /// explicit rect is honoured up to a card-sized area and no further.
  private static let BACKDROP_MAX = CGSize(width: 900, height: 700)

  func setBackdrop(_ hex: String?, over ax: CGRect? = nil) {
    guard let hex = hex, hex.count >= 6 else {
      backdrop.isHidden = true
      backdrop.backgroundColor = nil
      return
    }
    let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard let v = UInt32(s, radix: 16) else { return }
    // MEASURED: without disableActions the backgroundColor change runs CALayer's
    // default 0.25s implicit animation, and `render` (which draws the
    // PRESENTATION tree) then caught it ~30% of the way through — a white
    // backdrop came out as rgb(76,76,76) and a red one as (143,68,68), i.e.
    // exactly 0.3·new + 0.7·previous. Every screenshot judged off those crops
    // would be judging the wrong colours.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    /* NEVER the whole desktop. the user, mid-run: "I just saw the whole screen turn
       blank for a second, with no window change, what's that about?" — a probe
       had set a backdrop and the panel spans every display, so an opaque layer
       at root.bounds IS a blanked screen. Clamped to the pill's own
       neighbourhood, the worst a forgotten backdrop can do is put a small dark
       card behind the phantom. */
    /* …but around the WHOLE phantom, not just the pill. Anchoring on the bubble
       alone left the cursor outside the painted ground whenever the two are
       apart — which is most of the time, and which made the overlay probe count
       bare desktop as phantom pixels (22,400 of them: a 320x70 band of white
       above a backdrop that stopped short). The union is still local; it just
       includes the thing the backdrop exists to sit behind. */
    /* An explicit rect wins, because a caller measuring a REGION needs the
       ground painted under that region — following the phantom cannot promise
       that, and the overlay probe was counting bare desktop as phantom pixels
       because of it. Still bounded: a rect bigger than a card is clamped, so
       "never the whole desktop" holds for a caller that asks for too much. */
    if let ax = ax, ax.width > 0, ax.height > 0 {
      let want = local(ax)
      backdrop.frame = CGRect(
        x: want.minX, y: want.minY,
        width: min(want.width, Self.BACKDROP_MAX.width),
        height: min(want.height, Self.BACKDROP_MAX.height))
    } else {
      let pill = (bubble.presentation() ?? bubble).frame
      let glyph = (cursorGroup.presentation() ?? cursorGroup).frame
      let both = pill.isEmpty ? glyph : (glyph.isEmpty ? pill : pill.union(glyph))
      let around = both.insetBy(dx: -90, dy: -70)
      backdrop.frame = around.isEmpty ? CGRect(x: 0, y: 0, width: 420, height: 260) : around
    }
    backdrop.backgroundColor = cgColor(
      CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255, 1)
    backdrop.isHidden = false
    CATransaction.commit()
  }

  /// Render the layer tree to a PNG — the probe's eyes. Renders the
  /// PRESENTATION tree when one exists, so a screenshot taken mid-glide shows
  /// the cursor mid-glide rather than already arrived. `rect` is a top-left
  /// screen rect (nil = the whole panel); `scale` oversamples so a crop of the
  /// glyph can actually be judged.
  func render(to path: String, rect: CGRect?, scale s: CGFloat) -> Bool {
    let frame = panel.frame
    var local = CGRect(origin: .zero, size: frame.size)
    if let r = rect {
      let cocoaY = cocoaFlipBase() - (r.origin.y + r.height)
      local = CGRect(
        x: r.minX - frame.minX, y: cocoaY - frame.minY, width: r.width, height: r.height)
    }
    let pxW = Int((local.width * s).rounded())
    let pxH = Int((local.height * s).rounded())
    guard pxW > 0, pxH > 0,
      let ctx = CGContext(
        data: nil, width: pxW, height: pxH, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    ctx.scaleBy(x: s, y: s)
    ctx.translateBy(x: -local.minX, y: -local.minY)
    (root.presentation() ?? root).render(in: ctx)
    /* The buttons live on their own window (the phantom must stay
       click-through), so they are not in this layer tree. Draw them in at the
       pill's position, or a render of a hovered pill would show the blur with
       nothing on it. */
    if let view = controlsView, let win = controls, win.isVisible, view.bounds.width > 1,
      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
    {
      view.cacheDisplay(in: view.bounds, to: rep)
      if let img = rep.cgImage {
        let f = win.frame
        ctx.draw(
          img,
          in: CGRect(
            x: f.minX - frame.minX, y: f.minY - frame.minY, width: f.width, height: f.height))
      }
    }
    guard let image = ctx.makeImage() else { return false }
    let url = URL(fileURLWithPath: path)
    guard
      let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
  }

  /// Everything a probe needs to assert the mechanism, since there is no DOM to
  /// read any more.
  func info() -> [String: Any] {
    let flipBase = cocoaFlipBase()
    let behavior = panel.collectionBehavior
    var d: [String: Any] = [
      "ok": true,
      "visible": panel.isVisible,
      // Window-server truth: does the compositor actually have our panel on
      // screen? `isVisible` is our own bookkeeping; this is the check that
      // catches an activation policy that silently refuses to show windows.
      "onScreenPerWindowServer": windowServerSeesPanel(),
      "frame": axRect(panel.frame, flipBase: flipBase),
      "screens": NSScreen.screens.map { axRect($0.frame, flipBase: flipBase) },
      "clickThrough": panel.ignoresMouseEvents,
      "canBecomeKey": panel.canBecomeKey,
      "canBecomeMain": panel.canBecomeMain,
      "isKeyWindow": panel.isKeyWindow,
      "hidesOnDeactivate": panel.hidesOnDeactivate,
      "opaque": panel.isOpaque,
      "hasShadow": panel.hasShadow,
      "level": panel.level.rawValue,
      "trackedWindow": trackedWindow,
      "trackedPid": Int(trackedPid),
      "trackedNumberOnScreen": trackedNumberOnScreen,
      "anchorIndex": anchorIndex ?? -1,
      "masksNatively": masksNatively,
      "windowNumber": panel.windowNumber,

      "floatingLevel": NSWindow.Level.floating.rawValue,
      "appActive": NSApp.isActive,
      "activationPolicy": policyName(NSApp.activationPolicy()),
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "frontmostPid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
      "behavior": [
        "transient": behavior.contains(.transient),
        "canJoinAllSpaces": behavior.contains(.canJoinAllSpaces),
        "offSpace": offSpace,
        "unmasked": unmaskedReason ?? "",
        "ignoresCycle": behavior.contains(.ignoresCycle),
        "fullScreenAuxiliary": behavior.contains(.fullScreenAuxiliary),
        "managed": behavior.contains(.managed),
      ],
      "cursorVisible": (cursorGroup.presentation() ?? cursorGroup).opacity > 0.5,
      "maskHoles": maskHoles,
      "maskRects": maskRects,
      "pillCovered": pillCovered,
      /* The truth a screenshot would show, computed in the mask's own terms:
         is the cursor's tip inside one of the holes right now? */
      "cursorCovered": cursorAX.map { c in lastOccluders.contains { $0.contains(c) } } ?? false,
      /* And the truth the COMPOSITOR shows: is the cursor's tip inside the
         mask's filled region? Computed off the mask path itself, not the
         rects — the two disagreed for a whole release (see setOccluders). */
      "cursorMasked": cursorMaskedByPath(),
      "occluders": lastOccluders.prefix(24).map {
        ["x": Double($0.minX), "y": Double($0.minY), "w": Double($0.width), "h": Double($0.height)]
      },
      "reduceMotion": reduceMotion(),
      "press": livePress,
      "glyph": ["w": Double(glyph.box.width), "h": Double(glyph.box.height)],
      "bubble": [
        "visible": (bubble.presentation() ?? bubble).opacity > 0.5,
        "status": bubbleStatus,
        "text": bubbleTextValue,
        "sub": bubbleSubValue,
        "dots": dotsVisible,
        "pulse": pulsing,
        "flipX": bubbleFlipX,
        "flipY": bubbleFlipY,
        "frame": axRect(
          (bubble.presentation() ?? bubble).frame.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY),
          flipBase: flipBase),
      ],
    ]
    /* The controls panel is a SEPARATE window, so overlay-render cannot
       photograph it — reporting where it is parked is how it gets verified. */
    if let win = controls {
      d["controls"] = [
        "visible": win.isVisible,
        "clickThrough": win.ignoresMouseEvents,
        "hovered": controlsView?.isHovered ?? false,
        "frame": axRect(win.frame, flipBase: flipBase),
        // The two levels, so a probe can assert the buttons are not behind
        // the pill they belong to (see buildControls).
        "level": win.level.rawValue,
        "phantomLevel": panel.level.rawValue,
        "number": win.windowNumber,
      ]
    }
    if let c = cursorAX { d["cursor"] = ["x": Double(c.x), "y": Double(c.y)] }
    // Where the tip is actually DRAWN, in screen points. Differs from `cursor`
    // only for a point off every display, which the panel clamps to its edge
    // rather than losing — the phantom parks at the border instead of vanishing.
    let drawn = (cursorGroup.presentation() ?? cursorGroup).position
    d["cursorDrawn"] = [
      "x": Double(drawn.x + panel.frame.minX),
      "y": Double(flipBase - (drawn.y + panel.frame.minY)),
    ]
    // The glyph's live box in screen points — what the "is it clipped?" check
    // measures against the panel and the screen.
    let live = (cursorGroup.presentation() ?? cursorGroup).frame
    d["cursorGlyph"] = axRect(
      live.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY), flipBase: flipBase)
    return d
  }

  private func policyName(_ p: NSApplication.ActivationPolicy) -> String {
    switch p {
    case .regular: return "regular"
    case .accessory: return "accessory"
    case .prohibited: return "prohibited"
    @unknown default: return "unknown"
    }
  }

  /// Is the panel in the window server's on-screen list? Reads only window
  /// METADATA (no Screen Recording grant involved — that gates images, not the
  /// list), filtered to our own pid.
  private func windowServerSeesPanel() -> Bool {
    guard
      let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]]
    else { return false }
    let me = ProcessInfo.processInfo.processIdentifier
    return list.contains { w in
      (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == me
    }
  }
}

// ── NDJSON pump ──────────────────────────────────────────────────────────────

private func rectsFrom(_ v: Any?) -> [CGRect] {
  guard let arr = v as? [[String: Any]] else { return [] }
  return arr.compactMap { o in
    guard let x = doubleValue(o["x"]), let y = doubleValue(o["y"]),
      let w = doubleValue(o["w"]), let h = doubleValue(o["h"]), w > 0, h > 0
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }
}

private func handleOverlay(
  _ controller: OverlayController, method: String, params: [String: Any]
) -> [String: Any]? {
  switch method {
  case "ping":
    return ["ok": true]
  case "show":
    controller.show()
    return ["ok": true]
  case "hide":
    controller.hide()
    return ["ok": true]
  case "reset":
    controller.reset()
    return ["ok": true]
  case "cursor":
    guard let x = doubleValue(params["x"]), let y = doubleValue(params["y"]) else {
      return ["ok": false, "error": "cursor needs x,y"]
    }
    controller.placeCursor(
      CGPoint(x: x, y: y), travelMs: doubleValue(params["ms"]) ?? DEFAULT_TRAVEL_MS)
    return ["ok": true]
  case "order-test":
    /*
     * CAN WE SIT DIRECTLY ABOVE ANOTHER APP'S WINDOW?
     *
     * the user: "there's no way it's impossible to do this overlay window stacking
     * thing, oai were able to do it so we can too." He is right that I asserted
     * this instead of measuring it, so this measures it: order our panel
     * relative to a window number we do not own, then read the real z-order back
     * out of the window server and report what actually happened.
     */
    guard let target = doubleValue(params["windowId"]).map({ Int($0) }) else {
      return ["ok": false, "error": "order-test needs windowId"]
    }
    return controller.orderRelativeTest(
      targetWindowNumber: target, mode: (params["mode"] as? String) ?? "read-only")
  case "target":
    if let x = doubleValue(params["x"]), let y = doubleValue(params["y"]),
      let w = doubleValue(params["w"]), let h = doubleValue(params["h"])
    {
      let rect = CGRect(x: x, y: y, width: w, height: h)
      let win = doubleValue(params["windowNumber"]).map { Int($0) }
      /* A re-targeting of the SAME window at a new place is a move the Node
         tracker saw — it rides it here, by the delta against the rect we hold,
         exactly as the AX watcher does. Both sources converge on the same rect,
         so a move both of them report shifts the phantom once. (The watcher can
         miss a move — an app that never posts kAXMovedNotification — and then
         this is the only ride there is.) A different window number is a new
         window, not a move: nothing shifts. */
      let sameWindow = win == nil || !controller.isTrackingOtherWindow(than: win!)
      if controller.masksNatively, controller.hasWindowRect, sameWindow {
        // Node was told `nativeFollow` and pushes no shift of its own — see the
        // reply below — so this ride is the only one. Without native masking
        // Node shifts, and a ride here on top of it would be the double move.
        controller.followWindow(to: rect, windowNumber: win)
      } else {
        controller.setWindowRect(rect)
      }
      /* Watch the app itself from here: a move or resize is then pushed to us
         the instant it happens, instead of being sampled for. */
      if let pid = doubleValue(params["pid"]), pid > 0 { watchWindowChanges(pid: pid_t(pid)) }
      /* And sit directly above its window, which is the layering itself. The
         pid alone is enough to mask by (see refreshOcclusion); the number, when
         known, is the fallback anchor. */
      let pid = doubleValue(params["pid"]).map { pid_t($0) } ?? 0
      if let win = win {
        controller.trackWindow(number: win, pid: pid)
      } else if pid > 0 {
        controller.trackWindow(number: 0, pid: pid)
      } else {
        // Nothing to anchor on: the Node side masks (and follows) from here.
        controller.untrackWindow()
      }
    } else {
      controller.setWindowRect(nil)
      controller.untrackWindow()
      stopWatchingWindowChanges()
    }
    /* The Node side stops sampling occlusion and stops hiding the overlay once
       the helper is cutting the mask itself — see overlayShouldShow. */
    return [
      "ok": true, "nativeMask": controller.masksNatively,
      // The helper rides window moves itself now, so Node must stop pushing its
      // own (later, staler) shift on top — that double-move WAS the snap.
      "nativeFollow": controller.masksNatively,
    ]
  case "pill":
    controller.setPillEnabled(boolValue(params["enabled"]) ?? true)
    return ["ok": true]
  case "prefill":
    /* nil clears it; a number 0...1 expands the pill and fills the bar. */
    controller.setPrefill(doubleValue(params["fraction"]))
    return ["ok": true]
  case "shift":
    controller.shiftCursor(dx: doubleValue(params["dx"]) ?? 0, dy: doubleValue(params["dy"]) ?? 0)
    return ["ok": true]
  case "click":
    guard let x = doubleValue(params["x"]), let y = doubleValue(params["y"]) else {
      return ["ok": false, "error": "click needs x,y"]
    }
    controller.click(at: CGPoint(x: x, y: y))
    return ["ok": true]
  case "status":
    controller.setStatus(
      (params["status"] as? String) ?? "thinking", text: (params["text"] as? String) ?? "")
    return ["ok": true]
  case "hideBubble":
    controller.hideBubble()
    return ["ok": true]
  case "occluders":
    controller.setOccluders(rectsFrom(params["rects"]))
    return ["ok": true]
  case "backdrop":
    var over: CGRect?
    if let x = doubleValue(params["x"]), let y = doubleValue(params["y"]),
      let w = doubleValue(params["w"]), let h = doubleValue(params["h"]), w > 0, h > 0
    {
      over = CGRect(x: x, y: y, width: w, height: h)
    }
    controller.setBackdrop(params["color"] as? String, over: over)
    return ["ok": true]
  case "render":
    guard let path = params["path"] as? String, !path.isEmpty else {
      return ["ok": false, "error": "render needs a path"]
    }
    var rect: CGRect?
    if let x = doubleValue(params["x"]), let y = doubleValue(params["y"]),
      let w = doubleValue(params["w"]), let h = doubleValue(params["h"]), w > 0, h > 0
    {
      rect = CGRect(x: x, y: y, width: w, height: h)
    }
    let ok = controller.render(
      to: path, rect: rect, scale: CGFloat(doubleValue(params["scale"]) ?? 2))
    return ["ok": ok, "path": path]
  case "controls-hover":
    /* Probe seam for the pill's buttons: hover them without a pointer, so they
       can be rendered and looked at while the user's mouse stays where it is. */
    controller.previewControlsHover(
      boolValue(params["on"]) ?? true, hot: doubleValue(params["hot"]).map { Int($0) })
    return ["ok": true]
  case "info":
    return controller.info()
  case "zorder":
    /* What the mask sees: the on-screen list front-to-back, as the occlusion
       pass reads it — for probes that need a real two-window layout and for a
       field report that has to say which window was over the phantom. */
    let list =
      (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    let rows: [[String: Any]] = list.map { w in
      var d: [String: Any] = [
        "number": (w[kCGWindowNumber as String] as? Int) ?? -1,
        "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? -1,
        "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
        "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
        "alpha": (w[kCGWindowAlpha as String] as? Double) ?? 1,
      ]
      if let raw = w[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: raw)
      {
        // CG bounds are already top-left origin; nothing to flip.
        d["x"] = Double(r.minX)
        d["y"] = Double(r.minY)
        d["w"] = Double(r.width)
        d["h"] = Double(r.height)
      }
      return d
    }
    return ["ok": true, "windows": rows]
  case "quit":
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exit(0) }
    return ["ok": true]
  default:
    return nil
  }
}

/// `pi-mac --overlay`: run the phantom-cursor panel and pump NDJSON commands.
///
/// Activation policy: `.prohibited`, the same one main.swift sets for every
/// other mode, kept because a prohibited app can never be activated — which is
/// the strongest available guarantee that the overlay cannot take the user's
/// focus. MEASURED on macOS 26: the panel displays fine under it, contradicting
/// the documented "may not create windows". See verifyDisplayedOnce() for the
/// fallback that catches a future macOS enforcing the docs.
func runOverlay() {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let controller = OverlayController()
  /* The pill's buttons are the one thing in the overlay a person can press, so
     they are the one thing that talks back. */
  controller.onBrake = { action in emitEvent("overlay-brake", data: ["action": action]) }
  repinLiveController = { [weak controller] in controller?.refreshOcclusion() }
  followLiveController = { [weak controller] rect, num in
    controller?.followWindow(to: rect, windowNumber: num)
  }
  watchActivationChanges()

  let pump = Thread {
    while let line = readLine(strippingNewline: true) {
      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        emitError(id: nil, message: "malformed request")
        continue
      }
      let id = (obj["id"] as? NSNumber)?.intValue
      guard let method = obj["method"] as? String else {
        emitError(id: id, message: "missing method")
        continue
      }
      let params = (obj["params"] as? [String: Any]) ?? [:]
      // .sync, not .async: CoreAnimation is main-thread-only AND responses must
      // come back in request order (the Node client correlates by id but the
      // probe reads state right after driving it).
      DispatchQueue.main.sync {
        if let result = handleOverlay(controller, method: method, params: params) {
          /* Anything that moves the phantom or the window under it changes
             what covers it, so the mask is re-cut on the same beat rather than
             waiting up to a frame for the timer. */
          controller.refreshOcclusion()
          emitResult(id: id, result: result)
        } else {
          emitError(id: id, message: "unknown method: \(method)")
        }
      }
    }
    // stdin closed — Electron main is gone, so is any reason to keep painting.
    exit(0)
  }
  pump.name = "pi-mac-overlay-stdin"
  pump.start()

  NSApplication.shared.run()
}
