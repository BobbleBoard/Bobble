# Connectors — candidate designs

Four candidates for the Connectors tab, reachable at `?candidates=connectors` (`PI_DESKTOP_CANDIDATES=connectors`,
`PI_DESKTOP_CANDIDATE_V=shelf-plus|shelf|ledger|reach`). Nothing outside this directory changed. Screenshots are in
`shots/`; `node src/candidates/connectors/shots.mjs all` regenerates them, headless, against the renderer-only dev
server `npx vite --config src/candidates/connectors/vite.candidates.config.mjs` (:5312; it builds no
`dist-electron`, so an e2e suite running against the built app is undisturbed). `shots.mjs current` shoots the
shipping screen and `shots.mjs hub` the model hub, which is the bar the candidates are held to.

All four run against the real stores and the real IPC: the catalog + registry + `/Applications` scan from
`useConnectorsStore`, the bundled skills from `useSkillsStore`, the MCP mode from `useSettingsStore`. Add / turn on /
turn off / remove / fill a key / add a custom server / change the mode all round-trip. The one shared data layer is
`data.ts`; the detail sections are `detail-parts.tsx`; marks and the state control are `marks.tsx`.

**Round 2** (2026-09-07) started with `CRITIQUE.md` — the three round-1 candidates and the shipping screen re-shot
and put beside the 24 reference screenshots and the model hub — and the round-2 sections below are what that
critique changed. **Round 3** (the same day, 10:50–) started with `JUDGEMENT-R3.md`, an independent judge's verdict
of *at parity*, and its section is what that judgement changed. **Round 4** (11:48–) started with `JUDGEMENT-R4.md`,
the verdict of *above the references* and the ten defects found on the way; the section right below is that list
worked through. Read the judgements first.

## Round 4 — the defects found while granting "above"

`JUDGEMENT-R4.md` called Shelf+ above the references and listed what it found on the way. This round is that list,
in its order. Every image named here is from ONE run (`shots.mjs all`, 2026-09-07 ~12:40); the round-3 set is gone.
The round was interrupted once by a usage limit mid-edit — see "Things I noticed" 37 — and picked up from the diff.

### The ten items

1. **A failed server no longer reads as healthy anywhere.** The failure is a FACT BESIDE THE STATE, not a sixth
   `ItemState`: the switch is honestly on (the registry says so), and what changed is that every surface asks
   `failing(item)` before drawing the state. The last failed listing is kept in the same cache as the list
   (`ToolFailure`, `cand-connectors:failed:<id>`, persisted, cleared by the next success — "a success outlives every
   failure before it" is the one ordering rule), and `useCatalog` folds it into each item as `failure`, so the ledger
   row, the card's control, the pill and the detail's status line all read one record instead of the Tools
   section's component state. What each surface does with it:
   - The detail's status line: `● Needs setup` (amber) where the connector takes a key — the likeliest cause — and
     `● Not responding` otherwise; the switch stays, because it is still how the server is turned off.
     `shelf-plus-setup-bad-key-bobble-dark.png` / `-light` (was a green `● On` over *Could not list its tools.*);
     `shelf-plus-not-responding-detail-bobble-dark.png` (Blender, whose fixture package was made to exit before the
     handshake: amber status, *Could not refresh — this list is from its last answer* with the remedies ABOVE the
     seventeen rows it still has — under them it was the last thing on the pane).
   - The ledger row: under *Needs setup*, with an amber, dated second line — *Did not answer · tried just now*
     (`failureLine`) — in place of the reach line, and the `● Set up` / `● Try again` pill where the switch was.
     `shelf-plus-ledger-bad-key-bobble-dark.png` / `-light`, `shelf-plus-not-responding-ledger-bobble-dark.png`.
     The summary reads *4 tools on · 1 needs setup · 1 off · 1 skill on · 7 built in*; a failing server is never
     under *On*, and the *On* filter excludes it while *Needs setup* includes it.
   - The card: the same pill (`StateControl`), and the card sorts to the first slot with the other needs-setup
     items. The pill's count holds at 1 through the bad key.
   - The way back: the row's *Set up* opens the detail with the key card already open over the saved value
     (`shelf-plus-setup-change-key-bobble-dark.png` — the *Change the key* link under the error is hidden while the
     card is open); *Try again* on a row re-lists where it is clicked and opens the detail so the answer is in view
     (`shelf-plus-not-responding-recovered-bobble-dark.png`: green `● On`, *17 · listed just now*, the pill's count
     gone, the card back to a switch).
   - At 900 and 640, where there is no ledger: `shelf-plus-w900-not-responding-bobble-dark.png` (the sheet) and
     `shelf-plus-w640-not-responding-bobble-dark.png` (the column); the card's pill and the *Needs setup 1* pill are
     what the list carries.
   - The warm never spawns a needs-setup server (they are `enabled: false`), and a recorded failure is retried once
     per launch, not once per registry change (`attempted` — MEASURED: the bad-key save used to start GitHub
     twice).
2. **Both tool-list variants are rendered.** The fixture registry now carries Sequential Thinking added and
   switched off, never run, so the *Off* group is in every ledger frame and
   `shelf-plus-detail-never-run-bobble-dark.png` (and the other three candidates' `*-detail-never-run-*`) reads
   *Turn it on to list its tools.* under `○ Off`. Memory switched off from its card and opened:
   `shelf-plus-detail-memory-off-bobble-dark.png` — `○ Off`, *Tools 9 · from its last run*, the nine rows kept, no
   Refresh (it is off). `shelf-plus-ledger-off-bobble-dark.png` has both under *Off 2*. Also new: *Refresh* in
   flight — `shelf-plus-ix-refresh-in-flight-bobble-dark.png`, *9 · listing…* with the spinner in the button —
   from the fixture's `{ delayMs }` control.
3. **The skill row is whole.** `SKILL_LINE` in `data.ts`: twelve authored lines under `REACH_MAX` (44), one per
   bundled skill (*Reviews diffs for bugs and cleanups*, *Branches, commits, PRs and recoveries*, *Scaffolds an MCP
   server, Python or Node*, …); a skill the table does not know falls back to its description. Whole at 1440
   (`shelf-plus-bobble-dark.png`, the pane's *Skills on* row) and at 1152 (`shelf-plus-w1152-bobble-dark.png`).
4. **The fresh pane opens the built-in group by itself** when it is all the ledger has (`Resting`: `builtinsOpen`
   defaults to `empty && cat.loaded`; a person's toggle then holds). `shelf-plus-fresh-bobble-dark.png` / `-light`:
   *Nothing added yet.* over seven rows that already work, not a chevron and 400px of nothing.
5. **Focus and selection are different rings.** Focus is an `outline`, 2px, 2px OUT (`outline-offset`) — the app's
   own focus grammar — where selection stays a 1px box-shadow line with a halo hugging the card. MEASURED in
   `shelf-plus-ix-focus-card-bobble-dark.png`: accent at x 20–21, the card's edge at 23; in
   `shelf-plus-detail-github-bobble-dark.png`: halo at 22, accent at 23. Both on one card:
   `shelf-plus-ix-focus-selected-card-bobble-dark.png` (Memory selected, then Tab-focused: 2px ring standing off a
   1px ring). Tab order unchanged: card → control, never control → card.
6. **The 1104 crossing changes the pane mode and nothing else.** `PINNED_MIN = 1104`, not 1080: the pinned list is
   the box minus 420, the grid goes two-column from 660px of list, and the list's `scrollbar-gutter: stable` costs
   ~15px — so from 1104 the pinned list is ≥ 660 and never one column. `shelf-plus-ix-pinned-1105-bobble-dark.png`
   and `shelf-plus-ix-overlay-1103-bobble-dark.png`: two columns on both sides.
7. **Hover is visible at 1×.** `--pd-bg-hover` is translucent, and set as the card's *background* it composited over
   the page base — a five-step lift. Now it is LAYERED over `--pd-bg-raised` and the hairline goes to
   `--pd-border-strong`. MEASURED (`shelf-plus-ix-hover-card-bobble-dark.png` against the same card at rest):
   fill (30,30,33) → (43,43,46), border (39,39,41) → (77,77,78).
8. **The sheet enters opaque** — only the scrim fades. `candp-sheet-in` is a 24px slide with no opacity ramp;
   `shelf-plus-ix-sheet-w900-000ms-bobble-dark.png` is a solid panel with the close button, `-080ms` shows the
   body fading in over the sheet's own ground, never over the list. Taken.
9. **The back link holds still through a swap.** It is rendered outside the keyed pane body (`BackLink`), so
   `shelf-plus-ix-swap-000ms-bobble-dark.png` has *‹ Your agent* at the top of an otherwise blank pane while the
   body remounts. Taken.
10. **No group of cap+1 is capped.** `ToolList` and `Section` both show the whole group when it is at most one
    over the cap: Blender's nine *Looks things up* rows are nine rows, not eight and *Show all 9*. Taken.

Also: the Remove row's caption said *Removing forgets its keys* on servers with no keys; it now says *The catalog
entry stays; add it again any time.* there.

### The probe's new hand on the servers

`fixtures/mcp-fixture.mjs` reads `$HOME/mcp-fixture-control.json` once at start — `{ "fail": [...] }` makes those
packages exit before the handshake the way a server whose dependency is gone does; `{ "delayMs": N }` holds every
answer — and `shots.mjs` writes it before a click and removes it after (`fixtureControl`). The app spawns servers
with its own `HOME`, so the fixture home is the seam. Every failure frame in this round is the real
`connectors:tools` handler reporting a real process that really exited, not a mocked error string.

### Still between this and a judge finding nothing

- **The failure's reason is still `exited (code 1)`.** The fixture writes *401 Bad credentials* to stderr and the
  handler drops it (proposal 8). The design says *Needs setup* on the strength of "takes a key"; with stderr it
  could say why.
- **The failure cache is a renderer cache**, like the list (proposal 7). A server that fails at chat start, in the
  pi child's own ConnectorHost, is not recorded here until this screen lists it.
- **The swap is still a cut**, and the pinned ↔ overlay switch a jump. Both deliberate; both noted before.
- **The heuristic split** (`readOnlyHint`, round-2 proposal 1) and **the footnote token** (below) are unchanged.
- **Ledger and Reach** carry the failure line and the never-run detail because they share the parts, but their
  round-3 rejections stand and nothing else in them moved.

### The footnote token — still a proposal

Unchanged from round 3: 13px / 18px for `--pd-font-size-footnote` / `--pd-leading-footnote` in every flavour,
applied here only inside `.candp`. The judge agreed; it moves with the model hub and Scheduled in one pass, not
from this directory.

### Things I noticed (round 4)

37. **A one-sided type guard narrows the other side too.** `failing(item): item is ConnectorItem | CustomItem`
    was written so the true branch could read `item.server`; TypeScript also narrowed the FALSE branch to
    "not a connector, not a custom" — `never` inside `summarize` (after skills were `continue`d away) and
    `SkillItem` in the detail header, where `item.state === 'builtin'` became "no overlap". This is the edit the
    usage limit cut through: four `TS2339`s and one `TS2367`, all from one annotation. It is a plain `boolean` now,
    and the one caller that needs the server narrows on `kind` itself.
38. **Two controls share a test id.** A failing GitHub has `cand-setup-github` on its card AND its ledger row;
    `page.click` takes the first in DOM order (the card), so the probe scopes the row's with `[data-testid=
    "cand-pane"] …`. Not a bug in the UI — both are the same act — but a thing to know when reading `shots.mjs`.
39. **The fixture's switched-off server changed the tab walk.** Sequential Thinking used to be the "+" the focus
    walk landed on; installed-and-off it is a switch, and the walk now takes the first `cand-add-*` in the Tools
    grid, whatever the fixture makes it.

## Round 3 — from parity to above it

The judge's verdict in one line: Shelf+ is above the references on the thing the owner objects to in them (one
surface, one search, one grammar) and below them on the most common path, because every installed-server detail
showed *Starting the server to list its tools…* and not one of 99 images showed what the spinner resolves to. This
round is about that path first, then the ranked list in order. Every image named here is from ONE run
(`shots.mjs all`, 2026-09-07 ~11:30), so the set is internally consistent; the round-2 Shelf+ set (09:23) is gone.

### The ranked list, item by item

1. **The tool list no longer depends on a spawn at look time — and the long case is drawn.** Two halves, both done.
   - *The cache.* `data.ts` keeps each server's list in `localStorage` (`cand-connectors:tools:<id>`, with the time
     it answered and the command line it answered for). It is filled the moment a server is turned on — `add`,
     `setOn(true)`, `setup` and `saveCustom` all warm it after the registry round-trip, which is the moment the
     judge named ("it is running then anyway") — and, in the background one server at a time, for any server that
     is on and has no list yet (enabled by hand in the JSON, or before this cache existed). On every open the pane
     draws the cached list at once with a caption saying when: `shelf-plus-detail-memory-bobble-dark.png` reads
     *Tools 9 · listed just now* with a *Refresh* on the right; `shelf-plus-detail-github-reopened-bobble-dark.png`
     is GitHub opened a second time — 50 tools, no spinner. A server that is off keeps its list (*N · from its last
     run*); a server that never ran says *Turn it on to list its tools* instead of spinning; a changed command line
     drops the list. The one spinner left is a server that is on and has never answered anything, and it is paid
     once per server, ever. (This is a renderer cache; the honest version lives in main — proposal 7 below.)
   - *The long case.* The probe now runs REAL servers: fixture `npx` / `uvx` / `node` shims on the app's PATH exec
     `fixtures/mcp-fixture.mjs`, which speaks MCP over stdio and lists the real servers' real tool names (GitHub's
     50, the reference servers', blender-mcp's 17, chrome-devtools-mcp's 26). The app's own `connectors:tools`
     handler spawns the real registry command line — the Command row still says `npx -y @github/github-mcp-server`
     — so what is on screen is what the handler returns, not a mock of the UI. GitHub after setup, in the pinned
     pane at 1440: `shelf-plus-detail-github-tools-bobble-dark.png` and `-light` (*Looks things up 30 / Changes
     things 20*, eight each then *Show all 30*); both groups opened: `…-tools-expanded-…`; the end of the detail:
     `…-tools-end-…`; in the 440px sheet at 900: `shelf-plus-w900-detail-tools-bobble-dark.png` and `-end`; at 640
     (full width now, see 3): `shelf-plus-w640-detail-tools-bobble-dark.png` and `-end`. Under Reach's in-place
     expansion: `reach-detail-github-tools-bobble-dark.png`, `-expanded` (the ~50-row column the judge predicted)
     and `-end`. Every other layout's `*-detail-memory-bobble-dark.png` shows the same nine-tool list where round 2
     showed the spinner.
2. **The setup button is the accent primary, full width of the card.** `SetupSection`: `variant="accent"`,
   `w-full`, the same button as *Add to Bobble*. Disabled it is the accent at half opacity — "primary, waiting" —
   `shelf-plus-detail-github-bobble-dark.png` (and `-light`); enabled, with a token pasted:
   `shelf-plus-setup-filled-bobble-dark.png` / `-light`. And the frames that did not exist: after *Save and turn
   on* the pane becomes On and lists the tools (`…-detail-github-tools-…`); a bad key —
   `shelf-plus-setup-bad-key-bobble-dark.png` — reads *Could not list its tools. / MCP server process exited (code
   1) / Try again · Change the key*, honest about what the app knows (the server's own stderr line, *401 Bad
   credentials*, never reaches the renderer — proposal 8); *Change the key* reopens the card over the saved value
   (`shelf-plus-setup-change-key-bobble-dark.png`: *Paste a new token*, *Keep the saved key*). The bad-key error is
   dated, so once a good key lists the tools it no longer prints under them (it did, for one render — caught in
   `…-tools-end-…` and fixed).
3. **Below 720px of content the detail takes the list's place.** A third pane mode, `full` (`OVERLAY_MIN = 720`):
   the list is hidden (kept mounted, its scroll position kept), the detail is the whole content box in a 560px
   reading column, the header (title, one-line summary, search, pills) stays above it, and the back link is
   *‹ Tools and skills* where Ledger puts *‹ Directory*. `shelf-plus-w640-detail-bobble-dark.png` (the setup card
   with the key whole), `-light`, `-end`, and `shelf-plus-w640-detail-tools-bobble-dark.png`. 900 keeps the overlay
   (`shelf-plus-w900-detail-bobble-dark.png`, 460px of dimmed list beside the sheet). The judge said whatever fixes
   this should be lifted to the hub; it is a width policy, and it is written down as proposal 9.
4. **The second line is smaller than the name — locally.** `.candp { --pd-font-size-footnote: 13px;
   --pd-leading-footnote: 18px }`. The app's Tailwind theme is `@theme inline`, so every `text-footnote` inside the
   candidate reads the scoped token and nothing outside it moves. Crop any card in `shelf-plus-bobble-dark.png`:
   name 14px, line 13px. The token itself is NOT changed — see "The footnote token" below for the proposal and the
   blast radius.
5. **A custom server's card and pane header say *Runs node · added by you*.** `data.ts`: the custom item's
   description is the ledger row's sentence; the path lives in the detail's *Command* row only
   (`shelf-plus-bobble-dark.png`, Weather; `shelf-plus-detail-custom-bobble-dark.png`). And the custom detail now
   lists the server's tools the way a catalog server's are listed — *a custom server is just a tool the catalog
   does not know* was the position; the pane now honours it (Weather: 4 tools, from the `node` shim).
6. **The constant rows are gone.** *Runs as* is dropped for MCP servers (the list's section header already says
   *each one runs as a local process*); it stays on built-ins, where *Inside Bobble. No separate process.* is the
   surprising fact (`shelf-plus-detail-builtin-bobble-dark.png`); a remote bridge gets a one-line caption under its
   command. *· official* is gone from *By*; the exception gets a sentence under the About rows: *Community server
   — not published by the Blender Foundation.* — `shelf-plus-detail-community-end-bobble-dark.png` (Blender is the
   community server in the fixture; the vendor's name is written the way the vendor writes it: `vendorOf`).
7. **Category is a link that searches for itself.** The About row's category (`shelf-plus-detail-github-…`, blue
   *Developer tools*) puts its words into the search; `matches()` now matches the category LABEL, not only its key,
   so *Developer tools* finds Memory, GitHub, Git, Sequential Thinking, Time and Postman
   (`shelf-plus-category-search-bobble-dark.png`, with the detail still open in the pinned pane; in the narrow
   modes the link also closes the detail so the result is what you see). A skill's category (*Developer*) does the
   same. The search's placeholder says so: *Search tools, skills and categories*.
8. **No ledger row truncates at the pane's designed width.** Every key-needing connector has an explicit reach
   line under 44 characters (`REACH_LINE`, `REACH_MAX`): *Signs in with your GitHub token*, *Signs in with your
   Notion token*, *Searches the web with your Brave API key*, … and the derived fallback is *Signs in with your
   {Brand} {token|API key|key}*, never the shouting identifier. `shelf-plus-bobble-dark.png`, the pane's GitHub
   row: whole, at 1440 and at 1152 (`shelf-plus-w1152-bobble-dark.png`).
9. **A glyph per skill.** `marks.tsx` `SkillOwnGlyph`: twelve authored 24-grid line glyphs keyed by skill id
   (code review is a magnifier with a check, git workflow a branch, MCP builder a plug, web app testing a browser
   window with a check, doc co-authoring two pages, internal comms a speech bubble, …), the category glyph as the
   fallback. The Skills grid in `shelf-plus-bobble-dark.png` has no two marks alike.

### What the judge could not see, now in the set

| State | Image(s) |
| --- | --- |
| The live MCP tool list, pinned / sheet / full / Reach | `shelf-plus-detail-github-tools-*`, `shelf-plus-w900-detail-tools-*`, `shelf-plus-w640-detail-tools-*`, `reach-detail-github-tools-*` |
| The setup card enabled, after saving, a bad key, changing it | `shelf-plus-setup-filled-*`, `shelf-plus-detail-github-tools-*`, `shelf-plus-setup-bad-key-*`, `shelf-plus-setup-change-key-*` |
| The community-server detail | `shelf-plus-detail-community-bobble-dark.png` (17 live tools), `-end` (the About sentence) |
| A fresh install, nothing added | `shelf-plus-fresh-bobble-dark.png`, `-light`, `shelf-plus-fresh-w900-bobble-dark.png` |
| The shell's real content width | `shelf-plus-w1152-bobble-dark.png`, `-light`, `shelf-plus-w1152-detail-bobble-dark.png` — pinned, two ~350px columns |
| The pane's ledger → detail swap | `shelf-plus-ix-swap-{000,060,120,200}ms-bobble-dark.png` |
| Pinned ↔ overlay across 1080 with a detail open | `shelf-plus-ix-pinned-1081-bobble-dark.png`, `shelf-plus-ix-overlay-1079-bobble-dark.png` |
| The sheet's entrance and the scrim at 900 | `shelf-plus-ix-sheet-w900-{000,080,160,250}ms-bobble-dark.png` |
| The built-in group expanding | `shelf-plus-ix-builtins-{000,080,160,250}ms-bobble-dark.png`, `shelf-plus-builtins-open-bobble-dark.png` |
| The pane scrolled, beside the hub's | `shelf-plus-pane-scrolled-bobble-dark.png`, `hub-pane-scrolled-bobble-dark.png` |
| Hover, focus rings, tab order | `shelf-plus-ix-hover-card-bobble-dark.png`, `shelf-plus-ix-focus-{chip,chip-plus,card,setup,switch,plus}-bobble-dark.png` |
| A chip's "+" after adding | `shelf-plus-ix-chip-added-bobble-dark.png`, `shelf-plus-detail-chrome-devtools-bobble-dark.png` |
| Overlay mode's footer | `shelf-plus-w900-end-bobble-dark.png`, `shelf-plus-w640-end-bobble-dark.png` |
| Light theme, narrow, with a detail | `shelf-plus-w900-detail-bobble-light.png`, `shelf-plus-w640-detail-bobble-light.png` |
| The Shelf+ set re-shot, with `*-detail-end` | every `shelf-plus-*` file, one run; `shelf-plus-w{900,640}-detail-end-bobble-dark.png` |

What those frames show, since a table of file names is not a judgement:

- **Transitions.** The pane body is keyed by what it shows, so a swap remounts it and runs a 250ms fade with a
  4px rise (`candp-swap`); the frames show the new content arriving, not a cross-fade — at 0ms the pane is blank
  for a frame, the hub's family-card swap is the same kind of cut. The card's selection ring animates in over
  150ms. The built-in group opens to its measured height (`grid-template-rows: 0fr → 1fr`, the engine measuring
  what the hub's `FamilyCard` measures by hand) — the 80ms and 160ms frames show one row, then three, under the
  rotating chevron. The sheet at 900 slides in 24px with a fade over 250ms while the scrim fades over 150ms
  (`…-ix-sheet-w900-080ms…` is mid-flight). The pinned ↔ overlay switch on resize is still a jump, and I think it
  should be: it is a layout mode changing under a window drag, not an act.
- **Hover and focus.** The card hover was measured invisible in the dark theme (a 3× crop of a hovered card beside
  one at rest: same shade), so hover now lifts the hairline to `--pd-border-default` as well as the fill. Keyboard
  focus on a card, chip or row draws the ring on the CONTAINER (`:has(> .cand-open:focus-visible)`), not on the
  inner button whose box is not what the eye reads as the thing. Tab order, measured: the five pills → each
  Recommended chip's open button then its "+" → each Tools card's open button then its control (switch, "+" or
  *Set up*) → *Show all* → each Skills card the same way. Card → control, never control → card.
- **The chip after adding.** The chip vanishes from Recommended (it is filtered on `available`), Chrome DevTools
  appears in Tools as on with a switch, in the ledger as *Attaches to Google Chrome*, and its 26 tools are listed
  the moment its detail opens because `add` warmed the cache.
- **The pane scrolled.** The pinned pane's top edge fades (the ScrollArea's 16px scroll-driven fade; a 4× crop of
  `shelf-plus-pane-scrolled-bobble-dark.png` shows the first line dimmed and the second not). The hub's
  `.pd-detail-panel` fades 24px inside its padding. Admission 10 is settled: both fade; the hub's is a touch deeper.

### The footnote token — proposal, not applied

`packages/themes/src/generated/themes.css:78–81`: `--pd-font-size-footnote: 14px; --pd-leading-footnote: 19px`
equals body (14/20) in the bobble and claude flavours; the codex flavour already has 13/18. The proposal is
**13px / 18px for the footnote in every flavour**, which is what the candidate scopes to itself. What it would
touch, from grepping `text-footnote` and `var(--pd-font-size-footnote)` outside this directory: the model hub's
row and card descriptions and its detail panel's byline, Scheduled's task rows, the activity chain's step lines,
chips, the tooltip body, the web-search card, the shipping Connectors and Skills rows, and every `text-footnote`
in settings and onboarding — roughly every second line in the app. It is the right change (the references draw
15/13 and the hub reads as two lines of grey text without it), and it is a one-line change with an app-wide
re-shoot, which is why it is a proposal: the hub, Scheduled and Connectors should move together, in one pass,
with their images side by side. `UI-AUDIT.md` D2's 12px floor is respected.

### Where I disagree with the judge, or did not do what it asked

- **"Cache the tool list the first time a server is turned on."** Done as asked, and one step further: servers
  that are on and have never been listed are warmed in the background when the screen opens, one at a time. The
  judge's own line was "the hub never spawns anything to fill its pane", and this does spawn — but it spawns the
  same processes the next chat starts, once per server ever, and it is what turns "the first look is a spinner"
  into "the first look is a list" for the registry a user already has. If that is too much, delete `useWarmTools`
  and the first open of a pre-existing server spins once; nothing else changes.
- **Item 3, the hub.** Not touched: the hub is outside this directory. Written down (proposal 9) with the widths.
- **Item 4, the token.** Deliberately not changed globally (the work order); demonstrated locally; proposed.
- **"If the other three candidates are kept."** Two of the cheap ones: Reach's not-added row has *Add to Bobble*
  under its description now, and Ledger's empty state names what to clear and clears it. Not done: Ledger's rail
  collapsing to marks at 640, the reason dropping below ~450px of directory, and the category scroller becoming a
  dropdown; Shelf's five-line subtitle at 640. Those three candidates are not the recommendation and each of those
  is an afternoon on a layout Shelf+ has already replaced.
- **The ~40-tool fixture is 50.** GitHub's server lists about that many; the fixture keeps its real names. The
  split lands 30 / 20, both groups over the cap, which is the case the cap was designed for.

### Still weaker than the references, or than the hub

- **The tool list is a renderer cache.** It lives in `localStorage`, per app profile; the real fix is main-side
  (proposal 7), fed by the pi child's own ConnectorHost at chat start so the list is never a separate spawn.
- **A bad key's error says "exited (code 1)"**, not "401 Bad credentials": the handler drops stderr (proposal 8).
- **The Looks-up / Changes split is still the name heuristic.** Chrome DevTools puts `navigate_page` and
  `take_screenshot` under *Changes things*, which is defensible and not authored. `readOnlyHint` from MCP tool
  annotations should win where a server sets it (round-2 proposal 1, still open).
- **The swap is a fade-in, not a cross-fade**; the pinned ↔ overlay switch is a jump.
- **Ledger and Shelf at 640** are as round 2 left them (see the disagreements).
- **Type** is a local demonstration until the token moves.

### Proposed changes outside this directory (round 3, continuing the round-2 list)

7. `electron/connectors/connectors-main.ts` — persist each server's last tool list beside the registry
   (`~/.pi/desktop/mcp-tools.json`: id, command line, listed-at, tools), written by `connectors:tools` and — the
   real win — by the pi child's ConnectorHost at chat start through the extension seam, so the screen never spawns
   a server to describe it. `connectors:list` returns it; the renderer cache in `data.ts` becomes a mirror.
8. Same file — return the server's last stderr line with `error` (`ConnectorHost` already collects it through
   `onLog`); *401 Bad credentials* is what a person can act on, *exited (code 1)* is not.
9. `src/models/ModelsView.tsx` — the hub's width policy: pinned pane from 1080px of content, an overlay sheet
   with a scrim from 720, the detail in the list's place below that (`ShelfPlus.tsx` `PaneMode`); at a 900 window
   today its list is 104px and the download buttons draw over the avatars.
10. `packages/themes` — the footnote token, above.
11. `packages/mcp-lite/src/detect-apps.ts` — the community exception's vendor name (`vendorOf` in `data.ts` is a
    seven-entry table that belongs on the catalog entry, `vendor?: string`).

### Things I noticed (round 3)

31. **A scroll-driven animation rejects `currentTime` in milliseconds.** `document.getAnimations()` includes the
    ScrollArea fades (`animation-timeline: scroll(self)`), and seeking one throws *Setting currentTime using
    absolute time values is not supported for progress based animations* — which killed the frame capture three
    launches in a row before the filter (`a.timeline instanceof DocumentTimeline`).
32. **The app spawns servers with `{...process.env, ...server.env}` and resolves the command on PATH.** That is
    what makes the fixture honest (a shim first on PATH, the real command line in the registry) and it is also a
    note for the security review: anything that can prepend to the app's PATH chooses which `npx` runs.
33. **`vite serve` with the app's own config rebuilds `dist-electron/main.js` before it serves anything**, even
    with `PI_DEV_NO_LAUNCH=1` — under the feet of an e2e suite running the built app. The renderer-only config
    (`vite.candidates.config.mjs`, the schedule candidates' pattern) serves the same root with no electron plugin.
34. **A dated error.** A failure recorded before a success must not outlive it; the tools section keeps the time
    of its last error and shows it only if it is newer than the cached list. Found by looking at one frame.
35. **The list keeps the scroll a click gave it.** Playwright scrolls a card into view to click it, and the next
    "at rest" shot was 30px down with the first heading gone. Every rest shot scrolls to the top first.
36. **One launch in the final run died under it** (Ledger, first attempt: *Target page, context or browser has
    been closed* on the third detail, then *app did not quit on close* and `withApp` terminated it). The dev
    server logged no reload, the retry rendered every state first time, and nothing in Ledger changed between the
    two — environmental (another session's process hygiene is the usual suspect, see the memory on `pkill`), and
    exactly the case `withRetry` + `reapChildren` exist for. Nine of ten launches were clean.

## What changed in round 2

- **A fourth candidate, Shelf+**, which is the design round 1 recommended without ever having rendered it — rebuilt
  on the hub's list-plus-pinned-pane idiom rather than a slide-over. See its section.
- **Every section caps** (`Show all — Playwright, Postman, Sentry and 16 more`, with a three-mark cluster the way
  ChatGPT does it) in Shelf+ and Reach; a search or a filter lifts the cap because then the subset was asked for.
- **The official check is gone from every card.** It was on 23 of 27 tools. The exception — a community server —
  is named in the detail's About row (`By: github · official` / `· community server, not the vendor's own`).
- **Add is a "+"** (a bordered 28px icon button, the references' affordance); installed is a switch; "Set up" is
  the only word in the action column and appears only where attention is needed. Two visual families, not four.
- **Tools read as sentences.** `list_channel_members` → *List channel members*, with the identifier in mono beside
  it (it is what appears in the chat when the tool is called), the description under it at 14px, eight per group
  and then *Show all*. Live lists are cached per session so re-opening an item does not spawn its server again.
- **The pane has a real primary action**: an available tool gets a full-width accent *Add to Bobble* under its
  name, the way the hub's pane puts *Download* there; a key-needing one gets the setup card; a switch stays in the
  header because it is a state, not an act.
- **The kind lives in About** (*MCP server* / *Built into Bobble* / *Skill — a playbook the agent reads*), once, in
  the words the app uses, instead of "· Tool" on the state line.
- **Identifiers never break mid-word** (`Key` renders `GITHUB_<wbr>PERSONAL_…`; the spec column is `break-word`,
  not `anywhere`) and an env key in a sentence is prose: *Signs in with a GitHub personal access token*.
- **Redundancy cut from the detail**: no *Needs* row (the setup card and *Touches* already say it); a custom server's
  card says *Added by you · runs …* rather than a bare command path.
- **Shelf**: the strip shows what you turned on — no built-ins — and caps at eight with a "+N" tile that applies
  the On filter; the grid's columns follow the list's width (a container query), not the window's; the pills wrap
  under the search instead of overlapping it; the empty state names what to clear and clears it.
- **Ledger**: the name never yields (it was "C." beside a full "· Developer tools" at 640); the rail's second line
  is the reach sentence, not "Tool · Files"; the category row has a 56px fade driven by the scroll position — right
  edge only at rest, both edges mid-scroll, none on the right at the end (the first fix was a static fade, which
  hid the last chip whenever the row was scrolled to it); under ~520px of directory the rows drop the category so
  the name and the reason keep the room; the rail is `clamp(228px, 30%, 300px)` so it gives way before the
  directory does.
- **Reach**: one affordance per row (the chevron is gone; the row is the expander); "Built in" is said beside the
  name, not printed where a control goes; groups cap at eight; the expansion's indent follows the list's width (a
  container query at 720px), not the window's.
- **`shots.mjs`**: every mode runs in `withApp`, which closes the app in `finally`, gives the harness's `finish()` a
  deadline, and then asks the OS for this process's own children and terminates whatever outlived close (see
  "Things I noticed" for why that was necessary). It also shoots the hub, the empty state, the On filter, an
  expanded section, 900px and 640px with the detail open and then scrolled to the detail's end, and the category
  row mid-scroll and at its end; a failed step logs Playwright's call-log lines (`brief`), not only the first.

## The last step: what the final renders showed (2026-09-07, 09:27–09:49)

The round ended one step short: three edits were made at 09:21 — Shelf's header button, Ledger's chip fade, Reach
at 640 with a row open — and the images were not looked at (the one look, a 4× crop of the fade at rest, is in
§26). This is what looking found, against `shots/*.png` from one run after the fixes below — the last run of the
morning (09:46–09:49, all three candidates first time, no retries); every `shelf-*`, `ledger-*` and `reach-*` file
in `shots/` is from it.

- **Shelf's button needed nothing further.** The edit was restoring `shrink-0` on *Add MCP server* after
  CRITIQUE §5 had called it a workaround and removed it: without the class the button, as a flex child, yields to
  the title and clips to *Add MCP serve* at 460px of list (a different shrink from the icon-squeeze fixed in
  `button.css`). `shelf-w900-detail-bobble-dark.png`: the button is whole with its "+" beside the open sheet;
  `shelf-w640-detail-bobble-dark.png`: whole again, and the subtitle pays with five lines, which is the honest
  cost at 307px of list. Both themes at 1440 are as before. The new `shelf-w{900,640}-detail-end-bobble-dark.png`
  show the sheet holds to its bottom: the command and the homepage wrap only at hyphens, the Remove caption wraps
  beside its button.
- **Ledger's fade rendered — and was wrong at the end of the row.** The 09:21 fix (`animation: none` plus an
  inline 56px) does draw a fade at rest, in both themes, at 1440, 900 and 640: a cut chip dissolves instead of
  stopping. But it was static: 56px of mask over 24px of trailing padding means the last chip lost its last 32px
  whenever the row was scrolled to the end, and there was no left-edge cue once scrolled. The script never
  scrolled the row, so that would have shipped. Now `.cand-cats` in `candidates.css` has keyframes of its own on a
  `scroll(self x)` timeline (0/56 at the start, 40/56 mid-scroll, 40/0 at the end) and `CategoryRow` in
  `Ledger.tsx` measures overflow into `data-overflow` so a row that fits has no fade at all.
  `ledger-categories-mid-bobble-dark.png`: both edges dissolve. `ledger-categories-end-bobble-dark.png`: *Search*,
  the last chip, is whole. `ledger-w640-categories-end-bobble-dark.png`: the same at 640. `ledger-bobble-dark.png`
  and `-light`: at rest, right edge only, *M…* dissolving — §26's point that it is faint on the dark ground
  stands; it is a cue, not a control. While there: at 640 the directory rows read *Chrome DevTools · … · Ch…* —
  the name held (the 09:21 change) and left three fragments — so under 520px of directory the category is dropped
  (`.cand-dir-cat`, a container query on `cand-dir`) and the row reads *Xcode · Xcode is installed*
  (`ledger-w640-bobble-dark.png`); at 900 the category is still there (`ledger-w900-bobble-dark.png`).
- **Reach at 640 with a row open holds**, top to bottom: `reach-w640-detail-bobble-dark.png` (the row, the
  description, the setup card with the key whole) and `reach-w640-detail-end-bobble-dark.png` (Touches / Runs as /
  Command on single lines, Tools, About, the Remove row). What was wrong was the 900 shot, not the 640 one: the
  expansion's 12px indent came from `@media (max-width: 960px)`, a *viewport* query, so the candidate route
  indented at a 900 window where the shell (900 of content beside the sidebar is an 1188 window) would not. It is
  a container query on the list now (`cand-reach-list`, 64px from 720px up): `reach-w900-detail-bobble-dark.png`
  shows the 64px indent, `reach-w640-detail-bobble-dark.png` the 12px one.

Two things about the run itself, both in "Things I noticed" (§28, §30): three of nine launches this pass died at
`waiting for navigation to finish` because another session's packaging into `apps/desktop/release/` made vite
reload every page, and each was absorbed by `withRetry`; and the retried launches' first Electrons outlived close
and were reaped by `withApp` (§25). `pnpm turbo run build --filter @pi-desktop/desktop` passed after all of it.

## The position on connectors vs skills vs servers, second look

The user's complaint is that ChatGPT and especially Claude give the same idea — "things I can add to my agent" — four
doors: Connectors, Plugins, Skills, Extensions, plus a Directory modal that re-nests three of them with its own nav.
The refs, looked at again: ChatGPT keeps Skills as a second tab (`r0240`) and shows a plugin's skills as pills inside
it (`r0504`); Claude has Skills / Connectors / Plugins as three settings rows and the Directory repeats the three.
So both references split, and both are right *at their scale* — Claude's directory has 2,419 connectors and a
"plugin" there is a bundle of skills, servers and hooks.

Bobble has 29 catalog servers, 7 built-ins and 12 skills, and no bundles. At that scale the candidates' stance
holds, and it is a judgement, not a reflex:

- **One surface, one search, one grammar.** A tool (an MCP server, catalog or custom) and a skill (a SKILL.md
  playbook) are both things you add to the agent. One list, one search, one way to turn things on. The *kind* is a
  label and a filter, never a tab and never a menu.
- **What keeps it a shelf and not a store** is the caps and the search: eight tools, six skills, four built-ins
  on the first screen, and everything else one *Show all* away. If the catalog ever grows to hundreds, the refs'
  split becomes right and this file should say so; the caps are what buy the time.
- **The kinds stay legible.** A tool detail shows tools, reach, command, keys; a skill detail shows the document.
  The About row says which it is.
- **Three words, on purpose.** The page is *Connectors* (the sidebar row); the kinds are *Tools* and *Skills*; and
  *MCP server* appears in exactly two places — the button that adds one by hand and the About row — because it is
  the phrase a person holding a server command will look for. Round 1 also had *Tool* on every state line; that is
  gone.
- **A custom server is just a tool the catalog does not know.** It appears everywhere a catalog tool would, and the
  pane says *Added by hand, so Bobble knows only what you typed*.
- **"Plugin" is gone.** Bobble has tools and skills; there is no third thing, so there is no third word.

## Candidate 4 — Shelf+ (`shelf-plus`) — the one I would ship

**Argument.** Two questions, one screen, no reflow. The list answers *what can I add*: recommended apps as a row of
compact chips, then Tools, Skills and Built in as capped card grids. The pane answers *what is on*: at rest it is the
ledger — needs-setup first, then on, off, skills on, built-ins collapsed, the engine mode in its footer — every row
with its switch. Pick anything and the pane becomes its detail; the list under it does not move, because the pane
was already there. Below 1080px of content the pane becomes an overlay sheet with a scrim, which also does not move
the list. That is the model hub's idiom (`grid-cols-[minmax(0,1fr)_460px]`, a hint when empty), and it is why the
"On now" strip is gone: the resting pane does its job with names and switches instead of thirteen tiles.

**Took from the refs.** Claude's Popular strip of compact Connect chips (`r0705`) for Recommended; Claude's
"Show all N →" and ChatGPT's "See Health, Trello, and more" for the caps; ChatGPT's humanised action names and
Read / Write split (`r0428`) for the tools list; Claude's `Enabled` switch + `Configure` (`r0854`) as the setup card
that lives *inside* the detail. From the hub: the reserved pane, the full-width accent action under the name, pills on
one baseline with the search, a fixed header above the scrolling list.

**Rejected.** The strip (see above). Claude's tinted header band (`r0752`): the hub's detail is flat and this is
the hub's sibling. A "Related connectors" grid at the bottom of a detail (`r0759`): the list is right there. Claude's
trust paragraph on every detail (`r0752`): *Touches* says the specific thing instead.

**Tradeoffs, honestly.**
- The pane's resting state spends 420px on a ledger that, for a new user, says *Nothing added yet* — the hub spends
  the same 460px on a one-line hint, so this is no worse, but it is not better either until something is added.
- The Looks-up / Changes split is still the name heuristic (`toolVerb`); the UI says so under the lists.
- Cards keep the description and the reach sentence lives only where every item is installed (the ledger rows and
  the pane), so a grid never mixes two kinds of second line — which means an installed card in the grid says what
  the tool *is*, and you look right for what it *touches*. That is one glance more than round 1's sketch promised.
- Opening an installed item lists its tools from a cache filled when the server was turned on (round 3); the one
  spawn left is a server enabled outside this screen that has never answered, paid once. Round 1's critique wanted
  this on demand only; see "Rejected from the critique".
- `PINNED_MIN` is 1080px of content: a 1440 window with the sidebar gives 1152, so the pane is pinned; a 1280 window
  gives 992 and gets the overlay; below 720 (round 3) the detail takes the list's place. All three were looked at;
  the switch-over itself is not animated.

## Candidate 1 — Shelf (`shelf`)

**Argument.** A strip of marks for what is on right now, one search, filter pills, then sections as two-column
cards; opening anything slides a sheet in beside the list. Round 2 fixed its strip, columns, pills and empty state;
what it cannot fix without becoming Shelf+ is the sheet, which still narrows the list when it opens. Kept because
it is the plainest statement of the one-surface position and because Shelf+ is its descendant.

## Candidate 2 — Ledger (`ledger`)

**Argument.** The split that matters is *have* vs *could have*: a persistent rail of what your agent has beside a
directory to add from. Claude's settings table (`r0705`) is the one genuinely good thing in those refs and this is
that table with a switch per row. It is still the best *management* story and it still pays for it in width and in
showing every added item twice — and round 2 did not change that, because it is the design's premise. Shelf+ took
its rail and made it the pane's resting state.

## Candidate 3 — Reach (`reach`)

**Argument.** On an offline, local app the question is *what can this reach on my computer?*, so the catalog is
grouped by reach — Your Mac / Apps on this Mac / Accounts and services / Local tools — every row's second line is a
plain sentence about what it touches, and details expand in place. Round 2 capped its groups and cut the second
affordance per row. It is still the only candidate that holds at 640 without a special mode, and its reach sentences
and Looks-up / Changes split are in Shelf+.

## Rejected from the critique, and why

- **"Tools fetched on demand, not on open."** Not done as written. Every catalog MCP entry has no static tool list
  (`detect-apps.ts` carries none; only the seven built-ins do), so a detail that waits for a button is an empty
  detail on every first look. Instead: fetch on explicit selection only (never for the resting pane), cached per
  session in `TOOL_CACHE`, so the second look is free. The spawn is still the price of the first look.
- **"Two visual families, not four" — kept a third.** "● Set up" stays a word-button. A "+" on a needs-setup item
  would say *add* about something already added; the orange dot and the word are the one place the column asks for
  attention, and the Needs-setup pill carries the same dot.
- **"The community mark on the card."** Not on the card. The card has no room for a trust signal that reads at a
  glance without becoming the badge it replaced; the About row carries it, and the card's "+" opens the pane where
  it is read before the key is pasted.
- **"Try in chat" as an affordance** (critique §4.2). Right, and not built: the candidate route has no chat to
  open. Proposed below.
- **Ledger's duplicated rows and Reach's 16-row account group re-cut by category.** Capped, not re-cut. Both are the
  candidates' premises; Shelf+ is where the better answer went.

## Still weaker than the references, or than the hub (as of round 2; round 3's own list is above)

- **A community server is marked only in the pane.** Claude marks the *official* ones on the card (`r0733`); a
  person scanning the grid still cannot tell a vendor's server from a stranger's without opening it. Round 3 made
  the exception a sentence in the pane; the card is still unmarked, on purpose (the judge agreed).
- **No related items.** Claude's Directory (`r0740`) offers *Related connectors*; at 29 servers the list on screen
  is the related grid. Category browsing exists since round 3 (the About row's link into the search).
- **The tools list still carries raw identifiers**, humanised or not, and the split is guessed from names. ChatGPT's
  actions are authored (`r0428`). Authoring 29 servers' tool lists is catalog work, not UI work.
- **The hub's pane fades its top edge 24px inside its padding**; Shelf+'s pane fades 16px, scroll-driven — both
  fade, settled by a crop in round 3.
- **Ledger's category row is still a scroller** where Claude has a *Filter: All* dropdown (`r0733`). It now says
  where it is — both edges fade mid-scroll, neither at an end — but seventeen chips are seventeen chips, and the
  one you want is still one scroll away; §26's arrow is still open.
- **Ledger at 640 truncates twice per directory row**: the reason to *Chrom…* and the description to one line,
  even with the category gone. The references never render that narrow — Claude's modal has a floor — so the
  honest comparison is that they refuse the width and Ledger degrades in it; Reach is the only one that reads.
- **Shelf's subtitle wraps to five lines at 640 with the sheet open.** The button it yields to is whole now; the
  copy is what pays. A shorter subtitle, or none below ~400px of list, is the fix, and it is a copy decision.
- **The pinned ↔ overlay switch on resize is a jump** (the swap and the group expansion animate since round 3).
- **Type**: fixed locally in round 3 (13px footnote scoped to the candidate); the token proposal is above.
- **At 640 the overlay strip** — fixed in round 3 (the detail takes the list's place below 720px of content).
- **Skill marks** — fixed in round 3 (a glyph per skill).

## Proposed changes outside this directory (not applied)

1. `packages/mcp-lite/src/detect-apps.ts` — an authored reach line, so the UI stops deriving it. Shelf+ shows the
   sentence on every ledger row and in every pane, so the derivation + `REACH_LINE` override table in `data.ts` is
   now load-bearing copy that lives in the wrong place:

   ```ts
   export interface KnownConnector {
     // …
     /** One plain sentence about what this connector can touch on the user's Mac. */
     reach?: string;
   }
   ```

   `data.ts#reachLine` becomes `c.reach ?? derived`. While there, `readOnlyHint` from MCP tool annotations should
   win over `toolVerb`'s name heuristic wherever a server sets it.
2. `apps/desktop/tests/e2e/harness.mjs#finish` — do not swallow a rejected `app.close()`, and after close list the
   probe's own children (`pgrep -P`) and terminate what remains. MEASURED this round: an Electron outlived a close
   that Playwright reported as complete, three times in one `all` run, hidden, 150–230 MB each, holding node open.
   `shots.mjs#withApp` does this locally now; every other probe in `tests/e2e/` has the same exposure.
3. `src/connectors/ConnectorDetail.tsx` — a field for the key it says it *Requires*. The shipping detail states
   `Requires GITHUB_PERSONAL_ACCESS_TOKEN` and offers nowhere to put it; the candidates' `SetupSection` (paste, save,
   turn on, via the same `connectors:upsert`) is the smallest thing that fixes the biggest gap on the screen.
4. A "Use in a chat" action on an added tool — open a new chat with the tool named in the draft. The one thing
   OpenAI's detail page has that a local app can do better (`r0405`'s *Try in chat*).
5. `apps/desktop/vite.config.ts` — `server: { watch: { ignored: ['**/release/**'] } }`. Packaging output is not a
   page; today every `electron-builder` run full-reloads every client of the dev server, which is every probe in
   flight (§28).
6. `packages/ui/src/components/scroll-area.tsx` — `fadeStart` / `fadeEnd` props (and no fade when the content
   fits), lifting the `.cand-cats` recipe (§26, §29) so the next hidden-scrollbar row does not re-derive it.

## Things I noticed

Blunt, with file and line. The first 19 are round 1's; their status is as of this morning's shipping screen
(`shots/current-*.png`, re-shot 2026-09-07 08:33). Nothing outside this directory was touched.

1. Four names for one thing — **fixed** (the tab is Tools).
2. A custom server vanished after you added it — **fixed** ("Added by you", removable).
3. "Popular" was a lie — **fixed** ("More connectors").
4. **The first screen is still six cards you cannot act on.** "Added by you" now leads, but "By us" — the seven
   built-ins, each *Preinstalled* — is still the next 460px, and everything addable starts below the fold
   (`current-plugins-bobble-dark.png`).
5. **"Official" on our own tools — not fixed.** Every "By us" card still carries the blue badge
   (`ConnectorCard.tsx:100`, `builtin-connectors.ts` `official: true`).
6. Wrong reason for an empty tool list — **fixed**.
7. Developer: github.com — **fixed** (the repo owner).
8. Category as raw enum — **fixed**; **the launch command still scrolls**: `ConnectorDetail.tsx` renders the docker
   command in a `CodeBlock` with a horizontal scrollbar (`current-detail-bobble-dark.png`).
9. YAML frontmatter as prose — **fixed**.
10. Grammar and the old name in the Skills copy — **fixed**.
11. The permission dialog is a cloud dialog on a local app (`ConnectPermissionDialog.tsx`) — not re-checked this
    round; the candidates do not use it.
12. **The MCP mode control still sits between the search and the grid** (`ConnectorsScreen.tsx`, "How connectors
    run" + a paragraph), on every visit.
13. "Create ▾" with one item — **fixed** (a button).
14. Full-window surface with "Back to chat" — **fixed** (a content route).
15. The icon box disappearing in dark mode — not re-measured.
16. Skills rows shouting the licence — **fixed** (grey).
17. `vite` launching a visible app — **fixed** (`PI_DEV_NO_LAUNCH=1`).
18. A `.pd-btn` icon squeezed to a dot — **fixed** in `button.css`. The candidates' `shrink-0` on the header button
    is NOT a workaround for it and stays: the icon no longer shrinks, but the button as a flex child still yields
    to the title beside it, and without the class *Add MCP server* clipped to *Add MCP serve* at 460px
    (`shelf-w900-detail-bobble-dark.png`, second run). Two different shrinks.
19. Brand marks vs the no-purple rule — unchanged; still the only purple on these screens (Obsidian, Discord).

New this round:

20. **The shipping detail asks for a key it gives you nowhere to enter.** `ConnectorDetail.tsx` says *Requires
    GITHUB_PERSONAL_ACCESS_TOKEN* under the command; the only way to satisfy it is the JSON file. The candidates'
    setup card is proposal 3 above.
21. **Viewport breakpoints in a route that lives beside a 288px sidebar.** My round-1 Shelf used `md:grid-cols-2`,
    which fires at a 768px *window* — 480px of content — and put two 190px columns beside an open sheet
    (`CRITIQUE.md` §1). The shipping `ConnectorSection.tsx:26` has the identical `md:grid-cols-2`, so its gallery
    goes to two columns at a 768px window — 480px of content beside the sidebar — and every card in it gets ~230px.
    Container queries are the fix (`.cand-grid` here: two columns only when the *list* is ≥660px).
22. **`--pd-font-size-footnote` = `--pd-font-size-body` = 14px** (`packages/themes/src/generated/themes.css:78–81`).
    A footnote the size of the body cannot do a second line's job; every card in the hub and here leans on colour
    alone for that hierarchy, and it reads as one weight of grey text. `UI-AUDIT.md` D2 sets 12px as the floor; a
    13px footnote is the size the references use for the same line.
23. **The model hub does not hold below ~700px of content** (`hub-w900-bobble-dark.png`): its pane is a fixed 460px
    with no overlay mode, so at a 900px window the list is 104px wide and *Quick Download* buttons draw over the
    avatars. The Connectors route inherits the shell, so whatever width policy fixes one should fix both.
24. **`ConnectorDetail` re-spawns the server on every open** (`fetchTools` in a mount effect, no cache) — listing
    tools means starting the process, and in a fresh home `npx -y` downloads it first. `TOOL_CACHE` in
    `detail-parts.tsx` is the two-line version of the fix.
25. **The e2e harness leaves Electrons behind** (proposal 2): `finish()` swallows a rejected close; Playwright's
    `app.process()` reported an exit for a process that was alive in `ps`; a probe that throws before `finish()`
    orphans the app it launched. Three runs this round left five hidden instances between them. All were mine and
    all were reaped, but only because I went looking.
26. **`ScrollArea axis="x" hideScrollbar` has no visible affordance** at its default 16px fade
    (`packages/ui/src/styles/scroll.css:118`): a chip row cut mid-word reads as a bug, not as "more". And the fade
    cannot be widened from outside: under `@supports (animation-timeline)` the scroll-driven keyframes *own*
    `--pd-fade-start/end`, and an animation beats an inline custom property, so `style={{'--pd-fade-end': '56px'}}`
    did nothing until Ledger also set `animation: none`. MEASURED on the final render: computed `mask-image` is
    the 56px gradient and `animation-name: none`, and a 4× crop of `ledger-bobble-dark.png` shows *Files* at full
    strength and the *M…* chip dissolving — present, but faint enough on the dark ground that at full view it
    still reads as a cut. A fade is a weak cue for a hidden scrollbar; the component should take the widths as
    props and a chip row should probably get an arrow. Since then (the last step): the static fade also hid the
    last chip at the end of the row (§29), so Ledger carries keyframes of its own (`.cand-cats` in candidates.css:
    0/56 at the start, 40/56 mid-scroll, 40/0 at the end, none when a measured `data-overflow` is false). The
    widths-as-props point stands and is proposal 6; the arrow is still open.
27. **Skill categories are too coarse to draw**: `resources/skills` gives twelve skills five categories, `dev` to
    five of them, so any category-driven mark is a wall of `</>`. A per-skill glyph (or a colour per category) is
    authoring work worth doing before skills get a directory of their own.
28. **Another session's packaging reloads every dev-server page.** The main session runs `electron-builder --dir`
    into `apps/desktop/release/` every few minutes, and vite's watcher treats `release/**/LICENSES.chromium.html`
    as a page: `page reload release/mac-arm64.tmp/LICENSES.chromium.html`, MEASURED in the dev-server log at
    9:27, 9:31, 9:34, 9:36 and 9:38 — and each burst that met a probe launch killed it (`page.waitForSelector:
    Timeout 45000ms … waiting for navigation to finish`; three of nine launches this pass). `withRetry` absorbs
    it, at a minute a time. Proposal 5 below: `server.watch.ignored` for `release/**` in `vite.config.ts`.
29. **A static scroll fade is wrong at exactly one place — the end.** The 09:21 fix set `--pd-fade-end: 56px`
    with the animation off; over a 24px trailing pad that fades the last chip's last 32px whenever the row is
    scrolled to it, and the script never scrolled it. The rule: a fade that does not know the scroll position
    must be narrower than the trailing padding, or the last chip can never be read. Scroll-driven keyframes are
    the fix; `shotCategoryRow` in `shots.mjs` is what would have caught it.
30. **Playwright's first line says only "Timeout"; the reason is on the lines after.** `intercepts pointer
    events`, `not visible`, `waiting for navigation to finish` — the probe kept `split('\n')[0]` and one Ledger
    flake (every click timing out after a detail opened, once, not reproduced) went unexplained. `brief()` keeps
    those lines now.
