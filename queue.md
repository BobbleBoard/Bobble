# Queue — round 21 (from the user, 2026-09-07 ~20:55)

Everything here was queued while computer use was being finished. Order below is
the user's, not mine. He said: "you have a whole night to do it and produce that
video, you can take your time with all of it."

**Do the video first, then this file.**

Six screenshots came with the message. They could not be written to disk from
the conversation, so each is described where it belongs — precisely enough to
act on without them.

---

## 0. Immediate, said in the same breath as the video

- [ ] **Do not blur the wallpaper** in the computer-use monitor. It is currently
      blurred + dimmed behind the window. Show it as it is.
- [ ] **Always show the fake cursor**, even idle. the user: "looks nice and makes it
      feel like 'this is the model's computer.'"
- [ ] **Recording should be available.** He granted the permissions, double
      checked, restarted — and Bobble still asks. There are "a lot of permission
      re-popups in bobble even after I totally have provided the permissions".
      Find secondary ways to get the recording; do not make him fight TCC.

---

## 1. Rendering error — unacceptable, top priority after the video

*Screenshot: the whole Bobble window replaced by "Bobble hit a rendering error /
The window stopped drawing. Your chats are on disk and were not affected.",
with `Minified React error #185` in a code box and two buttons, "Reload" (blue)
and "Reload with a fresh window". Menu bar reads Bobble · Edit · View · Window,
8:53:28 PM.*

- [ ] React error #185 is "maximum update depth exceeded" — an effect/setState
      loop. Find it and kill the cause; this must not happen at all.
- [ ] **The Reload buttons do not work.** He has to press ⌘R, which "clears
      really everything".
- [ ] ⌘R should NOT do that hard clear. Replace it with a safe reload we control
      — one that restores the chat, the canvas tabs and the scroll position.

## 2. Canvas tabs — floating, not connected

*Two screenshots of a dark tab strip, four "New Tab" items. Today the selected
tab is joined to the content area by a border that runs up and around and back
down the other side; hovering an unselected tab draws the same connected shape
with a ✕ appearing.*

- [ ] Tabs float. Only the selected tab gets a surround, and it does not connect
      downward into the content border.
- [ ] Hover shows a floating highlight, not the connecting-downward treatment.

## 3. One "Activity" tab, not tab spam

- [ ] The model doing many things must not open many tabs. **One tab, "Activity"**.
- [ ] The canvas opens to Activity on the first tool call that has anything to
      show, and from then on Activity *switches* to whatever is happening:
      a file edited → that file; a file written → that file; something in the
      browser → the browser; a bash command → a terminal.
- [ ] Bash only counts when it is really bash — if the command starts with a
      registered CLI tool name, it is that tool, not a terminal.
- [ ] **Everything persists.** The terminal keeps its history: `ls -la` and its
      output stay visible above the next command as that one is typed. Switching
      away and back keeps the state of every past one.

## 4. Edits animate as an edit, not as a diff being written

- [ ] Do not stream the diff. Show **the file**, then:
      1. the negative side deletes live (forward-delete, animated the way
         writing is animated),
      2. then the replacement types in, starting exactly where the delete ended.
      One smooth line: delete, then type.

## 5. Media generation never goes to the canvas

- [ ] Image / video / audio / media generation tools **do not open a canvas tab**.
      They render **inline**, as the large card — the same card its studio shows.
- [ ] Custom generating animations per modality, until real diffusion steps land:
      - image (and probably video): the **Bobble logo as the loader**, squares
        sliding clockwise like a sliding-tile puzzle;
      - audio: **pulsing waveforms** that resolve, at the end, into the real
        playable waveform.
- [ ] The moment diffusion steps exist, show them — the image unblurring live as
      soon as it resembles anything at all.

## 6. The "Starting up" pill must mean something

*Screenshot: the new-chat screen — "Bobble / How can I help you today?" — with a
pill overlapping the subtitle line reading "◌ Starting up — usually about 2s on
this Mac · 0:01". A hand-drawn red arrow points up at it: move it up.*

- [ ] Move the pill up, off the subtitle, on the new-chat screen.
- [ ] Make it **true of TTFT**: while it is showing, the conversation is not yet
      prefilled. When it disappears, everything up to what he has typed so far is
      already prefilled and will not be prefilled again — the next send only has
      to prefill the new message plus its attachments.
- [ ] **Attachments show their own loading** while they are tokenized and
      prefilled, in the composer, while he is still typing. The spinner can
      persist past send; it clears when that attachment is prefilled.

## 7. Kill the pinned "Writing svg-icon in the panel" line

*Screenshot: a lone grey line at the bottom, "◌ Writing svg-icon in the panel →
· 1.6s" — the timer keeps resetting and it shows nothing useful.*

- [ ] Remove it. It is pinned to the bottom, the elapsed time resets, and it
      tells him nothing.

## 8. Edit/write tool calls show as errors

*Screenshot: a `file-icon.svg` canvas tab, Rendered/Raw toggle, showing
`file-icon.svg +11 −18` with a large red (removed) block and a green (added)
block below it.*

- [ ] "editing/writing tool calls a lot of the time show up as red". Find why a
      successful edit renders as a failure and fix it.

---

## Standing constraints these must respect

- No purple anywhere.
- Never take the user's screen; headless by default, prove it with a focus guard.
- Reproduce → fix → re-reproduce → LOOK, for anything visual.
- Report only when done; every report carries a UI/UX table and a harness table
  and says which BUILD a claim refers to.
