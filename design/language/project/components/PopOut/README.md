A card that comes from what it explains: it opens beside a control on hover or on first sight, with a notch facing the control.

`.bb-popout` with a direction (`--left` is the "<" for a rail or sidebar row; `--down`, `--up`, `--right`) and `--notch` set to the control's centre along that side. Inside: `.bb-popout__stage` (the demo, inset 6px, 136 tall), `.bb-popout__body` with `.bb-popout__title` and `.bb-popout__text`, and `.bb-popout__foot` with a small "Got it" (`.bb-btn--primary.bb-btn--s`). It opens out of the notch with a 180ms settle from 0.94 (`bb-pop-in`).

- Sit 10px clear of the control; never cover the control itself.
- Got it closes it for good; moving away closes it until next time.
