/**
 * A FAKE HINDSIGHT — the memory service's HTTP API, in memory, deterministic.
 *
 * Memory (track 1) runs Vectorize's Hindsight (MIT) as a local service: retain
 * (fact extraction, which needs the model), recall (search, which does not),
 * and the curation API the Memory tab is built on. The real one is a Python
 * service with embedded Postgres, ONNX models and minutes of cold start; every
 * UI probe and most unit tests want none of that. This answers the same routes
 * with the same shapes — taken from the generated client of
 * @vectorize-io/hindsight-client 0.10.1 (`types.gen.ts` / `sdk.gen.ts`) — from
 * an in-memory bank, and makes "extraction" a rule instead of a model: every
 * sentence of three words or more becomes one fact.
 *
 * ## Routes (all under /v1/default)
 *
 *   GET    /health, /version
 *   GET    /banks                               list          PUT/PATCH/GET/DELETE /banks/{bank}
 *   GET    /banks/{bank}/config                 PATCH …/config {updates}
 *   POST   /banks/{bank}/memories               retain {items, async, operation_id, document_tags}
 *   GET    /banks/{bank}/memories/list          list ?type&q&state&document_id&tags&limit&offset
 *   POST   /banks/{bank}/memories/recall        recall {query, types, budget, max_tokens, tags, tags_match}
 *   GET    /banks/{bank}/memories/{id}          one memory
 *   PATCH  /banks/{bank}/memories/{id}          curate {text?, state: 'invalidated'|'valid', reason?}
 *   DELETE /banks/{bank}/memories               clear the bank (?type=)
 *   GET    /banks/{bank}/documents              DELETE /banks/{bank}/documents/{id}
 *   GET    /banks/{bank}/stats                  counts, pending/failed operations
 *   GET    /banks/{bank}/operations             GET …/operations/{id}
 *   GET    /banks/{bank}/entities
 *
 * Retain follows Hindsight's document semantics: a `document_id` seen before
 * is REPLACED (its facts deleted, new ones extracted) unless the item says
 * `update_mode: 'append'`. `async: true` answers at once with an operation id
 * that completes after `retainDelayMs` (0 = the next tick), which is what the
 * app's outbox and the Memory tab's "learning…" state need to see.
 *
 * Forget is curation, not deletion: PATCH `state: 'invalidated'` hides a fact
 * from recall and the default list, and `state: 'valid'` brings it back.
 *
 * `apiKey` makes every /v1 route demand `Authorization: Bearer <key>` (the
 * tenant-key extension Bobble runs with) and answer 401 without it.
 *
 *   const hs = await startFakeHindsight({ apiKey: 'k' });
 *   … PI_DESKTOP_MEMORY_FAKE_URL = hs.url …
 *   hs.log; hs.seed('bobble', ['the user prefers dark mode.']); await hs.close();
 *
 *   node tests/e2e/fixtures/fake-hindsight.mjs --port 8888 [--api-key k]
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const API_VERSION = '0.10.1';

const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you your my me we our they their what which who how'.split(
    ' ',
  ),
);

const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/**
 * The fake "extraction": one fact per sentence of three words or more, typed
 * by WHO said it — Hindsight's `experience` for what the assistant did
 * ("Bobble:"/"Assistant:" lines, the retain context Bobble sends says so), and
 * `world` for everything else, including the person talking about themselves.
 */
export function extractTypedFacts(content) {
  const text = Array.isArray(content)
    ? content.map((b) => (b?.type === 'text' ? (b.text ?? '') : '')).join('\n')
    : String(content ?? '');
  const facts = [];
  let speaker = 'user';
  for (const line of text.split('\n')) {
    // A speaker label may also start mid-line: "…ok. Bobble: I made you a chart."
    for (const part of line.split(/(?=\b(?:User|Bobble|Assistant):)/)) {
      const label = /^\s*(User|Bobble|Assistant):\s*/i.exec(part);
      if (label !== null) speaker = label[1].toLowerCase() === 'user' ? 'user' : 'assistant';
      const body = label === null ? part : part.slice(label[0].length);
      for (const sentence of body.split(/(?<=[.!?])\s+/)) {
        const s = sentence.trim();
        if (s.split(/\s+/).length < 3) continue;
        facts.push({ text: s, factType: speaker === 'assistant' ? 'experience' : 'world' });
      }
    }
  }
  return facts;
}

/** {@link extractTypedFacts}, texts only. */
export function extractFacts(content) {
  return extractTypedFacts(content).map((f) => f.text);
}

/** Capitalised words that are not sentence-initial stand in for entities. */
function entitiesOf(text) {
  const out = new Set();
  const tokens = text.split(/\s+/);
  tokens.forEach((t, i) => {
    const w = t.replace(/[^\p{L}\p{N}'-]/gu, '');
    if (i > 0 && /^\p{Lu}/u.test(w) && w.length > 1) out.add(w);
  });
  return [...out];
}

function newBank(id) {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    mission: null,
    config: {},
    createdAt: now,
    updatedAt: now,
    units: new Map(),
    documents: new Map(),
    operations: new Map(),
    lastWriteAt: null,
  };
}

/**
 * Start the fake. Options: `port` (0), `host`, `apiKey`, `retainDelayMs` (0),
 * `extract` (content → facts, as strings or `{ text, factType }`; default
 * {@link extractTypedFacts}),
 * `failRetain` (answer retain with 500, for outbox tests).
 */
export async function startFakeHindsight(opts = {}) {
  const extract = opts.extract ?? extractTypedFacts;
  const state = {
    banks: new Map(),
    log: [],
    seq: 0,
    retainDelayMs: opts.retainDelayMs ?? 0,
    failRetain: opts.failRetain ?? false,
  };
  const bankOf = (id, create = true) => {
    if (!state.banks.has(id) && create) state.banks.set(id, newBank(id));
    return state.banks.get(id);
  };

  function addFact(
    bank,
    {
      text,
      factType = 'world',
      documentId = null,
      tags = [],
      context = null,
      mentionedAt,
      metadata = {},
    },
  ) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const unit = {
      id,
      text,
      context,
      date: mentionedAt ?? now,
      fact_type: factType,
      document_id: documentId,
      mentioned_at: mentionedAt ?? now,
      occurred_start: null,
      occurred_end: null,
      entities: entitiesOf(text).join(', '),
      chunk_id: documentId ? `${documentId}#0` : null,
      proof_count: 1,
      tags: [...tags],
      metadata,
      consolidated_at: null,
      consolidation_failed_at: null,
      state: 'valid',
      invalidation_reason: null,
      invalidated_at: null,
      edited_at: null,
      updated_at: now,
      source_memory_ids: [],
      created_at: now,
    };
    bank.units.set(id, unit);
    if (documentId !== null) {
      const doc = bank.documents.get(documentId) ?? {
        id: documentId,
        bank_id: bank.id,
        created_at: now,
        tags: [],
        memory_unit_count: 0,
      };
      doc.updated_at = now;
      doc.memory_unit_count += 1;
      doc.tags = [...new Set([...doc.tags, ...tags])];
      bank.documents.set(documentId, doc);
    }
    bank.lastWriteAt = now;
    return unit;
  }

  function deleteDocument(bank, documentId) {
    let n = 0;
    for (const [id, u] of bank.units) {
      if (u.document_id === documentId) {
        bank.units.delete(id);
        n += 1;
      }
    }
    bank.documents.delete(documentId);
    return n;
  }

  function applyRetain(bank, items, documentTags) {
    let facts = 0;
    for (const item of items) {
      const documentId = item.document_id ?? null;
      if (documentId !== null && item.update_mode !== 'append' && bank.documents.has(documentId)) {
        deleteDocument(bank, documentId);
      }
      const tags = [...(item.tags ?? []), ...(documentTags ?? [])];
      for (const fact of extract(item.content)) {
        const { text, factType = 'world' } = typeof fact === 'string' ? { text: fact } : fact;
        addFact(bank, {
          text,
          factType,
          documentId,
          tags,
          context: item.context ?? null,
          mentionedAt: item.timestamp ?? undefined,
          metadata: item.metadata ?? {},
        });
        facts += 1;
      }
    }
    return facts;
  }

  function visible(u, stateFilter) {
    if (stateFilter === 'all' || stateFilter === 'any') return true;
    return u.state === (stateFilter ?? 'valid');
  }

  /**
   * Hindsight's tag modes (client docs): `any` and `all` INCLUDE untagged
   * memories; the `_strict` variants and `exact` exclude them.
   */
  function tagsMatch(unitTags, want, mode = 'any') {
    if (!want || want.length === 0) return true;
    const has = new Set(unitTags);
    if (has.size === 0) return mode === 'any' || mode === 'all';
    if (mode === 'all' || mode === 'all_strict') return want.every((t) => has.has(t));
    if (mode === 'exact') return want.length === has.size && want.every((t) => has.has(t));
    return want.some((t) => has.has(t));
  }

  function listItem(u) {
    const { created_at: _c, ...rest } = u;
    return rest;
  }

  function recall(bank, body) {
    const q = words(body.query ?? '');
    const types = body.types ?? null;
    const cap = { low: 100, mid: 300, high: 1000 }[body.budget ?? 'mid'] ?? 300;
    const scored = [];
    for (const u of bank.units.values()) {
      if (u.state !== 'valid') continue;
      if (types !== null && !types.includes(u.fact_type)) continue;
      if (!tagsMatch(u.tags, body.tags, body.tags_match)) continue;
      const have = new Set(words(u.text));
      const hits = q.filter((w) => have.has(w)).length;
      if (hits === 0) continue;
      scored.push({ u, score: hits / q.length });
    }
    scored.sort((a, b) => b.score - a.score || (a.u.mentioned_at < b.u.mentioned_at ? 1 : -1));
    const out = [];
    let budget = body.max_tokens ?? 4096;
    for (const { u, score } of scored.slice(0, cap)) {
      const cost = Math.ceil(u.text.length / 4);
      if (cost > budget) break;
      budget -= cost;
      out.push({
        id: u.id,
        text: u.text,
        type: u.fact_type,
        entities: u.entities ? u.entities.split(', ') : [],
        context: u.context,
        occurred_start: null,
        occurred_end: null,
        mentioned_at: u.mentioned_at,
        document_id: u.document_id,
        metadata: u.metadata,
        chunk_id: u.chunk_id,
        tags: u.tags,
        source_fact_ids: null,
        scores: {
          final: Number(score.toFixed(4)),
          keyword: Number(score.toFixed(4)),
          reranker: null,
          semantic: null,
        },
      });
    }
    return { results: out, trace: null, entities: null, chunks: null };
  }

  function stats(bank) {
    const byType = { world: 0, experience: 0, observation: 0 };
    for (const u of bank.units.values())
      if (u.state === 'valid') byType[u.fact_type] = (byType[u.fact_type] ?? 0) + 1;
    const ops = [...bank.operations.values()];
    const byStatus = {};
    for (const o of ops) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    return {
      bank_id: bank.id,
      total_nodes: Object.values(byType).reduce((a, b) => a + b, 0),
      total_links: 0,
      total_documents: bank.documents.size,
      nodes_by_fact_type: byType,
      links_by_link_type: {},
      links_by_fact_type: {},
      links_breakdown: {},
      pending_operations: byStatus.pending ?? 0,
      failed_operations: byStatus.failed ?? 0,
      operations_by_status: byStatus,
      last_consolidated_at: null,
      last_memory_write_at: bank.lastWriteAt,
    };
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => json(res, 500, { detail: String(err) }));
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '')
      ? await readJson(req)
      : undefined;
    const entry = {
      seq: ++state.seq,
      at: Date.now(),
      method: req.method,
      path: p,
      query: url.search,
      body,
    };
    const reply = (status, payload) => {
      state.log.push({ ...entry, status });
      return json(res, status, payload);
    };

    if (p === '/health') return reply(200, { status: 'healthy', database: 'connected' });
    if (p === '/version') {
      return reply(200, {
        api_version: API_VERSION,
        features: {
          observations: false,
          mcp: false,
          worker: true,
          bank_config_api: true,
          bank_llm_health: false,
          file_upload_api: false,
          document_export_api: false,
          document_import_api: false,
          audit_log: false,
          llm_trace: false,
          store_document_text: false,
        },
      });
    }
    if (p === '/__fake/log') return reply(200, state.log);

    if (!p.startsWith('/v1/')) return reply(404, { detail: 'Not Found' });
    if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      return reply(401, { detail: 'Invalid or missing API key' });
    }

    if (p === '/v1/default/banks' && req.method === 'GET') {
      const banks = [...state.banks.values()].map((b) => ({
        bank_id: b.id,
        name: b.name,
        disposition: { skepticism: 3, literalism: 3, empathy: 3 },
        mission: b.mission,
        created_at: b.createdAt,
        updated_at: b.updatedAt,
        fact_count: [...b.units.values()].filter((u) => u.state === 'valid').length,
        last_document_at: null,
        last_write_at: b.lastWriteAt,
      }));
      return reply(200, { banks, total: banks.length, limit: 100, offset: 0 });
    }

    const m = /^\/v1\/default\/banks\/([^/]+)(\/.*)?$/.exec(p);
    if (m === null) return reply(404, { detail: 'Not Found' });
    const bankId = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    const method = req.method;

    if (rest === '') {
      if (method === 'DELETE') {
        const existed = state.banks.delete(bankId);
        return reply(existed ? 200 : 404, {
          success: existed,
          message: existed ? 'deleted' : 'bank not found',
          deleted_count: null,
        });
      }
      const bank = bankOf(bankId, method !== 'GET');
      if (bank === undefined) return reply(404, { detail: `bank ${bankId} not found` });
      if (method === 'PUT' || method === 'PATCH') {
        // CreateBankRequest: name/mission on the profile, everything else
        // (retain_mission, retain_extraction_mode, …) is bank config.
        const { name, mission, background: _b, disposition: _d, ...config } = body ?? {};
        if (typeof name === 'string') bank.name = name;
        if (typeof mission === 'string') bank.mission = mission;
        for (const [k, v] of Object.entries(config))
          if (v !== null && v !== undefined) bank.config[k] = v;
        bank.updatedAt = new Date().toISOString();
      }
      return reply(200, {
        bank_id: bank.id,
        name: bank.name,
        disposition: { skepticism: 3, literalism: 3, empathy: 3 },
        mission: bank.mission ?? '',
        background: null,
      });
    }

    const bank = bankOf(bankId);
    if (rest === '/config') {
      if (method === 'PATCH') Object.assign(bank.config, body?.updates ?? {});
      return reply(200, {
        bank_id: bank.id,
        config: { ...bank.config },
        overrides: { ...bank.config },
      });
    }
    if (rest === '/memories' && method === 'POST') {
      if (state.failRetain) return reply(500, { detail: 'retain failed (fake)' });
      const items = Array.isArray(body?.items) ? body.items : [];
      const operationId = body?.operation_id ?? randomUUID();
      if (body?.async === true) {
        const known = bank.operations.get(operationId);
        if (known === undefined) {
          const now = new Date().toISOString();
          const op = {
            id: operationId,
            task_type: 'retain',
            items_count: items.length,
            document_id: items[0]?.document_id ?? null,
            created_at: now,
            updated_at: now,
            status: 'pending',
            error_message: null,
            retry_count: 0,
          };
          bank.operations.set(operationId, op);
          setTimeout(() => {
            applyRetain(bank, items, body.document_tags);
            op.status = 'completed';
            op.updated_at = new Date().toISOString();
          }, state.retainDelayMs);
        }
        return reply(200, {
          success: true,
          bank_id: bank.id,
          items_count: items.length,
          async: true,
          operation_id: operationId,
          operation_ids: [operationId],
          usage: null,
        });
      }
      applyRetain(bank, items, body?.document_tags);
      return reply(200, {
        success: true,
        bank_id: bank.id,
        items_count: items.length,
        async: false,
        operation_id: null,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    }
    if (rest === '/memories' && method === 'DELETE') {
      const type = url.searchParams.get('type');
      let n = 0;
      for (const [id, u] of bank.units) {
        if (type === null || u.fact_type === type) {
          bank.units.delete(id);
          n += 1;
        }
      }
      if (type === null) bank.documents.clear();
      return reply(200, { success: true, message: `deleted ${n} memory units`, deleted_count: n });
    }
    if (rest === '/memories/list' && method === 'GET') {
      const q = url.searchParams;
      const type = q.get('type');
      const text = q.get('q')?.toLowerCase();
      const documentId = q.get('document_id');
      const stateFilter = q.get('state') ?? 'valid';
      const tags = q.getAll('tags');
      const limit = Number(q.get('limit') ?? 100);
      const offset = Number(q.get('offset') ?? 0);
      const all = [...bank.units.values()]
        .filter((u) => visible(u, stateFilter))
        .filter((u) => type === null || u.fact_type === type)
        .filter((u) => documentId === null || u.document_id === documentId)
        .filter((u) => !text || u.text.toLowerCase().includes(text))
        .filter((u) => tagsMatch(u.tags, tags, q.get('tags_match') ?? 'any'))
        .sort((a, b) =>
          a.mentioned_at < b.mentioned_at
            ? 1
            : a.mentioned_at > b.mentioned_at
              ? -1
              : a.created_at < b.created_at
                ? 1
                : -1,
        );
      return reply(200, {
        items: all.slice(offset, offset + limit).map(listItem),
        total: all.length,
        limit,
        offset,
      });
    }
    if (rest === '/memories/recall' && method === 'POST')
      return reply(200, recall(bank, body ?? {}));

    const one = /^\/memories\/([^/]+)$/.exec(rest);
    if (one !== null) {
      const u = bank.units.get(decodeURIComponent(one[1]));
      if (u === undefined) return reply(404, { detail: 'memory not found' });
      if (method === 'GET') return reply(200, { ...listItem(u), history: [] });
      if (method === 'PATCH') {
        const now = new Date().toISOString();
        if (typeof body?.text === 'string' && body.text !== u.text) {
          u.text = body.text;
          u.edited_at = now;
        }
        if (body?.state === 'invalidated') {
          u.state = 'invalidated';
          u.invalidated_at = now;
          u.invalidation_reason = body.reason ?? null;
        } else if (body?.state === 'valid') {
          u.state = 'valid';
          u.invalidated_at = null;
          u.invalidation_reason = null;
        }
        u.updated_at = now;
        return reply(200, listItem(u));
      }
    }

    if (rest === '/documents' && method === 'GET') {
      const docs = [...bank.documents.values()];
      return reply(200, { items: docs, total: docs.length, limit: 100, offset: 0 });
    }
    const doc = /^\/documents\/([^/]+)$/.exec(rest);
    if (doc !== null) {
      const id = decodeURIComponent(doc[1]);
      if (!bank.documents.has(id)) return reply(404, { detail: 'document not found' });
      if (method === 'DELETE') {
        const n = deleteDocument(bank, id);
        return reply(200, {
          success: true,
          message: 'deleted',
          document_id: id,
          memory_units_deleted: n,
        });
      }
      return reply(200, bank.documents.get(id));
    }
    if (rest === '/stats') return reply(200, stats(bank));
    if (rest === '/operations') {
      const ops = [...bank.operations.values()];
      return reply(200, {
        bank_id: bank.id,
        total: ops.length,
        limit: 100,
        offset: 0,
        operations: ops,
      });
    }
    const op = /^\/operations\/([^/]+)$/.exec(rest);
    if (op !== null) {
      const o = bank.operations.get(decodeURIComponent(op[1]));
      return o === undefined ? reply(404, { detail: 'operation not found' }) : reply(200, o);
    }
    if (rest === '/entities') {
      const counts = new Map();
      for (const u of bank.units.values()) {
        if (u.state !== 'valid' || !u.entities) continue;
        for (const e of u.entities.split(', ')) counts.set(e, (counts.get(e) ?? 0) + 1);
      }
      const items = [...counts].map(([name, n]) => ({
        id: name.toLowerCase(),
        canonical_name: name,
        mention_count: n,
      }));
      return reply(200, { items, total: items.length, limit: 100, offset: 0 });
    }
    return reply(404, { detail: `fake-hindsight: no route ${method} ${p}` });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const url = `http://${opts.host ?? '127.0.0.1'}:${port}`;

  return {
    url,
    port,
    log: state.log,
    /** Put facts straight into a bank (no retain, no operation). Returns their ids. */
    seed(bankId, facts, { tags = [], documentId = null, factType = 'world' } = {}) {
      const bank = bankOf(bankId);
      return facts.map((text) => addFact(bank, { text, tags, documentId, factType }).id);
    },
    /** A bank's facts as the list route would return them (valid only unless `all`). */
    facts(bankId, { all = false } = {}) {
      const bank = state.banks.get(bankId);
      return bank === undefined
        ? []
        : [...bank.units.values()].filter((u) => all || u.state === 'valid');
    },
    setRetainDelay(ms) {
      state.retainDelayMs = ms;
    },
    setFailRetain(v) {
      state.failRetain = v;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const hs = await startFakeHindsight({
    port: Number(arg('--port') ?? 0),
    apiKey: arg('--api-key'),
    retainDelayMs: Number(arg('--retain-delay') ?? 0),
  });
  console.log(`FAKE_HINDSIGHT_READY ${JSON.stringify({ url: hs.url })}`);
  const stop = () => hs.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
