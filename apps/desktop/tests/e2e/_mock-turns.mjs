/**
 * mock-pi turns for the chat-behaviour probes: a reply that STREAMS for a
 * while (so a probe can act mid-turn — scroll, press ⌘Z), and the events an
 * abort plays on its way out, so a stopped turn ends the way real pi's does.
 *
 * mock-pi only honours an abort BETWEEN steps, so the reply is many short
 * steps rather than one long sleep: a stop lands within one step (~120 ms).
 */
import { writeFileSync } from 'node:fs';

const MODEL = {
  id: 'qwen3.5-4b',
  name: 'Qwen3.5 4B',
  api: 'openai-completions',
  provider: 'llamacpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 8192,
};
const USAGE = {
  input: 24,
  output: 12,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 36,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const final = (text, stopReason) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: USAGE,
  stopReason,
  ...(stopReason === 'aborted' ? { errorMessage: 'aborted by user' } : {}),
  timestamp: Date.now(),
});

/**
 * One scripted turn: `text` streamed as `chunks` deltas `stepMs` apart — or,
 * given an array, streamed as exactly those deltas (a probe that needs a
 * chunk to end on a particular character). `match` pins it to a prompt
 * containing that substring (mock-pi consumes turns in order otherwise).
 * `leadMs` holds the reply EMPTY that long first — the pre-first-token
 * window, in which the composer queues a second message.
 */
export function streamedTurn(reply, { chunks = 24, stepMs = 120, match, leadMs = 0 } = {}) {
  const text = Array.isArray(reply) ? reply.join('') : reply;
  const words = Array.isArray(reply) ? reply : text.split(/(?<= )/);
  const per = Array.isArray(reply) ? 1 : Math.max(1, Math.ceil(words.length / chunks));
  const steps = [
    { emit: { type: 'agent_start' } },
    { delayMs: 5, emit: { type: 'turn_start' } },
    { emit: { type: 'message_start', message: { role: 'assistant', content: [] } } },
    ...(leadMs > 0 ? [{ delayMs: leadMs }] : []),
  ];
  let sofar = '';
  for (let i = 0; i < words.length; i += per) {
    const delta = words.slice(i, i + per).join('');
    sofar += delta;
    steps.push({
      delayMs: stepMs,
      emit: {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: sofar }] },
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta,
          partial: { role: 'assistant', content: [{ type: 'text', text: sofar }] },
        },
      },
    });
  }
  steps.push(
    { emit: { type: 'message_end', message: final(text, 'stop') } },
    { emit: { type: 'turn_end', message: final(text, 'stop'), toolResults: [] } },
    { emit: { type: 'agent_end', messages: [] } },
  );
  const abortSteps = [
    { emit: { type: 'message_end', message: final('', 'aborted') } },
    { emit: { type: 'turn_end', message: final('', 'aborted'), toolResults: [] } },
    { emit: { type: 'agent_end', messages: [] } },
  ];
  return {
    ...(match !== undefined ? { match } : {}),
    response: { success: true },
    steps,
    abortSteps,
  };
}

/** Write a mock-pi fixture holding these turns; returns its path. */
export function writeFixture(path, name, prompts) {
  writeFileSync(
    path,
    JSON.stringify({
      name,
      state: { model: MODEL, sessionFile: `/mock/sessions/${name}-0.jsonl`, sessionId: name },
      models: [MODEL],
      prompts,
    }),
  );
  return path;
}
