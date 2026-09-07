# Judgement — round 3

Written from the images only: the fourteen references in `~/Desktop/refs/schedule/`,
every candidate shot in `shots/` (dark and light, 1168 / 900 / 640, all states,
the `empty-*` first-run screens, the claude and codex flavours), the shipping
screens in `shots/current/`, and the Connectors candidates in
`../connectors/shots/` as the in-app bar. `NOTES.md` and `CRITIQUE.md` were read
as claims and checked against pictures; nothing below is repeated from them
without a screenshot behind it. Coordinates are pixels in the 1168-wide shots
unless a width is named. Two greps were run to caveat two items (no `tasks:stop`
IPC exists; `TaskRun` carries no model) — nothing else was read from source.

## Verdict: at parity

Ledger+ is above both references at the thing a scheduled-task screen is for —
seeing what ran. Its detail pane shows the run ledger on the page with each
run's first sentence, its duration, whether a hand or a clock started it, a
failure in red with the real error, and the picture a run made as a thumbnail
on the row; none of the fourteen reference images shows a run's result
anywhere, and the shipping Bobble screen hides it in a drawer that says "No
runs yet". It is below both references at the front door — the composer is
indistinguishable from the search field 60 px beneath it, has no send
affordance while idle, and the first-run screen has two horizontal axes, clamps
its template blurbs, and at 640 px shows a back link to a list that does not
exist. Every user walks through the door before they see the room, so the two
cancel out. Items 1–4 below are what stands between this and "above"; nothing
in the "already better" list should be touched to get there.

## What must change to reach parity

Ranked by what it costs the person using it. Each item: what was seen and
where, what the reference or the rest of Bobble does instead, what to change.

### 1. The front door reads as a search field

**Seen.** `ledger-plus-default-bobble-dark.png`: the composer at y=139 is a
pill (x 24→835) with a placeholder and nothing else — no glyph, no button. The
list's "Search tasks" at y=200 is the same pill, same border, same fill, same
radius, plus a magnifier. Of the two, the *composer* is the more anonymous;
the one with an icon is the one that only filters. The "Check it" button and
the "↵ to check it" hint exist only once text is typed
(`ledger-plus-typing-bobble-dark.png`), so an idle screen gives no hint that
this box creates anything. At 1168 the pill stops at x=835 while the header's
controls end at x=1143; at 640 the placeholder clips mid-word ("…in my
working", `ledger-plus-default-narrow-bobble-dark.png`).

**Instead.** ChatGPT's box (`12.03.38 AM`) is the first thing on the page,
spans the column, and always shows "+", a mic and a send arrow. Bobble's own
chat composer (`shots/current/chat-bobble-dark.png`) always shows "+", mic and
the model picker. Bobble's Model hub search bar runs to the content's right
edge, level with its header chips. The Agenda candidate's composer
(`agenda-default-bobble-dark.png`) spans its column exactly to the header
controls' edge (x 163→995 under controls ending at 999) — that is what
"placed" looks like and it is one directory away.

**Change.** (a) A persistent submit affordance in the composer — a muted "↵"
or the chat composer's arrow at the right end, live once there is text; the
"Check it" button can stay as its typed state. (b) Span the box to the header
controls' right edge, or give it the chat composer's rounded-rectangle shape
so it cannot be read as a search pill. (c) Either drop "Search tasks" (nine
tasks do not need one; Claude has a search because it lists twelve
suggestions under one task) or make it a magnifier in the list header; if it
stays as a field, it must not share the composer's exact shape. (d) A shorter
placeholder that survives 640 px: "Every weekday at 9am, summarise what
changed".

### 2. The first-run screen

**Seen.** `empty-ledger-plus-default-narrow-bobble-dark.png` y=239: a
"‹ All tasks" back link above "Nothing scheduled yet" — there are no tasks to
go back to. `empty-ledger-plus-default-bobble-dark.png`: the composer's left
edge is x=24; the template column is centred at x 217→941; two horizontal axes
on one screen, so the eye lands nowhere. The template blurbs are
ellipsis-clamped: "Runs on…", "Reads locally;…", and at 640 "what arrived…",
"It…". No focus ring is visible on the composer in the empty default shot
(NOTES says it has focus; the `new` state shows what a focus ring looks like
here, and the empty default does not show one).

**Instead.** Claude's templates (`11.57.43 PM`) are whole sentences; ChatGPT's
(`12.03.38 AM`) are one line each. The shipping baseline
(`current/scheduled-empty-bobble-dark.png`) prints the full blurb — "Your
day, before you start it: today's events, what arrived overnight, what is due.
Runs on your Mac. Nothing leaves it." — so the candidate regressed the
baseline here.

**Change.** No back link when the list is empty. The template column shares
the composer's left edge (or both centre together). Unclamp the blurbs — at
725 px wide they are two lines — or rewrite them to fit; at 640 use one
column. If the composer is meant to have focus on the empty screen, it needs a
visible ring, and a shot that proves it.

### 3. Running: three copies of the state and no way to stop

**Seen.** `ledger-plus-running-bobble-dark.png`: a disabled "▷ Running…"
button at x=880,y=205; a "◌ Running · 23s" pill at x=357,y=265 on the next
line; a spinner + "23s" on the list row; a spinner + "23s so far" on the run
row. The word twice and the spinner three times, for one job. There is no Stop
anywhere, and `electron/scheduled/scheduled-contract.ts` has no `tasks:stop`
— a running scheduled task cannot be cancelled from any surface.

**Instead.** The references show no Stop either — but those are cloud runs.
Here the job holds the one local model slot ("one task at a time" is this
screen's own subtitle in earlier rounds), and a runaway run costs the user the
chat.

**Change.** The "Run now" button becomes "Stop" while running (needs a
`tasks:stop` IPC — a shared change; if it cannot land this round, hide the
dead button rather than greying it). Keep the pill (it is the state) and the
run row (it is the record); the list row's "23s" can stay because it says
*which* task is running from the list.

### 4. Off: the screen argues with itself

**Seen.** `ledger-plus-off-bobble-dark.png`: header switch off; an amber
banner; the detail's subtitle says "scheduling is off"; a grey "Off" pill at
x=357,y=311; and a blue *on* switch at x=1067,y=251 on the same task. Three
statements of "off" and one of "on" within 100 px. In the list every task,
including "Sort my Downloads · Only when you run it", is filed under "Paused"
with "off" on the right — although the banner says "you can still run one by
hand" — and the when-groups collapse into one alphabetical list.

**Instead.** Neither reference has a kill switch; this is Bobble's own
feature (kept on purpose), so it has to be crisp on its own terms.

**Change.** Drop the "Off" pill — the subtitle and the banner already say it.
Dim (do not disable) the per-task switch while scheduling is off, so it reads
as "on, but not firing". Leave by-hand tasks in "By hand"; they are
unaffected. Keep the when-groups with a trailing "off" rather than
reshuffling the list — someone who flips the switch for a minute should not
watch their list rearrange.

### 5. The detail header holds the reach chips above the prompt

**Seen.** `ledger-plus-default-bobble-dark.png` (crop measured): 40 px tile,
22 px title, 13 px schedule line, three controls on the right, then a row of
four chips ("Own folder · Calendar · Mail · Reminders"), then the prompt box
at y=291 — an 82 px stack plus a 14 px gap before the prompt.

**Instead.** Claude's pane (`12.01.27 AM`): a 12 px "Active", a 17 px name,
the prompt box, and the facts *below* it as label/value rows under "Details"
and "Frequency". Bobble's own Connectors detail
(`../connectors/shots/ledger-detail-github-bobble-dark.png`,
`shelf-plus-detail-builtin-bobble-dark.png`): icon, name, one-line
description, a status line, the description, then **Reach** as label/value
rows ("Touches", "Runs as"). Both put the facts under the text.

**Change.** Move the chips below the prompt into a "Reach" block in
Connectors' form — "Reaches  Calendar · Mail · Reminders" / "Runs in  its own
folder". "Own folder" is not a reach, it is a place, and belongs on the
"Runs in" line. That also puts the reach next to the run rows' "used Calendar
· Mail · Reminders", where it is explained. The header becomes tile, title,
schedule line, controls — the reference's shape and the in-app bar's. Keep
the 22 px title (see "Not worth fixing").

### 6. Machine-cut names

**Seen.** `ledger-plus-review-bobble-dark.png` (and light, and narrow, and
`agenda-editor-bobble-dark.png`): Name = "Write up what I worked on", cut at
six words mid-thought. The field is focused, which invites a fix, but this is
the name the list shows forever if the person presses ↵ twice.

**Instead.** The reference's chat-made task (`12.00.58 AM`) is named "Weekday
meeting prep" by the model. No model is loaded here at first run, so a
deterministic cut is the right first answer — but not this cut.

**Change.** `titleFrom` cuts at the first clause boundary (`,;.` or a
conjunction) before falling back to six words, as NOTES proposes — do the
schedule-logic change. In the editor, when the name was cut, the lead line
should say so ("Named from your sentence — change it if you like") instead of
the generic "Read from your sentence."

### 7. Two type-here boxes while the editor is open

**Seen.** `ledger-plus-review-*.png`, `ledger-plus-new-*.png`, every width:
once ↵ opens the editor, the composer is emptied back to its placeholder and
stays above an editor whose first field is "What should it do?"; "+ New task"
stays live in the header while you are in New task.

**Change.** While the editor is open the composer either holds the sentence
(re-parse on edit) or collapses to one line — "From: 'every friday at 4pm,
write up…' · edit" — and the header button reads as active or hides.

### 8. The parse chips push the page

**Seen.** `ledger-plus-typing-bobble-dark.png`: the chip row appears under
the composer and moves both panes down 32 px (list top y=200→232); at 640
(`…typing-narrow…`) by ~50 px because the chips wrap.

**Change.** Reserve a fixed 32 px lane under the composer that holds "↵ to
check it" when idle and the chips when typing — or grow the chips inside the
composer's own box the way ChatGPT's box grows. Nothing under the composer
should move as you type.

### 9. "Add another" over an empty form

**Seen.** `ledger-plus-new-bobble-dark.png` y=654: the template grid under a
New-task form with nothing in it yet is headed "Add another". The empty
state's "Nothing scheduled yet" is right; this heading is not.

**Change.** "Or start from one of these".

### 10. Delete says nothing about what it deletes

**Seen.** A lone "Delete" text button at the bottom-right of the pane whose y
depends on the ledger's length (`ledger-plus-late-bobble-dark.png` y=735,
`ledger-plus-running-bobble-dark.png` y=595).

**Instead.** Connectors' detail ends with a hairline, "Removing forgets its
keys; the catalog entry stays.", and Remove.

**Change.** The same recipe: hairline, "Deleting removes the task and its 5
runs." (NOTES says that is what happens), Delete.

### 11. Nothing says what runs it

**Seen.** No run row and no detail says which model ran the task or will;
`TaskRun` in `scheduled-contract.ts` has no model field. The editor's
consequence line says only "no model is loaded yet — the first run loads
one".

**Instead.** Claude's modal has "Default model ▾" (`11.58.21 PM`,
`11.58.35 PM`). For a local app the model is the quality, speed and memory
decision.

**Change.** Shared, data-model: record the model on the run; print it on the
run row's meta ("41s · gemma-4-12b") and in the consequence line ("first run
loads gemma-4-12b"). Ranked last because it is outside this directory, but
the next round should not treat the current line as the final word.

## What is already better than the references

Do not "fix" these.

- **Run history on the page.** `ledger-plus-default-bobble-dark.png`,
  `-running`, `-late`: the ledger with the first sentence of each run, its
  measured duration, "by hand", "1h 42m late", a failure in red with the real
  error, and the thumbnail of the picture a run made on its row. No reference
  image shows a run's result at all; the shipping drawer
  (`current/scheduled-runs-drawer-bobble-light.png`) says "No runs yet".
- **Derived states that are true.** running / due / missed / late / by hand /
  paused / off, with the missed slot named ("missed 4 Sep 6:30 PM" in the
  Agenda; "missed" in orange on the Ledger+ row). The references have Active
  and Paused.
- **The consequence line in the editor.** "first run Today 9:00 AM (now)"
  (`ledger-plus-new-bobble-dark.png`) says what saving does — the shipping
  dialog and Claude's modal are silent about a slot that already passed.
- **Live parse while typing.** "Every Friday at 4:00 PM · first run Fri
  4:00 PM" before anything is created (`ledger-plus-typing-*`). ChatGPT's box
  gives nothing until send.
- **The when-grouped list** with no trailing column on scheduled rows
  (`ledger-plus-default-*`). Quieter than the plain Ledger's mixed trailing
  column ("23s / missed / now / in 9h / tomorrow / Fri / by hand / paused",
  `ledger-default-bobble-dark.png`) and than the baseline's four rows of
  "in 23h".
- **Rejecting the references' noise.** No "New task ▾ → Create with Claude /
  Set up manually" (`11.58.15 PM`), no "+" menu of connectors
  (`12.03.44 AM`). Correct.
- **Template cards** carry the schedule line and use the app's stroked icons
  where the baseline used Unicode glyphs (`current/scheduled-empty-*`), and
  they are the same card recipe as Connectors
  (`current/connectors-bobble-light.png`).
- **One inline editor**, same form at 1168 and 640, never a modal. Both the
  baseline and Claude use a modal.
- **The kill switch** is a real, labelled Switch with a banner that says
  exactly what off means (`ledger-plus-off-*`) — where the baseline used a
  status-looking pill.
- **No purple** anywhere, across bobble / claude / codex in dark and light.
- **The 640 px layout** (list as the landing screen, detail pushed in with a
  back link) works in every non-empty state: `ledger-plus-running-narrow`,
  `-late-narrow`, `-review-narrow`, `-new-narrow`, `-off-narrow`.

## Not worth fixing

Differences from the references judged cosmetic — nobody's life is worse for
them.

- Claude's serif title, clock illustration and wavy divider. Decoration;
  Bobble is sans everywhere.
- Bordered template cards versus Claude's borderless grid. Connectors uses
  bordered cards; consistency wins.
- **Two 22 px titles** ("Scheduled" y=74, the task name y=207). The Model hub
  has three (`current/models-bobble-dark.png`: "Model hub", "Top
  Recommended", "More"), and the selected task *is* the content. Revisit only
  if item 5 does not calm the pane enough.
- ChatGPT's emoji template icons. No.
- Claude's "Sort by Next run ▾" and "All · Active · Paused" tabs. The
  when-groups do both jobs.
- Claude's hover "…" menu on rows. The pane's buttons are visible and one
  click away.
- The subtitle saying "next Tomorrow 7:30 AM" under a "Tomorrow" group label.
  At 640 the pane stands alone without the list; it must carry its own
  facts.
- The failed run row printing the runner's own error
  (`calendar_list_events was blocked…`). It is the record.
- Reach inferred from tool-name prefixes. Correct; a registry is a shared
  change.
- Claude's hover preview of a template's output (`11.57.58 PM`). Cloud-canned
  imagery; the blurb does it in words.
- Claude's "Permissions: Manually approve" row. An unattended local run has
  nobody to ask; "reads your Mac, never sends" is the answer, said in the
  editor.
- The Routines board's seven-things-per-card and the Agenda's
  expand-in-place. Neither is shipping; the Routines sheet
  (`routines-open-bobble-dark.png`) is Ledger+'s pane and the Agenda's one
  lesson — the placed composer — is item 1.
- Dark and light using a bordered box (dark) versus a filled box (light) for
  the prompt. Both read as "the prompt".

## The previous round's admissions, checked

1. *Detail pane busier in its top 120 px.* **Confirmed, restated** as item 5:
   the cost is the chip row between title and prompt, and both the reference
   and Bobble's own Connectors detail put those facts below the text.
2. *Two 22 px titles.* **Confirmed; not worth fixing** (Model hub precedent).
3. *No motion when switching tasks.* **Cannot be judged** from stills. See
   below for what to record.
4. *The composer is an 810 px bar that does not look placed.* **Confirmed,
   and the real cost is worse than stated**: not the width, but that it is
   the same pill as the search field 60 px below it and has no send
   affordance while idle (item 1). At 900 the width is fine; at 640 the
   placeholder clips.
5. *The empty state has three cold starts.* **Confirmed, restated**: the
   number of doors is not the problem, their alignment is — two axes,
   clamped blurbs (a regression from the baseline), and a phantom back link
   at 640 (item 2).
6. *Routines cards are seven things in a box.* **Confirmed** — tile, name,
   prompt line, schedule, next-run, last-run line, chip row; eight with a
   state pill on four of nine cards (`routines-default-bobble-dark.png`).
   Irrelevant to the ship decision.
7. *`titleFrom` names a task "Write up what I worked on".* **Confirmed** in
   every editor shot (item 6).
8. *Nothing touched by a hand.* **Confirmed** — no hover, focus, transition
   or two-step-delete image exists. The reference's template hover
   (`11.57.58 PM`) is the one interaction the references show that we have no
   picture of.

## What could not be judged from the available images

- **Hover, focus, transitions, the two-step delete, the parse chips
  appearing, the pane swap.** Needs a recording or paired before/after shots:
  hover on a list row and on a template card; the composer focused on the
  empty screen; the disclosure of a run row turning; "Delete" → "Delete for
  good?" → disarmed; the pane switching from Morning brief to Portrait of the
  day.
- **Chat-created tasks.** The reference's best moment is `12.00.58 AM` /
  `12.01.06 AM`: a task made in conversation, shown as a card in the chat
  with "Open". NOTES says a `create_scheduled_task` tool exists; whether
  Bobble's chat shows anything when it fires has no image.
- **Ledger+ inside the app chrome.** Every candidate shot is the bare content
  area; only the baseline shots have the sidebar and the top bar. The
  composer's relationship to the top bar's "Scheduled" label is unjudged.
- **`empty-routines-default-bobble-light.png` is stale** — timestamped 01:11
  against 09:00 for the rest, it still shows the deleted honesty strip and
  its tab strip has no "Ledger+". Re-shoot or delete it.
- **The dark and light `ledger-plus-default` shots hold different data**
  ("Watch llama.cpp releases" is in *Today* at 08:59 and in *Tomorrow* at
  09:02 because the clock crossed 9:00 between them). Not a theme bug; do not
  read it as one.
- **`empty-ledger-plus-late` and `empty-ledger-plus-running` are
  byte-identical to `empty-ledger-plus-default`** (124,850 B). Those states
  cannot exist on an empty list, which is fine, but the filenames promise
  something the files do not show.
