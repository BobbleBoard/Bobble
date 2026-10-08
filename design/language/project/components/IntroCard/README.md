The first time a feature is used: a centred card with the feature's demo on top, what it does, and Got it bottom right.

Build it from `.bb-scrim` (the window dimmed under `scrim` with an 8px blur) holding a `.bb-intro` in the feature's hue. Inside it go `.bb-intro__stage` (the demo, inset 8px on the hue's wash, 236 tall), then `.bb-intro__body` (an eyebrow with the feature's name, `.bb-title--s` saying what it does for you, and `.bb-intro__text` with one or two sentences), then `.bb-intro__foot`. The foot holds one `.bb-btn--primary` reading "Got it", and optionally a `.bb-btn--quiet` second step on the left.

- Show it once, the first time the feature opens or is asked for; Got it, Escape or a click outside close it for good.
- Never two in a row. A tour is not an intro card.
