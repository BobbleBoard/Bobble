# Queue — round 21 (from the user, 2026-09-07 ~20:55)

Everything here was queued while computer use was being finished. Order below is
the user's, not mine. He said: "you have a whole night to do it and produce that
video, you can take your time with all of it."

**Do the video first, then this file.** — the video is done and delivered
(`scratchpad/mac-video/bobble-drives-textedit.mp4`, plus a close-up cut).

Six screenshots came with the message. They could not be written to disk from
the conversation, so each is described where it belongs — precisely enough to
act on without them.

---

## 0. Immediate, said in the same breath as the video

- [x] **Do not blur the wallpaper** — done. The 4px blur, the 58% wash and the
      42% vignette are gone. Exposed a real regression (empty state and footer
      unreadable over a sunlit photo), fixed with a glass card and a scrim
      rather than by blurring everything again.
- [x] **Always show the fake cursor**, even idle — done. Drawn whenever there is
      a window, resting where it last acted, breathing gently.
- [x] **Recording** — done, by a second route. The monitor now draws the app
      from Accessibility when it cannot capture pixels, so it works with no
      capture grant at all; the video was recorded through it. Root cause of the
      permission trouble found: macOS keys the grant to the binary that CALLS
      the capture API, which was the separately-signed pi-mac helper — so
      enabling "Bobble" granted a binary that does no capturing. Capture is
      moving into Electron so the grant given to Bobble is the one that counts. He granted the permissions, double
      checked, restarted — and Bobble still asks. There are "a lot of permission
      re-popups in bobble even after I totally have provided the permissions".
      Find secondary ways to get the recording; do not make him fight TCC.

---

## 1. Rendering error — unacceptable, top priority after the video  ◐ MOSTLY DONE

*Screenshot: the whole Bobble window replaced by "Bobble hit a rendering error /
The window stopped drawing. Your chats are on disk and were not affected.",
with `Minified React error #185` in a code box and two buttons, "Reload" (blue)
and "Reload with a fresh window". Menu bar reads Bobble · Edit · View · Window,
8:53:28 PM.*

- [x] #185 hunted with a commit-counting detector across chat, canvas, every
      rail route, settings, session switching and 300+ prefill/status
      transitions. Nothing loops (peak 85 commits/250ms vs hundreds for a real
      loop). Three genuine instances of the INGREDIENT found and killed — writes
      that change nothing but notify anyway: the canvas controller committing a
      fresh state object on every quiet refresh, `dismissPill` returning a new
      array whether or not it removed anything, and `useRunningChats`'s
      stability memo keyed on objects built fresh in the render body.
- [x] **The Reload buttons** — root cause was our own security guard:
      `will-navigate` is preventDefaulted, and both buttons navigated the
      renderer, so the app refused its own recovery. Recovery goes through main
      now.
- [x] ⌘R is a safe re-mount that keeps the chat, the canvas tabs and the scroll
      position; ⌘⇧R is the real document reload.
- [ ] REMAINING: a **second real cause** of the full-window crash — a lazily
      imported route chunk that fails to fetch (seen when a rebuild changed a
      hash mid-session) takes down the whole app through the same boundary. The
      Studio/Tripo lazy routes need their own boundary. IN FLIGHT.

## 2. Canvas tabs — floating, not connected  ✅ DONE

*Two screenshots of a dark tab strip, four "New Tab" items. Today the selected
tab is joined to the content area by a border that runs up and around and back
down the other side; hovering an unselected tab draws the same connected shape
with a ✕ appearing.*

- [x] Tabs float: rounded on all four corners, centred with air above and below
      rather than resting on the seam, the selected one carrying a hairline all
      round plus a shadow. The strip's boundary is one unbroken line again.
- [x] Hover is a filled floating pill; nothing reaches down into the seam.

## 3. One "Activity" tab, not tab spam  ✅ DONE

- [x] One tab. It opens once, focused, on the first tool call with anything to
      show, then morphs in place and never takes focus again.
- [x] What it shows is decided by POSITION in the thread, newest wins across
      kinds — a file ties-and-wins against the command that wrote it. "A file if
      there is one, else a terminal" is the trap the corp router had already
      written down: it pins the tab to whichever surface happened first.
- [x] Bash vs a registered CLI tool is asked of the registry, not a list. It
      matches GROUP names, so `ls` (which is `file ls`) has no shim and a real
      `ls -la` is correctly a terminal.
- [x] Everything persists because nothing is cached: every surface is re-derived
      from the whole history, so the terminal's text only ever grows at the end.
      Verified in the user's exact sequence — `ls -la` and its output still above
      `$ git status --short` after a file write in between.

## 4. Edits animate as an edit, not as a diff being written  ✅ DONE

- [x] The tab shows the file, waits for the tool's arguments to finish arriving
      (half an `old_string` would animate a delete of the wrong text), scrolls
      the edit site to centre, forward-deletes with the caret parked at the head
      of the span, and types the replacement from that same offset — so "starts
      exactly where the delete ended" is not a special case but the only place
      it could start. Capped so a 4,000-character replacement finishes in 1.4s
      instead of 20, scaling every duration by the same factor so the motion
      keeps its shape. No second animation system: the schedule produces text,
      and that text goes through the same reconcile a file being written does.

## 5. Media generation never goes to the canvas  ✅ DONE

- [ ] Image / video / audio / media generation tools **do not open a canvas tab**.
      They render **inline**, as the large card — the same card its studio shows.
- [ ] Custom generating animations per modality, until real diffusion steps land:
      - image (and probably video): the **Bobble logo as the loader**, squares
        sliding clockwise like a sliding-tile puzzle;
      - audio: **pulsing waveforms** that resolve, at the end, into the real
        playable waveform.
- [ ] The moment diffusion steps exist, show them — the image unblurring live as
      soon as it resembles anything at all.

## 6. The "Starting up" pill must mean something  ◐ MOSTLY DONE

*Screenshot: the new-chat screen — "Bobble / How can I help you today?" — with a
pill overlapping the subtitle line reading "◌ Starting up — usually about 2s on
this Mac · 0:01". A hand-drawn red arrow points up at it: move it up.*

- [x] Moved off the subtitle: the space is reserved above the card, so the pill
      cannot move the card when it appears and cannot collide with anything
      added there later.
- [x] **True of TTFT.** It waited 700ms before saying a prime was running — the
      exact window a send lands in. It now uses the rate this machine has
      measured for this model: a prime the numbers say will be FELT announces
      itself at once; one too short to perceive keeps the anti-flicker delay,
      and so does an unmeasured one (guessing "slow" would flash a pill on
      every keystroke).
- [x] Attachments show their own loading **in the composer** while they are
      tokenized and prefilled, and it clears when they are.
- [ ] REMAINING: the spinner does not survive **send** — the chips leave the
      composer with the message, and the copies rendered in the thread
      (`ChatThread.tsx`, `data-testid="user-attachments"`) carry no prefill
      state. the user called this one a "maybe"; the turn's own prefill progress is
      already shown in the thread, so this is about putting it on the chips.

## 7. Kill the pinned "Writing svg-icon in the panel" line  ✅ DONE

*Screenshot: a lone grey line at the bottom, "◌ Writing svg-icon in the panel →
· 1.6s" — the timer keeps resetting and it shows nothing useful.*

- [x] Deleted, not hidden — both complaints were structural: it was pinned
      because the one status indicator sits at the foot of the thread, and its
      clock reset because the timer re-arms whenever the timing flips, which a
      run of short streaming tabs does per file. A probe now asserts it stays
      gone while the column still names what is happening.

## 8. Edit/write tool calls show as errors  ✅ DONE

*Screenshot: a `file-icon.svg` canvas tab, Rendered/Raw toggle, showing
`file-icon.svg +11 −18` with a large red (removed) block and a green (added)
block below it.*

- [x] Nothing was ever misclassified — the diff was fake. Both places that draw
      an edit listed EVERY line of `old_string` as a deletion and EVERY line of
      `new_string` as an addition, and a `str_replace` quotes its surroundings
      to make the match unique, so a two-line change arrived as nine deleted and
      nine added. A real line diff, shared by both so they cannot drift: the
      same fixture goes from 210px of red at `+9 −9` to 47px at `+2 −2` with
      seven untinted context rows.

---

## Standing constraints these must respect

- No purple anywhere.
- Never take the user's screen; headless by default, prove it with a focus guard.
- Reproduce → fix → re-reproduce → LOOK, for anything visual.
- Report only when done; every report carries a UI/UX table and a harness table
  and says which BUILD a claim refers to.
