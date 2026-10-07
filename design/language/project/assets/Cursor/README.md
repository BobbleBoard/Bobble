The one cursor drawing, from packages/shared/src/agent-cursor.ts (the user's path, keyline and glow), at its real size of 25.3px tall.

- `cursor.svg`: yours. A black body `#0A0B0F` under a white keyline, with a soft shadow.
- `agent-cursor.svg`: Bobble's. The same, plus the blue edge glow `#2769EF` at 36%.

Paste them inline inside `.bb-cursor`: the glow and the shadow spill past the box, and an `<img>` would clip them. The tip sits 1.53px right and 0.92px down from the box's corner.
