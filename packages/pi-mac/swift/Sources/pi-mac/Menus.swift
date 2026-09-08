import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ── the menu bar ─────────────────────────────────────────────────────────────
//
// "click new" is a menu item, not a button. Every real Mac app puts a third of
// its capability in the menu bar — New, Save, Undo, the whole Format menu — and
// none of it appears in a window snapshot, so a model that could only see
// windows simply could not do those things.
//
// Accessibility can PRESS a menu item directly, which means the menu never has
// to be opened on screen: no flashing menus over the user's work, no focus
// steal, and it works while the app is in the background. That is strictly
// better than driving menus with the mouse, so it is the only path offered.

private let MENU_ITEM_CAP = 400

struct MenuEntry {
  let path: [String]
  let title: String
  let enabled: Bool
  let shortcut: String
  let hasSubmenu: Bool
  let element: AXUIElement
}

private func menuBar(of pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  guard let bar = axCopy(app, kAXMenuBarAttribute) else { return nil }
  return unsafeBitCast(bar, to: AXUIElement.self)
}

/// ⌘⇧S style label for a menu item, built from the AX command-character and
/// modifier mask so the model can prefer a keyboard chord when one exists.
private func shortcutLabel(_ el: AXUIElement) -> String {
  guard let ch = axString(el, "AXMenuItemCmdChar"), !ch.isEmpty else { return "" }
  let mods = (axCopy(el, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
  var label = ""
  if mods & 0x04 != 0 { label += "⌃" }
  if mods & 0x02 != 0 { label += "⌥" }
  if mods & 0x01 != 0 { label += "⇧" }
  if mods & 0x08 == 0 { label = "⌘" + label }
  return label + ch.uppercased()
}

/// Walk the menu bar depth-first. `under` limits the walk to one branch and
/// `levels` says how many levels BELOW that branch to include — a whole menu bar
/// is hundreds of items and returning it all would drown the list it is meant to
/// help, so one level is the default and naming a submenu opens the next.
func menuEntries(pid: pid_t, under: [String] = [], levels: Int = 1) -> [MenuEntry] {
  guard let bar = menuBar(of: pid) else { return [] }
  var out: [MenuEntry] = []

  func walk(_ el: AXUIElement, path: [String], level: Int) {
    guard out.count < MENU_ITEM_CAP else { return }
    for child in axChildren(el) {
      let role = axString(child, kAXRoleAttribute) ?? ""
      if role == "AXMenu" {
        walk(child, path: path, level: level)
        continue
      }
      guard role == "AXMenuItem" || role == "AXMenuBarItem" else { continue }
      let title = cleanText(axString(child, kAXTitleAttribute) ?? "")
      if title.isEmpty { continue }  // separators
      let here = path + [title]
      if here.count > under.count + levels { continue }
      // Only descend the branch the caller asked about.
      let onPath =
        under.isEmpty || zip(under, here).allSatisfy { $0.lowercased() == $1.lowercased() }
      guard onPath else { continue }
      let submenu = axChildren(child).first { axString($0, kAXRoleAttribute) == "AXMenu" }
      if here.count > under.count {
        out.append(
          MenuEntry(
            path: here, title: title,
            enabled: axBool(child, kAXEnabledAttribute) ?? true,
            shortcut: shortcutLabel(child), hasSubmenu: submenu != nil, element: child))
      }
      if let submenu, here.count < under.count + levels {
        walk(submenu, path: here, level: level + 1)
      }
    }
  }
  walk(bar, path: [], level: 0)
  return out
}

/// Resolve "File > New" (or "file>new", or just "New" when unambiguous) to a
/// menu item. Being forgiving here matters: the model is reading a path it was
/// shown and retyping it, and refusing over a missing space would cost a whole
/// turn to discover.
func findMenuItem(pid: pid_t, path: String) -> MenuEntry? {
  let wanted = path.split(separator: ">").map {
    $0.trimmingCharacters(in: .whitespaces).lowercased()
  }.filter { !$0.isEmpty }
  guard !wanted.isEmpty else { return nil }
  let all = menuEntries(pid: pid, under: [], levels: 3)
  // Exact path first.
  if let hit = all.first(where: { $0.path.map { p in p.lowercased() } == wanted }) { return hit }
  // Then a path SUFFIX ("New" → File > New), preferring the shallowest match so
  // "Save" finds File > Save rather than some plugin's nested Save.
  let bySuffix = all.filter { e in
    let lower = e.path.map { $0.lowercased() }
    return lower.count >= wanted.count && Array(lower.suffix(wanted.count)) == wanted
  }
  if let hit = bySuffix.min(by: { $0.path.count < $1.path.count }) { return hit }
  // Finally a leaf-title prefix, so "Save As" matches "Save As…".
  return all.first { e in
    guard let last = wanted.last, let leaf = e.path.last?.lowercased() else { return false }
    return leaf.hasPrefix(last) && !e.hasSubmenu
  }
}

// ── what is NOT on offer ─────────────────────────────────────────────────────
//
// The Apple menu belongs to macOS, not to the app being driven, and every
// snapshot was handing the model a resolvable path to "Shut Down…", "Restart…"
// and "Log Out…" with nothing standing between them and an AXPress. Two fences,
// because one of them is copy and copy is not a control:
//
//   1. it is not LISTED — `listableMenuTitles` drops it, so the model is never
//      shown a menu it has no business in;
//   2. the items that end the user's session or destroy data are not PRESSED
//      without an explicit confirmation flag, which only the tool layer sets and
//      only after the user has said yes in their own words.
//
// Deliberately NOT guarded: Edit > Delete and Finder's Move to Trash. Delete is
// the most ordinary editing verb on the Mac and it undoes; Move to Trash is
// recoverable by definition. Refusing them would break real work every day to
// prevent something the user can put straight back.

/// The system menu, whose AXTitle is "Apple".
let APPLE_MENU_TITLE = "Apple"

/// Leaf titles that end the user's session or destroy something they cannot get
/// back. Matched case-insensitively against the leaf, ignoring a trailing "…"
/// and any "…" the app spells with three dots.
private let DESTRUCTIVE_LEAVES: Set<String> = [
  "shut down", "restart", "log out", "sleep", "lock screen", "empty trash",
  "erase all content and settings", "erase assistant", "erase",
]

private func normalizedLeaf(_ title: String) -> String {
  var t = title.lowercased().trimmingCharacters(in: .whitespaces)
  for suffix in ["…", "..."] where t.hasSuffix(suffix) { t = String(t.dropLast(suffix.count)) }
  // "Log Out the user…" / "Shut Down…" — the user's short name rides along.
  for stem in DESTRUCTIVE_LEAVES where t.hasPrefix(stem) { return stem }
  return t.trimmingCharacters(in: .whitespaces)
}

/// True when pressing this path would end the session or destroy data.
func isDestructiveMenuPath(_ path: [String]) -> Bool {
  guard let leaf = path.last else { return false }
  return DESTRUCTIVE_LEAVES.contains(normalizedLeaf(leaf))
}

/// The top-level menus worth telling a model about: the app's own, never the
/// system's.
func listableMenuTitles(pid: pid_t) -> [String] {
  menuEntries(pid: pid, under: [], levels: 1).map { $0.title }.filter { $0 != APPLE_MENU_TITLE }
}

func menuEntryDict(_ e: MenuEntry) -> [String: Any] {
  var d: [String: Any] = ["path": e.path.joined(separator: " > "), "title": e.title]
  if !e.enabled { d["enabled"] = false }
  if !e.shortcut.isEmpty { d["shortcut"] = e.shortcut }
  if e.hasSubmenu { d["submenu"] = true }
  return d
}
