import { describe, expect, it } from 'vitest';
import { effectiveToolName } from './long-job';
import {
  argsNamePath,
  attributeRecords,
  type CardKind,
  placeTurnCards,
  resultNamesPath,
  type TurnCall,
  type TurnCard,
} from './turn-cards';

const DIR = '/Users/j/Bobble/generated/cat-in-a-hat';
const V1 = `${DIR}/edit_000.png`;
const V2 = `${DIR}/edit_001.png`;
const V3 = `${DIR}/edit_002.png`;

const call = (id: string, chain: number, tool: string, args: unknown = {}): TurnCall => ({
  id,
  chain,
  tool,
  args,
});
const card = (callId: string, path: string, kind: CardKind = 'image'): TurnCard => ({
  key: `${callId}:${path}`,
  callId,
  path,
  kind,
});

describe('what the turn made is the work; what it presented is the answer', () => {
  /* the user's iteration: one chain, each edit taking the previous result as input. */
  const calls = [
    call('e1', 0, 'edit_image', { image_path: '/Users/j/Desktop/photo.png', instruction: 'x' }),
    call('e2', 0, 'edit_image', { image_path: V1, instruction: 'warmer' }),
    call('e3', 0, 'edit_image', { image_path: V2, instruction: 'crop' }),
  ];
  const cards = [card('e1', V1), card('e2', V2), card('e3', V3)];

  it('while the chain works, every result files into it — none of them was handed over', () => {
    const place = placeTurnCards(calls, cards, 0);
    expect([...place.values()]).toEqual(['inside', 'inside', 'inside']);
  });

  it('once the chain is done, the last version comes out; the drafts it grew from stay in the work', () => {
    const place = placeTurnCards(calls, cards, null);
    expect([...place.values()]).toEqual(['inside', 'inside', 'beneath']);
  });

  it('presenting the last version brings it out, full size, once', () => {
    const presented = [...calls, call('p', 1, 'present', { path: V3 })];
    const place = placeTurnCards(presented, [...cards, card('p', V3, 'record')]);
    expect(place.get(`e1:${V1}`)).toBe('inside');
    expect(place.get(`e2:${V2}`)).toBe('inside');
    // The edit's own card of V3 gives way to the presented one: one file, one card.
    expect(place.get(`e3:${V3}`)).toBe('none');
    expect(place.get(`p:${V3}`)).toBe('beneath');
  });

  const pages = Array.from({ length: 8 }, (_, i) =>
    call(`g${i}`, 0, 'generate_image', { prompt: `page ${i}` }),
  );
  const made = pages.map((c, i) => card(c.id, `${DIR}/page_${i}.png`));

  it('eight pages of a children’s book: in the chain while it works, out when it is done', () => {
    expect([...placeTurnCards(pages, made, 0).values()].every((p) => p === 'inside')).toBe(true);
    expect([...placeTurnCards(pages, made, null).values()].every((p) => p === 'beneath')).toBe(
      true,
    );
  });

  it('…and when the model presents what it chose, the rest stays its work', () => {
    const shown = [...pages, call('p', 1, 'present', { path: `${DIR}` })];
    const place = placeTurnCards(shown, [...made, card('p', DIR, 'record')]);
    expect(place.get(`p:${DIR}`)).toBe('beneath');
    expect(made.every((m) => place.get(m.key) === 'inside')).toBe(true);
  });

  it('a chart or diagram tool presents what it draws — its result says the card is shown', () => {
    const chart = '/w/units.svg';
    const flow = '/w/flow.svg';
    const place = placeTurnCards(
      [call('c', 0, 'chart'), call('d', 0, 'diagram')],
      [card('c', chart, 'record'), card('d', flow, 'record')],
    );
    expect(place.get(`c:${chart}`)).toBe('beneath');
    expect(place.get(`d:${flow}`)).toBe('beneath');
  });

  it('the math command presents its explanation — the answer, not a step of the work', () => {
    const page = '/w/circle_area.html';
    const place = placeTurnCards([call('m', 0, 'math')], [card('m', page, 'record')]);
    expect(place.get(`m:${page}`)).toBe('beneath');
  });

  it('…but while its chain works on, it files in with the work and comes out when done', () => {
    const chart = '/w/units.svg';
    const calls2 = [call('c', 0, 'chart'), call('w', 0, 'write', { path: 'summary.md' })];
    const cards2 = [card('c', chart, 'record')];
    expect(placeTurnCards(calls2, cards2, 0).get(`c:${chart}`)).toBe('inside');
    expect(placeTurnCards(calls2, cards2, null).get(`c:${chart}`)).toBe('beneath');
  });

  it('a drawing OmniSVG made is work while its chain works, and out when it is done', () => {
    const svg = '/w/lighthouse.svg';
    const drew = [call('s', 0, 'generate_svg')];
    expect(placeTurnCards(drew, [card('s', svg, 'record')], 0).get(`s:${svg}`)).toBe('inside');
    expect(placeTurnCards(drew, [card('s', svg, 'record')], null).get(`s:${svg}`)).toBe('beneath');
  });

  it('a card no call in the turn accounts for stays where it was drawn', () => {
    expect(placeTurnCards([], [card('x', V1)]).get(`x:${V1}`)).toBe('beneath');
  });
});

describe('a picture the model made and never presented', () => {
  /* The visual-learner student (2026-10-01, Gemma 4 12B, bash-CLI): a picture
     made through bash, a flowchart drawn next in the same chain, then the reply
     about "the image of the thin slices" — and the student: "theres no picture
     in the chat". The picture was in the chain row, and the chain folds. */
  const PIC = '/Users/j/Bobble/generated/a-high-quality/cand0_seed259687452.png';
  const FLOW = '/Users/j/Bobble/new-chat/visualizations/onion_method.svg';
  const turn = [
    {
      id: 'c1',
      chain: 0,
      tool: effectiveToolName('bash', {
        command: 'media generate image "A high-quality, educational 3D illustration…"',
      }),
      args: { command: 'media generate image "A high-quality, educational 3D illustration…"' },
    },
    {
      id: 'c2',
      chain: 0,
      tool: effectiveToolName('bash', { command: 'diagram --title "The Onion Method"' }),
      args: { command: 'diagram --title "The Onion Method"' },
    },
  ];
  const turnCards = [card('c1', PIC), card('c2', FLOW, 'record')];

  it('is in its chain row while the chain works', () => {
    expect(turn.map((c) => c.tool)).toEqual(['generate_image', 'diagram']);
    expect(placeTurnCards(turn, turnCards, 0).get(`c1:${PIC}`)).toBe('inside');
  });

  it('stands at the reply’s foot with the flowchart once the chain is done', () => {
    const place = placeTurnCards(turn, turnCards, null);
    expect(place.get(`c1:${PIC}`)).toBe('beneath');
    expect(place.get(`c2:${FLOW}`)).toBe('beneath');
  });

  it('a picture a later call made something from is a draft: the new thing shows', () => {
    const GLB = '/Users/j/Bobble/generated/fox/fox.glb';
    const calls = [
      call('g', 0, 'generate_image', { prompt: 'a low-poly fox' }),
      call('m', 0, 'generate_3d', { image_path: PIC }),
    ];
    const place = placeTurnCards(calls, [card('g', PIC), card('m', GLB, 'model')], null);
    expect(place.get(`g:${PIC}`)).toBe('inside');
    expect(place.get(`m:${GLB}`)).toBe('beneath');
  });

  it('a picture merely named later — copied, opened — is still the answer', () => {
    const calls = [
      call('g', 0, 'generate_image', { prompt: 'a fox' }),
      call('b', 0, 'bash', { command: `cp ${PIC} ~/Desktop/fox.png` }),
    ];
    expect(placeTurnCards(calls, [card('g', PIC)], null).get(`g:${PIC}`)).toBe('beneath');
  });

  it('when the model presented another picture, it chose: this one stays its work', () => {
    const B = `${DIR}/second.png`;
    const calls = [
      call('g1', 0, 'generate_image', { prompt: 'a cat' }),
      call('g2', 0, 'generate_image', { prompt: 'a better cat' }),
      call('p', 0, 'present', { path: B }),
    ];
    const place = placeTurnCards(
      calls,
      [card('g1', PIC), card('g2', B), card('p', B, 'record')],
      null,
    );
    expect(place.get(`g1:${PIC}`)).toBe('inside');
    expect(place.get(`g2:${B}`)).toBe('none');
    expect(place.get(`p:${B}`)).toBe('beneath');
  });

  it('the corp feed — rows and words only — keeps it in the row', () => {
    const place = placeTurnCards(turn, turnCards, null, { madeStaysInWork: true });
    expect(place.get(`c1:${PIC}`)).toBe('inside');
    // What a tool presents is unchanged by it.
    expect(place.get(`c2:${FLOW}`)).toBe('beneath');
  });
});

describe('the CLI form of present is present', () => {
  /* FOUND by the visual suite (4B, CLI mode, 2026-09-25): the model drew a chart
     (`chart …` through bash) and then presented it (`coordinate present …`
     through bash). The present was the newest call for the file, read as plain
     bash, so its card went INSIDE the finished chain and the chart's own card
     gave way to it — the chart showed nowhere. */
  it('a chart drawn then presented through bash stands beneath the finished chain', () => {
    const calls = [
      {
        id: 'c4',
        chain: 0,
        tool: effectiveToolName('bash', { command: 'chart --labels "A, B" --values "1, 2"' }),
        args: {},
      },
      {
        id: 'c5',
        chain: 0,
        tool: effectiveToolName('bash', { command: 'coordinate present --path=traffic.svg' }),
        args: {},
      },
    ];
    const placed = placeTurnCards(calls, [
      { key: 'r:c5:/w/traffic.svg', callId: 'c5', path: '/w/traffic.svg', kind: 'record' },
    ]);
    expect(placed.get('r:c5:/w/traffic.svg')).toBe('beneath');
  });
});

describe('one file, one card', () => {
  it('the same file from two calls is drawn once, at the newer call', () => {
    const chart = '/w/units.svg';
    const place = placeTurnCards(
      [call('c', 0, 'chart'), call('e', 0, 'chart_edit', { file: 'units.svg' })],
      [card('c', chart, 'record'), card('e', chart, 'record')],
    );
    expect(place.get(`c:${chart}`)).toBe('none');
    expect(place.get(`e:${chart}`)).toBe('beneath');
  });
});

describe('lineage through the shell and the working folder', () => {
  it('reads the path out of a bash command line', () => {
    expect(
      argsNamePath({ command: `media edit image --image_path="${V1}" --instruction "warmer"` }, V1),
    ).toBe(true);
    expect(argsNamePath({ command: `media edit image --image_path=${V1}` }, V1)).toBe(true);
  });

  it('a path relative to the working folder names the file it ends', () => {
    expect(argsNamePath({ image_path: 'cat-in-a-hat/edit_000.png' }, V1)).toBe(true);
    expect(argsNamePath({ image_path: './edit_000.png' }, V1)).toBe(true);
    expect(argsNamePath({ image_path: 'edit_001.png' }, V1)).toBe(false);
  });

  it('the app’s own media URL is the same file', () => {
    expect(argsNamePath({ image: `pd-file://f${V1}` }, V1)).toBe(true);
    expect(argsNamePath({ image: 'pd-file://f/Users/j/a%20b.png' }, '/Users/j/a b.png')).toBe(true);
  });

  it('a name that merely ends the same way is not the same file', () => {
    expect(argsNamePath({ image_path: 'xedit_000.png' }, V1)).toBe(false);
    expect(argsNamePath({ image_path: `${DIR}/old/edit_000.png` }, V1)).toBe(false);
  });
});

describe('which call a presented card came from', () => {
  const units = '/Users/j/Bobble/q3/units.svg';

  it('the chart tool’s own words, relative to the working folder', () => {
    expect(resultNamesPath('Drew a bar chart "Units": units.svg (the spec beside it)', units)).toBe(
      true,
    );
    expect(resultNamesPath('Presented q3/units.svg to the user. Preview: …', units)).toBe(true);
    expect(resultNamesPath('Drew a bar chart "Units": other.svg', units)).toBe(false);
  });

  it('goes to the call that handed it over, not a later read of it', () => {
    const { byCall, loose } = attributeRecords(
      [
        { id: 'c1', tool: 'chart', text: 'Drew a bar chart "Units": units.svg', isError: false },
        { id: 'r1', tool: 'read', text: `${units}\n<svg …`, isError: false },
      ],
      [{ path: units }],
    );
    expect(byCall.get('c1')?.map((r) => r.path)).toEqual([units]);
    expect(byCall.has('r1')).toBe(false);
    expect(loose).toEqual([]);
  });

  it('a chart redrawn in place belongs to the edit', () => {
    const { byCall } = attributeRecords(
      [
        { id: 'c1', tool: 'chart', text: 'Drew a bar chart "Units": units.svg', isError: false },
        {
          id: 'e1',
          tool: 'chart_edit',
          text: 'Changed units.svg → a line chart: units.svg.',
          isError: false,
        },
      ],
      [{ path: units }],
    );
    expect([...byCall.keys()]).toEqual(['e1']);
  });

  it('through bash, the tool’s first words say it handed the file over', () => {
    const { byCall } = attributeRecords(
      [{ id: 'b1', tool: 'bash', text: 'Presented q3/units.svg to the user.', isError: false }],
      [{ path: units }],
    );
    expect([...byCall.keys()]).toEqual(['b1']);
  });

  it('a card nothing in the turn accounts for is loose, and stays where it was', () => {
    const { byCall, loose } = attributeRecords(
      [{ id: 'c1', tool: 'bash', text: 'ok', isError: false }],
      [{ path: units }],
    );
    expect(byCall.size).toBe(0);
    expect(loose).toEqual([{ path: units }]);
  });

  it('a failed call made nothing', () => {
    const { loose } = attributeRecords(
      [{ id: 'c1', tool: 'present', text: `There is nothing at ${units}.`, isError: true }],
      [{ path: units }],
    );
    expect(loose).toHaveLength(1);
  });

  it('a diagram or chart presented a beat before its answer goes to the call still waiting for one', () => {
    const flow = '/Users/j/Bobble/q3/flow.svg';
    const calls = [
      { id: 'd0', tool: 'diagram', text: 'Drew a flowchart: old.svg', isError: false },
      { id: 'c1', tool: 'chart', text: undefined, isError: false },
      { id: 'd1', tool: 'diagram', text: undefined, isError: false },
    ];
    // present:show has landed; no result names the file yet.
    const { byCall, loose } = attributeRecords(calls, [
      { path: flow, diagram: {} },
      { path: units, chart: {} },
    ]);
    expect(byCall.get('d1')?.map((r) => r.path)).toEqual([flow]);
    expect(byCall.get('c1')?.map((r) => r.path)).toEqual([units]);
    expect(loose).toEqual([]);
  });

  it('…but not a plain file, and not to a call that has answered or failed', () => {
    const { loose } = attributeRecords(
      [
        { id: 'd1', tool: 'diagram', text: 'Drew a flowchart: other.svg', isError: false },
        { id: 'd2', tool: 'diagram', text: undefined, isError: true },
      ],
      [{ path: units, diagram: {} }, { path: '/w/notes.md' }],
    );
    expect(loose.map((r) => r.path)).toEqual([units, '/w/notes.md']);
  });
});
