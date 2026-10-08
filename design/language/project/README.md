Bobble's design language: how a picture, a demo or a card is drawn, so that every one of them looks like it came from the same place. It sits on the app's own surfaces (the Apple-frosted neutrals, the system face, the shipping radii and shadows) and adds the three things the app had no rule for: what a picture is made of, what colour it is, and how it moves.

## Principles

- **Three tiles.** Everything drawn is built from the mark's square (`radius-tile`, a corner of 28% of the side), the dot it rounds into, and the pill it stretches into. No other shapes: no circles-with-icons, no blobs, no gradients.
- **One hue per picture.** A picture takes exactly one of `teal`, `sun` or `pink`, chosen by what it shows (below), and everything inside it follows that hue. The three meet only in the mark, on the cover and in a segmentation, where colour is the point.
- **The rest state is the picture.** Motion runs from an earlier state into the static styles. With Reduce Motion nothing moves, and what shows is the result: the marked month, the rewritten paragraph, the button already done.
- **Copy, never draw.** The mark, the app icon, the cursor and every icon are copied from the app's own files (Logos, Cursor and Icons assets). A connector's icon is its official mark. Nothing is reconstructed from memory.
- **On this Mac.** Bobble runs locally, and the language says so: every card that names where something lives says "On this Mac".

## Colour

- **Neutrals carry the interface.** Set the window on `ground`, cards and frames on `surface`, wells and fields on `surface-sunken`, menus and chips on `overlay`. Text is `ink`, then `ink-secondary`, then `ink-muted` for metadata; all three hold 4.5:1 on `ground` and `surface` in both themes.
- **Hues carry pictures, never text.** `teal` is words and numbers: docs, sheets, mail, the calendar, charts. `sun` is pictures and pages: images, designs, decks. `pink` is things that move: video, animation, 3D. Use a hue as a fill, a bar, a tile, a ring. Text in a hue's colour uses its `-ink` (`teal-ink`, `sun-ink`, `pink-ink`). Text on a hue fill is `on-hue` in both themes. White on a hue fails.
- **Tints are washes.** `teal-tint`, `sun-tint` and `pink-tint` sit behind a picture (a plate, a wash frame, a selection), never behind body copy.
- **The agent's blue is its cursor's.** `agent`, `agent-pill` and `on-agent` belong to Bobble's cursor glow and its status pill and nowhere else. A picture never uses them as a fourth hue.
- **Accent and focus are teal.** `accent` is `teal-ink` in light and `teal` in dark; `focus` is `teal-ink`, a solid 2px ring that holds 3:1 on every surface. State colours (`success`, `warning`, `danger`) always come with a word or a glyph.

## Type

- **Two faces.** Fraunces (display) names things: a picture's title, a page head, a greeting. It is always softened, `SOFT 100` and `WONK 0`, which `bundle.css` sets on every display class and `.bb-title`. The system face (`ui`) is for everything read and touched.
- **Display sizes:** `display-xl` for the one line that introduces a screen, `display-l` for a screen title, `display-m` for the title inside an illustration, `display-s` for a small card's heading. Never set body copy in Fraunces, and never set Fraunces below 20px.
- **Interface sizes:** `title`, `heading`, `prose` for reading, `body` for interface text, `label` for controls, `caption` for metadata, `eyebrow` for a section's kicker, `code` in the mono face.
- **Numerals are tabular** wherever they line up: dates, prices, table cells.

## Shape, space, depth

- **Radii:** `radius-xs` 5 and `radius-sm` 7 for small controls, `radius-md` 10 for fields and plates, `radius-lg` 14 for cards and frames, `radius-xl` 18 for a hero card, `radius-full` for pills, `radius-tile` for anything drawn.
- **Space** runs on 4: `space-1` to `space-16`. A frame pads `space-6`; a hero frame pads `space-8`.
- **Depth is grounded:** a 1px `hairline` ring plus `shadow-sm`, `shadow-md` or `shadow-lg` (the one in front). Floating glass (chips, toolbars, menus) is `overlay` with a blur, an `edge` ring and `shadow-popover`. No borders as decoration, and never a coloured left border.

## Pictures

Words in a picture are lines (`.bb-line`), never lorem ipsum. Only a title is real type. A made image is a plate with two hills (tiles turned 45°) and a sun. A number is a bar standing on a baseline or a line through nodes. A day or a cell is a tile. See **Pictures** for the full grammar.

## In the app

Two cards teach a feature where it lives. An **intro card** (`.bb-intro` on `.bb-scrim`) opens centred the first time a feature is used: the feature's demo on top, its name, what it does for you, and "Got it" bottom right. A **pop-out** (`.bb-popout`) opens beside the control it explains, on hover or on first sight, with a notch facing that control: a demo, a title, a line, and a small "Got it". On a connector's page, **Try it** plays its sample ask through to the answer. The In the app cards show each in place on the real app, photographed headless (Backdrops).

## Motion

Seven curves, one per verb: things arrive on `ease-settle`, the cursor glides on `ease-glide`, tiles slide on `ease-slide`, placed marks land on `ease-bob`, colour changes on `ease-standard`, things leave on `ease-exit`, and presses use `ease-press`. A demo loop shows one verb, runs at most `duration-loop` (4.8 s) and rests `duration-hold` on its result. See **Motion**.

## Voice

Bobble's interface talks plainly, in sentence case, to "you", and calls itself Bobble. It says what is happening and where, then stops. From the app:

- "What runs next on this Mac, and what already did."
- "Scheduling is off — nothing fires until it is back on."
- "Runs on a local Python engine. Bobble installs it for you."
- "Getting ready — usually about 8s on this Mac"
- "Delete for good?"

Separate facts with a middle dot ("Deck · On this Mac", "Built in · always on"). Name an action by its verb ("Open", "Turn on", "Edit with Bobble"). No emoji, anywhere. No exclamation marks. Numbers are numerals.

## Iconography

- **Glyphs** (`glyph-*` in Icons) are the app's 24-grid Hugeicons set: stroke 1.5 at 24px, round caps and joins. They mark places and tools: sidebar rows, studios, menu items.
- **Icons** (`icon-*` in Icons) are the app's 16-grid set for controls: check, close, copy, share, pencil, chevrons. Draw them 16px inside a 32px target, `ink-secondary` at rest and `ink` on hover.
- **The cursor** is one drawing (Cursor assets). Yours is the plain drawing. Bobble's adds the `agent` edge glow and, while it acts, the status pill, which names the action ("Typing", "Clicking") and never what is typed.
- A connector's own icon is its official mark, copied, on a `surface-sunken` tile. Without one, use a glyph from the set. Never draw a brand.
