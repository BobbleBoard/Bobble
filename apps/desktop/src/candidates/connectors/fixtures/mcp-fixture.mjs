/**
 * A fixture MCP server for the connector candidates' screenshots.
 *
 * `node mcp-fixture.mjs <package>` speaks enough of the Model Context Protocol
 * over stdio (newline-delimited JSON-RPC 2.0: `initialize`, the `initialized`
 * notification, `tools/list`, `ping`) for @pi-desktop/mcp-lite's client to
 * start it and list its tools. shots.mjs puts `npx` / `uvx` / `node` shims on
 * the app's PATH that exec this file for the packages below, so the app's own
 * `connectors:tools` handler spawns the REAL command line from the registry
 * (`npx -y @github/github-mcp-server`), the Command row shows the real
 * command, and the list that comes back is deterministic and instant — no
 * download, no token, no network.
 *
 * The tool lists are the servers' real tool names and one-line descriptions
 * (GitHub's, the reference servers', blender-mcp's, chrome-devtools-mcp's),
 * trimmed to what a screen shows. GitHub is the ~40-tool case the
 * Looks-up / Changes split and the eight-per-group cap were designed for.
 *
 * `GITHUB_PERSONAL_ACCESS_TOKEN=bad-token` makes the GitHub fixture fail the
 * way the real server fails on a bad key — a stderr line and a non-zero
 * exit before the handshake — so the "bad key" frame is a real error path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const GITHUB = [
  ['get_me', 'Get details of the authenticated GitHub user.'],
  ['search_repositories', 'Search for GitHub repositories.'],
  ['get_file_contents', 'Get the contents of a file or directory from a repository.'],
  ['list_commits', 'Get a list of commits of a branch in a repository.'],
  ['get_commit', 'Get details for a commit from a repository.'],
  ['list_branches', 'List branches in a repository.'],
  ['list_tags', 'List git tags in a repository.'],
  ['search_code', 'Search for code across GitHub repositories.'],
  ['search_users', 'Search for GitHub users.'],
  ['get_issue', 'Get details of a specific issue in a repository.'],
  ['get_issue_comments', 'Get comments for a specific issue.'],
  ['list_issues', 'List issues in a repository.'],
  ['search_issues', 'Search for issues in GitHub repositories.'],
  ['get_pull_request', 'Get details of a specific pull request.'],
  ['list_pull_requests', 'List pull requests in a repository.'],
  ['get_pull_request_files', 'Get the files changed in a pull request.'],
  ['get_pull_request_diff', 'Get the diff of a pull request.'],
  ['get_pull_request_reviews', 'Get the reviews on a pull request.'],
  ['get_pull_request_status', 'Get the status of a pull request.'],
  ['get_pull_request_comments', 'Get comments for a pull request.'],
  ['list_notifications', 'List notifications for the authenticated user.'],
  ['get_notification_details', 'Get details of a specific notification.'],
  ['list_code_scanning_alerts', 'List code scanning alerts in a repository.'],
  ['get_code_scanning_alert', 'Get details of a specific code scanning alert.'],
  ['list_secret_scanning_alerts', 'List secret scanning alerts in a repository.'],
  ['list_workflows', 'List workflows in a repository.'],
  ['list_workflow_runs', 'List workflow runs for a workflow.'],
  ['get_workflow_run', 'Get details of a specific workflow run.'],
  ['get_job_logs', 'Download logs for a workflow job.'],
  ['create_issue', 'Create a new issue in a repository.'],
  ['add_issue_comment', 'Add a comment to an issue.'],
  ['update_issue', 'Update an existing issue in a repository.'],
  ['create_pull_request', 'Create a new pull request in a repository.'],
  ['update_pull_request', 'Update an existing pull request in a repository.'],
  ['merge_pull_request', 'Merge a pull request.'],
  [
    'update_pull_request_branch',
    'Update a pull request branch with the latest changes from the base branch.',
  ],
  ['create_pull_request_review', 'Create a review for a pull request.'],
  ['add_pull_request_review_comment', 'Add a review comment to a pull request.'],
  ['request_copilot_review', 'Request a Copilot review for a pull request.'],
  ['create_or_update_file', 'Create or update a single file in a repository.'],
  ['push_files', 'Push multiple files to a repository in a single commit.'],
  ['delete_file', 'Delete a file from a repository.'],
  ['create_branch', 'Create a new branch in a repository.'],
  ['create_repository', 'Create a new GitHub repository in your account.'],
  ['fork_repository', 'Fork a repository to your account or an organization.'],
  ['dismiss_notification', 'Dismiss a notification by marking it as read or done.'],
  ['mark_all_notifications_read', 'Mark all notifications as read.'],
  ['run_workflow', 'Run a workflow by its file name or id.'],
  ['rerun_workflow_run', 'Re-run a workflow run.'],
  ['cancel_workflow_run', 'Cancel a workflow run.'],
];

const MEMORY = [
  ['create_entities', 'Create multiple new entities in the knowledge graph.'],
  ['create_relations', 'Create multiple new relations between entities in the knowledge graph.'],
  ['add_observations', 'Add new observations to existing entities in the knowledge graph.'],
  ['delete_entities', 'Delete multiple entities and their associated relations.'],
  ['delete_observations', 'Delete specific observations from entities.'],
  ['delete_relations', 'Delete multiple relations from the knowledge graph.'],
  ['read_graph', 'Read the entire knowledge graph.'],
  ['search_nodes', 'Search for nodes in the knowledge graph based on a query.'],
  ['open_nodes', 'Open specific nodes in the knowledge graph by their names.'],
];

const FILESYSTEM = [
  ['read_file', 'Read the complete contents of a file from the file system.'],
  ['read_text_file', 'Read the complete contents of a file as text.'],
  ['read_media_file', 'Read an image or audio file and return it as base64 data.'],
  ['read_multiple_files', 'Read the contents of multiple files simultaneously.'],
  ['write_file', 'Create a new file or completely overwrite an existing file.'],
  ['edit_file', 'Make line-based edits to a text file and return a git-style diff.'],
  ['create_directory', 'Create a new directory or ensure a directory exists.'],
  ['list_directory', 'Get a detailed listing of all files and directories in a path.'],
  ['list_directory_with_sizes', 'List a directory with each entry’s size.'],
  ['directory_tree', 'Get a recursive tree view of files and directories as JSON.'],
  ['move_file', 'Move or rename files and directories.'],
  ['search_files', 'Recursively search for files and directories matching a pattern.'],
  ['get_file_info', 'Retrieve detailed metadata about a file or directory.'],
  ['list_allowed_directories', 'Return the list of directories this server is allowed to access.'],
];

const BLENDER = [
  ['get_scene_info', 'Get detailed information about the current Blender scene.'],
  ['get_object_info', 'Get detailed information about a specific object in the scene.'],
  ['get_viewport_screenshot', 'Capture a screenshot of the current Blender 3D viewport.'],
  ['execute_blender_code', 'Execute arbitrary Python code in Blender.'],
  ['get_polyhaven_categories', 'Get a list of categories for a specific asset type on Poly Haven.'],
  ['search_polyhaven_assets', 'Search for assets on Poly Haven with optional filtering.'],
  ['download_polyhaven_asset', 'Download and import a Poly Haven asset into Blender.'],
  ['set_texture', 'Apply a previously downloaded Poly Haven texture to an object.'],
  ['get_polyhaven_status', 'Check if Poly Haven integration is enabled in Blender.'],
  ['get_hyper3d_status', 'Check if Hyper3D Rodin integration is enabled in Blender.'],
  ['generate_hyper3d_model_via_text', 'Generate a 3D asset from a text description.'],
  ['generate_hyper3d_model_via_images', 'Generate a 3D asset from reference images.'],
  ['poll_rodin_job_status', 'Check the status of a Hyper3D generation task.'],
  ['import_generated_asset', 'Import a generated asset into the Blender scene.'],
  ['get_sketchfab_status', 'Check if Sketchfab integration is enabled in Blender.'],
  ['search_sketchfab_models', 'Search for models on Sketchfab.'],
  ['download_sketchfab_model', 'Download and import a Sketchfab model into Blender.'],
];

const CHROME = [
  ['list_pages', 'List all open pages in the browser.'],
  ['select_page', 'Select a page as the context for future tool calls.'],
  ['new_page', 'Open a new page.'],
  ['close_page', 'Close a page by its index.'],
  ['navigate_page', 'Navigate the currently selected page to a URL.'],
  ['navigate_page_history', 'Go back or forward in the page history.'],
  ['take_screenshot', 'Take a screenshot of the page or an element.'],
  ['take_snapshot', 'Take a text snapshot of the page with element uids.'],
  ['click', 'Click on an element on the page.'],
  ['fill', 'Type text into an input, textarea or select element.'],
  ['fill_form', 'Fill out multiple form elements at once.'],
  ['hover', 'Hover over an element on the page.'],
  ['press_key', 'Press a key or key combination.'],
  ['drag', 'Drag an element onto another element.'],
  ['evaluate_script', 'Evaluate a JavaScript function inside the selected page.'],
  ['list_console_messages', 'List all console messages for the selected page.'],
  ['list_network_requests', 'List all network requests for the selected page.'],
  ['get_network_request', 'Get a network request by URL.'],
  ['performance_start_trace', 'Start a performance trace recording on the selected page.'],
  ['performance_stop_trace', 'Stop the active performance trace recording.'],
  ['performance_analyze_insight', 'Provide detailed information on a performance insight.'],
  ['emulate_cpu', 'Emulate CPU throttling on the selected page.'],
  ['emulate_network', 'Emulate network conditions on the selected page.'],
  ['resize_page', 'Resize the selected page’s window.'],
  ['handle_dialog', 'Handle an open browser dialog.'],
  ['wait_for', 'Wait for text to appear on the selected page.'],
];

const WEATHER = [
  ['get_forecast', 'Get the seven-day forecast for a place.'],
  ['get_current_conditions', 'Get the current conditions for a place.'],
  ['get_alerts', 'Get active weather alerts for a region.'],
  ['search_location', 'Resolve a place name to coordinates.'],
];

const SEQUENTIAL = [
  [
    'sequentialthinking',
    'A detailed tool for dynamic and reflective problem-solving through thoughts.',
  ],
];

const PACKAGES = {
  '@github/github-mcp-server': ['github-mcp-server', GITHUB],
  '@modelcontextprotocol/server-memory': ['memory-server', MEMORY],
  '@modelcontextprotocol/server-filesystem': ['secure-filesystem-server', FILESYSTEM],
  '@modelcontextprotocol/server-sequential-thinking': ['sequential-thinking-server', SEQUENTIAL],
  'blender-mcp': ['BlenderMCP', BLENDER],
  'chrome-devtools-mcp': ['chrome-devtools-mcp', CHROME],
  weather: ['weather-mcp', WEATHER],
};

const key = (process.argv[2] ?? '').replace(/@[^/@]+$/, ''); // chrome-devtools-mcp@latest → chrome-devtools-mcp
const entry = PACKAGES[key];
if (entry === undefined) {
  process.stderr.write(`mcp-fixture: no fixture for "${process.argv[2] ?? ''}"\n`);
  process.exit(2);
}
const [serverName, list] = entry;

if (key === '@github/github-mcp-server') {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? '';
  if (token === '' || token === 'bad-token') {
    process.stderr.write('GitHub API: 401 Bad credentials\n');
    process.exit(1);
  }
}

/**
 * The probe's hand on the server, between launches: `$HOME/mcp-fixture-control.json`
 * (HOME is the fixture home the app was launched with, and the app spawns
 * servers with its own environment) —
 *
 *   { "fail": ["blender-mcp"] }   these packages exit before the handshake,
 *                                 the way a server whose dependency is gone
 *                                 does — the "Not responding" frames
 *   { "delayMs": 2500 }           every answer waits this long — the
 *                                 "Refresh in flight" frame
 *
 * Read once at start; the probe writes the file before the click and deletes
 * it after.
 */
function control() {
  try {
    const home = process.env.HOME ?? '';
    if (home === '') return {};
    return JSON.parse(readFileSync(path.join(home, 'mcp-fixture-control.json'), 'utf8'));
  } catch {
    return {};
  }
}
const ctl = control();
if (Array.isArray(ctl.fail) && ctl.fail.includes(key)) {
  process.stderr.write(`${serverName}: could not start (fixture control)\n`);
  process.exit(1);
}
const delayMs = typeof ctl.delayMs === 'number' ? ctl.delayMs : 0;

const tools = list.map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
}));

function send(msg) {
  const write = () => process.stdout.write(`${JSON.stringify(msg)}\n`);
  if (delayMs > 0) setTimeout(write, delayMs);
  else write();
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // a notification (initialized)
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '0.0.0-fixture' },
        },
      });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    default:
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
      });
  }
});
rl.on('close', () => process.exit(0));
