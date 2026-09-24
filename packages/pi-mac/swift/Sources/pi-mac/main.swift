import AppKit
import Foundation

// VISION FIRST, BEFORE APPKIT EXISTS.
//
// `--vision*` reads image files; it needs no app identity and no permission.
// Initialising NSApplication (the line below) is not free even with
// `.prohibited`: MEASURED in the unified log, it checks the process in with
// LaunchServices as a FOREGROUND app first and only then applies the policy.
// Dispatching the vision modes before that line means they are never
// registered as an app at all (absent from `lsappinfo list`), so a dock tile is
// impossible by construction rather than suppressed. The only TCC traffic left
// is the Input Monitoring check the window server makes when Vision's model
// runtime connects to it — MEASURED `preflight=true`, which cannot prompt.
switch CommandLine.arguments.dropFirst().first {
case "--vision-serve":
  runVisionServe()
  exit(0)
case "--vision":
  runVisionCommand(Array(CommandLine.arguments.dropFirst(2)))
default:
  break
}

// Run as a background agent: no dock tile, no menu bar, never in the app
// switcher. pi-mac links AppKit (NSWorkspace/CGEvent/screenshot), and an
// AppKit-linked executable otherwise defaults to a REGULAR activation policy —
// which paints a second, generic ("exec"/terminal-looking) icon in the dock the
// moment Electron main spawns the `--serve` helper for computer-use. `.prohibited`
// suppresses that tile while leaving CGEvent synthesis + AX reads fully working
// (they are gated by the TCC grant on the spawning bundle, not by activation
// policy). Set FIRST, before any subcommand touches the window server.
NSApplication.shared.setActivationPolicy(.prohibited)

// pi-mac: a tiny argv dispatcher for Mac computer-use.
//
//   pi-mac --check                      → one TCC-status JSON line, exit 0.
//   pi-mac --snapshot [target] [--screenshot]
//                                       → one INDEXED AX-tree JSON line, exit 0.
//   pi-mac --act <json>                 → perform one raw act (x,y/type/key/
//                                          scroll), print an ack line, exit 0.
//   pi-mac --serve                      → persistent NDJSON request/response
//                                          loop on stdin/stdout. Keeps the
//                                          index→AXUIElement map alive across a
//                                          snapshot and the acts that follow, so
//                                          the bridge can act by [index]. This is
//                                          the mode Electron main drives.
//   pi-mac --apps [dir …]              → the installed apps, one JSON line
//                                          (id/name/path) — the computer-use
//                                          chooser's list.
//   pi-mac --app-icon <app> <px> <out>  → the app's real icon as a PNG.
//   pi-mac --overlay                    → the phantom-cursor overlay: a
//                                          screen-sized, click-through,
//                                          Mission-Control-excluded NSPanel
//                                          drawn with CoreAnimation, driven by
//                                          the same NDJSON dialect. Runs its own
//                                          NSApplication (a live runloop), which
//                                          is why it is a second process rather
//                                          than a `--serve` method.
//   pi-mac --vision-serve               → Apple Vision on image FILES for the
//                                          image editor (lift / instanceAt /
//                                          ocr), NDJSON like --serve. Its own
//                                          process so a Vision request never
//                                          queues in front of a click; needs
//                                          no permission (see Vision.swift).
//                                          Dispatched above, before AppKit.
//   pi-mac --vision <method> [json|path]
//                                       → one Vision request, one line, exit.
//
// Deliberately no arg-parsing dependency: positional subcommands only.
let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "--check":
  runCheckCommand()
case "--snapshot":
  runSnapshotCommand(Array(arguments.dropFirst()))
case "--act":
  runActCommand(Array(arguments.dropFirst()))
case "--serve":
  runServe()
case "--stream":
  runStream(Array(arguments.dropFirst()))
case "--apps":
  runAppsCommand(Array(arguments.dropFirst()))
case "--app-icon":
  runAppIconCommand(Array(arguments.dropFirst()))
case "--overlay":
  // `--overlay --headless`: the panel is driven and rendered, never shown —
  // what the app passes for a run that must not touch the screen.
  runOverlay(headless: arguments.contains("--headless"))
default:
  writeStderr(
    "usage: pi-mac [--check | --snapshot [--frontmost|--pid N|--app NAME] [--screenshot]"
      + " | --act <json> | --serve | --apps [dir …] | --app-icon <app> <px> <out> | --overlay"
      + " | --vision-serve | --vision <method> [json|path]]\n")
  exit(2)
}
