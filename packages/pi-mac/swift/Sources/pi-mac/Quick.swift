import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

// ── the quick panel's reads (apps/desktop/electron/quick) ────────────────────
//
// Three small methods for the hotkey panel, kept apart from computer use
// because none of them drives anything:
//
//   selection         the text selected in an app, read through Accessibility
//                     BEFORE the panel takes the keyboard — and never from a
//                     password field: a secure text field, or secure keyboard
//                     entry switched on anywhere (a password prompt has the
//                     keys), answers `secure: true` with no text at all.
//   replaceSelection  put text where the selection was, through the same
//                     attribute — no pasteboard involved. Apps that do not take
//                     it answer `replaced: false` and the caller falls back.
//   screenWindows     every ordinary on-screen window, front to back, with its
//                     owner — what "click a window" hit-tests against. Window
//                     frames and owners come from the window server and need no
//                     Screen Recording grant; titles would, so none are read.

private func qInt(_ v: Any?) -> Int? {
  if let i = v as? Int { return i }
  if let n = v as? NSNumber { return n.intValue }
  if let s = v as? String { return Int(s) }
  return nil
}

/// The app a quick read is aimed at: the pid asked for, else the front app.
private func quickTargetPid(_ params: [String: Any]) -> pid_t? {
  if let p = qInt(params["pid"]), p > 0 { return pid_t(p) }
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// The focused element of `pid`, with a short messaging timeout so an app that
/// is beach-balling cannot hold the panel up.
private func focusedElement(of pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.25)
  guard let ref = axCopy(app, kAXFocusedUIElementAttribute) else { return nil }
  let el = unsafeBitCast(ref, to: AXUIElement.self)
  AXUIElementSetMessagingTimeout(el, 0.25)
  return el
}

private func isSecureField(_ el: AXUIElement) -> Bool {
  let role = axString(el, kAXRoleAttribute) ?? ""
  let subrole = axString(el, kAXSubroleAttribute) ?? ""
  return role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

/// `selection` method.
func doSelection(_ params: [String: Any]) -> [String: Any] {
  guard AXIsProcessTrusted() else { return ["ok": false, "error": "accessibility"] }
  // Someone is typing a password somewhere: read nothing at all.
  if IsSecureEventInputEnabled() { return ["ok": true, "secure": true, "text": ""] }
  guard let pid = quickTargetPid(params) else { return ["ok": false, "error": "no app in front"] }
  let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
  guard let el = focusedElement(of: pid) else {
    return ["ok": true, "text": "", "pid": Int(pid), "app": name]
  }
  if isSecureField(el) { return ["ok": true, "secure": true, "text": "", "pid": Int(pid), "app": name] }
  let text = axString(el, kAXSelectedTextAttribute) ?? ""
  var settable: DarwinBoolean = false
  let canSet =
    AXUIElementIsAttributeSettable(el, kAXSelectedTextAttribute as CFString, &settable) == .success
    && settable.boolValue
  return [
    "ok": true, "text": text, "pid": Int(pid), "app": name,
    "role": axString(el, kAXRoleAttribute) ?? "", "editable": canSet,
  ]
}

/// `replaceSelection` method.
func doReplaceSelection(_ params: [String: Any]) -> [String: Any] {
  guard AXIsProcessTrusted() else { return ["ok": false, "error": "accessibility"] }
  if IsSecureEventInputEnabled() { return ["ok": true, "replaced": false, "secure": true] }
  guard let text = params["text"] as? String else { return ["ok": false, "error": "no text"] }
  guard let pid = quickTargetPid(params), let el = focusedElement(of: pid) else {
    return ["ok": true, "replaced": false]
  }
  if isSecureField(el) { return ["ok": true, "replaced": false, "secure": true] }
  let before = axString(el, kAXValueAttribute)
  let err = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString)
  guard err == .success else { return ["ok": true, "replaced": false] }
  // Some apps report success and change nothing; a value that did not move
  // (when there was one to read) is treated as not replaced.
  if let b = before, let after = axString(el, kAXValueAttribute), b == after, !text.isEmpty {
    return ["ok": true, "replaced": false]
  }
  return ["ok": true, "replaced": true]
}

/// `screenWindows` method.
func doScreenWindows(_ params: [String: Any]) -> [String: Any] {
  let exclude = Set(((params["excludePids"] as? [Any]) ?? []).compactMap { qInt($0) })
  var names: [pid_t: String] = [:]
  var out: [[String: Any]] = []
  for w in onScreenWindows() {
    guard w.alpha > 0.05, w.bounds.width >= 40, w.bounds.height >= 40 else { continue }
    if exclude.contains(Int(w.ownerPid)) { continue }
    let name: String
    if let cached = names[w.ownerPid] {
      name = cached
    } else {
      name = NSRunningApplication(processIdentifier: w.ownerPid)?.localizedName ?? ""
      names[w.ownerPid] = name
    }
    out.append([
      "windowId": Int(w.windowId), "pid": Int(w.ownerPid), "app": name, "layer": w.layer,
      "x": Double(w.bounds.origin.x), "y": Double(w.bounds.origin.y),
      "w": Double(w.bounds.width), "h": Double(w.bounds.height),
    ])
  }
  return ["ok": true, "windows": out]
}
