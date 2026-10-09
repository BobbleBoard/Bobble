# Connectors — design review

Two surfaces, kept apart throughout: the **shipping screen** (`apps/desktop/src/connectors/`, what the user sees from the sidebar) and the **candidate**, Shelf+ (`apps/desktop/src/candidates/connectors/`, behind `?candidates=connectors`). References: the 24 screenshots in `~/Desktop/refs/connectors/` (cited as `r0705` = `Screenshot 2026-09-07 at 12.07.05 AM.png`). Frames cited as `ship-*` / `cand-*` are from **this review's own drive** — `src/candidates/connectors/review-probe.mjs`, run headless on 2026-09-07 against the renderer-only dev server with the same fixture home and MCP shims `shots.mjs` uses — and live in `src/candidates/connectors/shots/review/`, with the numbers the frames cannot carry (timings, focus order, computed sizes, measured hover lifts) in `measurements-*.json` beside them. The three earlier rounds' verdicts (`NOTES.md`, `JUDGEMENT-R3.md`, `JUDGEMENT-R4.md`) were read as claims and re-tested by driving, not by re-reading their images; where a claim did not survive, it is said in the relevant item.

Both surfaces were driven at Bobble's shell width (a 1440 window minus the 288px sidebar = 1152px of content; the candidate route renders full-window, so it was set to 1152 directly), plus 1440, ~900 and ~640, in the default Bobble flavour, light and dark. The focus guard in the e2e harness passed on every run: nothing took the screen.

### The ideal, before looking

Written before opening any reference image, any screenshot, or any source file for either surface. Only the brief was known: Bobble is an offline local-AI desktop app; this surface is where a person manages what the assistant can reach (MCP servers, skills, plugins); the user's brief says no purple, and the user dislikes "separate and convoluted menus for plugins/connectors/skills".

**What the surface is for.** A person opens Connectors to answer one of four questions, in this order of frequency: *what can my assistant reach right now, and is any of it broken?* — *how do I give it one more thing?* — *why did that tool call fail?* — *turn this one off (for this chat / for good)*. The first answer should be readable in under a second from the list alone; the second should be one paste and one click; the third should be one click on the failing row; the fourth should be a switch on the row.

**One model, not three menus.** Servers, skills and plugins are all "things the assistant can use". The ideal shows one list with one row shape (icon, name, one-line description, status, enabled switch), and the kind is a facet — a small tag on the row and a filter chip at the top — never a separate navigation tree. A person should never have to know whether the thing they want is "a plugin" or "a connector" before they can find it.

**Status carried by the row.** Every row shows a state a glance can read: running (tool count), starting, stopped, needs sign-in, failing. Failing is not a red dot; it is the reason in plain words on the row itself ("`uvx` is not on PATH", "exited with code 1 — see log"), and a single fix action where one exists (Retry, Sign in, Open log, Edit). Status changes in place; the row never jumps or re-sorts under the pointer.

**Adding is a paste.** One primary "Add" that accepts whatever the person has copied from a README: a command line, a URL, or the `{"mcpServers": {...}}` JSON blob every project ships, and works out which it is. The form is then pre-filled: name (derived, editable), transport (detected, visible), command + args or URL, environment variables collapsed until needed, and a scope (this project / everywhere). Before committing, a **Test** actually launches or connects and lists the tools it found — this is the moment worth screenshotting, the tools appearing one by one under the form. Submitting empty shows the error at the field, in place, without moving anything else; the primary button is not disabled as a substitute for telling the person what is missing. Escape closes, Enter submits, focus lands in the first field when the dialog opens and returns to the Add button when it closes.

**After adding.** The new row appears in the list in a "connecting" state and resolves to its tool count where it stands. Nothing reloads.

**Detail is the tools.** Opening a row shows the tools that thing exposes (name, one-line description), each individually toggleable, with the prompt cost of what is enabled — this is a local app where every advertised tool is paid for in prompt tokens on every turn, so the cost is a first-class number, not a footnote. Then: last error and a log, Restart, Edit, Remove (confirm inline, not a second modal). For a remote server, the sign-in state and a Sign out.

**The states nobody designs.**
- *Empty*: not a blank pane — one sentence saying what a connector is, and three or four starters that work fully offline (filesystem, git, a local database, a fetch-through-local-browser), each one click to add.
- *One item*: the same list, no special case, no "you have 1 connector" copy.
- *Hundreds*: a search field that is always present (not revealed by a button), status grouping (failing first), keyboard up/down through rows.
- *Failing*: as above — reason on the row, fix action on the row.
- *Half-configured / draft*: a server saved without required values shows "needs setup" and opens straight to the missing field.
- *Offline*: local stdio servers are unaffected and say nothing; remote ones show "unreachable" with a last-seen time and do not spin forever.

**Day 200 without a control panel.** Edit-as-JSON for the whole config, per-chat enablement, import/export, per-tool allow/deny, env editing, and the token budget — all reachable, all behind one "Advanced" disclosure or a secondary menu on the row, none of it in the primary path.

**Feel.** Instant and quiet. Bobble's default is an Apple-frosted look, so the surface should feel like a Mac System Settings pane that a good product team took over: dense but airy, one accent, no gradients doing marketing work, no purple anywhere. Dialogs fade and scale in over ~150 ms and do not pop. Hover states exist on every row and every button and are subtle. Focus rings are visible, one style, everywhere. Copy uses the person's words ("server", "sign in", "tools") and keeps "MCP" for the place the person will actually type it.

**What would get it screenshotted.** The Test moment (tools discovered, appearing in place), a list with real product icons and readable status, and the cost meter — a small honest number that no cloud product shows because they do not have to.

### The references

Every one of the 24 was opened as an image, one at a time. Two products: ChatGPT (Plugins / Skills; `r0240`–`r0504`) and Claude Desktop (Connectors / Directory / Plugins; `r0705`–`r0952`).

**ChatGPT.**
- `r0240` Plugins, light, mid-search. The kind is a **tab** ("Plugins | Skills"), not a settings page. Full-width search; results grouped by publisher. Row = 56px icon tile, 17px name, 15px grey line, one right-aligned action. Hover is a soft grey card behind the row. *Bad:* "Install" as borderless grey text has almost no affordance; a spinner, a label and a tooltip all saying "Loading".
- `r0317` The composer with an inline skill chip. Not a management surface, but it says where a skill *goes*: the composer. Worth remembering when judging what a skill row needs to promise.
- `r0352` Plugins, dark. **"Installed ›" is a strip of six bare icons** — the installed set glanceable in one row. "+" to add, "…" when installed. "See Health, Trello, and more" with a three-icon cluster is a good overflow. *Bad:* pure #000 flattens every card; the strip needs a hover to learn which is which; an unexplained sparkle badge on some icons.
- `r0405`, `r0409` Slack listing. Big icon, 40px title, tagline, white "Try in chat" pill, then a gradient hero card with a mock conversation and an *Information* label/value table. Spends its space on marketing — this is a store listing. *Bad for Bobble:* a hero is dead weight for a server you added yourself; "Website" is an icon with no URL.
- `r0424` The "…" menu: **Manage / Uninstall (red), a divider between**. Minimal and right.
- `r0428`, `r0439` Settings › Plugins › Slack — a *second* surface for the same plugin, reached by "…" → Manage. **Tools named in words** ("Get reactions on a message"), described, grouped Read / Write, a chevron per row. *Bad:* the listing page and the manage page are two places for one thing — exactly the convolution the user named; names inconsistent ("Slack list starred items"); descriptions cut mid-word; no per-tool toggle; "Created at May 6, 2026 at 9:27 AM".
- `r0453`, `r0504` Higgsfield listing. One clear primary ("Install plugin"); a plugin's skills as **chips with "5 more"**. *Bad:* a hero carousel clipped at the right with no scroll cue.

**Claude Desktop.**
- `r0705` Settings › Connectors. The settings sidebar has **Skills, Connectors and Plugins as three separate rows** (the user's complaint, in the picture). "Popular" as three compact chips with Connect; **filter chips All / Connected / Not connected**; a calm hairline table Connector / Type / Status. *Bad:* "Type" (Web / Desktop) is a column nobody filters by; Status mixes a glyph with a button; Popular duplicates two rows already in the table; no descriptions, no tool counts; the lower 60% is empty.
- `r0720` "Add ▾" → Browse connectors / Add custom connector. *Bad:* browsing hidden under "Add".
- `r0725` "Add custom connector". **Help text with a concrete example under each field** ("https://mcp.example.com/mcp"); one primary. *Bad:* remote-URL only — no stdio, the case a local app lives on; two paragraphs of trust copy inside an add form; the disabled Continue gives no reason; **focus lands on the Close button first** (the blue ring is on ✕).
- `r0733`, `r0740` Directory. Full-width search with a focus ring, "Filter: All", category sections with "Show all N →". **A complete card**: 96px icon tile, name + verified, two-line description, one 40px "+" — or a **green ✓ tile when already connected**. *Bad:* "2419" is a number for the company; 150px cards so twelve fit; the settings sidebar stays and eats 320px.
- `r0752`, `r0759`, `r0804` Connector detail (HyperFrames). A grey header band with a 144px tile, name, tagline, terracotta primary; **tools as bare snake_case chips**; the same trust box on every detail; small-caps metadata (CATEGORIES, CONNECTOR URL, ADDED, SIGN-IN: Required); Related connectors. *Bad:* tool chips with no description and no toggle; store metadata in the person's face; a useful fact (sign-in required) buried under metadata.
- `r0829` Upload local plugin. A drop zone, fine; *Bad:* a pink/red warning is the loudest thing in a dialog where nothing has gone wrong.
- `r0835` Plugins. A **project scope chip** (good idea); a four-column table with one row reading `Clangd lsp · — · 0 · 4/27/26`; search icon + Browse + Add for a one-row list; 90% empty.
- `r0854` Blender detail (installed). **"Enabled" toggle in words beside "Configure"** — good. *Bad:* an installed connector with no tools listed and no status; ~200px of nothing between the band and the toggle.
- `r0940`, `r0945` The "Directory" modal: a serif title in a sans app, a THIRD Skills / Connectors / Plugins nav, and **every plugin wearing the identical placeholder glyph** — a wall.
- `r0952` Plugin detail: name, byline, three lines, then ~90% empty. Says nothing about what installing adds.

**What both references are bad at — so it is not copied.** The same three nouns navigated three ways (Claude: settings rows + Connectors › Directory + a Directory modal; ChatGPT: listing page + manage page). **Not one frame shows a failure** — a server that would not start, an expired token, a missing binary; cloud products never have to. **Nothing says what enabling a thing costs** in prompt tokens. Claude's custom connector is remote-only. Tools are bare chips (Claude) or descriptions without a toggle (ChatGPT). Store metadata and marketing heroes where a local app has none.

**The ideas worth taking.** Claude's filter chips and hairline table (`r0705`); Claude's complete card and the green ✓ for "already yours" (`r0733`); ChatGPT's tools in words, described, grouped Read / Write (`r0428`) — plus a toggle each, which neither has; ChatGPT's installed strip as a one-row summary (`r0352`); Claude's help text with a concrete example under each field (`r0725`); Claude's scope chip (`r0835`); ChatGPT's two-item overflow with the destructive item in red (`r0424`); Claude's "Enabled" toggle in words beside Configure (`r0854`).

**Exemplars not provided, used for what the references leave out.** Because neither reference draws a failure, a stdio server, a per-tool toggle or a cost, I checked two products whose MCP surfaces do, from their current documentation (fetched 2026-09-07; I did not screenshot them): **VS Code's MCP Servers view** — per-server Start / Stop / Restart, "Show Output" for the failing log, a trust confirmation on first start, a tools picker that toggles individual tools, and an error indicator that leads to the log ("Selecting the error notification reveals a *Show Output* option"); and **Cursor's MCP settings** — enable/disable toggles per server, one-click install from a marketplace, and "MCP Logs" in the Output panel when a server fails. Neither shows prompt cost either; that item stands on the ideal alone.

### Verdict

**The shipping screen is not shippable as a design, and it is the one the user sees.** Driven rather than looked at, it fails the first three questions of the ideal: the first screen has nothing to act on (the first "+" is at y=991 on a 900px window; the page is 3,246px tall), a server that fails to start reads *"This connector exposes no tools."* in three different ways I could make it fail, a hand-added server's card is a dead click (no detail exists for it), a key-needing connector offers nowhere to type the key, and the Add-MCP-server dialog — the thing the user photographed — is an unpadded 320px column of five inputs whose labels touch the dialog's edges, that Enter cannot submit and that drops the keyboard on `<body>` when it closes.

**The candidate, Shelf+, is much closer to shippable and should be the base.** At the real shell width it is one list, one search, one grammar; its resting pane is the best idea on either surface; its setup card, its failure grammar (amber on the row, a dated line, a pill count) and its cached, humanised, split tool list are all better than both references. But the two earlier verdicts of "above the references" were too generous for a reason that is now plain: both judges worked from stills at 1440 full-window and never opened the dialog. **The candidate imports the shipping `AddServerDialog` unchanged** (`ShelfPlus.tsx:44`; `cand-add-dialog-light.png` is pixel-for-pixel `ship-add-dialog-empty-light.png`), so the entry point for the most common expert action was never designed on either surface — and that is where "very not on par" comes from. Beyond the dialog, driving found what stills cannot: Escape does nothing, a second click on the open card closes it, the list re-sorts under the open pane the moment a key is saved, a hand-added server cannot be edited, and 50 tools are listed with no way to turn one off and no word on what they cost.

So: fix the dialog (it is shared), fix the candidate's interaction gaps, port the candidate over the shipping screen. Do not spend another round on the shipping screen's own layout; every item in its work order below is either fixed by the port or is about the components the port keeps (the dialog, the permission dialog, the main-side handler).

### The work order

Ordered by impact, biggest first, within each category; categories ordered by impact too. Every item names the element, the current value, the wanted value, and the frame or measurement it was seen in. Items that apply to both surfaces are stated once and cross-referenced.

## Work order A — the shipping screen (`apps/desktop/src/connectors/`)

#### A · Failure and edge states

1. **A server that fails to start is reported as having no tools.** Turning GitHub on with an empty token (the fixture writes `GitHub API: 401 Bad credentials` and exits 1) shows *Tools — This connector exposes no tools.* (`ship-detail-github-on-failed-dark.png`); Memory made to exit before the handshake shows the same (`ship-detail-memory-failing-light.png`); Time, straight after pressing **Connect**, shows the same (`ship-detail-time-connected-dark.png`). `ConnectorDetail.tsx:133` stores `error` in state and lines 217–237 never render it; the list keeps the green *Installed* badge for the same server. This is the ideal's third question ("why did that tool call fail?") answered with a lie. **Change:** render the error where the list would be — the host's message plus the last stderr line (see B7 for the main-side half) — with an amber *Could not start* status in the header and on the card, and a *Try again* button; never print "exposes no tools" unless the server answered with zero.
2. **Key-needing connectors state the requirement and offer no field.** *Requires `GITHUB_PERSONAL_ACCESS_TOKEN`* under the command (`ship-detail-github-light.png` 523,463; `ship-detail-slack-needs-key-dark.png`); the only way to satisfy it is editing `~/.pi/desktop/mcp-connectors.json`. **Change:** a setup field in the detail (the candidate's `SetupSection` is the reference: key name, masked field, "stays on this Mac in …", one accent button that saves and turns on).
3. **The Connect permission dialog promises a sign-in that never happens.** `ship-permission-dialog-light.png`: a cloud consent sheet ("Data is shared with this app — Messages and files you use with Slack are sent to it", "Apps may introduce elevated risk") for a local stdio process that needs a token; the primary reads *Continue to Slack*; pressing it lands you back on the list with a grey *Disabled* badge and nothing else (`ship-after-connect-slack-dark.png`), and the detail then says *Requires `SLACK_MCP_XOXP_TOKEN`* with no field. It also opens with focus on **Cancel** (measured), draws a "P" placeholder where the app icon should be, and says *"Pi only shares…"* — the pre-rebrand name (`ConnectPermissionDialog.tsx:78`). **Change:** replace it with the setup step (item 2) reached directly from "+"; if a consent is kept for connectors that genuinely send data out, make it say the specific true thing ("Sends what you ask to api.slack.com with your token") and focus the primary.
4. **A hand-added server's card is a dead click.** Clicking the Weather card body does nothing; "View details" in its "…" menu does nothing; a catalog card opens fine (measured false / false / true; `ship-click-custom-card-dark.png`). `ConnectorsScreen.tsx:84–87` resolves the selection from `catalog` only, and hand-added servers live in `addedByYou`. There is therefore no detail, no tool list and no failure surface at all for the servers a person configured themselves. **Change:** resolve from `catalog ∪ addedByYou`; the custom detail shows tools, the real command, env keys masked, Edit and Remove (the candidate's `CustomSection` is the reference).
5. **Every open of an installed detail spawns the server again.** Both opens of Memory re-ran `connectors:tools` (92 ms and 103 ms against the instant fixture; a real `npx -y` is seconds) and both showed *Connecting to list tools…* first (`ship-detail-memory-loading-dark.png`). **Change:** list once when the server is turned on, cache with a "listed just now" caption and a Refresh (the candidate's tool cache is the reference).
6. **Remove has no confirmation and no undo.** One click on the header's *Remove* deletes a configured server and its keys: no dialog, the detail closes, the registry shrinks (measured; `ship-after-remove-dark.png`). **Change:** inline confirm in place of the button ("Remove GitHub? Its token will be forgotten. — Remove / Keep") or an undo toast; never a second modal.
7. **A name collision silently overwrites.** Adding a server named "weather" with command `python3` replaced the existing Weather (node) with no warning; the card renamed itself to lowercase *weather · Runs python3* (`ship-after-duplicate-dark.png`; registry before/after in `measurements-shipping2.json`). `idFromName` slugs the name into the id and `upsert` replaces. **Change:** on submit, if the id exists: "A server called Weather already exists — Replace it / Keep both (weather-2)".
8. **The detail describes the catalog template, not what is installed.** GitHub in the registry runs `npx -y @github/github-mcp-server`; the detail's *How it runs* prints `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-serve…` in a horizontally scrolling block, and *Transport: stdio · docker* (`ship-detail-github-light.png`). `ConnectorDetail.tsx:114` reads `connector.template`. A person who edited the JSON is shown a command that is not running. **Change:** read `installed ?? template`; wrap the command (`white-space: pre-wrap`, no horizontal scrollbar).
9. **A disabled switch is shown for a thing that is not added.** The Time detail before Connect draws the *MCP server* switch greyed out above *Add this connector to discover its tools.* (`ship-detail-available-dark.png`). **Change:** no switch until it is added; the primary is Connect.
10. **The search empty state is a sentence.** *No connectors match your search.* with the engine-mode control still above it and the disclaimer below (`ship-search-empty-dark.png`); no clear action. **Change:** name the query, a *Clear* button, and *Add MCP server* as the alternative (the candidate's empty state is the reference, `cand-empty-light.png`).
11. **The fresh install has nothing to do above the fold.** `ship-fresh-light.png`: six *Preinstalled · Official* cards fill the first screen; the first addable card is below it; no sentence says what a connector is. **Change:** one line of intro under the title and the addable starters first (see A-IA-1).

#### B · The Add-MCP-server dialog (`AddServerDialog.tsx` — shared by both surfaces; the candidate inherits every item here)

12. **The fields run edge-to-edge of a 320px dialog while the title is inset 20px.** Measured: dialog x=560 w=320; the Name input x=560 w=320; the title x=580. The fields are in a bare `<div className="flex flex-col gap-3">` (`AddServerDialog.tsx:127`) instead of `DialogBody` (which carries `12px 20px` padding); the `max-w-[520px]` class is on the content, but `.pd-dialog` has `min-width: 20rem` and no width, so the dialog collapses to its unpadded content (`ship-add-dialog-empty-light.png`, `-dark.png`). This is the frame the user photographed. **Change:** wrap the fields in `DialogBody`; give the dialog a width of 480px; the labels then align with the title.
13. **No gap between the title and the first label.** *Name* sits at y=206, the pixel the 22px title's box ends on; the header is `padding: 16px 20px 0` and the body has no top padding (same frames). **Change:** 16px between title and first field; 12px between a field's hint and the next label (currently 12 — keep).
14. **Five stacked fields with a hint sentence each, 576px tall, for a task that is usually one paste.** *Working directory — Optional.* is a hint that says nothing; *Environment* is a textarea at first sight; the dialog is taller than the setup card that replaces it in the candidate (`ship-add-dialog-empty-light.png`). **Change:** two fields visible — *Name* and one *Command* line that accepts `npx -y pkg args…` — with *Working directory* and *Environment* behind a *More options* disclosure, and hints only where they carry information ("Space-separated; quotes are respected" stays).
15. **No paste intelligence.** A README's `{"mcpServers": {…}}` blob pasted into Name is kept as a name (`ship-add-dialog-pasted-json-dark.png`); a full command line likewise. This is the second question of the ideal ("one paste and one click") answered with five fields. **Change:** on paste into any field, detect JSON (`mcpServers` / `command` / `args` / `env` / `url`), a command line, or a URL; fill the form; say what was detected under the command ("Detected: local process · npx").
16. **No remote transport.** The form is stdio-only; a URL has nowhere to go, while the catalog itself ships `mcp-remote` bridges. **Change:** a URL in the command line → remote (streamable HTTP / SSE), with the sign-in state shown on the row once added.
17. **Submitting empty says nothing.** The primary is disabled; Enter in the empty Name does nothing; no error text appears anywhere (measured: open true, disabled true, errorText false; `ship-add-dialog-submit-empty-dark.png`). **Change:** keep the button enabled; on submit with a missing field, an inline error under that field ("Enter the command that starts the server") and focus on it.
18. **Enter does not submit.** With every field filled, Enter in Arguments leaves the dialog open (measured false); there is no `<form>`. **Change:** a form element; Enter submits from any single-line field; ⌘↩ from the textarea.
19. **Focus is lost when the dialog closes — by Add, by Cancel and by Escape.** `activeElement` is `<body>` after all three (measured, both surfaces); the next keystroke goes nowhere. `DialogContent`'s restore-on-close exists but the trigger button was not the focused element when the dialog opened (a mouse click on macOS Chromium does not focus a button), so there is nothing to restore to. **Change:** pass the trigger ref explicitly and focus it on close; the "Add MCP server" button is the right place for the keyboard to land.
20. **The disabled primary is invisible as a primary.** *Add server* disabled is transparent (measured background `rgba(0,0,0,0)`) with grey text; *Cancel* beside it is the heavier control (`ship-add-dialog-empty-dark.png`). **Change:** disabled primary = the accent at 40% opacity ("primary, waiting"); the candidate's *Save and turn on* already does this.
21. **After Add, nothing tells you whether it works.** The dialog writes the registry and says *Its tools become available in your next chat.*; the card appears with a green *Installed* badge (`ship-added-row-dark.png`) whatever the command was. **Change:** a *Test* button in the dialog that spawns, lists and shows the tools inline before Add (the ideal's screenshot moment), and the tool count on the card after.
22. **The dialog enters translucent over the list.** At 80 ms of the entrance the list's text is legible through the form (`ship-add-dialog-enter-080ms.png`); at rest the surface is 66% opaque with backdrop blur (measured `color(srgb … / 0.66)`). **Change:** fade the overlay in before the dialog, or enter the dialog opaque and let only the scrim fade (the candidate applied exactly this rule to its sheet).
23. **The Environment textarea shows a native resize grip** in its bottom-right corner (`ship-add-dialog-empty-light.png` ≈ 875,632). **Change:** `resize: vertical` with the app's own grip, or `resize: none` and auto-grow.
24. **Placeholders look like values.** *Weather*, *npx*, *-y @acme/weather-mcp*, */Users/you/projects/weather* in the fields, at a grey close to the input text in light (`ship-add-dialog-empty-light.png`). **Change:** placeholders name the field ("Name", "Command"); the example lives in the hint.
25. **Tab order puts ✕ after Cancel.** Name → Command → Arguments → Working directory → Environment → Cancel → Close → Name (measured); Shift+Tab from Name lands on the close button. **Change:** the close button first in DOM order (or `tabindex="-1"`, since Escape does the same job).
26. **Copy:** *Also becomes the tool prefix* is developer-speak. **Change:** "Its tools will be called weather_…" once a name is typed.

#### C · Information architecture

27. **The first screen is provenance, not state.** Sections are *Added by you (1) / By us (6) / Recommended for you (4) / Official (16) / More connectors (10)* (`measurements-shipping.json`: y=262 / 454 / 950 / 1290 / 2538); the fold at 900px shows one hand-added card and six *Preinstalled* built-ins; the first "+" is at y=991; the page is 3,246px tall (4.1 screens). No reference sorts by who made it; the ideal's first question is "what is on and is any of it broken?". **Change:** one list sorted needs-attention → on → off → available, each group capped at 8 with a *Show all N* row, built-ins collapsed (the candidate's `groupItems` is the reference); search results with no section headings.
28. **Skills are a second surface.** A *Tools | Skills* tab, a second search, a second empty state and a second detail (`ship-skills-light.png`, `ship-skill-detail-dark.png`), and the *Add MCP server* button stays on the Skills tab where it means nothing. This is the user's complaint at small scale. **Change:** one list; *Skills* is a filter pill; a skill's card carries its switch.
29. **The engine-mode control sits in the browsing path.** *How connectors run · Lite / Native / Bash CLI* plus a sentence, between the search and the first card on every visit (`ship-list-light.png` y=196–228), and three Tab stops before the first card (measured order: Lite, Native, Bash CLI, then the first card). **Change:** move it to the end of the list or a pane footer; keep the one-sentence explanation there.
30. **"Official" on 25 of 37 cards, including all six built-ins Bobble wrote.** Measured; `ship-list-light.png`. A badge on 68% of items is texture, and *Official* on Calendar/Mail/Messages is untrue in the sense the word carries elsewhere (the vendor's own server). **Change:** no badge on cards; mark the exception (a community server for a vendor's product) in the detail.
31. **Three status words in the action corner, none of them a control.** *Preinstalled* (green, ×7), *Installed* (green), *Disabled* (grey) — and nothing to press on an installed card except "…" (`ship-list-scrolled-dark.png`). Claude's `r0854` puts an *Enabled* switch on the thing; the candidate puts it on the card. **Change:** installed → a switch; available → "+"; built-in → nothing; the words go.
32. **No Edit anywhere.** A wrong path or env value means Remove + re-add (both surfaces). **Change:** *Edit* in the detail and in the "…" menu, opening the add dialog pre-filled.
33. **The "…" menu duplicates the click and hides the only destructive action in plain text.** *View details / Remove*, Remove not styled destructive (`ship-overflow-menu-dark.png`); ChatGPT's `r0424` separates and reddens *Uninstall*. **Change:** *Edit / Remove* (red, below a divider); drop *View details*.
34. **Four nouns for one thing on one screen.** Title *Connectors*, tab *Tools*, button *Add MCP server*, search *Search tools*, detail switch *MCP server*. **Change:** *Connectors* for the page, "tools" only for the things a server exposes, the button *Add a server*, the switch *Enabled*.

#### D · Layout and density

35. **Cards are 140px tall for an icon, a name and two lines.** The 40px icon tile sits on its own row above the name (measured card h=140 vs the candidate's 82 with the icon beside the name; `ship-list-light.png`). **Change:** icon left, name + description right, ~80px.
36. **Two columns from a 768px window, whatever the content width.** `ConnectorSection.tsx:26` uses `md:grid-cols-2`, a viewport query; at 640px of content the cards are 285px (`ship-w928-dark.png`), at 512px they are 221px with names truncated to *Video edi…* (`ship-w800-dark.png`). **Change:** a container query on the list; two columns only from ~660px of list.
37. **The detail resets the tabs.** Opening a connector hides the *Tools | Skills* control; opening a skill keeps it (`ship-skill-detail-dark.png`) — two detail chromes. Moot after item 28; otherwise make them the same.
38. **The disclaimer is three lines of legal.** `ship-list-end-dark.png`: *All third-party product names, logos, and brands are property of…* at 12px across the column. **Change:** the candidate's one line: *Third-party names and marks belong to their owners and identify the tool only.*

#### E · Typography

39. **Section heading = card name.** Both 14px/400 (measured): *By us* and *Video editing* are one type. **Change:** headings 13px/600 in the muted colour with the count beside them, a step below the names. (Same item in the candidate, C15.)
40. **Tool rows in the detail are mono identifiers in bordered boxes.** `create_entities` at 13px `code` over a 13px grey line, each row a 62px box (`ship-detail-memory-tools-light.png`; nine boxes = 600px). ChatGPT's `r0428` names tools in words. **Change:** the candidate's row — humanised name, identifier in mono beside it, description under — hairline-separated in one container.
41. **The mode hint's leading is 19.5px at 12px** (measured) against 18px everywhere else at 13px. Moot after item 29.

#### F · Colour and depth

42. **Four status colours on one screen.** Blue *Official* pills, green *Preinstalled* / *Installed*, grey *Disabled*, blue switches; in dark the *Official* pill is the brightest object on every card (`ship-list-dark.png`). **Change:** one accent for controls; attention in amber only where it is needed; no informational blue.
43. **Cards have no fill in dark.** `background: rgba(0,0,0,0)` with a hairline (measured); hover adds 6% white. Cards read as outlines drawn on the page, and the 40px icon tile (`rgb(18,18,20)`) inside them is nearly invisible (`ship-list-dark.png`). **Change:** a raised fill (`--pd-bg-raised`, 30,30,33) as the candidate's cards have; the tile then reads.
44. **The 🔌 emoji as the hand-added server's mark.** The only emoji in a line-icon system, 22px in a 40px tile (`ship-list-light.png` 460,325). **Change:** a neutral glyph (the candidate's `>_` prompt glyph).
45. **Brand marks in purple (Obsidian, Discord)** — vendors' marks, not the UI's palette; see *Not worth fixing*.

#### G · Motion and state transitions

46. **The detail replaces the list with a cut** and the list is re-mounted on Back (`ScrollArea` remount; no shared element, no fade). Low; the candidate's pane makes this moot after the port.
47. **The screen's own entrance** (`pd-settings-enter`, 150 ms fade) is quiet and fine (`ship-enter-080ms.png`). Keep.

#### H · Copy

48. **"MCP server" as the label of the on/off switch** (`ship-detail-github-light.png`). Claude's `r0854` says *Enabled*. **Change:** *Enabled*.
49. **"Developer: Official"** on the built-in's Information table (`ship-detail-builtin-dark.png`). **Change:** *Bobble*.
50. **"Pi" and the "P" tile** in the permission dialog (item 3) — the rename rule.
51. **The hand-added card's description is a path.** *Runs node ~/tools/weather-mcp/index.js · added by you*, wrapping mid-path (`ship-list-light.png`). **Change:** *Runs node · added by you*; the path lives in the detail.

#### I · Accessibility

52. **The card body — the primary open target — has no focus indicator.** Tabbing to it focuses the `<button>` (measured: `button:"🔌Weather…"`) and the frame is pixel-identical to the card at rest (`ship-focus-card-body.png` vs `ship-list-dark.png`, cropped); the button lacks `pd-focusable`. **Change:** the focus ring on the card container, 2px outline offset 2px, as the candidate does (`cand-focus-card.png`).
53. **Tab order visits the controls before the card.** "…" then "+" then the body, because the action corner precedes the body in DOM order (measured: `connector-overflow-weather` → the body). **Change:** body first, then its control; `aria-label="Open Weather"` on the body instead of its concatenated text.
54. **The permission dialog opens with focus on Cancel** (measured). Moot with item 3; otherwise focus the primary.

## Work order B — the candidate, Shelf+ (`apps/desktop/src/candidates/connectors/`)

#### A · Interaction and input

1. **It inherits every dialog item (A-B 12–26).** `ShelfPlus.tsx:44` imports the shipping `AddServerDialog`; `cand-add-dialog-light.png` over the candidate is the same 320px unpadded form, Enter does not submit, and after Add the keyboard lands on `<body>` (measured `body:"Shelf+ShelfLedgerReach…"`). Opening it from this list is the biggest feel-drop on the surface, and the reason the two "above the references" verdicts do not hold: the stills never opened it. **Change:** the dialog items, plus *Test* (A-B 21) — in the candidate the test result can be the pane's own tool list.
2. **Escape does nothing.** It neither closes the pinned detail nor the overlay sheet (measured false / false); only the back link, ✕ or the scrim do. **Change:** Escape closes the detail and returns focus to its card.
3. **A second click on the open card closes its detail.** `open()` toggles (measured true; `ShelfPlus.tsx:635`); a person who clicks the thing they are reading about makes it vanish. Neither reference nor the hub does this. **Change:** click = open; close only via back / ✕ / Escape / another card.
4. **The list re-sorts under the open pane.** Saving GitHub's key moved its card from slot 1 to slot 4 while its detail stayed open (`cand-detail-github-setup-light.png` → `cand-detail-github-tools-light.png`); toggling Memory off from its card moved the ledger row from *On* to *Off* in the same frame with no transition (`cand-row-moves-000ms.png`). The ideal says the row never moves under the pointer; Round 4 called this "the price of a useful sort" and it is not — it is the sort being applied at the wrong moment. **Change:** hold the order while a detail is open or a pointer is over the list, and apply it on the next open; or animate the move (FLIP, 250 ms) so the eye can follow.
5. **No per-tool control.** GitHub lists 50 tools (`cand-detail-github-tools-light.png`) and none can be turned off; VS Code's tools picker and the ideal both have a switch per tool, and on a local model every advertised tool is prompt prefix. **Change:** a switch per tool row, persisted per server (`disabledTools: string[]` in the registry; the extension filters on advertise), with the group header's count reading *30 · 28 on*.
6. **No cost.** Nothing on either surface says what enabling a thing does to the prompt; the engine-mode hint says *uses the most context* without a number. Memory: ~9.4k tokens for 17 tools in Native. **Change:** under *Tools 50*: *≈ 27k tokens per turn in Native · summarised in Lite* (a static estimate from the tool schemas is enough); the pane's summary line gains *· ≈ N tokens of tools*.
7. **The failure reason is the exit code.** *MCP server process exited (code 1)* (`cand-setup-bad-key-light.png` 752,371) while the server wrote *401 Bad credentials* to stderr; `connectors-main.ts:119` returns only the host's message and the host already has an `onLog` sink. **Change (main-side, in `connectors:tools`):** collect the last three stderr lines and return them with `error`; the pane shows them under the sentence. Round 3 filed this as proposal 8; it is the single cheapest improvement to the third question of the ideal.
8. **"Not responding" for a process that could not start.** Time after Add: `exited (code 2)` in under a second, shown as *● Not responding* (`cand-detail-time-added-light.png`). **Change:** *Could not start* for a spawn error or an exit before the handshake; *Not responding* only for a timeout; both amber.
9. **The remedies under a failure are body text.** *Try again   Change the key* at 13px in the primary colour, indistinguishable from the sentence above them (`cand-setup-bad-key-light.png` 752,394; `cand-not-responding-detail-light.png` 752,386). **Change:** the link colour, or two small outline buttons.
10. **The setup card says where the key goes, not where to get one.** (`cand-detail-github-setup-light.png`). **Change:** a `keyHelp` URL on the catalog entry and a line *Create a token at github.com › Settings › Developer settings ↗*.
11. **After Add, the new server is not brought into view or opened.** Weather Two appears as the second card with no highlight, and the pane stays on the ledger (`cand-added-light.png`; measured `selected: false`). **Change:** open its detail on Add, so the tool list (4 · listed just now) is the confirmation.
12. **No Edit for a hand-added server or a catalog server's arguments.** `cand-detail-custom-light.png`: *Remove server* only; *Change the key* exists only for env keys. **Change:** *Edit* in the header's "…" → the dialog pre-filled.
13. **Enter on a focused card opens it but focus stays on the card** (measured `cand-open-github` after Enter). Fine for pointer, awkward for keyboard: the pane's content is not reachable without tabbing through the rest of the list. **Change:** on keyboard open, move focus to the pane's back link.

#### B · Layout and density

14. **Two vertical lines at the list/pane boundary.** The list's always-visible scrollbar thumb at x≈726 beside the pane hairline at x=732 (`cand-list-1152-light.png`, y 170–590). This is the app's `ScrollArea` convention (the hub shows the same thumb at x≈1432), so it is an app-wide item, but here it sits 6px from a divider and reads as a stray bar every time. **Change (app-wide):** overlay-scrollbar behaviour — thumb visible on hover and while scrolling, hidden at rest.
15. **The sheet at 900 enters as an empty panel.** At 0 ms it is a white sheet with only a ✕ (`cand-sheet-w900-000ms.png`); the body fades in from zero over the next 250 ms (`-080ms.png` half there). Round 4 asked for the sheet to enter opaque and it does — but its content does not enter with it. **Change:** the body animates with the sheet (one keyframe, no separate fade).
16. **The pane's type is a step smaller than the list's for the same things.** Ledger row names 13px / lines 12px vs card names 14px / lines 13px, across a 20px divider (measured). **Change:** 14/13 in the pane; one ramp.
17. **The pane footer is the densest block for the least-used control.** *How tools reach the model* 12px + a segmented control + a two-line 12px sentence (`cand-list-1152-light.png` y 807–880). **Change:** one line — *Tools reach the model as* [Lite ▾] — with the sentence as the menu's description; or keep, low.
18. **Descriptions clamp at two lines with an ellipsis** for 6 of 12 visible cards at 1152 (*A structured workflow for co-authoring docs, proposals, specs,…*). The references do the same (`r0733`); see *Not worth fixing*. The skills' descriptions, though, are catalog copy — authoring them to one line (the way `SKILL_LINE` already did for the ledger) removes the ellipsis for free.

#### C · Typography

19. **Section heading = card name** (14px/400 both; `cand-list-1152-light.png` *Tools 27* vs *GitHub*). **Change:** 13px/600 muted with the count; the blurb stays 12px.
20. **"Show all — Playwright, Postman, Sentry and 16 more" reads as a caption.** 13px in the secondary colour with no affordance beyond the three marks; it is the only way to 16 of 27 tools (`cand-list-1152-light.png` 36,676). **Change:** the link colour, or a hairline row with a chevron.

#### D · Colour and depth

21. **The pressed filter pill is the heaviest object on the screen.** *All* is solid black on white (light) / solid white on black (dark) at rest (measured), heavier than the accent switches and the primary button; a filter should not outweigh the actions. **Change:** pressed = `--pd-bg-selected` fill with the primary text and a hairline, no inversion.
22. **Brand marks in purple (Linear, Obsidian)** (`cand-expanded-light.png` 54,865 / `ship-list-end-dark.png`). Vendors' marks; see *Not worth fixing*.
23. **The amber card is the right single warm surface** (`cand-detail-github-setup-light.png`); in dark it is a brown box that still reads. Keep.

#### E · Motion

24. **The pane swap is a cut with a fade** — blank at 0 ms except the back link, half at 60 ms, settled at 120 ms (`cand-swap-000/060/120ms.png`). Acceptable (the hub does the same); a 120 ms cross-fade would be quieter. Low.
25. **Pinned ↔ overlay at 1104px is a jump** (`cand-w1105-detail-light.png` → `cand-w1103-detail-light.png`): the list goes from 2×300 to 2×516 columns and the pane becomes a sheet in one frame. A layout mode changing under a window drag; accepted.
26. **The ledger's group re-sort has no motion** — item A4.

#### F · Copy

27. **"Your agent" is not the agent's name.** Pane title *Your agent*, back link *‹ Your agent*, subtitle *Tools and skills your agent can use* — the agent is Bobble; "your agent" reads as a different product. **Change:** *What Bobble can use* / *‹ Back*; subtitle *Tools and skills Bobble can use. Everything here runs on this Mac.*
28. **"Needs setup" counts a server that is not responding.** Time, failing to start, sits under *Needs setup 1* with a *Try again* pill (`cand-detail-time-added-light.png`). **Change:** *Needs attention* for the pill and the group; *Set up* / *Try again* stay as the row's verb.
29. **The engine-mode hint is jargon.** *Tools are summarised and fetched on demand, so many connectors fit a small context.* **Change:** *Bobble is told what each server can do and asks for the tools it needs — the cheapest on the prompt.* / *Every tool is sent to the model with its full schema — the most capable and the most expensive.*
30. Keep: *Tools 27 · each one runs as a local process*, *Skills 12 · playbooks the agent reads; they touch nothing by themselves*, *Built in 7 · always on, no server*, *Grouped by name — a guide, not a guarantee.*, *Stays on this Mac, in ~/.pi/desktop/mcp-connectors.json.* — the best copy on either surface.

#### G · Accessibility

31. Focus rings are consistent on card, chip, pill, switch and setup pill (`cand-focus-card.png`, `cand-focus-setup.png`, `cand-focus-switch.png`); tab order is card → control (measured). Keep.
32. **Focus after the dialog closes** — A-B 19.
33. **The tab walk from the search crosses five pills and six chip stops before the first card.** Acceptable; a *Skip to list* is not warranted at this scale.

#### H · Day-200 items neither surface has

34. **Per-project scope.** Claude's `r0835` chip; the registry is global. **Change:** a *Project* / *Everywhere* segmented control in the add dialog and the detail's About block, once the registry supports it.
35. **Reveal the file.** The setup card names `~/.pi/desktop/mcp-connectors.json`; make the path a *Reveal in Finder* link — the cheapest escape hatch for the person who wants to edit JSON.
36. **Import / export** of the registry (a JSON in the app's own `mcpServers` shape) from the header's "…".

### Feel and vibe

Everything true that does not reduce to a rule. The two surfaces separately.

**The shipping screen.**
- The list feels like a store that has nothing to sell you. Badges on every card, cards shaped like app-store tiles, four screens of them, and the first thing you can press below the fold. It reads as generated, not designed: the same card for a Mac Calendar tool you cannot remove and a Discord server you have not added, and both get the same blue *Official* pill.
- Dark makes it worse. Outline cards on a black ground, the blue pills glowing, the icon tiles disappearing — it looks like the settings page of a browser extension, not a Mac app. Light is calmer only because the outlines are quieter.
- The dialog is where the app stops feeling like a Mac app entirely. A 320px column of five identical inputs with the labels flush to the glass, a title indented and everything else not. It looks like a form that has not been styled yet, and it is the one screen that has to feel trustworthy because a person is about to hand it a command line and a token.
- The detail has good bones — back, name, one switch row, *Tools*, *How it runs*, *Information* — and then betrays them: *This connector exposes no tools.* when it broke, a docker command that scrolls sideways, a greyed switch on a thing you have not added. It feels like a page that was believed rather than tried.
- The Skills tab is the best-looking thing on the shipping screen: one calm column, name, a line, a switch. It is what the Tools tab should have been, and it makes the Tools tab look like it came from a different product.
- The permission dialog feels borrowed. A cloud consent sheet with a "P" placeholder for an icon, promising *Continue to Slack* and delivering a grey badge. Anyone who has connected Slack anywhere else will feel the sequence break.

**The candidate.**
- At the real shell width it is the first frame in this whole effort where Connectors reads as Bobble's own screen rather than a copy of someone's. The pane is the reason: *Your agent — 4 tools on · 1 needs setup* with switches on the rows is the answer to the question a person actually came with, and nothing on either reference answers it.
- The setup card is genuinely good. One amber box, one field, one blue button, one sentence about where the secret lives. It is the kind of thing you would screenshot to show someone how a token should be asked for.
- The tool list is the screenshot moment — *Get me* `get_me`, described, split into *Looks things up* and *Changes things*, listed in 41 ms from cache — and it is also where the surface feels unfinished, because it is a list you can only look at. The switch that belongs on each row is missing, and once you notice, the whole pane feels one control short.
- Three control shapes in one card column (a switch, a "+", a *● Set up* pill) look mixed for the first thirty seconds and make sense after a minute. I would keep them; a stranger's first minute is the price.
- The always-visible scrollbar thumb 6px from the pane divider looks like a rendering artefact every single time. It is an app-wide convention and it is wrong for a Mac.
- The pressed pill is the darkest thing on the screen and it is a filter. The eye goes there first and finds *All*.
- Save the key and the card you were looking at is gone from where it was. The app moved your furniture. The pane keeps the item so nothing is lost, but the list underneath is briefly not the list you had.
- The sheet at 900 flashing an empty white panel for a frame reads as a glitch even at a tenth of a second; opaque-then-fill is the wrong order.
- Opening the dialog from this list is the feel gap in one click: a polished shelf, then an unstyled form. This is where "very not on par" comes from, and it is the same component on both surfaces.
- Overall: the candidate feels like a System Settings pane made by people with taste; the shipping screen feels like a web dashboard. The distance between them is smaller than the distance between the candidate and its own dialog.

**Both.**
- Neither surface ever says a number. How many tools are on, yes; what they cost, never. For an app whose whole pitch is running on your own machine, the absence of a single honest cost figure makes both feel like they are hiding something they are not.
- The empty state on both is fine and neither is inviting. A first-timer gets a grid of "+" and no sentence that says what pressing one will do to their chat.

### What is already better than the references

So the next round does not "fix" it.

**Shipping screen.**
- *Added by you* first — a thing you configured is the thing you came to find. Keep the priority when the sections go.
- One button, not a menu of one: *Add MCP server* is a button (`add-server-probe.mjs` guards it).
- The Skills tab's one-column switch list with the licence badge in grey (`ship-skills-light.png`); the skill detail renders the playbook with the frontmatter stripped.
- The detail's *Tools* section is the content, not a marketing paragraph; a built-in lists its three tools statically.

**Candidate.**
- One surface, one search, one grammar for tools, skills and built-ins; the kind is a pill and a section blurb (`cand-list-1152-light.png`). Claude's four doors and ChatGPT's two tabs were not copied.
- The resting pane as the ledger — *Needs setup / On / Off / Skills on / Built in*, a switch per row, needs-setup first, a one-line summary. Neither reference has a "what is on" that you can act on without leaving the page.
- The setup card (`cand-detail-github-setup-light.png`): key name, masked field, where it is stored, one accent button, and the bad-key / change-key / recovered states all drawn (`cand-setup-bad-key-light.png`, `cand-setup-change-key-light.png`, `cand-not-responding-recovered-light.png`).
- Failure on the row: *Did not answer · tried just now* in amber, the *Set up* / *Try again* pill, the *Needs setup N* count, the card's control changing to match (`cand-not-responding-ledger-dark.png`). Neither reference draws a failure at all.
- The tool list: instant from cache with *listed just now*, humanised name + identifier + description, split by what it changes, capped at eight with *Show all 30* (`cand-detail-github-tools-light.png`). Above ChatGPT's `r0428` (no identifier, a chevron per row) and far above Claude's two chips (`r0752`).
- Specific reach facts (*Reads and writes files under ~/Projects*, *Touches nothing: clocks and time zones*) instead of Claude's identical trust paragraph on every detail.
- *Show all — Playwright, Postman, Sentry and 16 more* with a three-mark cluster: names three (ChatGPT) and counts (Claude) at once.
- *Recommended for you* from a true signal (*Chrome is installed*) as compact chips — Claude's Popular strip with a local fact instead of popularity.
- The empty search state names the query and clears itself (`cand-empty-light.png`); the category link searches for itself (`cand-search-category-light.png`).
- The fresh pane opens the built-in group so a new user's first look is seven things that already work (`cand-fresh-1152-light.png`).
- Focus rings on the container, consistent across card, chip, pill and switch; tab order card → control.
- A hand-added server is a first-class item with its own tools, command and tool prefix (`cand-detail-custom-light.png`) — on the shipping screen it cannot even be opened.
- Three width modes that hold with a detail open (pinned at 1152, sheet at 900, full column at 640; `cand-w900-detail-light.png`, `cand-w640-detail-light.png`) where the hub itself breaks at 900.

### Not worth fixing

Differences from the references judged cosmetic, said out loud.

- Brand marks in purple (Obsidian, Discord, Linear). Vendors' marks; no accent, chip, dot, ring or switch is purple in any frame of either surface, light or dark. The no-purple brief is met.
- No tinted header band on the detail (`r0752`), no hero, no *Try in chat*, no Information table with Version / Privacy / Terms. A local server has a command and a homepage; both surfaces show those.
- The candidate's descriptions ending in an ellipsis at two lines at 1152 — the references' cards do the same (`r0733`).
- The candidate's pane at 420px where the hub's is 460.
- The three control shapes in the card column (switch / "+" / *● Set up*): three states, three looks, and amber is the only attention colour on the page.
- *Built in* said three times on one candidate screen (summary line, collapsed group, list section); *○ Not added* directly above *Add to Bobble*.
- The pinned ↔ overlay switch on resize being a jump.
- The ✕ closing the sheet and *‹ Your agent* backing out of the pinned pane — two idioms, each right for its container.
- The shipping screen's 880px centred column at 1440 — fine, and moot after the port.
- A ~9px shift of the whole app shell in `ship-overflow-menu-dark.png` (the sidebar and title bar sit 9px higher than in every other frame): Playwright's scroll-into-view nudging the outer document before the click. A capture artefact until seen without automation; not a UI change.

### What I could not judge

And exactly what would have to be captured to judge it.

1. **Real cold-start cost.** Every server here is a fixture that answers in ~100 ms. What a first `npx -y @github/github-mcp-server` costs on this Mac — and therefore how long the shipping detail's spinner and the candidate's *Add to Bobble* really take — needs one run with the shims removed and a clock on the tool list.
2. **The engine modes in a chat.** Whether *Lite* actually summarises, and what the tool prefix costs in each mode, would settle item B6's number. Capture: the prompt prefix size per mode with 6 servers on (`ttft-probe.mjs` territory).
3. **A remote server's sign-in.** No `mcp-remote` connector was exercised; how an OAuth-style bridge asks for and shows a sign-in on either surface is unseen. Capture: add Sentry or Zoom (both `mcp-remote` in the catalog) with a fixture that returns 401 once and 200 after.
4. **Reduced motion.** The candidate's CSS has `prefers-reduced-motion` blocks; the shipping dialog's are in `base.css`. Neither was captured with the preference on.
5. **VoiceOver.** Reading order and the switches' announced names were not checked; the tab-order measurements are a proxy only.
6. **Scroll restore on Back** in the shipping detail (the list re-mounts; whether it returns to where you were was not measured — each drive returned to a list at rest).
7. **The sibling surfaces.** One dark frame of the Scheduled candidate (`../schedule/shots/ledger-plus-default-bobble-dark.png`) confirms the same header grammar and the same black pill action; whether the type ramp and pane widths agree across Scheduled, the model hub and Connectors needs the three side by side at 1152 after the footnote-token change Round 3 proposed.
8. **Windows and Linux.** Only macOS was driven; the title bar, the scrollbar convention and the `PATH` semantics of the shims all differ.

### Report card — the ten that matter most across both surfaces

1. The shared dialog: unpadded 320px form, no Enter, focus lost on close (A-B 12, 13, 17, 18, 19) — both surfaces, and the frame the user photographed.
2. Shipping: failures read as *"This connector exposes no tools."* (A-A 1), and the list stays green.
3. Shipping: a hand-added server's card is a dead click — no detail, no tools, no failure surface (A-A 4).
4. Shipping: no field for a key, and a consent dialog that promises a sign-in that never happens (A-A 2, 3).
5. Shipping: the first screen is provenance sections and badges on 25 of 37 cards, with nothing to act on above the fold (A-C 27, 30, 31).
6. Candidate: per-tool switches and a prompt-cost line on the tool list (B-A 5, 6).
7. Candidate: a *Test* in the add flow and stderr in the failure reason (A-B 21, B-A 7).
8. Both: no Edit; shipping removes without confirm and overwrites on a name collision (A-C 32, A-A 6, 7; B-A 12).
9. Candidate: the list re-sorts under the open pane; Escape is dead; a second click closes (B-A 2, 3, 4).
10. Candidate: the failure remedies look like body text and "Not responding" is used for "could not start" (B-A 8, 9).
