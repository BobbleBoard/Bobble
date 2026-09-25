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

describe('what the turn made is the work; what it presented is the answer', () => {
  /* the user's iteration: one chain, each edit taking the previous result as input. */
  const calls = [
    call('e1', 0, 'edit_image', { image_path: '/Users/j/Desktop/photo.png', instruction: 'x' }),
    call('e2', 0, 'edit_image', { image_path: V1, instruction: 'warmer' }),
    call('e3', 0, 'edit_image', { image_path: V2, instruction: 'crop' }),
  ];
  const cards = [card('e1', V1), card('e2', V2), card('e3', V3)];

  it('every result files into the chain — none of them was handed over', () => {
    const place = placeTurnCards(calls, cards);
    expect([...place.values()]).toEqual(['inside', 'inside', 'inside']);
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

  it('eight pages of a children’s book come out only as the model presents them', () => {
    const pages = Array.from({ length: 8 }, (_, i) =>
      call(`g${i}`, 0, 'generate_image', { prompt: `page ${i}` }),
    );
    const made = pages.map((c, i) => card(c.id, `${DIR}/page_${i}.png`));
    expect([...placeTurnCards(pages, made).values()].every((p) => p === 'inside')).toBe(true);
    const shown = [...pages, call('p', 1, 'present', { path: `${DIR}` })];
    const place = placeTurnCards(shown, [...made, card('p', DIR, 'record')]);
    expect(place.get(`p:${DIR}`)).toBe('beneath');
  });

  it('a chart the chart tool drew is part of the work until it is presented', () => {
    const chart = '/w/units.svg';
    const drawn = placeTurnCards([call('c', 0, 'chart')], [card('c', chart, 'record')]);
    expect(drawn.get(`c:${chart}`)).toBe('inside');
    const shown = placeTurnCards(
      [call('c', 0, 'chart'), call('p', 0, 'present', { path: 'units.svg' })],
      [card('p', chart, 'record')],
    );
    expect(shown.get(`p:${chart}`)).toBe('beneath');
  });

  it('a card no call in the turn accounts for stays where it was drawn', () => {
    expect(placeTurnCards([], [card('x', V1)]).get(`x:${V1}`)).toBe('beneath');
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
    expect(place.get(`e:${chart}`)).toBe('inside');
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
