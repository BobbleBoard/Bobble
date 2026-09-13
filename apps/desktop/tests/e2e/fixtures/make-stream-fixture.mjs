/**
 * Build a mock-pi fixture that streams a LONG bulleted list slowly — the shape
 * the user described when auto-scroll kept snapping him down ("if the model is
 * writing a bulleted list quickly") and the shape in his gap screenshot.
 *
 *   node tests/e2e/fixtures/make-stream-fixture.mjs > /tmp/stream-fixture.json
 *   LINES=40 DELAY_MS=120 …
 */
const LINES = Number(process.env.LINES ?? 40);
const DELAY = Number(process.env.DELAY_MS ?? 120);
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
const partial = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
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
let text = 'Here is the list you asked for:\n\n';
steps.push({
  delayMs: DELAY,
  emit: {
    type: 'message_update',
    message: partial(text),
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: text,
      partial: partial(text),
    },
  },
});
for (let i = 1; i <= LINES; i++) {
  const delta = `- Item ${i}: a short line about the ${['lighthouse', 'bakery', 'harbour', 'library', 'station'][i % 5]} in town number ${i}\n`;
  text += delta;
  steps.push({
    delayMs: DELAY,
    emit: {
      type: 'message_update',
      message: partial(text),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: partial(text) },
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
    output: LINES * 16,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 24 + LINES * 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 1770000000000,
};
steps.push({ emit: { type: 'message_end', message: done } });
steps.push({ emit: { type: 'turn_end', message: done, toolResults: [] } });
steps.push({ emit: { type: 'agent_end', messages: [done] } });
const fixture = {
  name: 'stream-list',
  state: {
    model,
    sessionFile: '/tmp/mock-pi/sessions/stream-list.jsonl',
    sessionId: 'mock-session-stream-list',
  },
  models: [model],
  prompts: [
    { response: { success: true }, steps },
    { response: { success: true }, steps },
    { response: { success: true }, steps },
  ],
};
process.stdout.write(JSON.stringify(fixture));
