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
  VERIFIED_PRESET_IDS,
} from './preset-motions';

/** A cskel27-named bone tree, deep enough for every preset's targets. */
/**
 * One sample of a keyframe track, by index.
 *
 * The tracks are Float32Arrays read by computed offsets, and under
 * `noUncheckedIndexedAccess` every one of those reads is `number | undefined`.
 * Sprinkling `!` through the assertions would silence that by lying; this says
 * out loud what an out-of-range read means here — the clip is malformed, and
 * the test should stop rather than quietly compare against nothing.
 */
function at(values: ArrayLike<number>, i: number): number {
  const v = values[i];
  if (v === undefined) throw new Error(`track has no sample at ${i} (length ${values.length})`);
  return v;
}

function rig(names: readonly string[]): InstanceType<typeof THREE.Object3D> {
  // A CHAIN, not a flat list: the aim solver reads each bone's direction from
  // where its child sits, so bones need children with real offsets. Built arms
  // DOWN on purpose — that is the bind pose the old angle-based curves broke on.
  const root = new THREE.Object3D();
  const made = new Map<string, InstanceType<typeof THREE.Object3D>>();
  for (const n of names) {
    const b = new THREE.Object3D();
    b.name = n;
    b.position.set(0, -0.2, 0);
    made.set(n, b);
  }
  const parentOf: Readonly<Record<string, string>> = {
    Spine: 'Hips',
    Spine1: 'Spine',
    Spine2: 'Spine1',
    Spine3: 'Spine2',
    Neck: 'Spine3',
    Head: 'Neck',
    LeftShoulder: 'Spine3',
    LeftArm: 'LeftShoulder',
    LeftForeArm: 'LeftArm',
    LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine3',
    RightArm: 'RightShoulder',
    RightForeArm: 'RightArm',
    RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips',
    LeftLeg: 'LeftUpLeg',
    LeftFoot: 'LeftLeg',
    RightUpLeg: 'Hips',
    RightLeg: 'RightUpLeg',
    RightFoot: 'RightLeg',
  };
  for (const n of names) {
    const b = made.get(n);
    if (b === undefined) continue;
    const p = parentOf[n] === undefined ? root : (made.get(parentOf[n]) ?? root);
    p.add(b);
  }
  root.updateWorldMatrix(true, true);
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
    expect(PRESET_MOTION_IDS).toContain('wave');
    expect(PRESET_MOTION_IDS).not.toContain('dance_01');
  });

  it('only offers instant playback for poses that were rendered and checked', () => {
    // The gate exists so an unverified pose falls back to generating instead of
    // putting a wrong one a click away.
    expect(hasPresetMotion('idle')).toBe(true);
    expect(hasPresetMotion('wave')).toBe(true);
    expect(hasPresetMotion('run')).toBe(true);
    // Held back after rendering them: the arm does not read from the studio
    // camera, and both shoulders shard at full swing, respectively.
    expect(hasPresetMotion('point')).toBe(false);
    expect(hasPresetMotion('cheer')).toBe(false);
    expect(hasPresetMotion('dance_01')).toBe(false);
    for (const id of VERIFIED_PRESET_IDS) {
      expect(PRESET_MOTION_IDS).toContain(id);
      expect(buildPresetClip(id, rig(CSKEL))).not.toBeNull();
    }
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
          if (Math.abs(at(t.values, i) - at(t.values, k * stride + i)) > 1e-6) return true;
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
          expect(at(t.values, i)).toBeCloseTo(at(t.values, t.values.length - stride + i), 5);
        }
      }
    }
  });

  it("aims from the rig's OWN rest pose, so an arms-down bind works", () => {
    // The whole reason this file states directions instead of joint angles.
    const clip = buildPresetClip('wave', rig(CSKEL));
    const arm = clip?.tracks.find((t) => t.name === 'RightArm.quaternion');
    expect(arm).toBeDefined();
    // The first keyframe must not be the identity — an arms-down bind has to be
    // rotated to reach "up and out", and a no-op would mean it was not aimed.
    const w = arm?.values[3] ?? 1;
    expect(Math.abs(w)).toBeLessThan(0.999);
  });

  it('skips bones the rig does not have rather than throwing', () => {
    // The medial rigger emits joint_00..joint_17; no preset bone exists there.
    const medial = rig(['joint_00', 'joint_01', 'joint_02']);
    expect(buildPresetClip('wave', medial)).toBeNull();
  });

  it('AIMS: the limb actually ends up pointing where the curve asked', () => {
    // The decisive check for the aim solver — if this passes, a wrong-looking
    // pose is a wrong TARGET, not broken maths, and those are fixed in very
    // different places.
    const root = rig(CSKEL);
    const clip = buildPresetClip('wave', root);
    const track = clip?.tracks.find((t) => t.name === 'RightArm.quaternion');
    expect(track).toBeDefined();
    const arm = root.getObjectByName('RightArm');
    const fore = root.getObjectByName('RightForeArm');
    expect(arm && fore).toBeTruthy();
    if (arm === undefined || fore === undefined || track === undefined) return;

    // Apply the first keyframe and read where the limb points, in model space.
    arm.quaternion.set(
      at(track.values, 0),
      at(track.values, 1),
      at(track.values, 2),
      at(track.values, 3),
    );
    root.updateWorldMatrix(true, true);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    arm.getWorldPosition(a);
    fore.getWorldPosition(b);
    const dir = b.sub(a).normalize();

    // Up and OUT — the numbers track wave's curve, so retuning the pose means
    // retuning this too; what is being checked is that the solver hits whatever
    // the curve asked for, not that the curve asks for something in particular.
    const want = new THREE.Vector3(-0.88, 0.46, -0.1).normalize();
    expect(dir.dot(want)).toBeGreaterThan(0.99);
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
        expect(at(hips.values, i)).toBeCloseTo(at(hips.values, 0), 6);
        expect(at(hips.values, i + 2)).toBeCloseTo(at(hips.values, 2), 6);
      }
    }
  });
});
