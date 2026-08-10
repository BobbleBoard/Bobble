/**
 * Unit coverage for the pure THEME 3 mapping: the chain GROUPING RULE
 * (segmentBlocks), tool→kind classification, and the per-kind step data
 * (bash command+output, edit diff, read preview, media opensInCanvas + tabSpec).
 */
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import {
  chainRunningFlags,
  cleanThought,
  firstMediaUrl,
  type GroupSegment,
  generatedImageSrc,
  isEmptyThinking,
  mapThinkingStep,
  mapToolStep,
  resolveTool,
  segmentBlocks,
  segmentGroup,
  toolStepKind,
} from './activity-mapping';

type ToolCall = Extract<ContentBlock, { type: 'toolCall' }>;
type Thinking = Extract<ContentBlock, { type: 'thinking' }>;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const think = (t: string): Thinking => ({ type: 'thinking', thinking: t });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const result = (id: string, out: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'x',
  text: out,
  isError: false,
  timestamp: 0,
});

describe('segmentBlocks (grouping rule)', () => {
  it('coalesces consecutive thinking + tool calls into one chain, split by text', () => {
    const segments = segmentBlocks([
      text('Let me look.'),
      think('planning'),
      call('c1', 'bash', { command: 'ls' }),
      call('c2', 'edit', { path: 'a.txt' }),
      text('Done.'),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'chain', 'text']);
    const chain = segments[1];
    expect(chain?.kind).toBe('chain');
    if (chain?.kind === 'chain') expect(chain.blocks).toHaveLength(3);
  });

  it('renders a run of only thoughts (no tool call) as standalone thoughts', () => {
    const segments = segmentBlocks([think('just thinking'), text('answer')]);
    expect(segments.map((s) => s.kind)).toEqual(['thoughts', 'text']);
  });

  it('drops empty text blocks', () => {
    expect(segmentBlocks([text(''), call('c1', 'bash', {})]).map((s) => s.kind)).toEqual(['chain']);
  });
});

const assistant = (id: string, blocks: ContentBlock[], streaming = false): AssistantMsg => ({
  kind: 'assistant',
  id,
  blocks,
  isStreaming: streaming,
  timestamp: 0,
});

describe('segmentGroup (A1 — inline artifact interleaving)', () => {
  it('splices an artifact BETWEEN the text before and after its fence', () => {
    const seg = segmentGroup([
      assistant('m1', [
        text('Before the drawing.\n\n```svg\n<svg><circle/></svg>\n```\n\nAfter the drawing.'),
      ]),
    ]);
    expect(seg.map((s) => s.kind)).toEqual(['text', 'artifact', 'text']);
    const [before, art, after] = seg;
    expect(before?.kind === 'text' && before.text).toBe('Before the drawing.');
    expect(after?.kind === 'text' && after.text).toBe('After the drawing.');
    if (art?.kind === 'artifact') {
      expect(art.artifact.id).toBe('m1-a0');
      expect(art.artifact.kind).toBe('svg');
    }
  });

  it('keeps artifact ids stable + sequential across the message (matches detection)', () => {
    const seg = segmentGroup([
      assistant('m1', [text('```svg\n<svg/>\n```\ntween\n```html\n<b>hi</b>\n```')]),
    ]);
    const ids = seg
      .filter((s): s is Extract<GroupSegment, { kind: 'artifact' }> => s.kind === 'artifact')
      .map((s) => s.artifact.id);
    expect(ids).toEqual(['m1-a0', 'm1-a1']);
  });

  it('leaves a plain (non-artifact) code fence inside the markdown run', () => {
    const seg = segmentGroup([assistant('m1', [text('text\n```js\nconst x = 1;\n```')])]);
    expect(seg.map((s) => s.kind)).toEqual(['text']);
    expect(seg[0]?.kind === 'text' && seg[0].text).toContain('```js');
  });

  it('coalesces a tool chain across message boundaries while interleaving artifacts', () => {
    const seg = segmentGroup([
      assistant('m1', [text('Here:\n```svg\n<svg/>\n```'), call('c1', 'bash', { command: 'ls' })]),
      assistant('m2', [call('c2', 'edit', { path: 'a.txt' }), text('done')]),
    ]);
    // one chain spans c1 (m1) + c2 (m2); the svg stays inline before it.
    expect(seg.map((s) => s.kind)).toEqual(['text', 'artifact', 'chain', 'text']);
    const chain = seg[2];
    if (chain?.kind === 'chain') expect(chain.blocks).toHaveLength(2);
  });
});

describe('toolStepKind', () => {
  it('classifies tools by name', () => {
    expect(toolStepKind('bash')).toBe('bash');
    expect(toolStepKind('shell')).toBe('bash');
    expect(toolStepKind('str_replace_editor')).toBe('edit');
    expect(toolStepKind('write_file')).toBe('edit');
    expect(toolStepKind('web_search')).toBe('search');
    expect(toolStepKind('generate_image')).toBe('image');
    expect(toolStepKind('make_pdf')).toBe('pdf');
    expect(toolStepKind('read_file')).toBe('read');
    expect(toolStepKind('grep')).toBe('read');
  });

  it('classifies browser-use tools by verb (#17) — never the generic file read', () => {
    expect(toolStepKind('browser_navigate')).toBe('browser-navigate');
    expect(toolStepKind('browser_click')).toBe('browser-click');
    expect(toolStepKind('browser_type')).toBe('browser-type');
    expect(toolStepKind('browser_read')).toBe('browser-read');
    expect(toolStepKind('browser_snapshot')).toBe('browser-read');
    expect(toolStepKind('browser_scroll')).toBe('browser-click');
    expect(toolStepKind('playwright_goto')).toBe('browser-navigate');
    // A plain file read must stay a file read, not get diverted to a browser kind.
    expect(toolStepKind('read_file')).toBe('read');
  });
});

describe('resolveTool (R14 registry — each tool its own kind, neutral fallback)', () => {
  it('classifies the first-party builtins to their OWN kinds (not "read")', () => {
    expect(toolStepKind('tool_search')).toBe('tool-search');
    expect(toolStepKind('python_run')).toBe('python');
    expect(toolStepKind('run_python')).toBe('python');
    expect(toolStepKind('web_search')).toBe('search');
    // The magnifier-over-tools search is NOT the web search.
    expect(toolStepKind('tool_search')).not.toBe('search');
  });

  it('maps macOS connector tools to the `connector` kind with their brand identity', () => {
    const rem = resolveTool('reminders_create');
    expect(rem.kind).toBe('connector');
    expect(rem.connectorId).toBe('mac-reminders');
    expect(rem.label).toEqual(['Setting a reminder', 'Set a reminder']);

    expect(resolveTool('calendar_list_events')).toMatchObject({
      kind: 'connector',
      connectorId: 'mac-calendar',
    });
    expect(resolveTool('mail_send')).toMatchObject({ kind: 'connector', connectorId: 'mac-mail' });
    // A connector tool NOT in the exact registry still resolves by prefix.
    expect(resolveTool('calendar_delete_event')).toMatchObject({
      kind: 'connector',
      connectorId: 'mac-calendar',
    });
  });

  it('resolves an MCP-namespaced tool to a connector (brand icon when known)', () => {
    // Branded MCP server (simple-icons has `linear`).
    const linear = resolveTool('mcp__linear__create_issue');
    expect(linear.kind).toBe('connector');
    expect(linear.connectorId).toBe('linear');
    expect(linear.displayName).toBe('Linear');
    // Unknown-brand MCP server → still a connector row, named by the server, no id.
    const unknown = resolveTool('acmecorp__do_thing');
    expect(unknown.kind).toBe('connector');
    expect(unknown.connectorId).toBeUndefined();
    expect(unknown.displayName).toBe('Acmecorp');
  });

  it('falls an UNKNOWN tool back to the neutral `tool` kind — NEVER "read"', () => {
    const t = resolveTool('summarize_document');
    expect(t.kind).toBe('tool');
    expect(t.kind).not.toBe('read');
    expect(t.displayName).toBe('Summarize document');
    // Genuinely read-ish inspection tools DO still read as `read`.
    expect(toolStepKind('grep')).toBe('read');
    // `ls` used to be 'read' too, which is why a directory listing rendered as
    // "Read a file — buggyapp" with a file sheet. A folder is not a file.
    expect(toolStepKind('ls')).toBe('folder');
  });
});

describe('mapToolStep (R14 new kinds)', () => {
  it('reminders_create renders "Set a reminder" with the connector brand SVG + reveal', () => {
    const step = mapToolStep(
      call('c1', 'reminders_create', { title: 'Call mom', due: 'tomorrow' }),
      result('c1', 'Created reminder'),
      false,
    ).data;
    expect(step.kind).toBe('connector');
    expect(step.label).toBe('Set a reminder');
    if (step.kind !== 'connector') throw new Error('expected connector');
    expect(step.iconSvg).toBeDefined();
    expect(step.iconSvg).toContain('<svg');
    expect(step.detail).toBe('Call mom');
    expect(step.argsText).toContain('Call mom');
    expect(step.output).toBe('Created reminder');
  });

  it('a running connector call reads present-tense ("Setting a reminder")', () => {
    expect(
      mapToolStep(call('c1', 'reminders_create', { title: 'x' }), undefined, true).data.label,
    ).toBe('Setting a reminder');
  });

  it('an unknown tool maps to a neutral generic row (humanized name, args + result)', () => {
    const step = mapToolStep(
      call('c1', 'summarize_document', { path: '/x/y.md' }),
      result('c1', 'a summary'),
      false,
    ).data;
    expect(step.kind).toBe('tool');
    expect(step.label).toBe('Summarize document');
    if (step.kind !== 'tool') throw new Error('expected tool');
    expect(step.argsText).toContain('/x/y.md');
    expect(step.output).toBe('a summary');
  });

  it('tool_search reads "Searched tools" and reveals its query + matches', () => {
    const step = mapToolStep(
      call('c1', 'tool_search', { query: 'calendar' }),
      result('c1', 'calendar_create_event\ncalendar_list_events'),
      false,
    ).data;
    expect(step.kind).toBe('tool-search');
    expect(step.label).toBe('Searched tools');
    expect(step.detail).toBe('calendar');
  });

  it('python_run reads "Ran Python" and carries its code + output like a terminal', () => {
    const step = mapToolStep(
      call('c1', 'python_run', { code: 'print(2+2)' }),
      result('c1', '4'),
      false,
    ).data;
    expect(step.kind).toBe('python');
    expect(step.label).toBe('Ran Python');
    if (step.kind !== 'python') throw new Error('expected python');
    expect(step.command).toBe('print(2+2)');
    expect(step.output).toBe('4');
  });
});

describe('mapToolStep', () => {
  it('past-tense on done, present tense + running status while running', () => {
    expect(mapToolStep(call('c1', 'bash', { command: 'ls' }), undefined, false).data.label).toBe(
      'Ran a command',
    );
    const running = mapToolStep(call('c1', 'bash', { command: 'ls' }), undefined, true).data;
    expect(running.label).toBe('Running a command');
    expect(running.status).toBe('running');
  });

  it('bash carries command + output', () => {
    const step = mapToolStep(
      call('c1', 'bash', { command: 'ls -la' }),
      result('c1', 'total 8'),
      false,
    ).data;
    expect(step).toMatchObject({ kind: 'bash', command: 'ls -la', output: 'total 8' });
  });

  it('edit builds a diff from old/new text and carries the filename', () => {
    const step = mapToolStep(
      call('c1', 'edit', { path: '/tmp/hello.txt', oldText: 'Hello', newText: 'Hi world' }),
      undefined,
      false,
    ).data;
    expect(step.kind).toBe('edit');
    expect(step).toMatchObject({ filename: 'hello.txt' });
    if (step.kind === 'edit') {
      expect(step.diff?.[0]?.lines).toEqual([
        { kind: 'del', text: 'Hello' },
        { kind: 'add', text: 'Hi world' },
      ]);
    }
  });

  it('read carries the tool output as inline preview', () => {
    const step = mapToolStep(
      call('c1', 'read_file', { path: 'a.ts' }),
      result('c1', 'file body'),
      false,
    ).data;
    expect(step).toMatchObject({ kind: 'read', filename: 'a.ts', preview: 'file body' });
  });

  it('ticks +N up from the streaming argsText before the args parse (LC4)', () => {
    // While a whole-file write streams, `arguments` is still empty — the count is
    // read from the raw argsText so +N grows in real time and matches the canvas.
    const streaming = (argsText: string): ToolCall => ({
      type: 'toolCall',
      id: 'w1',
      name: 'write_file',
      arguments: {},
      argsText,
    });
    const early = mapToolStep(
      streaming('{"path":"/tmp/a.py","content":"one\\ntwo'),
      undefined,
      true,
    ).data;
    expect(early.kind).toBe('edit');
    if (early.kind === 'edit') {
      expect(early.added).toBe(2);
      expect(early.deleted).toBe(0);
      expect(early.filename).toBe('a.py');
    }
    // More content arrives → the count ticks up.
    const later = mapToolStep(
      streaming('{"path":"/tmp/a.py","content":"one\\ntwo\\nthree\\nfour'),
      undefined,
      true,
    ).data;
    if (later.kind === 'edit') expect(later.added).toBe(4);
    // Once the args parse (done), the real diff takes over.
    const done = mapToolStep(
      call('w1', 'write_file', { path: '/tmp/a.py', content: 'one\ntwo' }),
      result('w1', 'ok'),
      false,
    ).data;
    if (done.kind === 'edit') expect(done.diff).toBeDefined();
  });

  it('classifies a SKILL / skills-dir read as `skill` → "Read a skill" (Wave B #3a)', () => {
    const step = mapToolStep(
      call('c1', 'read', { path: '/Users/user/.pi/agent/skills/code-review/SKILL.md' }),
      result('c1', 'You are a reviewer.'),
      false,
    ).data;
    expect(step.kind).toBe('skill');
    expect(step.label).toBe('Read a skill');
    expect(step).toMatchObject({ filename: 'SKILL.md', preview: 'You are a reviewer.' });
    // Present tense while running.
    expect(
      mapToolStep(call('c1', 'read', { path: '/x/.pi/skills/debugging/SKILL.md' }), undefined, true)
        .data.label,
    ).toBe('Reading a skill');
  });

  it('leaves a NORMAL file read as `read` (a look-alike name is not a skill)', () => {
    expect(
      mapToolStep(call('c1', 'read', { path: '/repo/src/app.ts' }), undefined, false).data.kind,
    ).toBe('read');
    // A doc that merely mentions skills but isn't a SKILL.md / under skills/.
    expect(
      mapToolStep(call('c1', 'read', { path: '/repo/docs/SKILLS.md' }), undefined, false).data.kind,
    ).toBe('read');
  });

  it('does NOT promote an EDIT of a skill file to `skill` (only reads)', () => {
    expect(
      mapToolStep(
        call('c1', 'edit', { path: '/x/.pi/agent/skills/x/SKILL.md', oldText: 'a', newText: 'b' }),
        undefined,
        false,
      ).data.kind,
    ).toBe('edit');
  });

  it('browser navigate carries the url + a page-tense label (#17)', () => {
    const step = mapToolStep(
      call('c1', 'browser_navigate', { url: 'https://neal.fun' }),
      undefined,
      false,
    ).data;
    expect(step.kind).toBe('browser-navigate');
    expect(step.label).toBe('Visited a page');
    if (step.kind === 'browser-navigate') expect(step.url).toBe('https://neal.fun');
  });

  it('browser read expands the returned page text inline (#17)', () => {
    const step = mapToolStep(
      call('c1', 'browser_read', {}),
      result('c1', 'the page body'),
      false,
    ).data;
    expect(step.kind).toBe('browser-read');
    if (step.kind === 'browser-read') expect(step.preview).toBe('the page body');
  });

  it('image opens in canvas and yields a media tab spec', () => {
    const mapped = mapToolStep(
      call('c1', 'generate_image', {}),
      result('c1', 'data:image/png;base64,AAAA'),
      false,
    );
    expect(mapped.data).toMatchObject({ kind: 'image', opensInCanvas: true });
    expect(mapped.tabSpec).toMatchObject({
      kind: 'image',
      key: 'c1',
      mediaSrc: 'data:image/png;base64,AAAA',
    });
    // B1: the tab spec must NOT hard-control the load status — the surface
    // self-manages from the media element's load/error events.
    expect(mapped.tabSpec?.mediaStatus).toBeUndefined();
  });
});

describe('on-device image tools (generate_image / edit_image)', () => {
  // What the harness image tools actually return: the pd-file media URL on line
  // one (renderable), the plain disk path on line two (for a follow-up edit).
  const PNG = '/Users/j/.pi/desktop/sandbox/gen3d/abc/prompt-image.png';
  const toolText = `pd-file://f${PNG}\nGenerated image saved at ${PNG}`;

  it('edit_image is an IMAGE step, not a file edit', () => {
    // It contains "edit", so without an exact registry entry the edit/write
    // heuristic would claim it and draw a diff row instead of a picture.
    expect(toolStepKind('edit_image')).toBe('image');
    expect(toolStepKind('generate_image')).toBe('image');
    expect(resolveTool('edit_image').label?.[1]).toBe('Edited an image');
  });

  it('firstMediaUrl takes the URL line and ignores the prose line', () => {
    expect(firstMediaUrl(toolText)).toBe(`pd-file://f${PNG}`);
    expect(firstMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(firstMediaUrl(`Generated image saved at ${PNG}`)).toBeUndefined();
    expect(firstMediaUrl(PNG)).toBeUndefined(); // a bare path is not loadable
    expect(firstMediaUrl(undefined)).toBeUndefined();
  });

  it('renders the generated image INLINE from its pd-file URL', () => {
    expect(
      generatedImageSrc(call('c1', 'generate_image', { prompt: 'a bike' }), result('c1', toolText)),
    ).toBe(`pd-file://f${PNG}`);
  });

  it('renders an EDITED image inline too, and does not mistake the source arg for the result', () => {
    const editText = `pd-file://f/tmp/edited.png\nEdited image saved at /tmp/edited.png`;
    const block = call('c2', 'edit_image', {
      image_path: '/tmp/source.png',
      instruction: 'make the jacket red',
    });
    expect(generatedImageSrc(block, result('c2', editText))).toBe('pd-file://f/tmp/edited.png');
    const mapped = mapToolStep(block, result('c2', editText), false);
    expect(mapped.data).toMatchObject({ kind: 'image', label: 'Edited an image' });
    expect(mapped.tabSpec?.mediaSrc).toBe('pd-file://f/tmp/edited.png');
  });

  it('a FAILED image tool renders no inline image (the arg path is not a picture)', () => {
    const block = call('c3', 'edit_image', { image_path: '/tmp/source.png', instruction: 'x' });
    const failed = result('c3', 'edit_image failed: Mage-Flow-Edit-Turbo is not downloaded yet.');
    expect(generatedImageSrc(block, failed)).toBeUndefined();
  });

  it('still renders a legacy single-line data-URI result', () => {
    expect(
      generatedImageSrc(
        call('c4', 'generate_image', {}),
        result('c4', 'data:image/png;base64,AAAA'),
      ),
    ).toBe('data:image/png;base64,AAAA');
  });
});

describe('mapToolStep — web_search result parsing', () => {
  // The exact text body the built-in web_search tool emits (index.ts): a header,
  // an optional "(note: …)" line, then "[n] title / url / snippet" blocks. The
  // engine forwards only this TEXT (not the structured details), so the mapper
  // must parse it — a JSON-only parse yielded [] → every search read "0 results".
  const toolText = [
    '2 result(s) via duckduckgo',
    '',
    '[1] Example Domain',
    '    https://www.example.com/',
    '    This domain is for use in illustrative examples in documents.',
    '',
    '[2] example.com - Wikipedia',
    '    https://en.wikipedia.org/wiki/Example.com',
    '    The domain names are reserved by the IANA.',
  ].join('\n');

  it('parses the tool text body into title/url/domain/snippet rows', () => {
    const step = mapToolStep(
      call('c1', 'web_search', { query: 'example domain' }),
      result('c1', toolText),
      false,
    ).data;
    expect(step.kind).toBe('search');
    if (step.kind !== 'search') return;
    expect(step.results).toHaveLength(2);
    expect(step.results?.[0]).toEqual({
      title: 'Example Domain',
      url: 'https://www.example.com/',
      domain: 'example.com',
      snippet: 'This domain is for use in illustrative examples in documents.',
    });
    expect(step.results?.[1]?.url).toBe('https://en.wikipedia.org/wiki/Example.com');
    expect(step.results?.[1]?.domain).toBe('en.wikipedia.org');
  });

  it('still handles JSON array / { results } shapes (MCP / API search tools)', () => {
    const json = JSON.stringify({
      results: [{ title: 'T', link: 'https://t.example/x', description: 'a  desc' }],
    });
    const step = mapToolStep(
      call('c1', 'brave_search', { query: 'q' }),
      result('c1', json),
      false,
    ).data;
    if (step.kind !== 'search') throw new Error('expected search');
    expect(step.results?.[0]).toMatchObject({
      title: 'T',
      url: 'https://t.example/x',
      domain: 't.example',
      snippet: 'a  desc',
    });
  });

  it('yields an empty result set + the backend note for a no-results body', () => {
    const step = mapToolStep(
      call('c1', 'web_search', { query: 'zxqw' }),
      result(
        'c1',
        'No results (via duckduckgo).\n(note: duckduckgo failed (it may be rate-limiting requests))',
      ),
      false,
    ).data;
    if (step.kind !== 'search') throw new Error('expected search');
    expect(step.results).toEqual([]);
    expect(step.note).toContain('rate-limiting');
  });

  it('never throws and returns [] on an absent result', () => {
    const step = mapToolStep(call('c1', 'web_search', { query: 'q' }), undefined, true).data;
    if (step.kind !== 'search') throw new Error('expected search');
    expect(step.results).toEqual([]);
  });
});

describe('mapToolStep — primary arg surfaced as `detail` (round-2 #2)', () => {
  it('carries the command for bash', () => {
    expect(
      mapToolStep(call('c1', 'bash', { command: 'ls -la' }), undefined, false).data.detail,
    ).toBe('ls -la');
  });

  it('carries the full path for read / edit', () => {
    expect(
      mapToolStep(call('c1', 'read_file', { path: '/repo/src/app.ts' }), undefined, false).data
        .detail,
    ).toBe('/repo/src/app.ts');
    expect(
      mapToolStep(
        call('c1', 'edit', { path: '/repo/a.txt', oldText: 'a', newText: 'b' }),
        undefined,
        false,
      ).data.detail,
    ).toBe('/repo/a.txt');
  });

  it('carries the full path for a skill read', () => {
    expect(
      mapToolStep(
        call('c1', 'read', { path: '/Users/user/.pi/agent/skills/code-review/SKILL.md' }),
        undefined,
        false,
      ).data.detail,
    ).toBe('/Users/user/.pi/agent/skills/code-review/SKILL.md');
  });

  it('carries the query for search and the url for a browser action', () => {
    expect(
      mapToolStep(call('c1', 'web_search', { query: 'weather tokyo' }), undefined, false).data
        .detail,
    ).toBe('weather tokyo');
    expect(
      mapToolStep(call('c1', 'browser_navigate', { url: 'https://neal.fun' }), undefined, false)
        .data.detail,
    ).toBe('https://neal.fun');
  });
});

describe('mapThinkingStep', () => {
  it('maps a thought to a thinking step with past/present labels', () => {
    expect(mapThinkingStep(think('hmm'), false).data).toMatchObject({
      kind: 'thinking',
      label: 'Thought',
      thought: 'hmm',
    });
    expect(mapThinkingStep(think('hmm'), true).data.label).toBe('Thinking…');
  });
});

describe('chainRunningFlags (E1 — only the last live step is present-tense)', () => {
  const noResults = { hasResult: () => false, runningToolCalls: [] as string[] };

  it('marks ONLY the last step running in a live chain — prior steps stay past', () => {
    const flags = chainRunningFlags(
      [call('c1', 'edit', { path: 'a.ts' }), call('c2', 'edit', { path: 'b.ts' })],
      { streaming: true, ...noResults },
    );
    // The E1 bug: a NEW action used to re-present ALL prior tool calls. Now the
    // earlier edit is settled (past "Edited a file") and only the current one runs.
    expect(flags).toEqual([false, true]);
  });

  it('keeps a prior tool PAST when a new THOUGHT is the live trailing block', () => {
    const flags = chainRunningFlags([call('c1', 'edit', { path: 'a.ts' }), think('next step')], {
      streaming: true,
      ...noResults,
    });
    // The tool ran, then the model started thinking — the tool is "Edited a file"
    // (past), the trailing thought is "Thinking…" (present).
    expect(flags).toEqual([false, true]);
  });

  it('settles the whole chain once the turn is no longer streaming', () => {
    const flags = chainRunningFlags(
      [think('a'), call('c1', 'bash', { command: 'ls' }), call('c2', 'read', { path: 'a' })],
      { streaming: false, ...noResults },
    );
    expect(flags).toEqual([false, false, false]);
  });

  it('honors an explicit runningToolCalls entry even when it is not the last step', () => {
    const flags = chainRunningFlags(
      [call('c1', 'bash', { command: 'ls' }), call('c2', 'read', { path: 'a' })],
      { streaming: true, hasResult: () => false, runningToolCalls: ['c1'] },
    );
    // c1 is authoritatively in-flight (present); c2 is last so also present.
    expect(flags).toEqual([true, true]);
  });

  it('settles the last tool once its result lands (the current-action-done gap)', () => {
    const flags = chainRunningFlags(
      [call('c1', 'bash', { command: 'ls' }), call('c2', 'edit', { path: 'a.ts' })],
      { streaming: true, hasResult: (id) => id === 'c2', runningToolCalls: [] },
    );
    // c2 already has a result → past; c1 is not last and has no result → past.
    expect(flags).toEqual([false, false]);
  });

  it('runs the last thinking block of a live thinking-only run', () => {
    expect(chainRunningFlags([think('a'), think('b')], { streaming: true, ...noResults })).toEqual([
      false,
      true,
    ]);
  });
});

describe('mapToolStep — commission_contract (D1 contract row)', () => {
  it('renders a contract as a "Commissioned" tool row with the title inline + args reveal', () => {
    const step = mapToolStep(
      call('c1', 'commission_contract', {
        title: 'Player movement controller',
        owner: 'combat-eng-1',
        slot: 'src/combat/move.ts',
        status: 'queued',
      }),
      undefined,
      false,
    ).data;
    expect(step.kind).toBe('tool');
    expect(step.label).toBe('Commissioned');
    // The contract TITLE is the inline detail ("Commissioned <title>").
    expect(step.detail).toBe('Player movement controller');
    if (step.kind !== 'tool') throw new Error('expected tool');
    // The full contract fields are revealed on click (Input) — never a raw JSON dump.
    expect(step.argsText).toContain('combat-eng-1');
    expect(step.argsText).toContain('src/combat/move.ts');
  });
});

describe('a folder is not a file', () => {
  // Spotted by looking at a real run: the first row read "Read a file —
  // buggyapp" with a file icon, and buggyapp is a directory.
  it('labels a directory listing as a listing', () => {
    const step = mapToolStep(
      { type: 'toolCall', id: 't1', name: 'ls', args: { path: 'buggyapp' } } as never,
      undefined,
      false,
    );
    expect(step.data.label).toBe('Listed a folder');
    expect(step.data.label).not.toContain('file');
  });

  it('still says file for an actual file read', () => {
    const step = mapToolStep(
      { type: 'toolCall', id: 't2', name: 'read', args: { path: 'app.py' } } as never,
      undefined,
      false,
    );
    expect(step.data.label).toBe('Read a file');
  });
});

describe('a rejected tool call is marked failed', () => {
  const failed = (id: string, out: string): ToolResultMsg => ({
    ...result(id, out),
    isError: true,
  });

  /*
   * RUN G: six `edit` calls, all rejected on an oldText mismatch, the file never
   * written — and the thread summarised it as "edited 6 files". `isError` was on
   * the result the whole time and simply never reached the step, so the roll-up
   * had no way to tell a rejection from a success.
   */
  it('carries isError through to the step, so the summary can be honest', () => {
    const step = mapToolStep(
      call('e1', 'edit', { path: '/w/app.py' }),
      failed('e1', 'Could not find edits[1] in /w/app.py. The oldText must match exactly'),
      false,
    );
    expect(step.data.failed).toBe(true);
  });

  it('leaves a successful call unmarked rather than defaulting to false', () => {
    const step = mapToolStep(call('e2', 'edit', { path: '/w/app.py' }), result('e2', 'ok'), false);
    expect(step.data.failed).toBeUndefined();
  });

  it('marks a failure on any tool kind, not just edit', () => {
    expect(
      mapToolStep(call('b1', 'bash', { command: 'false' }), failed('b1', 'exit 1'), false).data
        .failed,
    ).toBe(true);
  });

  /* A call still in flight has no result yet — it must not read as failed. */
  it('does not mark a running call', () => {
    expect(
      mapToolStep(call('e3', 'edit', { path: '/w/a.py' }), undefined, true).data.failed,
    ).toBeUndefined();
  });
});

describe('chat-template markers are not thoughts', () => {
  /*
   * the user, from a screenshot of a live run: three "Thought" rows in a row whose
   * entire visible content was `<|channel>thought`. MEASURED in that run's
   * session log — the model prefixes its reasoning with a template marker and
   * often emits nothing else:
   *
   *   block=thinking len=18   '<|channel>thought\n'
   *   block=thinking len=1643 '<|channel>thought\nThe previous edit call failed…'
   */
  it('strips the marker off a real thought', () => {
    expect(cleanThought('<|channel>thought\nThe previous edit call failed.')).toBe(
      'The previous edit call failed.',
    );
  });

  it('treats a marker-only block as empty', () => {
    expect(cleanThought('<|channel>thought\n')).toBe('');
    expect(isEmptyThinking({ type: 'thinking', thinking: '<|channel>thought\n' })).toBe(true);
  });

  it('handles the closed form and stacked markers', () => {
    expect(cleanThought('<|channel|>analysis\nhello')).toBe('hello');
    expect(cleanThought('<|start|><|channel>thought\nhello')).toBe('hello');
  });

  it('leaves an ordinary thought completely alone', () => {
    const real = 'I need to read the README first.';
    expect(cleanThought(real)).toBe(real);
    expect(isEmptyThinking({ type: 'thinking', thinking: real })).toBe(false);
  });

  /* A tool call is never dropped, whatever it contains. */
  it('never calls a tool call empty', () => {
    expect(isEmptyThinking({ type: 'toolCall' })).toBe(false);
  });

  it('does not attach a thought when only the marker was emitted', () => {
    const step = mapThinkingStep({ type: 'thinking', thinking: '<|channel>thought\n' }, false);
    expect((step.data as { thought?: string }).thought).toBeUndefined();
  });

  it('attaches the cleaned text for a real thought', () => {
    const step = mapThinkingStep(
      { type: 'thinking', thinking: '<|channel>thought\nReading the file.' },
      false,
    );
    expect((step.data as { thought?: string }).thought).toBe('Reading the file.');
  });
});

describe('the corp coordination rows are specific, not generic', () => {
  it('talk_to says WHO on the row and reads as prose when opened', () => {
    /*
     * the user: "the talk to, ready to delegate additionally need to be clickable
     * to show case specific not generic expansions of details of the tool
     * call." A hand-off is one recipient and one paragraph; JSON.stringify
     * buried both behind escaped newlines.
     */
    const step = mapToolStep(
      call('c1', 'talk_to', { recipient: 'engineer:1', message: 'Build the deck.\nUse office-gen.' }),
      result('c1', 'on it'),
      false,
    ).data as { kind: string; label: string; detail?: string; argsText?: string };
    expect(step.kind).toBe('talk');
    expect(step.label).toBe('Messaged');
    expect(step.detail).toBe('engineer:1');
    expect(step.argsText).toContain('To: engineer:1');
    expect(step.argsText).toContain('Build the deck.');
    expect(step.argsText).not.toContain('{');
  });

  it('commission_specialist names the specialist and the request', () => {
    const step = mapToolStep(
      call('c1', 'commission_specialist', { specialty: 'document', request: 'Make the pptx.' }),
      undefined,
      false,
    ).data as { kind: string; label: string; detail?: string; argsText?: string };
    expect(step.kind).toBe('commission');
    expect(step.detail).toBe('document');
    expect(step.argsText).toContain('Specialist: document');
    expect(step.argsText).toContain('Make the pptx.');
  });

  it('request_test_tools lists each kit WITH the reason it was asked for', () => {
    // The reason is never checked by the harness — but it is worth reading.
    const step = mapToolStep(
      call('c1', 'request_test_tools', {
        kits: [{ kit: 'shell', why: 'run the deck renderer' }, 'browser'],
        what_you_will_test: 'the exported pptx',
      }),
      undefined,
      false,
    ).data as { kind: string; label: string; detail?: string; argsText?: string };
    expect(step.kind).toBe('toolkit');
    expect(step.argsText).toContain('Kit: shell — run the deck renderer');
    expect(step.argsText).toContain('Kit: browser');
    expect(step.argsText).toContain('Testing: the exported pptx');
  });

  it('ready_to_delegate shows the plan it claims to have', () => {
    const step = mapToolStep(
      call('c1', 'ready_to_delegate', { plan_summary: '1. deck → engineer 1' }),
      undefined,
      false,
    ).data as { kind: string; label: string; detail?: string; argsText?: string };
    expect(step.kind).toBe('delegate');
    expect(step.label).toBe('Ready to delegate');
    expect(step.argsText).toContain('1. deck → engineer 1');
  });
})
