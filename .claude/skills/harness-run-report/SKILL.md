---
name: harness-run-report
description: Write the report for a Bobble corp-harness run — the bulleted flow from initial prompt through CEO research, delegation, engineers and termination, with numbered failures inline, timestamps, measured numbers, and an error diagnosis. Use this whenever a corp/mesh/agent run has finished or been stopped and you are about to tell the user what happened, whenever the user asks "how did the run go", "what happened", "give me the report", or asks for the flow/trace of a run — and also when you are tempted to summarise a run in a couple of paragraphs, because that is exactly the summary this format exists to replace.
---

# Reporting on a harness run

A run report has one job: let the user see **where the harness actually broke**, without
having watched it. A prose summary cannot do that. Two paragraphs saying "the run went
well but hit some issues" is worth nothing — the user cannot act on it, and it hides the
thing the user is paying for the run to discover.

The format below is his, from his own words. Follow its shape rather than its letter.

## Gather the evidence BEFORE writing a word

The single most expensive mistake in this workflow is writing the report from the
run's own narration. Agents claim completion they have not achieved — that is one of
the things being measured. A previous run was reported as "healthy" and five of its
seven source files did not compile. Nobody caught it until the files were opened.

So: open the artifacts.

- **The project directory** — what actually landed on disk.
  `find <project> -type f | wc -l`, then look at the files.
- **Do they parse?** Run the real parser, per language, and count:
  `node --check f.js`, `npx tsc --noEmit`, `python3 -m py_compile f.py`.
  A file that does not parse is not a deliverable. Report the ratio
  (e.g. "53 files / 4,709 lines, 12 fail to parse, 5 truncated mid-function").
- **Does it run?** If it claims to be an app, try to start it. If it claims to
  convert a file, convert a real file and open the result.
- **The run log** — timestamps (`[136s]`), message counts, the vitals lines.
- **The screenshots** in the run's `OUT` directory, if the launcher took them.
- **The session JSONLs** for what each role actually said and called:
  `find ~/.pi ~/Library/Application\ Support -name '*.jsonl' -newermt '-3 hours'`.
  A session's own `cwd` header is authoritative — the directory name can be a slug
  of a stale path.

State which **build** every claim refers to. "Fixed" in the working tree and "fixed"
in `/Applications/Bobble.app` are different claims, and conflating them has wasted
his time before.

## The shape of the report

A bulleted flow, in the order things happened, with failures numbered **inline at the
point they occur** — not collected in a section at the end. The failure numbering is
what makes the report skimmable: he can jump to `failure 3` and see its context.

This is the user's own example of the level of detail required:

> initial prompt sent, ceo researches, gets blocked on tools, calls specialist to
> research, **failure1: doesn't incorporate specialist feedback** … manager delegates
> 6 engineers with divisions: ui, office integration, file engine. ui engineer
> falsereports completion, manager loops attempting to message file engine engineer
> and I found a harness bug where the subagent would never receive the message if
> sent during a hanging bash tool use … **cause of termination**: manager never
> returned second round until time limit, **error diagnosis**: "it was actually
> working toward the task and it did fix a lot…"

Note what he includes: the specialist call, the fact that its feedback was ignored,
the exact division of engineers, the false completion, and a harness bug found along
the way. Note also that the diagnosis is generous where the evidence supports it —
"it was actually working toward the task" is as important as the failures.

### Skeleton

```
## Run <N> — <model>, <duration>, <task>

- **[0s] initial prompt sent** — <the prompt, verbatim or trimmed>
- **[Ns] CEO research** — what it opened, searched, read
  - **failure 1: <one line>** — what it did, what it should have done, evidence
- **[Ns] delegation** — how many engineers, what divisions
- **[Ns] engineer: <name>** — what it built, what it claimed
  - **failure 2: <one line>** — …
- **[Ns] <whatever happened next>**

**Cause of termination:** <the specific thing that ended it>
**Error diagnosis:** <would it have succeeded given more time? why?>
```

Timestamps come from the log. If you only have wall-clock, say so rather than
inventing precision.

## The two things people get wrong

**1. Laundering a failure through the verification ceremony.** If the run's own
reviewer or manager declared the work verified, that is a *claim inside the run*, not
a finding. It goes in the flow as "the manager reported X" and is immediately
followed by what you found when you opened the files. Never let the harness's
self-assessment stand as the report's conclusion.

**2. Reporting "no progress" when the run was stopped early.** Say how it ended and
be exact: finished / hit the time limit / detected as a loop / aborted by you. If you
aborted it, say at what point and why. A run "aborted at 4m06s" and a run that "ran
five hours" are different facts, and getting this wrong once cost real credibility.

## Cause of termination

Be specific. Useful causes look like:

- finished and submitted
- time limit reached while the manager was mid-round
- loop detector fired after N identical calls
- output limit hit with no tool calls, turn discarded
- context exhausted (`tot == contextWindow`) — distinct from the output cap
- OOM / "Compute error" — **check for an orphaned llama-server before blaming the
  model**; an orphan holding the GPU has faked this exact failure before
- aborted by me at <time>, because <reason>

## Error diagnosis

One honest paragraph answering: **would this have completed if left alone?** This is
a judgment call and he wants the judgment, not a hedge. Distinguish:

- *working, just slow* — real progress, would likely have finished
- *working on the wrong thing* — progressing confidently in a direction that does not
  satisfy the brief (scope narrowing is the common form)
- *stuck* — repeating, or waiting on something that will never arrive
- *broken* — a harness defect stopped it, and the model could not have recovered

If a harness bug was found, that is the most valuable output of the whole run. Give
it its own line, name the file, and say whether it is fixed.

## The standing report format

When everything is done and solid, the report is delivered as **three parts, in this
order** (this is a persistent instruction from the user, not a per-run choice):

1. **UI/UX table** — the queued interface items, what changed, what is outstanding.
   UI items are never allowed to interrupt harness work; they queue and get fitted in.
2. **Harness table** — the harness fixes and findings.
3. **Notes** — everything that does not fit a table, including the run flow above.

Keep tables genuinely tabular — one row per item, a status, and the build the claim
refers to. Prose belongs in the notes.

## Tone

Report outcomes faithfully. If it failed, say so plainly with the evidence. If it
worked, say that plainly too, without hedging it into mush. Do not apologise for
non-determinism — the harness is non-deterministic by design, and a well-aimed prompt
is an accepted fix, not a workaround to be embarrassed about. What matters is that
every claim in the report is one you actually checked.
