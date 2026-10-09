# Judgement — round 3

Written from the images only: the 24 references in `~/Desktop/refs/connectors/` (cited as
`r0428` = `Screenshot 2026-09-07 at 12.04.28 AM.png`), every file in `shots/` (99 images: four
candidates in bobble / claude / codex, dark and light, 1440 / 900 / 640, every detail kind, the
empty, filter-on, expanded, category-row and `*-end` states), the shipping screen (`current-*`),
the model hub (`hub-*`), and the Scheduled candidates in `../schedule/shots/` as the sibling
surface. `NOTES.md` and `CRITIQUE.md` were read as claims and each claim below was checked
against a picture; twenty 3–6× crops were cut to settle the ones the full frame could not
(type sizes, the pane's top edge, the chip fade, the setup card's button, the 640 strip).
Coordinates are pixels in the 1440×900 shots unless a width is named. No source was read to
form a judgement; nothing was run.

**Which images are current.** `shelf-*`, `ledger-*` and `reach-*` are from the 09:46–09:49 run.
`shelf-plus-*` is from **09:23** — it predates `candidates.css` (09:34) and the last run. NOTES
says the 09:34 CSS edits were Ledger's chip keyframes, Ledger's `.cand-dir-cat` query and
Reach's list query, none of which Shelf+ uses, so the Shelf+ images are probably still true;
but "probably" is the word, and the Shelf+ set is also the only one with no `w900-detail-end`,
no `w640-detail-end` and no light-theme narrow detail. `current-*` is 08:33 and `hub-*` 08:52,
both fine as bars. One Ledger frame carries the probe's I-beam cursor over the text
(`ledger-detail-skill-bobble-dark.png`, 625,508) — a capture artefact, not the UI.

The candidate judged is **Shelf+**, the one the previous round recommends and the only one
built on the hub's pinned-pane idiom. Shelf, Ledger and Reach get their confirmed defects
noted (§Admissions, and the end of the work order) but are not the work order's subject.

## Verdict: at parity

Shelf+ is above the references at the thing the owner actually objects to in them: it is one
surface, one search and one grammar for tools, skills and built-ins (`shelf-plus-bobble-dark.png`,
five pills — All, Tools, Skills, On, Needs setup — at 1063–1415,139), where Claude gives the
same idea four doors and a modal directory
with its own nav (`r0705`, `r0733`, `r0835`, `r0940`) and ChatGPT two tabs (`r0240`). Its resting
pane answers "what is on" with a switch per row and the one needs-setup item first, its detail
states the specific fact (*Reads and writes files under ~/Projects*) where Claude
prints the same trust paragraph on every page (`r0752`, `r0854`), and its setup card is a paste
field the shipping screen does not have at all. It is below the references on the most common
detail path: every installed-server detail in every candidate shows *Starting the server to
list its tools…* (`shelf-plus-detail-memory-bobble-dark.png` 1040,347 and the same line in
Shelf, Ledger and Reach) — a spinner where `r0428` and `r0752` show the list at once, and not
one image in the set shows what the spinner resolves to. Add that the one item the pane flags
for attention gets the weakest button on the screen (`Save and turn on`, grey, inside the
amber card), and the structural lead and the execution gap cancel out. Items 1–3 below are
what stands between this and "above"; nothing in "already better" should be touched to get
there.

Against the shipping screen it is clearly better: `current-plugins-bobble-dark.png` still puts
the engine-mode control between the search and the grid, spends the first screen on six
*Preinstalled · Official* cards, and `current-detail-bobble-dark.png` says *Requires
GITHUB_PERSONAL_ACCESS_TOKEN* with nowhere to type it and a docker command in a
horizontally-scrolling block. Shelf+ fixes all four.

## What must change to reach parity

Ranked by what it costs the person using it. Each item: what was seen and where, what the
reference or the rest of Bobble does instead, what to change.

### 1. Opening an installed server shows a spinner, and nothing shows what comes after it

**Seen.** `shelf-plus-detail-memory-bobble-dark.png`: under *Tools* (1040,321) the pane says
*Starting the server to list its tools…* with a spinner (1046,347). `shelf-detail-memory-…`
(1027,225), `ledger-detail-memory-…` (556,217) and `reach-detail-memory-…` (358,788) show the
identical line. The only tool list rendered anywhere in the 99 images is the three built-in
Video editing tools (`shelf-plus-detail-builtin-bobble-dark.png`, *Looks things up 1* at
1040,339, *Changes things 2* at 1040,431). GitHub's ~40 tools, the case the Looks-up / Changes
split and the eight-per-group cap were designed for, were never drawn in the 420px pane.

**Reference / Bobble.** ChatGPT's Slack detail lists *Read actions* and *Write actions* the
instant it opens — humanised name left, three-line description right, chevron to expand
(`r0428`, `r0439`). Claude's HyperFrames detail lists its tools as chips, instantly
(`r0752`). The hub never spawns anything to fill its pane (`hub-detail-bobble-dark.png`).

**Change.** Two parts. (a) The list must not depend on a spawn at look time: cache the tool
list the first time a server is turned on (it is running then anyway) and show the cached list
on every later open, with a small *as of last run* caption; for a server that has never run,
say *Turn it on to list its tools* rather than spinning. (b) Render the long case and look at
it: a ~40-tool fixture in the pinned pane at 1440, in the 440px sheet at 900 and 640, both
groups capped at eight with *Show all*, then expanded. Until that image exists the pane's
central section is a claim, not a design.

### 2. The needs-setup flow's one button is the least emphatic control on the screen

**Seen.** `shelf-plus-detail-github-bobble-dark.png`: the amber card *Before it can run*
(1040–1410 × 293–460) ends in *Save and turn on* at 1053–1170,421–447 — a mid-grey pill (crop
D: fill ≈ #6a6a6a on the brown card). `shelf-plus-detail-github-bobble-light.png`: the same
button is taupe on cream (crop Q). Two panes over, `shelf-plus-detail-time-bobble-dark.png`
puts *Add to Bobble* full-width in accent blue at 1040–1410,275–305. Ledger and Reach put the
same grey button bottom-right of the card (`ledger-detail-github-…` 1050,286;
`reach-detail-github-…` 1000,725).

**Reference / Bobble.** Claude's primary is *Connect to Claude*, accent, under the name
(`r0752`); the hub's is *Download*, accent, under the name (`hub-detail-bobble-dark.png`
430,288). Within the candidate itself, *Add to Bobble* already follows that rule.

**Change.** If the button is disabled until a token is pasted, its disabled state must not be
the secondary style — a disabled accent (accent at reduced opacity) says "primary, waiting";
grey says "secondary". If it is enabled, make it the accent button, full width of the card,
matching *Add to Bobble*. Either way, shoot the card with a token pasted, the button enabled,
and the pane after saving (does it become the On state and list the tools?) — none of those
frames exist.

### 3. Below ~720px of content the overlay leaves a 200px strip of cards behind the scrim

**Seen.** `shelf-plus-w640-detail-bobble-dark.png`: the sheet is 440px (x 200–640) and the list
strip beside it (crop J) shows *GitHub / Search repos, read*, *Weather / Added by you · runs*,
each card cut at the sheet's edge. At 900 the same sheet leaves 460px of dimmed list
(`shelf-plus-w900-detail-bobble-dark.png`), which is fine — at 640 it is neither list nor
context.

**Reference / Bobble.** The references never render that narrow: Claude's directory is a
modal with a floor (`r0733`), ChatGPT's settings a fixed dialog (`r0428`). The hub is worse
than Shelf+ here — at a 900 window its list is 104px and *Quick Download* buttons draw over the
avatars (`hub-w900-bobble-dark.png`, 296–380) — so this is a shell-wide width policy, not a
candidate bug. Ledger already has the right narrow idiom: the detail takes the directory's
place with a *‹ Directory* back link (`ledger-w640-detail-bobble-dark.png`, 252,72).

**Change.** Below ~720px of list, let the sheet take the full content width and put the back
link where Ledger puts it, instead of a scrim over 200px. Keep the header (title, search,
pills) above it as now — `shelf-plus-w640-detail-bobble-dark.png` already keeps them visible
at y 60–190, which is the right call. Whatever fixes this should be lifted to the hub.

### 4. The second line on every card is the name's size, differing only in weight and colour

**Seen.** Crop A (`shelf-plus-bobble-dark.png` 24–500 × 290–385, 3×): *GitHub* and *Search
repos, read code, and manage issues/PRs.* share one x-height; the name is semibold white, the
line regular grey, and that is the whole hierarchy. Crop M shows the same in light. Crops K,
L, T: the hub's rows and cards (`hub-bobble-dark.png` 296–920 × 260–540) and the shipping
Skills rows (`current-skills-bobble-dark.png` 443–1260 × 220–300) do exactly the same, so the
candidates are consistent with Bobble here — consistently short of the references.

**Reference.** Claude's directory cards are a 15px name over 13px description (`r0733`);
ChatGPT's rows the same pair (`r0352`). At a glance their cards read as name-then-note; ours
read as two lines of text that happen to differ in colour.

**Change.** A token, not a candidate: `--pd-font-size-footnote` to 13px (NOTES §22 says it
equals body at 14px; `UI-AUDIT.md` D2 sets the 12px floor). Re-shoot the hub, Scheduled and
Connectors together afterwards, because all three inherit it and all three should move at once.

### 5. A custom server's card prints the launch path as its description

**Seen.** `shelf-plus-bobble-dark.png`: the Weather card (510–986 × 297–372) reads *Added by
you · runs node ~/tools/weather-mcp/index.js*, wrapping at *weather-/mcp* — the only
two-line second line in the Tools grid, and the only one that is a path. The pane's own ledger
row for the same server says *Runs node · added by you* (1084,539), which is the right line;
the pane header for it (`shelf-plus-detail-custom-bobble-dark.png` 1100,245) prints the path
again, wrapping to two lines, directly above a *Command* row that prints it a third time.

**Reference / Bobble.** Claude's custom connector shows the URL once, in its own row
(`r0759`, *Connector URL*). The hub never puts an identifier on a card.

**Change.** The card and the pane header use the ledger row's sentence (*Runs node · added by
you*); the path lives in *Command* only.

### 6. Rows that say the same thing on every detail

**Seen.** *Runs as — A local process on this Mac, started with the chat.* appears on every MCP
detail (`shelf-plus-detail-github-…` 1164,627; `-memory-` 1164,438; `-time-` 1164,452) while
the section header two panes over already says *Tools 27 · each one runs as a local process*
(24,275). *By — github · official* / *modelcontextprotocol · official* prints *official* on
every catalog detail shot (1164,797; 1164,626; 1164,604); the community exception NOTES says
it exists for appears in no image.

**Reference.** This is the local-app version of Claude's paragraph-on-every-detail (`r0752`,
`r0854`) and of the `Author —` / `Skills 0` columns (`r0835`) the previous round rightly
rejected — a constant row is texture. ChatGPT prints nothing about trust on a card and one
*Developer* row in the detail (`r0409`).

**Change.** Drop *Runs as* for MCP servers (keep it on built-ins, where *Inside Bobble. No
separate process.* is the surprising fact) — or make it the caption under *Command*. Print
nothing after the author for the rule; for the exception print a sentence in the About block:
*Community server — not published by GitHub.* Then shoot that one detail (see "Could not
judge").

### 7. Category is dead text; two cheap wins for browsing

**Seen.** *Category — Developer tools* (`shelf-plus-detail-github-bobble-dark.png` 1164,823)
is plain text. The list has All plus four pills and a search, and nothing else to browse by
(`shelf-plus-bobble-dark.png` 1063–1415,139).

**Reference.** Claude's directory browses by *Design* / *Code* sections with *Show all N →*
(`r0740`) and offers *Related connectors* under a detail (`r0804`). At 29 servers a category
axis is not worth a row of chips (see Ledger, §Admissions 7), and a related grid is the list
that is already on screen — the previous round was right to refuse both.

**Change.** Make the About row's category a link that puts the category into the search
(*category:Developer tools* or simply the words), and let the search match category names.
That is category browsing with no new surface. Optional: a *Skill* detail's category
(*Developer*) the same way.

### 8. The ledger row's reach sentence truncates at the widest window

**Seen.** `shelf-plus-bobble-dark.png` 1084,299: *Signs in with a GitHub personal access t…*
in a 420px pane at 1440 (crop I). The real shell gives the same pane at 1152 of content, so
this is the best case. Codex flavour fits it (`shelf-plus-codex-dark.png`, 1084,296) by a
few pixels; bobble and claude do not.

**Change.** Copy: *Signs in with your GitHub token* (and the same trim for any reach line
over ~44 characters). The row's job is the switch and the name; the sentence must never need
an ellipsis at the pane's designed width.

### 9. Skill marks: one glyph does the work of five

**Seen.** `shelf-plus-detail-builtin-bobble-dark.png`, Skills section: the `</>` glyph on
MCP builder (540,268), Web app testing (54,360), Code review (54,452) and Git workflow
(540,452) — four of six visible cards. The cap keeps it to one screen, which is why this ranks
last, but it is the beginning of Anthropic's wall (`r0940`, `r0945`).

**Change.** A glyph per skill (twelve, authored once), or a colour per category so *Developer*
skills at least share a tint rather than a shape.

### If the other three candidates are kept

- **Ledger.** At 640 the directory row truncates twice (`ledger-w640-bobble-dark.png` 313,269
  and 313,288 — crop AA): the green reason is cut to *Chrom…*, which says nothing, while the
  "+" column keeps 76px. Drop the reason below ~450px of directory (the section header already
  says *apps found on this Mac*), not only the category. The rail (228px at 640, 16–228)
  should collapse to marks, the way Scheduled's Ledger+ stacks at 640
  (`../schedule/shots/ledger-plus-default-narrow-bobble-dark.png`). The 17-chip row
  (`ledger-bobble-dark.png` 323–1440 × 158–186) is Claude's *Filter: All* dropdown (`r0733`)
  copied as a scroller; the fade now works at rest, mid-scroll and at the end
  (`ledger-categories-mid-…`, `ledger-categories-end-…`, crop F) but a dropdown or the search
  is still the answer. *Nothing matches.* (`ledger-empty-bobble-dark.png` 323,211) has no
  clear button; Shelf+'s empty state is the template.
- **Reach.** A not-added row, expanded, has no primary action: `reach-detail-time-bobble-dark.png`
  shows the "+" in the row header (1117,533) and *Add it to see its tools.* in the body with
  nothing to press — Shelf+'s *Add to Bobble* belongs under the description. Expanding GitHub
  pushes everything below it ~700px (`reach-detail-github-bobble-dark.png`), which is the
  in-place idiom's price and why Shelf+ took Reach's sentences and not its layout.
- **Shelf.** The sheet reflows the list on open (title 232→32 between `shelf-bobble-dark.png`
  and `shelf-detail-github-bobble-dark.png`); at 640 with the sheet open the subtitle is five
  lines (`shelf-w640-detail-bobble-dark.png` 32,95–175, crop AB) and the strip wraps to two
  rows. The *Yours 6* strip (232–540 × 150–197) is ChatGPT's Installed strip (`r0352`) as six
  buttons above an *On 12* pill that answers the same question. Shelf+ dropped all of this,
  correctly.

## The previous rounds' admissions, checked

1. **No trust signal on the cards** — confirmed, and reframed: the cards carry none, the
   details print *official* on the rule (see item 6), and the community exception is in no
   image. Claude badges every card (`r0733`, crop of the *Top connectors* row: check after
   every name); ChatGPT badges none (`r0352`). At 29 servers, none on the card is the right
   call — the gap is that the exception is unproven, not that the rule is unmarked.
2. **No category browsing, no related items** — confirmed; dismissed as a gap at this scale,
   with item 7 as the cheap version.
3. **Tool names are humanised identifiers** — partly dismissed. The only rendered list
   (`shelf-plus-detail-builtin-bobble-dark.png`, crop N) shows *Video edit `video_edit`* over
   an authored description, which is the same shape as `r0428` — ChatGPT's descriptions are
   the vendor's tool descriptions too, and showing the identifier beside the name is *better*
   for a local app, because the identifier is what appears in the chat. What is unverified is
   the derived case (a live server's 40 names) — item 1.
4. **Pane swap and pinned↔overlay switch have no transition** — cannot be judged from stills;
   frames named under "Could not judge".
5. **At 640 the overlay leaves a ~200px strip** — confirmed (crop J); item 3.
6. **Footnote = body = 14px** — confirmed (crops A, M) and shown to be app-wide (crops K, L,
   T); item 4.
7. **Ledger's 17-chip scroller vs *Filter: All*** — confirmed; the fade is now correct at all
   three scroll positions; still the wrong control.
8. **Ledger at 640 truncates twice per row** — confirmed (crop AA) and restated: the truncated
   reason is the useless half.
9. **Shelf's subtitle wraps to five lines at 640 with the sheet open** — confirmed (crop AB);
   Shelf+ does not have the problem because its header spans the full width above the sheet.
10. **No fade at the top of the pinned pane** — restated. Crop W (`shelf-plus-bobble-dark.png`
    980–1440 × 158–188, 6×) shows no stripe at the pane's top at all; NOTES' "plain stripe" is
    not in the image. Both the hub's list (crop V, `hub-detail-bobble-dark.png` 296,170–240:
    the TripoSR row sliced) and Shelf+'s list (crop U, `shelf-plus-detail-skill-bobble-dark.png`
    24,150–205: the Recommended chips sliced) cut hard under their sticky headers — the same
    idiom, so not a gap. Whether the *pane* fades when scrolled cannot be judged: no image has
    either pane scrolled.

## What is already better than the references

Do not "fix" these.

- **One surface, one search, one grammar.** Tools, skills and built-ins in one list with the
  kind as a section subtitle and a pill (`shelf-plus-bobble-dark.png`: *Tools 27 · each one runs
  as a local process*, *Skills 12 · playbooks the agent reads; they touch nothing by
  themselves*, *Built in 7 · always on, no server*). Claude's Connectors / Plugins / Skills
  settings rows plus a Directory modal that re-nests them with its own left nav (`r0705`,
  `r0835`, `r0940`) and ChatGPT's Plugins / Skills tabs (`r0240`) are the noise the owner named,
  and none of it was copied.
- **The resting pane is the ledger.** *Your agent — 4 tools on · 1 needs setup · 1 skill on ·
  7 built in*, then Needs setup / On / Skills on / Built in (collapsed) with a switch per row
  (1020–1440 × 190–680). ChatGPT's Installed strip is six bare marks and a chevron (`r0352`);
  Claude's *Enabled* switch is one click deep in each detail (`r0854`) and its settings table
  has a check, not a control (`r0705`). Ours answers "what is on" and lets you change it
  without leaving the page.
- **The setup card.** Key name, a paste field, *Stays on this Mac, in
  ~/.pi/desktop/mcp-connectors.json.*, one button (`shelf-plus-detail-github-bobble-dark.png`
  1040–1410 × 293–460). Claude offers *Configure* (`r0854`), ChatGPT *Connection → Connect ›*
  (`r0428`), and neither says where the secret goes. Only the button's emphasis is wrong (item 2).
- **Specific facts instead of a trust paragraph.** *Touches — Reads and writes files under
  ~/Projects*, *Touches nothing: clocks and time zones*, *Edits video files with
  ffmpeg*. Claude's identical warning box on every detail (`r0752`, `r0854`) is a warning on
  nothing.
- **Caps that name what they hide.** *Show all — Playwright, Postman, Sentry and 16 more* with
  a three-mark cluster (crop G, 36–420,623). ChatGPT names three (`r0352`); Claude gives a
  count (`r0740`). Ours does both.
- **Recommended from a true signal.** *Chrome DevTools · Chrome is installed* as a compact chip
  with a "+" (crop O, 24–587 × 202–242) — Claude's Popular strip form (`r0705`) with a local
  fact instead of popularity.
- **The skill detail shows the playbook.** The rendered SKILL.md in the pane
  (`shelf-plus-detail-skill-bobble-dark.png` 1040–1410 × 512–900). Claude's plugin detail is a
  name, a byline and a paragraph (`r0952`); ChatGPT lists skill names as pills (`r0504`). Ours
  shows the thing the agent will read.
- **The empty state says what to clear and clears it.** *Nothing matches "zzzz".* / *Try another
  word, or a server the catalog does not know yet with Add MCP server.* / *Clear search and
  filters* (`shelf-plus-empty-bobble-dark.png` 24,209–280), with the ledger still beside it. On
  a par with the hub's *Reset*; no reference shows an empty state at all.
- **The kind in the app's words.** *Kind — MCP server* / *Built into Bobble* / *Skill — a playbook
  the agent reads* (crop R). Claude's table says `Author —`, `Skills 0` (`r0835`).
- **Identifiers hold.** `GITHUB_PERSONAL_ACCESS_TOKEN` is whole at 640 in Shelf+, Shelf and
  Ledger (`shelf-plus-w640-detail-bobble-dark.png` 236,379; `shelf-w640-detail-…` 341,237;
  `ledger-w640-detail-…` 266,247); commands wrap only at hyphens.
- **Three flavours, one layout.** bobble / claude / codex, dark and light, all hold the same
  structure at 1440 with no layout drift (`shelf-plus-{bobble,claude,codex}-{dark,light}.png`).
  The claude flavour's rounder face and the codex flavour's tighter leading change nothing.
- **Consistent with Scheduled.** The same header (title, one-line subtitle, a white/black pill
  action top-right), the same grey section labels with a right-aligned count, the same switch,
  the same list-plus-pane split (`../schedule/shots/ledger-plus-default-bobble-dark.png`).
  Someone moving between the two rows of the sidebar will recognise both.

## Not worth fixing

Differences from the references that make no one's life worse.

- No tinted header band on the detail (`r0752`, `r0854`): the hub's detail is flat and this is
  its sibling.
- No hero image, no *Try in chat* row, no marketing paragraphs (`r0405`, `r0453`): there are no
  marketing assets for a local MCP server. (*Use in a chat* is a good idea for the real route;
  it is not a stills matter and not a candidate matter.)
- No kebab menu (`r0424`): *Remove* as a captioned footer row (*Removing forgets its keys; the
  catalog entry stays.*) is clearer than a "…" that hides *Uninstall* in red.
- No *Information* table with Version / Privacy Policy / Terms of Service (`r0409`, `r0439`):
  a local server has a homepage and a command; those are shown.
- The pane is 420px where the hub's is 460px.
- "+" for add, a switch for installed, *● Set up* for attention: three states, three looks,
  and the orange dot is the only attention colour on the page. NOTES' defence stands.
- The card says what a tool *is* and the ledger row says what it *touches* (GitHub: *Search
  repos, read code…* at 84,336 vs *Signs in with a GitHub personal access…* at 1084,299). Two
  questions, two answers; Claude's table and directory also describe an item two ways.
- *Built in* is mentioned three times on one screen (the summary line, the collapsed group, the
  list section). It is the group that cannot be changed; it is small.
- *○ Not added* directly above *Add to Bobble* (`shelf-plus-detail-time-bobble-dark.png`
  1100,266 / 275): redundant, harmless.
- Two vertical lines at the list/pane boundary (the list's scrollbar thumb at ≈1013 beside the
  divider at ≈1020, crop W): the hub has the same pair.
- The "×" closes the overlay sheet and *‹ Your agent* backs out of the pinned pane: two idioms,
  each right for its container.
- Brand colours: Linear's and Obsidian's marks are the only purple on any screen
  (`shelf-plus-expanded-bobble-dark.png` 54,785; `reach-detail-github-bobble-dark.png` 317,344).
  They are the vendors' marks, not the UI's palette; no accent, chip, dot or switch is purple in
  any flavour or theme. The no-purple brief is met.
- *Third-party names and marks belong to their owners and identify the tool only.* — one grey
  line at the foot of the list.
- The I-beam cursor in `ledger-detail-skill-bobble-dark.png` (625,508): move the mouse off the
  content before the shot; not a UI change.
- The Recommended chips' "+" and the Tools grid's "+" at slightly different sizes (crop O vs
  crop A): both read as add.

## Could not judge from stills

Named precisely enough to record next round.

1. **The live tool list.** GitHub (or a ~40-tool fixture) after the server answers: the pinned
   pane at 1440; the sheet at 900 and 640; each group capped with *Show all*; then expanded;
   dark and light. Also the identical list under Reach's in-place expansion, which will be
   ~40 rows tall. This is the frame item 1 needs and the set does not have.
2. **The setup card enabled.** A token pasted; the button's enabled look; the pane immediately
   after *Save and turn on* (does it become the On state and start the list?); a bad key's
   error.
3. **The community-server detail.** Whichever catalog entry is the exception, opened, so the
   About wording can be read.
4. **A fresh install.** Zero added: the pane's *Nothing added yet* (NOTES' words) beside a list
   of all "+", at 1440 and 900. Every fixture in the set has six added, so the state a new user
   sees first was never shot.
5. **The shell's own width.** Shelf+ at 1152px of content (a 1440 window minus the 288px
   sidebar): the pane pins at 1080, which leaves 732px for the list — two ~350px columns with
   a switch and a two-line description each. The 900 shot is the overlay mode and the 1440
   shot the full window; the width the app most often has is between them and is not in the
   set.
6. **Transitions.** (a) Click a card at 1440 and record 300ms at 60fps: does the pane cross-fade
   or hard-swap from ledger to detail, and does the selected card's blue outline animate in?
   (b) Resize across 1080px of content with a detail open: pinned→overlay and back. (c) The
   sheet's entry/exit at 900 and the scrim's fade. (d) *Built in · always on 7 ⌄* expanding —
   the hub animates its family expansion with a measured height (`hub-bobble-dark.png`, *N
   versions ⌄*); this should match.
7. **The pane scrolled.** The skill playbook scrolled ~400px in the pinned pane, and the hub's
   Kokoro description scrolled the same, side by side — to settle admission 10 (does either
   fade its top edge).
8. **Hover and focus.** Card hover; focus ring on the "+" button, the switch and the *Set up*
   pill; tab order (does focus go card → control or control → card?); the Recommended chip's
   "+" after adding (does the chip vanish, or show a switch?).
9. **Overlay mode's footer.** Where *How tools reach the model* lives below 1080px of content —
   no 900 or 640 Shelf+ shot reaches the end of the list without a detail open.
10. **Light theme, narrow, with a detail.** `shelf-plus-w640-bobble-light.png` exists; the
    sheet and scrim in light do not.
11. **The Shelf+ set re-shot** after the 09:34 CSS edit, with `w900-detail-end` and
    `w640-detail-end` like the other three candidates have, so the sheet's bottom (Remove row,
    Homepage wrap) can be checked the way `shelf-w640-detail-end-bobble-dark.png` allows for
    Shelf.
