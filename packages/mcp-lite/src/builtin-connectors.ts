/**
 * Built-in ("preinstalled") connectors — pi's own bundled tool surfaces that
 * ship inside the app rather than launching an external MCP server. They are
 * always on (never installed, never removed, never spawned), so they carry
 * `kind:'builtin'` + a sentinel empty `command`; the connectors-main IPC no-ops
 * install/remove/enable for them, and the gallery renders a static "Preinstalled"
 * affordance instead of the "+" add button.
 *
 * The set spans two provenance tiers (this distinction drives the gallery
 * sections — see connector-sections.ts):
 *   - Video editing + the macOS connectors are genuinely OURS (`firstParty:true`)
 *     — the "By us" section.
 *   - HyperFrames is HeyGen's official tool (github.com/heygen-com/hyperframes),
 *     bundled/preinstalled but NOT authored by us. It is `firstParty:false` +
 *     `official:true`, so it lands under "Official / Verified", never "By us".
 *
 * Their static {@link KnownConnector.tools} lists are the "real content" the
 * detail view shows — no schema fetch / server spawn is needed to describe what
 * a builtin does. HyperFrames renders motion-graphics scenes to MP4 on-device
 * (its runtime tool is `motion_graphics_render`); Video editing is a typed
 * ffmpeg façade (`video_edit` / `extract_frames` / `probe`).
 *
 * {@link MAC_CONNECTORS} surface the first-party macOS integrations that ship in
 * the `@pi-desktop/mac-connectors` pi extension (always loaded via `-e`, so their
 * calendar/mail/messages/contacts/reminders tools are ALWAYS live). They were
 * previously invisible in the gallery — a user had no way to discover that the
 * agent can read their Calendar or Mail — so they are exposed here as
 * `kind:'builtin'` "Preinstalled" cards. Their tool NAMES mirror
 * `@pi-desktop/mac-connectors/tool-names` (kept as literals so the registry does
 * not take a dependency on a specific connector extension).
 *
 * Merged to the FRONT of {@link KNOWN_CONNECTORS} so they cross the connectors
 * IPC in `catalog` and land first in their sections.
 */
import type { KnownConnector } from './detect-apps';

const HYPERFRAMES_DESCRIPTION =
  'Motion-graphics video — the agent authors HTML/CSS/JS and renders it to MP4 ' +
  '(ffmpeg + headless Chrome). Deterministic, on-device, no model weights.';

const VIDEO_EDITING_DESCRIPTION =
  'A typed ffmpeg façade — trim, concat, overlay, extract frames, and probe ' +
  'video, with safe argv (no shell).';

const DATA_VISUALS_DESCRIPTION =
  'Charts drawn from their numbers, in the chat — bar, stacked, horizontal bar, line, area, ' +
  'scatter, donut — as an interactive card (hover values, chart/table toggle, open in the canvas), ' +
  'with the SVG written into the project. Pure, on-device, no model weights.';

/** One first-party macOS connector card: an always-on `kind:'builtin'` gallery
 * entry for a `@pi-desktop/mac-connectors` app surface. `command:''` (never a
 * server); a static tool list drives the detail view. */
function macConnector(
  card: Pick<KnownConnector, 'id' | 'name' | 'icon' | 'category' | 'description' | 'tools'>,
): KnownConnector {
  return {
    ...card,
    kind: 'builtin',
    // Authored by us (the mac-connectors pi extension) → the "By us" section.
    firstParty: true,
    official: true,
    template: {
      id: card.id,
      name: card.name,
      icon: card.icon,
      description: card.description,
      command: '',
    },
  };
}

/**
 * The first-party macOS connectors, surfaced so the calendar/mail/messages/
 * contacts/reminders tools (always live via the `@pi-desktop/mac-connectors`
 * extension) are DISCOVERABLE in the gallery. Tool names mirror
 * `@pi-desktop/mac-connectors/tool-names`.
 */
/**
 * OmniSVG — a MODEL connector (`kind:'model'`). the user: "add a connector that's
 * for this model ... the connector can just be called OmniSVG, for making svgs,
 * and then a simple cli tool ... svg <optional prompt> --image <optional
 * reference image path(s)>".
 *
 * Installing it downloads `omnisvg-1.1-4b` (a Q8_0 GGUF plus its vision tower,
 * ~5.1 GB) into the ordinary models directory. Nothing else changes: the
 * `generate_svg` tool is registered whether or not the files are there, and
 * says so plainly when they are not. In CLI mode the tool IS the `svg` command.
 */
export const OMNISVG_CONNECTOR: KnownConnector = {
  id: 'omnisvg',
  name: 'OmniSVG',
  icon: '✒️',
  category: 'design',
  description:
    'Make SVGs — icons, logos, symbols, flat illustrations — from a description or by tracing ' +
    'a reference image. Runs on-device (OmniSVG 1.1, Apache-2.0). Downloads ~5 GB once.',
  homepage: 'https://github.com/OmniSVG/OmniSVG',
  kind: 'model',
  modelId: 'omnisvg-1.1-4b',
  firstParty: true,
  official: false,
  popular: true,
  tools: [
    {
      name: 'generate_svg',
      description:
        'svg <prompt> --image <path> — an SVG from a description, a reference image, or both.',
    },
  ],
  template: {
    id: 'omnisvg',
    name: 'OmniSVG',
    icon: '✒️',
    description: 'SVG generation, on-device.',
    command: '',
  },
};

export const MAC_CONNECTORS: KnownConnector[] = [
  macConnector({
    id: 'mac-calendar',
    name: 'Calendar',
    icon: '📅',
    category: 'meetings',
    description: 'Read and create events in your macOS Calendar.',
    tools: [
      { name: 'calendar_list_events', description: 'List Calendar events in a date range.' },
      { name: 'calendar_create_event', description: 'Create an event in Calendar.' },
    ],
  }),
  macConnector({
    id: 'mac-mail',
    name: 'Mail',
    icon: '📧',
    category: 'comms',
    description: 'Search, list, and read messages in macOS Mail.',
    tools: [
      { name: 'mail_search', description: 'Search Mail messages by subject or unread state.' },
      { name: 'mail_recent', description: 'List the newest messages in a Mail mailbox.' },
      { name: 'mail_read', description: 'Read the full body of one Mail message by id.' },
    ],
  }),
  macConnector({
    id: 'mac-messages',
    name: 'Messages',
    icon: '💬',
    category: 'comms',
    description: 'Read recent iMessage/SMS conversations and send messages.',
    tools: [
      {
        name: 'messages_recent',
        description: 'Read recent iMessage/SMS (needs Full Disk Access).',
      },
      { name: 'messages_send', description: 'Send an iMessage to a number or email.' },
    ],
  }),
  macConnector({
    id: 'mac-contacts',
    name: 'Contacts',
    icon: '👤',
    category: 'comms',
    description: 'Search people, emails, and phone numbers in macOS Contacts.',
    tools: [
      {
        name: 'contacts_search',
        description: 'Search Contacts people by name (emails, phones, org).',
      },
    ],
  }),
  macConnector({
    id: 'mac-reminders',
    name: 'Reminders',
    icon: '☑️',
    category: 'project',
    description: 'List and create reminders in macOS Reminders.',
    tools: [
      { name: 'reminders_list', description: 'List reminders from Reminders.' },
      { name: 'reminders_create', description: 'Create a reminder in Reminders.' },
    ],
  }),
];

/**
 * The built-in connectors. Each has an empty `template.command` sentinel (it
 * never runs as a server) and a static tool list for the detail view. Icons are
 * neutral line-art glyphs from `connector-icons`.
 */
const CLI_TOOLS_DESCRIPTION =
  'Every tool as a command behind `bash` — `tools`, `tools search`, `<command> --help`. ' +
  'Specialists and subagents run on it by default: the same reach as the JSON schemas at a ' +
  'fraction of the prompt. Switch it in Settings → Harness → Tool interface.';

export const BUILTIN_CONNECTORS: KnownConnector[] = [
  {
    /*
     * THE CLI, AS A CONNECTOR CARD. the user: "ensure there is a cli connector for
     * the specialists that is by default there and enabled, cli tools are a
     * good context saver so it's important that they're just the same power
     * as schemas." The mode itself is the harness's (tool-cli-bridge.ts) and
     * the switch lives in Settings; this card is where a person discovers that
     * it exists and that it is on. Its "tools" are the three ways in.
     */
    id: 'cli-tools',
    name: 'CLI tools',
    kind: 'builtin',
    firstParty: true,
    official: true,
    category: 'dev',
    icon: '⌨️',
    description: CLI_TOOLS_DESCRIPTION,
    tools: [
      { name: 'tools', description: 'List every command group the session has on PATH.' },
      { name: 'tools search', description: 'Find a command by what it does.' },
      {
        name: '<command> --help',
        description: 'The arguments of any command, from its own schema.',
      },
    ],
    template: {
      id: 'cli-tools',
      name: 'CLI tools',
      icon: '⌨️',
      description: CLI_TOOLS_DESCRIPTION,
      command: '',
    },
  },
  {
    id: 'hyperframes',
    name: 'HyperFrames',
    kind: 'builtin',
    // HeyGen's tool — bundled/preinstalled, but NOT authored by us. Official
    // (Verified), never "By us".
    firstParty: false,
    official: true,
    category: 'creative',
    icon: '🎞️',
    homepage: 'https://github.com/heygen-com/hyperframes',
    description: HYPERFRAMES_DESCRIPTION,
    tools: [
      {
        name: 'motion_graphics_render',
        description: 'Render an HTML/CSS/JS motion-graphics scene to an MP4 clip.',
      },
    ],
    template: {
      id: 'hyperframes',
      name: 'HyperFrames',
      icon: '🎞️',
      description: HYPERFRAMES_DESCRIPTION,
      command: '',
    },
  },
  {
    /*
     * DATA VISUALS — the user (2026-09-16), Claude's inline chart beside ours:
     * "we need parity on these datavisuals … this can be a connector". The
     * `chart` tool is pure TypeScript and always registered (harness
     * chart-tool.ts); this card is where a person discovers that a chart of
     * numbers is one call away and what its command looks like.
     */
    id: 'data-visuals',
    name: 'Data visuals',
    kind: 'builtin',
    firstParty: true,
    official: true,
    category: 'analytics',
    icon: '📊',
    description: DATA_VISUALS_DESCRIPTION,
    popular: true,
    tools: [
      {
        name: 'chart',
        description:
          'chart <type> "<title>" --labels "…" --values "…" — a bar, stacked, hbar, line, area, scatter or donut chart of the numbers, shown inline.',
      },
    ],
    template: {
      id: 'data-visuals',
      name: 'Data visuals',
      icon: '📊',
      description: DATA_VISUALS_DESCRIPTION,
      command: '',
    },
  },
  {
    id: 'video-editing',
    name: 'Video editing',
    kind: 'builtin',
    // Genuinely ours — the "By us" section.
    firstParty: true,
    official: true,
    category: 'media',
    icon: '✂️',
    description: VIDEO_EDITING_DESCRIPTION,
    tools: [
      {
        name: 'video_edit',
        description: 'Trim / concat / overlay / burn subtitles via a safe ffmpeg façade.',
      },
      { name: 'extract_frames', description: 'Extract still frames from a clip.' },
      { name: 'probe', description: 'Read a media file’s streams and metadata.' },
    ],
    template: {
      id: 'video-editing',
      name: 'Video editing',
      icon: '✂️',
      description: VIDEO_EDITING_DESCRIPTION,
      command: '',
    },
  },
  ...MAC_CONNECTORS,
];

/** Ids of the built-in connectors (stable set). */
export const BUILTIN_CONNECTOR_IDS: readonly string[] = BUILTIN_CONNECTORS.map((c) => c.id);

/**
 * Model connectors — installable, but not servers. Kept apart from
 * {@link BUILTIN_CONNECTORS} on purpose: "builtin" means preinstalled and
 * never installed, and the tests hold that line. These are merged to the front
 * of the catalog beside the builtins.
 */
export const MODEL_CONNECTORS: KnownConnector[] = [OMNISVG_CONNECTOR];

const BOBBLE_3D_DESCRIPTION =
  'Make 3D models in the chat — a mesh from a description or a picture, then texture, ' +
  "split into parts, rig or retopologise it — on the 3D studio's own engine, on-device. " +
  'The result turns right in the conversation.';

/**
 * Bobble 3D — a MODULE connector (`kind:'module'`): the 3D studio's engine,
 * offered to the CHAT. the user (2026-09-17): "3d should be a connector that gets
 * recommended for install upon installing the 3d studio module, the card for
 * during generation/texturing/segmentation/rigging … should just be a little
 * embedded viewport rotatable".
 *
 * The engine belongs to the studio (gen module `3d`); this card is the chat's
 * use of it. It has its own on/off — a person who installed the studio finds
 * it under "Recommended for you" rather than finding two new tools in every
 * chat — and installing it from a Mac with no engine installs the engine first
 * (the same download the studio's card runs). Its two tools register at pi's
 * spawn (PI_BOBBLE_3D_READY), like OmniSVG's `svg`; in CLI mode they are
 * `3d generate` and `3d refine`.
 */
export const BOBBLE_3D_CONNECTOR: KnownConnector = {
  id: 'bobble-3d',
  name: 'Bobble 3D',
  icon: '🧊',
  category: 'creative',
  description: BOBBLE_3D_DESCRIPTION,
  kind: 'module',
  moduleId: '3d',
  firstParty: true,
  official: true,
  popular: true,
  tools: [
    {
      name: 'generate_3d',
      description:
        '3d generate <prompt> --image <path> — a textured mesh from a description, a picture, or both.',
    },
    {
      name: 'refine_3d',
      description:
        '3d refine <model> --op texture|segment|rig|retopo — texture, split into parts, rig or retopologise a model the chat has.',
    },
  ],
  template: {
    id: 'bobble-3d',
    name: 'Bobble 3D',
    icon: '🧊',
    description: "3D generation for the chat, on the studio's engine.",
    command: '',
  },
};

/**
 * Module connectors — the studios' engines as chat tools. Installable (the
 * engine, when it is missing) and switchable, never servers, never in the
 * registry; their state lives in settings (`moduleConnectors`) beside the
 * engine's own presence. Merged beside the model connectors.
 */
export const MODULE_CONNECTORS: KnownConnector[] = [BOBBLE_3D_CONNECTOR];
