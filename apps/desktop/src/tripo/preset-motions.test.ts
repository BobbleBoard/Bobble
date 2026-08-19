/**
 * The preset library must be DATA, not a prompt — see preset-motions.ts.
 *
 * These build clips against a stand-in skeleton rather than a loaded model, so
 * they check the part that has to be right for a click to feel instant: that a
 * clip exists at all, that it targets the bones the rig actually has, and that
 * it moves.
 */

import { THREE } from '@pi-desktop/canvas/three';
import { describe, expect, it } from 'vitest';
import {
  buildPresetClip,
  hasPresetMotion,
  PRESET_DURATION,
  PRESET_MOTION_IDS,
} from './preset-motions';

/** A cskel27-named bone tree, deep enough for every preset's targets. */
function rig(names: readonly string[]): InstanceType<typeof THREE.Object3D> {
  const root = new THREE.Object3D();
  for (const n of names) {
    const b = new THREE.Object3D();
    b.name = n;
    root.add(b);
  }
  return root;
}

const CSKEL = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Spine3',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
];

describe('preset motions', () => {
  it('ships a clip for every card except the one that is a capture', () => {
    // dance_01's preview is a Mixamo capture, not authored curves.
    expect(PRESET_MOTION_IDS.length).toBeGreaterThanOrEqual(15);
    expect(hasPresetMotion('wave')).toBe(true);
    expect(hasPresetMotion('dance_01')).toBe(false);
  });

  it('builds a clip on a cskel27 rig', () => {
    const clip = buildPresetClip('wave', rig(CSKEL));
    expect(clip).not.toBeNull();
    expect(clip?.duration).toBe(PRESET_DURATION);
    expect(clip?.tracks.length).toBeGreaterThan(0);
  });

  it('targets bones by the names the rig actually uses', () => {
    const clip = buildPresetClip('wave', rig(CSKEL));
    for (const t of clip?.tracks ?? []) {
      const bone = t.name.split('.')[0];
      expect(CSKEL).toContain(bone);
    }
  });

  it('also accepts a Mixamo-named rig, since the curves were authored on one', () => {
    const mixamo = rig(CSKEL.map((n) => `mixamorig${n}`));
    expect(buildPresetClip('wave', mixamo)).not.toBeNull();
  });

  it('actually moves — the midpoint differs from the start', () => {
    // NOT first-vs-last: these are looping cycles, so the two ends match on
    // purpose. A clip whose ends differ would visibly snap every loop.
    const clip = buildPresetClip('wave', rig(CSKEL));
    // ANY keyframe, not the midpoint: a 2-cycle curve is back at its start
    // exactly halfway through, which says nothing about whether it moved.
    const moving = (clip?.tracks ?? []).some((t) => {
      const stride = t.values.length / t.times.length;
      for (let k = 1; k < t.times.length; k++) {
        for (let i = 0; i < stride; i++) {
          if (Math.abs(t.values[i] - t.values[k * stride + i]) > 1e-6) return true;
        }
      }
      return false;
    });
    expect(moving).toBe(true);
  });

  it('loops seamlessly — every track ends where it began', () => {
    for (const id of PRESET_MOTION_IDS) {
      const clip = buildPresetClip(id, rig(CSKEL));
      for (const t of clip?.tracks ?? []) {
        const stride = t.values.length / t.times.length;
        for (let i = 0; i < stride; i++) {
          expect(t.values[i]).toBeCloseTo(t.values[t.values.length - stride + i], 5);
        }
      }
    }
  });

  it('skips bones the rig does not have rather than throwing', () => {
    // The medial rigger emits joint_00..joint_17; no preset bone exists there.
    const medial = rig(['joint_00', 'joint_01', 'joint_02']);
    expect(buildPresetClip('wave', medial)).toBeNull();
  });

  it('is unknown-preset safe', () => {
    expect(buildPresetClip('not_a_preset', rig(CSKEL))).toBeNull();
  });

  it('keeps the root in place — a preset performs where it stands', () => {
    for (const id of PRESET_MOTION_IDS) {
      const clip = buildPresetClip(id, rig(CSKEL));
      const hips = clip?.tracks.find((t) => t.name === 'Hips.position');
      if (hips === undefined) continue;
      // Only vertical movement: x and z stay at the rest value.
      for (let i = 0; i < hips.values.length; i += 3) {
        expect(hips.values[i]).toBeCloseTo(hips.values[0], 6);
        expect(hips.values[i + 2]).toBeCloseTo(hips.values[2], 6);
      }
    }
  });
});
