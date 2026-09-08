# Scheduled tasks — what shipped, what was left, and why

The screen in this directory is the Ledger+ candidate (`src/candidates/schedule/`)
made the shipping surface, then simplified to the reference's shape after the user
judged the two-pane version "similarly overcomplicated" — right on substance,
too much apparatus. This file is the record of what was taken, what was
stripped, what was refused, and what still stands.

## The shape

Two pages, one thing on screen at a time.

- **The list.** A plain title, one line under it, and at the right a magnifier
  (a field only when opened), the scheduling switch, and New task. The tasks
  are rows straight on the background — a 36px tile carrying the status glyph
  derived from the newest run and the task's real state (`derive.ts`: green
  tick, red "!" for a failed run, amber "!" for a missed slot, a spinner, the
  pause bars, a hand for by-hand), the name, the schedule with the day it fires
  next ("Weekdays at 7:30 AM · next tomorrow"), and a trailing word only where
  the state is the information: the elapsed time while running, "due",
  "missed" (amber), "paused", "off". Hover is the only fill. Sorted by
  attention, then by when: running, due, missed, then by next run, then
  by-hand, then paused. Under the list, one quiet row — "Start from a
  suggestion — Morning brief, What did I miss and 7 more ›" — opens the
  suggestions in place; a template whose name is already a task is not offered
  again. On an empty schedule the suggestions ARE the page, as rows (tile ·
  name · blurb · schedule · "+"), two abreast from 808px of page, one below.
- **The task.** Opened from a row, with "‹ All tasks" as the way back (Escape
  works too, and the keyboard lands back on the row). Header: tile · name
  (title size) · schedule with the state clause ("· Running · 25s", "· Missed
  4 Sep 6:30 PM · next in 20m") · **Run now / Stop · Edit · switch**. Then the
  instruction as plain text at a reading measure, three quiet facts (Reaches /
  Runs in / Runs on), the Runs ledger, and the delete footer.
- **The ledger** is untouched from the two-pane version: eight runs, then "Show
  N older runs"; a run's head is when · duration · model · by-hand/late tag ·
  first line (errors get two lines, in red); open, it is the report, the files,
  and "used Calendar · Mail". A stopped run is a quiet square, counted as
  neither ok nor failed. The newest run opens by itself.
- **New task and Edit are one dialog** (`TaskEditor.tsx`): What should it do?,
  Name, When (exactly the controls the frequency needs), Where it works, the
  consequence line ("Every day at 7:30 AM · first run tomorrow 7:30 AM (in 13h)"
  / "already passed, so it runs as soon as you save"), Cancel · Schedule it.
  Escape cancels, ⌘↩ saves, the keyboard returns to the button that opened it.
- **The sentence parse lives under the dialog's instruction field**, for a
  new blank task only. "every friday at 4pm, write up what I worked on this
  week" sets When to Friday 4 PM and a line says "Read as [Every Friday at
  4:00 PM] — the instruction becomes “write up what I worked on this week”";
  the timing words are left out of what is saved, because a model handed
  "every friday at 4pm…" as its brief has a scheduling tool and will use it.
  Nothing is presented as a reading until it is ("eve" shows nothing); a
  cadence alone says "add a time, or pick one below"; a sentence that was only
  timing words says "now say what it should do" and cannot be saved. The
  parse drives When only until a When control is touched.

## What was stripped, and why

- The permanent two-pane list+detail. A list with the detail reached by
  opening a row is one thing on screen, and the reference screens never show
  both. The FLIP row animation and the pane crossfade went with it: rows
  reorder only while you are on the task's page, so there is no move to follow.
- The sentence box with its live-parse ledge — the loudest thing on the page
  for something used once per task — and the strip it folded into. The parse
  itself was kept; it moved into the dialog.
- The group headings (Now / Today / Tomorrow / This week / Later / By hand /
  Paused). Six headings for nine rows was more chrome than content; the "when"
  survives as a clause on each row, and the order is still by when.
- The state pill in the pane and the missed pill's second Run now. The state
  is a clause in the schedule line; Run now is already in the header.
- The prompt's inset box, the "Reach" heading over the facts, the template
  cards (rows now), the collapsible search in a list head (a magnifier in the
  header now).

## Plumbing that was built, not drawn

- **`tasks:stop`** (`scheduled-contract.ts`, `scheduled-runner.ts`,
  `scheduled-main.ts`, `tasks-store.ts`). The runner disposes the live bridge
  (which frees the model slot it held) and finalises the record as `stopped`
  with whatever it had said so far; a run still queued behind another is
  dropped before it starts and leaves no record. Run now becomes Stop in the
  same place while a run is going. Unit-tested (`scheduled-runner.test.ts`),
  and driven for real by `scheduled-probe.mjs` through the mock pi.
- **`TaskRun.model`** — stamped from the inference supervisor's loaded model at
  run start, and at run end if none was loaded at the start. The ledger says
  "41s · Gemma 4 12B"; Runs on says "Gemma 4 12B last time · none loaded now".
- **One namer**: `nameFrom` / `nameWasCut` and the human schedule sentence live
  in `@pi-desktop/shared` (`schedule-words.ts`) and are used by the screen, the
  scheduler and the harness tool, so a task is named and read back the same
  way wherever it was made.

## Refused or left

- **A card for a task made in the chat.** The chat's surface, not this
  screen's; the plumbing it needs is in place (`describeScheduleWords`, and
  this screen can be opened with a task selected once `onOpenScheduled`
  carries an id).
- **Notify on completion and failure.** A new behaviour outside the screen; the
  runner's `onRunUpdated` is the seam.
- **A per-row control** (switch, or a "…" menu). The row is the control — it
  opens the task, where pause, run and edit live once. Easy to add if the list
  is where people want to pause things.

## Evidence

`tests/e2e/scheduled-probe.mjs` drives the real thing end to end (the plain
page, the dialog's honest parse and what it saves, pause and the kill switch
without movement or reordering, a tool-written task arriving live with its
history, a real run through the mock pi with Stop, Edit, search, delete).
`tests/e2e/scheduled-design-probe.mjs` photographs every state in both themes
at 1440, and the list, the task's page and the suggestions at 1172/900/760,
films the transitions (open, back, kill switch, suggestions, Run now, Stop)
and dumps `measure.json`; frames land under `src/scheduled/shots/{seeded,empty}/`.
