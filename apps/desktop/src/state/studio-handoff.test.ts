/**
 * The handoff is a one-shot message across a mounting boundary — the transcript
 * unmounts as the studio mounts — so the two properties that matter are that it
 * survives the gap and that it is consumed exactly once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { studioFor, useStudioHandoff } from './studio-handoff';

const media = (name: string) => ({ path: `/out/${name}`, name, kind: 'image' as const });

beforeEach(() => useStudioHandoff.setState({ pending: {} }));

describe('studioFor', () => {
  it('sends each kind to the room that can work on it', () => {
    expect(studioFor('model')).toBe('3d');
    expect(studioFor('image')).toBe('image');
    expect(studioFor('video')).toBe('video');
    expect(studioFor('audio')).toBe('audio');
  });
});

describe('the handoff', () => {
  it('survives the gap between the two rooms', () => {
    useStudioHandoff.getState().offer('image', media('fox.png'));
    expect(useStudioHandoff.getState().take('image')?.name).toBe('fox.png');
  });

  it('is consumed exactly once', () => {
    /*
     * A studio that is left and returned to must not silently reload what it was
     * handed twenty minutes ago — that would discard whatever you did in between.
     */
    useStudioHandoff.getState().offer('image', media('fox.png'));
    expect(useStudioHandoff.getState().take('image')).not.toBeNull();
    expect(useStudioHandoff.getState().take('image')).toBeNull();
  });

  it('peeks without consuming, for a render before the room has mounted', () => {
    useStudioHandoff.getState().offer('image', media('fox.png'));
    expect(useStudioHandoff.getState().peek('image')?.name).toBe('fox.png');
    expect(useStudioHandoff.getState().take('image')?.name).toBe('fox.png');
  });

  it('keeps the rooms separate', () => {
    useStudioHandoff.getState().offer('image', media('fox.png'));
    useStudioHandoff.getState().offer('3d', { ...media('bust.glb'), kind: 'model' });
    expect(useStudioHandoff.getState().take('3d')?.name).toBe('bust.glb');
    // Taking one must not empty the other.
    expect(useStudioHandoff.getState().take('image')?.name).toBe('fox.png');
  });

  it('replaces rather than queues — the latest offer is the one you meant', () => {
    useStudioHandoff.getState().offer('image', media('one.png'));
    useStudioHandoff.getState().offer('image', media('two.png'));
    expect(useStudioHandoff.getState().take('image')?.name).toBe('two.png');
    expect(useStudioHandoff.getState().take('image')).toBeNull();
  });

  it('carries the prompt and seed, because "again but…" is the point', () => {
    useStudioHandoff
      .getState()
      .offer('image', { ...media('fox.png'), prompt: 'a red fox', seed: 42, model: 'z-image' });
    const got = useStudioHandoff.getState().take('image');
    expect(got).toMatchObject({ prompt: 'a red fox', seed: 42, model: 'z-image' });
  });

  it('clear drops a pending offer without taking it', () => {
    useStudioHandoff.getState().offer('image', media('fox.png'));
    useStudioHandoff.getState().clear('image');
    expect(useStudioHandoff.getState().peek('image')).toBeNull();
  });
});
