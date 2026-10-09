# Judgement — round 4

Written from the images only: the fourteen references in `~/Desktop/refs/schedule/`,
every Ledger+ shot in `shots/` (bobble dark and light at 1168, dark at 900 and 640,
all seven states, the `empty-*` first-run set, and — new — the seventeen
`ledger-plus-ix-*` and three `empty-ledger-plus-ix-*` interaction shots), the
shipping screens in `shots/current/`, and the Connectors candidates in
`../connectors/shots/` as the in-app bar. `NOTES.md` was read as a list of claims
and each claim was checked against a picture; where no picture exists it is said
so below. Coordinates are pixels in the 1168-wide shots unless a width is named.
Where a detail was too small to call at 1× (a switch's opacity, a button's
fill, a row's hover tint) it was cropped and enlarged 3× before being judged;
nothing was read from source, and the only two facts taken from `NOTES.md`
without a picture are marked as such.

## Verdict: above the references

I agree with the builder. Round 3's verdict was parity because the room (the
run ledger on the page, the derived states, the consequence line) was above both
references while the front door (a composer that read as a search field, a
first-run screen with two axes and clamped blurbs) was below. The front door is
now level with the best reference door — ChatGPT's box, with a live parse
ChatGPT does not have — and above Claude's menu-and-modal; the first-run screen
is level with Claude's; and the room is untouched. On the axes the references
cover, nothing in the fourteen images beats a state of this screen. What keeps
it from being above on *every* axis is two things no reference has either — a
Stop for a run that holds the local model, and the model's name on the run —
and both are shared changes the builder correctly did not fake. Items 1–3
below are what I would still do; none of them is a reason to hold the ship.

## The round-3 work order, item by item

Each item: what was asked, what the picture shows, and the shot it was checked in.

1. **The front door read as a search field.** **Fixed**, all four parts.
   (a) `ledger-plus-default-bobble-dark`: a 28 px send circle at x≈1122 sits in
   the composer while idle — grey disc, muted arrow (crop at 4×) — and turns
   accent blue with a white arrow once there is text
   (`ledger-plus-typing-bobble-dark`). The typed-state "Check it" button is
   gone; the lane's "↵ to check it" at x=1141 and the live circle say it.
   (b) The box spans x 24→1144, level with the "New task" button's right edge
   at 1143; rounded rectangle, hairline, raised — the chat composer's shape
   (`current/chat-bobble-dark`), not the 835 px pill. At 900 it ends at 876
   under a button ending at 876 (`…-default-mid-…`). (c) "Search tasks" is a
   magnifier + label in the list head at y=225 with no field around it; it
   expands in place into a bordered field with the focus ring
   (`ledger-plus-ix-search-open-*`, field x 8→271, y 208→242) and the list
   below does not move ("Now" stays at y=257); "test" leaves one row
   (`…-search-typed-*`). (d) Placeholder "Every weekday at 9am, summarise what
   changed" ends at x≈398 with the arrow at 594 at 640 px
   (`ledger-plus-default-narrow-bobble-dark`) — nothing clips.
2. **The first-run screen.** **Fixed.** No "‹ All tasks" at 640
   (`empty-ledger-plus-default-narrow-bobble-dark`: "Nothing scheduled yet" at
   y=270 directly under the lane). The template grid's left edge is x=24, the
   composer's left edge (`empty-ledger-plus-default-bobble-dark`) — one axis.
   Blurbs are whole sentences at every width ("Your day, before you start it:
   today's events, what arrived overnight, what is due. Runs on your Mac.
   Nothing leaves it." — the baseline's text, back); three columns at 1168
   (x 24/397/770), two at 900 (`…-default-mid-…`), one at 640. The composer
   carries the 1.5 px blue focus ring with nothing clicked
   (`empty-ledger-plus-default-*` and `empty-ledger-plus-ix-composer-focus-*`
   are the same picture, which is the point).
3. **Running: three copies and no Stop.** **Partly** — the sanctioned fallback.
   `ledger-plus-running-bobble-dark`: the greyed "Running…" button is gone from
   the header; "Edit" (x≈1012) and the switch (x≈1067) hold their positions
   exactly (crop against `-default`), so nothing shifts when the button leaves.
   The pill "◌ Running · 24s" at (357, 289), the list row's "24s" and the run
   row's "24s so far · by hand" remain, as round 3 asked. There is still no
   Stop on any surface; that needs `tasks:stop` (see below).
4. **Off: the screen argued with itself.** **Fixed.** `ledger-plus-off-bobble-dark`:
   no "Off" pill; the subtitle says "scheduling is off"; the per-task switch at
   (1067, 280) is the same switch at roughly half opacity (crop: dull blue
   track, grey thumb, against the bright track and white thumb in `-default`)
   — dimmed, not disabled. The when-groups stay in their places (Now / Today /
   Tomorrow / This week / By hand) with a trailing "off" on the six rows the
   switch silences; "Sort my Downloads · Only when you run it" under By hand
   has no trailing word (crop of y 790→860); the running "Portrait of the day"
   keeps its "24s". Light and 640 match.
5. **Reach chips above the prompt.** **Fixed.** `ledger-plus-default-bobble-dark`:
   the header is tile (357, 224), 22 px title, schedule line, controls; the
   prompt box begins at y=281; under it a **Reach** block at y=478→553 in
   Connectors' label/value form — "Reaches  Calendar · Mail · Reminders",
   "Runs in  A folder of its own, kept per run" (or "OSS-harness —
   the repo root" in `-late`), "Runs on  whichever model
   Bobble loads first — none is loaded yet". Same recipe as
   `../connectors/shots/ledger-detail-github-bobble-dark` ("Group / Touches /
   Runs as / Command").
6. **Machine-cut names.** **Fixed for the sentence shown; the guessed-name lead
   line is unpictured.** `ledger-plus-review-*`, `ledger-plus-ix-enter-*`,
   `empty-ledger-plus-review-*`: Name = "Write up what I worked on this week",
   whole. No shot has a prompt long enough to be cut (the portrait prompt would
   be), so "The name is its first words — change it if you like" exists only in
   `NOTES.md`. Not a blocker; the visible case is the one round 3 named.
7. **Two type-here boxes while the editor is open.** **Fixed.**
   `ledger-plus-ix-enter-bobble-dark`: the composer is a one-line strip at
   y=119→156 — "⟳ From "every friday at 4pm, write up what I worked on this
   week"" with "Edit sentence" at x=1090 — above an editor whose textarea
   holds the sentence. `…-strip-back-*`: "Edit sentence" puts the sentence
   back in the composer with the ring and the chips, "Morning brief" still
   selected. From "New task" the composer hides altogether
   (`ledger-plus-new-*`). The header's "New task" changes from the
   inverted-mono pill to a secondary grey pill while an editor is up (crop:
   white-on-dark → grey-on-dark; in light, black → light grey). It reads as
   *demoted* rather than pressed, which is fine since a click does nothing.
   The cost of the collapse and the hide is item 2 of the new list.
8. **The parse chips pushed the page.** **Fixed, measured.** "Search tasks" is at
   y=225 in `ledger-plus-default`, `-typing`, `-ix-composer-focus`,
   `-ix-typing-1`, `-2`, `-3` and `-ix-strip-back`; the chips appear in a lane
   between the composer (bottom y=166) and the divider (y=200). At 640 the list
   head holds y=263 in `-default-narrow` and `-ix-typing-3-narrow`, the hint
   dropping first so the three chips fit on one line. On the empty screen
   "Nothing scheduled yet" holds y=232 (`empty-…-typing`) and y=270 at 640.
9. **"Add another" over an empty form.** **Fixed.** `ledger-plus-new-bobble-dark`
   y=602: "Or start from one of these", subtitle "Every one runs on this Mac; it
   can read what is here and cannot send anything."
10. **Delete said nothing about what it deletes.** **Fixed.** Hairline at y=717,
    "Deleting removes the task and its 2 runs." at y=746, "Delete" at x=1052
    (`ledger-plus-running-*`). Armed (`ledger-plus-ix-delete-armed-*`): the
    button becomes "Delete for good?" + a red-tinted "Delete" (x 962→1022) +
    "Keep" (x 1032→1080); Keep disarms it (`…-delete-kept-*`). 640 matches.
    Only the "2 runs" variant is pictured; the "one run" / "no runs" wordings
    are `NOTES.md` claims.
11. **Nothing said what runs it.** **Partly.** The Reach block's "Runs on" and the
    editor's consequence line ("no model is loaded yet — the first run loads
    one") say what the *next* run would use. Every shot shows the no-model
    sentence because the probe loads none, so the named-model form ("runs on
    Gemma 4 12B") is unpictured. Past runs still carry no model — the run
    rows' meta is duration only. `TaskRun.model` is the shared change.

Score: eight fixed, one fixed-as-far-as-pictured (6), two partly (3, 11) — and
the two partials are the two items round 3 already marked as outside this
directory.

## The four rejections, judged

- **A Stop control now.** Reason holds. Round 3 offered "hide the dead button"
  as the fallback; the builder took it, and a Stop wired to nothing would be
  the greyed button with a worse name. The IPC proposal in `NOTES.md` is small
  and specific. Stays at the top of the outstanding list below.
- **"↵ to check it" as the lane's idle content.** Reason holds. With the send
  circle always visible an idle hint is a second affordance for the same act,
  and "check it" with nothing typed is nonsense. The empty lane reads as
  spacing between the composer and the panes, not a hole — 34 px under a 48 px
  box (`e` crop). Accept.
- **Chips inside a box that grows.** Reason holds; round 3's own item 8 wanted
  stillness under the composer, and a growing box is the opposite. The lane
  satisfies both readings.
- **Round 3's exact `titleFrom` rule.** Reason holds. The rule as written
  (clause boundary, then six words) would have cut the very sentence it was
  written for; the builder's whole-clause allowance first is the correct
  ordering, and the table in `NOTES.md` shows nine before/after cases. The
  remaining weakness ("Generate one portrait in the style") is admitted and
  ends on a word.

## What still stands between this and "above" on every axis

Ranked by what it costs the person using it. The first and third are shared
changes; the rest are one-file fixes.

### 1. A running task cannot be stopped from any surface

**Seen.** `ledger-plus-running-bobble-dark`: pill, list row and run row all say
running; the header holds Edit and the switch and nothing that stops. No
reference has a Stop either — but the references are cloud runs. Here the run
holds the one local model slot, and a runaway prompt costs the user the chat.

**Change.** Land `tasks:stop` (`NOTES.md` proposal 1) and let "Run now" become
"Stop" in the space it already vacates (x 888→977). Until then the screen is
honest — better a missing control than a dead one — but this is the one
control a *local* scheduler needs that this screen does not have.

### 2. The list column moves when an editor opens

**Seen.** The list head ("Search tasks") is at y=225 in the default, typing and
focus states; y=192 after ↵ (`ledger-plus-ix-enter-*`, `ledger-plus-review-*`)
because the strip is 37 px where the box + lane were 82; and y=144 after "New
task" (`ledger-plus-new-*`) because the composer hides. So the persistent
navigation has three resting heights, and Cancel bounces it back. Round 3's
item 8 was about typing; this is the same complaint one click later. Claude's
modal (`11.58.21 PM`) leaves the page under it exactly where it was.

**Change.** Give the composer's slot one height across its three states. The
strip should occupy the box + lane (or the lane should stay under the strip,
empty), and "New task" / Edit should show a strip too — "New task" / "Editing
Morning brief" with the same right-aligned action — rather than hide the
composer. Then y=225 holds in every state and the 640 layout gains the same
stillness.

### 3. Nothing names the model, and the model cannot be chosen

**Seen.** "Runs on  whichever model Bobble loads first — none is loaded yet" in
every shot; run rows carry "41s" and nothing else. Claude's editor
(`11.58.21 PM`, `11.58.35 PM`) has "Default model ▾" with a list. For a local
app the model is the quality, speed and memory decision, and
`ScheduledTask.modelId` already exists unread (`NOTES.md` proposal 2).

**Change.** Shared: write the model on the run at start so the row's meta can
read "41s · Gemma 4 12B", and either honour `modelId` with a picker in the
editor's "Where it works" row or delete the field. In this directory: when a
model *is* loaded, the value should be its name and nothing else; a shot with
a loaded model would settle whether it is.

### 4. The empty screen with an editor open

**Seen.** `empty-ledger-plus-new-bobble-dark` (and `-narrow`): the composer is
hidden, yet the section under the form still reads "Nothing scheduled yet —
Start from one of these, **or write your own above**". There is nothing above.
The non-empty New state already fixed this heading (item 9); the empty one did
not get it. Second, the same shot is not a blank New-task form: it holds the
sentence draft from the previous step ("write up what I worked on this week",
Every week / Friday / 4 PM) with its "From …" strip removed and its "Read from
your sentence" lead gone — so clicking "+ New task" while a sentence-born
editor is open drops the provenance but keeps the values. A person who wanted
a blank form gets their old sentence with no way back to it.

**Change.** Under any open editor use "Or start from one of these". And decide
what "New task" does while the sentence editor is up — do nothing (as
`NOTES.md` says it should) or reset the form — but not the pictured third
thing.

### 5. Off rows keep the healthy glyph

**Seen.** `ledger-plus-off-bobble-dark` (crop of y 380→560): a green ✓ at the
left of a row that says "off" at the right, six times. The word was round 3's
request and it is right that the list does not reshuffle; the glyph is what
still argues.

**Change.** While scheduling is off, draw the row glyph in the muted colour
(the paused glyph's grey) so the row does not say "fine" and "off" at once.
The amber "!" on the missed row can stay — it is missed *and* off.

### 6. The template hover says "clickable", not what a click does

**Seen.** `empty-ledger-plus-ix-template-hover-bobble-dark`: the Morning brief
card's border lightens and it lifts 1 px (title y=303 vs 304); in light a
shadow appears. The reference's hover (`11.57.58 PM`) does three things: fills
the card, swaps the icon tile for a "+", and slides in a canned preview. The
preview is not worth copying (below). The "+" is: it says the click adds.

**Change.** On hover, either swap the tile to "+" the way the reference does
or reveal a small "Use" at the card's bottom-right. Cheap, and it settles what
the cards are for.

### 7. Stale flavour shots

**Seen.** `ledger-plus-default-claude-dark/light` and `-codex-dark/light` are
timestamped 09:03 against 10:55 for the bobble set and show the round-2 screen:
the 810 px pill composer stopping at x=835, "Search tasks" as a pill field, the
chip row above the prompt, no Reach block, "23s". Anyone opening the folder to
check the flavours sees the design round 3 was told to fix. No purple in them,
but they are not this screen.

**Change.** Re-shoot or delete, as round 3 said of `empty-routines-*-light`.

## The interaction states

Every earlier round judged stills of a hidden window; these are the same
window driven by a mouse and a keyboard, and they are the first evidence that
the design *behaves*. What they show, in the order a person would meet them:

- **Composer focus** (`ledger-plus-ix-composer-focus-*`): the 1.5 px blue ring
  on the box, nothing else changing. Same ring on the empty screen with
  nothing clicked (`empty-…-ix-composer-focus-*`).
- **Typing** (`…-ix-typing-1/2/3`): "every friday" → "Every Friday at 9:00 AM"
  and "first run Fri 9:00 AM"; " at 4pm" → both chips flip to 4:00 PM; the
  quote chip grows with the clause. The send circle turns blue on the first
  character. "Search tasks" at y=225 in all three. The 640 shot fits three
  chips on one line by dropping the hint.
- **↵** (`…-ix-enter-*`): the editor with the whole name in a focused Name
  field, the composer folded to its strip, "New task" demoted.
- **Edit sentence** (`…-ix-strip-back-*`): the sentence back in the box with the
  ring and the chips; the previously selected task still selected — nothing
  was lost by looking.
- **Search** (`…-ix-search-open/-typed`): the magnifier becomes a field in
  place, the list does not move, "test" leaves one row under its group label.
- **Row hover** (`…-ix-row-hover-*`): a filled, rounded row under the pointer;
  clear in dark, faint but present in light (crop: a one-step darker grey on
  the list's grey). The app's sidebar rows use the same token; leave it.
- **Row focus** (`…-ix-row-focus-*`): a blue ring drawn *inside* the row (x
  8→261, y 270→326), so keyboard users have a target and the scroll area cannot
  clip it.
- **Pane swap** (`…-ix-pane-swap-mid/-after`): the incoming pane caught mid-way
  — its title 1–2 px lower than settled, so the crossfade also slides up.
  Motion itself cannot be judged from two stills; that it exists can.
- **Run hover / open** (`…-ix-run-hover/-open`): a run row under the pointer
  takes a fill (x 378→1088), which is what says the rows open; opened, the
  4 Sep run shows its three lines, its "used Calendar · Mail · Reminders" and
  "Delete run", and the previously open Today run folds to its first line.
  One open at a time; the ledger stays scannable.
- **Delete armed / kept** (`…-ix-delete-armed/-kept`): "Delete for good?" +
  red Delete + Keep, then back to a lone "Delete". The 4 s auto-disarm is a
  claim (no still can show it).
- **Template hover** (`empty-…-ix-template-hover-*`): border, 1 px lift, shadow
  in light. See item 6 above.
- **Typing on the empty screen** (`empty-…-ix-typing-*`): chips in the lane,
  templates unmoved.

**Against the reference's one interaction.** `11.57.58 PM` shows a template
hover doing three jobs: it fills the card, swaps the tile to "+", and slides
in a "5 completed / 2 still open" preview clipped by the card's corner. Ours
does one job (this is clickable) with a lift and a border. The reference is
better at one thing — saying that the click *adds* — and that is item 6. Its
preview is canned cloud imagery for a task type; a local app has no such
picture to show and the blurb already says what the task produces, so ours is
right not to copy it. Against the rest of Bobble, the ix set is consistent:
the same ring on the composer, the search field, the Name field and the list
row; the same fill for a hovered row and a hovered run; the same
inverted-mono primary as Connectors' "Add MCP server".

## Already better than the references

Carried from round 3 where still true; do not "fix" these.

- Run history on the page with first sentence, duration, "by hand", "1h 42m
  late", the real error in red, the run's picture on the row. No reference
  shows a run's result at all; the shipping drawer says "No runs yet".
- Derived states — running / due / missed / late / by hand / paused / off —
  and, new, off *wrapping* the inner state so the list does not reshuffle.
- Live parse while typing, with the first run named before anything exists.
- The consequence line: "Today 9:00 AM already passed, so it runs **as soon as
  you save**" (`ledger-plus-new-*`). Claude's modal is silent; ChatGPT's box
  gives nothing until send.
- The composer, now: spans the column, always has a send affordance, and the
  reach of a sentence is shown under it rather than after a round trip.
- One inline editor, same form at 1168 and 640, never a modal.
- The when-grouped list with no trailing word on ordinary rows.
- The Reach block derived from the tool trail, not from reading the prompt.
- Delete that says what it takes and asks once, in place.
- The kill switch as a real Switch with a banner that says exactly what off
  means and that by-hand runs still work.
- No purple anywhere, dark or light, in any state.
- Keyboard focus on rows and in-place search — neither reference shows either.
- Templates: Connectors' card recipe, the app's stroked icons, whole blurbs,
  a schedule line — level with Claude's, above ChatGPT's emoji one-liners.

## Not worth fixing

- The 34 px idle lane. It is spacing; the alternative moves the page.
- Two 22 px titles ("Scheduled", the task name). The Model hub has three.
- Claude's serif, clock illustration, wavy divider; ChatGPT's emoji tiles.
- ChatGPT's mic and "+" menu in the composer (`12.03.44 AM`). The "+" is a
  connector picker this task does not need; dictation belongs to the chat.
- Claude's hover preview of a template's output. Cloud-canned.
- Claude's "Sort by Next run" and All / Active / Paused. The groups do both.
- Claude's Suggestions and From Plugins sections listed *under* the real tasks
  (`12.01.27 AM`). Ours puts templates one click away under "New task"; a list
  of nine does not need twelve more rows.
- Claude's hover "…" menu on rows. The pane's buttons are visible.
- The composer's focus ring at rest on the empty screen. The caret's home
  should look like it.
- "Search tasks" as a ghost label rather than a field. It expands when wanted.
- The empty-screen divider at y=200 and the light theme's filled prompt box
  versus the dark theme's bordered one. Both read correctly.
- The "Run now" button vanishing (rather than dimming) while running — Edit
  and the switch hold their places, so nothing jumps.
- The failed run row printing the runner's own error. It is the record.
- Claude's Permissions row. An unattended local run has nobody to ask.

## What could not be judged from the images

- **Motion**: the pane crossfade's feel, the strip collapsing, the chips
  arriving, the delete auto-disarm at 4 s. `pane-swap-mid` proves motion
  exists; nothing proves it is good. A short recording of ↵ → Edit sentence
  and of one pane swap would close this.
- **The named-model "Runs on" line** and the editor's "runs on Gemma 4 12B" —
  no shot has a loaded model. One shot with a model loaded is needed before
  item 3 can be called half-done in this directory.
- **The guessed-name lead line** ("The name is its first words — change it if
  you like") — no shot has a prompt long enough to be cut.
- **The "one run" / "no runs" delete wordings** — only "its 2 runs" is pictured.
- **A task made in chat.** The reference's best moment (`12.00.58 AM`,
  `12.01.06 AM`) has no Bobble counterpart image; whether the chat shows a card
  when `create_scheduled_task` fires is still unknown, two rounds running.
- **Ledger+ inside the app chrome.** Still no shot with the sidebar and the top
  bar's "Scheduled" label above the composer. The shipping screens
  (`current/scheduled-list-*`) show what that chrome is; the candidate has
  never been photographed inside it.
- **Stop**, obviously — there is nothing to photograph.
