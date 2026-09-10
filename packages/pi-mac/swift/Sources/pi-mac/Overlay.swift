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

  /// Three equal slots along the right-hand end of the pill.
  private func slots() -> [NSRect] {
    let side = min(bounds.height - 6, 18)
    let gap: CGFloat = 4
    var x = bounds.maxX - 6 - side
    var out: [NSRect] = []
    for _ in 0..<3 {
      out.append(NSRect(x: x, y: (bounds.height - side) / 2, width: side, height: side))
      x -= side + gap
    }
    return out  // [stop, pause, hide]
  }

  private func slotAt(_ p: NSPoint) -> Int? {
    for (i, r) in slots().enumerated() where r.insetBy(dx: -3, dy: -3).contains(p) { return i }
    return nil
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
    for (i, r) in rects.enumerated() {
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
      default:  // hide — an eye with a slash
        ctx.move(to: CGPoint(x: inset.minX, y: inset.midY))
        ctx.addLine(to: CGPoint(x: inset.maxX, y: inset.midY))
        ctx.move(to: CGPoint(x: inset.minX, y: inset.minY))
        ctx.addLine(to: CGPoint(x: inset.maxX, y: inset.maxY))
        ctx.strokePath()
      }
    }
  }
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
  private var liveRipples = 0
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
    win.level = .floating
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
    let showing = pillEnabled && bubble.opacity > 0.4 && panel.isVisible
    if !showing {
      if win.isVisible { win.orderOut(nil) }
      return
    }
    /* The pill's frame in Cocoa screen points — the same conversion info()
       reports it with, so the controls sit exactly on it. */
    let local = (bubble.presentation() ?? bubble).frame
    let f = local.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
    win.setFrame(f, display: false)
    view.frame = CGRect(origin: .zero, size: f.size)
    view.needsDisplay = true
    if !win.isVisible { win.order(.above, relativeTo: panel.windowNumber) }
  }

  /// While the controls are up, whatever the pill was saying goes soft — the
  /// buttons are the subject then, not the words behind them.
  private func setBubbleBlurred(_ on: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.16)
    bubbleText.opacity = on ? 0.18 : 1
    bubbleSub.opacity = on ? 0.18 : 1
    for d in bubbleDots { d.opacity = on ? 0.12 : (dotsVisible ? 0.45 : 0) }
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
    // `.floating` — NOT `.screenSaver`. macOS window levels are global bands,
    // not per-app, so nothing at this layer can be truly z-sandwiched between
    // the controlled app and the rest of the desktop; parking at the LOWEST
    // level that still reads over a normal window keeps the phantom out of the
    // way of system UI, and the occluder mask (see setOccluders) does the real
    // z-scoping.
    panel.level = .floating
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
    if panel.isVisible { panel.orderOut(nil) }
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
    ripple(at: ax, delay: 0)
    ripple(at: ax, delay: 0.13)
  }

  private func pressPop() {
    let pop = CAKeyframeAnimation(keyPath: "transform.scale")
    pop.values = [1.0, 0.84, 1.08, 1.0]
    pop.keyTimes = [0, 0.38, 0.7, 1]
    pop.duration = 0.34
    pop.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.7, 0.3, 1.25)
    // The group is anchored on the tip, so the pop radiates from the hotspot.
    cursorGroup.add(pop, forKey: "press")
  }

  private func ripple(at ax: CGPoint, delay: Double) {
    let p = local(ax)
    liveRipples += 1
    let r = CAShapeLayer()
    let d: CGFloat = 18
    r.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    r.position = p
    r.path = CGPath(ellipseIn: CGRect(x: 1.25, y: 1.25, width: d - 2.5, height: d - 2.5), transform: nil)
    r.fillColor = nil
    r.strokeColor = cgColor(0.478, 0.424, 1, 0.95)
    r.lineWidth = 2.5
    r.contentsScale = scale
    r.opacity = 0
    stage.insertSublayer(r, below: cursorGroup)

    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.55
    grow.toValue = 3.1
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.95
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.5
    group.beginTime = CACurrentMediaTime() + delay
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 0.84, 0.44, 1)
    group.fillMode = .backwards
    r.add(group, forKey: "ripple")
    DispatchQueue.main.asyncAfter(deadline: .now() + delay + 0.55) { [weak self] in
      r.removeFromSuperlayer()
      self?.liveRipples = max(0, (self?.liveRipples ?? 1) - 1)
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
  func setWindowRect(_ rect: CGRect?) {
    windowAX = rect
    if bubble.opacity > 0 { layoutBubble() }
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
    let w = contentW + (bare ? padY * 2 : padX * 2)

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
  func setOccluders(_ rects: [CGRect]) {
    maskHoles = rects.count
    guard !rects.isEmpty else {
      stage.mask = nil
      return
    }
    let path = CGMutablePath()
    path.addRect(stage.bounds)
    let flipBase = cocoaFlipBase()
    let frame = panel.frame
    for r in rects {
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
  }

  // ── probe seams ──────────────────────────────────────────────────────────

  /// Paint a solid colour behind the overlay. Probe-only: a transparent PNG of
  /// a white-on-nothing pointer tells a human reviewer nothing, and the cursor
  /// has to be judged against BOTH a light and a dark app.
  func setBackdrop(_ hex: String?) {
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
    backdrop.frame = root.bounds
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
      "floatingLevel": NSWindow.Level.floating.rawValue,
      "appActive": NSApp.isActive,
      "activationPolicy": policyName(NSApp.activationPolicy()),
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "frontmostPid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
      "behavior": [
        "transient": behavior.contains(.transient),
        "canJoinAllSpaces": behavior.contains(.canJoinAllSpaces),
        "ignoresCycle": behavior.contains(.ignoresCycle),
        "fullScreenAuxiliary": behavior.contains(.fullScreenAuxiliary),
        "managed": behavior.contains(.managed),
      ],
      "cursorVisible": (cursorGroup.presentation() ?? cursorGroup).opacity > 0.5,
      "maskHoles": maskHoles,
      "reduceMotion": reduceMotion(),
      "ripples": liveRipples,
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
  case "target":
    if let x = doubleValue(params["x"]), let y = doubleValue(params["y"]),
      let w = doubleValue(params["w"]), let h = doubleValue(params["h"])
    {
      controller.setWindowRect(CGRect(x: x, y: y, width: w, height: h))
    } else {
      controller.setWindowRect(nil)
    }
    return ["ok": true]
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
    controller.setBackdrop(params["color"] as? String)
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
  case "info":
    return controller.info()
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
