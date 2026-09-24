// swift-tools-version:6.0
import PackageDescription

// pi-mac — a headless Swift CLI that gives Node (Electron main) a computer-use
// bridge for ANY Mac app: an INDEXED Accessibility-tree snapshot, synthetic
// CGEvent click/type/key/scroll, and a TCC status probe. arm64 + macOS 26.
// Built with SwiftPM (`swift build -c release`) because this box has
// CommandLineTools only — no full Xcode / xcodebuild (identical to pi-afm).
//
// Language mode is pinned to v5 so the plain top-level entry + FileHandle line
// writes don't trip Swift 6 strict-concurrency diagnostics. There are no async
// APIs here (unlike pi-afm), so the serve loop is a simple synchronous
// readLine() NDJSON pump.
//
// The AX/CGEvent frameworks (ApplicationServices, AppKit, CoreGraphics) are
// linked explicitly so the executable resolves AXUIElement*/CGEvent* symbols
// even when auto-linking is conservative. QuartzCore comes in for the `--overlay`
// mode's CALayer tree and ImageIO for the PNG writer the overlay probe renders
// its screenshots through. Vision + CoreVideo serve `--vision` (instance masks,
// instance-at-point, OCR on image files; Vision.swift) — both live in the dyld
// shared cache, and `--check` was measured before and after linking them.
let package = Package(
  name: "pi-mac",
  platforms: [
    .macOS("26.0")
  ],
  targets: [
    .executableTarget(
      name: "pi-mac",
      path: "Sources/pi-mac",
      swiftSettings: [.swiftLanguageMode(.v5)],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("QuartzCore"),
        .linkedFramework("ImageIO"),
        .linkedFramework("Vision"),
        .linkedFramework("CoreVideo"),
      ]
    )
  ]
)
