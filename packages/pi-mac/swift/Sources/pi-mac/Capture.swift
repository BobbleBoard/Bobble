import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// ── composite capture ────────────────────────────────────────────────────────
//
// The old surface captured ONE CGWindowID with `screencapture -l`. A sheet is
// its own window, so the moment TextEdit put up a save panel the model was
// looking at a picture of the window BEHIND the thing it had to act on.
//
// ScreenCaptureKit composites an explicit SET of windows in one pass, which is
// exactly the right primitive: the app's window plus every sheet/dialog it is
// presenting, over a transparent background, cropped to their union. The same
// filter drives the live stream (Stream.swift), so what the model sees and what
// the user watches are the same picture by construction.

/// Run an async body from the synchronous serve loop. The NDJSON pump is a
/// blocking readLine loop by design (it owns the index map with no locking), so
/// async capture has to hand its result back across a semaphore.
private final class ResultBox<T>: @unchecked Sendable {
  var value: T?
}

func runBlocking<T>(timeout: TimeInterval = 8, _ body: @escaping () async -> T?) -> T? {
  let sem = DispatchSemaphore(value: 0)
  let box = ResultBox<T>()
  Task.detached(priority: .userInitiated) {
    box.value = await body()
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + timeout)
  return box.value
}

/// Backing scale of the display a rect sits on (2 on Retina) — the stream and
/// the screenshot both capture at native pixels so text stays legible.
func scaleFor(rect: CGRect) -> CGFloat {
  for screen in NSScreen.screens where screen.frame.intersects(flipToCocoa(rect)) {
    return screen.backingScaleFactor
  }
  return NSScreen.main?.backingScaleFactor ?? 2
}

/// CGWindowList/AX use a top-left origin on the main display; NSScreen uses a
/// bottom-left origin. Only the y flips.
func flipToCocoa(_ r: CGRect) -> CGRect {
  guard let main = NSScreen.screens.first else { return r }
  return CGRect(x: r.minX, y: main.frame.maxY - r.maxY, width: r.width, height: r.height)
}

struct CaptureTarget {
  let windowIds: [CGWindowID]
  /// Union of the surfaces, in global screen points (top-left origin).
  let rect: CGRect
}

/// Resolve the SCK filter for a set of window ids. Returns nil when none of
/// them are shareable (no Screen Recording grant, or all gone).
@available(macOS 14.0, *)
func contentFilter(for target: CaptureTarget) async -> (SCContentFilter, SCDisplay)? {
  guard
    let content = try? await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: true)
  else { return nil }
  let wanted = Set(target.windowIds)
  let windows = content.windows.filter { wanted.contains($0.windowID) }
  guard !windows.isEmpty else { return nil }
  let display =
    content.displays.first(where: { CGDisplayBounds($0.displayID).intersects(target.rect) })
    ?? content.displays.first
  guard let display else { return nil }
  return (SCContentFilter(display: display, including: windows), display)
}

@available(macOS 14.0, *)
func configuration(for target: CaptureTarget, display: SCDisplay, maxWidth: Int?)
  -> SCStreamConfiguration
{
  let origin = CGDisplayBounds(display.displayID).origin
  let local = target.rect.offsetBy(dx: -origin.x, dy: -origin.y)
  let scale = scaleFor(rect: target.rect)
  var pxW = max(1, Int((target.rect.width * scale).rounded()))
  var pxH = max(1, Int((target.rect.height * scale).rounded()))
  if let maxWidth, pxW > maxWidth {
    pxH = max(1, Int((Double(pxH) * Double(maxWidth) / Double(pxW)).rounded()))
    pxW = maxWidth
  }
  let config = SCStreamConfiguration()
  config.sourceRect = local
  config.width = pxW
  config.height = pxH
  config.scalesToFit = true
  config.showsCursor = false
  config.capturesAudio = false
  config.pixelFormat = kCVPixelFormatType_32BGRA
  config.colorSpaceName = CGColorSpace.sRGB
  // Transparent background: the app's windows are the subject, and the canvas
  // monitor paints the user's own wallpaper behind them.
  config.backgroundColor = .clear
  config.queueDepth = 3
  config.ignoreShadowsSingleWindow = true
  config.ignoreShadowsDisplay = true
  return config
}

/// Composite the given windows into one image. Nil on any failure so callers
/// can fall back to the legacy single-window path.
@available(macOS 14.0, *)
func captureComposite(target: CaptureTarget, maxWidth: Int? = nil) async -> CGImage? {
  guard let (filter, display) = await contentFilter(for: target) else { return nil }
  let config = configuration(for: target, display: display, maxWidth: maxWidth)
  return try? await SCScreenshotManager.captureImage(
    contentFilter: filter, configuration: config)
}

// ── encoding ─────────────────────────────────────────────────────────────────

func encode(_ image: CGImage, as type: UTType, quality: Double = 0.72) -> Data? {
  let data = NSMutableData()
  guard
    let dest = CGImageDestinationCreateWithData(
      data as CFMutableData, type.identifier as CFString, 1, nil)
  else { return nil }
  CGImageDestinationAddImage(
    dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return data as Data
}

func writePNG(_ image: CGImage, prefix: String) -> String? {
  guard let data = encode(image, as: .png) else { return nil }
  let path = (NSTemporaryDirectory() as NSString).appendingPathComponent(
    "\(prefix)-\(Int(Date().timeIntervalSince1970 * 1000)).png")
  return (try? data.write(to: URL(fileURLWithPath: path))) == nil ? nil : path
}

/// The `screenshot`/`snapshot` capture surface: every window the app is
/// presenting, composited, cropped to their union. Falls back to the legacy
/// single-window `screencapture -l` (and then to the whole screen) so a machine
/// without the Screen Recording grant still gets a usable, non-throwing result.
func captureAppSurfaces(pid: pid_t, withBase64: Bool, maxWidth: Int? = nil) -> [String: Any]? {
  let windows = appWindows(pid: pid)
  let ids = windows.compactMap { $0.windowId }
  guard let rect = unionFrame(windows), !ids.isEmpty else { return nil }
  let target = CaptureTarget(windowIds: ids, rect: rect)
  if #available(macOS 14.0, *),
    let image = runBlocking(timeout: 8, { await captureComposite(target: target, maxWidth: maxWidth) }),
    let path = writePNG(image, prefix: "pi-mac-app\(pid)")
  {
    var result: [String: Any] = [
      "path": path, "rect": rectDict(rect), "width": image.width, "height": image.height,
      "windows": windows.map(windowDict), "composite": true,
    ]
    if withBase64, let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
      result["base64"] = data.base64EncodedString()
      result["mimeType"] = "image/png"
    }
    return result
  }
  // Legacy fallbacks — one window, then the whole screen.
  if let first = ids.first, var shot = captureWindow(windowID: first, withBase64: withBase64) {
    shot["rect"] = rectDict(rect)
    shot["windows"] = windows.map(windowDict)
    shot["composite"] = false
    return shot
  }
  return captureScreenshot(withBase64: withBase64)
}

/// The user's desktop picture for the display the app is on — the backdrop the
/// canvas monitor paints behind the streamed window.
func desktopWallpaper(rect: CGRect?) -> [String: Any] {
  let screen =
    (rect.flatMap { r in NSScreen.screens.first { $0.frame.intersects(flipToCocoa(r)) } })
    ?? NSScreen.main
  guard let screen, let url = NSWorkspace.shared.desktopImageURL(for: screen) else {
    return ["ok": false, "error": "no desktop image"]
  }
  return [
    "ok": true, "path": url.path,
    "screen": ["w": screen.frame.width, "h": screen.frame.height],
    "scale": screen.backingScaleFactor,
  ]
}
