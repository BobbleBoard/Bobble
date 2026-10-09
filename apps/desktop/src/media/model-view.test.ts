import { describe, expect, it, vi } from 'vitest';
import {
  controlsFor,
  countParts,
  createModelView,
  DEFAULT_MODEL_VIEW,
  fileFacts,
  isPartName,
} from './model-view';

describe('a 3D card’s few controls', () => {
  it('starts in Color with nothing toggled and nothing known about the file', () => {
    expect(createModelView().get()).toEqual(DEFAULT_MODEL_VIEW);
  });

  it('notifies on a change and stays quiet on a no-op', () => {
    const view = createModelView();
    const heard = vi.fn();
    view.subscribe(heard);
    view.set({ shading: 'grey' });
    view.set({ shading: 'grey' });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(view.get().shading).toBe('grey');
  });

  /* The user: "coloring/normals/grey, if rig, skeleton and if segment, then
     explode" — the toggles exist only for a file that has the thing. */
  it('offers Skeleton only for a rigged file and Explode only for a segmented one', () => {
    const plain = createModelView();
    fileFacts(plain, { hasSkeleton: false, parts: 0 });
    expect(controlsFor(plain.get())).toMatchObject({ skeleton: false, explode: false });
    expect(controlsFor(plain.get()).shading.map((s) => s.id)).toEqual(['color', 'normals', 'grey']);

    const rigged = createModelView();
    fileFacts(rigged, { hasSkeleton: true, parts: 0 });
    expect(controlsFor(rigged.get())).toMatchObject({ skeleton: true, explode: false });

    const split = createModelView();
    fileFacts(split, { hasSkeleton: false, parts: 5 });
    expect(controlsFor(split.get())).toMatchObject({ skeleton: false, explode: true });
  });

  it('shows a rig the moment it arrives, and keeps parts together until asked', () => {
    const rigged = createModelView();
    fileFacts(rigged, { hasSkeleton: true, parts: 0 });
    expect(rigged.get().skeleton).toBe(true);
    const split = createModelView();
    fileFacts(split, { hasSkeleton: false, parts: 3 });
    expect(split.get().explode).toBe(false);
  });

  it('respects a choice already made when the same view reloads (the expanded stage)', () => {
    const view = createModelView();
    fileFacts(view, { hasSkeleton: true, parts: 0 });
    view.set({ skeleton: false });
    fileFacts(view, { hasSkeleton: true, parts: 0 });
    expect(view.get().skeleton).toBe(false);
  });

  it('drops a toggle the file cannot honour', () => {
    const view = createModelView({ skeleton: true, explode: true });
    fileFacts(view, { hasSkeleton: false, parts: 1 });
    expect(view.get()).toMatchObject({ skeleton: false, explode: false });
  });
});

describe('parts', () => {
  it('counts the engine’s part_NN bodies and only those', () => {
    expect(isPartName('part_00_main_body')).toBe(true);
    expect(isPartName('mesh_0')).toBe(false);
    expect(countParts(['part_00_main_body', 'part_01_left_ear', 'part_02_tail'])).toBe(3);
    // Two primitives of one model are not a segmentation.
    expect(countParts(['mesh_0', 'mesh_1'])).toBe(0);
    // One part is not a split.
    expect(countParts(['part_00_body'])).toBe(0);
  });
});
