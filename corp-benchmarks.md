# Corp harness benchmarks

Tasks for testing the corp harness end to end. Each is a one-line prompt a user
would actually type, plus the delegation and behaviour we want to see from it.

## What makes a task a valid benchmark

- Too big for one model in one pass. If a single write plus a check would do it,
  it tests nothing — the manager should never have been called.
  - A single HTML file is NOT a benchmark. Neither is a script, a config, or a
    one-file refactor.
- Splits into pieces that can be built and checked independently.
- Has a real, verifiable end state someone can look at or run.
- Ideally uses an environment that is NOT set up out of the box, so setup and
  runtime discovery are part of the work.
- The prompt stays SHORT and vague. Everything below it should be the team's own
  decisions, not ours.

## Verification bar (all of them)

- The product exists where the user asked for it, not one level down, not in a
  temp directory.
- It RUNS. Loaded/launched/opened by the harness itself, errors read from both
  streams.
- Somebody LOOKED at it — a screenshot, a rendered frame, a driven UI.
- Claims in the final report were each discharged, not asserted.
- The CEO's answer describes what was actually delivered.

---

## 1. LocalConvert — a local CloudConvert

- **Prompt**
  - "Build me a fully functional 1:1 clone of CloudConvert, but local, as a
    desktop app in my Applications folder. Call it LocalConvert."
- **Why it's a good benchmark**
  - Research, UI cloning, wide parallel work, third-party reuse, and packaging —
    four different kinds of work in one task.
  - The parallel part is genuinely parallel: each format pair is independent.
- **Ideal process**
  - Research first
    - Open cloudconvert.com, screenshot it, pull the UI style — layout, spacing,
      type, colour, the drop zone, the queue, the per-file state.
    - Clone that look rather than invent one.
  - Format research
    - Enumerate what the real thing supports; decide what the local one will.
    - LOOK FOR AN EXISTING PROJECT FIRST. An OSS converter that already does
      nearly everything is a better answer than fifty hand-written pipelines.
      Wrapping ffmpeg / ImageMagick / LibreOffice / pandoc is the expected shape.
    - Only hand-build what nothing covers.
  - Split
    - One engineer owns the app shell + packaging.
    - One owns the UI clone.
    - The rest own format families in parallel (image, audio, video, documents,
      archives) — each independently testable on a real file.
  - Verify
    - Real inputs, made or found on this machine, not empty files with the right
      extension.
    - Convert something in each family and OPEN the result.
    - The packaged app launches from /Applications, not just `npm run dev`.
- **Delivered means**
  - A launchable app, from Applications, that converts a real file the user drops
    on it, and looks like the thing it was cloned from.

## 2. Research deck

- **Prompt**
  - "Research <complex topic> and make me a really good looking slideshow
    presenting the findings."
- **Why it's a good benchmark**
  - Delegation is per slide, so the fan-out is natural and wide.
  - The hard part is COHERENCE — many hands, one artifact that has to look like
    one person made it.
- **Ideal process**
  - The manager decides the narrative arc first, then hands out slides.
    - A deck assigned before the arc exists is a pile of slides.
  - One engineer per slide (or per section), researching its own claim.
  - A shared style decided ONCE and given to everyone in the contract — type
    scale, palette, slide template — rather than five engineers inventing five
    looks.
  - Research is real: sources fetched and read, figures attributed.
  - Specialists
    - ui-critic on the deck as a whole, once assembled.
    - visual specialist to actually look at the rendered slides.
    - correctness on the claims.
  - Verify
    - Render every slide and LOOK at them in order.
    - No overflowing text, no placeholder, no slide that contradicts another.
- **Delivered means**
  - A deck that opens, reads as one document, and whose claims are sourced.

## 3. Godot sample game

- **Prompt**
  - "Ask the manager to set up a sample Godot game to demo Godot in <dir>."
- **Why it's a good benchmark**
  - Godot is NOT set up out of the box on a normal machine — discovery and setup
    are part of the task.
  - Scene files are a structured format owned by a program, so hand-writing them
    fails loudly and honestly.
  - It has an unambiguous runtime check that exits by itself.
- **Ideal process**
  - Establish Godot exists and what version, before anything is written.
  - Do NOT hand-write `.tscn` / `project.godot`. Drive the tool that owns the
    format — a GDScript calling `ResourceSaver.save()` under
    `godot --headless --script`.
  - Split: project skeleton first (stacked), then player / level / UI / enemy in
    parallel on top of it.
  - Verify
    - `godot --headless --quit --path .` — zero error lines, read from BOTH
      streams (Godot writes errors to stderr and still exits 0).
    - Then render a frame with `--write-movie` and look at it.
- **Delivered means**
  - The project opens, the game draws, and someone has seen it draw.
- **Known failure mode**
  - A small model invents the scene format and cannot repair it. This benchmark
    is as much a model-capability probe as a harness probe — keep the two apart
    when reading a result.

## 4. Add a feature to an existing codebase

- **Prompt**
  - "Add <feature> to the project in <dir>, matching how the rest of it is
    written."
- **Why it's a good benchmark**
  - Everything else here is greenfield. Most real work is not.
  - Tests whether the team READS before writing, and whether it can follow
    conventions it did not choose.
- **Ideal process**
  - The manager reads the codebase and reports its conventions before splitting.
  - Contracts name the exact files each engineer owns — no two engineers in the
    same file.
  - The auditor traces how the feature has to thread through existing code.
  - Verify
    - The project's OWN test command, green.
    - New tests for the new behaviour, written now, also green.
    - The diff looks like the surrounding code.
- **Delivered means**
  - The feature works, the existing suite still passes, and the change is not
    obviously bolted on.

## 5. Data tool over a messy real dataset

- **Prompt**
  - "Make me a desktop tool that loads <messy CSV/folder of files> and shows me
    what's actually in it."
- **Why it's a good benchmark**
  - Correctness is checkable against ground truth, unlike aesthetics.
  - Messy input is where "it worked on my test file" dies.
- **Ideal process**
  - Profile the real data FIRST — encodings, missing values, duplicates, mixed
    types, dates in three formats.
  - Split: ingest/clean, analysis, UI, export — ingest is the foundation and goes
    out first.
  - Contracts specify behaviour on BAD rows, not just good ones.
  - Specialists: correctness on the numbers, tester on the edge cases.
  - Verify
    - Numbers checked against a hand-computed answer on a small slice.
    - Feed it a deliberately broken file and confirm it says so instead of
      producing a confident wrong total.
- **Delivered means**
  - It opens the real file, the numbers are right, and bad input produces an
    honest error.

## 6. Illustrated short — the multi-modal one

- **Prompt**
  - "Make me a short illustrated explainer about <topic> — pictures and all."
- **Why it's a good benchmark**
  - The only one that exercises the generation stack and the producing
    specialists (image, motion) as part of a build.
  - Style consistency across separately-generated images is a real coordination
    problem.
- **Ideal process**
  - Script and shot list before any image is generated.
  - One style brief, given to every image request, so the pictures belong
    together.
  - image specialist produces; visual specialist LOOKS at what came back and
    sends back what is wrong.
  - Iterate on the images that fail, not on all of them.
  - Verify
    - Every image viewed. No sixth finger, no wrong subject, no placeholder.
    - The assembled piece plays/reads start to finish.
- **Delivered means**
  - A finished piece someone has watched or read all the way through.

---

## Reading a result

- Separate the two failure classes before concluding anything.
  - HARNESS: nobody was contracted, work landed in the wrong place, a claim went
    undischarged, the CEO reported something that was not delivered.
  - MODEL: the decomposition was sound and the pieces were wrong — invented API,
    invented file format, a repair loop that cannot converge.
- A run that fails on MODEL with a clean delegation trace is a passing harness
  test and a failing model test. Say which.
