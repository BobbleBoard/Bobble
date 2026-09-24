/**
 * DOES THE FAKE HINDSIGHT BEHAVE LIKE THE SERVICE? — the smoke probe for
 * fixtures/fake-hindsight.mjs.
 *
 * Runs the memory feature's whole loop against the fake over HTTP, the way
 * the app's memory service and Memory tab will: a tenant-keyed bank created
 * with Bobble's config, an async retain from the outbox (with a resend of the
 * same operation_id, as after a crash), the operation completing, list,
 * recall, forget (invalidate) and restore, forget-a-chat (delete the
 * document), stats, and the 401 without the key.
 *
 * When the real client is on hand it runs the same calls through it too —
 * `HINDSIGHT_CLIENT_DIR=<an unpacked @vectorize-io/hindsight-client@0.10.1>`,
 * or the package installed in apps/desktop once WP-M6 adds it — because a
 * fake that only agrees with itself proves nothing about the real thing.
 *
 *   SHOT_DIR=/tmp/out [HINDSIGHT_CLIENT_DIR=…] node tests/e2e/fake-hindsight-smoke-probe.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeHindsight } from './fixtures/fake-hindsight.mjs';
import { APP_ROOT, focusComplaint, frontmostApp } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'fake-hindsight-smoke');
mkdirSync(OUT, { recursive: true });
const KEY = 'probe-tenant-key';
const BANK = '/v1/default/banks/bobble';
const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
    console.error(`fake-hindsight-smoke FAILED: ${message}`);
  }
  return ok;
};

const before = frontmostApp();
const hs = await startFakeHindsight({ apiKey: KEY, retainDelayMs: 150 });
const call = async (method, p, body, key = KEY) => {
  const res = await fetch(`${hs.url}${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
};

const results = {};
try {
  // ── the app's loop, over HTTP ──
  results.health = (await call('GET', '/health')).json;
  results.unauthorized = (await call('GET', `${BANK}/memories/list`, undefined, 'wrong')).status;
  check(results.unauthorized === 401, 'a wrong tenant key was accepted');

  await call('PUT', BANK, {
    name: 'bobble',
    retain_extraction_mode: 'custom',
    retain_mission: 'durable facts about the person',
  });
  const turn = {
    items: [
      {
        content:
          'User: My name is The user and I build Bobble. I prefer answers in British English.\nBobble: I set the spelling to British English for you.',
        timestamp: '2026-09-23T18:00:00Z',
        context: 'Conversation between the user and Bobble, their local AI assistant.',
        document_id: 'chat:smoke',
        update_mode: 'append',
        tags: ['chat:smoke', 'project:none'],
      },
    ],
    async: true,
    operation_id: 'outbox-1',
  };
  const queued = await call('POST', `${BANK}/memories`, turn);
  await call('POST', `${BANK}/memories`, turn); // the outbox resends after a crash
  check(queued.json.operation_id === 'outbox-1', 'retain did not echo the operation id');
  const statsQueued = (await call('GET', `${BANK}/stats`)).json;
  check(
    statsQueued.pending_operations === 1,
    `pending operations ${statsQueued.pending_operations}`,
  );
  let op;
  for (let i = 0; i < 40; i++) {
    op = (await call('GET', `${BANK}/operations/outbox-1`)).json;
    if (op.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check(op?.status === 'completed', `operation never completed: ${op?.status}`);

  const list = (await call('GET', `${BANK}/memories/list`)).json;
  results.list = list.items.map((u) => `${u.fact_type}: ${u.text}`);
  check(list.total === 3, `expected 3 facts from the turn, got ${list.total}`);
  check(
    list.items.some((u) => u.fact_type === 'experience' && u.text.startsWith('I set the spelling')),
    'Bobble’s own line was not stored as experience',
  );

  const recall = (
    await call('POST', `${BANK}/memories/recall`, {
      query: 'Which spelling does The user prefer?',
      budget: 'mid',
      max_tokens: 800,
    })
  ).json;
  results.recall = recall.results.map((r) => `${r.scores.final} ${r.text}`);
  check(recall.results[0]?.text.includes('British English'), 'recall did not find the preference');

  const target = list.items.find((u) => u.text.startsWith('I prefer answers'));
  await call('PATCH', `${BANK}/memories/${target.id}`, {
    state: 'invalidated',
    reason: 'user forgot it',
  });
  const afterForget = (
    await call('POST', `${BANK}/memories/recall`, { query: 'prefer answers British' })
  ).json;
  check(
    !afterForget.results.some((r) => r.id === target.id),
    'a forgotten fact was still recalled',
  );
  await call('PATCH', `${BANK}/memories/${target.id}`, { state: 'valid' });
  const restored = (await call('GET', `${BANK}/memories/list`)).json.total;
  check(restored === 3, `restore did not bring the fact back (${restored})`);

  const forgetChat = (await call('DELETE', `${BANK}/documents/${encodeURIComponent('chat:smoke')}`))
    .json;
  check(
    forgetChat.memory_units_deleted === 3,
    `forget-chat removed ${forgetChat.memory_units_deleted}`,
  );
  results.statsEnd = (await call('GET', `${BANK}/stats`)).json;

  // ── the same, through the real client when it is here ──
  const require = createRequire(path.join(APP_ROOT, 'package.json'));
  let clientEntry = null;
  if (process.env.HINDSIGHT_CLIENT_DIR) {
    clientEntry = path.join(process.env.HINDSIGHT_CLIENT_DIR, 'dist', 'index.mjs');
  } else {
    try {
      clientEntry = require.resolve('@vectorize-io/hindsight-client');
    } catch {
      clientEntry = null;
    }
  }
  if (clientEntry !== null && existsSync(clientEntry)) {
    const { HindsightClient } = await import(pathToFileURL(clientEntry).href);
    const client = new HindsightClient({ baseUrl: hs.url, apiKey: KEY });
    const version = await client.getVersion();
    await client.createBank('client-bank', {
      retainExtractionMode: 'custom',
      retainMission: 'facts',
    });
    const retained = await client.retain(
      'client-bank',
      'User: The office plant is a fern called Gerald.',
      {
        documentId: 'chat:client',
        tags: ['chat:client'],
      },
    );
    const listed = await client.listMemories('client-bank', { limit: 10 });
    const recalled = await client.recall('client-bank', 'what is the plant called', {
      budget: 'low',
    });
    const docs = await client.listDocuments('client-bank');
    await client.deleteDocument('client-bank', 'chat:client');
    const after = await client.listMemories('client-bank', {});
    const cfg = await client.getBankConfig('client-bank');
    results.realClient = {
      entry: clientEntry,
      apiVersion: version.api_version,
      retained: retained.items_count,
      listed: listed.items.map((u) => u.text),
      recalled: recalled.results.map((r) => r.text),
      documents: docs.items.map((d) => d.id),
      afterForget: after.total,
      config: cfg.config,
    };
    check(
      listed.total === 1 && recalled.results.length === 1,
      'the real client saw a different bank',
    );
    check(after.total === 0, 'the real client’s deleteDocument did not forget the chat');
    check(cfg.config.retain_extraction_mode === 'custom', 'createBank config did not land');
  } else {
    results.realClient =
      'skipped: @vectorize-io/hindsight-client not installed (WP-M6 adds it); set HINDSIGHT_CLIENT_DIR to run it';
  }
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  results.requests = hs.log.length;
  await hs.close();
  const complaint = focusComplaint(before, frontmostApp());
  if (complaint !== null) check(false, complaint);
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

console.log(JSON.stringify(results, null, 2));
if (failures.length > 0) {
  console.error(`fake-hindsight-smoke: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('fake-hindsight-smoke OK');
}
