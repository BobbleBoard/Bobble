import AppKit
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// ── live window stream ───────────────────────────────────────────────────────
//
// `pi-mac --stream --pid N` composites the app's windows (and every sheet or
// dialog it puts up, re-resolved as they come and go) and writes JPEG frames to
// stdout so the app can show the user what the model is doing, live, in a
// canvas tab.
//
// Framing (stdout, binary):
//   "PIMF" | uint32be headerLen | uint32be payloadLen | header JSON | JPEG
// Control (stdin, NDJSON): {"cmd":"fps","value":8} | {"cmd":"quit"}
// Diagnostics: stderr, never stdout — stdout is the frame pipe.
//
// A zero-byte payload is a valid frame: it means "the app has no on-screen
// window right now", which the monitor renders as an empty stage rather than
// as an error.

private let FRAME_MAGIC = Array("PIMF".utf8)

private let frameQueue = DispatchQueue(label: "pi-mac.stream.out")

private func emitFrame(header: [String: Any], payload: Data) {
  guard let headerData = try? JSONSerialization.data(withJSONObject: header) else { return }
  var out = Data(FRAME_MAGIC)
  var hLen = UInt32(headerData.count).bigEndian
  var pLen = UInt32(payload.count).bigEndian
  withUnsafeBytes(of: &hLen) { out.append(contentsOf: $0) }
  withUnsafeBytes(of: &pLen) { out.append(contentsOf: $0) }
  out.append(headerData)
  out.append(payload)
  frameQueue.async {
    FileHandle.standardOutput.write(out)
  }
}

/// The window set + geometry a stream is currently pointed at. Comparing these
/// is how the stream notices a sheet opening, a dialog closing or the user
/// dragging the window, and re-points itself.
private struct StreamShape: Equatable {
  let ids: [CGWindowID]
  let rect: CGRect

  /// `overlayPid` adds that process's floating windows over the app — in
  /// practice Pi Desktop's own phantom-cursor overlay, so a recording shows the
  /// cursor doing the clicking instead of things happening by themselves.
  /// `fullDisplay` pins the framing to the whole screen so a dialog opening
  /// anywhere is never clipped and the picture never jumps mid-recording; only
  /// the app's own windows are ever composited, so nothing else on the user's
  /// screen can leak into it.
  static func of(pid: pid_t, overlayPid: pid_t?, fullDisplay: Bool)
    -> (shape: StreamShape?, windows: [AppWindow])
  {
    let windows = appWindows(pid: pid)
    var ids = windows.compactMap { $0.windowId }
    guard let union = unionFrame(windows), !ids.isEmpty else { return (nil, windows) }
    if let overlayPid {
      for w in onScreenWindows()
      where w.ownerPid == overlayPid && w.alpha > 0.02 && w.bounds.intersects(union) {
        if !ids.contains(w.windowId) { ids.append(w.windowId) }
      }
    }
    var rect = union.integral
    if fullDisplay {
      for id in activeDisplayIDs() where CGDisplayBounds(id).intersects(union) {
        rect = CGDisplayBounds(id)
        break
      }
    }
    return (StreamShape(ids: ids, rect: rect), windows)
  }
}

@available(macOS 14.0, *)
final class WindowStreamer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let pid: pid_t
  private let maxWidth: Int
  private let overlayPid: pid_t?
  private let fullDisplay: Bool
  /// Where finished frames go. The default writes the PIMF framing to stdout
  /// (`--stream`); the recorder swaps in a sink that writes numbered JPEGs to a
  /// directory, so one capture path serves both the live monitor and a video.
  var sink: ((_ header: [String: Any], _ jpeg: Data) -> Void)?
  private var fps: Int
  private var stream: SCStream?
  private var shape: StreamShape?
  private var windows: [AppWindow] = []
  private var seq = 0
  private var lastEmit = Date.distantPast
  private var sentEmpty = false
  private var reportedNoContent = false
  private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  private let lock = NSLock()

  var frameCount: Int { seq }

  init(pid: pid_t, fps: Int, maxWidth: Int, overlayPid: pid_t? = nil, fullDisplay: Bool = false) {
    self.pid = pid
    self.fps = max(1, min(30, fps))
    self.maxWidth = maxWidth
    self.overlayPid = overlayPid
    self.fullDisplay = fullDisplay
  }

  func start() {
    Task { await self.repoint(force: true) }
    // The window set is polled rather than observed: AX notifications need a
    // run-loop observer per window and miss the panel-service surfaces
    // entirely, while one CGWindowList read is a fraction of a millisecond.
    Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { await self.repoint(force: false) }
    }
  }

  func setFps(_ value: Int) {
    lock.lock()
    fps = max(1, min(30, value))
    let current = stream
    lock.unlock()
    guard let current, let shape else { return }
    Task {
      try? await current.updateConfiguration(self.configFor(shape))
    }
  }

  func stop() {
    let s = stream
    stream = nil
    Task { try? await s?.stopCapture() }
  }

  private func configFor(_ shape: StreamShape) -> SCStreamConfiguration {
    let target = CaptureTarget(windowIds: shape.ids, rect: shape.rect)
    var display: SCDisplay?
    // configuration(for:) needs the display only for its origin; resolve it from
    // the rect so this stays synchronous on the polling path.
    _ = display
    let config = SCStreamConfiguration()
    let origin = displayOrigin(for: shape.rect)
    let scale = scaleFor(rect: shape.rect)
    var pxW = max(2, Int((shape.rect.width * scale).rounded()))
    var pxH = max(2, Int((shape.rect.height * scale).rounded()))
    if pxW > maxWidth {
      pxH = max(2, Int((Double(pxH) * Double(maxWidth) / Double(pxW)).rounded()))
      pxW = maxWidth
    }
    // Even dimensions keep the encoder off a slow path.
    if pxW % 2 == 1 { pxW += 1 }
    if pxH % 2 == 1 { pxH += 1 }
    config.sourceRect = target.rect.offsetBy(dx: -origin.x, dy: -origin.y)
    config.width = pxW
    config.height = pxH
    config.scalesToFit = true
    config.showsCursor = false
    config.capturesAudio = false
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    config.backgroundColor = .clear
    config.queueDepth = 3
    config.ignoreShadowsSingleWindow = true
    config.ignoreShadowsDisplay = true
    lock.lock()
    let rate = fps
    lock.unlock()
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(rate))
    return config
  }

  private func displayOrigin(for rect: CGRect) -> CGPoint {
    for id in activeDisplayIDs() where CGDisplayBounds(id).intersects(rect) {
      return CGDisplayBounds(id).origin
    }
    return .zero
  }

  /// Re-resolve the window set and, when it changed, re-point the live stream at
  /// it. This is what makes a save sheet appear in the monitor the moment the
  /// model opens it.
  private func repoint(force: Bool) async {
    let (next, windows) = StreamShape.of(
      pid: pid, overlayPid: overlayPid, fullDisplay: fullDisplay)
    guard let next else {
      if !sentEmpty {
        sentEmpty = true
        seq += 1
        deliver(
          header: ["seq": seq, "t": nowMs(), "windows": [], "empty": true], payload: Data())
      }
      return
    }
    sentEmpty = false
    self.windows = windows
    if !force, let current = shape, current == next { return }
    shape = next
    let target = CaptureTarget(windowIds: next.ids, rect: next.rect)
    guard let (filter, _) = await contentFilter(for: target) else {
      // Nothing shareable. Almost always the missing Screen Recording grant —
      // say which, once, so the monitor can show a real reason and an actionable
      // fix instead of an empty stage the user cannot explain.
      let denied = !CGPreflightScreenCaptureAccess()
      if !reportedNoContent {
        reportedNoContent = true
        seq += 1
        deliver(
          header: [
            "seq": seq, "t": nowMs(), "windows": windows.map(windowDict),
            "error": denied ? "screen-recording-denied" : "no-shareable-window",
          ], payload: Data())
        writeStderr(
          denied
            ? "stream: Screen Recording is not granted for this app\n"
            : "stream: no shareable window for pid \(pid)\n")
      }
      return
    }
    reportedNoContent = false
    let config = configFor(next)
    if let existing = stream {
      try? await existing.updateContentFilter(filter)
      try? await existing.updateConfiguration(config)
      return
    }
    let created = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try created.addStreamOutput(
        self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "pi-mac.stream.frames"))
      try await created.startCapture()
      stream = created
    } catch {
      writeStderr("stream: could not start capture: \(error)\n")
    }
  }

  private func deliver(header: [String: Any], payload: Data) {
    if let sink { sink(header, payload) } else { emitFrame(header: header, payload: payload) }
  }

  // MARK: SCStreamOutput

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen, CMSampleBufferIsValid(sampleBuffer) else { return }
    guard frameIsComplete(sampleBuffer) else { return }
    lock.lock()
    let rate = fps
    lock.unlock()
    let minGap = 1.0 / Double(rate)
    if Date().timeIntervalSince(lastEmit) < minGap * 0.9 { return }
    guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let ci = CIImage(cvPixelBuffer: pixels)
    guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return }
    guard let jpeg = encode(cg, as: .jpeg, quality: 0.7) else { return }
    lastEmit = Date()
    seq += 1
    let rect = shape?.rect ?? .zero
    let mainSize = NSScreen.main?.frame.size ?? CGSize(width: 0, height: 0)
    deliver(
      header: [
        "seq": seq, "t": nowMs(),
        "w": cg.width, "h": cg.height,
        "scale": Double(scaleFor(rect: rect)),
        "rect": rectDict(rect),
        "display": ["w": mainSize.width, "h": mainSize.height],
        "windows": windows.map(windowDict),
      ], payload: jpeg)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    writeStderr("stream: stopped: \(error)\n")
    self.stream = nil
    Task { await self.repoint(force: true) }
  }
}

/// SCK marks frames that carry no new pixels (idle / blank / suspended). Only a
/// complete frame is worth encoding and shipping.
@available(macOS 14.0, *)
private func frameIsComplete(_ sample: CMSampleBuffer) -> Bool {
  guard
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
      as? [[SCStreamFrameInfo: Any]], let first = attachments.first,
    let raw = first[.status] as? Int, let status = SCFrameStatus(rawValue: raw)
  else { return true }
  return status == .complete
}

private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

func activeDisplayIDs() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  return Array(ids.prefix(Int(count)))
}

/// `pi-mac --stream --pid N [--app NAME] [--fps 12] [--max-width 1400]`
func runStream(_ args: [String]) {
  var pid: pid_t?
  var appName: String?
  var fps = 12
  var maxWidth = 1400
  var overlayPid: pid_t?
  var fullDisplay = false
  var i = 0
  while i < args.count {
    switch args[i] {
    case "--pid": if i + 1 < args.count { pid = pid_t(args[i + 1]) ?? nil }; i += 1
    case "--app": if i + 1 < args.count { appName = args[i + 1] }; i += 1
    case "--fps": if i + 1 < args.count { fps = Int(args[i + 1]) ?? fps }; i += 1
    case "--max-width": if i + 1 < args.count { maxWidth = Int(args[i + 1]) ?? maxWidth }; i += 1
    case "--overlay-pid":
      if i + 1 < args.count { overlayPid = pid_t(args[i + 1]) }
      i += 1
    case "--full-display": fullDisplay = true
    default: break
    }
    i += 1
  }
  if pid == nil, let name = appName, let r = resolveTargetPid(.app(name)) { pid = r.pid }
  guard let pid else {
    writeStderr("stream: needs --pid N or --app NAME\n")
    exit(2)
  }
  guard #available(macOS 14.0, *) else {
    writeStderr("stream: needs macOS 14+\n")
    exit(2)
  }
  let streamer = WindowStreamer(
    pid: pid, fps: fps, maxWidth: maxWidth, overlayPid: overlayPid, fullDisplay: fullDisplay)
  streamer.start()

  // Control channel. Reading stdin on its own thread keeps the run loop free for
  // the capture callbacks; EOF (the app closed the pipe) ends the process.
  let reader = Thread {
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      switch obj["cmd"] as? String {
      case "fps": if let v = obj["value"] as? Int { streamer.setFps(v) }
      case "quit":
        streamer.stop()
        exit(0)
      default: break
      }
    }
    streamer.stop()
    exit(0)
  }
  reader.start()
  RunLoop.main.run()
}


// ── file recorder ────────────────────────────────────────────────────────────
//
// `recordStart` / `recordStop` on the serve pipe. The point of recording INSIDE
// the helper is that the capture grant belongs to the app that spawned it, so
// this is the only place a recording of the controlled app can be made at all.
//
// Only the app's own windows (plus, optionally, the phantom-cursor overlay) are
// ever composited, so a recording cannot pick up anything else on the user's
// screen.

@available(macOS 14.0, *)
private var activeRecorder: WindowStreamer?
private var activeRecordDir: String?
private var recordedFrames = 0

func recordStart(_ params: [String: Any]) -> [String: Any] {
  guard #available(macOS 14.0, *) else { return ["ok": false, "error": "needs macOS 14+"] }
  if activeRecordDir != nil { return ["ok": false, "error": "a recording is already running"] }
  let explicitPid = (params["pid"] as? NSNumber).map { pid_t($0.int32Value) }
  guard
    let pid = explicitPid
      ?? (params["app"] as? String).flatMap({ resolveTargetPid(.app($0))?.pid })
  else { return ["ok": false, "error": "recordStart needs pid or app"] }
  let dir =
    (params["dir"] as? String)
    ?? (NSTemporaryDirectory() as NSString).appendingPathComponent(
      "pi-mac-rec-\(Int(Date().timeIntervalSince1970))")
  try? FileManager.default.createDirectory(
    atPath: dir, withIntermediateDirectories: true)
  let fps = (params["fps"] as? NSNumber)?.intValue ?? 12
  let maxWidth = (params["maxWidth"] as? NSNumber)?.intValue ?? 1600
  let overlayPid = (params["overlayPid"] as? NSNumber).map { pid_t($0.int32Value) }
  let streamer = WindowStreamer(
    pid: pid, fps: fps, maxWidth: maxWidth, overlayPid: overlayPid,
    fullDisplay: (params["fullDisplay"] as? Bool) ?? true)
  recordedFrames = 0
  streamer.sink = { (header: [String: Any], jpeg: Data) in
    guard !jpeg.isEmpty else { return }
    recordedFrames += 1
    // The capture only produces a frame when the picture CHANGES, so the wall
    // clock has to travel with each one or the video would play back as if
    // everything happened at a uniform rate — a five-second pause and a
    // sixteenth of a second would look identical.
    let t = (header["t"] as? Int) ?? Int(Date().timeIntervalSince1970 * 1000)
    let name = String(format: "frame-%06d-%d.jpg", recordedFrames, t)
    try? jpeg.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent(name)))
  }
  streamer.start()
  activeRecorder = streamer
  activeRecordDir = dir
  return ["ok": true, "dir": dir, "pid": Int(pid), "fps": fps]
}

func recordStop() -> [String: Any] {
  guard #available(macOS 14.0, *), let dir = activeRecordDir else {
    return ["ok": false, "error": "no recording is running"]
  }
  activeRecorder?.stop()
  activeRecorder = nil
  activeRecordDir = nil
  return ["ok": true, "dir": dir, "frames": recordedFrames]
}
