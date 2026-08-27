/**
 * THE BASH-CLI EXPERIMENT — does one bash tool beat N JSON schemas?
 *
 * the user's hypothesis, verbatim: "I would totally bet that we get near if not
 * actual 100% tool success rate because the actual tool syntax is just the one
 * bash tool and no modern model is failing to write simple bash commands these
 * days."
 *
 * WHAT IS COMPARED. The same models, the same tasks, the same underlying tool
 * universe, described two ways:
 *
 *   schemas — every tool advertised as a JSON tool definition, the way the
 *             harness does it today. The model emits a structured tool call.
 *   cli     — ONE tool advertised (`bash`). Every tool is a command on PATH,
 *             discoverable with `tools`, `tools search` and `--help`. The model
 *             emits a shell line.
 *
 * WHAT IS MEASURED, per model and config:
 *   accuracy   — the right tool ran, with its required arguments
 *   discovery  — it found a tool it was not told about, by looking
 *   refusals   — it claimed it could not do something it can do ("I don't have
 *                a tool for that"), which is the failure mode this project keeps
 *                meeting and the reason the experiment exists
 *   turns      — how many round trips it took
 *
 * HONESTY OF THE SETUP. Both configs are built from the SAME captured tool
 * definitions — the real ones, taken by handing `registerGenTools` a recording
 * stand-in for the extension API — and the cli side resolves through the real
 * `resolveCli`, not a copy of it. Neither side gets a hint the other lacks: the
 * schema side gets full JSON schemas in-context, the cli side gets one paragraph
 * saying the commands exist and how to look them up.
 *
 * Tool calls are NOT executed. A generation takes minutes and would measure the
 * GPU; what is under test is whether the model reaches the right call at all, so
 * results are stubbed and fed back so the conversation can continue.
 *
 *   node tests/e2e/tool-cli-eval.mjs                 # every model
 *   MODELS=qwen3.5-4b-mtp node tests/e2e/tool-cli-eval.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  buildCli,
  renderRootHelp,
  resolveCli,
} from '../../../../packages/harness/src/tools/tool-cli.ts';

const OUT = process.env.OUT ?? '/tmp/tool-cli-eval';
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'run.log');
const log = (...a) => {
  const line = `${a.join(' ')}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(LOG, line);
  } catch {}
};

/*
 * THE REAL TOOL DEFINITIONS, not a transcription of them.
 *
 * `gen-tools` is imported through a one-shot esbuild bundle because its import
 * chain reaches a file using TypeScript parameter properties, which Node's
 * strip-only mode cannot parse. Bundling costs a second and keeps this
 * experiment measuring the descriptions and schemas the app actually ships — a
 * hand-copied universe would drift, and every number below would quietly become
 * a claim about the copy.
 */
const BUNDLE = path.join(OUT, 'gen-tools-bundle.mjs');
function bundleGenTools() {
  const esbuild = execFileSync('find', [
    path.resolve('../../node_modules/.pnpm'),
    '-path',
    '*@esbuild/darwin-arm64*/bin/esbuild',
    '-type',
    'f',
  ])
    .toString()
    .trim()
    .split('\n')[0];
  execFileSync(esbuild, [
    path.resolve('../../packages/gen-tools/src/tools.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${BUNDLE}`,
    '--external:@mariozechner/*',
    '--log-level=error',
  ]);
}

// ── the tool universe, captured from the real registrars ────────────────────

/** A stand-in for pi's ExtensionAPI that records what a registrar registers. */
function recordingPi() {
  const tools = [];
  return {
    tools,
    registerTool: (t) =>
      tools.push({ name: t.name, description: t.description, parameters: t.parameters }),
    registerCommand: () => {},
    registerExtension: () => {},
    getAllTools: () => tools,
    setActiveTools: () => {},
  };
}

bundleGenTools();
const { registerAudioTools, registerGenTools } = await import(BUNDLE);

const recorder = recordingPi();
const noBridge = {
  bridge: { call: async () => ({ outputs: [] }) },
  readImage: async () => Buffer.alloc(0),
};
registerGenTools(recorder, noBridge);
registerAudioTools(recorder, noBridge);

/**
 * The rest of the universe — the ordinary tools any turn carries. Kept small and
 * realistic: the comparison is about how a tool is REACHED, so padding the
 * schema side with twenty more definitions would just be measuring context size.
 */
const EXTRA_TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: 'Read a file from disk.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web and return results.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const GEN_TOOLS = recorder.tools;
const ALL_TOOLS = [...GEN_TOOLS, ...EXTRA_TOOLS];

/** The capability groups, mirroring `capabilities.ts`. */
const GROUPS = [
  {
    name: 'generation',
    summary: 'Make images, video, speech, music and sound effects on this machine.',
    tools: GEN_TOOLS.map((t) => t.name),
  },
  { name: 'web-research', summary: 'Search the web.', tools: ['web_search'] },
];

const CLI = buildCli(GROUPS, ALL_TOOLS);

// ── tasks ───────────────────────────────────────────────────────────────────

/**
 * `expect: null` means NO tool should be called — over-triggering is a failure
 * too, and a config that reaches for a generator when asked for arithmetic has
 * not won anything.
 */
const TASKS = [
  {
    id: 'image-direct',
    kind: 'direct',
    ask: 'Make me a picture of a red fox asleep in tall grass at sunset.',
    expect: 'generate_image',
  },
  {
    id: 'speech-direct',
    kind: 'direct',
    ask: 'Read this out loud for me: "Bobble can speak now."',
    expect: 'generate_speech',
  },
  {
    id: 'sfx-discovery',
    kind: 'discovery',
    ask: "I'm making a game scene and I need the sound of a heavy wooden door slamming shut.",
    expect: 'generate_sfx',
  },
  {
    id: 'music-refusal-bait',
    kind: 'refusal-bait',
    ask: 'Can you make some background music for a video I am editing? Something calm.',
    expect: 'generate_music',
  },
  {
    id: 'video-direct',
    kind: 'direct',
    ask: 'Generate a short video clip of a paper boat drifting down a rain gutter.',
    expect: 'generate_video',
  },
  {
    id: 'no-tool',
    kind: 'none',
    ask: 'What is 17 times 23? Just tell me the number.',
    expect: null,
  },
];

// ── the two configurations ──────────────────────────────────────────────────

const SYSTEM_SCHEMAS =
  "You are a helpful assistant running locally on the user's Mac. " +
  'Use the tools available to you when they fit the request.';

/*
 * THE THIRD ARM, added after the first run rather than designed in — which is
 * the point of running it.
 *
 * With discovery alone, Qwen3.5-4B answered "I'm sorry, but I don't have the
 * capability to generate video clips directly. I ONLY HAVE ACCESS TO SHELL
 * COMMANDS" and never ran `tools`. Handing a model a terminal and hoping it
 * goes looking reproduces the exact false-refusal this experiment exists to
 * remove, so the remedy has to be measured too: put the command list IN the
 * system prompt. It is ~40 tokens, it never changes between turns, and it costs
 * nothing at the KV prefix — which is the actual claim being tested, that every
 * capability can be resident at once without paying per-turn for schemas.
 */
const SYSTEM_CLI_LISTED = () =>
  [
    "You are a helpful assistant running locally on the user's Mac.",
    '',
    'Your abilities are COMMANDS in the shell, reachable with the `bash` tool.',
    'You CAN do everything these commands do — running one is how you do it.',
    '',
    renderRootHelp(CLI),
    '',
    'Run `<command> --help` before using one if you are unsure of its arguments.',
  ].join('\n');

const SYSTEM_CLI = [
  "You are a helpful assistant running locally on the user's Mac.",
  '',
  'Your abilities are COMMANDS in the shell, reachable with the `bash` tool.',
  'Run `tools` to list every command, `tools search <words>` to find one, and',
  '`<command> --help` to see its arguments. Anything you can do, you do by',
  'running a command — there is no other tool interface.',
].join('\n');

/*
 * THE TUNED PREAMBLE — written against the FAILURES, not from taste.
 *
 * Three things went wrong in the measured runs, and each line here answers one:
 *
 *   1. Ling-3.0-tiny treated the shell as a real Unix box and went shopping —
 *      `festival`, `say`, `which ffmpeg`, `pip list`, `ls /usr/bin`, PIL — for
 *      three turns before it ever read its own help. When your tools look like
 *      commands, the whole command ecosystem looks like your tools. So the
 *      prompt says these are the only ones, and names the temptations.
 *
 *   2. Several models answered "I only have access to shell commands" and never
 *      looked. So it states outright that the commands ARE the ability.
 *
 *   3. Two models ran `--help`, found the right command, and then stopped
 *      without running it. So it says what to do after reading help.
 *
 * Kept to a dozen lines: this rides in every request, and a preamble that
 * lectures is a preamble that crowds out the conversation.
 */
const SYSTEM_CLI_TUNED = () =>
  [
    "You are a helpful assistant running locally on the user's Mac.",
    '',
    'These commands are your abilities. Run them with the `bash` tool.',
    '',
    renderRootHelp(CLI),
    '',
    'They are the ONLY way to make images, video, speech, music or sound effects.',
    'Do not look for other programs — ffmpeg, sox, say, festival, python imaging',
    'libraries and the like are not installed and are not how this works. Do not',
    'check whether anything exists first; just run the command.',
    '',
    "If you are unsure of a command's arguments, run `<command> --help`, then run",
    'the real command. Reading the help is not finishing the task.',
    '',
    'Never tell the user you are unable to do something one of these commands does.',
  ].join('\n');

/**
 * THE PROMPT THAT ACTUALLY SHIPS, read from a capture rather than rebuilt.
 *
 * The tuned arm above is ~20 lines. The shipped bash-CLI prompt is that plus
 * everything pi puts in front of it — its own tool-usage guidance, the harness's
 * verify section, the working directory — which measured 5,172 characters. So
 * `cli-tuned`'s numbers describe a prompt no user ever receives, and the gap
 * between the two is exactly what this arm exists to size.
 *
 * It reads a file rather than reconstructing the prompt, because a
 * reconstruction is a second implementation that can drift from the first. The
 * default path is what `prompt-truth-probe.mjs` writes, so the two compose:
 *
 *   node tests/e2e/prompt-truth-probe.mjs        # capture what went over the wire
 *   node tests/e2e/tool-cli-eval.mjs             # measure it
 */
const SHIPPED_PROMPT_PATH =
  process.env.SHIPPED_PROMPT ?? path.join('/tmp/prompt-truth', 'first-system.txt');

const SYSTEM_CLI_SHIPPED = () => {
  if (!existsSync(SHIPPED_PROMPT_PATH)) return null;
  const text = readFileSync(SHIPPED_PROMPT_PATH, 'utf8').trim();
  return text.length > 0 ? text : null;
};

const BASH_ONLY = [EXTRA_TOOLS[0]];

/** JSON-schema tool definitions in the OpenAI shape llama-server expects. */
const asOpenAiTools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));

// ── the model under test ────────────────────────────────────────────────────

const MODELS_DIR = path.join(homedir(), '.cache/pi-desktop/models');
const TEMPLATES = path.join(homedir(), '.cache/pi-desktop/chat-templates');
const SERVER_BIN = findServerBin();
const PORT = Number(process.env.PORT ?? 8099);

/**
 * The NEWEST llama-server build, by build NUMBER.
 *
 * Sorting the directory names as strings puts `b9934` above `b10603`, because
 * '9' > '1' — so this quietly picked the July build over the August one, and
 * Ling-3.0-tiny "failed to load" with `unknown model architecture: bailingmoe3`
 * on an engine that simply predated the architecture. The models that did run
 * ran on the wrong binary too. Compare the numbers, not the strings.
 */
function findServerBin() {
  const root = path.join(homedir(), '.cache/pi-desktop/llamacpp');
  const builds = readdirSync(root)
    .map((name) => ({ name, n: Number(/^b(\d+)$/.exec(name)?.[1] ?? '-1') }))
    .sort((a, b) => b.n - a.n);
  for (const build of builds) {
    const p = path.join(root, build.name);
    for (const inner of readdirSync(p)) {
      const bin = path.join(p, inner, 'llama-server');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error('no llama-server found');
}

/** The .gguf inside a model dir (largest file wins for split archives). */
function ggufFor(dir) {
  const full = path.join(MODELS_DIR, dir);
  const files = readdirSync(full).filter((f) => f.endsWith('.gguf'));
  const first = files.filter((f) => !/-0000\d-of-/.test(f) || /-00001-of-/.test(f)).sort()[0];
  return first === undefined ? null : path.join(full, first);
}

/** Best-effort chat template match: the model dir name against the cache. */
function templateFor(dir) {
  if (!existsSync(TEMPLATES)) return null;
  const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.jinja'));
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const d = norm(dir);
  let best = null;
  for (const f of files) {
    const n = norm(
      f
        .replace(/\.jinja$/, '')
        .split('--')
        .pop() ?? '',
    );
    if (n.length >= 4 && (d.includes(n) || n.includes(d.slice(0, 10)))) {
      if (best === null || n.length > best.len) best = { file: f, len: n.length };
    }
  }
  return best === null ? null : path.join(TEMPLATES, best.file);
}

let serverProc = null;

async function startServer(modelDir) {
  const gguf = ggufFor(modelDir);
  if (gguf === null) throw new Error(`no gguf in ${modelDir}`);
  const template = templateFor(modelDir);
  const args = [
    '-m',
    gguf,
    '--port',
    String(PORT),
    '-c',
    '16384',
    '--parallel',
    '1',
    '-ngl',
    '999',
    '--jinja',
  ];
  if (template !== null) args.push('--chat-template-file', template);
  log(`[server] ${modelDir}  template=${template ? path.basename(template) : 'built-in'}`);
  serverProc = spawn(SERVER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = path.join(OUT, `server-${modelDir}.log`);
  const append = (d) => {
    try {
      appendFileSync(sink, d);
    } catch {}
  };
  serverProc.stdout.on('data', append);
  serverProc.stderr.on('data', append);
  await waitHealthy();
}

async function waitHealthy(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc?.exitCode !== null && serverProc?.exitCode !== undefined) {
      throw new Error(`server exited (${serverProc.exitCode})`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server never became healthy');
}

function stopServer() {
  if (serverProc !== null && serverProc.exitCode === null) {
    try {
      serverProc.kill('SIGKILL');
    } catch {}
  }
  serverProc = null;
}

async function chat(messages, tools) {
  const body = {
    messages,
    tools: asOpenAiTools(tools),
    tool_choice: 'auto',
    temperature: 0.2,
    max_tokens: 512,
    stream: false,
  };
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message ?? {};
}

// ── running one task ────────────────────────────────────────────────────────

const REFUSAL =
  /\b(i (don'?t|do not) have|i (can'?t|cannot|am unable to|'m unable to)|no (such )?(tool|command|ability|capability)|not (capable|able) (of|to)|i lack)\b/i;

/** What a stubbed tool call returns, so the conversation can continue. */
const stubResult = (name) =>
  `${name}: done. Output written to /Users/you/Bobble/generated/out (stubbed for evaluation).`;

/**
 * The cli side's bash executor: the REAL resolver, with calls stubbed.
 * `tools` / `--help` / `tools search` return their real generated text, which is
 * the whole point — discovery is what is being measured.
 */
function runCliCommand(command) {
  const argv = tokenize(command);
  if (argv.length === 0) return { text: '', resolved: null };
  const res = resolveCli(CLI, argv);
  if (res.kind === 'call') return { text: stubResult(res.tool), resolved: res };
  return { text: res.text, resolved: null };
}

/** Split a shell-ish line, honouring quotes. Good enough for a command line. */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = re.exec(line);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(line);
  }
  return out;
}

async function runTask(task, config) {
  const isCli = config.startsWith('cli');
  const system =
    config === 'cli'
      ? SYSTEM_CLI
      : config === 'cli-listed'
        ? SYSTEM_CLI_LISTED()
        : config === 'cli-tuned'
          ? SYSTEM_CLI_TUNED()
          : config === 'cli-shipped'
            ? (SYSTEM_CLI_SHIPPED() ?? SYSTEM_CLI_TUNED())
            : SYSTEM_SCHEMAS;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task.ask },
  ];
  const tools = isCli ? BASH_ONLY : ALL_TOOLS;
  const record = {
    task: task.id,
    config,
    turns: 0,
    called: null,
    args: null,
    explored: false,
    refused: false,
    malformed: false,
    transcript: [],
    error: null,
  };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    record.turns = turn + 1;
    let msg;
    try {
      msg = await chat(messages, tools);
    } catch (e) {
      record.error = String(e).slice(0, 200);
      return record;
    }
    const calls = msg.tool_calls ?? [];
    const text = msg.content ?? '';
    record.transcript.push({ turn, text: text.slice(0, 300), calls: calls.length });

    if (calls.length === 0) {
      if (REFUSAL.test(text)) record.refused = true;
      return record;
    }

    messages.push({ role: 'assistant', content: text, tool_calls: calls });

    for (const c of calls) {
      const name = c.function?.name ?? '';
      let args = {};
      try {
        args = JSON.parse(c.function?.arguments ?? '{}');
      } catch {
        record.malformed = true;
      }

      if (!isCli) {
        record.called = name;
        record.args = args;
        return record;
      }

      // cli: the only tool is bash, so read the command out of it.
      const command = String(args.command ?? '').trim();
      record.transcript.push({ turn, command: command.slice(0, 200) });
      const { text: outText, resolved } = runCliCommand(command);
      if (resolved !== null) {
        record.called = resolved.tool;
        record.args = resolved.args;
        return record;
      }
      // Not a call: a discovery command (tools / --help / search) or a miss.
      if (/^\s*(tools|.*--help|.*\bhelp\b)/.test(command)) record.explored = true;
      messages.push({
        role: 'tool',
        tool_call_id: c.id ?? 'call',
        content: outText.slice(0, 2000),
      });
    }
  }
  return record;
}

// ── scoring ─────────────────────────────────────────────────────────────────

function score(records) {
  const byConfig = {};
  for (const r of records) {
    byConfig[r.config] ??= {
      total: 0,
      correct: 0,
      wrongTool: 0,
      noCall: 0,
      refused: 0,
      malformed: 0,
      explored: 0,
      turns: 0,
      errors: 0,
    };
    const c = byConfig[r.config];
    const task = TASKS.find((t) => t.id === r.task);
    c.total += 1;
    c.turns += r.turns;
    if (r.error !== null) c.errors += 1;
    if (r.refused) c.refused += 1;
    if (r.malformed) c.malformed += 1;
    if (r.explored) c.explored += 1;
    if (task.expect === null) {
      if (r.called === null) c.correct += 1;
      else c.wrongTool += 1;
    } else if (r.called === task.expect) {
      c.correct += 1;
    } else if (r.called === null) {
      c.noCall += 1;
    } else {
      c.wrongTool += 1;
    }
  }
  return byConfig;
}

// ── main ────────────────────────────────────────────────────────────────────

const DEFAULT_MODELS = [
  'liquidai-lfm2-5-1-2b-instruct-gguf-bf16',
  'unsloth-qwen3-5-2b-mtp-gguf-bf16',
  'gemma-4-e2b-it',
  'ling-3.0-tiny',
  'qwen3.5-4b-mtp',
  'qwen3.5-9b-mtp',
];
const MODELS = (process.env.MODELS ?? DEFAULT_MODELS.join(',')).split(',').filter(Boolean);
/*
 * `cli-shipped` is in the default set on purpose: the tuned arm measures a
 * prompt nobody receives, and shipping a number from it is how "34/36" came to
 * describe a configuration that does not exist.
 */
const CONFIGS = (process.env.CONFIGS ?? 'schemas,cli-tuned,cli-shipped').split(',').filter(Boolean);
/* The turn cap is a MEASUREMENT BOUNDARY, not a property of the interface: a
   model that probes the system before reading its own help can find the right
   command on turn 5 and be scored a failure at 4. Raise it to tell "cannot"
   apart from "slow". */
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 4);

log(`[eval] ${ALL_TOOLS.length} tools, ${CLI.groups.length} cli groups, ${TASKS.length} tasks`);
log(`[eval] cli surface:\n${renderRootHelp(CLI)}\n`);

const all = [];
for (const model of MODELS) {
  if (!existsSync(path.join(MODELS_DIR, model))) {
    log(`[skip] ${model} — not installed`);
    continue;
  }
  try {
    await startServer(model);
  } catch (e) {
    log(`[skip] ${model} — ${String(e).slice(0, 160)}`);
    stopServer();
    continue;
  }
  for (const config of CONFIGS) {
    for (const task of TASKS) {
      const t0 = Date.now();
      const rec = await runTask(task, config);
      rec.model = model;
      rec.ms = Date.now() - t0;
      all.push(rec);
      const verdict =
        rec.error !== null
          ? `ERR ${rec.error.slice(0, 40)}`
          : `called=${rec.called ?? '—'} turns=${rec.turns}${rec.explored ? ' explored' : ''}${rec.refused ? ' REFUSED' : ''}`;
      log(`  ${model} ${config.padEnd(7)} ${task.id.padEnd(20)} ${verdict}`);
    }
  }
  stopServer();
  await new Promise((r) => setTimeout(r, 2000));
}

writeFileSync(path.join(OUT, 'records.json'), JSON.stringify(all, null, 2));

// Per-model, per-config summary.
log('\n=== RESULTS ===');
log(
  'model                                config   correct  wrongTool  noCall  refused  explored  avgTurns',
);
for (const model of MODELS) {
  const mine = all.filter((r) => r.model === model);
  if (mine.length === 0) continue;
  const s = score(mine);
  for (const config of CONFIGS) {
    const c = s[config];
    if (c === undefined) continue;
    log(
      `${model.padEnd(36)} ${config.padEnd(8)} ${String(`${c.correct}/${c.total}`).padEnd(8)} ` +
        `${String(c.wrongTool).padEnd(10)} ${String(c.noCall).padEnd(7)} ${String(c.refused).padEnd(8)} ` +
        `${String(c.explored).padEnd(9)} ${(c.turns / c.total).toFixed(1)}`,
    );
  }
}

const overall = score(all);
log('\n=== OVERALL ===');
for (const [config, c] of Object.entries(overall)) {
  log(
    `${config.padEnd(8)} correct ${c.correct}/${c.total} (${Math.round((100 * c.correct) / c.total)}%)  ` +
      `wrongTool ${c.wrongTool}  noCall ${c.noCall}  refused ${c.refused}  malformed ${c.malformed}  ` +
      `explored ${c.explored}  avgTurns ${(c.turns / c.total).toFixed(1)}`,
  );
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(overall, null, 2));
log(`\nartifacts in ${OUT}`);
stopServer();
