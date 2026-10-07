# Pictures

A picture explains a thing at a glance: a doc, a deck, a month, a model. It is drawn, not screenshotted, from a small set of parts in `bundle.css`, inside a `.bb-scene` that sets its hue.

## Choose the hue by the subject

| The picture shows | Hue | Scene class |
|---|---|---|
| Words or numbers: a doc, a sheet, mail, a calendar, a chart | teal | `bb-scene bb-hue-teal` |
| Pictures or pages: an image, a design, a deck | sun | `bb-scene bb-hue-sun` |
| Something that moves: a video, an animation, a 3D model | pink | `bb-scene bb-hue-pink` |

One hue per picture. Setting a second hue inside a scene is wrong, except in a segmentation, where each part takes its own colour (the Parts demo).

## The parts

- **Frame** (`.bb-frame`): the surface a picture sits on. `--lift` for the one in front, `--wash` for a number or a scene on the hue's tint, `--hero` for a large card, `.bb-window` for an app a demo drives.
- **Title** (`.bb-title`, `--s`, `--l`): the one piece of real type, in Fraunces, softened. Give every picture a short, concrete title ("Launch plan", "October", "Desk lamp").
- **Lines** (`.bb-lines` > `.bb-line`): words. Lines are 8 high on gaps of 8, groups 20 apart, and the last line of a group is short (40 to 70%). `--strong` for a heading line, `--hue` for a link.
- **Tile, dot, pill** (`.bb-tile`, `.bb-dot`, `.bb-pill`): marks, buttons, swatches. `--tint`, `--ink`, `--line`, `--lift` change the fill.
- **Picture plate** (`.bb-picture`): a made image. Two hills (tiles turned 45°, the back one at 55%) and a sun. In dark, the sun takes the hue.
- **Bars and lines** (`.bb-bars` > `.bb-bar`, `.bb-spark`): numbers. A bar is a tile standing on the baseline: tile corners on top, square at the foot. `--quiet` outlines it. A line is 3.5 wide with nodes only where the story is.
- **Cells** (`.bb-cells` > `.bb-cell`): days and sheet cells. `--mark` for a marked day (hue, `on-hue` numerals), `--soft` for a lighter one, `--head` for weekday letters, `--sheet` for a spreadsheet cell. Today is a ring, never a fill.
- **Selection** (`.bb-selected` on a line group): each line takes its own tint, like selected text.
- **Chip** (`.bb-chip`): the glass pill that offers an action on a selection, below it and never over it.
- **Cursor** (`.bb-cursor` holding the Cursor drawing; `.bb-status` for the pill): who is acting. Yours is plain. Bobble's has the blue edge glow.

## Composition

- One subject per picture, centred, with the frame's padding around it.
- Show the real shape of the thing: a deck is landscape, a doc and a phone design are portrait, a sheet has a header row.
- Leave out chrome that says nothing: no scroll bars, no traffic lights in colour, no fake menus.
- Captions under a picture are `bb-caption`: the kind, in a word or two ("Doc", "Deck").
