# Connectors — candidate designs

Three candidates for the Connectors tab, reachable at `?candidates=connectors` (`PI_DESKTOP_CANDIDATES=connectors`,
`PI_DESKTOP_CANDIDATE_V=shelf|ledger|reach`). Nothing outside this directory changed. Screenshots are in `shots/`
(`node src/candidates/connectors/shots.mjs all` regenerates them, headless, against the Vite dev server on :5312).

All three run against the real stores and the real IPC: the catalog + registry + `/Applications` scan from
`useConnectorsStore`, the bundled skills from `useSkillsStore`, the MCP mode from `useSettingsStore`. Add / turn on /
turn off / remove / fill a key / add a custom server / change the mode all round-trip. The one shared data layer is
`data.ts`; the detail sections are `detail-parts.tsx`; marks and the state control are `marks.tsx`.

## The position on connectors vs skills vs servers

the user's complaint is that ChatGPT and especially Claude give the same idea — "things I can add to my agent" — four
doors: Connectors, Plugins, Skills, Extensions, plus a Directory modal that re-nests three of them with its own nav.
Bobble reproduces the shape in miniature: a screen titled **Connectors**, a tab called **Plugins**, a search that says
**connectors**, a detail toggle labelled **MCP server**, and a **Skills** tab that hides half of the catalog.

The candidates all take the same stance, in three different layouts:

- **One surface, one search, one verb.** A tool (an MCP server, catalog or custom) and a skill (a SKILL.md playbook)
  are both things you add to the agent. They live in one list, are found by one search, and are turned on with one
  grammar (Add / Set up / a switch). The *kind* is a label on the row and a filter, never a tab and never a menu.
- **The kinds stay legible.** Merging is not blurring: a tool detail shows tools, reach, command, keys; a skill detail
  shows the document. The row says "Tool" or "Skill"; the mark differs (brand glyph vs page tile).
- **A custom server is just a tool the catalog does not know.** It appears everywhere a catalog tool would. (Today it
  appears nowhere — see "Things I noticed".)
- **"Plugin" is gone.** Bobble has tools and skills; there is no third thing, so there is no third word.

Every candidate embodies this. **Shelf** is the purest expression of it; **Ledger** re-cuts the same items by
*have vs could-have*; **Reach** re-cuts them by *what they can touch*.

## Candidate 1 — Shelf (`shelf`)

**Argument.** A person does not think "is this an MCP server or a markdown file?"; they think "what can my agent use,
and what can I add?". So: a strip of marks for what is on right now (with a dot per state), one search, filter pills
(All / Tools / Skills / On / Needs setup), then sections — Recommended for you, Tools, Skills, Built in — as two-column
cards. Opening anything slides a detail sheet in beside the list (the models hub's list-plus-pane idiom); the list
reflows to one column rather than being covered.

**Took from the refs.** ChatGPT's *Installed* row of icons (`refs/…12.03.52`) — as an honest "On now" strip with
state dots, built-ins after a gap. ChatGPT's Read actions / Write actions split is used in Reach; here the sheet keeps
a flat tool list. Claude's per-connector `Enabled` switch + `Configure` (`refs/…12.08.54`) became the setup card that
lives *inside* the detail, where the missing key is named and filled in place.

**Rejected.** Claude's split between a Connectors settings page and a separate Directory modal (`refs/…12.07.05` vs
`12.07.33`): two places for one catalog, each with its own search. OpenAI's marketing-page detail (`12.04.05`: a hero
image, "Try in chat", then the real management buried in Settings › Plugins › Slack, `12.04.28`): the detail should be
the management surface. Blue "Official" badges on every card: most of the catalog is official, so the badge is noise;
it is a quiet check-mark with a tooltip here, and never shown on first-party built-ins.

**Researched.** Raycast's store card (icon, one line, author, *command count*, install) and VS Code's extension
detail (*Feature Contributions* — what the extension adds — as a first-class tab) are why the detail leads with the
real tool list rather than a description; Obsidian's community-plugin browser is the model for install ≠ enable being
one switch when the install is a local file copy (skills).

**Tradeoff to flag.** The "On now" strip is 13 tiles once the seven built-ins are counted; with more built-ins it
needs a "+N" collapse. The sheet takes 440px, so at 900px the grid drops to one column while it is open.

## Candidate 2 — Ledger (`ledger`)

**Argument.** The split that actually matters is *have* vs *could have*. Claude's settings table (Connector / Type /
Status, `refs/…12.07.05`) is the one genuinely good thing in those refs — a ledger of what is connected — and a
directory is the right shape for adding. They have to be one screen: a persistent left ledger (Running / Needs setup /
Off / Skills on / Built in, each row with its switch) beside a directory with search and category chips. Adding moves
the item left. Opening anything replaces the directory with the detail, back returns to it. The MCP mode lives in the
ledger's footer, which is where an "engine" setting belongs.

**Took.** Claude's ledger table and its status column; Claude's directory category groups (`12.07.40`) as a scrolling
chip row rather than a wall; Zed's convention of a status dot beside a server's name (green = active) for the built-in
rows.

**Rejected.** The Directory as a *modal with its own three-way nav* (`12.09.40`: Skills / Connectors / Plugins again,
inside a dialog, inside Settings) — the directory is a pane, not a second app. Claude's plugin table (`12.08.35`) with
`Author —`, `Skills 0`, `Last updated 4/27/26` columns: three columns that say nothing for the one row that exists.
The near-empty plugin detail (`12.09.52`: a title, "by Anthropic", one paragraph, an Install button, and a screen of
white) — every detail here has tools/reach/command or the document itself.

**Tradeoff.** Two panes cost width: at 900px the ledger is still 300px and the directory row's description truncates
early. An added item shows in both panes ("Added" on the right, a switch on the left), which is correct but two rows
for one thing.

## Candidate 3 — Reach (`reach`)

**Argument.** On an offline, local app the question about a connector is not "is it popular?" but "what can this
reach on my computer?". So the catalog is grouped by reach — *Your Mac* (Calendar, Mail, Messages, Filesystem, Git…),
*Apps on this Mac* (Blender, Xcode, Docker…), *Accounts and services* (anything that needs a key or an OAuth bridge),
*Local tools* (Memory, Time, Playwright…) — plus *Added by you* and *Playbooks* (skills, framed as "they touch
nothing by themselves"). Every row's second line is a plain sentence about what it touches, derived from the real
config: "Reads and writes files under /Users/user/Projects", "Talks to mcp.zoom.us", "Signs in with BRAVE_API_KEY".
Details expand in place (the models hub's family-card move, measured height, content mounts only while open so
nothing spawns for a closed row), and tools are split into *Looks things up* / *Changes things*.

**Took.** ChatGPT's Read actions / Write actions grouping (`refs/…12.04.28`, `12.04.39`) — the best idea in the
refs, because it answers the trust question directly. Claude's per-connector trust notice ("Only use connectors from
developers you trust", `12.07.52`) is replaced by *specific* facts — which folder, which host, which key — since a
generic warning on every card teaches people to ignore it.

**Rejected.** Grouping by popularity: Bobble has no popularity data, and the shipping screen's "Popular" section is
a fallthrough for "everything else" (see below). Claude's red "Make sure you trust a plugin" banner on the upload
dialog (`12.08.29`) as the *only* trust affordance.

**Tradeoff to flag, honestly.** The Looks-up / Changes split is a **name heuristic** (`toolVerb` in `data.ts`: `list`,
`get`, `search`, `read`… vs everything else). MCP has no reliable read-only annotation, so the UI says "grouped from
tool names, a guide not a guarantee" under the lists. If adopted, `readOnlyHint` from tool annotations should be
preferred when a server sets it. The reach sentences are also derivation + a per-id override table
(`REACH_LINE`); the right home for that copy is a `reach` field on `KnownConnector` in `packages/mcp-lite` (proposed
patch below). "Accounts and services" is a 16-row pile; it wants the category chips from Ledger as a secondary axis.

## Which one I'd ship

**Shelf**, with two pieces of Reach folded in: the reach sentence as the card's second line for anything installed,
and the Looks-up / Changes split in the sheet. Shelf answers both questions — what is on, what can I add — on one
screen with the least structure, it is the same list-plus-pane idiom as the models hub, and it holds at 900px.
Ledger is the best *management* story but pays for it in width and in showing every added item twice. Reach is the
most honest to what Bobble is, and its grouping is the one I would keep as the *default sort inside* Shelf's Tools
section if the team wants it without a second layout.

## Proposed change outside this directory (not applied)

`packages/mcp-lite/src/detect-apps.ts` — add an authored reach line to the catalog so the UI stops deriving it:

```ts
export interface KnownConnector {
  // …
  /** One plain sentence about what this connector can touch on the user's Mac, shown on the card. */
  reach?: string;
}
```

and fill it per entry (e.g. `reach: 'Reads and writes files in a folder you choose'` on `filesystem`,
`reach: 'Signs in to GitHub with a personal access token'` on `github`). `data.ts#reachLine` then becomes
`c.reach ?? derived`.

## Things I noticed

Blunt, with file and line. None of these were touched.

1. **Three names for one thing, and a fourth for the same thing again.** Title "Connectors"
   (`src/connectors/ConnectorsScreen.tsx:155`), tab "Plugins" (`:192`), search "Search connectors" (`:205`), detail
   toggle "MCP server" (`src/connectors/ConnectorDetail.tsx:174`). This is the Anthropic confusion, reproduced.
2. **A custom server vanishes after you add it.** The gallery is built from `catalog` only
   (`ConnectorsScreen.tsx:107–115`); `registry.servers` is read only to compute `installedIds` (`:106`). Add a server
   through "Add an MCP server" and there is no row for it anywhere on the screen. The only way to see or remove it is
   the JSON file.
3. **"Popular" is a lie.** `src/connectors/connector-sections.ts:86–87`: the Popular section is the fallthrough for
   every connector not caught by an earlier section. There is no popularity data. That is a signal the UI invents.
4. **The first screen is six cards you cannot act on.** "By us" renders the seven built-ins first, each with a static
   "Preinstalled" badge, an "Official" badge and a "…" menu whose only item is "View details" (`ConnectorCard.tsx`).
   Everything a person could actually add starts below the fold.
5. **"Official" on our own tools.** `ConnectorCard.tsx:100` shows the badge for `connector.official`, and every
   first-party built-in is `official: true` (`packages/mcp-lite/src/builtin-connectors.ts:56`). Calendar is not
   "official" in any sense a user cares about.
6. **Wrong reason for an empty tool list.** `ConnectorDetail.tsx:202`: an installed-but-disabled connector reads
   "This connector exposes no tools." It exposes plenty; it is off, so nothing was fetched. GitHub's detail says this
   today.
7. **Developer: github.com.** `ConnectorDetail.tsx:36` uses the homepage *host* as the developer, so every
   GitHub-hosted server — including the official `modelcontextprotocol/servers` — is "by github.com".
8. **Category shows the raw enum** (`ConnectorDetail.tsx:229`: "dev", "comms", "docs"), and the launch command is a
   `CodeBlock` that scrolls horizontally for one line (`:212`) — the docker command needs a scrollbar.
9. **The skill detail renders YAML frontmatter as prose.** `src/connectors/SkillDetail.tsx:87` passes the raw
   `SKILL.md` to `Markdown`, so the page opens with "name: code-review description: … license: MIT" as one giant
   paragraph in chat-response font size. (`detail-parts.tsx#stripFrontmatter` is the two-line fix.)
10. **Grammar bug and the old name in the Skills copy.** `src/connectors/SkillsTab.tsx:115–116` produces "Enable one
    to copy it into your agent 1 enabled." — missing full stop — and says "Pi follows", which the rebrand rules say
    should be Bobble in user-facing text.
11. **The permission dialog is a cloud dialog on a local app.** `src/connectors/ConnectPermissionDialog.tsx:58` draws
    a literal "P" as the app avatar (pre-rebrand), `:78` says "Pi only shares…", and `:81–82` says "Messages and files
    you use with X are sent to it" — copied from OpenAI's wording for cloud plugins. For Filesystem or Memory nothing
    is "sent" anywhere; it is a process on the same machine. The dialog also fires for *needs a token*, which is a
    setup step, not a consent step.
12. **The MCP mode control sits between the search and the grid** (`ConnectorsScreen.tsx:218–236`): a global engine
    setting interrupting a browsing surface, with a paragraph of explanation under it, on every visit.
13. **"Create ▾" is a dropdown with one item** (`ConnectorsScreen.tsx:156–181`). A menu of one is a button.
14. **Navigation model differs from the models hub.** Connectors is a full-window surface with "Back to chat"
    (`ConnectorsScreen.tsx:122–133`) while the models hub renders inside the shell with the sidebar present
    (`src/models/ModelsView.tsx`, "No traffic-light strip: the hub renders INSIDE the chat shell now"). Two top-level
    views, two ways back.
15. **The icon box disappears in dark mode.** `ConnectorCard.tsx:94` uses `bg-bg-inset` for the mark tile; on the
    dark bobble surface inset is within a few percent of the card, so brand marks float on nothing. (The candidates
    add a hairline ring.)
16. **Skills rows shout the license.** `SkillsTab.tsx:36` renders "Apache-2.0" as an `info` (blue) badge on every row,
    so the licence draws the eye before the skill's name does.
17. **`vite` launches a visible app against the real profile.** `apps/desktop/vite.config.ts:108`
    (`onstart: ({ startup }) => void startup(['.'])`): running the dev server as documented put a real Electron on
    the screen, with the user's real `~/.pi`, and started a real `llama-server` loading Qwen3.5-4B — for about two
    minutes, on this pass, before I caught it. There is no env guard. The only safe way to use the dev server for a
    headless probe today is to start vite itself with `PI_E2E=1 HOME=<throwaway> PI_BIN=<mock-pi>` so the
    auto-launched instance inherits background mode; that should be the default or the auto-launch should have an
    opt-out.
18. **A `.pd-btn` icon can be squeezed to nothing.** MEASURED: under the claude flavour a primary `Button` holding
    `<IconPlus size={14} /> Add MCP server` in a flex header rendered the SVG at 6.9px wide — a dot — because
    neither `.pd-btn > .pd-icon` nor `.pd-icon` sets `flex: none` (`packages/ui/src/styles/button.css`,
    `icons.css`), so the icon absorbs the shrink before the label wraps. The candidates work around it with
    `shrink-0` on the button; the fix belongs in `button.css` (`.pd-btn > .pd-icon { flex: none; }`).
19. **Brand marks vs the no-purple rule.** Obsidian's and Discord's real marks are purple/blurple by brand hex
    (`packages/mcp-lite/src/connector-icons.ts`). I read the rule as being about UI colour, not third-party logos,
    and left them; flagging it because it is the only purple on these screens.
