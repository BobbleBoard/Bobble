import CoreGraphics
import CoreText
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

// pi-mac --vision: Apple Vision on IMAGE FILES for the image editor.
//
//   pi-mac --vision-serve                    → persistent NDJSON loop, same wire
//                                              format as --serve ({ id, method,
//                                              params } in, { id, ok, result |
//                                              error } out). The editor's Mac
//                                              executor keeps one alive.
//   pi-mac --vision <method> [json | path]   → one request, one `{ ok, … }` line,
//                                              exit 0 (ok) or 1 (error).
//
// Methods:
//   info        what this helper can do (protocol version, OCR languages, limits)
//   lift        every foreground instance Vision finds: bbox, area, centroid,
//               and (on request) a soft mask PNG, an RGBA cutout PNG, the union
//               of all instances ("remove background"), and a label map
//   instanceAt  the instance under a tap point (0 = background), optionally
//               snapped to the nearest instance within `radius` pixels
//               (a tap tolerance, capped at 1024)
//   ocr         recognised text as lines (and words) with boxes, reading order
//   forget      drop the cached analysis of one image, or all of them
//   warm        pay the one-time model preparation now (see below)
//
// Why a separate mode from --serve: the computer-use bridge is a single-threaded
// pump whose index map must stay responsive; a Vision request on a 4K image
// takes tens of milliseconds and must never sit in front of a click. A second
// process also means a Vision failure cannot take computer use down with it.
//
// NO PROMPT, NO APP. Everything here reads image FILES (Vision runs on pixels
// we decode ourselves); nothing captures the screen or touches another app.
// main.swift dispatches these modes BEFORE NSApplication is initialised, so the
// process never checks in with LaunchServices: no dock tile is possible. The
// one TCC exchange that remains is not ours — Vision's model runtime opens a
// window-server connection and SkyLight/WindowServer check Input Monitoring
// for it — and MEASURED in tccd's log every such request is `preflight=true`:
// a silent status read that cannot put up a permission prompt.
//
// THE FIRST ACCURATE OCR OF EVERY NEW BUILD IS SLOW. MEASURED on this M5
// (macOS 27.2): ~29 s once — ~16 s preparing text detection (even on a blank
// image) and ~13 s preparing recognition (on the first image with text) —
// then ~0.1 s per poster. The OS caches the prepared models under the
// executable's NAME (~/Library/Caches/pi-mac/com.apple.e5rt.e5bundlecache) for
// ONE signed identity at a time. MEASURED: a byte-identical copy at another
// path hits the cache; the same bytes re-signed recompile and take the cache
// over, after which the original identity recompiles too. So each shipped
// build pays once per user, and a dev build alternating with the shipped
// helper pays on every switch. `warm` exists so the editor can pay it before
// a person waits; the lift model and the fast OCR level showed no such cost
// (~0.1 s cold).
//
// COORDINATES are image pixels with a TOP-LEFT origin, in the image's DISPLAYED
// orientation (EXIF orientation applied) — the space the editor's canvas draws
// in. Vision's own normalized, bottom-left coordinates never leave this file.
//
// Every failure becomes an error line; nothing here may crash the process.

// ── entry points ─────────────────────────────────────────────────────────────

/// `pi-mac --vision-serve`: one request per stdin line until EOF. The parent
/// closing the pipe (quit, crash, SIGKILL) ends the loop, so the helper can
/// never outlive the app that spawned it.
func runVisionServe() {
  while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    guard let data = line.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      emitError(id: nil, message: "malformed request")
      continue
    }
    let id = PiVision.int(obj["id"])
    guard let method = obj["method"] as? String else {
      emitError(id: id, message: "missing method")
      continue
    }
    let params = (obj["params"] as? [String: Any]) ?? [:]
    // A long-lived loop on the main thread has no run loop draining the
    // autorelease pool, and Vision hands back large autoreleased buffers
    // (a 4K float mask is 33 MB). Drain after every request.
    autoreleasepool {
      do {
        let result = try PiVision.handle(method: method, params: params)
        emitResult(id: id, result: result)
      } catch {
        emitError(id: id, message: PiVision.describe(error))
      }
    }
  }
}

/// `pi-mac --vision <method> [<json params> | <image path>]`.
func runVisionCommand(_ argv: [String]) {
  guard let method = argv.first else {
    writeStderr(
      "usage: pi-mac --vision <info|lift|instanceAt|ocr|forget|warm>"
        + " [<json params> | <image path>]\n")
    exit(2)
  }
  var params: [String: Any] = [:]
  if argv.count > 1 {
    let arg = argv[1]
    if arg.hasPrefix("{") {
      guard let data = arg.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        emitError(id: nil, message: "params are not a JSON object")
        exit(1)
      }
      params = obj
    } else {
      params["image"] = arg
    }
  }
  var ok = false
  autoreleasepool {
    do {
      let result = try PiVision.handle(method: method, params: params)
      emitResult(id: nil, result: result)
      ok = true
    } catch {
      emitError(id: nil, message: PiVision.describe(error))
    }
  }
  exit(ok ? 0 : 1)
}

// ── implementation ───────────────────────────────────────────────────────────

enum PiVision {
  /// Bumped when a result shape changes incompatibly. The TS client checks it.
  static let protocolVersion = 1
  /// A decoded image, its masks and its label map all live at full resolution;
  /// past this many pixels the memory cost stops being a helper's to pay.
  /// 64 MP holds a 48 MP phone photo with room to spare. MEASURED at 61 MP
  /// (9600×6400, three instances): analysis 0.7 s, lift writing five
  /// full-size files 3.8 s, 737 MB held by the cache, 2.4 GB peak RSS.
  static let defaultMaxPixels = 64_000_000
  /// Analyses kept warm. Two covers "the picture being edited plus the one
  /// before it" without letting a session of 4K edits grow the helper forever.
  static let cacheCapacity = 2
  /// …and at most this many bytes of them (decoded picture, masks, label map,
  /// cutout pixels). The most recent analysis always stays — it is the one
  /// being worked on — so the ceiling is this plus one picture's worth, never
  /// two 64 MP pictures with a dozen instances each. PI_MAC_VISION_CACHE_MB
  /// overrides it (the probe shrinks it to watch eviction happen).
  static let cacheBudgetBytes: Int = {
    let env = ProcessInfo.processInfo.environment["PI_MAC_VISION_CACHE_MB"]
    // Clamped (1 TB) before the multiply: a typo must not trap the helper.
    if let mb = env.flatMap({ Int($0) }), mb >= 0 { return min(mb, 1 << 20) * 1_048_576 }
    return 768 * 1_048_576
  }()
  /// A soft mask value counts as "inside" at or above this (0…255).
  static let inside: UInt8 = 128
  /// `instanceAt`'s snap radius is a tap tolerance; past this it is clamped.
  static let maxSnapRadius = 1024.0

  static let liftOutputs: Set<String> = [
    "mask", "cutout", "foregroundMask", "foregroundCutout", "labels",
  ]
  static let instanceOutputs: Set<String> = ["mask", "cutout"]

  struct Failure: Error {
    let message: String
    init(_ message: String) { self.message = message }
  }

  static func describe(_ error: Error) -> String {
    if let f = error as? Failure { return f.message }
    return "\(error.localizedDescription)"
  }

  // ── params ────────────────────────────────────────────────────────────────

  /// Whole part of a finite number, clamped far inside Int's range — so a
  /// hostile or mistaken 1e300 is a big number, never a trap.
  static func int(_ v: Any?) -> Int? {
    guard let d = double(v), d.isFinite else { return nil }
    return Int(max(-1e15, min(1e15, d)).rounded(.towardZero))
  }
  static func double(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
  }
  static func bool(_ v: Any?, _ fallback: Bool) -> Bool {
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    return fallback
  }
  static func string(_ v: Any?) -> String? {
    guard let s = v as? String, !s.isEmpty else { return nil }
    return s
  }
  static func strings(_ v: Any?) -> [String]? {
    if let a = v as? [String] { return a }
    if let s = v as? String { return [s] }
    return nil
  }
  /// A list of whole numbers, or an error — 1.9 is not quietly instance 1.
  static func wholeNumbers(_ v: Any?, _ name: String) throws -> [Int]? {
    guard let v else { return nil }
    guard let list = v as? [Any] else { throw Failure("\(name) must be a list of whole numbers") }
    return try list.map { item in
      guard let d = double(item), d.isFinite, d == d.rounded(), abs(d) < 1e9 else {
        throw Failure("\(name) must be a list of whole numbers")
      }
      return Int(d)
    }
  }

  /// An absolute, standardized path; a relative one resolves against the
  /// helper's working directory (handy from a shell, never used by the app).
  static func imagePath(_ params: [String: Any]) throws -> String {
    guard let raw = string(params["image"]) else {
      throw Failure("missing image (an image file path)")
    }
    let expanded = (raw as NSString).expandingTildeInPath
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let url =
      expanded.hasPrefix("/")
      ? URL(fileURLWithPath: expanded) : cwd.appendingPathComponent(expanded)
    // `.standardized`, not `.standardizedFileURL`: the latter also strips a
    // leading /private, so a caller that sent /private/tmp/x.png would get
    // /tmp/x.png echoed back and fail to match its own path.
    return url.standardized.path
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  static func handle(method: String, params: [String: Any]) throws -> [String: Any] {
    defer { trimCache() }
    switch method {
    case "info", "ping": return info()
    case "lift": return try lift(params)
    case "instanceAt", "instance-at": return try instanceAt(params)
    case "ocr": return try ocr(params)
    case "forget": return try forget(params)
    case "warm": return try warm()
    default: throw Failure("unknown method: \(method)")
    }
  }

  // ── the analysis cache ────────────────────────────────────────────────────

  struct Stats {
    /// Pixels at or above `inside`: the instance proper.
    let minX: Int, minY: Int, maxX: Int, maxY: Int
    let pixels: Int
    let cx: Double, cy: Double
    /// Every pixel with any coverage at all — the soft edge included. A
    /// cropped cutout uses this, so no semi-transparent fringe is cut off.
    let extentMinX: Int, extentMinY: Int, extentMaxX: Int, extentMaxY: Int
  }

  final class Analysis {
    let key: String
    let path: String
    let width: Int
    let height: Int
    let orientation: Int
    let image: CGImage
    let handler: VNImageRequestHandler
    /// A short content tag (path, size, mtime) that makes default output
    /// names unique per image VERSION, so a renderer caching by URL can never
    /// show last version's mask for this version's picture.
    let tag: String

    var lifted = false
    var liftMs = 0
    var indices: [Int] = []
    var masks: [Int: [UInt8]] = [:]
    var stats: [Int: Stats] = [:]
    var labels: [UInt8] = []
    /// Straight-alpha RGBA of the source, decoded on the first cutout.
    var rgba: [UInt8]?
    var rgbaSpace: CGColorSpace?

    /// What this analysis keeps alive, for the cache budget.
    var bytes: Int {
      width * height * 4 + masks.values.reduce(0) { $0 + $1.count } + labels.count
        + (rgba?.count ?? 0)
    }

    init(
      key: String, path: String, width: Int, height: Int, orientation: Int, image: CGImage,
      tag: String
    ) {
      self.key = key
      self.path = path
      self.width = width
      self.height = height
      self.orientation = orientation
      self.image = image
      self.tag = tag
      self.handler = VNImageRequestHandler(cgImage: image, options: [:])
    }
  }

  /// Most recently used last.
  private static var cache: [Analysis] = []

  static func analysis(_ params: [String: Any]) throws -> (Analysis, Bool) {
    let path = try imagePath(params)
    let attrs: [FileAttributeKey: Any]
    do {
      attrs = try FileManager.default.attributesOfItem(atPath: path)
    } catch {
      throw Failure("image not found: \(path)")
    }
    let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
    let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let key = "\(path)|\(size)|\(mtime)"
    let maxPixels = int(params["maxPixels"]) ?? defaultMaxPixels
    if let i = cache.firstIndex(where: { $0.key == key }) {
      let hit = cache.remove(at: i)
      cache.append(hit)
      // The limit is the caller's to set per request, cached or not.
      try checkSize(hit.width, hit.height, maxPixels)
      return (hit, true)
    }
    let fresh = try load(path: path, key: key, maxPixels: maxPixels)
    // A file that changed on disk replaces its stale analysis outright.
    cache.removeAll { $0.path == path }
    cache.append(fresh)
    trimCache()
    return (fresh, false)
  }

  static func checkSize(_ w: Int, _ h: Int, _ maxPixels: Int) throws {
    guard w * h <= maxPixels else {
      throw Failure(
        "image is too large to analyse (\(w)×\(h) is \(megapixels(w * h)), the limit is"
          + " \(megapixels(maxPixels)))")
    }
  }

  static func megapixels(_ pixels: Int) -> String {
    String(format: "%.1f MP", Double(pixels) / 1_000_000)
  }

  static var cacheBytes: Int { cache.reduce(0) { $0 + $1.bytes } }

  /// Oldest first, until both the count and the byte budget fit — never the
  /// most recent analysis, which is the picture being worked on. Run after
  /// every request, because an analysis grows (masks, cutout pixels) after it
  /// is first cached.
  static func trimCache() {
    while cache.count > 1, cache.count > cacheCapacity || cacheBytes > cacheBudgetBytes {
      cache.removeFirst()
    }
  }

  /// Decode with the EXIF orientation APPLIED, so every coordinate and mask is
  /// in the orientation a browser or Preview displays.
  static func load(path: String, key: String, maxPixels: Int) throws -> Analysis {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(src) > 0
    else { throw Failure("could not read image: \(path)") }
    let props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
    let pw = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let ph = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
    let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    guard pw > 0, ph > 0 else { throw Failure("could not decode image: \(path)") }
    try checkSize(pw, ph, maxPixels)
    let decoded: CGImage?
    if orientation == 1 {
      decoded = CGImageSourceCreateImageAtIndex(
        src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    } else {
      decoded = CGImageSourceCreateThumbnailAtIndex(
        src, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: max(pw, ph),
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }
    guard let image = decoded, image.width > 0, image.height > 0 else {
      throw Failure("could not decode image: \(path)")
    }
    return Analysis(
      key: key, path: path, width: image.width, height: image.height, orientation: orientation,
      image: image, tag: shortHash(key))
  }

  /// FNV-1a, 32 bits as 8 hex digits — a file-name tag, not a security boundary.
  static func shortHash(_ s: String) -> String {
    var h: UInt32 = 2_166_136_261
    for b in s.utf8 {
      h ^= UInt32(b)
      h = h &* 16_777_619
    }
    return String(format: "%08x", h)
  }

  static func ms(since t0: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
  }

  // ── lifting: instance masks at full resolution ────────────────────────────

  /// Run the foreground-instance request once per image and keep, per
  /// instance, an 8-bit soft mask at FULL resolution plus its stats, and a
  /// label map (argmax over the masks) for O(1) point lookups.
  ///
  /// Vision's own `instanceMask` is 512×512 whatever the aspect ratio; the
  /// scaled masks are what line up with the picture's pixels, so everything
  /// downstream is derived from them.
  static func ensureLift(_ a: Analysis) throws {
    if a.lifted { return }
    let t0 = DispatchTime.now()
    let request = VNGenerateForegroundInstanceMaskRequest()
    do {
      try a.handler.perform([request])
    } catch {
      throw Failure("Vision could not analyse the image: \(error.localizedDescription)")
    }
    let w = a.width
    let h = a.height
    var labels = [UInt8](repeating: 0, count: w * h)
    var indices: [Int] = []
    if let observation = request.results?.first {
      var best = [UInt8](repeating: 0, count: w * h)
      for index in observation.allInstances.sorted() where index > 0 && index < 256 {
        // One full-size float mask alive at a time (a 48 MP one is ~195 MB):
        // the pool drains it before the next instance's is made.
        let mask: [UInt8] = try autoreleasepool {
          let buffer: CVPixelBuffer
          do {
            buffer = try observation.generateScaledMaskForImage(
              forInstances: IndexSet(integer: index), from: a.handler)
          } catch {
            throw Failure(
              "Vision could not scale the mask of instance \(index): \(error.localizedDescription)")
          }
          return try bytes(of: buffer, width: w, height: h)
        }
        guard let s = stats(of: mask, width: w, height: h) else { continue }
        // The label map: each pixel belongs to the instance that covers it
        // most, provided that one covers it at least halfway.
        mask.withUnsafeBufferPointer { m in
          labels.withUnsafeMutableBufferPointer { l in
            best.withUnsafeMutableBufferPointer { b in
              for i in 0..<(w * h) where m[i] >= inside && m[i] > b[i] {
                b[i] = m[i]
                l[i] = UInt8(index)
              }
            }
          }
        }
        a.masks[index] = mask
        a.stats[index] = s
        indices.append(index)
      }
    }
    a.indices = indices
    a.labels = labels
    a.lifted = true
    a.liftMs = ms(since: t0)
  }

  /// A Vision mask buffer (32-bit float or 8-bit, one component) as 8-bit
  /// values at exactly `width`×`height` — resampled nearest-neighbour in the
  /// unexpected case that Vision hands back another size.
  static func bytes(of buffer: CVPixelBuffer, width w: Int, height h: Int) throws -> [UInt8] {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_OneComponent32Float
      || format == kCVPixelFormatType_OneComponent8
    else { throw Failure("unexpected Vision mask format \(format)") }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw Failure("empty Vision mask") }
    let bw = CVPixelBufferGetWidth(buffer)
    let bh = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    var out = [UInt8](repeating: 0, count: w * h)
    out.withUnsafeMutableBufferPointer { o in
      for y in 0..<h {
        let sy = bh == h ? y : min(bh - 1, y * bh / h)
        let row = base.advanced(by: sy * stride)
        if format == kCVPixelFormatType_OneComponent32Float {
          let f = row.assumingMemoryBound(to: Float32.self)
          for x in 0..<w {
            let sx = bw == w ? x : min(bw - 1, x * bw / w)
            let v = f[sx]
            // `v > 0` is false for NaN too, so a bad value reads as outside
            // rather than trapping in the UInt8 conversion.
            o[y * w + x] = v > 0 ? (v < 1 ? UInt8((v * 255).rounded()) : 255) : 0
          }
        } else {
          let b = row.assumingMemoryBound(to: UInt8.self)
          for x in 0..<w {
            o[y * w + x] = b[bw == w ? x : min(bw - 1, x * bw / w)]
          }
        }
      }
    }
    return out
  }

  /// Bounding box, pixel count and centroid of a soft mask; nil when nothing
  /// in it reaches `inside` (an instance too faint to be one).
  static func stats(of mask: [UInt8], width w: Int, height h: Int) -> Stats? {
    var minX = Int.max
    var minY = Int.max
    var maxX = -1
    var maxY = -1
    var eMinX = Int.max
    var eMinY = Int.max
    var eMaxX = -1
    var eMaxY = -1
    var count = 0
    var sx = 0.0
    var sy = 0.0
    mask.withUnsafeBufferPointer { m in
      for y in 0..<h {
        let row = y * w
        var rowCount = 0
        var rowSum = 0
        for x in 0..<w {
          let v = m[row + x]
          if v == 0 { continue }
          if x < eMinX { eMinX = x }
          if x > eMaxX { eMaxX = x }
          if y < eMinY { eMinY = y }
          if y > eMaxY { eMaxY = y }
          if v < inside { continue }
          if x < minX { minX = x }
          if x > maxX { maxX = x }
          rowCount += 1
          rowSum += x
        }
        if rowCount > 0 {
          if y < minY { minY = y }
          if y > maxY { maxY = y }
          count += rowCount
          sx += Double(rowSum)
          sy += Double(rowCount) * Double(y)
        }
      }
    }
    guard count > 0 else { return nil }
    return Stats(
      minX: minX, minY: minY, maxX: maxX, maxY: maxY, pixels: count,
      cx: sx / Double(count) + 0.5, cy: sy / Double(count) + 0.5,
      extentMinX: eMinX, extentMinY: eMinY, extentMaxX: eMaxX, extentMaxY: eMaxY)
  }

  /// A number for the wire, rounded to `places` decimals and serialised as
  /// exactly that — "528.17", never "528.16999999999996".
  static func num(_ v: Double, _ places: Int) -> NSNumber {
    guard v.isFinite else { return NSNumber(value: 0) }
    return NSDecimalNumber(string: String(format: "%.\(places)f", v))
  }
  static func round2(_ v: Double) -> NSNumber { num(v, 2) }
  static func round6(_ v: Double) -> NSNumber { num(v, 6) }

  static func box(_ x: Int, _ y: Int, _ w: Int, _ h: Int) -> [String: Any] {
    ["x": x, "y": y, "width": w, "height": h]
  }

  static func statsDict(_ s: Stats, _ a: Analysis) -> [String: Any] {
    [
      "bbox": box(s.minX, s.minY, s.maxX - s.minX + 1, s.maxY - s.minY + 1),
      "area": round6(Double(s.pixels) / Double(a.width * a.height)),
      "pixels": s.pixels,
      "center": ["x": round2(s.cx), "y": round2(s.cy)],
    ]
  }

  // ── output files ──────────────────────────────────────────────────────────

  static func outputDir(_ params: [String: Any]) throws -> URL {
    let dir: URL
    if let out = string(params["out"]) {
      dir = URL(fileURLWithPath: (out as NSString).expandingTildeInPath).standardized
    } else {
      dir = FileManager.default.temporaryDirectory.appendingPathComponent(
        "pi-mac-vision", isDirectory: true)
    }
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      throw Failure("cannot create output folder \(dir.path): \(error.localizedDescription)")
    }
    return dir
  }

  /// File-name prefix: the caller's (made safe — it can never climb out of the
  /// output folder), else "<image name>-<content tag>".
  static func prefix(_ a: Analysis, _ params: [String: Any]) -> String {
    let raw =
      string(params["prefix"])
      ?? "\(((a.path as NSString).lastPathComponent as NSString).deletingPathExtension)-\(a.tag)"
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    var safe = String(raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" })
    while safe.hasPrefix(".") { safe.removeFirst() }
    return safe.isEmpty ? "image-\(a.tag)" : safe
  }

  /// PNG via a temp file + rename, so a reader never sees half a picture.
  static func writePNG(_ image: CGImage, to url: URL) throws {
    let tmp = url.deletingLastPathComponent().appendingPathComponent(
      ".\(url.lastPathComponent).\(getpid()).tmp")
    guard
      let dest = CGImageDestinationCreateWithURL(
        tmp as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw Failure("cannot write \(url.path)") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
      try? FileManager.default.removeItem(at: tmp)
      throw Failure("cannot encode \(url.path)")
    }
    guard rename(tmp.path, url.path) == 0 else {
      try? FileManager.default.removeItem(at: tmp)
      throw Failure("cannot move \(url.path) into place")
    }
  }

  /// An 8-bit single-channel PNG: 0 = outside, 255 = inside, soft in between.
  /// Device gray on purpose: a mask is data, not a colour, and must reach the
  /// stitcher with the values it was written with.
  static func writeGray(_ values: [UInt8], _ w: Int, _ h: Int, to url: URL) throws {
    guard
      let provider = CGDataProvider(data: Data(values) as CFData),
      let image = CGImage(
        width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w,
        space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw Failure("cannot build mask image") }
    try writePNG(image, to: url)
  }

  /// The source as STRAIGHT (un-premultiplied) RGBA in its own RGB colour
  /// space, so a cutout keeps the original pixel values wherever it is opaque.
  static func sourceRGBA(_ a: Analysis) throws -> ([UInt8], CGColorSpace) {
    if let rgba = a.rgba, let space = a.rgbaSpace { return (rgba, space) }
    let w = a.width
    let h = a.height
    // The image's own RGB space first (Display P3 stays P3, byte for byte);
    // sRGB when that space cannot back a bitmap context (or is not RGB).
    var spaces: [CGColorSpace] = []
    if let own = a.image.colorSpace, own.model == .rgb { spaces.append(own) }
    if let srgb = CGColorSpace(name: CGColorSpace.sRGB) { spaces.append(srgb) }
    spaces.append(CGColorSpaceCreateDeviceRGB())
    for space in spaces {
      var pixels = [UInt8](repeating: 0, count: w * h * 4)
      let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
        guard
          let ctx = CGContext(
            data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return false }
        ctx.interpolationQuality = .none
        ctx.draw(a.image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
      }
      if !drawn { continue }
      // Un-premultiply. Opaque pixels (every pixel of a photo) are untouched.
      pixels.withUnsafeMutableBufferPointer { p in
        for i in Swift.stride(from: 0, to: w * h * 4, by: 4) {
          let alpha = Int(p[i + 3])
          if alpha == 255 { continue }
          if alpha == 0 {
            p[i] = 0
            p[i + 1] = 0
            p[i + 2] = 0
            continue
          }
          for c in 0..<3 {
            p[i + c] = UInt8(min(255, (Int(p[i + c]) * 255 + alpha / 2) / alpha))
          }
        }
      }
      a.rgba = pixels
      a.rgbaSpace = space
      return (pixels, space)
    }
    throw Failure("cannot decode the image's pixels")
  }

  /// The source's pixels with alpha = source alpha × mask, cropped to `crop`
  /// (x, y, w, h) when given. Fully transparent pixels are zeroed rather than
  /// keeping the background they came from.
  static func writeCutout(
    _ a: Analysis, mask: [UInt8], crop: (Int, Int, Int, Int)?, to url: URL
  ) throws {
    let (source, space) = try sourceRGBA(a)
    let w = a.width
    let (cx, cy, cw, ch) = crop ?? (0, 0, a.width, a.height)
    var out = [UInt8](repeating: 0, count: cw * ch * 4)
    source.withUnsafeBufferPointer { s in
      mask.withUnsafeBufferPointer { m in
        out.withUnsafeMutableBufferPointer { o in
          for y in 0..<ch {
            for x in 0..<cw {
              let si = (y + cy) * w + (x + cx)
              let alpha = (Int(s[si * 4 + 3]) * Int(m[si]) + 127) / 255
              if alpha == 0 { continue }
              let oi = (y * cw + x) * 4
              o[oi] = s[si * 4]
              o[oi + 1] = s[si * 4 + 1]
              o[oi + 2] = s[si * 4 + 2]
              o[oi + 3] = UInt8(alpha)
            }
          }
        }
      }
    }
    guard
      let provider = CGDataProvider(data: Data(out) as CFData),
      let image = CGImage(
        width: cw, height: ch, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: cw * 4,
        space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw Failure("cannot build cutout image") }
    try writePNG(image, to: url)
  }

  /// Which analysis last wrote each output file, and the file's mtime then.
  private static var writtenBy: [String: (key: String, mtime: TimeInterval)] = [:]

  static func mtime(_ path: String) -> TimeInterval? {
    let attrs = try? FileManager.default.attributesOfItem(atPath: path)
    return (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970
  }

  /// Write and return the path — skipping the write only when THIS picture
  /// wrote exactly this file and nothing has touched it since. A prefix two
  /// pictures share would otherwise hand back the other picture's mask.
  ///
  /// The contract: a file under `out` holds exactly what the response says
  /// it holds. One that was edited in place is rewritten on the next request
  /// that names it — the editor copies a mask into its document before it
  /// refines it, never refines the helper's own file.
  static func emitFile(_ a: Analysis, _ url: URL, _ write: () throws -> Void) throws -> String {
    if let last = writtenBy[url.path], last.key == a.key, mtime(url.path) == last.mtime {
      return url.path
    }
    try write()
    if writtenBy.count > 4096 { writtenBy.removeAll() }
    writtenBy[url.path] = (a.key, mtime(url.path) ?? 0)
    return url.path
  }

  static func union(_ a: Analysis, _ indices: [Int]) -> [UInt8] {
    if indices.count == 1, let only = a.masks[indices[0]] { return only }
    var out = [UInt8](repeating: 0, count: a.width * a.height)
    out.withUnsafeMutableBufferPointer { o in
      for index in indices {
        guard let mask = a.masks[index] else { continue }
        mask.withUnsafeBufferPointer { m in
          for i in 0..<o.count where m[i] > o[i] { o[i] = m[i] }
        }
      }
    }
    return out
  }

  /// One instance as the wire reports it, writing whatever `write` asks for.
  static func instanceDict(
    _ a: Analysis, _ index: Int, write: Set<String>, crop: Bool, dir: URL?, prefix: String
  ) throws -> [String: Any] {
    guard let s = a.stats[index], let mask = a.masks[index] else {
      throw Failure("no instance \(index) in this image")
    }
    var d = statsDict(s, a)
    d["index"] = index
    if write.contains("mask"), let dir {
      let url = dir.appendingPathComponent("\(prefix)-mask-\(index).png")
      d["maskPath"] = try emitFile(a, url) { try writeGray(mask, a.width, a.height, to: url) }
    }
    if write.contains("cutout"), let dir {
      let region = crop ? extentBox(s) : nil
      let url = dir.appendingPathComponent("\(prefix)-cutout-\(index)\(crop ? "-crop" : "").png")
      d["cutoutPath"] = try emitFile(a, url) {
        try writeCutout(a, mask: mask, crop: region, to: url)
      }
      if let r = region { d["cutoutBox"] = box(r.0, r.1, r.2, r.3) }
    }
    return d
  }

  static func extentBox(_ s: Stats) -> (Int, Int, Int, Int) {
    (
      s.extentMinX, s.extentMinY, s.extentMaxX - s.extentMinX + 1,
      s.extentMaxY - s.extentMinY + 1
    )
  }

  static func requestedOutputs(_ params: [String: Any], allowed: Set<String>, fallback: [String])
    throws -> Set<String>
  {
    let asked = Set(strings(params["write"]) ?? fallback)
    let unknown = asked.subtracting(allowed)
    guard unknown.isEmpty else {
      throw Failure(
        "unknown write option \(unknown.sorted().joined(separator: ", "))"
          + " (allowed: \(allowed.sorted().joined(separator: ", ")))")
    }
    return asked
  }

  // ── methods ───────────────────────────────────────────────────────────────

  static func info() -> [String: Any] {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let languages = (try? VNRecognizeTextRequest().supportedRecognitionLanguages()) ?? []
    return [
      "version": protocolVersion,
      "os": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
      "lift": true,
      "ocr": true,
      "ocrLanguages": languages,
      "maxPixels": defaultMaxPixels,
      "cache": [
        "entries": cache.count, "capacity": cacheCapacity, "bytes": cacheBytes,
        "budgetBytes": cacheBudgetBytes,
      ],
    ]
  }

  static func lift(_ params: [String: Any]) throws -> [String: Any] {
    let t0 = DispatchTime.now()
    let write = try requestedOutputs(
      params, allowed: liftOutputs, fallback: ["mask", "foregroundMask"])
    let (a, cached) = try analysis(params)
    try ensureLift(a)
    var chosen = a.indices
    if let only = try wholeNumbers(params["instances"], "instances") {
      chosen = chosen.filter { only.contains($0) }
    }
    let crop = bool(params["crop"], false)
    var dir: URL?
    if !write.isEmpty { dir = try outputDir(params) }
    let pre = prefix(a, params)

    var result: [String: Any] = [
      "image": a.path, "width": a.width, "height": a.height, "orientation": a.orientation,
      "count": chosen.count, "cached": cached, "analysisMs": a.liftMs,
    ]
    result["instances"] = try chosen.map {
      try instanceDict(a, $0, write: write, crop: crop, dir: dir, prefix: pre)
    }
    if !chosen.isEmpty {
      let mask = union(a, chosen)
      let all = chosen == a.indices
      let tagSuffix = all ? "" : "-" + chosen.map(String.init).joined(separator: "-")
      if let s = stats(of: mask, width: a.width, height: a.height) {
        var fg = statsDict(s, a)
        if write.contains("foregroundMask"), let dir {
          let url = dir.appendingPathComponent("\(pre)-mask-fg\(tagSuffix).png")
          fg["maskPath"] = try emitFile(a, url) { try writeGray(mask, a.width, a.height, to: url) }
        }
        if write.contains("foregroundCutout"), let dir {
          let region = crop ? extentBox(s) : nil
          let name = "\(pre)-cutout-fg\(tagSuffix)\(crop ? "-crop" : "").png"
          let url = dir.appendingPathComponent(name)
          fg["cutoutPath"] = try emitFile(a, url) {
            try writeCutout(a, mask: mask, crop: region, to: url)
          }
          if let r = region { fg["cutoutBox"] = box(r.0, r.1, r.2, r.3) }
        }
        result["foreground"] = fg
      }
    }
    if write.contains("labels"), let dir {
      let url = dir.appendingPathComponent("\(pre)-labels.png")
      result["labelsPath"] = try emitFile(a, url) {
        try writeGray(a.labels, a.width, a.height, to: url)
      }
    }
    result["ms"] = ms(since: t0)
    return result
  }

  static func instanceAt(_ params: [String: Any]) throws -> [String: Any] {
    let t0 = DispatchTime.now()
    guard let x = double(params["x"]), let y = double(params["y"]), x.isFinite, y.isFinite else {
      throw Failure("instanceAt needs x and y (image pixels, top-left origin)")
    }
    let write = try requestedOutputs(params, allowed: instanceOutputs, fallback: ["mask"])
    let (a, cached) = try analysis(params)
    guard x >= 0, y >= 0, x < Double(a.width), y < Double(a.height) else {
      throw Failure(
        "point (\(String(format: "%.2f, %.2f", x, y))) is outside the"
          + " \(a.width)×\(a.height) image")
    }
    try ensureLift(a)
    var index = Int(a.labels[Int(y) * a.width + Int(x)])
    var distance: NSNumber?
    // A tap tolerance, so capped at maxSnapRadius: an absurd radius must not
    // overflow the pixel arithmetic below, nor scan a whole 64 MP picture.
    let asked = double(params["radius"]) ?? 0
    let radius = asked.isFinite ? min(max(0, asked), maxSnapRadius) : 0
    if index == 0, radius > 0 {
      // Nearest labelled pixel within the radius: a tap that lands a hair
      // outside a soft edge still means the thing it was aimed at. Measured
      // from the TAP POINT to each pixel's CENTRE — a tap at x = 10.9 is not
      // a tap at x = 10.0 — and a radius of exactly √D reaches √D (the
      // epsilon absorbs sqrt(6)² = 5.999…).
      let limit = radius * radius * (1 + 1e-12) + 1e-9
      let x0 = max(0, Int((x - radius - 1).rounded(.down)))
      let x1 = min(a.width - 1, Int((x + radius + 1).rounded(.up)))
      let y0 = max(0, Int((y - radius - 1).rounded(.down)))
      let y1 = min(a.height - 1, Int((y + radius + 1).rounded(.up)))
      var bestD = Double.infinity
      for yy in y0...y1 {
        let dy = Double(yy) + 0.5 - y
        for xx in x0...x1 {
          let label = a.labels[yy * a.width + xx]
          if label == 0 { continue }
          let dx = Double(xx) + 0.5 - x
          let d = dx * dx + dy * dy
          if d <= limit, d < bestD {
            bestD = d
            index = Int(label)
          }
        }
      }
      if index != 0 { distance = round2(bestD.squareRoot()) }
    }
    var result: [String: Any] = [
      "image": a.path, "width": a.width, "height": a.height, "orientation": a.orientation,
      "count": a.indices.count, "point": ["x": num(x, 2), "y": num(y, 2)], "index": index,
      "hit": index != 0, "cached": cached, "analysisMs": a.liftMs,
    ]
    if let distance { result["distance"] = distance }
    if index != 0 {
      var dir: URL?
      if !write.isEmpty { dir = try outputDir(params) }
      result["instance"] = try instanceDict(
        a, index, write: write, crop: bool(params["crop"], false), dir: dir,
        prefix: prefix(a, params))
    }
    result["ms"] = ms(since: t0)
    return result
  }

  static func ocr(_ params: [String: Any]) throws -> [String: Any] {
    let t0 = DispatchTime.now()
    let (a, cached) = try analysis(params)
    let request = VNRecognizeTextRequest()
    let level = string(params["level"]) ?? "accurate"
    guard level == "accurate" || level == "fast" else {
      throw Failure("level must be \"accurate\" or \"fast\"")
    }
    request.recognitionLevel = level == "fast" ? .fast : .accurate
    // Language correction lets a language model settle ambiguous glyphs
    // (0/O, 1/l) toward real words — right for reading a picture, wrong for
    // CHECKING one, which wants exactly what is painted, so it is a knob.
    // (MEASURED: the fixture's "FRESH BRAED DAILY" reads literally either
    // way; correction does not respell whole words.)
    let correction = bool(params["correction"], true)
    request.usesLanguageCorrection = correction
    if let languages = strings(params["languages"]), !languages.isEmpty {
      request.recognitionLanguages = languages
      request.automaticallyDetectsLanguage = false
    } else {
      request.automaticallyDetectsLanguage = true
    }
    if let minHeight = double(params["minTextHeight"]), minHeight > 0 {
      request.minimumTextHeight = Float(minHeight)
    }
    let minConfidence = double(params["minConfidence"]) ?? 0
    let wantWords = bool(params["words"], true)

    // A region is OCR'd as its own crop, then mapped back: simpler and more
    // predictable than Vision's region-of-interest coordinate rules.
    var handler = a.handler
    var ox = 0
    var oy = 0
    var rw = a.width
    var rh = a.height
    if let region = params["region"] as? [String: Any] {
      guard let rx = double(region["x"]), let ry = double(region["y"]),
        let rwd = double(region["width"]), let rhd = double(region["height"]),
        rx.isFinite, ry.isFinite, rwd.isFinite, rhd.isFinite, rwd > 0, rhd > 0
      else {
        throw Failure("region needs finite x, y and a positive width and height (image pixels)")
      }
      // Clamped to the picture BEFORE becoming Ints: 1e19 must not trap.
      let fw = Double(a.width)
      let fh = Double(a.height)
      let x0 = Int(min(fw, max(0, rx.rounded(.down))))
      let y0 = Int(min(fh, max(0, ry.rounded(.down))))
      let x1 = Int(min(fw, max(0, (rx + rwd).rounded(.up))))
      let y1 = Int(min(fh, max(0, (ry + rhd).rounded(.up))))
      guard x1 > x0, y1 > y0,
        let crop = a.image.cropping(to: CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
      else { throw Failure("region lies outside the \(a.width)×\(a.height) image") }
      handler = VNImageRequestHandler(cgImage: crop, options: [:])
      ox = x0
      oy = y0
      rw = x1 - x0
      rh = y1 - y0
    }
    do {
      try handler.perform([request])
    } catch {
      throw Failure("Vision could not read text: \(error.localizedDescription)")
    }

    // Vision: normalized, bottom-left origin, relative to what it was given.
    func px(_ p: CGPoint) -> [String: Any] {
      [
        "x": round2(Double(ox) + Double(p.x) * Double(rw)),
        "y": round2(Double(oy) + (1 - Double(p.y)) * Double(rh)),
      ]
    }
    func pxBox(_ r: CGRect) -> [String: Any] {
      [
        "x": round2(Double(ox) + Double(r.minX) * Double(rw)),
        "y": round2(Double(oy) + (1 - Double(r.maxY)) * Double(rh)),
        "width": round2(Double(r.width) * Double(rw)),
        "height": round2(Double(r.height) * Double(rh)),
      ]
    }

    struct Line {
      let top: Double
      let left: Double
      let height: Double
      let dict: [String: Any]
    }
    var lines: [Line] = []
    for observation in request.results ?? [] {
      guard let best = observation.topCandidates(1).first else { continue }
      let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty || Double(best.confidence) < minConfidence { continue }
      let bb = observation.boundingBox
      var d: [String: Any] = [
        "text": text,
        "confidence": round2(Double(best.confidence)),
        "box": pxBox(bb),
        "quad": [
          px(observation.topLeft), px(observation.topRight), px(observation.bottomRight),
          px(observation.bottomLeft),
        ],
      ]
      if wantWords {
        var words: [[String: Any]] = []
        let s = best.string
        var i = s.startIndex
        while i < s.endIndex {
          while i < s.endIndex, s[i].isWhitespace { i = s.index(after: i) }
          guard i < s.endIndex else { break }
          var j = i
          while j < s.endIndex, !s[j].isWhitespace { j = s.index(after: j) }
          var word: [String: Any] = ["text": String(s[i..<j])]
          if let rect = try? best.boundingBox(for: i..<j) {
            word["box"] = pxBox(rect.boundingBox)
          }
          words.append(word)
          i = j
        }
        d["words"] = words
      }
      lines.append(
        Line(
          top: Double(1 - bb.maxY) * Double(rh), left: Double(bb.minX) * Double(rw),
          height: Double(bb.height) * Double(rh), dict: d))
    }
    // Reading order: top to bottom; lines that share a row (their tops within
    // half a line height of the row's first line), left to right. Grouped
    // first and then sorted, because "same row" is not transitive and a
    // comparator built on it would not be a valid ordering.
    lines.sort { $0.top < $1.top }
    var rows: [[Line]] = []
    for line in lines {
      if let first = rows.last?.first,
        abs(line.top - first.top) < min(line.height, first.height) / 2
      {
        rows[rows.count - 1].append(line)
      } else {
        rows.append([line])
      }
    }
    let ordered = rows.flatMap { row in row.sorted { $0.left < $1.left } }
    return [
      "image": a.path, "width": a.width, "height": a.height, "orientation": a.orientation,
      "level": level, "correction": correction, "revision": request.revision,
      "text": ordered.compactMap { $0.dict["text"] as? String }.joined(separator: "\n"),
      "lines": ordered.map { $0.dict },
      "cached": cached, "ms": ms(since: t0),
    ]
  }

  /// Run each model once on a small in-memory picture with a word on it, so
  /// the one-time preparation (see the header) happens now rather than under
  /// someone's first click. Cheap once warm; nothing is cached or written.
  static func warm() throws -> [String: Any] {
    let t0 = DispatchTime.now()
    let w = 480
    let h = 160
    guard
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw Failure("cannot build the warm-up picture") }
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.setFillColor(CGColor(srgbRed: 0.1, green: 0.3, blue: 0.4, alpha: 1))
    ctx.fillEllipse(in: CGRect(x: 360, y: 30, width: 100, height: 100))
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 56, nil)
    let text = NSAttributedString(
      string: "Warm up",
      attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(
          srgbRed: 0, green: 0, blue: 0, alpha: 1),
      ])
    ctx.textPosition = CGPoint(x: 24, y: 58)
    CTLineDraw(CTLineCreateWithAttributedString(text), ctx)
    guard let image = ctx.makeImage() else { throw Failure("cannot build the warm-up picture") }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])

    let tl = DispatchTime.now()
    do {
      try handler.perform([VNGenerateForegroundInstanceMaskRequest()])
    } catch {
      throw Failure("Vision could not warm the lift model: \(error.localizedDescription)")
    }
    let liftMs = ms(since: tl)

    let to = DispatchTime.now()
    let ocr = VNRecognizeTextRequest()
    ocr.recognitionLevel = .accurate
    ocr.automaticallyDetectsLanguage = true
    do {
      try handler.perform([ocr])
    } catch {
      throw Failure("Vision could not warm text recognition: \(error.localizedDescription)")
    }
    let read = (ocr.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return [
      "liftMs": liftMs, "ocrMs": ms(since: to), "ms": ms(since: t0),
      "text": read.joined(separator: " "),
    ]
  }

  static func forget(_ params: [String: Any]) throws -> [String: Any] {
    let before = cache.count
    if params["image"] != nil {
      let path = try imagePath(params)
      cache.removeAll { $0.path == path }
    } else {
      cache.removeAll()
    }
    return ["dropped": before - cache.count, "entries": cache.count]
  }
}
