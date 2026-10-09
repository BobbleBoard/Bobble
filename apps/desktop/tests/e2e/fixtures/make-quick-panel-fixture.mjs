/**
 * The mock-pi fixture the quick panel probe runs against: one scripted turn per
 * use case, in the order quick-panel-probe.mjs sends them, each matched by a
 * phrase only that case's message carries (the context lines the panel folds
 * in, see electron/quick/context.ts).
 *
 *   node tests/e2e/fixtures/make-quick-panel-fixture.mjs > tests/e2e/fixtures/quick-panel.json
 *   npx biome format --write tests/e2e/fixtures/quick-panel.json
 */
const model = {
  id: 'qwen3.6-27b',
  name: 'Qwen3.6 27B Q6',
  api: 'openai-completions',
  provider: 'llamacpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 16384,
};

const usage = {
  input: 180,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 220,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const msg = (content) => ({ role: 'assistant', content });
const done = (content) => ({
  ...msg(content),
  api: 'openai-completions',
  provider: 'llamacpp',
  model: model.id,
  usage,
  stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
  timestamp: 0,
});

/** A turn that streams `text` in a few chunks. */
function textTurn(text, { delayMs = 60, chunks = 5, before = [] } = {}) {
  const steps = [{ emit: { type: 'agent_start' } }, { delayMs: 5, emit: { type: 'turn_start' } }];
  steps.push(...before);
  steps.push({ emit: { type: 'message_start', message: msg([]) } });
  const size = Math.ceil(text.length / chunks);
  let sent = '';
  for (let i = 0; i < text.length; i += size) {
    const delta = text.slice(i, i + size);
    sent += delta;
    steps.push({
      delayMs,
      emit: {
        type: 'message_update',
        message: msg([{ type: 'text', text: sent }]),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta,
          partial: msg([{ type: 'text', text: sent }]),
        },
      },
    });
  }
  steps.push({ emit: { type: 'message_end', message: done([{ type: 'text', text }]) } });
  steps.push({
    emit: { type: 'turn_end', message: done([{ type: 'text', text }]), toolResults: [] },
  });
  steps.push({ emit: { type: 'agent_end', messages: [] } });
  return steps;
}

/** One tool call, executed, inside a turn of its own. */
function toolSteps(id, name, args, resultText, thought) {
  const content = [
    ...(thought !== undefined ? [{ type: 'thinking', thinking: thought }] : []),
    { type: 'toolCall', id, name, arguments: args },
  ];
  return [
    { delayMs: 5, emit: { type: 'turn_start' } },
    { emit: { type: 'message_start', message: msg([]) } },
    ...(thought !== undefined
      ? [
          {
            delayMs: 40,
            emit: {
              type: 'message_update',
              message: msg([{ type: 'thinking', thinking: thought }]),
              assistantMessageEvent: {
                type: 'thinking_delta',
                contentIndex: 0,
                delta: thought,
                partial: msg([{ type: 'thinking', thinking: thought }]),
              },
            },
          },
        ]
      : []),
    {
      delayMs: 40,
      emit: {
        type: 'message_update',
        message: msg(content),
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: content.length - 1,
          toolCall: { type: 'toolCall', id, name, arguments: args },
          partial: msg(content),
        },
      },
    },
    { emit: { type: 'message_end', message: done(content) } },
    { emit: { type: 'tool_execution_start', toolCallId: id, toolName: name, args } },
    {
      delayMs: 80,
      emit: {
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: name,
        result: { content: [{ type: 'text', text: resultText }], details: {} },
        isError: false,
      },
    },
    {
      emit: {
        type: 'turn_end',
        message: done(content),
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: id,
            toolName: name,
            content: [{ type: 'text', text: resultText }],
            isError: false,
            timestamp: 0,
          },
        ],
      },
    },
  ];
}

/** The closing words of a tool-using turn. */
function closingText(text) {
  return [
    { delayMs: 5, emit: { type: 'turn_start' } },
    { emit: { type: 'message_start', message: msg([]) } },
    {
      delayMs: 50,
      emit: {
        type: 'message_update',
        message: msg([{ type: 'text', text }]),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: msg([{ type: 'text', text }]),
        },
      },
    },
    { emit: { type: 'message_end', message: done([{ type: 'text', text }]) } },
    { emit: { type: 'turn_end', message: done([{ type: 'text', text }]), toolResults: [] } },
    { emit: { type: 'agent_end', messages: [] } },
  ];
}

const prompts = [
  {
    match: 'capital of Portugal',
    steps: textTurn(
      'The capital of Portugal is **Lisbon**. It sits on the Tagus estuary and has been the capital since the 13th century.',
    ),
  },
  {
    match: 'how many people',
    steps: textTurn(
      'About **550,000** people live in the city itself, and close to **3 million** in the wider Lisbon metropolitan area.',
    ),
  },
  {
    match: 'screenshot of the TextEdit window',
    steps: textTurn(
      'This is a **launch checklist** in TextEdit. It says the quick panel ships once the hotkey, the area capture and the window picker pass on two displays, with three open items:\n\n- Confirm the default shortcut\n- Write the permission guide\n- Record the walkthrough\n\nThe release notes go out on Thursday.',
    ),
  },
  {
    match: 'area of the screen the user selected',
    steps: textTurn(
      'That area shows a **bar chart of visitors by month**. It climbs steadily from left to right, ending at its highest point, which matches the note above it: up 18% on the last quarter.',
    ),
  },
  {
    match: 'screenshot of the whole screen',
    steps: textTurn(
      'You have three windows open: a **Groceries** note, a **launch checklist** in TextEdit and a **Quarterly report** with a visitors chart. The checklist is in front.',
    ),
  },
  {
    match: 'screenshot of the Safari window',
    steps: textTurn(
      'The Safari window shows the **Quarterly report**: visitors are up 18% on the last quarter, led by the new guides.',
    ),
  },
  {
    match: 'screenshot of the Notes window',
    steps: textTurn(
      'Your note is a short **grocery list**: oat milk, lemons, rye bread, coffee beans and basil.',
    ),
  },
  {
    match: 'Fix the spelling and grammar',
    steps: textTurn('The quick brown fox jumps over the lazy dog.', { chunks: 3 }),
  },
  {
    match: 'summoned Bobble while working in TextEdit',
    steps: [
      { emit: { type: 'agent_start' } },
      ...toolSteps(
        'call_snap_1',
        'mac_snapshot',
        { app: 'TextEdit' },
        'TextEdit, "Launch checklist.txt": text area [3], heading "Launch checklist"',
        'The user wants the title bold in TextEdit. Look at the window first.',
      ),
      {
        emit: {
          type: 'extension_ui_request',
          id: 'ui-consent-1',
          method: 'confirm',
          title: 'Let Bobble use TextEdit?',
          message:
            'Bobble wants to click and type in TextEdit to do what you asked. You can stop it at any time with Esc.',
          timeout: 120000,
        },
      },
      { awaitUi: 'ui-consent-1' },
      ...toolSteps(
        'call_key_1',
        'mac_key',
        { app: 'TextEdit', combo: 'cmd+b' },
        'pressed cmd+b in TextEdit',
      ),
      ...closingText(
        'Done. I selected the heading **Launch checklist** in TextEdit and made it bold.',
      ),
    ],
  },
  {
    match: 'Clipboard text',
    steps: textTurn(
      'The clipboard holds a **meeting note**: the design review moved to Friday at 10:00, and the room changed to the second floor.',
    ),
  },
  {
    match: 'Selected in Finder',
    steps: textTurn(
      'You selected two files: **budget-2026.numbers**, a spreadsheet, and **offsite-plan.pdf**, a document. Ask me to open either and I can go through it.',
    ),
  },
  {
    match: 'Open in Safari',
    steps: textTurn(
      'The page is **The quick panel guide**. It explains how to summon Bobble from any app, how to ask about a window or an area of the screen, and which permissions it needs.',
    ),
  },
  {
    match: 'Attached file',
    steps: textTurn(
      'The note you dropped lists **three ideas** for the offsite: a river walk, a cooking class and a museum morning.',
    ),
  },
  { steps: textTurn('Here is a short answer to that.') },
  { steps: textTurn('Here is another short answer.') },
  { steps: textTurn('And one more.') },
];

const fixture = {
  name: 'quick-panel',
  state: {
    model,
    sessionFile: '/tmp/mock-pi/sessions/quick-panel.jsonl',
    sessionId: 'mock-session-quick-panel',
  },
  models: [model],
  prompts: prompts.map((p) => ({ ...p, response: { success: true } })),
};

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
