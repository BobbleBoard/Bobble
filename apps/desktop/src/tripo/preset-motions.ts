/**
 * THE PRESET MOTIONS, AS DATA THE APP CAN APPLY IN A FRAME.
 *
 * the user: "the preset humanoid animation library should be existing and instantly
 * applicable."
 *
 * It was neither. `SEED_MOTIONS` carried only a `previewId` — the filename of a
 * preview video — so a preset was a thumbnail and a PROMPT, and clicking one
 * called `runMotion(m.prompt ?? m.name, true)`, i.e. it asked ARDY to generate
 * something matching the preset's NAME. That costs minutes, needs the motion
 * model downloaded, and can come back as a different movement than the video
 * the user just watched.
 *
 * The motion the video shows was never captured, though — it was AUTHORED, as
 * per-bone Euler curves, by `scripts/anim-previews/main.js`. So the honest fix
 * is not to bundle clip files but to evaluate the SAME curves here: one source
 * of truth for each preset, and what plays on the model is by construction the
 * motion its preview shows.
 *
 * BONE NAMES. The curves were written against Mixamo's rig, and the studio's
 * template rigger emits ARDY's cskel27 — whose joint names ARE Mixamo's without
 * the prefix (`mixamorigLeftForeArm` -> `LeftForeArm`), which is what makes the
 * mapping a string operation rather than a retarget. Bones the loaded model
 * does not have are skipped, so a rig with fewer joints plays the part of the
 * motion it can and nothing throws.
 *
 * These are POSES AND CYCLES, not travel: nothing here moves the root
 * horizontally, so a preset performs where it stands. That is the user's rule for
 * the presets ("letting it wander off across the grid is how you lose sight of
 * the thing you asked to see") and it is why walk and run are leg cycles rather
 * than displacements.
 */
import { THREE } from '@pi-desktop/canvas/three';

/** Sine helper — `f` cycles across the clip, `ph` in radians. */
const S = (t: number, f = 1, ph = 0): number => Math.sin(t * Math.PI * 2 * f + ph);

/** Degrees of rotation on a bone, as a function of normalised clip time. */
type Euler3 = (t: number) => readonly [number, number, number];
/** Millimetre-ish offsets in the rig's own units, same signature. */
type Offset3 = Euler3;

interface Curve {
  readonly bone: string;
  readonly rot?: Euler3;
  readonly pos?: Offset3;
}

export const PRESET_DURATION = 1.6;
const FPS = 30;

/**
 * Presets whose clip is NOT 1.6s, so that every curve in them completes a whole
 * number of cycles.
 *
 * The curves came from a generator that recorded a fixed 1.6s and played it
 * ONCE on hover, so a cycle that did not close was invisible there. Looping it
 * forever in the viewport is a different matter: `walk` runs at 1.25 cycles per
 * clip, which lands the legs mid-stride at the end and snaps back to the start
 * every 1.6 seconds.
 *
 * The cadence is preserved exactly rather than rounded away — 1.25 cycles in
 * 1.6s and 1 cycle in 1.28s are the same 0.781 strides per second, so the walk
 * looks identical and simply closes.
 */
const DURATIONS: Readonly<Record<string, number>> = {
  walk: 1.28,
};

const durationOf = (id: string): number => DURATIONS[id] ?? PRESET_DURATION;

const rot = (bone: string, fn: Euler3): Curve => ({ bone, rot: fn });
const pos = (bone: string, fn: Offset3): Curve => ({ bone, pos: fn });

/**
 * Every preset's curves, transcribed from the preview generator's `makeClip`.
 * Keyed by the same ids the preview videos use, so a card's video and its
 * motion cannot drift apart.
 */
const CURVES: Readonly<Record<string, readonly Curve[]>> = {
  wave: [
    rot('RightArm', () => [0, 0, -145]),
    rot('RightForeArm', (t) => [0, 0, -20 + 28 * S(t, 2)]),
    rot('Head', (t) => [0, 8 * S(t, 1), 0]),
  ],
  hello: [
    rot('RightArm', () => [0, 0, -145]),
    rot('RightForeArm', (t) => [0, 0, -20 + 28 * S(t, 2)]),
    rot('Head', (t) => [0, 8 * S(t, 1), 0]),
  ],
  agree: [
    rot('Head', (t) => [16 * Math.abs(S(t, 2)), 0, 0]),
    rot('Neck', (t) => [6 * Math.abs(S(t, 2)), 0, 0]),
  ],
  angry_01: angry(1),
  angry_02: angry(1.4),
  afraid: [
    rot('Spine', (t) => [18 + 2 * S(t, 2), 0, 0]),
    rot('RightArm', () => [0, 0, -30]),
    rot('LeftArm', () => [0, 0, 30]),
    rot('RightForeArm', () => [0, 0, -120]),
    rot('LeftForeArm', () => [0, 0, 120]),
    rot('Head', (t) => [10, 5 * S(t, 4), 0]),
  ],
  cheer: [
    rot('RightArm', (t) => [0, 0, -160 - 8 * S(t, 2)]),
    rot('LeftArm', (t) => [0, 0, 160 + 8 * S(t, 2)]),
    pos('Hips', (t) => [0, 8 * Math.abs(S(t, 2)), 0]),
  ],
  clap: [
    rot('RightArm', () => [0, 0, -70]),
    rot('LeftArm', () => [0, 0, 70]),
    rot('RightForeArm', (t) => [0, -35 - 30 * S(t, 3), -60]),
    rot('LeftForeArm', (t) => [0, 35 + 30 * S(t, 3), 60]),
  ],
  idle: [
    rot('Spine', (t) => [2 * S(t, 1), 0, 1.5 * S(t, 1)]),
    rot('Head', (t) => [2 * S(t, 1, 1), 4 * S(t, 0.5), 0]),
    pos('Hips', (t) => [0, 1.2 * S(t, 1), 0]),
  ],
  jump: [
    pos('Hips', (t) => [0, Math.max(0, 26 * S(t, 1)) - 6 * Math.max(0, S(t, 1, Math.PI)), 0]),
    rot('RightUpLeg', (t) => [Math.max(0, -40 * S(t, 1, Math.PI)), 0, 0]),
    rot('LeftUpLeg', (t) => [Math.max(0, -40 * S(t, 1, Math.PI)), 0, 0]),
    rot('RightArm', (t) => [0, 0, -40 - 50 * Math.max(0, S(t, 1))]),
    rot('LeftArm', (t) => [0, 0, 40 + 50 * Math.max(0, S(t, 1))]),
  ],
  kick: [
    rot('RightUpLeg', (t) => [-70 * Math.max(0, S(t, 1)), 0, 0]),
    rot('RightLeg', (t) => [45 * Math.max(0, S(t, 1, 0.6)), 0, 0]),
    rot('Spine', (t) => [-6 * Math.max(0, S(t, 1)), 0, 0]),
    rot('RightArm', () => [0, 0, -35]),
    rot('LeftArm', () => [0, 0, 35]),
  ],
  point: [rot('RightArm', (t) => [0, -12, -88 + 2 * S(t, 1)]), rot('Head', () => [0, -10, 0])],
  run: gait(2, 42, -25, 10, 5),
  // 1 cycle over the shorter clip — see DURATIONS.walk.
  walk: gait(1, 26, -8, 3, 2.5),
  sad_01: [
    rot('Head', (t) => [24 + 2 * S(t, 1), 0, 0]),
    rot('Spine', () => [10, 0, 0]),
    rot('RightShoulder', () => [12, 0, 0]),
    rot('LeftShoulder', () => [12, 0, 0]),
  ],
  /* dance_01 is deliberately absent — its preview is a Mixamo capture played on
     its own character, not authored curves, so there is nothing here to
     evaluate and the card falls back to generating it. */
};

function angry(m: number): readonly Curve[] {
  return [
    rot('RightArm', () => [0, 0, -55 * m]),
    rot('LeftArm', () => [0, 0, 55 * m]),
    rot('RightForeArm', () => [0, 0, -95]),
    rot('LeftForeArm', () => [0, 0, 95]),
    rot('Head', (t) => [6, 14 * S(t, 3), 0]),
  ];
}

function gait(f: number, amp: number, armZ: number, lean: number, bob: number): readonly Curve[] {
  return [
    rot('RightUpLeg', (t) => [amp * S(t, f), 0, 0]),
    rot('LeftUpLeg', (t) => [-amp * S(t, f), 0, 0]),
    rot('RightLeg', (t) => [Math.max(0, 40 * S(t, f, 2.2)), 0, 0]),
    rot('LeftLeg', (t) => [Math.max(0, 40 * S(t, f, 2.2 + Math.PI)), 0, 0]),
    rot('RightArm', (t) => [-amp * 0.7 * S(t, f), 0, armZ]),
    rot('LeftArm', (t) => [amp * 0.7 * S(t, f), 0, -armZ]),
    rot('Spine', () => [lean, 0, 0]),
    pos('Hips', (t) => [0, bob * Math.abs(S(t, f * 2)), 0]),
  ];
}

/**
 * Canonical T-POSE direction each bone points in, in its own parent's frame.
 *
 * WHY A CORRECTION IS NEEDED AT ALL. The curves say things like "rotate the
 * right arm -145 degrees about Z", and they mean it RELATIVE TO A T-POSE,
 * because that is the rest pose of the Mixamo rig they were authored on. Our
 * template rigger fits the skeleton to the mesh, so a character modelled with
 * its arms at its sides gets a bind pose with the arms DOWN — correct for
 * skinning, and 90 degrees away from what the curves assume. Composing the
 * authored delta straight onto that bind drove every arm through the body:
 * MEASURED, the astronaut folded into itself the moment a preset played, while
 * the same model at rest was flawless.
 *
 * So each bone is first rotated from wherever it rests to where a T-pose would
 * put it, and the authored motion is composed on top of THAT. The direction is
 * taken from the bone's own first child, so it works off the rig's geometry
 * rather than a table of expected orientations.
 */
const TPOSE_DIR: Readonly<Record<string, readonly [number, number, number]>> = {
  LeftShoulder: [1, 0, 0],
  LeftArm: [1, 0, 0],
  LeftForeArm: [1, 0, 0],
  RightShoulder: [-1, 0, 0],
  RightArm: [-1, 0, 0],
  RightForeArm: [-1, 0, 0],
  LeftUpLeg: [0, -1, 0],
  LeftLeg: [0, -1, 0],
  RightUpLeg: [0, -1, 0],
  RightLeg: [0, -1, 0],
  Spine: [0, 1, 0],
  Spine1: [0, 1, 0],
  Spine2: [0, 1, 0],
  Spine3: [0, 1, 0],
  Neck: [0, 1, 0],
  Head: [0, 1, 0],
};

/**
 * The rotation that takes `bone` from its bind direction to its T-pose one.
 *
 * Identity when the bone has no child to measure a direction from (hands, the
 * head's tip) or no canonical direction — those carry no length to swing, so
 * leaving them alone is both safe and correct.
 */
function tposeCorrection(
  bone: InstanceType<typeof THREE.Object3D>,
  canonical: readonly [number, number, number] | undefined,
): InstanceType<typeof THREE.Quaternion> {
  const q = new THREE.Quaternion();
  if (canonical === undefined) return q;
  const child = bone.children.find((c) => c.name !== '');
  if (child === undefined) return q;
  const dir = child.position.clone();
  if (dir.lengthSq() < 1e-12) return q;
  dir.normalize();
  const target = new THREE.Vector3(canonical[0], canonical[1], canonical[2]);

  /*
   * A FULL BASIS, not just the direction. `setFromUnitVectors` gives the
   * shortest arc between two directions, which leaves the ROLL about that
   * direction unspecified — so the bone ended up pointing the right way with its
   * local axes twisted, and an authored rotation "about Z" then swung the limb
   * about whatever axis happened to land there. The wave came out as the arm
   * folding across the chest.
   *
   * Fixing the roll needs a second reference. The rig's own up (+Y) serves,
   * except for the bones that POINT along it — the spine and legs — where it is
   * degenerate and +Z (forward) is used instead. Both bases are then built the
   * same way, so the correction carries orientation and not just aim.
   */
  const degenerate = Math.abs(dir.y) > 0.9 || Math.abs(target.y) > 0.9;
  const ref = degenerate ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const basis = (primary: InstanceType<typeof THREE.Vector3>) => {
    const x = primary.clone().normalize();
    const z = new THREE.Vector3().crossVectors(x, ref).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const from = new THREE.Quaternion().setFromRotationMatrix(basis(dir));
  const to = new THREE.Quaternion().setFromRotationMatrix(basis(target));
  return q.copy(to).multiply(from.invert());
}

/** Is there authored motion for this preset id? */
export function hasPresetMotion(id: string): boolean {
  return CURVES[id] !== undefined;
}

export const PRESET_MOTION_IDS: readonly string[] = Object.keys(CURVES);

/**
 * Build the clip for `id` against the bones `root` actually has.
 *
 * Returns null when the preset is unknown or the rig shares no bone with it —
 * an empty clip plays as a freeze, which reads as "the click did nothing".
 */
export function buildPresetClip(
  id: string,
  root: InstanceType<typeof THREE.Object3D>,
): InstanceType<typeof THREE.AnimationClip> | null {
  const curves = CURVES[id];
  if (curves === undefined) return null;

  /* Bones are looked up by cskel27 name, then by the Mixamo spelling, so a model
     imported from a Mixamo-rigged file works too without a second code path. */
  const find = (bone: string): InstanceType<typeof THREE.Object3D> | undefined =>
    root.getObjectByName(bone) ?? root.getObjectByName(`mixamorig${bone}`);

  const tracks: InstanceType<typeof THREE.KeyframeTrack>[] = [];
  const duration = durationOf(id);
  const steps = Math.round(duration * FPS);
  const euler = new THREE.Euler();
  const delta = new THREE.Quaternion();
  const out = new THREE.Quaternion();

  for (const curve of curves) {
    const bone = find(curve.bone);
    if (bone === undefined) continue;
    const times: number[] = [];
    const values: number[] = [];

    if (curve.rot !== undefined) {
      // Curves are DELTAS from the rig's own rest pose, not absolute
      // orientations: the authored numbers describe "raise this arm by 145
      // degrees", and applying them absolutely would first snap every rigged
      // model into Mixamo's T-pose regardless of how it was built.
      // rest * toTpose * authored — see tposeCorrection.
      const rest = bone.quaternion.clone().multiply(tposeCorrection(bone, TPOSE_DIR[curve.bone]));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const [x, y, z] = curve.rot(t);
        times.push(t * duration);
        euler.set((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180);
        delta.setFromEuler(euler);
        out.copy(rest).multiply(delta);
        values.push(out.x, out.y, out.z, out.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
      continue;
    }

    if (curve.pos !== undefined) {
      const base = bone.position.clone();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const [dx, dy, dz] = curve.pos(t);
        times.push(t * duration);
        values.push(base.x + dx, base.y + dy, base.z + dz);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values));
    }
  }

  if (tracks.length === 0) return null;

  /* Arms not otherwise animated hang at the sides. A rig fitted from a mesh
     whose arms are already down does not need it, but one built in T-pose reads
     as a mannequin without it — the same reason the preview generator does it. */
  const touched = new Set(tracks.map((t) => t.name.split('.')[0]));
  for (const [side, sign] of [
    ['RightArm', 68],
    ['LeftArm', -68],
  ] as const) {
    const bone = find(side);
    if (bone === undefined || touched.has(bone.name)) continue;
    const rest = bone.quaternion.clone().multiply(tposeCorrection(bone, TPOSE_DIR[side]));
    euler.set(0, 0, (sign * Math.PI) / 180);
    delta.setFromEuler(euler);
    out.copy(rest).multiply(delta);
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        [0, duration],
        [out.x, out.y, out.z, out.w, out.x, out.y, out.z, out.w],
      ),
    );
  }

  return new THREE.AnimationClip(id, duration, tracks);
}
