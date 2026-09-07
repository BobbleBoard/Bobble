# Scheduled tab — three candidates

Rendered at `?candidates=schedule` (`PI_DESKTOP_CANDIDATES=schedule`), nothing
outside this directory changed. Every colour, radius and duration is a `--pd-*`
token; the six flavor × mode combinations are in `shots/`.

To look at them yourself, from `apps/desktop`:

```sh
# a renderer-only dev server — the app's own vite.config would spawn a visible Electron
CAND_VITE_CACHE=/tmp/cand-vite npx vite --config src/candidates/schedule/vite.candidates.config.mjs
node src/candidates/schedule/shots.mjs                       # every candidate, bobble dark+light, all states
THEMES=claude-dark,codex-light STATES=default node src/candidates/schedule/shots.mjs
EMPTY=1 node src/candidates/schedule/shots.mjs               # the first-run screens
MODE=baseline node src/candidates/schedule/shots.mjs         # the shipping screens, for comparison
```

The probe is headless (tests/e2e/harness.mjs: hidden window, throwaway `$HOME`,
mock pi, and it fails if focus moved). Tasks are created through the real
`tasks:create` IPC; run records use the real `TaskRun` shape and are handed to
the real zustand store through a hook that exists only on this route.

## What all three share

- **The real data model.** `ScheduledTask` / `TaskRun` as they are; nothing was
  added to render these. State is *derived* (`derive.ts`): the same three facts
  the scheduler uses (`previousRun`, `lastRunAt`, the 6h grace) give a task one
  of `running / due / missed / scheduled / manual / paused / off`. This is the
  Up / Late / Down model Healthchecks.io uses for cron monitoring — it fits a
  local scheduler exactly, because a slot that passed while Bobble was closed is
  a real, derivable state, and the shipping screen never says it.
- **The honesty strip.** One line under the header with facts the app already
  holds: the run in flight and its measured time, the model phase and name from
  the llm store ("No model loaded — the first run loads it"), "runs one at a
  time, only while Bobble is open", "can read your Mac; cannot send anything"
  (that last one is `SCHEDULED_FORBIDDEN_TOOLS`, enforced at `tool_call`). This
  is the difference between a local product and a cloud one, said once.
- **Reach chips are real.** "Calendar · Mail · Reminders" on a task come from
  the tool trail of its runs, never from reading the prompt. A task that has
  not run shows only its folder. Guessed chips would be exactly the kind of
  fake certainty the brief rules out.
- **One editor** (`TaskEditor.tsx`), inline everywhere, never a modal. Its
  preview line says the *consequence* of saving: "Every day at 7:30 AM · first
  run Tomorrow 7:30 AM (in 6h)" — and, because `dueTasks` catches up a slot
  missed within six hours, "Today 7:30 AM already passed, so it runs **as soon
  as you save**". That is what the scheduler does today, silently.
- **Delete asks once, in place.** The button becomes the question ("Also
  deletes its past runs. Delete / Keep") and disarms after 4s. The shipping row
  deletes on one click and takes the history with it.
- **Runs as a ledger** (`RunLedger.tsx`): when, measured duration, the first
  sentence of the report; open to the full report, the files it left (image
  tiles), the tool trail. No percentage anywhere — the runner has none.

## 1 · Ledger — "a task is judged by what it left behind"

Mail-client anatomy: tasks on the left (status glyph, schedule, countdown),
the selected task on the right — contract, where it works, what it reached,
then its runs as a timeline. Under 720px the panes stack and a row pushes its
detail in with a back link. New/edit happen in the right pane; with nothing
selected or nothing scheduled, the pane is the template picker.

Taken from the refs: the Claude list-plus-detail (`12.01.27 AM`) — a prompt
shown in full on the right, "Runs in" as a fact. Rejected: their detail pane
lists *settings* (Repeat, At, Notifications) where ours lists *results*; their
"5 completed / 2 still open" hover card (`11.58.02 PM`) is a decorative ring
that reports nothing real and appears only on hover — the one thing on that
screen that could be mistaken for progress.

Researched: GitHub Actions' run list (status glyph · name · measured duration
per row) is the grammar of the ledger rows; Time Machine's menu, where "Latest
backup: …" is the single most useful line, is why the last run's headline sits
on the row instead of behind a button.

Tradeoff to flag: a permanent left column costs ~320px, so this needs the
content area, not a sheet; at 640px it becomes a two-step list.

## 2 · Agenda — "a schedule is a question about time on this Mac"

One column, grouped as a calendar app groups a day: Now / Today / Tomorrow /
This week / Later / Only when you run them / Paused. Every row leads with the
clock time and a countdown, carries a seven-day dot strip (which days it
fires — computed from the frequency, not drawn), and a missed slot is said in
words: "missed 4 Sep 6:30 PM — Bobble was not open". Rows expand in place to
the last report and a three-run ledger; hover reveals run / pause / edit /
delete as icons, the way sidebar rows do.

Creation is the ChatGPT sentence box (`12.03.38 AM`), but the deterministic
parser (`parseTaskDraft`) is shown *live* as chips while you type — "Weekdays
at 9:00 AM · first run Today 9:00 AM · 'summarise what changed…'" — so ↵ opens
an inline confirm card with nothing to discover. Rejected from that ref: the
"+" menu inside the composer that lists Slack / Figma / GitHub / Canva with a
"Connect" (`12.03.44 AM`) — a connector marketplace inside a task box is the
confusing cabinet the user named. Rejected from Claude's `New task ▾` → "Create
with Claude / Set up manually": two doors for one thing; a sentence that shows
its parse is both.

Researched: Healthchecks.io (Period + Grace → Up/Late/Down) for the state
model; Apple Shortcuts' iOS 17 "Run Immediately" (automations that just run,
with a per-automation notify switch) for the principle that unattended means
unattended — hence no "Permissions: Manually approve" row, which the Claude
modal (`11.58.21 PM`) shows and which is a contradiction for a run with nobody
present.

Tradeoff to flag: the week strip and hover icons are dense; the user's stated
dislike of fiddly chrome may apply. Both hide at narrow widths.

## 3 · Routines — "a task is a prompt with a clock"

One board. A task, a template and "new" are the same card: icon tile, name,
state pill, two lines of the prompt, schedule, next run, reach chips, last
result. Templates ("Start from") are ghost cards on the same grid with their
default schedule; the empty state is the same board with only ghosts. The
"New routine" card turns into the editor where it stands. A card opens a sheet
(opaque, per the app's overlay rule) with the contract, reach and ledger.
Filter: All / Active / Paused / By hand.

This is the candidate that answers the connectors/skills confusion most
directly: what a routine can reach is *on the routine*, from its runs, and
there is no other menu to visit. Taken from Claude's template grid
(`11.57.43 PM`): the icon tile + name + blurb + "Weekdays at 8:00 AM" card,
minus the wavy divider and the stopwatch illustration that pushes the useful
half of the screen below the fold. Rejected: ChatGPT's emoji glyphs (☀️📖🏷️) —
off the app's stroked icon set — and the shipping template cards' Unicode
glyphs for the same reason (`icons.tsx` here draws the missing ones in the
`packages/ui` recipe).

Tradeoff to flag: cards hide the run history one click away (the sheet), so
it is the weakest at "what happened this morning" — and a grid of nine cards
with chips is the busiest of the three.

## Which I would ship

**Ledger**, with the Agenda's composer-and-live-parse grafted above its list.
The run record is the only trace a scheduled task leaves (`scheduled-runner.ts`
runs in a throwaway session by design), and today it is behind a "Past runs"
button per row; a screen whose main pane *is* the ledger is the one that makes
the feature legible. The Agenda's honesty about time (due / missed / "as soon
as you save") should survive into it — its `derive.ts` already does.

## Proposed changes outside this directory (not applied)

- `apps/desktop/electron/scheduled/scheduled-contract.ts` — `TaskRun` cannot
  say whether a run was scheduled or started by hand:
  ```ts
  /** What started it: the clock, or a person pressing Run now. */
  readonly trigger?: 'schedule' | 'manual';
  ```
  With it, a run whose `startedAt` is well past its slot can honestly read "ran
  1h 42m late (caught up after sleep)"; without it a Run-now at 10:00 on a 7:30
  task would be mislabelled, so the candidates do not attempt it.
- `apps/desktop/src/scheduled/tasks-store.ts` — `create`/`update` apply the
  IPC response but a task created by anything else that writes the file (the
  `create_scheduled_task` tool, the probe) is only seen through `tasks:changed`,
  which is deliberately not sent for the app's own writes. Fine in the app; the
  candidates expose a `reload()` on the probe hook for it.

## Things I noticed

Blunt, as asked. File and line where I can.

1. **Delete has no confirmation and takes the history with it.**
   `src/scheduled/ScheduledView.tsx` ~L318 `onClick={() => void removeTask(task.id)}`
   → `electron/scheduled/scheduled-main.ts` `tasks:delete` → `deleteRunsForTask`.
   A red "Delete" text button on every row, one click, and a week of morning
   briefs is gone. Every candidate here uses a two-step in-place delete.
2. **A task for a time earlier today runs the moment you save it.**
   `electron/scheduled/schedule-logic.ts` `dueTasks`: `previousRun` is today's
   slot, `lastRunAt` is unset, and if the slot is within six hours it is due on
   the next 30s tick. Reasonable as catch-up after sleep; a surprise at
   creation. The dialog says nothing. (The candidates' editor says it out loud.)
3. **Three sibling screens, three navigation models.** Model hub and Scheduled
   render inside the chat shell (sidebar stays); Connectors is a full-window
   takeover with "Back to chat" (`src/App.tsx` ~L305 vs `src/connectors/ConnectorsScreen.tsx` ~L127).
   Same sidebar section, different behaviour per row.
4. **Three sibling screens, three CTA colours.** Model hub "Download" is accent
   blue, Connectors "Create" is inverted mono (`Button variant="primary"`),
   Scheduled "New task" is accent blue via bare Tailwind
   (`ScheduledView.tsx` ~L152 `bg-accent-primary`). The design DNA says primary
   = inverted mono, accent for accents. Pick one.
5. **Title scale drifts between siblings.** Scheduled's `<h1>` is `text-heading`
   (16px, `ScheduledView.tsx` ~L118); Model hub and Connectors use `text-title`
   (22px). Scheduled reads as a settings sub-panel next to them.
6. **The top bar keeps saying "New chat" on every content route.**
   `shots/current/scheduled-list-bobble-dark.png` — Scheduled and the Model hub
   both show "New chat" in the title bar. The content route should own the title.
7. **Template glyphs are Unicode characters** (`src/scheduled/templates.ts`
   `icon: '☀' | '⟲' | '✎' | '◷' | '✓' | '↑' | '⇢' | '◎' | '☰'`), rendered at
   text weight next to the app's 1.5-stroke icon set. They look like a
   different product. `icons.tsx` here has stroked replacements for all nine.
8. **The run drawer and the task dialog are hand-rolled surfaces.**
   `TaskDialog.tsx` builds its own `Picker` with `pd-menu` rows instead of the
   ui `Select`; its buttons are Tailwind spans, not `pd-btn`; the drawer
   (`TaskRuns.tsx`) is a plain `bg-bg-base` panel with a 1px border and no
   entrance motion while every other overlay in the app animates and uses the
   opaque-overlay recipe. Both read as older than the screens around them.
9. **"Scheduling off" is a pill that looks like a status, not a control.**
   `ScheduledView.tsx` ~L130: a rounded pill with a dot, `role="switch"`. The
   app has a Switch component with the documented 36×20 geometry; use it.
10. **Row actions are four text buttons on every row** ("Run now · Past runs ·
    Edit · Delete"), 32 buttons for 8 tasks, red on every line. The sidebar
    already teaches hover-revealed controls; the list should too.
11. **Unlayered CSS silently beats Tailwind utilities.** Not a Scheduled bug, a
    trap: any `.pd-*`/app rule that sets `margin` wins over `mt-*` on the same
    element regardless of specificity, because Tailwind v4's utilities are in
    `@layer`. I lost an hour to it here; `global.css` has 2,700 lines of
    unlayered rules that can do the same to anyone.
12. **The Scheduled quick input parses offline but tells you nothing until the
    dialog opens.** `parseTaskDraft` runs in microseconds; the shipping input
    waits for "Draft it" and then shows the result in a modal. The Agenda
    candidate shows the parse as you type — same function, no new code.
