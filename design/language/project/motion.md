# Motion

Bobble moves to show what something does: a demo plays the verb once, then rests on the result. It never moves to decorate.

## One verb per loop

A demo shows one action. "Edit" selects lines, asks, and the lines come back rewritten. "Book" types into a field and presses the button. "Plan" lands marks on a month. If a loop needs two verbs, it is two demos.

## The beats

- **Arrive** on `ease-settle` over `duration-beat` (480ms): frames, sheets, a line growing.
- **Glide** the cursor on `ease-glide` over `duration-travel` (300ms), then **press**: a 150ms squeeze to 0.78 about the tip and back, with no ring and no ripple.
- **Slide** a tile on `ease-slide`: firm, no bounce. A tile in a frame has nowhere to overshoot to.
- **Place** a mark or a chip on `ease-bob`, the one curve that overshoots. Tiles and dots only.
- **Change colour** on `ease-standard`. **Leave** on `ease-exit`.

A loop runs at most `duration-loop` (4800ms) and holds its result for about `duration-hold` (1400ms) before it starts again. A demo set in the app may run to 6.4 s when it tells a conversation or a hover (Try it, a pop-out opening and closing); its hold is at least 1.8 s, because words need reading time. Stagger along the diagonal (row plus column) at 70 to 110ms a step, so marks arrive as a wave rather than all at once.

## The mark's puzzle

The mark moves one way only: as a sliding-tile puzzle (`.bb-mark--slide`, the Slide card). Only the tile beside the hole moves, only into the hole, one slide per `duration-slide` beat, and twelve beats bring every tile home. It means "making": a picture being drawn, a model loading. Nothing else uses it.

## The rules a loop keeps

1. **The static styles are the result.** Write the finished state as the plain CSS, and the animation as a journey into it. Reduce Motion (`prefers-reduced-motion`) turns every animation off inside `.bb-scene`, and the result is what shows.
2. **Delays fill backwards.** Any element with an `animation-delay` uses `animation-fill-mode: backwards`, or it shows its finished state while it waits.
3. **Layout never animates**, except a typed line's width, so the caret can ride its end.
4. **The cursor is the only thing that travels far.** Everything else moves less than a tile.
