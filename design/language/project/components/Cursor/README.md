Whose hand is on the controls: the one cursor drawing, plain for you and with the agent's blue edge glow for Bobble.

Paste the drawing from the Cursor assets (`cursor.svg` for yours, `agent-cursor.svg` for Bobble's) inline inside a `.bb-cursor`, because an `<img>` would clip the glow. The wrapper is placed by the tip and scales about it. A press is a 150ms squeeze to 0.78 and back; there is no ring or ripple. While Bobble acts, a `.bb-status` pill inside the wrapper names the action ("Typing", "Clicking", "Scrolling"), never its contents.

- Do copy the drawing; never draw another arrow.
- Do not use `agent` blue anywhere but the cursor and its pill.
