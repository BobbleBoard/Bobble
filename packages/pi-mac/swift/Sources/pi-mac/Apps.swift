import AppKit
import Foundation

// The apps on this Mac, and their icons, for the computer-use chooser.
//
// The user (2026-09-15): "a UI on onboarding for computer use on/off and then if on
// choose what apps to allow control of, show this as a grid of real app icons
// w/ names below, this is editable later in settings via a similar UI."
//
// REAL icons means the ones Finder draws, and only AppKit can draw them: modern
// apps keep their icon in an asset catalog (Assets.car), which `sips` and
// `iconutil` cannot read, and Electron's own `getFileIcon` is capped at 32 px
// on macOS — a blur in a 64-pt tile on a Retina screen. `NSWorkspace.icon` is
// the same call Finder makes; rendered at the asked size it is crisp at any
// scale. The helper is already the app's Mac-side hands, so it lists and draws
// too — the Node side only reads what it writes.
//
//   pi-mac --apps [dir …]              → one JSON line: [{ id, name, path }]
//   pi-mac --app-icon <app> <px> <out> → writes a PNG, prints {"ok":true}

/// Where a person's apps live. `/System/Applications` carries Apple's own
/// (Mail, Notes, Safari …) on every modern macOS; the Utilities folders hold
/// Terminal and friends, which the chooser names by their risk.
private let DEFAULT_APP_DIRS: [String] = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  NSString(string: "~/Applications").expandingTildeInPath,
]

/// One `.app` bundle as the chooser shows it: the bundle id (what the
/// allowlist stores — stable across renames and localisation), the name Finder
/// shows (localised, no extension), and the path the icon is read from.
struct InstalledApp {
  let id: String
  let name: String
  let path: String

  var dict: [String: Any] { ["id": id, "name": name, "path": path] }
}

/// The apps in `dirs` (one level deep — an `/Applications/Foo/Foo.app` layout
/// is common enough to look inside a folder, and deeper is packaging, not apps).
/// Bundles with no identifier are skipped: nothing could name them later.
func installedApps(in dirs: [String]) -> [InstalledApp] {
  let fm = FileManager.default
  var seen = Set<String>()
  var out: [InstalledApp] = []

  func add(_ url: URL) {
    guard url.pathExtension == "app", let bundle = Bundle(url: url),
      let id = bundle.bundleIdentifier, !id.isEmpty
    else { return }
    // Two copies of one app (a folder alias, a duplicate install) are one choice.
    let key = id.lowercased()
    guard !seen.contains(key) else { return }
    seen.insert(key)
    let name = FileManager.default.displayName(atPath: url.path)
      .replacingOccurrences(of: ".app", with: "")
    out.append(InstalledApp(id: id, name: name, path: url.path))
  }

  for dir in dirs {
    guard let entries = try? fm.contentsOfDirectory(
      at: URL(fileURLWithPath: dir), includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles])
    else { continue }
    for entry in entries {
      if entry.pathExtension == "app" {
        add(entry)
        continue
      }
      // One folder deep: /Applications/Adobe Photoshop/Adobe Photoshop.app.
      let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
      guard isDir else { continue }
      guard let inner = try? fm.contentsOfDirectory(
        at: entry, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
      else { continue }
      for sub in inner where sub.pathExtension == "app" { add(sub) }
    }
  }
  return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}

/// `--apps [dir …]`: the list, one JSON line.
func runAppsCommand(_ args: [String]) {
  let dirs = args.isEmpty ? DEFAULT_APP_DIRS : args
  let apps = installedApps(in: dirs).map { $0.dict }
  guard let data = try? JSONSerialization.data(withJSONObject: apps, options: []),
    let text = String(data: data, encoding: .utf8)
  else {
    emitError(id: nil, message: "could not encode the app list")
    exit(1)
  }
  FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

/// The icon Finder shows for `path`, rendered at `px` × `px` pixels as PNG.
///
/// `NSWorkspace.icon` hands back an NSImage with every representation the app
/// ships; drawing it into a bitmap of the asked size lets AppKit pick the best
/// one, which is how a 1024-pt asset-catalog icon comes out crisp at 128 px.
func appIconPNG(path: String, px: Int) -> Data? {
  let icon = NSWorkspace.shared.icon(forFile: path)
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
  else { return nil }
  rep.size = NSSize(width: px, height: px)
  NSGraphicsContext.saveGraphicsState()
  guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
  NSGraphicsContext.current = ctx
  ctx.imageInterpolation = .high
  icon.draw(
    in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .sourceOver,
    fraction: 1.0)
  ctx.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

/// `--app-icon <app path> <px> <out png>`: write the icon, say so.
func runAppIconCommand(_ args: [String]) {
  guard args.count >= 3, let px = Int(args[1]), px > 0, px <= 1024 else {
    writeStderr("usage: pi-mac --app-icon <app path> <px> <out png>\n")
    exit(2)
  }
  guard let png = appIconPNG(path: args[0], px: px) else {
    emitError(id: nil, message: "could not render an icon for \(args[0])")
    exit(1)
  }
  do {
    try png.write(to: URL(fileURLWithPath: args[2]))
  } catch {
    emitError(id: nil, message: "could not write \(args[2]): \(error)")
    exit(1)
  }
  emit(["ok": true, "bytes": png.count])
}
