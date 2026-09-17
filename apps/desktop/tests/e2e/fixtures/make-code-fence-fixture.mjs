/**
 * Build the mock-pi fixture behind code-theme-probe.mjs: a reply that is
 * mostly code — a TypeScript fence, a diff fence, a shell fence — so the
 * chat's syntax highlighting and diff tints have something to colour.
 *
 *   node tests/e2e/fixtures/make-code-fence-fixture.mjs > tests/e2e/fixtures/code-fence.json
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

const text = [
  'Here is the greeting, typed, with the change as a diff:',
  '',
  '```ts',
  '// Greet someone by name.',
  'export function greet(name: string, times = 1): string {',
  '  const lines: string[] = [];',
  '  for (let i = 0; i < times; i++) {',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source
  '    lines.push(`Hello, ${name}!`);',
  '  }',
  '  return lines.join("\\n");',
  '}',
  '```',
  '',
  '```diff',
  '--- a/greet.ts',
  '+++ b/greet.ts',
  '@@ -1,3 +1,3 @@',
  ' function greet(name: string) {',
  '-  return "Hello, " + name;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source
  '+  return `Hello, ${name}!`;',
  ' }',
  '```',
  '',
  'And to run it:',
  '',
  '```bash',
  'npx tsx greet.ts --name "Ada" # prints once',
  '```',
].join('\n');

const partial = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const steps = [
  { emit: { type: 'agent_start' } },
  { delayMs: 5, emit: { type: 'turn_start' } },
  { emit: { type: 'message_start', message: { role: 'assistant', content: [] } } },
  {
    emit: {
      type: 'message_update',
      message: partial(''),
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: partial('') },
    },
  },
];
// Streamed in a few chunks so the fence is highlighted while it is still open.
const chunks = 6;
let sent = '';
for (let i = 1; i <= chunks; i++) {
  const upto = Math.floor((text.length * i) / chunks);
  const delta = text.slice(sent.length, upto);
  sent += delta;
  steps.push({
    delayMs: 20,
    emit: {
      type: 'message_update',
      message: partial(sent),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: partial(sent) },
    },
  });
}
steps.push({
  emit: {
    type: 'message_update',
    message: partial(text),
    assistantMessageEvent: {
      type: 'text_end',
      contentIndex: 0,
      content: text,
      partial: partial(text),
    },
  },
});
const done = {
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'llamacpp',
  model: model.id,
  usage: {
    input: 24,
    output: 160,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 184,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 1770000000000,
};
steps.push({ emit: { type: 'message_end', message: done } });
steps.push({ emit: { type: 'turn_end', message: done, toolResults: [] } });
steps.push({ emit: { type: 'agent_end', messages: [done] } });
const prompt = { response: { success: true }, steps };
const fixture = {
  name: 'code-fence',
  state: {
    model,
    sessionFile: '/tmp/mock-pi/sessions/code-fence.jsonl',
    sessionId: 'mock-session-code-fence',
  },
  models: [model],
  prompts: [prompt, prompt, prompt],
};
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
