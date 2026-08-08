# GenOffice integration — module brief

**Status: a plan. Nothing has been built, vendored, or installed.** This is the
scope, size and sequence for adopting GenOffice as Bobble's office layer
(`.docx` / `.xlsx` / `.pptx` viewing and editing). Licensing is settled
separately in [LICENSING.md](LICENSING.md).

**Confidence note.** The original draft rested on a source read alone. **Step 1
has now been run** (2026-08-08, upstream `d8305ff`) — see §1a. It passed, and it
also proved two of this document's assumptions wrong. Those are corrected inline
and flagged **[corrected after probe]** so the diff is legible.

---

## 1a. Step 1 result — it runs, and it runs offline

Built `@genoffice/docs` at upstream `d8305ff` and opened
`fixtures/generated/simple.docx` in a probe that recorded every non-`file://`
request before allowing it.

| Question | Answer | How |
|---|---|---|
| Opens a real `.docx`? | **Yes** | Window titled `simple.docx`, content rendered, "Page 1 of 1 — 10 words" |
| Needs a Genspark login? | **No** | No auth gate anywhere in `apps/docs`; every `Genspark` hit in the docs tree is an AI-credit i18n string |
| Phones home? | **No** | `external: []` — **zero** network requests, measured not assumed |
| Electron version clash? | **None** | Theirs 43.3.0, ours 43 |
| Docs module size | **21 MB** | 4 MB main + 17 MB renderer, of which 13 MB is 22 font files |

**The layout you asked for already exists.** The probe screenshot shows chat
dock on the left, document on the right, ribbon on top — that is their
standalone window, unmodified. Nothing to build for the dedicated-window case
beyond hosting it.

**Two corrections this probe forced:**

1. **There is no consumable `@genoffice/docs` main library.** Their own shell
   imports the seam from *source* — `from '../../../docs/src/main/docs-main'` —
   and compiles it into its own main bundle. We must do the same: vendor the
   TypeScript and build it into our Electron main. The transitive closure for
   the main half is 8 workspace packages (`electron-utils`, `i18n`,
   `project-store`, `ai-provider`, `ai-search`, `file-parse`, `docx-engine`,
   `ui`). The renderer and preload we consume as built artifacts. **This is the
   single biggest correction — it is the difference between "add a dependency"
   and "vendor a subtree".**
2. **`packages/ai-search` is not a clean delete.** `docs-main.ts` imports six
   symbols from it directly (`ensureGenofficeLogin`, `gskApiKey`,
   `gskLoginInfo`, `hasGskAuth`, `webSearch`, `imageSearch`). Dropping it means
   a ~20-line stub, not `rm -rf`.

**Three things that got better:**

- `registerAiIpc()` is a **separate export** from `registerDocsIpc()`. The
  Genspark-bound AI can simply never be registered — the AI-swap risk in §2 is
  optional work, not a prerequisite.
- Upstream ships `tools/gen-third-party-notices.mjs`. We can generate the
  Apache-2.0 §4(d) notices with **their** tool instead of writing ours.
- **Docs and slides need no cargo.** Only sheets carries the Rust sidecar, and
  neither `apps/docs` nor `apps/slides` references it. A docs-first build keeps
  cargo out of CI entirely.

**Trademark surface, now seen rather than guessed:** a `Genspark AI` ribbon tab
and a `Genspark` panel header with logo. Both are in the renderer, so the
rebrand is a renderer patch and is exactly what the §6 build check must catch.

---

## 1. The finding that shapes everything

GenOffice is **not a component library**. It is five separate Electron
applications (docs, sheets, slides, pdf, markdown) plus a host shell. Each editor
is a whole renderer process with its own preload bridge, its own unscoped global
CSS, and mandatory main-process services. There is no `<DocsEditor/>` to import.

Mounting their React inside our tree is not a hard road — it is the wrong road:

| Obstacle | Measured |
|---|---|
| No component boundary | `apps/docs/src/renderer/App.tsx` is **130 KB / 3205 lines** — ribbon, AI dock, find/nav and editor as one unit |
| Preload surface is the real work | `apps/sheets/src/preload/index.ts` alone is **79,543 bytes**; 27 files touch `window.desktop` |
| Global CSS would bleed into us | `apps/docs/src/renderer/styles.css` is **142,725 bytes**, unscoped, opening `* { box-sizing }`, `body { overflow:hidden }`, class names like `.app`, `.editor-area` |
| Embed mode is per-process, not per-instance | `Ribbon.tsx:235` reads `?mode=tab` at **import time** |
| Main-process services are mandatory | sheets starts a **Rust sidecar** before the view exists; slides needs **HarfBuzz WASM** in main |

**But** they ship a deliberate embedding seam —
`configureDocsRuntime()` → `registerDocsIpc()` → `createDocsView() → WebContentsView`
— and the renderer honours `?mode=tab` to drop its own window chrome.

That seam is **the same mechanism Bobble's canvas already uses for browser
tabs** (`apps/desktop/electron/canvas/browser-manager.ts`,
`apps/desktop/src/chat/canvas/native-surfaces.ts`). We host their renderer as a
native view; we do not import their React.

### This reframes your two options

They are not alternatives. **(a) is a superset of (b)** and they share ~80% of
the work.

---

## 2. Size and scope

| | Shared foundation | (b) Dedicated window | (a) Editor in a canvas tab |
|---|---|---|---|
| **Work** | vendor + `ee/` delete + build 3 modules + `extraResources` packaging + cargo in CI + rebrand + notices | ~30 lines of window wiring | rect/visibility plumbing on the existing browser-overlay machinery |
| **Layout we write** | — | **none** — chat-left / doc-right / toolbar-top already exists upstream (`App.tsx:2620–2695`) | tab chrome; their ribbon renders in `mode=tab` |
| **Days** | **5–8** | **+2–3** | **+4–6** (or +2–3 if (b) lands first) |
| **Main risk** | upstream velocity | second app-menu owner; our chat vs their AI dock | native view paints above the DOM — occludes menus, no DOM cross-fade |

Plus, to whichever we pick:

- **AI swap: 3–5 days, uncertain.** Their AI is Genspark-account-bound. A
  `custom` provider with `needsBaseUrl: true` already exists in
  `packages/ai-provider/src/providers.ts` — an OpenAI-compatible endpoint, which
  is exactly what our llama-server serves. Whether it is reachable from their
  settings UI is *unverified*.
- **Global-menu conflict: 1–2 days.** `buildDocsMenu()` and friends set
  Electron's **application** menu. Their shell arbitrates per active tab; Bobble
  owns its own menu. Either suppress theirs (losing their shortcuts) or adopt
  per-window swapping.

**Total for a shipping office capability: roughly 10–18 days**, front-loaded on
the shared foundation.

---

## 3. Weight it adds

- **12.8 MB of fonts** (25 files; Noto CJK subsets alone are 2.5 + 3.5 MB)
- **~4.7 MB of i18n tables** (`strings-ribbon.ts` is 688 KB)
- a **per-architecture Rust binary** (the sheets sidecar) — adds cargo to CI
- **harfbuzzjs WASM**
- Incremental app size **~30–50 MB, estimated not measured** (their full DMG is 137 MB)

Version alignment is in our favour: **Electron 43 and React 19 match ours
exactly.** Their Vite/TS versions differ from ours, which is irrelevant so long
as each module keeps its own `electron-vite` build and we consume `out/`.

---

## 4. The real risks

1. **Upstream velocity — the top risk.** The repo was created **2026-07-31** and
   has **24 commits for 1204 files**: an internal repo squashed and drop-pushed,
   with releases v0.4.110 → v0.5.1 → v0.5.83 → v0.5.149 inside four days. We pin
   and cherry-pick; we cannot rebase. And we would be merging bulk drops into
   files of 130–155 KB. **This is a fork, and it should be budgeted as one.**
2. **xlsx editing is the weakest of the three.** Their own
   `apps/sheets/docs/architecture.md` "Production gaps" lists missing formula
   validation, conditional formatting and editable charts, and notes external
   workbooks are read-only while a streaming path is validated.
3. **Native views paint above the DOM.** Every piece of our chrome that overlaps
   an office tab needs the `setOverlayOpen` / `setPanelOpen` treatment we already
   use for browser tabs.

**One risk that turned out not to be real:** `ee/` is *not* load-bearing. Its
README says it is "intentionally empty today except for this notice and the
license", and the tree confirms only `ee/README.md` and `ee/LICENSE`. We still
delete it mechanically per LICENSING.md §6, because its stated future use is
offline licence verification.

---

## 5. Recommended sequence

**Ship (b) first.** It is the cheaper half, their renderer *already is* the
layout you described, and every artifact it produces — vendored modules, module
builds, packaging, preload wiring — is reused verbatim by (a). Then add (a) as a
canvas tab kind on top of the browser-overlay machinery that already exists.

### The first three steps

1. **Prove it runs before vendoring anything.** Clone upstream at a pinned commit
   into a scratch dir, build `@genoffice/docs`, and write ~40 lines of Electron
   that call `configureDocsRuntime` + `registerDocsIpc` + `createDocsView(path)`
   into a bare window. That answers *"does the docs editor open and edit a real
   .docx with no shell, no Genspark login, offline"* in about a day at zero
   commitment. **If this fails, the whole plan changes — so it goes first.**
2. **Write the vendoring script** (LICENSING.md §6): pin the commit, delete
   `ee/`, drop `apps/shell`, `apps/pdf`, `apps/markdown` and
   `packages/ai-search`, record the hash. Land `THIRD-PARTY-NOTICES.md` and the
   build check for the strings `GenOffice`/`Genspark` in the same change —
   those are the two failures that are **silent**.
3. **Settle the AI question before any UI work.** Point their `custom` provider
   at our llama-server base URL and see whether the AI dock streams. If yes, (b)
   is a two-week feature. If no, ship (b) with the dock suppressed
   (`includeAiHandlers: false`, which their own shell already passes for sheets)
   and Bobble's chat beside it.

---

## 6. Verification status **[corrected after probe]**

**Settled by step 1** (§1a):

- docs opens a `.docx` with **no network and no Genspark login** — measured;
- **actual** docs module size — 21 MB;
- the AI dock is **optional**, not load-bearing (`registerAiIpc` is separate);
- docs needs **no cargo**.

**Still open:**

- whether the **slides** renderer behaves the same as docs (only docs was run);
- whether the `custom` AI provider is **reachable from their settings UI** —
  now a nice-to-have rather than a blocker, since the dock can stay unregistered;
- whether `registerDocsIpc()`'s channels collide inside *our* main process. The
  probe ran it in a bare host, not in Bobble's main alongside our
  `browser:`/`canvas:`/`gen:`/`pi:` handlers. **This is now the top unverified
  item** and it is the next thing to test;
- how much of the 8-package main-process subtree survives contact with our
  pnpm workspace (they use npm workspaces).

**Not verifiable by probing at all:** upstream velocity. Head was `d8305ff`,
dated the same day this was written, at PR #53 — the repo has moved a long way
past the 24 commits §4 describes. That risk is a judgement call, not a
measurement, and it remains the reason to budget this as a fork.
