# Scheduled tasks — design review

Written 2026-09-07 against the fourteen references in `~/Desktop/refs/schedule/`
and the two surfaces this repo has for the job:

- **The shipping screen** — `apps/desktop/src/scheduled/` (`ScheduledView.tsx`,
  `TaskDialog.tsx`, `TaskRuns.tsx`). What the user sees when he clicks *Scheduled*.
- **The candidate, Ledger+** — `apps/desktop/src/candidates/schedule/`
  (`LedgerCandidate.tsx` with `plus`, `Composer.tsx`, `TaskEditor.tsx`,
  `RunLedger.tsx`, `shared.tsx`, `derive.ts`, `candidates.css`). Behind
  `?candidates=schedule`; replaces nothing.

Both were **driven, not only looked at**: a headless probe
(`src/candidates/schedule/review-probe.mjs`, built on `tests/e2e/harness.mjs` —
hidden window, throwaway `$HOME`, mock pi, focus guard green on every run)
created, edited, ran, paused, deleted and resized tasks on the **built**
renderer (`dist/`, 13:16 today — the code the user runs), photographed every state
in bobble dark and light, filmed the transitions through CDP's screencast, and
dumped computed styles, boxes, tab orders and focus targets to `measure.json`.
Every frame cited below lives under
`apps/desktop/src/candidates/schedule/shots/review/` — written `R/` here — in
`ship/`, `ship-motion/`, `cand/`, `cand-empty/`, `cand-chrome/`, `cand-motion/`
and `chat/`. Numbers in the text are read from `R/<mode>/measure.json`, not
estimated. Re-run any mode from `apps/desktop` with
`MODE=<mode> node src/candidates/schedule/review-probe.mjs`.

The three earlier rounds' verdicts (`candidates/schedule/JUDGEMENT-R3.md`,
`JUDGEMENT-R4.md`, `NOTES.md`) were read as claims and re-tested; the last
section says where they were too generous and why.

---

## Verdicts, up front

**The shipping screen is not at parity with any of the references, and is not
close.** It is a working feature wearing an undesigned surface: the row tells
you nothing about whether the last run worked, a running task is a button
label, a missed week reads "in 2h", the dialog opens with the keyboard still
behind it, every transition is a hard cut, four text buttons and a red
*Delete* sit on every row, and at the app's own minimum window the task names
are five letters wide. the user's reaction is correct. The three rounds of design
work never touched it.

**Ledger+ is at parity with the references on the axes they cover and above
them on the one that matters most — what ran and whether it worked — and it is
the surface to ship.** It is *not* "above the references on every axis" as
round 4 said: it still has no Stop, no model, no card in the chat, its
composer is the loudest thing on the page and shows a default schedule as if
it had read one, its kill switch shoves the page down 46 px, and it carries a
handful of copy and hierarchy faults that a prominent company would not ship.
Fix the work order below and it is a screen to be proud of. The shipping
screen cannot be fixed into that; it should be replaced by Ledger+ and then
Ledger+ finished.

---

## The ideal, before looking

Written before opening a single reference image or a single line of either screen's code.

**What the surface is for.** A person opens Scheduled to answer two questions in under two seconds — *what is this app going to do on its own, and when?* and *did the last one work?* — and, less often, to set up a new recurring job or to stop one. Everything on the screen should be ranked by how often it answers those questions. The list is therefore sorted by next run, and every row carries, in this order of visual weight: the name, the schedule in human words ("Weekdays at 9:00"), the next run as a relative time that is honest ("in 2h 14m", "Tonight 22:00", "Paused"), and the last outcome as a small coloured mark plus a relative time ("ok · 3h ago", "failed · yesterday"). A row should be readable at a glance from across the room: one line of primary text, one quieter line, one mark.

**What the best version makes effortless.** Writing the schedule. Most products make you pick from a wall of dropdowns (frequency / day / hour / minute / timezone) and never tell you what you actually picked. The best version accepts what a person would say — "every weekday at 9", "first Monday of the month", "every 30 minutes" — echoes it back in plain words, shows the next three occurrences as real dates ("Mon 8 Sep 09:00 · Tue 9 Sep 09:00 · Wed 10 Sep 09:00") that update as you type, and offers raw cron *in the same field* for the person who wants it, not on a separate "advanced" page. Creating a task from a chat ("do this every Monday") should be one action that lands the user in the same dialog with the prompt already filled in. Seeing what a run produced should be one click, inline or in a side drawer, never a modal inside a modal.

**What would make someone screenshot it.** A calm ledger of tasks where each row has a tiny run history — a strip of small green/red ticks, one per past run, like a commit-status strip — so health is visible without reading a word; a "next run" that counts down live; a creation dialog whose schedule preview reads like a sentence a person wrote. Restraint is the thing: one accent colour, used only where it means something (running, failed), and otherwise ink on paper.

**The states nobody designs.**
- *Empty:* one sentence saying what this is and the one honest constraint of a local app ("Runs while Bobble is open"), then three or four templates that are real starting points — clicking one opens the dialog pre-filled, it does not just describe the idea. The empty state should not be a graveyard of grey illustration.
- *One task:* should not look lonely. The templates can stay visible under the single row as "more ideas", quieter than the row.
- *Hundreds:* grouping by status (running / due soon / paused / failing), a search field, keyboard navigation, bulk pause. Row height must stay constant so a long list scrolls like a list, not like a card gallery.
- *Running:* a live indicator with elapsed time, a way to open the live transcript, and a Stop that works. The running row is the loudest thing on the page while it runs, and goes quiet the moment it finishes.
- *Failed:* the row leads with the first line of the error in the failure colour, and "Run again" is one click away. Failure is never hidden behind a neutral grey dot.
- *Paused:* visibly dimmed, next-run replaced with "Paused", one click to resume.
- *Missed:* the app was closed when a run was due. The ideal says so ("Missed · Bobble was closed") and offers "Run now" — it does not pretend the run happened or silently drop it.
- *Half-configured:* a draft that was never saved is either not on the list or is marked as a draft; a task with an empty prompt cannot be saved and the dialog says why, next to the field.
- *Model not available:* a task bound to a model that is not downloaded says so on the row, before the run fails at 3am.

**Day 1 vs day 200.** Day 1 needs templates, natural-language scheduling, and reassurance about what the task can touch. Day 200 needs cron, editing the raw prompt, the run history with durations and token counts, filtering by failed, duplicating a task, and keyboard-first everything. Serve both by making the friendly path the default and revealing the raw path *in place* (a "cron" toggle inside the schedule field, an "advanced" disclosure inside the dialog), never a separate settings page.

**What a local-AI app must add that a cloud product need not.** Trust. The user is handing autonomy to a machine on their own disk, so the blast radius must be visible on the row or in the dialog: which model will run it, which working folder it can write into, whether it can use tools, and whether it will notify. The dialog should show these as facts with sensible defaults, not as a settings wall. "Runs while Bobble is open" should be stated once, plainly, where a new user will read it.

**Motion.** Dialogs fade-and-scale in under 200ms and never shift the list beneath them. A newly created task slides into its sorted position rather than appearing at the top and then jumping. A run's state change (idle → running → ok) is a colour crossfade on the mark, not a re-render that pops. Hover on a row is a quiet background lift; hover on a template reveals what it would do. Nothing bounces.

**Accessibility.** Every control reachable by Tab in reading order, focus rings visible and consistent with the rest of the app, the list navigable with arrow keys, status conveyed by text as well as colour, and the schedule preview readable by a screen reader as a sentence.

---

## The references (written before opening either screen)

Fourteen stills in `/Users/user/Desktop/refs/schedule/`, three products. Named here by product so the work order can cite them; the filename is given once per group.

### Claude.ai — Scheduled tasks, empty state (`11.57.43`, `11.57.58`, `11.58.02`, `11.58.07`)
- **The decision that carries it:** the empty state is not the point of the page; the template grid is. One serif display title, one grey sentence, an illustration that takes little emotional weight, a wavy hairline, and then six real starting points in two columns — icon tile / title / two-line description / clock + schedule in words. It reads as an editorial page, not a form.
- **The best idea in the whole set (`11.57.58`, zoomed in `11.58.02`):** hovering a template lifts the tile, swaps its icon to a **+** (so the hover *tells you the action*), and a little preview card slides up from the bottom-right corner showing what the task's *output* looks like ("5 completed · 2 still open" with a progress ring). Hover shows what you would *get*, not what you would configure. Nobody else in the set does this.
- **What it refuses to show:** no status dots, no next-run, no toggles on templates. Templates are not tasks; they are not dressed as tasks.
- **Where it is weak:** the stopwatch illustration is large and says nothing; "No scheduled tasks yet." floats dead centre with so much air that at laptop height the templates are below the fold. "Sort by Next run" on an empty list is noise. The templates are cloud-shaped (calendar, email, inbox) — meaningless for a fully-offline app; the *shape* is worth taking, the content is not.
- **`11.58.15` — the New task split menu:** "Create with Claude" / "Set up manually". Right: it admits there are two ways in and names them. Worth taking as a pattern for a local app where the "with the model" path costs a model load.

### Claude.ai — Create scheduled task modal (`11.58.21`, `11.58.29`, `11.58.35`)
- **Carries it:** the project picker and the model picker live *inside the frame of the Instructions field*, as a footer bar. The context of the run is visually attached to the instructions. That is the one composition idea worth stealing from this modal.
- **What it does at the moment of action:** Save is disabled (grey) until the required fields are filled. Cancel is a quiet grey button beside it.
- **Weak:** it is a form. Name / Instructions / Frequency / Permissions as label-plus-dropdown pairs. "Frequency: Manual" hides the entire scheduling problem behind one dropdown, and there is no readback of when the task will actually run and no next-run preview. Red asterisks. The textarea is tall and empty, so the modal is tall and empty. The backdrop blur is heavy. Competent and generic; nothing to screenshot.
- **`11.58.29` / `11.58.35`** — project and model pickers are the product's ordinary pickers reused verbatim (search, Pinned, Create new project, View all; flat model list with a checkmark). Reused primitives are why it feels consistent, not any decision made on this screen.

### Claude — creating and updating a task from a chat (`12.00.58`, `12.01.06`, `12.01.47`)
- **Carries it:** the assistant replies in a *sentence* that reads the whole schedule back — "will run every Monday–Friday at 9:00 AM Pacific, starting Wednesday, August 12" — then a compact card: clock tile / name / "Weekdays at 9:00 AM" / **Open**. The card is the list row's shape, reused. In `12.01.47` an edit made in chat ("I also updated the weekday automation…") re-emits the same card.
- **What it refuses to show:** no controls on the card beyond Open. Right for a chat.
- **Weak:** the card does not say *next run*, which is the one thing a person wants to know after creating it. The sentence does, so it survives — but only because the model happened to write it.

### Claude desktop — master-detail list (`12.01.27`)
- **Carries it:** one-line rows — status ring · name · "Weekdays at 9:00 AM · Next run in 18 hours" · ⋯ — and, in the *same list*, "Suggestions" and "From Plugins" sections beneath your tasks. So a list with one task does not look lonely, and the suggestion rows carry their schedule inline in grey next to the name. All / Active / Paused segmented filter plus a search field. Selecting a row fills a right-hand detail pane: instructions in a bordered box, "Details" (Runs in / Chat), "Frequency" (Repeat / At / Notifications). No modal to *see* a task.
- **Weak:** the suggestion list is enormous (twelve-plus rows) and every description truncates mid-sentence with an ellipsis; the colourful brand icons fight the monochrome rows; the empty status ring communicates nothing; the filter sits top-left competing with Create top-right; the detail pane is a settings pane, not a page. It is the most *functional* screen in the set and the least pleasant to look at.
- **Worth taking:** "· Next run in 18 hours" inline; suggestions living below real tasks in the same list; the master-detail pane for reading a task without a modal.

### ChatGPT — Scheduled (`12.03.38`, `12.03.44`)
- **Carries it:** the composer *is* the creation. "Schedule a task" in a big pill with a mic and a send arrow; describe what you want in words and that is the whole UI. Under it, "Recommended": emoji · title · one-line description · **+**, hairline-separated. Very few controls. The subtitle — "Ask ChatGPT to schedule tasks, set reminders, or monitor for updates." — is the best one-line pitch in the set.
- **Weak, and the owner is right to be suspicious of it:** emoji as icons look cheap against the monochrome UI; an "Active" filter pill on a screen with no tasks; the recommended rows *do not show a schedule* — "Every Saturday" is buried inside the sentence, and "Daily brief" never says when. `12.03.44` is the chat composer's generic **+** menu (Create image, Figma, Canva…) — almost none of it belongs on a scheduling screen. And as a *management* surface it has nowhere to go: with thirty tasks this design collapses.
- **Worth taking:** a single natural-language composer as the primary way in, *if* the readback is instant and honest — which for a local app means a deterministic parser, not a model round-trip.

### Exemplars not provided that I also held in mind
None were supplied for the parts of this surface that the three products above are weakest at — run history and recurrence editing — so I used, from memory rather than captures (I could not fetch pixel-accurate stills headlessly, so treat these as claims about well-known screens, not frames):
- **GitHub Actions — workflow runs list**: status icon + name + duration + relative time per row, and the per-workflow run history. The standard for "did the last one work, how long did it take".
- **Google Calendar — Custom recurrence dialog**: "Repeat every [1] [week] on [S M T W T F S] · Ends [never / on / after n]". The industry default for recurrence a person can read back.
- **Apple Shortcuts — Personal Automation trigger sheet**: "Time of Day · 9:00 AM · Weekdays" written as a sentence; the closest thing to a schedule that reads like speech.
- **Zapier — Zaps list**: a per-row on/off switch with last-run status; the cleanest pause/resume affordance in the category.

### The two or three ideas worth taking, across all of them
1. **Hover on a template shows the output, not the configuration** (Claude.ai `11.57.58`).
2. **Rows carry "schedule · next run in Nh" on one grey line, and suggestions live beneath real tasks in the same list** (Claude desktop `12.01.27`).
3. **The schedule is read back as a sentence with a real start date** (Claude chat `12.00.58`) — and, from the unprovided exemplars, **a run-history strip per row** (GitHub Actions) and **a Zapier-style switch** for pause.

---

## How the two surfaces were driven

Same probe, same seed (`seed.mjs`: nine tasks with a week of run records, one
failed run, one running, one caught up 1h 42m late, one aged a week without a
run, one by-hand task, one image artifact), same window sizes: **1440×868**
(the user's clamped default), **1172×800** (a 13" laptop), **900×700**, and
**760×560** (the app's `minWidth`/`minHeight`). The candidate was also shot
inside the real shell (`cand-chrome/`, sidebar + top bar) so its title stack
could be judged. One run on each surface was **real** — *Run now* on "Sort my
Downloads" through the mock pi — so the running→done transition is the app's
own. Bobble flavour throughout: type scale caption 12/16, footnote 13/18, body
14/20, heading 16/21, title 22/28; accent `#0a84ff` (dark) / `#0071e3` (light);
no purple anywhere on either surface, dark or light — checked in every frame.

Two things could not be exercised and are listed under *What I could not judge*.

---

## The work order — the shipping screen (`src/scheduled/`)

Ordered by impact, biggest first, grouped. Every item names the element, the
value now, the value wanted, and the frame it is visible in.

### A. Information architecture — what the row and the page are for

1. **The row does not say whether the last run worked.** Every row shows a
   green 10 px dot regardless of outcome: "Morning brief" has a failed run three
   days ago and is green; "What did I miss" has never run and is green
   (`R/ship/ship-many-bobble-dark.png`). The dot is a *pause toggle*, not a
   status, so the one colour on the page reports nothing. Ledger+ derives a
   glyph (check / alert / spinner / hand / pause) from the newest run and the
   task's state (`R/cand/cand-default-bobble-dark.png`). The ideal wants a
   strip of ticks. At minimum: the mark reflects the newest run's status and
   the toggle becomes a real Switch at the row's right end.

2. **A running task is a button label.** The only sign that "Portrait of the
   day" is running is *Run now* reading "Running…" at x≈1006
   (`R/ship/ship-many-running-bobble-dark.png`); the dot stays green, no
   spinner, no elapsed time, and the list does not rank it first. The ideal and
   the candidate both make the running row the loudest thing on the page
   (spinner glyph, "24s", grouped under *Now* — `R/cand/cand-running-bobble-dark.png`).

3. **A missed week reads as fine.** "What did I miss" was created eight days
   ago and has never run; the row says green dot · "Weekdays at 6:30 PM" ·
   "in 2h" (`measure.json ship:missed-task-next = "in 2h"`). Nothing on the
   shipping screen can say *missed* (the store has no derived state). Ledger+
   says "missed" in amber with an alert glyph (`R/cand/cand-default-bobble-dark.png`, row 3).

4. **"last ran 9/7/2026" is the wrong fact in the wrong format.** Every row's
   second line ends in `· last ran ${toLocaleDateString()}` — a numeric US date
   that could be July 9 (`R/ship/ship-many-bobble-light.png`). The reference
   row (`12.01.27`) says "Next run in 18 hours"; the ideal says "ok · 3h ago".
   Replace with the newest run's outcome and relative time ("ok · 3h ago",
   "failed · Wed"), and drop it entirely for a task that has not run.

5. **Past runs live behind a drawer that hides the deliverable.** The result of
   a task — the whole reason it exists — is two clicks away (*Past runs* →
   read) and the drawer opens on a blank page for a new task
   (`R/ship/ship-runs-drawer-empty-bobble-dark.png`). Round 3 was right that this
   is the axis where the references are weak and where Bobble can lead; the
   candidate's ledger-on-the-page is the answer. If the drawer stays as an
   interim, the row must carry the newest run's first line.

6. **Four text buttons on every row, ten times.** *Run now · Past runs · Edit ·
   Delete* on each of ten rows is forty buttons, ten of them red
   (`R/ship/ship-many-bobble-dark.png`). The references show one ⋯ per row
   (`12.01.27`) or nothing; the candidate puts the actions in the detail
   header, once. Replace with: primary action visible (Run now, or Stop while
   running), the rest in a ⋯ menu or in a detail pane.

7. **The templates vanish the moment one task exists**, leaving one row and
   680 px of nothing (`R/ship/ship-one-task-bobble-dark.png`). Claude desktop
   keeps *Suggestions* under the real rows (`12.01.27`); the ideal says a
   single task should not look lonely. Keep a quieter "Start another from…"
   row of templates under a short list, or a *New task* affordance in the
   list's tail.

8. **The whole feature is a modal-and-drawer pattern the references have
   moved away from.** Create/edit is a 620×500 modal
   (`R/ship/ship-dialog-new-bobble-dark.png`); reading a task is a 560 px
   drawer. Claude desktop reads a task in a pane, ChatGPT creates from a
   sentence. This is the structural reason the screen cannot be tuned into
   parity — it is the wrong shape — and the reason the recommendation is to
   replace it with Ledger+ rather than iterate.

9. **Two titles for one screen.** The top bar says "Scheduled", the h1 says
   "Scheduled tasks" 60 px below it (`R/ship/ship-empty-bobble-dark.png`, y=24
   and y=87). Round 4 accepted this as the app's convention (Model hub does
   it); it still reads as a stutter on a page this empty. Either the top-bar
   title carries the name and the h1 goes, or the h1 becomes the page's one
   title and the top bar shows the section.

10. **There is no way to stop a run.** No `tasks:stop` IPC exists; while a run
    holds the one local model slot the user can only wait (up to the 20-minute
    timeout in `scheduled-runner.ts`). Shared with the candidate; see *Shared*.

### B. Interaction and input

11. **The dialog opens with the keyboard left behind it.** Measured focus after
    opening: from ↵ in the quick input → `tasks-quick-input` (the input *under*
    the backdrop — its blue ring is visible through the dimming at y=165 in
    `R/ship/ship-dialog-from-sentence-bobble-dark.png`); from a template →
    `tasks-template-morning-brief`; from *New task* → `tasks-new`. Typing after
    opening goes into the page, not the form, and Tab starts from the wrong
    place. Use the app's `Dialog` (`packages/ui/src/components/dialog.tsx`,
    Radix — focus-trapped, returns focus on close) and autofocus the first
    empty field.

12. **Escape while a picker is open closes the whole dialog and loses the
    draft.** `TaskDialog` listens for Escape on `document`; with the *Hour*
    menu open (`R/ship/ship-dialog-hour-open-bobble-dark.png`) one Escape
    removed the dialog (`measure.json ship-dialog:escape-with-picker-open-closed-dialog = true`).
    Escape must close the innermost thing only.

13. **Focus drops to `BODY` when the dialog closes** — after Cancel, after
    Escape, and after Create (`ship-dialog:focus-after-close = "BODY"`,
    `ship-one-task:focus-after-create = "BODY"`). The next Tab starts from the
    top of the document (the sidebar). Return focus to the trigger, or to the
    new row.

14. **The sentence is wiped before it is confirmed.** ↵ in the quick input
    clears the input and opens the dialog; Cancel leaves both empty
    (`ship-dialog:quick-input-after-close = ""`). A person who cancels to fix
    one word has to retype the sentence. Keep the text until the task is
    created; the candidate keeps it under a strip and offers *Edit sentence*
    (`R/cand/cand-review-bobble-dark.png`).

15. **The quick input answers nothing until ↵.** Typing "every friday at 4pm,
    write up what I worked on this week" changes only the *Draft it* button's
    grey (`R/ship/ship-empty-quick-typed-bobble-dark.png`). The parser runs in
    microseconds (`parseTaskDraft`); show its reading live under the field —
    "Every Friday at 4:00 PM · first run Fri 4:00 PM" — as the candidate does
    (`R/cand/cand-typing-bobble-dark.png`).

16. **The name is cut mid-phrase, twice over.** From the sentence: "Write up
    what I worked on" (six words, `titleFrom`); from a typed prompt in the
    dialog: "Run the test suite and tell me only what" (a 40-character slice
    in `TaskDialog.save`) — and that becomes the row's name and the drawer's
    22 px title (`R/ship/ship-one-task-bobble-dark.png`,
    `R/ship/ship-runs-drawer-empty-bobble-dark.png`). Adopt `derive.ts
    nameFrom` (whole clause ≤ 9 words, else cut at a conjunction, never end on
    a dangling word) in `schedule-logic.ts` and use it in both places.

17. **Pausing a task throws it to the bottom of the list, instantly.** Click
    the dot on "Morning brief" (position 3) and the row lands 252 px lower, in
    a cut (`ship-pause:row-moved-by = 252`;
    `R/ship-motion/ship-film-pause-list-strip.png`, 226 ms). The person has to
    find the row they just touched. Either keep a paused row in place with its
    trailing "paused", or animate the move.

18. **The kill switch reshuffles and pushes the whole list.** Toggling
    *Scheduling on* inserts a 36 px note, moves the list down 52 px
    (`ship-off:list-moved-by = 52`), greys every dot, replaces every countdown
    with "—", **and re-orders the rows** — before:
    *What changed today, What did I miss, Morning brief…*; after: *Morning
    brief, Run the tests, What changed today…* (`ship-off:reordered = true`,
    `R/ship-motion/ship-film-off-strip.png`). Toggling back re-sorts again.
    Sort by the schedule the task *would* have, not by `nextRun(…, enabled)`,
    and reserve the note's height or put the note in the header.

19. **Arming Delete shoves its three neighbours 61 px left**
    (`ship-delete-arm:run-now-moved-by = -61`;
    `R/ship-motion/ship-film-delete-arm-strip.png`, 214 ms) because "Delete for
    good?" is wider than "Delete". Reserve the width, or arm in place with a
    second control (the candidate's "Delete for good? [Delete] [Keep]" grows
    leftwards into empty space — `R/cand-motion/cand-film-delete-arm-strip.png`).

20. **Hovering a row does nothing.** The row has no hover state
    (`R/ship/ship-many-row-hover-bobble-dark.png` is pixel-identical to the
    default; `measure.json ship-many-row-hover.row.bg = rgba(0,0,0,0)`); only
    the four buttons highlight individually. Every reference lifts the row
    (`12.01.27`). Give the row `bg-bg-hover` on hover.

21. **Hovering a template is imperceptible.** The card's background goes from
    `#1e1e21` to `rgba(255,255,255,0.06)` and nothing else changes
    (`R/ship-motion/ship-film-template-hover-strip.png`, 0→217 ms). The
    reference's hover swaps the icon to **+** and previews the output
    (`11.57.58`); the candidate does the **+** swap in 100 ms
    (`R/cand-motion/cand-film-template-hover-strip.png`). Do the swap.

22. **⌘↩ does not save the dialog** (`ship-dialog:cmd-enter-saves = false`).
    The candidate's editor saves on ⌘↩ and cancels on Escape from any field.
    Add both.

23. **Escape does not close the past-runs drawer** — only the backdrop click
    and ✕ do (`ship-drawer:escape-closes = false`; the probe had to fall back
    to ✕ every time). Add the key.

24. **The pause toggle is a 10 px target** (`measure.json ship-one-task.dot.box
    = 10×10`) with `aria-pressed` and no visible label. It is the only way to
    pause. Use the app's `Switch` (`packages/ui/src/components/controls.tsx`)
    or a menu item.

25. **The "Draft it" button reads as disabled even when it is not.** Idle it is
    `bg-bg-inset` muted text; with text it becomes `bg-bg-active` — a slightly
    lighter grey (`R/ship/ship-empty-quick-typed-bobble-dark.png`). There is no
    moment at which it looks like the thing to press. Make the typed state
    primary, or replace the button with the send circle the chat composer
    already uses.

26. **Tab order leaves the page after the templates.** From the last template
    card the next stop is `collapse-sidebar` (`measure.json tab-order:ship-empty`);
    the list rows' controls come after the header pill only by wrapping. Fine
    for a document, wrong for a screen — keep the screen's controls contiguous.

### C. Layout and density

27. **At the app's own minimum window the names are five letters wide.** At
    760×560 the row keeps all four buttons at full width (180 px) and truncates
    the name to "What c…", "Mornin…", "Portr…" and the schedule to "Weekda…"
    (`R/ship/ship-many-minimum-bobble-dark.png`); at 900×700 the schedule line
    already truncates "last ra…" (`R/ship/ship-many-small-bobble-dark.png`).
    The name must win over the actions at every width — which item 6 solves.

28. **Rows are 63 px for two lines of 14/13 px text** with the actions
    vertically centred in a lot of air (`measure.json ship-many.row.h = 63`).
    Claude desktop's rows are ~56 px; the candidate's are 58. Take the row to
    52–56 px (padding 10 px, not 12).

29. **The drawer has no edge.** It is `bg-bg-base` (#151517) with a 1 px
    `border-border-subtle` — the same colour as the page it covers — so it
    reads as the page being cut, not as a panel arriving
    (`R/ship/ship-runs-drawer-week-bobble-dark.png`). Use the app's overlay
    surface (`--pd-bg-overlay` composited on raised, `--pd-shadow-lg`) as the
    candidate's Routines sheet does (`candidates.css .sc-sheet`).

30. **The dialog's textarea is 118 px of nothing** for a task created from a
    template it is *full and scrolling* (`R/ship/ship-dialog-template-bobble-dark.png`
    shows a scrollbar inside the field) and for a typed sentence it is
    three-quarters empty. Auto-grow between 3 and 10 lines (the ui
    `TextArea autoGrow` the candidate uses).

31. **The schedule preview floats right on the pickers' row** ("Every Friday
    at 4:00 PM" at x=864, muted 13 px) and *wraps under the pickers* when the
    weekday picker appears (`R/ship/ship-dialog-weekly-bobble-dark.png`, y=556
    vs y=536 in `…-new-…`). It is the most important line in the dialog. Give
    it its own line under the pickers, primary weight, with the first run
    ("first run Fri 4:00 PM (in 4 days)") as the candidate does.

32. **The template grid orphans its ninth card** — two columns, nine cards,
    "Weekly review" alone on the last row (`R/ship/ship-empty-bobble-dark.png`).
    Three columns at ≥1000 px (the candidate: `R/cand-empty/cand-empty-bobble-dark.png`),
    or eight templates.

33. **The content column is capped at 900 px and centred**, so at 1440 the
    list sits 134 px in from each side with the actions crammed at the right
    edge of a narrow box (`measure.json ship-empty.container.w = 900`). A
    list-and-detail layout wants the width; the candidate uses it.

### D. Typography

34. **Name and schedule are the same size.** Row name 14/20 regular
    `text-primary`; schedule 13/18 muted — one pixel and a colour apart
    (`measure.json ship-many.name.font = 14px/20px 400`, `meta = 13px/18px 400`).
    The reference and the candidate set the name a weight up (500). Make the
    name `font-medium`.

35. **Template icons are Unicode characters** (☀ ⟲ ✎ ◷ ✓ ↑ ⇢ ◎ ☰) rendered at
    13 px in the muted colour, each a different weight and optical size
    (`R/ship/ship-empty-bobble-dark.png`). The app has stroked icons
    (`@pi-desktop/ui`), and `candidates/schedule/icons.tsx` already has all
    nine replacements in 32 px tiles (`R/cand-empty/cand-empty-bobble-dark.png`).

36. **The h1 is 22 px regular (400)** where the candidate and the Model hub use
    medium (500) (`measure.json ship-empty.h1.font = 22px/28px 400` vs
    `cand-default.h1.font = 22px/28px 500`). Match the siblings.

37. **The drawer's title truncates the task name** at 22 px ("Run the test
    suite and tell me only what" fills the header, `R/ship/ship-runs-drawer-empty-bobble-dark.png`)
    with "Past runs" as a 12 px caption under it. Reverse the hierarchy: "Past
    runs" is the drawer's name, the task is the subtitle — or drop the caption
    and let the title wrap to two lines.

38. **Tool trails are raw identifiers on a user-facing card** —
    "calendar_list_events · mail_recent · reminders_list", "generate_image ·
    write" in 12 px muted (`R/ship/ship-runs-drawer-week-bobble-dark.png`).
    `derive.ts describeTrail` maps them to "Calendar · Mail · Reminders".

### E. Colour and depth

39. **"New task" is accent blue; the app's primary is inverted mono.**
    Connectors' *Add MCP server* and every `pd-btn--primary` are text-primary
    on raised (`packages/ui/src/styles/button.css:90`); this screen's *New
    task*, *Create task*, *Save* and the drawer's *Run now* are `bg-accent-primary`
    via bare Tailwind (`R/ship/ship-empty-bobble-dark.png`,
    `R/ship/ship-dialog-edit-bobble-dark.png`). Use `Button variant="primary"`.

40. **Ten red "Delete"s.** `text-status-danger-fg` (#ff6961) on every row is
    the loudest colour on the page and the least wanted action
    (`R/ship/ship-many-bobble-dark.png`). Danger colour belongs on the *armed*
    state only (the candidate: muted "Delete", red only after "Delete for
    good?" — `R/cand/cand-delete-armed-bobble-dark.png`).

41. **"Scheduling on" looks like a status badge, not a control.** A pill with
    a green dot and hairline border (`measure.json ship-empty.schedulingPill`),
    `role=switch` in the markup but nothing switch-like in the pixels
    (`R/ship/ship-empty-bobble-dark.png`). Use `Switch` with a label
    (`R/cand/cand-default-bobble-dark.png`).

42. **The dialog's "Active" toggle is a tinted pill** — `accent/10` fill,
    `accent/40` border, green dot — the only accent-tinted control on the
    surface, for a setting nobody changes at creation
    (`R/ship/ship-dialog-new-bobble-dark.png`). Remove it from the create
    dialog (pause lives on the task); on Edit make it a Switch.

43. **The running run's dot is orange** (`bg-status-warning-fg`,
    `R/ship/ship-runs-drawer-running-artifact-bobble-dark.png`) — warning
    colour for a healthy in-flight run. Running is accent (`--pd-accent-primary`),
    as the candidate's pill and glyph have it.

### F. Motion and state transitions

44. **Every transition is a cut.** Dialog open (`R/ship-motion/ship-film-dialog-open-strip.png`,
    fully present at 219 ms with no intermediate frame), dialog close (192 ms),
    create (`…-create-strip.png`: dialog gone and row present in one frame),
    drawer open and close (`…-drawer-open-strip.png` 212 ms,
    `…-drawer-close-strip.png` 216 ms — no slide, backdrop fully dark at once),
    pause (item 17), kill switch (item 18), delete arm (item 19). The app owns
    a dialog recipe with `--pd-duration-dialog-in: 250ms` / `-out: 125ms`
    (`packages/ui/src/styles/dialog.css`) and the candidate crossfades at
    `--pd-duration-base` (150 ms). Use them: dialog fade+scale, drawer slide
    from the right, list rows `transition: background-color`, and either
    animate re-orders or stop re-ordering (items 17–18).

45. **The running state is a blink.** The real run's label swapped to
    "Running…" at 318 ms and back at 423 ms
    (`R/ship-motion/ship-film-run-now-strip.png`); nothing else on the row
    moved. Even a long run would show only that word. See items 2 and 43.

### G. Copy

46. **The hint under the prompt is untrue.** "Runs as a normal chat, with
    your tools and working folder, so it can read, write and run things."
    (`R/ship/ship-dialog-new-bobble-dark.png`). `scheduled-runner.ts` runs a
    headless, sessionless bridge — no chat is created, and the drawer's own
    empty message says "Results appear here, not in a chat." Say what happens:
    "Runs on its own, with your tools and working folder. The report lands
    under Past runs, not in a chat."

47. **"Named from the instruction if you leave this blank"** is a placeholder
    that describes the code, not the result. The candidate shows the *actual*
    name it would use as the placeholder (`nameFrom(prompt)` —
    `R/cand/cand-edit-bobble-dark.png`). Do that.

48. **"Draft it"** names a mechanism. ChatGPT's box has a send arrow, the
    candidate a send circle. Either the circle, or a verb about the outcome
    ("Set it up").

49. **"—" for a by-hand task's next run** (`R/ship/ship-many-bobble-dark.png`,
    last row). Say "by hand".

50. **"No runs yet. Use “Run now” to try it. Results appear here, not in a
    chat."** — three sentences where one does the job, and the quotation marks
    are curly while the button is not quoted anywhere else. "No runs yet — Run
    now to try it."

51. **The subtitle** "Work Bobble does on its own, on a schedule or on demand."
    is fine; the candidate's "…while it is open — what ran, and what runs
    next." states the local constraint the ideal wants stated once. Adopt it.

52. **"Delete for good?" as a red pill on the row** with no *Keep* means the
    disarm is moving the mouse — invisible. The candidate says the cost
    ("Deleting removes the task and its 5 runs.") and offers Keep. Adopt.

### H. Failure and edge states

53. **A failed run is invisible outside the drawer** (items 1, 4). The drawer
    itself does the failure well: red dot, the runner's real error in red,
    which permission to grant (`R/ship/ship-runs-drawer-week-bobble-dark.png`).
    Keep the drawer card's error treatment when the row learns to lead with it.

54. **A task whose slot passed today runs the moment it is saved** (`dueTasks`
    catches up within six hours) and the dialog says nothing
    (`R/ship/ship-dialog-new-bobble-dark.png`: "Every day at 9:00 AM" at 4 pm).
    The candidate's consequence line — "Today 9:00 AM already passed, so it
    runs **as soon as you save**" (`R/cand-empty/…`, prior round
    `shots/ledger-plus-new-bobble-dark.png`) — is the fix.

55. **Nothing says what runs it.** No model, no "none loaded yet", nowhere.
    Shared with the candidate; see *Shared*.

56. **The artifact tile is right** — a 158×128 thumbnail, its filename, click
    to open (`R/ship/ship-runs-drawer-running-artifact-bobble-dark.png`). It
    is the one thing in the drawer to keep as is; it just belongs nearer the
    row.

### I. Accessibility

57. Focus management is the largest a11y fault on the surface (items 11–13,
    23, 26). The rest: the dot toggle's 10 px target and `aria-pressed` on a
    thing that looks like a status (item 24); group/section structure absent
    (the list is a `div` of `div`s — no `list`/`listitem` roles, no headings
    for the two halves of the page); the row's four buttons are unlabelled
    beyond their text, which is fine, but "Running…" is a disabled-looking
    button that is still enabled and re-queues a run if clicked
    (`ScheduledView.tsx:303`).

---

## The work order — Ledger+ (`src/candidates/schedule/`)

Same rules. Where an item was an earlier round's claim, what the probe found
is said.

### A. Information architecture

1. **A running task cannot be stopped.** Confirmed: no `tasks:stop`; while
   "Portrait of the day" runs the header shows Edit and the switch and
   nothing that stops (`R/cand/cand-running-bobble-dark.png`). For a local app
   that holds one model slot this is the missing control. Shared; see below.

2. **Nothing names the model, and it cannot be chosen.** "Runs on — whichever
   model Bobble loads first — none is loaded yet" on every task in every probe
   frame (`R/cand/cand-default-bobble-dark.png`, y=554); with one loaded it
   reads "Gemma 4 12B" (prior round `shots/ledger-plus-ix-model-loaded-bobble-dark.png`).
   Runs carry no model. `ScheduledTask.modelId` exists unread. Shared.

3. **The composer is the loudest element on the page.** 1120×48 px, raised,
   hairline plus shadow, a 16 px placeholder — the largest text on the page
   after the two 22 px titles — and 82 px of vertical chrome (box + 34 px lane)
   before any content (`R/cand-chrome/cand-chrome-bobble-dark.png`;
   `measure.json cand-default.composer`, `.composerInput.font = 16px/21px`).
   On a page whose argument is "the run history is the page", the door is
   bigger than the room. Take the input to body size (14 px), the box to
   40 px, and fold the lane's 34 px into the box (chips appear *inside* it,
   under the text, the way the chat composer's ledge does) — the round-4
   stillness measurement still holds if the box grows by a fixed 28 px only
   while there is text.

4. **The parse shows a default as if it had read one.** With "eve" typed the
   lane says "Every day at 9:00 AM · first run Tomorrow 9:00 AM · “eve”"
   (`R/cand-motion/cand-film-typing-strip.png`, 208 ms). Nothing in "eve" says
   daily or 9 AM; the chip presents the parser's fallback with the same
   confidence as a real reading. Until a time word is recognised, the lane
   should say what it is waiting for ("Add a time — “at 9am”, “every Friday”")
   and show the schedule chip only once one is found; and ↵ on a sentence with
   no time should open the editor with the frequency control *highlighted*,
   not silently filed as daily 9 AM.

5. **Two 22 px titles and a top-bar label.** Inside the shell: "Scheduled"
   (top bar, 14 px), "Scheduled tasks" (22 px, y=79), "Morning brief" (22 px,
   y=242) (`R/cand-chrome/cand-chrome-bobble-dark.png`). Rounds 3 and 4 filed
   this under *not worth fixing* citing the Model hub; with the composer
   between them it is the heaviest top-third of any screen in the app. Take
   the task name to heading (16/21, 500) with the tile at 32 px, or drop the
   page h1 in favour of the top-bar title (shared decision with item A9 of the
   shipping list).

6. **A task made in the chat is "Used a tool".** Confirmed against the
   shipping chat: the turn reads "I'll set that up as a task that runs on its
   own." → *Used a tool* (collapsed) → "Done — “Weekly write-up” runs every
   Friday at 4:00 PM… It is in Scheduled, where you can edit, pause or delete
   it." (`R/chat/chat-task-created-bobble-dark.png`, `…-open-…`). No card, no
   link, nothing to click to reach the task. The reference's card
   (`12.00.58`, `12.01.06`) is the one place it is plainly ahead. Shared:
   `activity-mapping.ts` registry entry + a step content with name, schedule
   and *Open*.

7. **The missed state names the problem and offers nothing.** "What did I miss
   · missed" in amber, and in the pane "Missed · missed Yesterday 6:30 PM ·
   next Today 6:30 PM" (`R/cand/cand-default-bobble-dark.png`). The ideal says
   *Run now* belongs beside the word. The header already has Run now; make the
   pill itself say "Missed yesterday — run now?" or put a small *Run now* in
   the row's trailing slot for missed tasks only.

8. **The run count aside and the section title compete.** "Runs 5" (14 px
   regular, count muted) and "4 ok · 1 failed" (12 px, right) say the same
   thing twice in two places (`R/cand/cand-default-bobble-dark.png`, y=597).
   One fact: "Runs · 4 ok · 1 failed" on the left, or the count only.

9. **The list groups "Now / Today / Tomorrow / This week / By hand / Paused"
   but sorts a running task's group by name**, so a *due* task and a *running*
   task under *Now* have no order between them other than alphabetical
   (`LedgerCandidate.tsx rank()` then `sortKey` returns 0 for both). Running
   first, then due by slot.

### B. Interaction and input

10. **The kill switch shoves the panes down 46 px.** Toggling *Scheduling on*
    inserts the amber `OffNotice` between the composer and the panes with no
    reserved height and no transition (`cand-off:panes-moved-by = 46`;
    `R/cand-motion/cand-film-switch-off-strip.png`, 139 ms). The same class of
    fault the candidate fixed for its own composer slot (round-4 item 2).
    Reserve the notice's height in the header row (put it where the subtitle
    is — the subtitle already changes to "scheduling is off"), or animate the
    height.

11. **Focus is lost after "Schedule it"** — `cand-after-save:focused = BODY`
    (`R/cand/cand-after-save-bobble-dark.png`). The new task is selected in the
    list; focus should land on its row (so ↓/↑ continue) or on the pane's
    title.

12. **Escape in the search leaves the filter applied.** With "test" typed the
    list shows one row (`R/cand/cand-search-typed-bobble-dark.png`); after
    Escape the list *still* had one row (`cand-search:escape-cleared = 1`). If
    the field collapsed with the query kept inside it, the person is looking at
    a filtered list with no visible filter. Escape clears, then collapses.

13. **"New task" while a sentence-born editor is open does nothing** (by
    design, `aria-pressed`; the button turns secondary grey —
    `R/cand/cand-review-bobble-dark.png`, x=1051). A pressed-looking button that
    ignores clicks is a dead control with a reason. Either it starts a blank
    draft (the strip already explains provenance) or it hides.

14. **The delete footer is at the very end of a pane that scrolls**, so on a
    task with five runs the person scrolls past the ledger to find it
    (`R/cand/cand-delete-armed-bobble-dark.png` — the header is cut off at the
    top because the probe had to scroll to the bottom). That is arguably
    correct (destructive last), but the Edit menu is the other natural home;
    at minimum keep it, and do not let the ledger grow unbounded — the
    `KEEP_RUNS_PER_TASK = 20` cap makes this a 20-row scroll.

15. **A run row's whole head is a button that toggles**, and the *Delete run*
    link inside an open run sits at the far right of a 700 px line, 10 px
    from the run's "used …" trail (`R/cand/cand-default-bobble-dark.png`,
    y=742). Fine on a mouse; on keyboard the tab order goes head → *Delete
    run* → next head, which is right. Only the wording: "Delete run" beside a
    run that is the newest and only evidence the task works should be a
    muted ⋯ or hidden until hover.

16. **The composer takes focus on the empty screen** by design, with the ring
    at rest (`R/cand-empty/cand-empty-bobble-dark.png`). Correct for the first
    visit; on every later visit to an empty list it means Tab starts mid-page
    and a screen reader is dropped into an input. Focus it on the *first*
    visit only (a settings flag), or focus the page.

### C. Layout and density

17. **The list column truncates real names.** At 280 px, "Write up what I
    worked on this week" becomes "Write up what I worked on th…"
    (`R/cand/cand-after-save-bobble-dark.png`); at 640 stacked it is
    "Write up what I worked on this …" in the pane title too
    (`R/cand-empty/cand-one-task-narrow-bobble-dark.png`). Two-line names in
    the list (clamp 2) cost 18 px per long row and end the problem; the
    sentence-born names are exactly the ones that are long.

18. **The pane is capped at 780 px and centred**, so at 1440 inside the shell
    the detail sits between 580 and 1360 with 150 px of empty base on each
    side of the reading column and the actions (Run now / Edit / switch) far
    from the list (`R/cand-chrome/cand-chrome-bobble-dark.png`). Cap the *text*
    (prompt, run bodies) at 780 and let the header and the ledger's rail use
    the pane.

19. **The header wraps at 900 px wide inside the shell**: "Scheduling on" +
    switch and "+ New task" drop under the title as a second row
    (`R/cand-chrome/cand-chrome-small-bobble-dark.png`, y=137). Acceptable, but
    the subtitle then wraps to two lines above them at 760
    (`…-minimum-…`, y=103–121) and the composer starts at y=180. Shorten the
    subtitle (item G3) and let the switch drop its label first.

20. **The narrow (< 720 px) layout works** — list as landing, detail pushed in
    with "‹ All tasks" (`R/cand/cand-detail-narrow-bobble-dark.png`). One
    fault: the back link is 13 px muted text with a 14 px chevron sitting
    12 px above a 22 px title; make it the app's ghost button.

### D. Typography

21. **Section titles are body-regular (14/20, 400)** — "Reach", "Runs" — one
    step below the run rows' 13 px *medium* dates, so the sections' headings
    are lighter than their contents (`measure.json cand-default.section.font =
    14px/20px 400`, `runWhen.font = 13px/18px 500`). Connectors' convention
    was followed to the letter; here it inverts the hierarchy. 14/20 medium.

22. **"Weekdays at 7:30 AM · next Tomorrow 7:30 AM"** — a capital in the
    middle of a sentence, and the word *next* doing the job the group label
    ("Tomorrow") already did (`R/cand/cand-default-bobble-dark.png`, y=259).
    Round 3 kept it for the narrow layout, where the pane stands alone. Keep
    it, lower-case the moment ("next tomorrow 7:30 AM") or use the delta
    ("next in 15h").

23. **The Reach block's third value is a sentence** ("whichever model Bobble
    loads first — none is loaded yet", 13 px, 341 px wide) under two short
    facts (`R/cand/cand-default-bobble-dark.png`, y=554). Facts want values.
    "None loaded yet" and, on hover or as a footnote, the explanation.

24. **Group labels are 12 px muted with 12 px of padding above** so "Today" and
    "Tomorrow" read as part of the row above them, not as the head of the
    group below (`R/cand/cand-default-bobble-dark.png`, y=340 vs the row at
    y=371). 16 px above, 4 below, and one weight up (500) at 12 px — the
    sidebar's own group labels are the precedent.

### E. Colour and depth

25. **The selected row and the hovered row are two greys 3 % apart**
    (`bg-selected #ffffff17` vs `bg-hover #ffffff0f`) and neither has an edge
    (`R/cand/cand-row-hover-bobble-dark.png`). Fine in dark, faint in light
    (round 4 agreed and let it stand because the sidebar does the same). The
    sidebar is a navigation list; this is a selection that drives a pane. Give
    the selected row a 2 px accent bar at its left edge, or the accent-subtle
    fill.

26. **The "By hand" pill is grey-on-grey** (`sc-pill` with no tone,
    `R/cand/cand-run-now-done-bobble-dark.png`, y=290) and says what the
    schedule line under it already says ("Only when you run it"). Drop the
    pill for by-hand tasks; the hand glyph and the line are enough.

### F. Motion and state transitions

27. **The pane swap cuts the old pane and fades the new one in** (67 → 111 →
    184 ms, `R/cand-motion/cand-film-pane-swap-strip.png`). Round 4 called it a
    crossfade; it is a fade-in after a cut, and at 150 ms it reads as a
    flicker when the two panes share a layout (same header, same "Reach",
    same "Runs"). Either keep the outgoing pane for one frame at opacity 1
    under the incoming one (the slot's own two-layer trick) or drop the fade
    and move only the *differences* — the title crossfades, the body swaps.

28. **The Enter fold is good** — composer → strip crossfade with the pane
    fading in behind it, settled by 368 ms
    (`R/cand-motion/cand-film-enter-strip.png`); *Edit sentence* returns the
    caret and the chips in ~70 ms (`…-edit-sentence-strip.png`). Keep.

29. **The template tile's icon→+ swap is 100 ms after a ~200 ms hover delay**
    (`R/cand-motion/cand-film-template-hover-strip.png`, 232 → 270 ms) — the
    lift is 1 px, the border lightens. Keep; consider the border going to
    `border-strong` a shade earlier so the card responds before the icon does.

30. **The kill-switch banner appears at once with no fade** (item B10).

### G. Copy

31. **"Read from your sentence. Check the name and the schedule, then put it
    on the calendar."** — there is no calendar; the button says "Schedule it"
    (`R/cand/cand-review-bobble-dark.png`, y=268). "…then schedule it."

32. **"A folder of its own, kept per run"** as the *Runs in* value and "A
    folder of its own" as the picker's label (`R/cand/cand-default-bobble-dark.png`,
    `R/cand/cand-review-bobble-dark.png`). Reads like a promise about tidiness,
    not a place. "Its own folder (a new one per run)" — and the picker's
    description "Whatever it writes lands in a folder kept per run" can go.

33. **The consequence line is a sentence of dots** — "Every Friday at 4:00 PM
    · first run Fri 4:00 PM (in 4 days) · no model is loaded yet — the first
    run loads one · reads your Mac, never sends" wrapping to two lines
    (`R/cand/cand-review-bobble-dark.png`, y=600–624). The best line on the
    page is buried in the longest. Two lines by design: the schedule + first
    run in primary; the two caveats in muted below it.

34. **"No runs yet. Results land here, not in a chat, and no model is loaded
    yet — the first run loads one."** — 96 characters for an empty list
    (`R/cand-empty/cand-one-task-bobble-dark.png`, y=519). "No runs yet — the
    report lands here." The model caveat is already in the Reach block above
    it.

35. **The subtitle** "Work Bobble does on its own while it is open — what ran,
    and what runs next." is right in content and one clause too long for a
    header that has to wrap at 760 (item C19). "What Bobble does on its own
    while it is open."

36. **"Deleting removes the task and its 5 runs."** — good. **"Delete for
    good?"** with *Delete* / *Keep* — good. **"1h 42m late"** with the tooltip
    explaining the catch-up — good (`R/cand/cand-late-bobble-dark.png`).
    **"by hand"** — good. Say so, so nobody re-words them.

### H. Failure and edge states

37. **The failed run is done right** — red alert glyph, red first line in the
    ledger, the full error and the permission to grant when opened, "used
    Calendar" (`R/cand/cand-failed-run-open-bobble-dark.png`). Keep. One
    thing: the headline truncates the error at the pane's width ("…(System
    Settings › P…") and the *actionable* part — which setting to change — is
    what gets cut. For errors, clamp to two lines instead of one.

38. **A running run's body says "Working — the report lands here when it
    finishes."** with no elapsed time in the body (the head has "24s so far")
    (`R/cand/cand-running-bobble-dark.png`). Fine. But the *real* run through
    the mock finished in under one frame, so the running→done transition of
    the pill and the glyph was never captured (`R/cand-motion/cand-film-run-now-strip.png`
    shows only the after). Listed under *could not judge*.

39. **An empty list inside the shell** shows the composer focused, the
    templates, and no list column (`R/cand-empty/cand-empty-bobble-dark.png`).
    Good. With one task the list column returns at 280 px with one row and
    the templates disappear (`R/cand-empty/cand-one-task-bobble-dark.png`);
    the same loneliness as the shipping screen's item A7, softened by the
    pane. Under the single row, a muted "Start another from a template ›"
    that opens the New-task pane with the cards.

40. **Hundreds of tasks**: the groups and the magnifier hold; there is no
    filter by state ("failing") and search matches the name only
    (`LedgerCandidate.tsx rows`). Search the prompt too, and let the group
    labels be clickable filters.

### I. Accessibility

41. The tab order is right and complete — New task → composer → search → every
    row → Run now → Edit → switch → each run head → Delete
    (`measure.json tab-order:cand-default`); the hidden slot layer is inert
    and takes no stop; rows and run heads draw the ring inside their bounds.
    Remaining: group labels are `<p>`s, not headings, so a screen reader hears
    a flat list; the running pill's spinner has no text alternative beyond
    "Running · 24s" (fine); the `Switch` has an `aria-label` that flips
    ("Pause this task"/"Resume this task") — good; the composer's
    `aria-label` "Describe a task, with a time" — good.

---

## Shared — data model and plumbing both surfaces need

These are the items that no amount of CSS fixes, in the order that changes
what a person sees most. `NOTES.md` proposals 1, 2, 7 and 8 are correct and
still unbuilt.

1. **`tasks:stop`** (`scheduled-contract.ts`, `scheduled-runner.ts`,
   `scheduled-main.ts`): dispose the live bridge, finalise the record as
   `stopped`, drop a queued run. Then *Run now* becomes *Stop* while running
   on both surfaces.
2. **`TaskRun.model`** written at run start, and either honour
   `ScheduledTask.modelId` with a picker in the editor or delete the field.
   The row/pane can then say "41s · Gemma 4 12B", and the editor "runs on…".
3. **The chat card**: `activity-mapping.ts` entry for `create_scheduled_task`
   with a clock glyph and "Scheduling a task / Scheduled a task"; a step body
   with name, `describeSchedule`, and *Open* → `onOpenScheduled` with the id
   selected. And the tool's own result sentence in `schedule-tool.ts` should
   use `describeSchedule` ("Every Friday at 4:00 PM"), not "every week (day 5)
   at 16:00".
4. **`titleFrom` → `nameFrom`** in `schedule-logic.ts`, used by the tool, the
   dialog and the editor alike.
5. **A derived state in the store** (`derive.ts taskState` — running / due /
   missed / late / by hand / paused / off) so the shipping row, the chat card
   and any notification say the same word.
6. **Notify on completion and failure.** Neither surface says whether a run
   will notify, and I could not find that a scheduled run posts a notification
   at all. A task that fails at 7:30 while the app is open should produce a
   banner with the first line of the error; the ideal lists this among the
   trust facts. (Check `notify-gate.ts` before assuming it is absent.)

---

## Feel and vibe

Kept separate on purpose. What it felt like to use each, screen by screen,
including the things I cannot pin to a rule.

### The shipping screen

- **It feels like a settings pane that grew a list.** The header is a
  status-badge and a blue button, the composer is a text field with a grey
  "Draft it" beside it, the list is a bordered box of rows with four verbs
  each. Nothing on it was *composed*; every element is the default of the
  thing it is. It is not ugly — the tokens are good, the spacing is even — it
  is *anonymous*. Compare `R/ship/ship-many-bobble-dark.png` with the Claude
  desktop reference `12.01.27`: same anatomy, and one reads as a product and
  the other as a table.
- **The dialog feels like a form you fill in, not a thing you make.** Two
  stacked fields, a row of dropdowns, a folder picker, a pill, two buttons.
  Correct and joyless. The candidate's editor is nearly the same fields and
  feels completely different because it *answers back* ("first run Fri 4:00
  PM (in 4 days)") and because it is in the page, not over it.
- **The cuts make the app feel cheaper than it is.** Dialog, drawer, create,
  pause, kill switch — each one pops. The app has a dialog recipe with a
  250 ms entrance and this screen does not use it. Motion is where a person
  decides whether software is "nice", and this screen's answer is no.
- **The drawer feels like the page tearing.** Same background as the page, a
  hairline edge, and it arrives in a frame. `R/ship/ship-runs-drawer-week-bobble-dark.png`.
  Yet the *cards inside it* are the best-designed thing on the surface — the
  failure card with its red error and the permission to grant is genuinely
  good, and the artifact thumbnail is a small delight. The content is ready;
  the container is not.
- **Ten red Deletes make the list feel dangerous.** The eye keeps landing on
  them. A list of things the app will do on its own should feel calm.
- **"last ran 9/7/2026" on every row makes the app feel American and
  bureaucratic** in a UI that otherwise speaks like a person ("Only when you
  run it", "Delete for good?").
- **The empty state with nine Unicode glyphs feels like a wiki.** The
  descriptions are excellent copy — "Runs on your Mac. Nothing leaves it." —
  let down by ☀ and ⇢ at 13 px.
- **At 760 px it feels broken**, not merely tight (`R/ship/ship-many-minimum-bobble-dark.png`).

### Ledger+

- **The pane feels like a real product.** Tile, name, schedule, three quiet
  buttons, the contract in a box, three facts, a ledger with a rail. Reading
  "Today 7:30 AM 41s — Calendar: 10:00 Bobble sync…" under a task called
  Morning brief is the moment the feature makes sense
  (`R/cand-chrome/cand-chrome-bobble-dark.png`). I would screenshot this.
- **The composer feels like it belongs to a different, louder app.** It is
  the chat composer's shape, and on the chat screen that shape is the whole
  point; here it sits above a filing cabinet and shouts. When it has focus
  at rest (the empty screen), the blue ring plus the 1120 px width makes the
  page feel like it is asking me to type before it has told me anything.
- **Typing into it feels good, then slightly dishonest.** The chips arriving
  as you type are the best interaction on either surface — until you notice
  "Every day at 9:00 AM" appeared before you had typed a time. The parse
  earns trust by never guessing; the chips spend it.
- **The list feels like a mail sidebar in the best way.** Groups by day,
  glyphs that mean something, a trailing word only when there is one. "What
  did I miss · missed" in amber is exactly the right amount of alarm.
- **The Enter fold feels expensive** — in a good way. The sentence becomes a
  strip, the pane fades in with the editor, the name is already whole and
  focused. It is the one transition in either surface that feels designed.
- **The kill-switch banner feels like a mistake even though every word in it
  is right**, because the page jumps under it.
- **The "Runs on — whichever model Bobble loads first — none is loaded yet"
  line makes the app feel unsure of itself**, three times per visit (Reach
  block, editor line, empty-runs line). On the user's machine a model is almost
  always loaded and it will read "Gemma 4 12B", which feels fine; the
  fallback copy should be as short as the good case.
- **Two 22 px titles stacked under a top-bar title feel like a document
  header, not an app.** The Model hub gets away with it because its second
  title is a section; here the second title is a *thing*, and things want to
  be smaller than the page.
- **The light theme is better than the dark.** The inset prompt box, the
  hairline rail and the amber missed word all read more clearly on `#f5f5f7`
  (`R/cand/cand-default-bobble-light.png`, `R/cand/cand-failed-run-open-bobble-light.png`).
  In dark the prompt box, the page and the raised composer are three greys
  within 12 points of each other, and the pane loses its edges.
- **It does not yet feel finished at the edges** — no Stop, no model, no
  card in the chat — and a person will hit all three in the first hour.
  Those are the difference between "this is nice" and "this is done".

### The chat

- **Creating a task in the chat feels like nothing happened.** "Used a tool"
  in 13 px grey, then a paragraph. The reference's card is small and it is
  the entire difference between a feature and a side effect
  (`R/chat/chat-task-created-bobble-dark.png` vs `12.00.58`).

---

## What is already better than the references

Do not "fix" these.

**Ledger+**
- The run ledger on the page: first sentence, measured duration, "by hand",
  "1h 42m late", the real error in red, the picture on the row. No reference
  shows a run's result at all (`R/cand/cand-default-bobble-dark.png`,
  `R/cand/cand-late-bobble-dark.png`, `R/cand/cand-running-bobble-dark.png`).
- Derived states that are true — running / due / missed / late / by hand /
  paused / off — and *off* wrapping the inner state so flipping the switch
  does not reshuffle the list (`R/cand/cand-off-bobble-dark.png`). The
  shipping screen reshuffles.
- The consequence line — "Today 8:00 AM already passed, so it runs **as soon
  as you save**" (`shots/ledger-plus-ix-enter-cut-bobble-dark.png`). Neither
  reference says what saving will do.
- Live parse while typing (with item A4 fixed).
- The Enter fold and the sentence strip (`R/cand-motion/cand-film-enter-strip.png`).
- One inline editor, never a modal; Escape and ⌘↩ work from any field; the
  weekday/hour/minute controls appear only when the frequency needs them.
- The template cards: stroked icons, whole blurbs, the schedule on the card
  (ChatGPT's cards have no schedule), the **+** swap on hover.
- Delete that says what it takes and asks in place with a *Keep*.
- The kill switch as a labelled Switch with a banner that says by-hand runs
  still work.
- Rows and run heads are real buttons with rings drawn inside them; the
  whole page tabs in order.
- No purple, dark or light, any state.

**The shipping screen**
- The past-run card's failure treatment and the artifact thumbnail (items H53,
  H56).
- The templates' *copy* ("Runs on your Mac. Nothing leaves it.", "It cannot
  send them.") — better than any reference's.
- "Only when you run it", "Delete for good?" — the voice is right even where
  the pixels are not.
- The two-step delete disarming when the pointer leaves (`ship-delete:disarmed-on-leave = true`).

---

## Not worth fixing

Differences from the references judged cosmetic, said out loud.

- Claude's serif title, stopwatch illustration and wavy divider. Bobble is
  sans and Apple-frosted; decoration would fight it.
- Claude's "New task ▾ → Create with Claude / Set up manually" split. The
  sentence box *is* both doors.
- Claude's "Sort by Next run" and "All / Active / Paused" tabs. The day groups
  do both jobs; a *failing* filter (Ledger+ item H40) is the one addition.
- Claude's "Permissions: Manually approve". An unattended local run has nobody
  to ask; "reads your Mac, never sends" is the answer.
- ChatGPT's emoji tiles, mic, and **+** connector menu.
- Claude's hover *preview* of a template's output. It is canned cloud imagery;
  the blurb says what the task produces. The **+** swap is the part worth
  having, and Ledger+ has it.
- Claude desktop's twelve "From Plugins" rows. A local app has no plugins to
  advertise; the nine templates are the right number.
- Bordered template cards vs Claude's borderless grid. Connectors uses bordered
  cards; consistency wins.
- The dark theme's bordered prompt box vs the light theme's filled one. Both
  read as "the prompt".
- The 34 px idle lane under the candidate's composer — *if* item A3 is done
  the lane goes with it; if not, it is spacing, not a hole.
- The shipping dialog's *width* (620) and the drawer's *width* (560). Both
  are fine; their edges and entrances are the problem.

---

## What I could not judge

- **The running → done transition on Ledger+.** The mock pi finishes in under
  one screencast frame, so `R/cand-motion/cand-film-run-now-strip.png` shows
  only the after. A `SLOW_MS` on the mock (it has one — `mock-pi.mjs:261`) or
  a real model would show whether the pill appears, the *Run now* button
  vanishes without a jump, and the ledger row flips from spinner to check.
  The seeded running state (`R/cand/cand-running-bobble-dark.png`) is the
  evidence for the *look*; the *change* is unfilmed on both surfaces.
- **A task made in the chat landing in the list.** The mock pi emits the
  tool call but does not execute it, so after the chat turn the Scheduled
  screen was still empty (`R/chat/chat-then-scheduled-bobble-dark.png`,
  `measure.json chat:rows = []`). Against a real model the file watcher
  (`scheduled-main.ts watchStore`) should deliver it live; whether the list
  animates the arrival, and whether the new task is selected, is unjudged.
- **The empty screen in the shell.** `cand-chrome/` was shot seeded only; the
  first-run screen with the sidebar and top bar around it — the composer
  focused at rest under the "Scheduled" label — has no frame.
- **Notifications on completion or failure**, on either surface (Shared item 6).
- **A run producing a video or audio artifact** — the shipping drawer renders
  `<video controls>` and `<audio controls>` tiles; the candidate shows a file
  icon for anything that is not an image. Neither was exercised.
- **Real widths under a real sidebar in the light theme** for the shipping
  screen — `ship/` has dark at 1172/900/760 only.
- **Hundreds of tasks.** The seed is nine. The candidate's groups and the
  shipping list's single box behave differently at 100; neither was loaded.
- **The Ledger, Agenda and Routines candidates.** Out of scope: Ledger+ is the
  intended replacement and the only one the brief named.

---

## On the earlier rounds' verdicts

Round 3 said *at parity*; round 4 said *above the references*. Re-tested, the
candidate is at parity with the references and above them on the ledger; the
"above on every axis the references cover" reading was too generous, for
reasons worth naming so the next round does not repeat them:

1. **They judged the wrong screen.** All three rounds judged
   `?candidates=schedule` and never re-opened `src/scheduled/`. The screen
   the user sees was never in a verdict, which is how "above the references" and
   "very not on par" were both true at once.
2. **They judged against the references, not against the ideal.** The
   references are weak on run history, so the candidate's ledger looked like a
   victory; the ideal asks for Stop, a model name, a live running transition
   and honest parsing, none of which a reference has, and the candidate
   lacks all four.
3. **The composer's defaults were never questioned.** Every typing shot was of
   a sentence with a time in it. Typed one letter at a time, the composer
   asserts "Every day at 9:00 AM" on "eve" (`R/cand-motion/cand-film-typing-strip.png`).
4. **Some motion evidence was of the wrong region.** `shots.mjs` crops the
   screencast in CSS pixels while frames arrive at 2× — the `slot` and `pane`
   crops happened to contain the areas they named only because those areas'
   device coordinates fell inside the CSS box. The pane-swap strip does show
   the swap (`shots/motion/ledger-plus-motion-pane-swap-bobble-dark-strip.png`)
   and the description was right; the method was lucky. `review-probe.mjs`
   scales crops by `devicePixelRatio`.
5. **Nothing was ever run.** No round pressed *Run now* through the mock, so
   the real running→done change, the `BODY` focus after save, the Escape in
   search, and the 46 px banner push were never on a list. Stills of seeded
   states are not the same as driving the thing.
6. **"Not worth fixing" absorbed real items.** The two 22 px titles and the
   composer's shape were filed as cosmetic; in the shell they are the heaviest
   top-third in the app.

---

## Appendix — where the evidence is

```
apps/desktop/src/candidates/schedule/review-probe.mjs   the probe (MODE=ship | ship-motion | cand | cand-empty | cand-chrome | cand-motion | chat)
apps/desktop/src/candidates/schedule/shots/review/
  ship/          39 stills: empty, hover, focus, typed, every dialog state, one task, many, paused, off, delete armed, drawers (empty / week / running+artifact / real run), 1172 / 900 / 760, measure.json (styles, boxes, tab orders, focus targets), console.txt (empty)
  ship-motion/   11 clips: template hover, dialog open/close, create, run now, drawer open/close, pause, off/on, delete arm — GIF + labelled filmstrip each; measure.json has the movement numbers
  cand/          22 stills: default (dark/light), typing, review, after save, hover, running, failed run open, real run, search, off, late, delete armed, edit, frequency menu, 900 / 640 / 640-detail
  cand-empty/    8 stills, first run: default (dark/light), hover, typing, review, one task (dark/light), one task at 640
  cand-chrome/   5 stills, inside the shell at 1440 (dark/light), 1172, 900, 760
  cand-motion/   9 clips: template hover, typing, enter, edit sentence, pane swap, run now, switch off, edit, delete arm
  chat/          4 stills: a task made in the shipping chat (dark/light), the chain open, the Scheduled screen after
```

Every run: window hidden, throwaway home, focus never moved (`review-* OK` on
each), no console errors or warnings.
