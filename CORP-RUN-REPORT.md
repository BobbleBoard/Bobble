# Corp harness — runs 1–15

Six runs, 2026-08-01. Forced corp (`?corpForce`), max effort, qwen3.5-4b-mtp,
identical prompt: a complete 2D platformer in Godot 4 at a named path.

Promotion was **forced**, not chosen — the model's own promotion decision measures
3/5, and a run that exists to prove the harness completes cannot be a coin flip.
Task content was never touched.

---

## The milestone

**A corp run completed end to end, twice.** It had never happened before.

| | run 5 | run 6 (clean testbed) |
|---|---|---|
| outcome | `completed` | `completed` |
| elapsed | 5m11s | 3m12s |
| team | 18 (CEO, manager, 4 engineers, 12 specialists) | same |
| verdict | `(no reply)` | a real briefing |
| files | 7, one location | 10, one location |
| strays outside the target | none | none |

---

## What the user reported, and what was actually wrong

> "it finished but no presenting, I can't as the user go and see the run even
> primitively following its instructions going to the folder and the file and
> pressing f5, won't do anything. it hasn't installed godot or looked for an
> installation or run any visual tests or used the present tool."

### ✅ FIXED — the folder was empty because the files went somewhere else

Not a fence refusal, which is what I first reported. The fence refused the
requested path and its error said *"use a relative path like `corp-run`"*. The
model complied, that resolved against the working folder, and the whole project
was built at `/Users/user/Desktop/corp-run` — eleven files, no error, and a reply
naming the path that had been asked for. One earlier run wrote to **both**
locations (different roles, different roots): a project torn in half, which is
why F5 does nothing even once you find the folder. Same mechanism produced
`/Users/user/Desktop/Users/user/Desktop/platformer_game`.

`3e63fcb` — an absolute or `~`-anchored path under HOME is honoured; writing a
path out in full is what intent looks like. Bare relative names stay fenced; a
direct child of HOME (`~/notes.txt`) stays refused, because that is the spill the
fence exists for.

**Verified live:** runs 4 and 6 wrote 8 and 10 files, each entirely inside the
requested directory, with zero strays on the Desktop. Three runs before the fix
produced strays every time.

### ✅ FIXED — `present` could not fire in a corp run at all

Registered for the top-level agent, and in **no corp role's allowlist**. The
building produced the artefact, wrote a verdict about it, and left the user to go
find their own deliverable. `52cf918` gives it to the CEO alone — the one role
that has spoken to the user and whose reply they read. Everyone else reports
upward, so "no subagent ever has this" holds unchanged.

### ✅ FIXED — the runtime rule never reached the corp harness

"Establish the program exists before you build for it" lived only in
`CAPABILITY_PROMPT`. The corp mesh preamble is entirely separate text, so the
building actually writing the Godot project never read it. `037a7bb` puts it in
the preamble, where every role gets it.

### ✅ FIXED — an empty verdict said nothing

Run 5's entire verdict was `(no reply)` after five minutes and seven files,
because the CEO exhausted its per-message step budget mid-tool-loop. Its own
status update said so — *"I've now made ~30 tool calls without reporting back"* —
and none of it reached the caller. `2552d26` distinguishes a spent budget (names
the count, tells the caller to ask for a summary) from genuine silence.

---

## STILL BROKEN — what run 6 proves is not fixed

These are behavioural, and the prompt changes did not move them.

### ❌ No Godot check ever ran

**Correction:** I first reported this as "Godot is not installed". It is —
`/opt/homebrew/bin/godot`, 4.7.1. My check was stale, carried over from an
earlier session.

That makes the failure worse, not milder. A capability probe already runs
`godot --version` at task start and briefs the team on what this machine has, so
the team was told Godot was available. Every mention of "godot" in run 6's logs
is still only inside the CEO's own prose — *"then the project opens in Godot and
all requested features work"* — with no invocation anywhere. It asserted the
project runs in an engine that was installed, present in its briefing, and one
command away, and never ran it.

### ❌ `present` still never called

Allowlisted and named in the CEO charter, and the run still ended without it.

### ❌ The submit gate did not hold

The verdict ships work it knows is broken, in its own words: *"Sprites have
syntax errors"*, *"they're empty placeholders"*, *"**2 minutes** to fix"*. The
`DO NOT SUBMIT UNTIL YOU ARE CERTAIN` line did not stop it.

### ❌ It hands the work back, and to the wrong person

The final verdict is headed **"## Manager Briefing"** and ends:

> "Shall I finalize the sprites and open the project for you to verify everything
> works?"

Two failures at once. The reply that reaches the user is addressed to a manager,
so the CEO is passing a subordinate's report through rather than judging it. And
it closes by asking the user to authorise work it was already told to do — the
exact hand-back the prompt forbids.

### ❌ It claims files that do not exist

*"I've created 4 sprite files (Player.svg, Platform.svg, Coin.svg, Enemy.svg)"*.
None are on disk. The ten files that exist contain no `.svg` at all.

---

## Reading of this

Four fixes were **reachability** bugs — a capability that existed and that
nothing could get to. Those are now measured fixed, and that class is close to
exhausted: `present` in no preset, then in no allowlist; the runtime rule in a
prompt the building never reads; the fs fence relocating instead of refusing.

What is left is different in kind. The harness now completes, keeps files where
they belong, and carries the right instructions to the right roles. The remaining
failures are the 4B not *acting* on instructions it demonstrably received — not
checking, not presenting, not holding its own gate, and describing work it did
not do. Prompt text has stopped being the lever; the next moves are structural
(make the check a step the harness performs rather than asks for) or a bigger
model for the CEO seat.

## Environment note

Run 5 was spoiled by testbed contamination: the CEO found a prior run's
`PlatformerGame` and adopted it instead of building the requested project. My
fault, not the harness's. `~/bobble-testbed` is now archived to
`~/bobble-archive` and runs start clean.

---

# Part two: runs 9–15, chasing an actually-working game

the user's standing order: rerun until *I* have visually verified, as the user, that
the game was delivered. Everything below was found by doing that.

## What was wrong, in the order it was found

**The corp worked in the wrong directory.** It rooted at the CHAT's folder — the
Desktop for most of the user's chats — so a task naming
`~/bobble-testbed/platformer` had its whole team in `~/Desktop`, and every
relative shell command landed there. The write fence had stopped this for the pi
file tools, but bash is not fenced and sensibly cannot be. `ad184ec` puts the
roles IN the directory the task names. It also closed the "vanished run-8 files"
mystery: they were at `/Users/user/Desktop/platformer` the whole time.

**My own instruction hung two runs.** Telling every role to "OPEN THE WORK IN IT"
made the CEO run `godot --headless -e game` and `godot --path .` — both open the
EDITOR, which never exits. Two processes were still alive when I went looking, at
1h19m and 19m, each holding its run hostage.

**And it named a command that does not exist.** I had written "wrap it in
`timeout 60`"; macOS ships no `timeout`. Found by running my own advice.

**The step budget was deciding the outcome.** Runs 9 and 10 ended "(ceo ran out
of steps after 31/33 tool calls without ever replying)" — 24 calls is less than a
17-file Godot project takes, so the cap landed mid-build every time and nobody
ever reached the verification. Raised to 60, plus a bump that rescues a spent
budget rather than letting the work vanish.

**The check itself was lying.** This is the important one. Godot prints every
error to STDERR and exits 0; `execFileSync` returns STDOUT only. So the harness
read an empty stream, found no errors, and told the CEO **"It loaded with NO
errors"** about a project with five parse errors. The CEO then reported "Project
loads cleanly" — and I called that a model failure. It was not. It did exactly
what the harness told it. the user pushed back ("did it attempt to get a screenshot
or compile and run the project at all?") and that is what found it.

## What the harness does now

- Works in the directory the task names, and logs `cwd` + `cwdFrom`.
- Classifies verification at task start AND per contract.
- `submit_work` lists the engineer's own claims back, numbered, with the proof
  that contract admits.
- Manager and CEO get the same through the bump, reading as the CEO and as the
  user respectively.
- **Runs `godot --headless --quit` itself** and sends the real errors back with
  "fix exactly these", looping WHILE the project fails to load rather than a
  fixed number of times.
- `present` renders a Godot project via `--write-movie` + ffmpeg and hands the
  frame back — no screen-recording permission, exits by itself.

## Measured

Run 14 went **6 load errors → 3** across two bumps: the CEO read the errors the
harness gave it and fixed the one in `player.gd`. That is the loop working. It
then ran out of bumps, which is why the loop is now driven by the check instead
of a count.

## Still true

- **Corp roles are text-only** (`launchMode: 'fast-text'`), so no role can read an
  image whatever the harness hands it.
- No run has yet produced a Godot project that loads cleanly.
- Delegation still does not happen: the manager and 16 specialists sit `queued`
  while the CEO builds alone.

## Runs 16–18: the last three things

**A `timeout` that exists.** Four runs were wedged by one shell call that never
returned — `godot --headless -e game`, a bare `--path`, and `--headless --path .`
without `--quit` (headless still runs the game loop forever). Naming each variant
in the prompt never kept up. macOS ships no `timeout(1)`, so the app now ships
one: a POSIX sh shim on PATH before any role gets a shell. When a prompt names a
mechanism the machine lacks, provide the mechanism rather than delete the advice.

**Show the failing line.** "line 27: Unexpected identifier 'deadzone'" is only
actionable next to line 27. The does-not-load bump now excerpts the lines the
errors point at, marked, plus the directory's real file listing — run 15 spent
four bumps on a missing `main.tscn` while never being told the project contained
no `.tscn` at all.

**Use the defaults before writing configuration.** Runs 10, 16 and 17 all died on
a hand-written `project.godot`. Run 17's was an `Object(InputEventKey,…)` block
with an unclosed brace and `"W"` where a keycode number belongs — Godot's hairiest
serialisation, hand-typed, purely to redefine keys the engine already ships.
`ui_left`/`ui_right`/`ui_accept` exist out of the box and a platformer needs no
input map at all.

The three of these share a shape with everything above them: the model is not
short of instruction, it is short of *ground truth delivered at the moment it can
act on it*. Every fix that has moved the needle works by putting a real fact in
front of it — the errors, the lines, the file list — rather than by asking it to
remember something.

## Runs 19–20

**A shadow tree my own fix created.** Run 19 built its entire game in
`platformer/platformer/2D Platformer/` — inside a workspace already called
`platformer`. `shadowRoots` missed it because `MIN_PREFIX` is 2: it looks for a
repeat of the last TWO path components, and a lone repeated leaf slips through.
That threshold was right when the corp worked in the chat's folder; rooting it at
the directory the task NAMES makes the single-leaf repeat the common case. Now
detected on evidence — the inner directory holds the project's entry point and the
outer does not — so a genuine `src/src` is left alone.

**Run 20 is the first structurally clean output.** Flat tree, no nesting, and a
`project.godot` that PARSES — the config failure that killed runs 10, 16, 17 and
18 is gone. What remains is a different and more tractable class: an autoload
written as `counter="Counter"` where Godot wants a real path.

**Worth knowing: the mesh is serial.** `concurrency: 1, parallelOptIn: false`
against `ramFittedMax: 3`. Delegation currently buys no wall-clock, which is part
of why the CEO builds alone while the manager and sixteen specialists sit
`queued` in every run. That is a deliberate OOM-safety setting on a single
machine, not a bug — but it does mean the corp's central promise is untested.
