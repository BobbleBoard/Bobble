# Canvas assessment — Bobble build `7f02b758`

Assessment only. Nothing in the app was changed for this; two probes were written
(`tests/e2e/canvas-assess.mjs`, `tests/e2e/canvas-click-assess.mjs`) and they only
look. Evidence: this folder (`m*` = model-driven turns, `c*` = clicking).

## How it was run

- A fixture project with every type the canvas routes: png/jpg/gif/webp, mp4,
  flac/mp3, glb (a real TRELLIS mesh, 26 MB), docx ×2 (one is GenOffice's own
  kitchen-sink), xlsx with formulas, pptx, pdf, md, json (200 rows and 5,000
  rows), csv, txt, svg, html, py.
- Two ways a person reaches the canvas:
  1. **Asking** — a real chat model (Qwen3.5 4B MTP; the 9B leaves this 24 GB
     Mac at 11% free, see notes) through the app's default bash-CLI tool
     interface, 23 asks a person would type, dialogs answered the way a person
     would (Cancel / Don't).
  2. **Clicking** — `+ › Files`, every fixture clicked in the tree, the panel's
     own chrome exercised (tabs, resize, `+` menu, close, popout).
- Isolated HOME (no pollution of your chats/settings), the real model cache,
  headless and backgrounded throughout. Nothing reached the screen: the app
  asked before driving Chrome/Preview/QuickTime/VLC every time, and the probe
  said no.

## The short version

**The canvas's surfaces are good. The model almost never reaches them.**

Clicking, every file type opened on the right surface, including the live
docx/xlsx/pptx/pdf editors. Asking, the model got a file onto the canvas in 3 of
23 turns; the rest ended in a terminal dump, a blocked `open`, a consent dialog
for a Mac app, a five-minute hang, or — twice — a crashed renderer. Several of
those endings came with the model telling the user something false.

## Clicking (the canvas itself)

| File | Tab kind | What showed | Verdict |
|---|---|---|---|
| mug.png / .jpg / .webp | image | the picture, full width; Download as PNG, reload, Open menu, fullscreen | ✓ |
| mug.gif | image | the picture at natural 256 px, centred | ✓ (scaling differs from png — natural size vs fit) |
| clip.mp4 | video | native player, 0:02, controls | ✓ |
| beat.flac / beat.mp3 / sfx.flac | audio | native `<audio>` strip, 0:20 | ✓ works · ✗ bare control, no waveform — the thread's audio card has one; two looks for one sound |
| mug.glb | model | three.js viewport, the mesh, orbitable | ✓ works · ✗ mesh framed small (~⅓ of the viewport) |
| README.md | file | rendered markdown (table, code block), Rendered/Raw toggle | ✓ |
| users.json / big.json | file | code editor with line numbers; 5,000-row file scrolls without lag | ✓ |
| data.csv / notes.txt | file | plain editor | ✓ (csv as text, no grid) |
| boat.svg | file | rendered SVG, Rendered/Raw | ✓ |
| letter.docx / kitchen-sink.docx | office | page view; kitchen-sink shows headings, bold/italic/underline/strike, colour, list, link, table, image, equation; "10 words", "61 words" | ✓ · toolbar hidden by default and the "Show toolbar" pill is clipped at the top; opens at 50% zoom |
| budget.xlsx | office | grid, formulas evaluated (Total 1600), Sheet tab bar | ✓ |
| pitch.pptx | office | slide 1 of 2, Notes, 29% | ✓ |
| sample.pdf | office | page thumbnails + page, 80% | ✓ |
| File tree | filetree | every file with a type badge (JSO/CSV/TXT/XLS/DOC/PPT/MD/PDF/FLA/MP3/MP4/GIF/GLB/JPG/PNG/WEB/SVG), folders open, filter box | ✓ |
| `+` menu | — | Files ⌘P · Browser ⌘T · Terminal · Subagents | ✓ |
| Rail resize | — | drag handle works | ✓ |
| 21 tabs open | — | **3 visible, no overflow affordance** (no scroll hint, no count, no menu); Files tab out of sight | ✗ |
| Close / popout | — | no close control found by selector (hover-only?); `canvas-popout` not present | needs a hand on it |

Not covered by clicking: typing into the office editors (edit round-trips), and
the built-in browser view (native overlay; the model never opened one).

## Asking (a real user, a real model)

| # | Ask | What happened | Canvas | Verdict |
|---|---|---|---|---|
| 1 | tiny website, "open it so I can see it" | files written; then `open ./site/index.html` ×2 → blocked, and the note says it opened; model: "now open in your default editor" | terminal of harness text | ✗ false claim — `m01` |
| 2 | "is the counter working? check the page you opened" | 3 × "Let Bobble use Google Chrome?" (cancelled) before the page rendered in the Activity tab | rendered page ✓ | ~ — `m02` |
| 3 | change the label, dark background | edit correct; the Activity tab morphed from the page into `cat index.html`; the page never came back | terminal | ✗ — `m03` |
| 4 | new chat: write stats.py, run it | **"fetch failed"** in red, "Getting this ready" for 5 min; recovered on its own | — | ✗ — `m04` |
| 5 | markdown report, "then open it" | written; never opened; the terminal showed the previous ask's python output | terminal | ✗ — `m05` |
| 6 | users.json, count over 60 | correct (58); Activity tab opened a file called **`60])}`** — "Could not read this file" — a fragment of a python one-liner lifted as a path; users.json never shown | junk file tab | ✗ — `m06` |
| 7 | big.json, "I want to look through it" | a bash summary; the file never opened | terminal | ✗ — `m07` |
| 8 | csv + txt side by side | bash only | terminal | ✗ |
| 9 | draw a paper-boat SVG | written (hand-drawn — the SVG connector is not installed in a fresh HOME) and **rendered** | svg ✓ | ✓ — `m09` |
| 10 | open png, gif, webp | `open` blocked; "Let Bobble use Google Chrome?", "…Preview?" (cancelled); model: "All three files have been successfully opened in their respective apps" | terminal | ✗ false claim — `m10` |
| 11 | open clip.mp4 | **`ffplay ./media/clip.mp4`** (a GUI player that blocks); six consent dialogs in one turn (Mac ×2, QuickTime ×2, Safari, "Apple Media Player"); 300 s hang | terminal | ✗ — `m11` |
| 12 | open beat.flac + beat.mp3 | `ffplay ./media/beat.flac` — plays through the speakers, blocks; 300 s | terminal | ✗ — `m12` |
| 13 | open mug.glb | "Let Bobble use VLC media player?" | terminal | ✗ |
| 14 | edit letter.docx | 300 s of python; **overwrote `letter.docx` with an empty document** (10,037 bytes, 0 paragraphs), then reported it "empty" | terminal | ✗✗ data loss — `m14` |
| 15 | read kitchen-sink.docx | `read` returned 3.3 KB of zip bytes into context (letter.docx earlier: 9.6 KB); then **renderer crash — React #185**, preceded by 4 × `Cannot read properties of undefined (reading 'dimensions')` | crashed | ✗✗✗ — `m15` |
| 16 | add an April row to budget.xlsx | edit correct (openpyxl; Total 1630 as a literal); `open` blocked + note; sheet never shown | terminal | ~ — `m16` |
| 17 | add a slide to pitch.pptx | `ModuleNotFoundError: No module named 'pptx'` ×12 in the app's CLT python 3.9; **renderer crash — React #185 again** | crashed | ✗✗✗ — `m17` |
| 18 | read sample.pdf; new invoice.docx | not reached (crash) | — | — |
| 19 | example.com "in the browser", the heading | `open -a "Google Chrome"` → the wrapper printed the whole `browser` help into the terminal plus "[This opened Google Chrome… Do NOT use the built-in browser tools]"; heading correct; no browser tab | terminal, retitled "Example Domain" | ~ |
| 20 | "show me the project folder" | `ls` | terminal | ✗ |
| 21 | open mug.png, README.md, index.html | nothing opened | terminal | ✗ |
| 22 | "use a subagent to write a haiku" | no subagent; the model wrote it; `open` blocked; file never shown | terminal | ~ |
| — | (earlier, real HOME) generate music in chat | the FLAC opened as an **empty text-editor tab** | text tab | ✗ — `m00` |

## Defects, ranked

1. **Renderer crash, twice** (`m15`, `m17`). Both after a burst of 10–12 rapid
   bash results into the Activity terminal tab; both preceded by
   `TypeError: Cannot read properties of undefined (reading 'dimensions')` ×4
   (xterm's renderer) and then `Minified React error #185` (maximum update
   depth). The error boundary catches it ("Your chats are on disk"), but the
   session is gone for the user. Reproducible with any looping model.
2. **A user's file destroyed** (`m14`). Asked to change two words in
   `letter.docx`, the model emptied it. Nothing in the harness distinguishes
   "write a new file" from "clobber an existing one the user named"; and the
   `read` tool hands an office file back as raw zip bytes, which is what sent
   the model down that road.
3. **The `open` note lies, so the model lies** (`m01`, `m10`, `m19`). Two
   independent mechanisms: the bash wrapper blocks `open <file>` with exit 1
   (`tool-cli-bridge.ts:242`, "use the read tool"), and `opened-app.ts`
   appends "[This opened the app that owns that file… mac snapshot…]" from the
   **shape of the command alone** — after a block, after a denied consent,
   even for a file that does not exist. Neither mentions `present`, the tool
   built for exactly "open it so I can see it". Result: "now open in your
   default editor", "opened in Preview", "opened in Chrome" — none true.
4. **The model cannot find the canvas.** In 23 asks, `present` was never
   called and the file tree never opened; instead `open`, `cat`, `head`,
   `ffplay`, `find`, and computer-use consent for Chrome, Preview, QuickTime,
   Safari, VLC, "your Mac" — six dialogs in one turn (`m11`). The one surface
   the model reliably reaches is the Activity terminal.
5. **The Activity tab eats what the user was looking at** (`m03`, `m06`). A
   rendered page becomes `cat` output on the next command; a python one-liner
   becomes a file tab named `60])}` (activity-CLI path lifting).
6. **New chat → "fetch failed" and a five-minute "Getting this ready"**
   (`m04`), recovered by itself. Not reproduced a second time; the main log
   around it shows only the power policy easing off.
7. **No guard on `find /`** (a whole-disk walk, still running at 4m59s in the
   sandboxed chat) **or on `ffplay`/`afplay`/`mpv`** (screen and speakers;
   300 s hangs). `open` and `say` have guards; these do not.
8. **Tab overflow**: 21 tabs, three visible, nothing says so (`c05`).
9. **Two routing tables disagree**: `present-store.ts` (`BY_EXT`, no audio
   entries → the text editor) vs `file-preview.ts` (knows flac/mp3). That is
   the empty text tab for a generated FLAC (`m00`).
10. **Consent dialog spam** — the app's "Let Bobble use X?" is the right
    safeguard, and it was the only thing between the model and your screen
    twelve times today; but six in one turn is a UX of its own.
11. Office editors: toolbar hidden with its "Show toolbar" pill clipped at the
    top; docx opens at 50%. Canvas audio is the bare `<audio>` while the
    thread has a waveform transport. 3D mesh framed small.
12. Guardian banner shows an idle hold ("Waiting to generate — 51% free…
    (3/4)") over a chat with nothing queued. Mine, from today; fixed in
    source (`queued` on the event), not yet built.
13. Compaction fires every 2–3 turns on the 4B at 32k context; the model's
    answers reference things that were compacted away ("page 19").
14. The app's shell python is the CommandLineTools 3.9 — no `python-pptx`
    (openpyxl and python-docx happened to be present). A user asking for
    slides gets a 12-loop of ModuleNotFoundError.

## Notes

- **Model choice is memory-bound on this Mac.** Qwen3.5 9B at the app's
  `-c 32768 --parallel 1` puts the machine at **11% free** (the shed line is
  8%); the 4B sits at 7 GB resident (4.8 GB of KV). The assessment ran on the
  4B for that reason, and a 4B is the weakest link in every model-driven row
  above — the canvas findings (1, 3, 5, 7, 8, 9, 11) stand regardless of
  model; the tool-choice ones (4, 10) would soften with a bigger model that
  this machine cannot comfortably hold beside anything else.
- Probe lessons, so the next run is cleaner: `project:set` over IPC does not
  reach the renderer's project store (new chats went to per-chat sandboxes
  until the probe reloaded after setting it); folders in the tree open
  expanded, so clicking a folder collapses it; a page screenshot cannot see a
  native office view — `office:capture` can.
