# Judgement — round 4

Written from the images only: the 24 references in `~/Desktop/refs/connectors/` (cited as
`r0428` = `Screenshot 2026-09-07 at 12.04.28 AM.png`), all 166 files in `shots/` (one run,
11:24–11:26 — `hub-*` and `current-*` at 11:24, every `shelf-plus-*` at 11:25–11:26, so this
round has no "which images are current" problem), the model hub as Bobble's own bar, and the
Scheduled candidates in `../schedule/shots/` as the sibling surface. `JUDGEMENT-R3.md` was read
first and each of its nine items was checked in a picture; `NOTES.md` was read as a set of
claims and each claim below was confirmed or not in a picture. Forty crops at 2–5× settled what
the full frames could not (type sizes, hover, the two rings, the pane's fade, the sheet's first
frame, the bad-key block). Coordinates are pixels in the 1440×900 shots unless a width is
named. The only source read was a `grep` of `shots.mjs` and `detail-parts.tsx` to confirm that
two states the notes describe were never shot; nothing was run.

## Verdict: above the references

I agree with the builder. The structural lead round 3 recorded is intact — one surface, one
search, one grammar, a ledger pane with a switch per row, a setup card that says where the
secret goes, specific reach facts instead of a trust paragraph — and the execution gap that
held it at parity is closed: every installed server in every image lists its tools the
instant it opens, from a cache with a dated caption and a *Refresh*, and the fifty-tool case
is drawn in all three pane modes, both themes, capped and expanded, to its last row. What
remains (ranked below) is short, and none of it is a place where Claude or ChatGPT does
better; the first item is a state the candidate must not ship as rendered, but it is a state
neither reference renders (Claude has no health signal; ChatGPT's *Connection* row is the
nearest thing, and it is not shown failing).

## The 9-item order, item by item

| # | Item | Status | Checked in |
| --- | --- | --- | --- |
| 1 | Tool list without a spawn at look time; the long case drawn | **Fixed** (two variants unrendered — §Tool list) | `shelf-plus-detail-memory-bobble-dark.png`, `-github-reopened-`, `-github-tools-{,-expanded,-end}`, `-github-tools-bobble-light`, `w900-detail-tools{,-end}`, `w640-detail-tools{,-end}` |
| 2 | Setup button the accent primary | **Fixed** | `shelf-plus-detail-github-bobble-{dark,light}.png`, `shelf-plus-setup-filled-bobble-{dark,light}.png` |
| 3 | 640: no 200px strip behind the scrim | **Fixed** | `shelf-plus-w640-detail-bobble-{dark,light}.png`, `-end`, `-tools`, `-tools-end` |
| 4 | Second line 13px, as a token | **Partly** — done locally, token not moved | crop of `shelf-plus-bobble-dark.png` 24–500 × 293–357 at 3× vs `hub-bobble-dark.png` 296–596 × 268–380 |
| 5 | Custom server's card prints the path | **Fixed** | `shelf-plus-bobble-dark.png` (571,336), `shelf-plus-detail-custom-bobble-dark.png` (1100,245 / 1174,636) |
| 6 | Rows that say the same thing on every detail | **Fixed** | `shelf-plus-detail-github-tools-end-bobble-dark.png`, `-builtin-`, `-community-end-` |
| 7 | Category as a link that searches | **Fixed** | `shelf-plus-detail-github-bobble-dark.png` (1164,759), `shelf-plus-category-search-bobble-dark.png` |
| 8 | No ledger row truncates at the designed width | **Partly** — tools yes, the skill row no | `shelf-plus-bobble-dark.png` (1084,299 vs 1084,624), `shelf-plus-w1152-bobble-dark.png` (796,403 vs 796,643) |
| 9 | A glyph per skill | **Fixed** | crop of `shelf-plus-detail-builtin-bobble-dark.png` 24–986 × 240–510 |

**1.** Covered in its own section below.

**2.** `shelf-plus-detail-github-bobble-dark.png`: the amber card (1040–1410 × 293–460) ends in
*Save and turn on* at 1053–1397 × 418–450, full width, accent blue at reduced opacity — a
disabled primary, not a secondary. The light frame is the same on cream (pale blue, white
text, legible as "waiting"). `shelf-plus-setup-filled-bobble-dark.png`: nine masked dots in
the field (1066,369) with the accent focus ring, the button at full accent — the same button
as *Add to Bobble* in `shelf-plus-detail-time-bobble-dark.png` (1040–1410 × 275–305). The
three frames round 3 asked for and did not have all exist: after saving
(`…-detail-github-tools-…`: switch on, *● On*, *Tools 50 · listed just now*), a bad key
(`shelf-plus-setup-bad-key-…`), changing it (`shelf-plus-setup-change-key-…`: *Paste a new
token*, disabled accent, *Keep the saved key* at 1225,485).

**3.** `shelf-plus-w640-detail-bobble-dark.png`: *‹ Tools and skills* at (24,228), then the
detail in a 560px column (x 55–575) with no list beside it, the key whole at (68,377), the
header (title, one-line summary, search, the pills on their own row) kept above — Ledger's
narrow idiom, as the order asked. `-end` reaches the Remove row; `-tools` and `-tools-end` show
fifty tools in the same column. `shelf-plus-w900-detail-bobble-dark.png` keeps the overlay
(sheet at x 460–900 over a two-column list), which is right at that width.

**4.** The crop shows *GitHub* and *Search repos, read code, and manage issues/PRs.* as two
sizes now — the description's x-height is visibly under the name's — where the hub's family
cards (*Qwen3.8 27B* / *17.2 GB · Q3_K_M* at 352,293 and 352,311 in `hub-bobble-dark.png`)
are still one size. So the candidate reads the way the references do (`r0733`, `r0352`) and
no longer the way the hub does. That is the right outcome for the candidate and a 1px
disagreement with its sibling; the builder's proposal (13/18 in every flavour, one pass,
hub + Scheduled + Connectors re-shot together) is the fix and should be taken. Judged as
"partly" only because the order said token, not candidate.

**5.** The Weather card reads *Runs node · added by you* on one line (571,336); the pane
header says the same (1100,245); the path appears once, under *Command*, wrapping at the
hyphen (1174,636). Round 3's triple print is gone. The custom detail also lists the server's
four tools now (*Get forecast*, *Get current conditions*, *Get alerts*, *Search location*),
which honours "a custom server is just a tool the catalog does not know".

**6.** *Runs as* is absent from every MCP detail (`…-github-tools-end`: Reach is *Touches* and
*Command* only) and present on the built-in (`…-detail-builtin`: *Inside Bobble. No separate
process.* at 1164,688) — exactly the split the order asked for. *By — github* (no *official*)
on every catalog detail; the exception is a sentence under About in
`shelf-plus-detail-community-end-bobble-dark.png` (1040,809): *Community server — not
published by the Blender Foundation.* — the community detail round 3 could not find is now in
the set, with a live seventeen-tool list above it.

**7.** *Developer tools* is blue in the About row (1164,759).
`shelf-plus-category-search-bobble-dark.png` shows the click's result: the search field reads
*Developer tools*, the list is *Tools 6* (Memory, GitHub, Git, Sequential Thinking, Time,
Postman), *Recommended for you 1*, and the GitHub detail is still open in the pinned pane.
The skill detail's *Developer* is the same blue (1164,426). The placeholder says *Search tools,
skills and categories*. Category browsing with no new surface, as specified.

**8.** Every tool row in the ledger is whole: *Signs in with your GitHub token* (1084,299),
*Reads and writes files under ~/Projects*, *Attaches to Google Chrome*
(`shelf-plus-ix-chip-added-…` 1084,455), at 1440 and at 1152. The one row that still ends in an
ellipsis is the skill: *Review a diff for correctness bugs and reuse / si…* at (1084,624) in
`shelf-plus-bobble-dark.png`, (796,643) at 1152, *…/ sim…* in codex. The rule was written for
key-needing connectors; a skill's second line is its description, which is the wrong sentence
for a ledger row anyway. Twelve authored lines under 44 characters finish this.

**9.** Six of six visible skills carry a different mark: two pages, a plug, a browser window
with a check, a speech bubble, a magnifier with a check, a branch. The Skills *Show all*
cluster (`…-detail-builtin` 44–88,530) shows three more, all distinct. Anthropic's wall of one
glyph (`r0940`, five of ten cards) is not repeated.

## The tool-list claim

This decided round 3, so it was checked hardest.

**What the images prove.**

- *Instant, cached, dated.* `shelf-plus-detail-memory-bobble-dark.png`: *Tools 9 · listed just
  now* (1040,322) with *↻ Refresh* right-aligned (1379,321), *Looks things up 2* (Read graph,
  Search nodes), *Changes things 7*. The same frame in the swap sequence sixty seconds later
  reads *listed 1 min ago* (`shelf-plus-ix-swap-120ms-…`, 1080,323) — the caption is a real
  time, not a string.
- *No spinner on the second look.* `shelf-plus-detail-github-reopened-bobble-dark.png`: GitHub
  opened again after setup — *Tools 50 · listed just now*, thirty and twenty, eight rows each,
  *Show all 30* (1040,780). No frame in the 166 shows *Starting the server to list its tools…*.
- *The long case, everywhere it was asked for.* Pinned pane at 1440, dark and light
  (`…-github-tools-bobble-{dark,light}`); both groups opened (`…-tools-expanded-`: Get me …
  Search issues, the thirty rows); the end (`…-tools-end-`: *Show fewer* at 1040,511, *Grouped
  by name — a guide, not a guarantee.*, Reach, About, *Remove* at 1376,862); the 440px sheet at
  900 (`shelf-plus-w900-detail-tools-…` and `-end`); the full-width column at 640
  (`shelf-plus-w640-detail-tools-…` and `-end`); Reach's in-place fifty-row column
  (`reach-detail-github-tools-expanded-…`). Also at 1152 (`shelf-plus-w1152-detail-…`).
- *Five different servers, all live.* GitHub 50, Chrome DevTools 26
  (`…-detail-chrome-devtools-`), Blender 17 (`…-detail-community-`), Memory 9, Weather 4
  (`…-detail-custom-`), plus the built-in's three. The names are the servers' real names
  (`list_console_messages`, `get_polyhaven_categories`, `rerun_workflow_run`), not a mock.
- *The row.* *Get me* `get_me` / *Get details of the authenticated GitHub user.* — humanised
  name, identifier in mono beside it, description under (crop U). The identifier is hidden when
  it equals the name (*Probe* in `…-detail-builtin`, 1052,392) — a good rule. This is above
  ChatGPT's list (`r0428`: name and description, no identifier, and a chevron per row to reach
  the rest) and well above Claude's two bare chips (`r0752`).
- *The error path.* `shelf-plus-setup-bad-key-bobble-dark.png`: *Could not list its tools.*
  (1040,348) / *MCP server process exited (code 1)* (1040,371) / *Try again   Change the key*
  (1040,394). Honest about what the app knows; *401* is proposal 8's business, not the
  design's. *Change the key* reopens the card over the saved value
  (`…-setup-change-key-`).

**What the images do not prove.** Two of the variants the brief named are in no frame:

- *Off:* `N · from its last run`. No server is off in any of the 166 images — every ledger
  shows *On N* and no *Off* group; the only switch the probe touches is for a focus ring
  (`shots.mjs` 619) and it does not flip it.
- *Never run:* `Turn it on to list its tools`. Same reason; nothing is ever turned off before
  it answers.

Both strings exist (`detail-parts.tsx` 224 and 280 — checked only to confirm they are coded,
not to judge them), so this is a verification gap, not a design gap; but "described and never
rendered" is this project's failure mode and these are the two states a real registry hits
first (a server you switched off last week; one enabled by hand in the JSON). Two frames
next run: Memory switched off then opened; a fresh add switched off before its first list.
Also unrendered: *Refresh* in flight, and the one remaining spinner case.

**The heuristic, admitted and visible.** *Open nodes* sits under *Changes things* for Memory
(1052,868); *Take screenshot* and *Navigate page* under *Changes things* for Chrome DevTools
(1052,866 / 1052,764). The caption under every list says so. `readOnlyHint` is the fix and it
is catalog work; not a reason to withhold the verdict.

**The builder's disagreement (warming on open) holds.** The judge's line was that the hub
never spawns to fill its pane; the builder spawns, one server at a time, once per server
ever, for servers already on. The images can only show the benefit — no spinner anywhere —
and not the cost, and the cost is invisible to the person using the screen provided it never
runs for a needs-setup server. Proposal 7 (the list persisted in main and fed by the chat's
own ConnectorHost) is the honest end state and should be the next thing outside this
directory; until then the warm is the right trade.

## What still stands between this and "above"

Nothing a reference does better, which is why the verdict is above. Ranked by what it costs
the person using it. The first three should be done before this ships; the rest are polish.

### 1. A failed server reads as healthy everywhere except one paragraph

**Seen.** `shelf-plus-setup-bad-key-bobble-dark.png`: after a bad key and *Save and turn on*,
the status line is *● On* in green (1100,284) directly above *Could not list its tools.*
(1040,348). The *Needs setup* pill has lost its count (1364,139) — the screen's one attention
signal went from 1 to 0 while the server got no more usable. The ledger in this state is not
in any frame, but from the design it lists GitHub under *On 5* with a switch and nothing else,
because the only place the failure is written is the detail's Tools section. Leave the detail
and the broken server looks like the four working ones.

**Reference / Bobble.** Claude shows no health at all (`r0854`: *Enabled* and *Configure*);
ChatGPT's *Connection — Connect ›* row (`r0428`) is a state the whole detail carries.
Scheduled's rows carry *missed* in orange on the row itself
(`../schedule/shots/ledger-plus-default-bobble-dark.png`, 229,438) — the sibling already puts
the failure where the eye rests.

**Change.** The candidate has the vocabulary: after a listing failure on a server that is on,
the status line and the ledger row go amber (*● Needs setup* if the failure followed a key
save; *● Not responding* otherwise), the *Needs setup* pill counts it, and the row's control is
the *Set up* pill again rather than a switch that says nothing. Then shoot the ledger after a
bad key.

### 2. Render the two tool-list variants

Off and never-run, as above. Not a design change; two frames. Until they exist the tools
section has two branches that have never been looked at.

### 3. The skill row truncates (item 8, the other half)

*Review a diff for correctness bugs and reuse / si…* at (1084,624), at 1440 and 1152, in all
three flavours. Author a ledger line per skill (*Reviews diffs for bugs and cleanups*), the
same ≤44-character rule the tool rows now obey.

### 4. The fresh pane points at something it hides

`shelf-plus-fresh-bobble-dark.png` (1040,275): *Pick a tool or a skill from the list; it
appears here with a switch. The built-in tools below are already on.* — and *Built in · always
on 7 ⌄* is collapsed under it (1040,326), so the 420px pane is empty from y 340 to the footer.
When nothing else is in the ledger, open the built-in group by default: the copy becomes true
and the new user's first look at the pane is seven things that already work, not a hint.

### 5. Focus and selection are the same ring

Crops C/C2: the keyboard-focus ring on the GitHub card (`…-ix-focus-card-`, 22–502 × 291–359)
and the selection ring on the same card (`…-detail-github-`) are both the accent — sampled
(77,149,248) at x=23 in both; focus is a 2px solid, selection a 1px line with a
(48,85,135) halo. Tabbing across the grid moves what looks like the selection, and a selected
card plus a focused card will wear the same ring. Give focus an offset outline (2px, 2px out)
so the two states differ in geometry, not only by a pixel of weight. The chip, "+", *Set up*
pill and switch rings are fine — no selection state competes with them.

### 6. The 1080 crossing changes three things at once

`shelf-plus-ix-pinned-1081-bobble-dark.png`: pinned pane, the list is one column of 605px
cards (24–628). `shelf-plus-ix-overlay-1079-bobble-dark.png`: overlay sheet, the list is two
columns (24–530, 540–1079) under the scrim, and the subtitle has changed. The builder is right
that a mode switch under a window drag need not animate; but the column count flipping at the
same pixel — because 1081 − 420 leaves a list under the 660px two-column threshold — means
there is a ~24px band (1080–1104 of content) where the pinned mode shows one column, then two
again. One number: either `PINNED_MIN` ≈ 1104 so the pinned list is always two columns, or
the two-column threshold at 640. Then a drag across the crossing changes the pane mode and
nothing else.

### 7. The card hover is at the threshold

Crop B3 (`…-ix-hover-card-`, the Git card at 510–986 × 440–505, over the same card at rest):
fill (30,30,33) → (35,35,37), border (39,39,41) → (49,49,51). Present, measured, and visible
at 3×; at 1× on this ground it is a "did that change?" lift. Double both steps, or take the
border to the same grey the selection halo uses. (Round 3 could not judge hover; NOTES' claim
that it was fixed is true, and it is still faint.)

### 8. The sheet enters translucent

Crops G/G2 (`…-ix-sheet-w900-000ms-` and `-080ms-`): the sheet fades in over the list, so for
roughly the first 100ms *Tools 50 · listed just now* sits over *Filesystem — Read and write
files under an allowed directory* and *Get me* over *GitHub*. At 250ms it is clean. Claude's
and ChatGPT's dialogs fade too, so this is not a gap against them; it is a cheap improvement:
slide the sheet in opaque and fade only the scrim.

### 9. The pane blanks for a frame, back link included

Crop W (`…-ix-swap-000ms-`): the whole pane is empty at 0ms — no *‹ Your agent*, nothing —
then the detail fades in with its 4px rise and is settled by 120ms. Fine as a cut (the hub's
family swap is a cut), but the back link is a fixed element pretending to be content; keep it
outside the keyed body so the eye has an anchor while the body remounts.

### 10. *Show all 9* behind eight rows

`shelf-plus-detail-community-bobble-dark.png` (1040,870): the cap hides exactly one row and
charges a click for it. Do not cap a group of cap+1.

## The new states

What each frame shows, since a table of file names is not a judgement.

- **Setup flow.** Needs-setup detail (disabled accent, *Finish setup to list its tools.* at
  1040,518) → filled (masked value, focus ring, enabled accent) → saved
  (`…-detail-github-tools-`: switch on, *● On*, fifty tools, the pill's count gone, the card
  moved from the first slot (24,293) to the On sort position (510,366) — the pane keeps it
  selected, so the eye has somewhere to be while the list reflows) → bad key → change key.
  Every step exists in a picture. Light for the first two. The one wrong frame is the bad key's
  green *On* (item 1).
- **Fresh install.** `shelf-plus-fresh-bobble-{dark,light}.png`: *Recommended for you 4*
  (Blender joins the chips because it is installed and not added), *Tools 25* all "+", every
  skill off, the pane *0 tools on · 0 skills on · 7 built in* / *Nothing added yet.* /
  *Built in · always on 7 ⌄*, the engine control in the footer. GitHub is a "+" here, not
  *Set up* — right, since it is not added. `shelf-plus-fresh-w900-bobble-dark.png`: no pane;
  the summary line moves into the subtitle (*0 tools on · 0 skills on · 7 built in* at 24,102),
  which is a good substitute. Item 4 is the only note.
- **1152.** `shelf-plus-w1152-bobble-{dark,light}.png`: pane pinned at 732–1152, two ~330px
  columns; descriptions wrap to two lines (*Filesystem*) or clamp at two with an ellipsis
  (*Chrome DevTools — Debug pages and capture performance traces via Chrome…* at 84,519; *Doc
  co-authoring*, *MCP builder*), which is what the references' cards do (`r0733`, *Microsoft
  365 — …Outlook, and Teams…*). The ledger rows are whole except the skill (item 3). The detail
  at 1152 (`…-w1152-detail-`) is the 1440 pane to the pixel. This is the width the app
  actually has, and it holds.
- **The 1080 crossing.** Item 6. The subtitle change (one-line summary ↔ counts) at the same
  pixel is right — the counts replace the ledger that just left.
- **Transitions.** *Swap:* blank → fade + 4px rise, settled by 120ms; the card's ring is on by
  60ms (`…-ix-swap-060ms-`). *Sheet:* 24px slide + fade over 250ms, scrim over 150ms; at 80ms
  the scrim is on and the sheet is still ghosted (crop G2); clean at 250. *Built-ins:*
  `…-ix-builtins-080ms-` shows the chevron mid-rotation (1400,632) with one row revealed,
  160ms three rows, 250ms the same three — the group opens to its measured height and stops at
  the pane's fold; the rest is a scroll (`shelf-plus-builtins-open-…` shows all seven with the
  earlier rows faded out under the header). That matches the hub's family expansion. The
  pinned↔overlay switch is a jump; agreed that it should be (item 6 is about what else jumps).
- **Scrolled panes.** `shelf-plus-pane-scrolled-bobble-dark.png` (crop E): the first visible
  line of the playbook is dimmed to about 60% under *‹ Your agent*, the second is full white —
  a 16px scroll-driven fade. `hub-pane-scrolled-bobble-dark.png` (crop E2): the hub's first
  line is nearly gone — a deeper, softer 24px fade. Both fade; round 3's admission 10 is
  closed. The hub's is the nicer curve; not worth a change.
- **Hover, focus, tab order.** Hover: item 7. Focus: the accent ring on the container for the
  card (22–502 × 291–359), the chip (22–210 × 200–244), the *Set up* pill (413–491 ×
  302–334), the switch (458–490 × 378–397), and on the "+" buttons with an *Add* tooltip
  under them (`…-ix-focus-plus-` 475,569; `…-ix-focus-chip-plus-` 193,251) — consistent, and
  the tooltip on focus is a nice touch. Tab order (card → control, never control → card) cannot
  be judged from stills; the six rings are consistent with the claim. Item 5 is the one note.
- **The chip after adding.** `shelf-plus-ix-chip-added-bobble-dark.png`: *Recommended for you
  2* (the Chrome DevTools chip is gone), *Tools 28* with Chrome DevTools on and switched, the
  ledger *6 tools on* with *Attaches to Google Chrome* (1084,455), and
  `…-detail-chrome-devtools-` lists its 26 tools on open because *add* warmed the cache. Exactly
  what round 3 asked to see.
- **Overlay mode's footer.** `shelf-plus-w900-end-bobble-dark.png` / `-w640-end-`: the engine
  control (*How tools reach the model — Lite / Native / Bash CLI*) and its caption sit at the
  end of the list above the third-party line (24,656 / 24,718 at 900). Right place.
- **Light, narrow, with a detail.** `shelf-plus-w900-detail-bobble-light.png` (a grey wash for
  the scrim, the cream card) and `shelf-plus-w640-detail-bobble-light.png` (the full-width
  column) both hold; nothing in light differs structurally from dark anywhere in the set.
- **Flavours.** `shelf-plus-{claude,codex}-{dark,light}.png`: same structure, no layout
  drift; codex's tighter face truncates the skill row one character later (*…/ sim…*).
- **No purple.** Linear's mark (`shelf-plus-expanded-…` 54,761) and Obsidian's
  (`reach-detail-github-tools-…` 317,344) are vendors' marks; no accent, chip, dot, ring or
  switch is purple in any flavour, theme or width. The brief is met, as before.
- **The rejections.** Ledger's rail and category scroller and Shelf's five-line subtitle at
  640 are as round 3 left them; they are not the recommendation and the rejection holds. The
  hub was not touched and is as broken at 900 as before (`hub-w900-bobble-dark.png`: a 104px
  list, *Quick Download* over the avatars) — proposal 9 stands and Shelf+'s three-mode width
  policy is the thing to lift into it. Reach's not-added row got its *Add to Bobble* and
  Ledger's empty state its clear button, as the notes say. The fifty-tool fixture instead of
  forty is fine; the point was both groups over the cap, and they are.

## Not worth fixing

Round 3's list stands (no tinted band, no hero, no kebab, no Information table, 420 vs 460,
three state looks, card-says-what-it-is vs row-says-what-it-touches, *Built in* three times,
*○ Not added* above *Add to Bobble*, two lines at the list/pane boundary, × vs ‹, brand
purple only, the third-party line). New this round:

- *Probe* with no identifier beside it while *Video edit* `video_edit` has one
  (`…-detail-builtin` 1052,392): the identifier is hidden when it equals the name. Correct.
- *Try again   Change the key* as plain white text (1040,394): the pane's actions are all plain
  white text (*Show all 30*, *Show fewer*, *Keep the saved key*); consistent. If item 1 is done
  the pair mostly stops mattering.
- The custom server's *Remove server* is a bordered button on the left
  (`…-detail-custom` 1052,749) where the catalog's *Remove* is a captioned text action on the
  right (1376,862). Removing a custom server forgets the command with nothing to fall back on,
  so a heavier control is defensible; give it the same caption form (*Removing forgets the
  command; nothing else keeps it.*) and leave the weight.
- The GitHub card moves on save (24,293 → 510,366) because needs-setup sorts first: the price
  of a useful sort, and the pane keeps the item.
- The identifier and the description at two greys in one tool row: it reads.
- The chevron's mid-rotation glyph in `…-ix-builtins-080ms-` looks broken in a still; it is a
  rotation.
- Three shots have the list scrolled 30px with the *Recommended for you* heading cut
  (`…-detail-time-`, `…-detail-skill-`, `…-pane-scrolled-`; chips at y 192): the click's
  scroll-into-view, which NOTES §35 fixed for rest shots and not for these. Capture, not UI.
- The *Show all* cluster's three marks change with the state (Playwright/Postman/Sentry, then
  Time/Playwright/Postman after Chrome DevTools is added): the cluster names the first three
  hidden, and it should.
- The fixture state carries across the run (Chrome DevTools and GitHub stay on after the
  flow, so later frames read *6 tools on*): internally consistent, and it is why the same run
  can show both *Needs setup 1* and its absence.

## Could not judge from stills

1. Tab order (card → control), and whether a focus ring ever coincides with a selection ring.
2. The off and never-run tool-list captions (item 2); *Refresh* in flight; the ledger after a
   bad key (item 1).
3. The cost of warming on open — whether a needs-setup server is ever spawned, and how long a
   cold `npx -y` holds the screen's first look on a real machine.
4. Whether the category link closes the detail in the overlay and full modes, as described.
5. Hover on a ledger row, a chip, a tool row.
6. The thirty-row group expanded inside the 900 sheet and the 640 column (only the pinned
   pane was shot expanded); the layout is proven there, so this is low.
