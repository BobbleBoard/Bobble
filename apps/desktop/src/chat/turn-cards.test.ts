import { describe, expect, it } from 'vitest';
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

describe('the user's iteration — edit, look, edit again', () => {
  /* The shape he described: one chain (Qwen's "\n\n" between thought and call is
     not a boundary), each edit taking the previous result as its input. */
  const calls = [
    call('e1', 0, 'edit_image', { image_path: '/Users/j/Desktop/photo.png', instruction: 'x' }),
    call('e2', 0, 'edit_image', { image_path: V1, instruction: 'warmer' }),
    call('e3', 0, 'edit_image', { image_path: V2, instruction: 'crop' }),
  ];
  const cards = [card('e1', V1), card('e2', V2), card('e3', V3)];

  it('while the chain is working, every earlier result is filed INTO it', () => {
    const place = placeTurnCards(calls, cards, 0);
    expect(place.get(`e1:${V1}`)).toBe('inside');
    expect(place.get(`e2:${V2}`)).toBe('inside');
  });

  it('…and the newest sits beneath it, where its generating card stood', () => {
    expect(placeTurnCards(calls, cards, 0).get(`e3:${V3}`)).toBe('beneath');
  });

  it('when the turn ends only the final version comes out — the drafts stay folded', () => {
    const place = placeTurnCards(calls, cards, null);
    expect(place.get(`e1:${V1}`)).toBe('inside');
    expect(place.get(`e2:${V2}`)).toBe('inside');
    expect(place.get(`e3:${V3}`)).toBe('beneath');
  });

  it('a draft is a draft only because a later edit took it as INPUT', () => {
    // Same three results, but each edit started from the ORIGINAL photo: they
    // are three alternatives, none of them revised, so all three are answers.
    const siblings = calls.map((c) => ({ ...c, args: { image_path: '/Users/j/Desktop/p.png' } }));
    const place = placeTurnCards(siblings, cards, null);
    expect([...place.values()]).toEqual(['beneath', 'beneath', 'beneath']);
  });
});

describe('a result the model is about to talk about does not jump', () => {
  it('thinking after the call is not moving on: the picture stays beneath', () => {
    // One call in the live chain and nothing after it (the model is thinking
    // about what to say) — beneath, so the reply's start does not move it twice.
    const place = placeTurnCards([call('g', 0, 'generate_image')], [card('g', V1)], 0);
    expect(place.get(`g:${V1}`)).toBe('beneath');
  });

  it('a later call in ANOTHER chain does not file it (that chain is not this one)', () => {
    const place = placeTurnCards(
      [call('g', 0, 'generate_image'), call('w', 2, 'write')],
      [card('g', V1)],
      2,
    );
    expect(place.get(`g:${V1}`)).toBe('beneath');
  });

  it('any later call in the SAME live chain files it — even a read of the picture', () => {
    const place = placeTurnCards(
      [call('g', 0, 'generate_image'), call('r', 0, 'read', { path: V1 })],
      [card('g', V1)],
      0,
    );
    expect(place.get(`g:${V1}`)).toBe('inside');
  });
});

describe('a turn that made several things makes several answers', () => {
  it('eight pages of a children’s book: none revised, all eight come out', () => {
    const calls = Array.from({ length: 8 }, (_, i) =>
      call(`p${i}`, 0, 'generate_image', { prompt: `page ${i}` }),
    );
    const cards = calls.map((c, i) => card(c.id, `${DIR}/page_${i}.png`));
    const done = placeTurnCards(calls, cards, null);
    expect([...done.values()].every((p) => p === 'beneath')).toBe(true);
    // …while mid-turn only the newest is out and the rest are in the chain.
    const mid = placeTurnCards(calls, cards, 0);
    expect(cards.map((c) => mid.get(c.key))).toEqual([...Array(7).fill('inside'), 'beneath']);
  });

  it('reading a picture is not revising it', () => {
    const place = placeTurnCards(
      [call('g', 0, 'generate_image'), call('r', 0, 'read', { path: V1 })],
      [card('g', V1)],
      null,
    );
    expect(place.get(`g:${V1}`)).toBe('beneath');
  });

  it('a video made FROM a picture does not make the picture a draft', () => {
    const clip = `${DIR}/clip.mp4`;
    const place = placeTurnCards(
      [call('g', 0, 'generate_image'), call('v', 0, 'generate_video', { image: V1 })],
      [card('g', V1), card('v', clip, 'video')],
      null,
    );
    expect(place.get(`g:${V1}`)).toBe('beneath');
    expect(place.get(`v:${clip}`)).toBe('beneath');
  });

  it('a refined mesh supersedes the build it refined', () => {
    const a = `${DIR}/out/fox.glb`;
    const b = `${DIR}/out/fox-refined.glb`;
    // `out/fox.glb` — the way the 3D tools tell the model to name it, relative
    // to the working folder — is the same file.
    const place = placeTurnCards(
      [call('m', 0, 'generate_3d'), call('r', 0, 'refine_3d', { model_path: 'out/fox.glb' })],
      [card('m', a, 'model'), card('r', b, 'model')],
      null,
    );
    expect(place.get(`m:${a}`)).toBe('inside');
    expect(place.get(`r:${b}`)).toBe('beneath');
    // Refining some OTHER mesh leaves this one an answer.
    const other = placeTurnCards(
      [call('m', 0, 'generate_3d'), call('r', 0, 'refine_3d', { model_path: 'out/owl.glb' })],
      [card('m', a, 'model'), card('r', b, 'model')],
      null,
    );
    expect(other.get(`m:${a}`)).toBe('beneath');
  });
});

describe('one file, one card', () => {
  it('the same file from two calls is drawn once, at the newer call', () => {
    const chart = '/w/units.svg';
    const place = placeTurnCards(
      [call('c', 0, 'chart'), call('e', 0, 'chart_edit', { file: 'units.svg' })],
      [card('c', chart, 'record'), card('e', chart, 'record')],
      null,
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
});
