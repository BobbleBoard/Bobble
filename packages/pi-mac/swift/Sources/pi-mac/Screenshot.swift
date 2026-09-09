import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// THE PICTURE THE MODEL GETS, AT THE SIZE ITS COORDINATES ARE IN.
///
/// `screencapture` writes native backing pixels: on this Retina Mac a window
/// capture is 3024x1730 and 7.5 MB of PNG. MEASURED once that reached the model
/// (see the CLI image fix): two screenshots cost 11 MB and prefill went to 35.9s
/// and 34.4s on a single turn. A screenshot that costs half a minute to look at
/// is not a perception surface.
///
/// Downscaling to POINTS rather than to some arbitrary budget is also the
/// correct size, not merely a smaller one: `mac click --x --y` takes screen
/// POINTS, so a 2x image forced the model to halve every coordinate it read off
/// the picture. At 1x the image's own pixel coordinates ARE the coordinates the
/// tool wants, and that arithmetic disappears.
///
/// The cap is a backstop for a display large enough that even 1x is expensive.
private let maxImageSide = 1600

/// Re-encode a captured PNG as a JPEG at `scale` of its pixel size (1/backing
/// scale, i.e. points), capped. Returns base64, the mime type and the size it
/// produced, or nil to let the caller fall back to the original bytes.
private func downscaledJPEG(path: String, backingScale: CGFloat) -> [String: Any]? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
    let pw = props[kCGImagePropertyPixelWidth] as? Int,
    let ph = props[kCGImagePropertyPixelHeight] as? Int
  else { return nil }

  let longest = max(pw, ph)
  let atPoints = Int((CGFloat(longest) / max(backingScale, 1)).rounded())
  let target = min(atPoints, maxImageSide)
  guard target > 0 else { return nil }

  guard
    let image = CGImageSourceCreateThumbnailAtIndex(
      src, 0,
      [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: target,
      ] as CFDictionary)
  else { return nil }

  let out = NSMutableData()
  guard
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)
  else { return nil }
  CGImageDestinationAddImage(
    dest, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }

  return [
    "base64": (out as Data).base64EncodedString(),
    "mimeType": "image/jpeg",
    "width": image.width,
    "height": image.height,
  ]
}

/// The scale of the display a capture came from — the exact divisor that turns
/// backing pixels into points.
private func mainBackingScale() -> CGFloat {
  NSScreen.main?.backingScaleFactor ?? 2
}

/// Capture the screen to a temp PNG via `/usr/sbin/screencapture` (the fallback
/// perception surface for AX-opaque apps). Returns the file path and, when
/// `withBase64` is set, the base64 PNG so the model can see it inline. Best-
/// effort: any failure returns nil rather than throwing. Capturing OTHER apps'
/// pixels requires the Screen Recording grant; without it macOS yields a
/// desktop-only image (still a valid, non-crashing result).
func captureScreenshot(withBase64: Bool) -> [String: Any]? {
  let dir = NSTemporaryDirectory()
  let path = (dir as NSString).appendingPathComponent(
    "pi-mac-\(ProcessInfo.processInfo.processIdentifier)-\(Int(Date().timeIntervalSince1970 * 1000)).png"
  )

  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  // -x: no sound. -o: no window shadow. Whole main display to `path`.
  proc.arguments = ["-x", "-o", path]
  do {
    try proc.run()
    proc.waitUntilExit()
  } catch {
    return nil
  }
  guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
    return nil
  }

  var result: [String: Any] = ["path": path]
  if withBase64 {
    if let small = downscaledJPEG(path: path, backingScale: mainBackingScale()) {
      result.merge(small) { _, new in new }
    } else if let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
      result["base64"] = data.base64EncodedString()
      result["mimeType"] = "image/png"
    }
  }
  return result
}

/// Capture ONE window by its CGWindowID via `screencapture -l <id>`. This
/// composites just that window even when it is occluded or NOT frontmost, and
/// needs no focus — the focus-free perception surface for a background app.
/// Requires the Screen Recording grant. Best-effort → nil on any failure so the
/// caller can fall back to a full-screen capture.
func captureWindow(windowID: CGWindowID, withBase64: Bool) -> [String: Any]? {
  let dir = NSTemporaryDirectory()
  let path = (dir as NSString).appendingPathComponent(
    "pi-mac-win\(windowID)-\(Int(Date().timeIntervalSince1970 * 1000)).png")

  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  // -x: silent. -o: no shadow. -l <id>: only this window (occluded/background OK).
  proc.arguments = ["-x", "-o", "-l", String(windowID), path]
  do {
    try proc.run()
    proc.waitUntilExit()
  } catch {
    return nil
  }
  guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
    return nil
  }

  var result: [String: Any] = ["path": path, "windowId": Int(windowID)]
  if withBase64 {
    if let small = downscaledJPEG(path: path, backingScale: mainBackingScale()) {
      result.merge(small) { _, new in new }
    } else if let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
      result["base64"] = data.base64EncodedString()
      result["mimeType"] = "image/png"
    }
  }
  return result
}
