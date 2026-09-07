# Scheduled tab — four candidates (round 4)

Rendered at `?candidates=schedule` (`PI_DESKTOP_CANDIDATES=schedule`), nothing
outside this directory changed. Every colour, radius and duration is a `--pd-*`
token; the shots in `shots/` are bobble dark + light for every state, the
Claude and Codex flavours at rest, 900 px and 640 px content widths in dark,
the first-run screens (`empty-*`), the screen touched by a hand (`*-ix-*`),
Ledger+ inside the app's own chrome (`ledger-plus-chrome-*`), the chat with a
task made in it (`chat-task-created-*`), and — new — the motion itself,
recorded (`shots/motion/`). Round two's critique of round one is
`CRITIQUE.md`; the round-three and round-four judgements are `JUDGEMENT-R3.md`
and `JUDGEMENT-R4.md`; this file is what was done about round four and what
is still not right.

To look at them yourself, from `apps/desktop`:

```sh
# a renderer-only dev server (PI_DEV_NO_LAUNCH=1 npx vite --port 5311 --strictPort works too)
CAND_VITE_CACHE=/tmp/cand-vite npx vite --config src/candidates/schedule/vite.candidates.config.mjs
node src/candidates/schedule/shots.mjs                        # every candidate, bobble dark+light, all states, flavours, 900 + 640
ONLY=ledger-plus THEMES=bobble-dark node src/candidates/schedule/shots.mjs   # one, fast
EMPTY=1 node src/candidates/schedule/shots.mjs                # the first-run screens
MODE=interactions node src/candidates/schedule/shots.mjs      # Ledger+ hovered, focused, typed into, swapped, deleted
EMPTY=1 MODE=interactions node src/candidates/schedule/shots.mjs
MODE=chrome node src/candidates/schedule/shots.mjs            # Ledger+ inside the sidebar and top bar
MODE=film node src/candidates/schedule/shots.mjs              # the motion, recorded at real speed (needs ImageMagick 7)
MODE=chat node src/candidates/schedule/shots.mjs              # a task made in the chat, as the shipping chat shows it
MODE=baseline node src/candidates/schedule/shots.mjs          # the shipping screens, for comparison
```

The probe is headless (tests/e2e/harness.mjs: hidden window, throwaway `$HOME`,
mock pi, and it fails if focus moved). Tasks are created through the real
`tasks:create` IPC and stamped through `tasks:update`; run records use the real
`TaskRun` shape (with `trigger`) and are handed to the real zustand store
through a hook that exists only on this route. The portrait run's picture is a
real PNG in the throwaway home, so the thumbnail is served by `pd-file://`
like a real artifact would be. Every image in `shots/` was rendered in one
sitting from the code as it stands; nothing in the folder predates the design
it sits beside.

## What changed since round three — the judgement's list, in its order

Every item names the shot that shows it. Coordinates are in the 1168-wide
shots.

1. **A running task cannot be stopped.** Proposed, not built — the same
   reason as round three: a Stop wired to nothing is the dead button with a
   worse name. `tasks:stop` is proposal 1 below; "Run now" already leaves the
   space a "Stop" would take.
2. **The list column moved when an editor opened** (y=225 idle, 192 after ↵,
   144 after New task). **Fixed, and asserted.** The composer's slot is one
   height in every state: the box is `--sc-box-height` (48 px) whether it is
   the composer or a strip, and the 34 px lane stays under both. "New task"
   and Edit no longer hide the composer; they fold it to a strip in its own
   footprint, like ↵ does — `New task — a blank form, or a sentence with a
   time in it · Write a sentence` (`ledger-plus-ix-new-*`), `New task, from
   the "Morning brief" card · Write a sentence` (`…-ix-template-picked-*`),
   `Editing "Morning brief" · Cancel` (`…-ix-edit-*`); the ↵ strip is as it
   was (`…-ix-enter-*`). The probe records the list head's y at eight
   moments — idle, typed, after ↵, after "Edit sentence", after "New task",
   after "Write a sentence", after Edit, after Cancel — and fails unless all
   eight are equal to the pixel; they are (y=201), and the same holds for the
   panes' top at 640 (`…-ix-enter-narrow-bobble-dark`). The first cut of this
   failed by one pixel: the composer's height fell out of its content (47)
   while the strip's minimum was 48. One number now.
3. **Nothing names the model.** Half done, as round three left it, but now
   pictured: with a model loaded, "Runs on" is its name and nothing else —
   `Runs on  Gemma 4 12B` (`ledger-plus-ix-model-loaded-*`) — and the
   editor's line says `runs on Gemma 4 12B` (`…-ix-model-loaded-editor-*`).
   The probe loads none (there is none in a throwaway home); the model is put
   in the llm store through the store's own `applyStatus`, the seam
   `llm:status` writes, so the screen reads what the app would read. What a
   past run used is still `TaskRun.model`, proposal 2.
4. **The empty screen with an editor open.** **Fixed, twice.** Under any open
   editor the templates say "Or start from one of these"
   (`empty-ledger-plus-new-*`, `empty-ledger-plus-ix-new-*`), with the strip
   above them where the composer was. And the form is blank: the editor is
   keyed by the draft (`Mode.seq`), so a new draft is a fresh editor, never
   the previous values under a new heading — the probe reads the prompt field
   after "New task" and fails if it is not empty. "New task" while a
   sentence-born editor is up does nothing (the button reads pressed); the
   probe's `new` state after `review` had taken a short cut the button does
   not have, and that was the pictured third thing. A template picked over the
   blank form fills it, for the same reason (`…-ix-template-picked-*`).
5. **Off rows kept the healthy glyph.** **Fixed.** While scheduling is off a
   row keeps its own glyph but loses its colour — the tick is the muted grey,
   not green, beside its "off" (`ledger-plus-off-*`, crop y 380→560 in dark
   and light). The amber "!" of the missed slot stays amber: it is missed and
   off, and off does not change the past. The running spinner stays.
6. **The template hover said "clickable", not what a click does.** **Fixed**,
   the reference's way: under the pointer (and under keyboard focus) the
   card's icon tile crossfades to a "+" in place — the click adds
   (`empty-ledger-plus-ix-template-hover-*`, the Morning brief tile at
   (55, 311); the probe reads the "+" face's opacity and fails below 0.9).
   The border and the 1 px lift stay. The reference's canned preview is not
   copied, as the judge said.
7. **Stale flavour shots.** **Fixed at the root.** The Claude and Codex
   flavours are shot in the same run as the bobble pair, under the same
   frozen clock, so the folder cannot again hold a flavour shot of an older
   design (`ledger-plus-default-claude-*`, `…-codex-*`: the current screen —
   spanning composer, magnifier, Reach block, "24s").

Score: five fixed, two proposed — the two the judge marked as shared changes.

## What the judge could not see, now pictured

- **Motion** (`shots/motion/`). `MODE=film` records the hidden window through
  CDP's screencast — real compositor frames with real timestamps, ~60 fps
  from a window that is never shown — and writes each clip as a GIF at the
  recorded speed plus a filmstrip of eight frames labelled with their
  millisecond offsets. Three clips per theme: ↵ (the composer folding to the
  strip), "Edit sentence" (the strip giving the composer back), and the pane
  swap (Morning brief → Portrait of the day). The film changed the design
  twice. The first strip showed the slot swap for what it was — the composer
  gone at one frame, an empty slot at the next, then the strip fading in from
  nothing: a pop, not the crossfade the code claimed. The slot's two faces are
  now both mounted in one grid cell and only their opacity moves, so the
  composer fades out as the strip fades in, one over the other, in
  `--pd-duration-base`; mid-fade the two lines of text overlap for two or
  three frames (`…edit-sentence…-strip` at 183 ms), which is what a crossfade
  of two texts in one place looks like, and the price of never showing a
  hole. The second strip caught the outgoing composer showing its
  *placeholder* through the fold, because ↵ cleared the text in the render
  that started the fade; the sentence now stays in the composer under the
  strip (Cancel brings it back untouched) and only saving clears it. The pane
  swap is what it was: the old pane leaves at once and the new one fades in
  with a 4 px rise, in under 180 ms. Read the strips; the GIFs are for the
  feel.
- **The named-model line**: item 3 above.
- **The guessed-name lead line**: a sentence long enough that `nameFrom` has
  to cut it — "every day at 8am, generate one portrait in the style of a
  1970s passport photo of a different animal" — opens an editor whose lead
  says "Read from your sentence. The name is its first words — change it if
  you like, then check the schedule." over the name "Generate one portrait in
  the style" (`ledger-plus-ix-enter-cut-*`).
- **The other two delete wordings**: "Deleting removes the task and its one
  run." on Sort my Downloads (`ledger-plus-ix-delete-one-run-*`) and
  "Deleting removes the task. It has no runs to lose." on What did I miss
  (`…-ix-delete-no-runs-*`). Taking the first of those also caught the pane's
  subtitle saying "Only when you run it · only when you run it" — the
  schedule line and the by-hand state are the same words — so a by-hand task's
  subtitle is now the schedule alone; the "By hand" pill under it is the
  state.
- **A task made in the chat** (`chat-task-created-*`). This is the shipping
  chat, unchanged, driven by a scripted pi turn (`fixtures/chat-task.json`)
  in which the model answers "Every Friday at 4pm, write up what I worked on
  this week." by calling `create_scheduled_task` with the tool's real
  argument shape and result text, then confirms in words. What the chat
  shows: a collapsed chain reading **"Used a tool"** (`chat-task-created-
  bobble-dark`, `-light`); opened, a generic step — puzzle glyph, "Create
  scheduled task  Weekly write-up", a "Done" tick (`…-open-…`); the step
  opened, the tool's raw sentence in monospace, clipped at the right
  (`…-step-…`). No card, no name-and-schedule, nothing to click through to
  the task. The reference's counterpart (`12.00.58 AM`) is a card with a
  clock tile, the name, "Weekdays at 9:00 AM" and Open. The tool has no
  entry in the chat's tool registry (`src/chat/activity-mapping.ts`), so it
  falls to the neutral fallback; that is proposal 7.
- **Ledger+ inside the app chrome** (`ledger-plus-chrome-*`: bobble dark and
  light at rest, typing, New task, and a 1172 px laptop window). The real
  shell — `ChatApp` with the candidate as its `contentOverride`, the seam
  `ScheduledView` rides in App.tsx (`chrome.tsx`) — so the sidebar has
  "Scheduled" selected and the top bar carries its "Scheduled" title, with
  the composer under it. The first shot of it showed a stutter no candidate
  shot could: the top bar's "Scheduled" and the page's own "Scheduled" h1,
  identical, 55 px apart. The app's convention, read off the shipping
  screens, is that the top bar carries the nav label and the h1 the screen's
  own name — "Model management" over "Model hub", "Scheduled" over
  "Scheduled tasks" — so all four candidates now say **Scheduled tasks**,
  which is also the reference's word. Every shot in the folder was re-rendered
  after the rename.

## What the interaction shots show (`shots/*-ix-*`)

Every state image is a still of a hidden window. These are the same window
driven by Playwright's mouse and keyboard, in bobble dark and light unless
named otherwise; the narrow ones are 640 px.

- `ledger-plus-ix-composer-focus` — the composer clicked, before a word: the
  1.5 px focus-border ring.
- `ledger-plus-ix-typing-1 / -2 / -3` — "every friday", then " at 4pm", then
  ", write up what I worked on this week": the chips changing in the lane,
  the page below pinned. `-3-narrow` is the same sentence at 640.
- `ledger-plus-ix-enter` — ↵: the editor, name whole, the composer folded to
  the sentence strip, "New task" demoted. `-enter-narrow` is the same at 640,
  with the panes' top asserted still.
- `ledger-plus-ix-enter-cut` — a sentence whose name had to be cut, and the
  lead line that says so.
- `ledger-plus-ix-strip-back` — "Edit sentence": the sentence back in the
  composer with focus, the previous task still selected. (Cancel does the
  same without the caret: the sentence was never cleared, only covered.)
- `ledger-plus-ix-new` — "New task": the strip in the composer's footprint,
  a blank form, "Or start from one of these" under it.
- `ledger-plus-ix-template-picked` — a card picked over the blank form: the
  form takes the card's values, the strip names the card.
- `ledger-plus-ix-edit` — Edit: `Editing "Morning brief"` with Cancel.
- `ledger-plus-ix-search-open / -typed` — the magnifier expanded in place,
  then "test" leaving one row.
- `ledger-plus-ix-row-hover` (and `-narrow`), `-row-focus` — a list row under
  the pointer, and one with the keyboard ring.
- `ledger-plus-ix-pane-swap-mid / -after` — the incoming pane caught 220 ms
  into a swap slowed to 1100 ms through the `--sc-pane-duration` seam, then
  settled. `shots/motion` has the same swap at real speed.
- `ledger-plus-ix-run-hover / -open` — a run row under the pointer, then
  opened, the first one closing.
- `ledger-plus-ix-delete-armed / -kept` (and `-armed-narrow`) — the two-step
  delete, and Keep. `-delete-one-run`, `-delete-no-runs` — the other two
  wordings of what deleting takes.
- `ledger-plus-ix-model-loaded / -model-loaded-editor` — "Runs on" and the
  editor's line with Gemma 4 12B loaded.
- `empty-ledger-plus-ix-composer-focus` — the empty screen with nothing
  clicked: the caret is in the composer.
- `empty-ledger-plus-ix-template-hover` — a template card under the pointer:
  the tile is a "+".
- `empty-ledger-plus-ix-typing` — the sentence typed on the empty screen: the
  chips in the lane, the templates unmoved.
- `empty-ledger-plus-ix-new`, `-template-picked` — "New task" on the empty
  screen (strip, blank form, "Or start from one of these"), then a card
  picked over it.

## Image hygiene

- **Time is frozen** in the renderer for a whole run (`shots.mjs`
  `freezeClock`), so every shot of a run holds the same data and the running
  run says "24s" in all of them. Main's clock cannot be frozen, so seeded
  tasks are stamped `lastRunAt` two hours ahead (`seed.mjs` `HOLD_MS`) and a
  slot that comes round during the shoot cannot fire.
- **Flavours are shot in the same run** as the bobble pair (item 7).
- **States are a function of the data** (`hook.ts`): an empty list announces
  no `running` and no `late`.
- **Motion is recorded, not staged**: the film's frames are the compositor's
  own, at its rate, with its timestamps; the only staging is which action is
  taken and how long the recorder waits after it. The filmstrip's labels are
  drawn with the first system font file that exists, because ImageMagick on
  this Mac has no default font configured and `-annotate` (and `montage`,
  even with nothing to letter) exits 1 without one.
- **One session**: every PNG and GIF in `shots/` was rendered after the last
  code change, by the probe as it stands. Where the film changed the code,
  the stills were shot again afterwards.

## What all four share

- **The real data model.** `ScheduledTask` / `TaskRun` as they are. State is
  *derived* (`derive.ts`) from the three facts the scheduler uses
  (`previousRun`, `lastRunAt`, the 6h grace): `running / due / missed /
  scheduled / manual / paused`, and `off` wrapping one of those when the
  feature switch is down.
- **Reach is real.** "Calendar · Mail · Reminders" come from the tool trail of
  a task's runs, never from reading the prompt.
- **One editor** (`TaskEditor.tsx`), inline everywhere, never a modal. Its
  preview says the consequence of saving — "first run Tomorrow 7:30 AM (in
  22h)", or "Today 7:30 AM already passed, so it runs **as soon as you
  save**" — and which model it runs on, when one is loaded.
- **Names a person would give** (`nameFrom`), and the editor says when it had
  to guess.
- **Delete asks once, in place** — "Delete for good?" — and disarms after 4 s.
- **Runs as a ledger** (`RunLedger.tsx`): when, measured duration, by hand /
  late, the first sentence; open to the report, the files, what it used.

## 1 · Ledger+ — the one to ship

`LedgerCandidate` with `plus`. The Ledger's page — tasks left, the selected
task's contract, reach and run history right — with two things grafted on:

- **The sentence box across the top**, under the title, in the chat
  composer's shape with its send circle, spanning the content. The
  deterministic parse shows as chips in the lane under it while you type;
  ↵ opens the editor in the pane, prefilled and named, with the name field
  focused, and the composer crossfades to the sentence it was read from.
  "New task" and Edit fold it the same way, to a strip that says what the
  pane is doing and offers the way back. The slot is one height in every
  case. Nothing is created until "Schedule it".
- **The list grouped by when** — Now / Today / Tomorrow / This week / Later /
  By hand / Paused — with a magnifier in its head. A scheduled row has no
  trailing word; only running ("24s"), due, missed, paused and off say
  anything on the right, and an off row's glyph goes grey with it.

The pane: tile, name, schedule line, Run now / Edit / the task's switch; the
state pill only when there is a state to say; the prompt; Reach as
label/value rows, "Runs on" naming the loaded model; the runs; and the
hairline / what deleting takes / Delete.

Empty: the list column is not drawn; the composer has the caret and the
templates take the width, sharing its left edge; a template's tile becomes a
"+" under the pointer. Under 720 px the panes stack, the list is the landing
screen, a row pushes its detail in with a back link (never on the empty
screen). States in `shots/`: `default`, `typing`, `review`, `running`,
`late`, `new`, `off`, `empty-…`, `…-mid`, `…-narrow`, the `ix-` set, the
`chrome-` set, and `motion/`.

Taken from the refs: Claude's list+detail anatomy (`12.01.27 AM`) and its
facts-under-the-text; ChatGPT's sentence box (`12.03.38 AM`) with its
always-there send circle and minus its "+" menu of connectors; Claude's
tile-to-"+" hover (`11.57.58 PM`) minus its canned preview. Rejected:
Claude's "New task ▾ → Create with Claude / Set up manually" (two doors; the
sentence with its parse is both) and its Permissions row (an unattended run
has nobody to ask).

## 2 · Ledger

The same page without the sentence box, rank-sorted with a coarse countdown
on the right and an "Add a task" row. Kept as the control: it is what Ledger+
is without the graft, one prop away. It inherits the pane, the magnifier and
the grey off-glyph.

## 3 · Agenda

One column grouped by day, the exact time in a left cell, the sentence box
first thing under the title, rows that expand in place to the reach chips,
the prompt and a three-run ledger. Best of the four under 700 px. Weakest at
reading a week of one task's history, which is the thing a scheduled task
is for.

## 4 · Routines

One board of cards — a task, a template and "new" are the same kind of thing —
each card leading with what its last run said, opening to a sheet with the
contract, reach and ledger. Still the busiest of the four and the only one
whose history is a click away. Its sheet's subtitle had the same by-hand
repetition as the Ledger pane; fixed the same way.

## What I rejected, and why

From the round-four judgement:

- *A Stop control now.* As before: hide the dead button rather than wire a
  live one to nothing. Proposal 1.
- *A small "Use" at the card's bottom-right* (item 6's alternative). The
  tile-to-"+" was the other half of the same item and is the reference's
  own gesture; a second control on a card that is already one button would
  have been two ways to say "add".
- *The reference's hover preview.* The judge said not to; the blurb says what
  the task produces, in words, without pretending to a picture the local app
  does not have.

Carried from earlier rounds (still standing): "↵ to check it" as the idle
lane's content; chips inside a box that grows; the exact `titleFrom` rule;
"chips only when they differ from the folder" (Routines); dropping the
"Scheduling on" switch; a `...` menu on Ledger+ rows; fewer when-groups.

## Still weaker than the refs, or than Bobble's own screens

- **A running task cannot be stopped from any surface.** Proposal 1.
- **A past run does not say which model ran it.** Proposal 2.
- **A task made in the chat is "Used a tool".** Pictured now, and it is the
  one place the reference is plainly ahead: a card with the name and the
  schedule that opens the task. Proposal 7.
- **The pane swap is a fade-in, not a crossfade.** The old pane leaves at
  once and the new one fades and rises in (`motion/…pane-swap…`). Keeping the
  old pane on screen while it fades would mean a ghost of a scrolling column;
  view transitions would do it in a line, but a hidden window's document is
  `hidden` and Chromium skips them there, so they cannot be photographed.
  It is the pattern most list/detail screens use; it is not a crossfade.
- **Two 22 px titles** ("Scheduled tasks" and the task name), and now the top
  bar's "Scheduled" above them in the chrome. The stutter is gone; the weight
  is not.
- **The idle lane is 34 px of nothing** under the composer. It is what keeps
  the page still.
- **A long first clause is still cut** — "Generate one portrait in the style".
  The editor says it guessed.
- **Hover on a list row is faint in light.** The app's sidebar rows use the
  same token.
- **Routines cards are still eight things in a box.**

## Proposed changes outside this directory (not applied)

1. **`tasks:stop`** — `electron/scheduled/scheduled-contract.ts`: add
   `'tasks:stop': { request: { id: string }; response: { ok: boolean } }` to
   `ScheduledInvokeMap` and `SCHEDULED_INVOKE_CHANNELS`.
   `scheduled-runner.ts`: `ScheduledRunner.stop(taskId)` — if `liveBridge`
   belongs to that task, `dispose()` it and finalise the record the way the
   timeout path does, with `status: 'error'` and `error: 'Stopped by hand'`
   (or a new `RunStatus` `'stopped'`, which the shipping drawer would need
   to learn); if the task is only queued, drop it from the queue.
   `scheduled-main.ts`: the handler. Then `LedgerCandidate` `Detail` turns
   "Run now" into "Stop" while running (the button's place is already
   reserved) and the run row's headline says "Stopped by hand".
2. **`TaskRun.model`** — `scheduled-contract.ts`: `readonly model?: { id:
   string; displayName: string }`, written by the runner at run start from
   the bridge it created (`createScheduledRunBridge` knows the model). Then
   the run row's meta can read "41s · Gemma 4 12B" and the Reach block's
   "Runs on" can name what the LAST run used as well as the next. Related:
   `ScheduledTask.modelId` exists in `normalizeTask` and nothing reads it —
   the runner ignores it — so either `createBridge` honours it or it goes.
3. **`titleFrom`** in `electron/scheduled/schedule-logic.ts` — adopt
   `derive.ts` `nameFrom`: a first clause of ≤ 9 words / ≤ 56 characters is
   kept whole; a longer one is cut at ` and / but / then / so / or ` when
   that leaves ≥ 3 words; otherwise the first seven words with dangling
   function words popped. The cases:

   | prompt | `titleFrom` (now) | `nameFrom` |
   | --- | --- | --- |
   | write up what I worked on this week | Write up what I worked on | Write up what I worked on this week |
   | summarise what changed in my working folder | Summarise what changed in my working | Summarise what changed in my working folder |
   | Run the test suite in my working folder. If… | Run the test suite in my | Run the test suite in my working folder |
   | Look at the git history in my working folder for the last 24 hours. | Look at the git history in | Look at the git history |
   | Search the web for anything new in the last day about llama.cpp releases and Metal backend changes. | Search the web for anything new | Search the web for anything new |
   | Check my working folder for outdated dependencies and known advisories. | Check my working folder for outdated | Check my working folder for outdated dependencies |
   | Generate one portrait in the style of a 1970s passport photo of a different animal each day, 1024×1024 | Generate one portrait in the style | Generate one portrait in the style |
   | Summarise my week: what changed in my working folder | Summarise my week: what changed in | Summarise my week |
   | please remind me to stretch | Please remind me to stretch | Remind me to stretch |

4. **`tasks:update`** (`scheduled-main.ts`) applies `createdAt` and
   `lastRunAt` from a patch although the contract says `Partial<TaskDraft>`.
   This probe relies on it (the aged task, the hold stamp); a renderer bug
   could rewrite a task's history stamp through it. Widen the type on purpose
   or strip the two keys.
5. **`src/scheduled/TaskRuns.tsx`** (the shipping drawer): `derive.ts`'s
   `lateBy` and `describeTrail` are pure and take the contract types; the
   drawer could say "by hand" and "1h 42m late" tomorrow.
6. **`src/scheduled/tasks-store.ts`** — a task created by something else that
   writes the file (the `create_scheduled_task` tool, the probe) is only seen
   through `tasks:changed`, which is deliberately not sent for the app's own
   writes. Fine in the app; the candidates expose a `reload()` on the probe
   hook for it.
7. **A card for a task made in the chat** — `src/chat/activity-mapping.ts`
   `TOOL_REGISTRY`: `create_scheduled_task: { kind: 'scheduled', label:
   ['Scheduling a task', 'Scheduled a task'] }` (a new `ActivityStepKind`
   with the clock glyph, or `tool` with a display name at the least, so the
   chain stops saying "Used a tool"). Then a step content for it built from
   the tool's result `details` — `{ ok, id, frequency }` today; add `name`,
   `hour`, `minute`, `weekday` to `ScheduleDetails` in
   `packages/harness/src/scheduled/schedule-tool.ts` so the row can read the
   name and "Every Friday at 4:00 PM" through `describeSchedule` — with an
   "Open" that navigates to Scheduled with that task selected (the
   `onOpenScheduled` callback ChatApp already takes). That is the
   reference's card, from real data, and closes the last axis it leads on.
8. **The tool's own sentence** — the same file's `when` string says "every
   week (day 5) at 16:00" to the person; `describeSchedule` would say "Every
   Friday at 4:00 PM". Since the model quotes the result back, the machine
   words reach the chat.

## Things I noticed

Blunt, as asked. Carried from earlier rounds where still true; the numbering
is the old one so the critique's references still resolve.

1. **Delete has no confirmation and takes the history with it** on the
   shipping screen (`ScheduledView.tsx` `onClick={() => void
   removeTask(task.id)}` → `tasks:delete` → `deleteRunsForTask`).
2. **A task for a time earlier today runs the moment you save it**
   (`schedule-logic.ts` `dueTasks`). The dialog says nothing. (The candidates'
   editor says it out loud.)
4. **Three sibling screens, two CTA colours.** Model hub "Download" is accent
   blue, Connectors "Add MCP server" is inverted mono, Scheduled "New task" is
   accent blue via bare Tailwind. The design DNA says primary = inverted mono.
7. **Template glyphs are Unicode characters** (`src/scheduled/templates.ts`).
   `icons.tsx` here has stroked replacements for all nine.
8. **The run drawer and the task dialog are hand-rolled surfaces**
   (`TaskDialog.tsx` builds its own `Picker`; `TaskRuns.tsx` is a plain panel
   with no entrance motion).
9. **"Scheduling on" is a pill that looks like a status, not a control** on
   the shipping screen. The app has a Switch component; use it.
10. **Row actions are four text buttons on every row** on the shipping screen.
11. **Unlayered CSS silently beats Tailwind utilities.** `global.css` has
    2,700 lines of unlayered rules; `candidates.css` is unlayered too, which is
    why no rule in it sets a margin a caller might tune with `mt-*`.
12. **The Scheduled quick input parses offline but tells you nothing until
    the dialog opens.**
13. **The real scheduler runs inside every probe.** Any e2e that creates
    tasks needs the hold stamp or it is testing the mock's canned reply; the
    frozen renderer clock is the other half.
14. **`tasks:update` takes `createdAt` and `lastRunAt` from the renderer**
    (proposal 4).
15. **`titleFrom` cuts at six words** regardless of phrase (proposal 3).
16. **The sibling screens disagree on section-heading scale.** Model hub
    `text-title`, Connectors `text-body`. I followed Connectors.
18. **The shipping "Past runs" drawer shows an artifact only as a tile in the
    open run.** `RunLedger.tsx` here puts it on the row.
19. **A `pd-file://` refusal is silent on the page.**
20. **The candidate shell's tab strip takes focus.** Clicking a tab is a
    click on a button; the probe does not click a tab that is already up.
21. **`ScheduledTask.modelId` is a dead field** — normalised, persisted,
    never read by the runner (proposal 2).
22. **`create_scheduled_task` is not in the chat's tool registry**
    (`activity-mapping.ts`), so the one tool that changes what the app does
    tomorrow renders as "Used a tool" (proposal 7). Its result sentence is in
    machine words (proposal 8).
23. **A hidden window paints at the compositor's full rate.** CDP
    `Page.startScreencast` on the probe's `show: false` window delivers
    ~60 frames a second with real timestamps and the focus guard green —
    which is what makes `MODE=film` possible, and what makes "it cannot be
    seen headless" untrue for motion as well as for stills. Two things do
    not hold in that window: `document.visibilityState` is `hidden` (the
    main window has no `backgroundThrottling: false`), so anything gated on
    visibility — view transitions, IntersectionObserver-driven work —
    will not run in a probe.
24. **ImageMagick here has no default font**, so `-annotate` and `montage`
    exit 1 unless a font file is named. `shots.mjs` names one.
25. **A screen's h1 should not repeat the top bar** — the Model hub and the
    shipping Scheduled screen both give the page its own name under the nav
    label; a candidate rendered without the chrome cannot see that it has
    broken the rule, which is one more reason to photograph inside the shell.
