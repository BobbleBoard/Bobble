# Connectors candidates — critique, round 2

Written before touching a component. Every claim below is against an image re-taken on 2026-09-07
between 08:33 and 08:51 with `shots.mjs` (`current`, `hub`, and `all`), not against last night's
images or my memory of them. References are the 24 screenshots in `~/Desktop/refs/connectors/`,
cited by their time stamp (`r0352` = `…12.03.52 AM.png`). Bobble's own bar is the model hub
(`shots/hub-*.png`) and the shipping Connectors screen as of this morning (`shots/current-*.png`).

**A caveat that changes the numbers.** The candidate route renders full-window; the real route renders
inside the chat shell beside a 288px sidebar (`--pd-sidebar-width`). So `shelf-bobble-dark.png` at a
1440 window shows 1440px of content, which the real screen never gets: a 1440 window gives the route
1152px. The `w900` shots are the honest 1440-window comparison (a 1188 window), and `w640` is what a
928 window — half of a 1728 display, or a 13-inch laptop with the sidebar open — leaves. The hub was
shot at both a 1440 window (1152 content) and a 900 window (612 content).

## 0. The finding that comes first

NOTES.md says: *"I would ship Shelf, with two pieces of Reach folded in: the reach sentence as the
card's second line for anything installed, and the Looks-up / Changes split in the sheet."*

That design was never built and never rendered. I recommended a combination from having seen its
parts, and the parts do not predict the whole:

- Putting the reach sentence on installed cards and the description on the rest gives one grid two
  kinds of second line — *"Reads and writes files under ~/Projects"* beside *"Structured
  step-by-step reasoning scratchpad."* — and nothing but the switch tells you which is which.
- The Looks-up / Changes split in a 440px sheet, for GitHub's ~40 live tools, is two lists of ~20
  rows at 12px in a column the width of a phone. Reach shows the split at 900px wide, which is why
  it read well there.

The recommendation was a sketch presented as a verdict. That is the primary failure of last round.

## 1. Shelf

### What a reference does better, concretely

**(a) Every reference caps a long section. Shelf caps nothing.** ChatGPT shows six per section then a
row reading *"See Health, Trello, and more"* with a three-icon cluster (`r0352`); Claude shows six per
category with *"Show all 164 →"* (`r0740`); ChatGPT's plugin page shows eight skill pills and a
*"5 more"* pill (`r0504`). Shelf renders all 27 tool cards, then 12 skill cards, then 7 built-in cards:
`shelf-bobble-dark.png` is one screen of a ~2,600px page. Last round I flagged the strip's 13 tiles
and said nothing about the 27-card wall under it, which is the same defect at twice the size. Why I
missed it: I rejected ChatGPT's "Popular" for its *label* (no popularity data) and threw out its
*cap* with it. The cap was the idea.

**(b) ChatGPT's Installed strip is a summary that links out; mine is thirteen buttons.** `r0352`: six
bare 40px marks and a chevron. Shelf: 13 tiles, each opening a sheet, seven of them built-ins nobody
turned on, under a 12px "On now" label, directly above an "On 12" pill that answers the same question
(`shelf-bobble-dark.png`). It is the loudest element above the fold and it is redundant with the
control beneath it.

**(c) Both references add with a quiet "+".** ChatGPT a bare glyph (`r0352`), Claude a bordered 28px
square (`r0733`). Shelf has 27 outlined word-buttons — "Add", "Set up", "● Set up" — each ~60×28, so
the right edge of the grid is a column of buttons competing with the names on the left. The hub does
use eight accent-filled buttons on one screen (`hub-bobble-dark.png`), but each is the one action the
hub exists for; here the action is per card and there are 27 of them.

**(d) I reproduced the badge noise at lower contrast.** I rejected Claude's blue "Official" badge on
every card and replaced it with "a quiet check-mark" — then drew it on every card that is not
community: 23 of 27 tools carry it (`shelf-bobble-dark.png`). Claude's directory has the identical
problem (`r0733`: every card has the check), and I copied it with the opacity turned down. A mark on
85% of items is texture, not signal. The exception is *community*; that is what deserves a word, in
the detail, not the rule.

**(e) ChatGPT names actions for people.** `r0428`: *"Get reactions on a message — Retrieves all
reactions (emoji) on a specific Slack message"*, in a two-column hairline table with an expander.
Mine (`detail-parts.tsx` `ToolList`): `get_file_contents` in 12px mono over a 12px description. For
the question the Looks-up / Changes split exists to answer — *what can this change?* — a person reads
verbs, not identifiers.

**(f) Claude's detail has a top; mine floats.** `r0752`, `r0854`: mark, name, one-liner and the primary
action sit in a tinted band, and the body starts under it. Shelf's sheet: mark, name, description
and state line in the sheet's own colour, and the "primary" control is a 16px switch in the corner
(`shelf-detail-memory-bobble-dark.png`). The hub's pane puts a 48px avatar and a full accent
*Download* button under the name (`hub-detail-bobble-dark.png`). In Shelf the pane's primary action
is the smallest control on it.

### Where it is worse than Bobble's own screens

- **Model hub, layout stability.** The hub's pane is reserved and pinned
  (`grid-cols-[minmax(0,1fr)_460px]`, `sticky top-0`) with a hint when empty; the list never moves
  when you click. Shelf's sheet appears on click and the list reflows under it — compare
  `shelf-bobble-dark.png` with `shelf-detail-github-bobble-dark.png`: every card changes width. At
  900 it does worse than reflow; see below.
- **Model hub, header rhythm.** Hub: a title row, one control row (two pill switches and the search on
  one baseline), one filter row of pills. Shelf: a title row, a 12px label, a row of 44px tiles, then
  a search/pill row. The strip is a third kind of thing and none of the rows share a height.
- **Model hub, type scale.** The sheet's tool list is 12px over 12px (`text-caption` for both name and
  description). The hub's card body is 14px. `UI-AUDIT.md` D2 names 12px as the app's floor; I used
  the floor for the content of the pane.
- **Model hub, empty state.** Hub: *"Nothing matches these filters."* and a Reset button in the filter
  row. Shelf (`shelf-empty-bobble-dark.png`): *"Nothing matches."* over the engine-mode control and the
  trademark line, with the 13-tile strip still above it — it reads as a settings screen with an
  error. There is no reset; with a pill and a query both active, nothing says which to clear.
- **Model hub, colour weight.** The hub colours its actions and nothing else. Shelf's Recommended
  section has three green sentences and three green dots for three items — the loudest section on
  the page is the smallest.
- **Shipping Skills tab, density.** `current-skills-bobble-dark.png` lists 12 skills in one column of
  ~70px rows that fit on one screen with the description in full. My two-column skill cards clamp
  the same description to two lines and take more height for less text.

### At 900 and at 640

`shelf-w900-detail-bobble-dark.png`: with the sheet open the list is 460px. `md:grid-cols-2` is a
**viewport** breakpoint — the window is 900 ≥ 768 — so a 460px list gets two 190px columns:
*Sequential Thinking* is under its own "Add", *GitHub* is under its "Set up", *Postman* is cut. The
strip wraps to two rows; the search shrinks to ~120px and the "All 49" pill is drawn on top of it
(the pills have no shrink policy). In the real shell this breakpoint fires at a 768 **window**, i.e. at
480px of content, so the two-column layout will be wrong on any narrow window regardless of the sheet.

`shelf-w640-bobble-dark.png` (closed): one column, fine; the strip wraps to two rows; the search is
150px and its placeholder is cut at "Search tools a".

`shelf-w640-detail-bobble-dark.png`: sheet 333px (52%), list 307px. The strip wraps to **four** rows,
the search collapses to its icon with the "9" of "All 49" over it, the subtitle wraps to five lines,
cards are 235px. Inside the sheet, `GITHUB_PERSONAL_ACC|ESS_TOKEN` breaks mid-word
(`.cand-spec dd { overflow-wrap: anywhere }`) and the command block wraps to three lines.

Verdict: Shelf does not hold at 900 with a detail open, which is the state it spends most of its
time in.

### The tradeoffs I flagged — were they excuses?

- *"The strip is 13 tiles; with more built-ins it needs a +N collapse."* An excuse. It is 13 today,
  with this fixture, and it is at least seven always, because built-ins are in it. The strip's job
  is done by the count on the "On" pill. A strip of what *you* added, capped at eight with a "+N"
  tile, is the honest version — or no strip.
- *"The sheet takes 440px, so at 900 the grid drops to one column."* An excuse, and factually wrong:
  it does not drop to one column, it stays at two and breaks. The defect is the reflow itself. The
  hub's answer — a reserved pane — removes the reflow at widths where a pane fits, and below that an
  overlay sheet removes it too. Neither was built.

## 2. Ledger

### What a reference does better

- **Claude's ledger is denser and scans as a table** (`r0705`): 47px rows, a one-word *Type* column
  (Web / Desktop), a status check. Mine is 52px rows with "Tool · Files" as a second line — I turned a
  column into a subtitle and lost the scan. (What mine has that Claude's lacks is right: a switch per
  row. Claude's *Enabled* switch is in the detail, `r0854`, one click too far for a local app.)
- **Claude's Popular strip** (`r0705`): three compact chips, each with a Connect button. My
  "Recommended for you" is three full rows in a bordered group — the same three items at three times
  the height.
- **The category row has no cue.** Claude uses a *Filter: All* dropdown (`r0733`); ChatGPT makes
  categories sections (`r0352`). My 17 chips scroll sideways and are cut mid-word — at "M…" at 1440
  (`ledger-bobble-dark.png`) and at "Databases" at 900 — with no arrow and no visible fade:
  `ScrollArea axis="x" hideScrollbar` removes the only scroll cue, and `pd-scroll-fade-x`'s 16px mask
  is invisible against raised chips.

### Where it is worse than the hub

- **The name yields.** `DirectoryRow` puts name, mark, category and reason in one flex row with
  `truncate` on the name, so at 640 the names are "C.", "D", "G.", "M…" while "· Developer tools"
  survives in full (`ledger-w640-bobble-dark.png`). I wrote *"the name never yields to the reason"*
  into Shelf's card the same night. The hub's rows give the name `min-w-0 flex-1` and make the size
  a `shrink-0` sibling; the name gets the room.
- **Two rows for one thing.** Filesystem is in the rail with a switch and in the directory as
  "● Added" — six of the twelve rows on the first screen are duplicates. I called this "correct but
  two rows"; it is half the screen.
- **The rail does not collapse.** At 640 the rail is 300 of 640; the directory gets 340, the section
  title wraps ("Recommended for / you") and the subtitle wraps under "Add MCP server" to three lines.
- **The detail replaces the directory** (`ledger-detail-github-bobble-dark.png`): 680px of content in
  an 1140px pane, and the list you were browsing is gone — the one thing the hub's pinned pane is
  there to prevent.

### At 900 and at 640

900 (`ledger-w900-bobble-dark.png`): holds, descriptions truncate early. 640: the name-yield above;
the chip row is cut at "Browser"; the detail (`ledger-w640-detail-bobble-dark.png`) is fine apart from
the same mid-word break in `GITHUB_PERSONAL_AC|CESS_TOKEN`.

The empty state (`ledger-empty-bobble-dark.png`) is the best of the three because the rail keeps the
context — but it is still "Nothing matches." with no reset and 17 chips.

## 3. Reach

### What a reference does better

- **ChatGPT's Read / Write tables** (`r0428`, `r0439`) humanise the names and truncate descriptions to
  three lines with an expander. I took the split and left the presentation: raw names at 12px in a
  bordered list.
- **Every reference caps; Reach is 50 rows in one column, ~3,000px.** "Accounts and services" is 16
  rows. I wrote that it "wants the category chips from Ledger as a secondary axis" and shipped the
  pile.

### Where it is worse than the hub

- **Two affordances per row.** A chevron and a control on every row (`reach-bobble-dark.png`). The
  hub's family row has one: "N versions ⌄" *is* the expander. The chevron says "expands" when the
  whole row is already the button.
- **A state printed where a control goes.** Seven rows say "Built in" in the control column. The hub
  never prints a state in the action slot.
- **Monotone.** Every mark is a monochrome line glyph on an inset tile; only Blender, Git, Obsidian
  and Docker have colour. Fifty 36px grey tiles is the Anthropic plugin wall (`r0945`) in a different
  typeface — the very thing I rejected.
- **Expansion moves the page.** Opening GitHub pushes everything below it ~700px
  (`reach-detail-github-bobble-dark.png`). The hub's family card reveals three rows; mine reveals a
  form, three tables and a remove row.

### At 900 and at 640

Holds (`reach-w640-bobble-dark.png`, `reach-w640-detail-bobble-dark.png`): one column, the subtitle
wraps to two lines, the detail expands in place. It is the only candidate that holds, and it holds
because it has the least structure, not because it was designed to.

### The tradeoffs

*"The split is a name heuristic"* — stands, and the UI says so. *"Accounts and services is a 16-row
pile"* — I knew, and shipped it.

## 4. Last round's rejections, re-checked

1. **Claude's separate settings page + Directory modal, two searches.** Judgement; stands. What I
   missed inside it: the settings *table* is the compact ledger, and Ledger took the idea without
   the density.
2. **OpenAI's marketing detail (hero image, "Try in chat", management buried in Settings).**
   Judgement on the hero — there are no marketing assets for a local MCP server. **Reflex on
   "Try in chat"**: after adding a tool the next act is using it, and a local app can open a chat
   with the tool named; I threw the affordance out with the marketing. It cannot be built inside
   the candidate route (there is no chat to open), so it goes in NOTES as a proposal.
3. **Blue "Official" on every card → a quiet check.** Reflex. I kept a badge because both references
   have one. The honest move is to mark the exception (community) and to do it in the detail.
4. **The Directory as a modal with its own three-way nav.** Judgement; stands.
5. **Claude's plugin table with `Author —`, `Skills 0`.** Judgement; stands — and I nearly repeated
   it: Ledger's "Tool · Files" second line is a column of near-constant values.
6. **The near-empty plugin detail.** Judgement; mine are full. Full of what, though: three rows of
   Shelf's GitHub sheet say `GITHUB_PERSONAL_ACCESS_TOKEN` (the setup card, *Touches*, *Needs*).
7. **Grouping by popularity.** Judgement on the label; **reflex on the cap** — see 1(a).
8. **The generic trust notice → specific facts (folder, host, key).** Judgement; stands. Claude puts
   the same paragraph on every detail (`r0752`, `r0854`); a warning on everything is a warning on
   nothing.
9. **Anthropic's wall of identical plugin icons** (`r0940`, `r0945`). Judgement — and my skills list
   has five glyphs for twelve skills, with the `dev` glyph four times in a row.
10. **Skills as a separate tab** (ChatGPT `r0240`) / **a separate nav item** (Claude). I merged them.
    Judgement *for Bobble's scale* — 38 tools and 12 skills — and I should have said so: at Claude's
    2,419 connectors the references are right and one list would be wrong. The merge holds while the
    catalog is a shelf, not a store; the caps and the search are what keep it a shelf.

## 5. Defects in the shared parts (hit all three)

- `.cand-spec dd { overflow-wrap: anywhere }` breaks identifiers mid-word at narrow widths. Env keys
  should break at underscores or not at all.
- `ToolsSection` fetches live tools on open, which **spawns the server** — "Starting the server to
  list its tools…" (`shelf-detail-memory-bobble-dark.png`). Every click on an installed item starts a
  process; in a throwaway home `npx -y` downloads the package first. The hub never spawns anything
  to show a card. A pane that rests on an item (the merged design) would spawn on page load.
- The state line "● Needs setup · Tool" repeats a kind the section heading already gave.
- Three names in my own candidates: the title says *Connectors*, the kind label says *Tool*, the
  button says *Add MCP server*. I complained about four names and used three.
- `StateControl` draws four visual variants in one column: a switch, outline "Add", outline "Set up",
  outline "● Set up".
- The `shrink-0` on the header button is a workaround for a bug fixed this morning in
  `packages/ui/src/styles/button.css`; it can go.
- Every mode's probe body ran outside a `try/finally`, so a mid-run click timeout (run 1, shelf attempt
  1) retried into a second Electron and left the first alive, hidden, for twelve minutes. And on the
  next pass all three candidates' Electrons outlived `finish()`: the harness swallows a rejected
  `app.close()`. Both fixed in `shots.mjs` this round (`withApp`).

## 6. In fairness: what the shipping screen now does that mine do not

`current-plugins-bobble-dark.png`: "Added by you" comes first; the Skills tab is one clean column.
And what it still does not do: the engine-mode control still sits between the search and the grid;
"By us" — six built-ins, each *Preinstalled* and blue *Official* — is still the first screen, so
everything addable starts below the fold; and the detail (`current-detail-bobble-dark.png`) has no way
to enter a key — *Requires GITHUB_PERSONAL_ACCESS_TOKEN* is a fact with no field. The setup card is the
one thing the candidates have that the shipping screen needs most.

## 7. What this critique commits me to (Part 2), in order

1. **Build the merged candidate** (`shelf-plus`), on the hub's idiom: a reserved, pinned 420px pane
   at ≥1100px of content (a container query, not a viewport breakpoint) and an overlay sheet below
   that, so the list never reflows on select. The pane's resting state is the ledger — what is on,
   with switches, needs-setup first, the engine mode in its footer — which makes the strip
   redundant, so the strip goes. Cards keep the description; the reach sentence lives where every
   item is installed (the ledger rows and the pane), so a grid never mixes two kinds of second line.
2. **Caps.** Eight tools, six skills, four built-ins, then a "Show all N" row with a three-mark
   cluster; no caps while a search or a filter is active, because then you asked for the subset.
3. **The name never yields**, in every row and card, including Ledger's.
4. **"+" for add, a switch for installed, "Set up" only where attention is needed.** Two visual
   families, not four.
5. **The official check leaves the cards.** "Community server" appears in the pane's About for the
   exception.
6. **Tools in the pane**: humanised name over the description at 14px, raw name in mono beside it,
   grouped Looks up / Changes, eight per group then "Show all". Fetched on demand, not on open.
7. **An empty state that says what to clear**, with a button that clears it.
8. **Narrow widths**: container queries for columns; pills wrap under the search below ~720px; the
   overlay sheet keeps a minimum list width; identifiers never break mid-word.
9. Fix Ledger's chip-row cue and rail collapse, Reach's double affordance and "Built in" in the
   control slot, and re-shoot everything.

## Status after Part 2 (added at the end of the round, so §7 can be checked)

| §7 commitment | What shipped |
|---|---|
| 1. Merged candidate on the hub's idiom, pane resting as the ledger, no strip | Done — `ShelfPlus.tsx`; `shots/shelf-plus-*.png`. The header is fixed above the list (first render had it scrolling away). |
| 2. Caps with "Show all N" rows; none under search/filter | Done in Shelf+ (8 / 6 / 4) and Reach (8 per group). Shelf and Ledger are uncapped by design and say so. |
| 3. The name never yields | Done in every card and row; Ledger's row was the offender. |
| 4. "+" / switch / "Set up" — two visual families | "+" and switch done; "● Set up" kept as a third (a "+" would say *add* about something already added) — see NOTES "Rejected". |
| 5. Official check off the cards; community named in the pane | Done. The card still carries no trust signal at all — see NOTES "Still weaker". |
| 6. Tools humanised, 14px, split, capped, fetched on demand | Humanised / 14px / split / capped done. Fetch is on selection with a session cache, not on demand — the catalog carries no static tool lists, so "on demand" was an empty detail. |
| 7. Empty state that says what to clear | Done (Shelf+, Shelf). Ledger and Reach still say "Nothing matches." |
| 8. Container queries; pills wrap; overlay keeps list width; no mid-word breaks | Done. The overlay at 640 leaves a 200px strip of list, which is the honest limit. |
| 9. Ledger chip cue and rail; Reach affordance and "Built in"; re-shoot everything | Done; the chip fade first went static (`animation: none`, because the shared scroll-driven keyframes own the fade variables — NOTES §26), which hid the last chip at the end of the row; it now has keyframes of its own (NOTES §29). Everything re-shot: `shots/*` dated 2026-09-07 after 09:20, and the three round-2 candidates again after the last-step fixes (NOTES "The last step"). |
