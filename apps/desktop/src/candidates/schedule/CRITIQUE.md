# Critique — round 2, before touching a component

Written from screenshots re-taken this morning (2026-09-07 ~08:33, `shots/`),
side by side with the fourteen references in `~/Desktop/refs/schedule/` and
the shipping Model hub / Connectors / Scheduled screens re-shot at the same time
(`shots/current/`). Nothing below is from memory or from last round's images.

## 0 · The thing I said I would ship does not exist

NOTES.md ends: *"Ledger, with the Agenda's composer-and-live-parse grafted
above its list."* There is no such screen. I wrote a verdict about a design I
had never rendered, which is the same failure as reporting a fix I had not
looked at. The Ledger's only way in is a form in the right pane; the Agenda's
sentence box, the one part of round one that actually removes a step, is
stranded in the candidate I said I would not ship. **Finding: the shipped
recommendation was a sentence, not a screen.** It gets built this round, as a
fourth entry, and it has to be the best of the four or the verdict was wrong.

## 1 · What the probe did while I was not looking

Compare `ledger-default-bobble-dark.png` with `ledger-default-bobble-light.png`,
taken forty seconds apart. Dark: Morning brief has "4 ok · 1 failed" and
Portrait of the day is "running". Light: "5 ok · 1 failed", a new run
"Today 8:33 AM · 1s · Done — hello.txt now greets the world", and Portrait is
finished with a ✓. The **real scheduler fired between the two shots**: the
seeded tasks had slots at 7:30 and 8:00 today with no `lastRunAt`, so
`dueTasks` caught them up on its next 30 s tick, through the mock pi. The
seeded "running" run I was photographing was replaced by a real one.

So half of round one's light-theme images were of data that had changed under
me, and I did not notice — the exact mistake in my own "stillness read as
state" memory. The seed has to set `lastRunAt` on every task that has seeded
runs (the probe already patches `createdAt` through `tasks:update`; the
handler normalises `lastRunAt` the same way). The one task that must stay
un-stamped is the aged "What did I miss", because being un-run past its grace
is what makes it MISSED.

It also means the seeded runs predate `TaskRun.trigger`. They get it now, and
one of them becomes a caught-up run (started 1h 42m after its slot) so the
ledger can say the sentence the field was added for.

## 2 · Ledger

**What the reference does better.** Claude's list+detail (`12.01.27 AM`) is
quieter in every dimension. Its row is two lines of prose — "Weekdays at
9:00 AM · Next run in 18 hours" — with no glyph column and no trailing
column; mine has a coloured glyph *and* a trailing word, and the trailing
column mixes types: "running", "missed", "in 27m", "in 22h 57m", "by hand",
"paused". Six rows say "in 22h 57m"-grade precision for tomorrow morning;
nobody is waiting 22 hours with a stopwatch. I wrote in `derive.ts` that a
countdown "keeps its minutes because people wait for it" — true under an hour,
false past it. Why I missed it: I wrote `describeDelta` once and used it for
every surface without asking which surface was a countdown.

Its detail pane leads with one blue word, "Active", above the name. Mine leads
with a 40 px tile, then a name, then a line that says the same thing twice
("Weekdays at 7:30 AM · next Tomorrow 7:30 AM · in 22h 57m"), then a **green
pill that says "Next"**. Green means good; "Next" is not a state. That pill is
my own version of the "5 completed / 2 still open" ring I rejected in
`11.58.02 PM`: colour that reports nothing. `StatePill` on a scheduled task
goes; a pill stays only where the word carries information (Running, Due,
Missed, Paused).

**What I copied out of deference.** The `Active` switch inside the editor
(`TaskEditor.tsx` "Where it works … Active"). It is there because the shipping
`TaskDialog` has an Active pill, and I kept it without asking who creates a
task paused. Nobody. The detail header already has the real switch. Out.

**Where it is worse than Bobble's own screens.**
- *Type scale.* `.sc-detail-title` is `calc(heading × 1.125)` = 16.9 px. The
  scale is 12 / 14 / 15 / 22. I invented a size. The Model hub's detail pane
  uses `text-title` for the family name; that is the precedent.
- *Section labels.* "RUNS" is uppercase, tracked, 12 px. No sibling does this:
  Connectors' `ConnectorSection` is `text-body text-text-primary` with a muted
  count ("By us 6"); the sidebar's group labels are sentence-case muted
  footnote. I introduced a third convention into an app that already has two.
- *Colour weight.* The honesty strip has an orange item on every shot
  ("No model loaded — the first run loads it"), because the probe never loads a
  model — but that is also true of a fresh install, which is exactly when the
  screen is being judged. A warning-coloured sentence that is true for weeks
  is furniture in warning paint. See §5.
- *Density.* The strip plus header cost 110 px before the first row; the
  Model hub gets its title, subtitle, hardware chips, two tab groups and a
  search into 120 px.
- *Redundancy in the running state* (`ledger-running-bobble-dark.png`): the
  word "running" appears four times and a spinner three times — strip, row,
  detail subtitle, detail pill, run row. One screen, one live indicator.
- *The tool trail is raw ids.* "used calendar_list_events · mail_recent ·
  reminders_list" on a user-facing screen, three lines under chips that already
  say "Calendar · Mail · Reminders". The reference never shows a tool name.
- *The artifact is hidden.* "Portrait of the day" exists to produce a picture,
  and the picture is behind a collapsed run row. An image-producing run should
  show its image on the row.

**At 900 px** (`ledger-default-mid-bobble-dark.png`): the strip wraps to two
lines (146 px before content); the 320 px list is 36 % of the width; the
detail's subtitle wraps under the action buttons with "7:30 AM · in 22h 57m"
orphaned. List → 280 px; subtitle → one fact.
**At 640 px** (`…narrow…`): stacks correctly with a back link, but the detail
subtitle wraps to three lines with "in" orphaned on the second. Same fix.

**The tradeoff I flagged** ("a permanent left column costs ~320px, so this
needs the content area"): acceptable — the Model hub is the same anatomy in
the same content area. What I did *not* flag: the Ledger has no fast way in.
"New task" is a form. That was the graft I promised.

## 3 · Agenda

**What the reference does better.** ChatGPT's composer (`12.03.38 AM`) is the
first thing after the title; mine is fourth, under a two-line strip. Claude's
row (`12.01.27 AM`) states the schedule once. Mine states it in the time cell
("9:00 AM / in 27m"), again in the meta line ("Every day at 9:00 AM"), and a
third time as a **seven-day dot strip** on the right — 5 px dots with 9 px
letters, illegible at 1168 and a grey smear at 900. I built a visualisation of
a fact already written in words three inches to its left. Why: it looked like
"information density" in the abstract; on the screen it is fiddly chrome, which
is the thing the user said the user dislikes and which I then flagged as a tradeoff
instead of removing.

Beside it, a **green ✓ on every row**, meaning "last run ok" — which the green
check-circle glyph on the *left* of the same row already says. Two identical
green ticks per row, eight rows.

**Copy that claims more than the app knows.** "missed 4 Sep 6:30 PM — Bobble
was not open". The app knows the slot passed without a run; it does not know
whether Bobble was closed, the Mac was asleep, or scheduling was off at the
time. That clause is the kind of confident guess the brief rules out, and I
wrote it. Also the whole second line goes orange, including "Weekdays at
6:30 PM ·", which is not a warning.

**Copied out of deference.** The "+" glyph in the composer is ChatGPT's "+"
(`12.03.44 AM`) minus the menu it opens — an icon that does nothing.

**Where it is worse than Bobble's own screens.** Uppercase group labels
("TODAY", "TOMORROW", "START WITH") — same third-convention problem as §2.
The subtitle "When things run on this Mac — and whether they can." is a slogan;
the reference's "Run tasks on a schedule or whenever you need them." is a
sentence. The `typing` and `default` states are indistinguishable at a glance
because the placeholder *is* the sample sentence.

**A bug.** `TaskEditor` derives a name with `.slice(0, 40)`: the editor shot
shows "Summarise what changed in my working" — cut mid-phrase. `titleFrom` in
schedule-logic already does this on word boundaries; I re-implemented it worse.

**At 900 px**: fine. **At 640 px**: fine (strip and week strip hide). The
narrow layouts are the only place the Agenda is *better* than the Ledger.

**The tradeoff I flagged** ("the week strip and hover icons are dense; the user's
stated dislike of fiddly chrome may apply"): that was not a tradeoff, it was
a finding I chose not to act on. The strip goes. The hover icons stay only in
the Agenda, whose argument is a one-column list; the merged candidate puts
actions in the detail header where they are visible.

## 4 · Routines

**What the reference does better.** Claude's template grid (`11.57.43 PM`) is
icon, name, blurb, schedule — four things, no border, generous line height.
My *task* card is tile, name, pill, two lines of prompt, schedule row with a
countdown, chips row with a duration: eight things in a 1 px box. Nine of them
in view. The chips "OSS-harness · Terminal · Files" repeat identically on five
cards; information that does not discriminate is noise, and it is the card's
busiest row.

**The card shows the measurement, not the result.** The bottom-right corner is
"✓ 1m 36s" — the duration of the last run. Nobody schedules a task to learn
how long it took. The whole argument of these candidates is "judged by what it
left behind", and the card omits the one line that *is* what it left behind:
the last run's first sentence. That is the real miss on this board.

**Where it is worse than Bobble's own screens.** The "New routine" ghost card is
a 175 px-tall dashed cell holding a button. The Model hub and Connectors put
"new" in the header and nowhere else. On the empty board the same cell sits
beside nine template cards that already *are* the ways to start.

**At 900 px**: two columns, cards get roomier, the strip wraps. **At 640 px**:
one column; the ghost card is now a full-width 130 px button; the header
controls drop under the title, which is fine.

**The tradeoff I flagged** ("cards hide the run history one click away"):
accurate and still true. It is why this is not the one to ship, and why the
sheet is now the only place a Routines card's history lives — the sheet itself
(`routines-open-bobble-dark.png`) is the best-looking surface on the board,
which says the detail is the product and the cards are a menu.

## 5 · The honesty strip (all three)

Under the header on every candidate: "Runs one task at a time, only while
Bobble is open · No model loaded — the first run loads it · Can read your Mac;
cannot send anything". I called it "the difference between a local product and
a cloud one, said once". It is not said once; it is said on every visit, in
34–60 px, and two of its three sentences never change. The reference solves the
same need with a subtitle. The only item that earns permanent space is the
*live* one — a run in flight — and that belongs on the row that is running.

Where each sentence actually goes: "only while Bobble is open" → the subtitle;
"can read, cannot send" → the editor's consequence line (already there) and the
empty state; "no model loaded" → the editor preview and the run list's empty
message, the two moments it changes what will happen next. The strip is
deleted, not trimmed.

## 6 · Things all three copied from the refs that I should not have

- A **"Scheduling on" label + switch** in the header, from the shipping screen's
  pill. Kept, but it is a feature-level kill switch beside a per-page CTA; the
  Claude and ChatGPT screens have no such control at all. Acceptable — the user
  wanted it findable — but it should not read as a per-task control.
- **Reach chips on every card** (Routines), from the plugin icons in
  `12.01.27 AM`'s "From Plugins" list. Real, but repeated where they do not
  differ. On the merged candidate they live in the detail only.

## 7 · Probe and process

- The 900 px width the brief asks about was never shot; the probe had 1168 and
  640. Added (`CONTENT_MID`).
- The seed's runs carry no `trigger`; the field exists now and the probe should
  exercise it, including one caught-up run.
- `tasks:update` accepts `createdAt` and `lastRunAt` from the renderer although
  `Partial<TaskDraft>` says it cannot. Useful for the probe; worth knowing.

## 8 · What changes, in order

1. Seed: `lastRunAt` stamps, `trigger` on every run, one late run, one manual.
2. `derive.ts`: `describeSoon` (coarse, for columns), `lateBy` (from
   `trigger` + `previousRun`), reach labels for tool trails, `titleFrom` reuse.
3. Shared: strip → gone; `StatePill` only for states that are states; section
   labels → Connectors' convention; detail title → `text-title`; no invented
   sizes.
4. Ledger: 280 px list; one-fact subtitle; artifact thumbnail on image runs;
   trail in reach vocabulary; "by hand" / "ran 1h 42m late" on run rows.
5. Agenda: week strip out; duplicate ✓ out; warning colour on the clause only;
   honest missed copy; distinct typing sample; composer first.
6. Routines: last-run headline on the card instead of duration; ghost card
   shrunk to a row; chips capped and only when they differ from the folder.
7. Editor: Active switch out; word-boundary name.
8. **Ledger+**: composer with live parse across the top, list left, detail
   right, ↵ opens the prefilled editor in the pane. Render, look, fix, repeat.
