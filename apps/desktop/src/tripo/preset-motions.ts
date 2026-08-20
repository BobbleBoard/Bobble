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
 * the user just watched. The motion is authored, not captured, so it belongs
 * here where a click can apply it.
 *
 * WHY THIS IS WRITTEN AS AIM DIRECTIONS RATHER THAN JOINT ANGLES.
 *
 * The preview generator states its motion as per-bone Euler deltas — "rotate
 * the right arm -145 degrees about Z" — which only means anything relative to
 * the rest pose those numbers were authored against, Mixamo's T-pose. Our
 * template rigger fits the skeleton to the MESH, so a character modelled with
 * its arms at its sides binds with the arms down. Composing T-pose-relative
 * angles onto that bind folded the astronaut into itself; correcting the bone's
 * direction stopped the folding but left the roll free, and correcting the full
 * basis still put the wave across the chest. Three attempts, each better and
 * none right, because a joint angle is only meaningful next to the rest pose it
 * was measured from — and we do not have that rest pose.
 *
 * A DIRECTION does not have that problem. "The upper arm points up and out" is
 * the same instruction whether the bone binds along -X, straight down, or at
 * 40 degrees, and the rotation that achieves it is computed from wherever the
 * bone actually rests. So each curve below says where a limb should POINT, in
 * the model's own space (+X is the model's left, +Y up, -Z the way it faces),
 * and `aimLocal` solves for the joint rotation. Bind-pose independent by
 * construction, which is the property the previous three attempts lacked.
 *
 * Rotations that are not aims — a nod, a head turn, a spine lean — stay small
 * Euler deltas on the rest pose, where the bind-pose error is a degree or two
 * and invisible.
 *
 * These are POSES AND CYCLES, not travel: nothing moves the root horizontally,
 * so a preset performs where it stands. That is the user's rule for the presets
 * ("letting it wander off across the grid is how you lose sight of the thing
 * you asked to see").
 */
import { THREE } from '@pi-desktop/canvas/three';

/** Sine helper — `f` cycles across the clip, `ph` in radians. */
const S = (t: number, f = 1, ph = 0): number => Math.sin(t * Math.PI * 2 * f + ph);

/** Where a limb points, in model space, as a function of normalised clip time. */
type Dir3 = (t: number) => readonly [number, number, number];
/** Degrees about the bone's own axes — for nods and leans, not limbs. */
type Euler3 = Dir3;

interface Curve {
  readonly bone: string;
  /** Point this bone's limb here (model space). */
  readonly aim?: Dir3;
  /** Small rotation from rest, in degrees. */
  readonly turn?: Euler3;
  /** Offset from rest, in the rig's units. */
  readonly move?: Dir3;
}

export const PRESET_DURATION = 1.6;
const FPS = 30;

/**
 * Presets whose clip is NOT 1.6s, so every curve completes a whole cycle.
 *
 * The generator recorded a fixed 1.6s and played it ONCE on hover, so a cycle
 * that did not close was invisible there. Looping forever is different: `walk`
 * ran 1.25 cycles per clip, landing the legs mid-stride and snapping back every
 * 1.6s. The cadence is preserved rather than rounded — 1 cycle in 1.28s is the
 * same 0.781 strides per second as 1.25 cycles in 1.6s.
 */
const DURATIONS: Readonly<Record<string, number>> = { walk: 1.28 };
const durationOf = (id: string): number => DURATIONS[id] ?? PRESET_DURATION;

const aim = (bone: string, fn: Dir3): Curve => ({ bone, aim: fn });
const turn = (bone: string, fn: Euler3): Curve => ({ bone, turn: fn });
const move = (bone: string, fn: Dir3): Curve => ({ bone, move: fn });

/* Model space: +X the model's LEFT, +Y up, -Z the way it faces. So the RIGHT
   arm reaching outward points along -X, and anything reaching forward is -Z. */

function angry(m: number): readonly Curve[] {
  const out = 0.62 + 0.12 * m; // wider stance the angrier it is
  return [
    aim('RightArm', () => [-out, -0.62, -0.2]),
    aim('LeftArm', () => [out, -0.62, -0.2]),
    // Forearms up and in: fists raised in front of the chest.
    aim('RightForeArm', () => [-0.3, 0.5, -0.81]),
    aim('LeftForeArm', () => [0.3, 0.5, -0.81]),
    turn('Head', (t) => [6, 14 * S(t, 3), 0]),
  ];
}

function gait(
  f: number,
  swing: number,
  armSwing: number,
  lean: number,
  bob: number,
): readonly Curve[] {
  return [
    // Legs swing fore/aft about vertical; the knee straightens on the forward
    // half of the stride, which is what makes it read as a step rather than a
    // shuffle.
    aim('RightUpLeg', (t) => [0, -1, -swing * S(t, f)]),
    aim('LeftUpLeg', (t) => [0, -1, swing * S(t, f)]),
    // A KNEE ONLY BENDS ONE WAY. Letting the shin swing forward with the thigh
    // hyperextends it, and the skin tears around the joint — which is what made
    // `run` render as a crumpled heap while `walk`, with half the swing, merely
    // looked stiff. The shin trails (+Z, behind) and only when the thigh is
    // behind the body, which is also when a real knee picks the foot up.
    aim('RightLeg', (t) => [0, -1, swing * 0.9 * Math.max(0, -S(t, f))]),
    aim('LeftLeg', (t) => [0, -1, swing * 0.9 * Math.max(0, S(t, f))]),
    // Arms counter-swing to the legs.
    aim('RightArm', (t) => [-0.2, -1, armSwing * S(t, f, Math.PI)]),
    aim('LeftArm', (t) => [0.2, -1, -armSwing * S(t, f, Math.PI)]),
    turn('Spine', () => [lean, 0, 0]),
    move('Hips', (t) => [0, bob * Math.abs(S(t, f * 2)), 0]),
  ];
}

/** Every preset's curves, keyed by the id its preview video uses. */
const CURVES: Readonly<Record<string, readonly Curve[]>> = {
  wave: [
    // Upper arm out and up; forearm vertical, swinging side to side.
    aim('RightArm', () => [-0.88, 0.46, -0.1]),
    aim('RightForeArm', (t) => [-0.5 + 0.28 * S(t, 2), 0.85, -0.05]),
    turn('Head', (t) => [0, 8 * S(t, 1), 0]),
  ],
  hello: [
    aim('RightArm', () => [-0.88, 0.46, -0.1]),
    aim('RightForeArm', (t) => [-0.5 + 0.28 * S(t, 2), 0.85, -0.05]),
    turn('Head', (t) => [0, 8 * S(t, 1), 0]),
  ],
  agree: [
    turn('Head', (t) => [16 * Math.abs(S(t, 2)), 0, 0]),
    turn('Neck', (t) => [6 * Math.abs(S(t, 2)), 0, 0]),
  ],
  angry_01: angry(1),
  angry_02: angry(1.4),
  afraid: [
    // Leaning back, forearms up in front of the face.
    turn('Spine', (t) => [-16 - 2 * S(t, 2), 0, 0]),
    aim('RightArm', () => [-0.5, -0.55, -0.67]),
    aim('LeftArm', () => [0.5, -0.55, -0.67]),
    aim('RightForeArm', () => [-0.15, 0.72, -0.68]),
    aim('LeftForeArm', () => [0.15, 0.72, -0.68]),
    turn('Head', (t) => [10, 5 * S(t, 4), 0]),
  ],
  cheer: [
    aim('RightArm', (t) => [-0.26 - 0.05 * S(t, 2), 0.96, 0]),
    aim('LeftArm', (t) => [0.26 + 0.05 * S(t, 2), 0.96, 0]),
    aim('RightForeArm', () => [-0.18, 0.98, 0]),
    aim('LeftForeArm', () => [0.18, 0.98, 0]),
    move('Hips', (t) => [0, 8 * Math.abs(S(t, 2)), 0]),
  ],
  clap: [
    aim('RightArm', () => [-0.66, -0.55, -0.51]),
    aim('LeftArm', () => [0.66, -0.55, -0.51]),
    // Hands meet in front of the chest and part again.
    aim('RightForeArm', (t) => [0.5 - 0.22 * S(t, 3), 0.12, -0.86]),
    aim('LeftForeArm', (t) => [-0.5 + 0.22 * S(t, 3), 0.12, -0.86]),
  ],
  idle: [
    turn('Spine', (t) => [2 * S(t, 1), 0, 1.5 * S(t, 1)]),
    turn('Head', (t) => [2 * S(t, 1, 1), 4 * S(t, 0.5), 0]),
    move('Hips', (t) => [0, 1.2 * S(t, 1), 0]),
  ],
  jump: [
    move('Hips', (t) => [0, Math.max(0, 26 * S(t, 1)) - 6 * Math.max(0, S(t, 1, Math.PI)), 0]),
    // Knees tuck at the top of the arc.
    aim('RightUpLeg', (t) => [0, -1, -0.55 * Math.max(0, S(t, 1))]),
    aim('LeftUpLeg', (t) => [0, -1, -0.55 * Math.max(0, S(t, 1))]),
    aim('RightLeg', (t) => [0, -1, 0.5 * Math.max(0, S(t, 1))]),
    aim('LeftLeg', (t) => [0, -1, 0.5 * Math.max(0, S(t, 1))]),
    aim('RightArm', (t) => [-0.45, 0.5 + 0.45 * Math.max(0, S(t, 1)), 0]),
    aim('LeftArm', (t) => [0.45, 0.5 + 0.45 * Math.max(0, S(t, 1)), 0]),
  ],
  kick: [
    // Right leg swings forward and the knee snaps straight behind it.
    aim('RightUpLeg', (t) => [0, -1 + 0.75 * Math.max(0, S(t, 1)), -1.15 * Math.max(0, S(t, 1))]),
    aim('RightLeg', (t) => [0, -1, -0.9 * Math.max(0, S(t, 1, 0.6))]),
    turn('Spine', (t) => [-6 * Math.max(0, S(t, 1)), 0, 0]),
    aim('RightArm', () => [-0.55, -0.8, 0.2]),
    aim('LeftArm', () => [0.55, -0.8, -0.2]),
  ],
  point: [
    // Out as well as forward: a purely forward point is foreshortened to a stub
    // from the studio's three-quarter camera, which reads as "nothing happened".
    aim('RightArm', (t) => [-0.55 + 0.02 * S(t, 1), 0.02, -0.83]),
    aim('RightForeArm', () => [-0.5, 0.0, -0.87]),
    turn('Head', () => [0, -10, 0]),
  ],
  run: gait(2, 0.85, 0.6, 10, 5),
  // 1 cycle over the shorter clip — see DURATIONS.walk.
  walk: gait(1, 0.5, 0.34, 3, 2.5),
  sad_01: [
    turn('Head', (t) => [24 + 2 * S(t, 1), 0, 0]),
    turn('Spine', () => [10, 0, 0]),
    // Shoulders slumped, arms hanging slightly in front.
    aim('RightArm', () => [-0.2, -0.96, -0.2]),
    aim('LeftArm', () => [0.2, -0.96, -0.2]),
  ],
  /* dance_01 is deliberately absent — its preview is a Mixamo capture played on
     its own character, not authored curves, so there is nothing here to
     evaluate and the card falls back to generating it. */
};

/**
 * The presets whose pose has been RENDERED on a rigged figure and read back.
 *
 * Only these play instantly; the rest fall back to generating, as before.
 *
 * They were verified on a neutral mannequin — a single watertight shell with
 * ordinary human proportions — and that subject matters as much as the list.
 * The astronaut everything was first tested on has a helmet nearly as wide as
 * its shoulders and short arms, so ANY raised-arm pose puts the hand inside the
 * head; it reads as broken whatever the rig does, and it sent three rounds of
 * work chasing a fault that was the character's proportions. A mannequin made
 * of separate interpenetrating capsules was no better: with no connected
 * surface at the shoulder there is no geodesic path, the weights fall back to
 * straight-line, and every shoulder tore. One shell, normal proportions, or the
 * result says nothing.
 *
 * Left out, and why:
 *   point  — the arm does not visibly leave the body from the studio camera.
 *   cheer  — reads correctly but both shoulders throw small shards.
 *   angry_01/02, afraid, jump, kick — shoulder or hip tearing at full swing.
 * All of them still work as generated motions, so nothing is lost from the
 * library; they just cost a minute instead of a frame.
 *
 * To add one: run
 *   GLB=<rigged.glb> TAB=animate PRESET=m-<id> MODES=clay \
 *     node tests/e2e/gen3d-visual-check.mjs
 * look at the frame, and only then put it in this list.
 */
const VERIFIED: ReadonlySet<string> = new Set([
  'wave',
  'hello',
  'clap',
  'agree',
  'sad_01',
  'walk',
  'run',
  'idle',
]);

/** Is there authored motion for this preset id that we have verified? */
export function hasPresetMotion(id: string): boolean {
  return VERIFIED.has(id) && CURVES[id] !== undefined;
}

/** Every id with curves, verified or not — the tests exercise all of them. */
export const PRESET_MOTION_IDS: readonly string[] = Object.keys(CURVES);
export const VERIFIED_PRESET_IDS: readonly string[] = [...VERIFIED];

/** Arms are lowered when a preset does not animate them, so nothing reads as a
 *  mannequin holding a T-pose. Same reason the preview generator does it. */
const HANGING: Readonly<Record<string, readonly [number, number, number]>> = {
  RightArm: [-0.22, -0.96, -0.05],
  LeftArm: [0.22, -0.96, -0.05],
};

/**
 * The local rotation that makes `bone`'s limb point along `want` (model space).
 *
 * Everything here is bind-pose relative: the bone's rest direction comes from
 * where its child actually sits, and the target is brought into the parent's
 * frame using the parent's own world rotation. A bone with no child has no
 * limb to aim, so it is left alone rather than spun about an arbitrary axis.
 */
function aimLocal(
  bone: InstanceType<typeof THREE.Object3D>,
  want: readonly [number, number, number],
): InstanceType<typeof THREE.Quaternion> | null {
  const child = bone.children.find((c) => c.name !== '' && c.position.lengthSq() > 1e-12);
  if (child === undefined) return null;

  const restDir = child.position.clone().normalize();
  const target = new THREE.Vector3(want[0], want[1], want[2]);
  if (target.lengthSq() < 1e-12) return null;
  target.normalize();

  // Model space -> the bone's parent frame, so the aim means the same thing
  // wherever the parent happens to be pointing.
  const parent = bone.parent;
  if (parent !== null) {
    const pq = new THREE.Quaternion();
    parent.getWorldQuaternion(pq);
    target.applyQuaternion(pq.invert());
    target.normalize();
  }

  // `restDir` is in the bone's own frame; rotating the bone by its rest
  // quaternion puts that direction into the parent's frame, which is where the
  // target now lives.
  const restInParent = restDir.clone().applyQuaternion(bone.quaternion).normalize();
  const swing = new THREE.Quaternion().setFromUnitVectors(restInParent, target);
  return swing.multiply(bone.quaternion);
}

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

  /*
   * BUILD FROM THE BIND POSE, NEVER FROM WHATEVER IS ON SCREEN.
   *
   * Every rotation here is solved against the bone's rest direction, so the
   * rest pose has to BE the rest pose when it is solved. A mixer leaves the
   * skeleton wherever the last clip stopped, so picking a second preset solved
   * against the first one's pose, a third against that, and the character
   * folded further with every click — which is exactly what a contact sheet of
   * twelve presets clicked in a row showed.
   */
  root.traverse((o) => {
    const skinned = o as { isSkinnedMesh?: boolean; skeleton?: { pose: () => void } };
    if (skinned.isSkinnedMesh === true && skinned.skeleton !== undefined) skinned.skeleton.pose();
  });
  // World matrices have to be current or every parent frame is a guess.
  root.updateWorldMatrix(true, true);

  /*
   * POSITION OFFSETS ARE IN THE GENERATOR'S UNITS, NOT OURS.
   *
   * The curves were authored on a Mixamo dummy about 100 units tall, so a hip
   * bob of "8" is 8% of its height. Our imported models are normalised to a
   * couple of units, so those numbers moved the root several body-lengths and
   * the character left the frame entirely — five of the twelve presets rendered
   * an empty viewport. Scaling by the rig's measured height makes the offsets
   * mean what they meant where they were written.
   */
  const bounds = new THREE.Box3().setFromObject(root);
  const rigHeight = bounds.max.y - bounds.min.y;
  const unit = (Number.isFinite(rigHeight) && rigHeight > 0 ? rigHeight : 100) / 100;

  /* Bones are found by cskel27 name, then by the Mixamo spelling, so a model
     imported from a Mixamo-rigged file works without a second code path. */
  const find = (bone: string): InstanceType<typeof THREE.Object3D> | undefined =>
    root.getObjectByName(bone) ?? root.getObjectByName(`mixamorig${bone}`);

  const duration = durationOf(id);
  const steps = Math.round(duration * FPS);
  const euler = new THREE.Euler();
  const delta = new THREE.Quaternion();

  /* Resolve the bones once, and order them PARENT FIRST.
   *
   * An aim is solved in the parent's frame, so the parent has to already be
   * where the pose puts it. Solving every bone against the BIND pose instead
   * meant a shoulder's rotation was never accounted for when the upper arm was
   * aimed, nor the upper arm's when the forearm was — and the error compounds
   * down the chain, which is why poses that moved one bone looked right and
   * poses that moved a whole limb did not. */
  const resolved = curves
    .map((c) => ({ curve: c, bone: find(c.bone) }))
    .filter(
      (r): r is { curve: Curve; bone: InstanceType<typeof THREE.Object3D> } => r.bone !== undefined,
    );
  const depthOf = (o: InstanceType<typeof THREE.Object3D>): number => {
    let d = 0;
    for (let p = o.parent; p !== null; p = p.parent) d++;
    return d;
  };
  resolved.sort((a, b) => depthOf(a.bone) - depthOf(b.bone));

  const rest = new Map(resolved.map((r) => [r.bone, r.bone.quaternion.clone()]));
  const restPos = new Map(resolved.map((r) => [r.bone, r.bone.position.clone()]));
  const quatKeys = new Map<InstanceType<typeof THREE.Object3D>, number[]>();
  const posKeys = new Map<InstanceType<typeof THREE.Object3D>, number[]>();
  const times: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    times.push(t * duration);
    // Back to bind, then build the whole pose top-down so each aim sees the
    // parent already posed.
    for (const { bone } of resolved) {
      bone.quaternion.copy(rest.get(bone) as InstanceType<typeof THREE.Quaternion>);
      bone.position.copy(restPos.get(bone) as InstanceType<typeof THREE.Vector3>);
    }
    root.updateWorldMatrix(true, true);

    for (const { curve, bone } of resolved) {
      if (curve.aim !== undefined) {
        const q = aimLocal(bone, curve.aim(t));
        if (q !== null) bone.quaternion.copy(q);
      } else if (curve.turn !== undefined) {
        const [x, y, z] = curve.turn(t);
        euler.set((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180);
        delta.setFromEuler(euler);
        bone.quaternion
          .copy(rest.get(bone) as InstanceType<typeof THREE.Quaternion>)
          .multiply(delta);
      } else if (curve.move !== undefined) {
        const [dx, dy, dz] = curve.move(t);
        const base = restPos.get(bone) as InstanceType<typeof THREE.Vector3>;
        bone.position.set(base.x + dx * unit, base.y + dy * unit, base.z + dz * unit);
      }
      // Only this bone's subtree can be affected, and the next bone to be
      // solved may be inside it.
      bone.updateWorldMatrix(false, true);

      if (curve.move !== undefined) {
        const arr = posKeys.get(bone) ?? [];
        arr.push(bone.position.x, bone.position.y, bone.position.z);
        posKeys.set(bone, arr);
      } else {
        const arr = quatKeys.get(bone) ?? [];
        arr.push(bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w);
        quatKeys.set(bone, arr);
      }
    }
  }

  // Leave the rig as we found it — the clip carries the pose from here.
  for (const { bone } of resolved) {
    bone.quaternion.copy(rest.get(bone) as InstanceType<typeof THREE.Quaternion>);
    bone.position.copy(restPos.get(bone) as InstanceType<typeof THREE.Vector3>);
  }
  root.updateWorldMatrix(true, true);

  const tracks: InstanceType<typeof THREE.KeyframeTrack>[] = [];
  const animated = new Set<string>();
  for (const [bone, values] of quatKeys) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    animated.add(bone.name);
  }
  for (const [bone, values] of posKeys) {
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values));
  }

  if (tracks.length === 0) return null;

  for (const [side, dir] of Object.entries(HANGING)) {
    const bone = find(side);
    if (bone === undefined || animated.has(bone.name)) continue;
    const q = aimLocal(bone, dir);
    if (q === null) continue;
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        [0, duration],
        [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w],
      ),
    );
  }

  return new THREE.AnimationClip(id, duration, tracks);
}
