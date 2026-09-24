/**
 * The fake Hindsight (fixtures/fake-hindsight.mjs): the routes and shapes the
 * memory service, the outbox and the Memory tab are built against.
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error - the fake is plain ESM for probes, not typed app code.
import { extractFacts, extractTypedFacts, startFakeHindsight } from './fixtures/fake-hindsight.mjs';

type Fake = Awaited<ReturnType<typeof startFakeHindsight>>;
type Unit = {
  id: string;
  text: string;
  state: string;
  fact_type: string;
  document_id: string | null;
};
let hs: Fake | null = null;
afterEach(async () => {
  await hs?.close();
  hs = null;
});

const B = '/v1/default/banks/bobble';
async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${hs?.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const retainItem = (content: string, extra: Record<string, unknown> = {}) => ({
  content,
  timestamp: '2026-09-23T18:00:00Z',
  context: 'Conversation between the user and Bobble.',
  document_id: 'chat:s1',
  tags: ['chat:s1', 'project:none'],
  ...extra,
});

describe('retain, list, recall', () => {
  it('extracts one fact per sentence, lists them newest first, recalls by words', async () => {
    hs = await startFakeHindsight();
    const r = await call('POST', `${B}/memories`, {
      items: [retainItem('User: My name is The user. I prefer dark mode in every app. ok')],
    });
    expect(r.json).toMatchObject({
      success: true,
      bank_id: 'bobble',
      items_count: 1,
      async: false,
    });
    const list = await call('GET', `${B}/memories/list`);
    expect(list.json.total).toBe(2);
    const texts = (list.json.items as Unit[]).map((u) => u.text);
    expect(texts).toEqual(
      expect.arrayContaining(['My name is The user.', 'I prefer dark mode in every app.']),
    );
    const rec = await call('POST', `${B}/memories/recall`, { query: 'what mode does he like?' });
    const results = rec.json.results as Array<{ text: string; scores: { final: number } }>;
    expect(results[0]?.text).toBe('I prefer dark mode in every app.');
    expect(results[0]?.scores.final).toBeGreaterThan(0);
  });

  it('replaces a document on a second retain, or appends when asked', async () => {
    hs = await startFakeHindsight();
    await call('POST', `${B}/memories`, {
      items: [retainItem('The project is called Bobble Desktop.')],
    });
    await call('POST', `${B}/memories`, {
      items: [retainItem('The deadline is next Friday afternoon.')],
    });
    expect(hs.facts('bobble').map((u: Unit) => u.text)).toEqual([
      'The deadline is next Friday afternoon.',
    ]);
    await call('POST', `${B}/memories`, {
      items: [retainItem('The budget is four hundred dollars.', { update_mode: 'append' })],
    });
    expect(hs.facts('bobble')).toHaveLength(2);
    const docs = await call('GET', `${B}/documents`);
    expect(docs.json.items).toEqual([
      expect.objectContaining({ id: 'chat:s1', memory_unit_count: 2 }),
    ]);
    const del = await call('DELETE', `${B}/documents/chat%3As1`);
    expect(del.json).toMatchObject({
      success: true,
      document_id: 'chat:s1',
      memory_units_deleted: 2,
    });
    expect(hs.facts('bobble')).toHaveLength(0);
  });

  it('queues async retains as operations, idempotent by operation_id', async () => {
    hs = await startFakeHindsight({ retainDelayMs: 80 });
    const body = {
      items: [retainItem('The user works on a Mac with 24 GB of memory.')],
      async: true,
      operation_id: 'op-1',
    };
    const first = await call('POST', `${B}/memories`, body);
    expect(first.json).toMatchObject({ async: true, operation_id: 'op-1' });
    await call('POST', `${B}/memories`, body); // a resend after a crash
    const pending = await call('GET', `${B}/stats`);
    expect(pending.json.pending_operations).toBe(1);
    expect(hs.facts('bobble')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(hs.facts('bobble')).toHaveLength(1);
    const op = await call('GET', `${B}/operations/op-1`);
    expect(op.json.status).toBe('completed');
    expect((await call('GET', `${B}/stats`)).json).toMatchObject({
      pending_operations: 0,
      total_nodes: 1,
    });
  });

  it('filters recall by type and tags with Hindsight’s modes', async () => {
    hs = await startFakeHindsight();
    hs.seed('bobble', ['The user likes green tea in the morning.'], { tags: ['chat:a'] });
    hs.seed('bobble', ['The user likes black coffee at night.'], { tags: ['chat:b'] });
    hs.seed('bobble', ['The user likes jasmine tea too.']);
    const q = (extra: Record<string, unknown>) =>
      call('POST', `${B}/memories/recall`, { query: 'what does the user like', ...extra }).then((r) =>
        (r.json.results as Array<{ text: string }>).map((x) => x.text).sort(),
      );
    expect(await q({ tags: ['chat:a'] })).toEqual([
      'The user likes green tea in the morning.',
      'The user likes jasmine tea too.', // `any` includes untagged
    ]);
    expect(await q({ tags: ['chat:a'], tags_match: 'any_strict' })).toEqual([
      'The user likes green tea in the morning.',
    ]);
    expect(await q({ types: ['experience'] })).toEqual([]);
  });
});

describe('curation', () => {
  it('invalidates (forget) and restores a memory, reversibly', async () => {
    hs = await startFakeHindsight();
    const [id] = hs.seed('bobble', ['The user has a cat called Miso.']);
    const forgot = await call('PATCH', `${B}/memories/${id}`, {
      state: 'invalidated',
      reason: 'asked',
    });
    expect(forgot.json).toMatchObject({ state: 'invalidated', invalidation_reason: 'asked' });
    expect((await call('GET', `${B}/memories/list`)).json.total).toBe(0);
    expect((await call('GET', `${B}/memories/list?state=invalidated`)).json.total).toBe(1);
    expect(
      ((await call('POST', `${B}/memories/recall`, { query: 'cat' })).json.results as unknown[])
        .length,
    ).toBe(0);
    await call('PATCH', `${B}/memories/${id}`, { state: 'valid' });
    expect((await call('GET', `${B}/memories/list`)).json.total).toBe(1);
    const edited = await call('PATCH', `${B}/memories/${id}`, {
      text: 'The user has a cat called Mochi.',
    });
    expect(edited.json).toMatchObject({ text: 'The user has a cat called Mochi.' });
  });

  it('clears the bank, and deletes it', async () => {
    hs = await startFakeHindsight();
    hs.seed('bobble', ['One fact about the user.', 'Another fact about the user.']);
    expect((await call('DELETE', `${B}/memories`)).json).toMatchObject({
      success: true,
      deleted_count: 2,
    });
    expect((await call('DELETE', B)).json).toMatchObject({ success: true });
    expect((await call('GET', '/v1/default/banks')).json.total).toBe(0);
  });

  it('keeps bank config from create (PUT) and PATCH /config', async () => {
    hs = await startFakeHindsight();
    await call('PUT', B, {
      name: 'Bobble',
      retain_extraction_mode: 'custom',
      retain_mission: 'durable facts',
    });
    await call('PATCH', `${B}/config`, { updates: { memory_defense: { enabled: true } } });
    const cfg = await call('GET', `${B}/config`);
    expect(cfg.json.config).toMatchObject({
      retain_extraction_mode: 'custom',
      retain_mission: 'durable facts',
      memory_defense: { enabled: true },
    });
  });
});

describe('service surface', () => {
  it('answers health and version without a key, and 401s every /v1 route without one', async () => {
    hs = await startFakeHindsight({ apiKey: 'tenant-key' });
    expect((await call('GET', '/health')).json).toEqual({
      status: 'healthy',
      database: 'connected',
    });
    expect((await call('GET', '/version')).json.api_version).toBe('0.10.1');
    expect((await call('GET', `${B}/memories/list`)).status).toBe(401);
    expect((await call('GET', `${B}/memories/list`, undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', `${B}/memories/list`, undefined, 'tenant-key')).status).toBe(200);
  });

  it('fails retain on demand, for outbox tests', async () => {
    hs = await startFakeHindsight({ failRetain: true });
    expect(
      (await call('POST', `${B}/memories`, { items: [retainItem('A fact that will not land.')] }))
        .status,
    ).toBe(500);
    hs.setFailRetain(false);
    expect(
      (await call('POST', `${B}/memories`, { items: [retainItem('A fact that will land.')] }))
        .status,
    ).toBe(200);
  });

  it('extracts facts from text and from content blocks, skipping fragments', () => {
    expect(extractFacts('User: I live in Leeds. ok. Bobble: I made you a chart.')).toEqual([
      'I live in Leeds.',
      'I made you a chart.',
    ]);
    expect(extractFacts([{ type: 'text', text: 'The meeting is on Monday.' }])).toEqual([
      'The meeting is on Monday.',
    ]);
  });

  it('types a fact by who said it: the person is world, Bobble is experience', () => {
    expect(
      extractTypedFacts('User: I live in Leeds.\nBobble: I made you a chart.\nIt has three bars.'),
    ).toEqual([
      { text: 'I live in Leeds.', factType: 'world' },
      { text: 'I made you a chart.', factType: 'experience' },
      { text: 'It has three bars.', factType: 'experience' },
    ]);
  });
});
