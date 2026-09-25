// Regenerates the synthetic `--vision` fixtures in packages/pi-mac/fixtures/vision.
//
//   swiftc -O scripts/make-vision-fixtures.swift -o /tmp/make-vision-fixtures
//   /tmp/make-vision-fixtures fixtures/vision
//
// Dev tooling only — not part of the SwiftPM target, never shipped. The two
// photos (cat.jpg, apples.jpg) are CC0 downloads recorded in fixtures.json;
// everything else is drawn here, headless (bitmap contexts, no window):
//
//   poster.png          an event poster whose every line of text is known, so
//                       OCR can be checked word for word
//   sign-misspelt.png   "FRESH BRAED DAILY": the misspelling an OCR *check* must
//                       report (MEASURED: read literally with correction on
//                       or off; a check still asks for it off)
//   blank.png           nothing in it: no instances, no text
//   cat-rotated.jpg     cat.jpg's pixels stored rotated a quarter turn with EXIF
//                       orientation 6, so it DISPLAYS exactly like cat.jpg —
//                       Vision results must come back in display coordinates
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("make-vision-fixtures: \(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: make-vision-fixtures <fixture dir>") }
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

/// A top-left-origin canvas: callers think in the same coordinates the
/// fixtures' expectations are written in.
func canvas(_ w: Int, _ h: Int, _ draw: (CGContext) -> Void) -> CGImage {
  guard
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { fail("no bitmap context") }
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: 1, y: -1)
  draw(ctx)
  guard let image = ctx.makeImage() else { fail("no image") }
  return image
}

func fill(_ ctx: CGContext, _ rect: CGRect, _ c: CGColor) {
  ctx.setFillColor(c)
  ctx.fill(rect)
}

/// One line of text with its baseline at `baseline` (top-left coordinates).
/// CoreText draws y-up, so the text matrix flips glyphs back upright inside
/// the flipped canvas.
@discardableResult
func text(
  _ ctx: CGContext, _ string: String, font name: String, size: CGFloat, color c: CGColor,
  x: CGFloat, baseline: CGFloat, centerIn width: CGFloat? = nil
) -> CGFloat {
  let font = CTFontCreateWithName(name as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): c,
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attrs))
  let advance = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
  let left = width.map { x + ($0 - advance) / 2 } ?? x
  ctx.saveGState()
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = CGPoint(x: left, y: baseline)
  CTLineDraw(line, ctx)
  ctx.restoreGState()
  return advance
}

func write(_ image: CGImage, _ name: String, type: UTType, properties: [CFString: Any] = [:]) {
  let url = dir.appendingPathComponent(name)
  guard
    let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)
  else { fail("cannot write \(url.path)") }
  CGImageDestinationAddImage(dest, image, properties as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { fail("cannot encode \(url.path)") }
  print("wrote \(name) \(image.width)x\(image.height)")
}

// ── poster.png ──────────────────────────────────────────────────────────────
let ink: UInt32 = 0x16404A
let poster = canvas(900, 1200) { ctx in
  fill(ctx, CGRect(x: 0, y: 0, width: 900, height: 1200), color(0xF3EADB))
  fill(ctx, CGRect(x: 0, y: 0, width: 900, height: 540), color(ink))
  // Lanterns, kept above the title's row: a disc level with a line of text is
  // read as a bullet on that line (MEASURED: "MIDNIGHT •" when one sat beside
  // the T), and the fixture is meant to pin exact lines.
  for (cx, cy, r) in [(752.0, 58.0, 36.0), (836.0, 84.0, 20.0), (676.0, 40.0, 14.0)] {
    ctx.setFillColor(color(0xE8913A))
    ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
  }
  let cream = color(0xF3EADB)
  let title = "AvenirNextCondensed-Heavy"
  text(ctx, "MIDNIGHT", font: title, size: 150, color: cream, x: 64, baseline: 250)
  text(ctx, "MARKET", font: title, size: 150, color: cream, x: 64, baseline: 400)
  let pill = CGPath(
    roundedRect: CGRect(x: 64, y: 444, width: 250, height: 58), cornerWidth: 29,
    cornerHeight: 29, transform: nil)
  ctx.addPath(pill)
  ctx.setFillColor(color(0xD9542F))
  ctx.fillPath()
  text(
    ctx, "LIVE MUSIC", font: "AvenirNext-DemiBold", size: 30, color: color(0xFFFFFF), x: 64,
    baseline: 484, centerIn: 250)
  text(
    ctx, "Street food, vinyl and lanterns", font: "Georgia-Italic", size: 46, color: color(ink),
    x: 64, baseline: 640)
  let body = color(0x2A2A2A)
  text(
    ctx, "Friday 12 June 2026 at 7 PM", font: "AvenirNext-DemiBold", size: 40, color: body,
    x: 64, baseline: 740)
  text(
    ctx, "Harbour Warehouse, Pier 9", font: "AvenirNext-Medium", size: 36, color: body, x: 64,
    baseline: 800)
  fill(ctx, CGRect(x: 64, y: 1040, width: 772, height: 3), color(ink, 0.35))
  text(
    ctx, "Free entry. Bring a friend.", font: "AvenirNext-Regular", size: 28,
    color: color(0x555555), x: 64, baseline: 1110)
}
write(poster, "poster.png", type: .png)

// ── sign-misspelt.png ───────────────────────────────────────────────────────
let sign = canvas(1000, 320) { ctx in
  fill(ctx, CGRect(x: 0, y: 0, width: 1000, height: 320), color(0x23302F))
  text(
    ctx, "FRESH BRAED DAILY", font: "AvenirNext-Bold", size: 92, color: color(0xF3EADB), x: 0,
    baseline: 196, centerIn: 1000)
}
write(sign, "sign-misspelt.png", type: .png)

// ── blank.png ───────────────────────────────────────────────────────────────
let blank = canvas(320, 240) { ctx in
  fill(ctx, CGRect(x: 0, y: 0, width: 320, height: 240), color(0xE8E4DC))
}
write(blank, "blank.png", type: .png)

// ── cat-rotated.jpg ─────────────────────────────────────────────────────────
// EXIF orientation 6 = "rotate 90° clockwise to display", so the stored pixels
// are the upright picture turned 90° counter-clockwise.
guard let src = CGImageSourceCreateWithURL(dir.appendingPathComponent("cat.jpg") as CFURL, nil),
  let cat = CGImageSourceCreateImageAtIndex(src, 0, nil)
else { fail("cat.jpg missing — it is a download, see fixtures.json") }
guard
  let rot = CGContext(
    data: nil, width: cat.height, height: cat.width, bitsPerComponent: 8, bytesPerRow: 0,
    space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fail("no rotation context") }
rot.translateBy(x: CGFloat(cat.height), y: 0)
rot.rotate(by: .pi / 2)
rot.draw(cat, in: CGRect(x: 0, y: 0, width: cat.width, height: cat.height))
guard let stored = rot.makeImage() else { fail("no rotated image") }
write(
  stored, "cat-rotated.jpg", type: .jpeg,
  properties: [kCGImagePropertyOrientation: 6, kCGImageDestinationLossyCompressionQuality: 0.9])
