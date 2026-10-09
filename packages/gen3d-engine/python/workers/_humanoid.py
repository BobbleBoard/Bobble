"""Humanoid detection + the ARDY-compatible bone hierarchy.

WHAT THIS IS, PLAINLY
---------------------
This is a GEOMETRIC auto-rigger, not a learned one. It measures the mesh and
fits a standard humanoid skeleton to it, then paints skin weights from bone
distance. It is deterministic, offline, runs in ~1 s with no weights to
download, and produces a real skinned GLB.

It is NOT SkinTokens — it is a geometric placeholder, and SkinTokens is the
intended replacement.

CORRECTION (2026-07-24): an earlier version of this comment claimed SkinTokens
"requires a >=14 GB NVIDIA GPU … it cannot run on Apple Silicon". That is
WRONG. It described the upstream CUDA repo, and it came from web research that
was never executed. `mlx-community/SkinTokens-bf16` is a real MLX port (1.68 GB
bf16, Qwen3-0.6B backbone + SkinVAE decoder) that runs natively on Apple
Silicon via the Swift `mlx-skintokens-swift` package, with `auto` (skeleton +
skin) and `skinOnly` modes.

What IS still true: it emits a VRoid-template hierarchy with per-vertex
`JOINTS_0`/`WEIGHTS_0`, so feeding a consumer that expects a different skeleton
(e.g. ARDY's cskel27) needs a RETARGETING step — a mapping problem, not a
hardware one.

WHY THIS EXACT SKELETON
-----------------------
NVIDIA ARDY consumes a bespoke 27-joint skeleton ("cskel27",
ardy/skeleton/definitions.py), NOT SMPL and NOT Mixamo. It is Mixamo-*flavoured*
but topologically different in ways that matter:
  * it has Spine3 — Mixamo stops at Spine2, so a Mixamo rig is one spine joint
    short and the shoulder/neck parent differs;
  * shoulders and neck parent to Spine3, not Spine2;
  * it has {Left,Right}HandEnd and a single {Left,Right}HandThumb1;
  * no `mixamorig:` prefix, and no leaf/tip bones (HeadTop_End, Toe_End).
Emitting Mixamo names here would mean a rename is NOT sufficient to feed ARDY.
So the fit below IS cskel27, joint-for-joint, in ARDY's own parent order.

MIXAMO_ALIAS maps the 22 joints that do correspond, for retargeting bundled
Mixamo clips onto the result.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# NVIDIA ARDY "cskel27" — 27 joints, (name, parent), hierarchy order.
BONES: list[tuple[str, str | None]] = [
    ("Hips", None),
    ("Spine", "Hips"),
    ("Spine1", "Spine"),
    ("Spine2", "Spine1"),
    ("Spine3", "Spine2"),
    ("Neck", "Spine3"),
    ("Head", "Neck"),
    ("RightShoulder", "Spine3"),
    ("RightArm", "RightShoulder"),
    ("RightForeArm", "RightArm"),
    ("RightHand", "RightForeArm"),
    ("RightHandEnd", "RightHand"),
    ("RightHandThumb1", "RightHand"),
    ("LeftShoulder", "Spine3"),
    ("LeftArm", "LeftShoulder"),
    ("LeftForeArm", "LeftArm"),
    ("LeftHand", "LeftForeArm"),
    ("LeftHandEnd", "LeftHand"),
    ("LeftHandThumb1", "LeftHand"),
    ("RightUpLeg", "Hips"),
    ("RightLeg", "RightUpLeg"),
    ("RightFoot", "RightLeg"),
    ("RightToeBase", "RightFoot"),
    ("LeftUpLeg", "Hips"),
    ("LeftLeg", "LeftUpLeg"),
    ("LeftFoot", "LeftLeg"),
    ("LeftToeBase", "LeftFoot"),
]

BONE_NAMES: list[str] = [n for n, _ in BONES]
BONE_PARENT: dict[str, str | None] = dict(BONES)
SKELETON_ID = "ardy-cskel27"

# cskel27 → Mixamo, for retargeting Mixamo-authored clips onto this rig. Spine3
# has no Mixamo counterpart (Mixamo stops at Spine2) and the *HandEnd /
# *HandThumb1 joints have no clean equivalent, so they are deliberately absent.
MIXAMO_ALIAS: dict[str, str] = {
    name: f"mixamorig:{name}"
    for name in BONE_NAMES
    if name not in {"Spine3", "LeftHandEnd", "RightHandEnd"}
}

# Bones whose motion should not drag the whole surface with it.
TIP_BONES = {
    "LeftToeBase",
    "RightToeBase",
    "LeftHandEnd",
    "RightHandEnd",
    "LeftHandThumb1",
    "RightHandThumb1",
}


@dataclass
class HumanoidProbe:
    """Measurements behind the humanoid verdict — shown to the user, not hidden."""

    is_humanoid: bool
    confidence: float
    height: float
    width: float
    depth: float
    leg_split_height: float | None
    arm_span_ratio: float
    reasons: list[str]

    def as_dict(self) -> dict:
        return {
            "isHumanoid": self.is_humanoid,
            "confidence": round(self.confidence, 3),
            "height": round(self.height, 4),
            "width": round(self.width, 4),
            "depth": round(self.depth, 4),
            "legSplitHeight": None if self.leg_split_height is None else round(self.leg_split_height, 4),
            "armSpanRatio": round(self.arm_span_ratio, 3),
            "reasons": self.reasons,
        }


def _slice_components(xs: np.ndarray, gap: float) -> list[tuple[float, float]]:
    """1-D clustering of x positions: returns [(lo, hi), …] runs separated by gap."""
    if xs.size == 0:
        return []
    order = np.sort(xs)
    runs: list[tuple[float, float]] = []
    start = prev = order[0]
    for value in order[1:]:
        if value - prev > gap:
            runs.append((float(start), float(prev)))
            start = value
        prev = value
    runs.append((float(start), float(prev)))
    return runs


def probe_humanoid(vertices: np.ndarray) -> HumanoidProbe:
    """Decide whether an upright Y-up mesh reads as a humanoid.

    The test is structural, not semantic: a humanoid in T/A pose splits into two
    leg columns in the lower body and reaches wide at shoulder height. Both are
    measured off horizontal slices.
    """
    lo = vertices.min(axis=0)
    hi = vertices.max(axis=0)
    size = hi - lo
    height = float(size[1])
    width = float(size[0])
    depth = float(size[2])
    reasons: list[str] = []
    if height <= 1e-6:
        return HumanoidProbe(False, 0.0, height, width, depth, None, 0.0, ["flat mesh"])

    score = 0.0
    # 1. Upright: taller than it is deep. Humanoids are.
    if height > depth * 1.6:
        score += 0.3
    else:
        reasons.append("not upright (height ≈ depth)")

    # 2. Two leg columns in the lower third.
    gap = max(width, 1e-6) * 0.06
    leg_split: float | None = None
    for frac in (0.10, 0.16, 0.22, 0.30):
        y = lo[1] + height * frac
        band = vertices[np.abs(vertices[:, 1] - y) < height * 0.02]
        runs = _slice_components(band[:, 0], gap)
        if len(runs) == 2:
            leg_split = float(y)
            break
    if leg_split is not None:
        score += 0.35
    else:
        reasons.append("no two-leg split found in the lower body")

    # 3. Arm reach: the widest slice sits in the upper body and is wide relative
    #    to the hip width (T/A pose).
    upper = vertices[vertices[:, 1] > lo[1] + height * 0.55]
    hips = vertices[np.abs(vertices[:, 1] - (lo[1] + height * 0.5)) < height * 0.05]
    hip_w = float(np.ptp(hips[:, 0])) if hips.size else width
    upper_w = float(np.ptp(upper[:, 0])) if upper.size else 0.0
    span_ratio = upper_w / max(hip_w, 1e-6)
    if span_ratio > 1.6:
        score += 0.35
    elif span_ratio > 1.15:
        score += 0.18
        reasons.append("arms read as narrow (A-pose or arms down)")
    else:
        reasons.append("no arm span detected at shoulder height")

    is_humanoid = score >= 0.6
    return HumanoidProbe(
        is_humanoid, score, height, width, depth, leg_split, span_ratio, reasons
    )


#: A slice that splits into three x-runs — arm | torso | arm — is the signature
#: of a figure standing with its arms down. Searched between these fractions of
#: stature: below is the two-leg split (which reads as 2 runs, not 3), above is
#: the shoulder line. Only the part of an arm that actually clears the body
#: splits, so on a bulky figure this finds the hands and forearms alone — which
#: is exactly what it is asked for, since the shoulder comes from the neck.
ARMS_DOWN_BAND = (0.26, 0.72)


#: How much clear air counts as "this limb is not the torso", as a fraction of
#: the model's width. The leg split uses 0.06, which is far too coarse here: the
#: astronaut's arms clear its suit by 0.04 against a 0.036 threshold, i.e. it
#: passed by a hair and any slimmer figure would not have. Arms hang CLOSE to a
#: body in a way legs never do, so this gets its own, tighter number.
ARM_GAP_FRACTION = 0.02


def _arm_columns(
    vertices: np.ndarray,
    lo: np.ndarray,
    height: float,
    width: float,
    leg_x: float | None = None,
) -> dict[str, float] | None:
    """Find the two arm columns of a figure whose arms hang at its sides.

    Returns the columns' x, their vertical extent and an arm half-width, or
    None if the mesh never splits into three.

    WHY THIS EXISTS. The joint heights below are fractions of stature taken from
    a T-pose: shoulders at 0.80, hands at 0.785. `probe_humanoid` already
    measures whether the mesh actually reaches wide up there — the astronaut
    sample scores armSpanRatio 0.816, i.e. the upper body is NARROWER than the
    hips, and the probe says so in as many words ("no arm span detected at
    shoulder height"). Placing a T-pose anyway put both arms straight through
    the helmet and left the real arms unrigged, which ARDY then swings about
    pivots that are not in the limbs at all.

    Width alone cannot find the shoulder line here — the helmet is the widest
    part of the model — but the three-run split can, because it is about
    CONNECTIVITY rather than extent: arms at the sides leave two gaps of empty
    space that no single-blob torso ever shows.
    """
    gap = max(width, 1e-6) * ARM_GAP_FRACTION
    lows, highs, lefts, rights, widths = [], [], [], [], []
    steps = 40
    for i in range(steps + 1):
        frac = ARMS_DOWN_BAND[0] + (ARMS_DOWN_BAND[1] - ARMS_DOWN_BAND[0]) * i / steps
        yy = float(lo[1] + height * frac)
        band = vertices[np.abs(vertices[:, 1] - yy) < height * 0.012]
        if band.size == 0:
            continue
        runs = _slice_components(band[:, 0], gap)
        if len(runs) != 3:
            continue
        lows.append(yy)
        highs.append(yy)
        rights.append(float((runs[0][0] + runs[0][1]) * 0.5))
        lefts.append(float((runs[-1][0] + runs[-1][1]) * 0.5))
        widths.append(float(max(runs[0][1] - runs[0][0], runs[-1][1] - runs[-1][0])))
    # One lucky slice can be a hole in the mesh rather than a limb; a real arm
    # keeps splitting over a stretch of the body.
    if len(lefts) < 3:
        return None

    left_x = float(np.median(lefts))
    right_x = float(np.median(rights))

    # ARMS HANG OUTBOARD OF THE LEGS. Without this the two LEGS, with the hips
    # between them, read as a perfectly good three-run split and the "arm"
    # columns came back at the leg's x — so the arm chain was fitted down the
    # legs and every raised-arm pose swung the wrong limb. MEASURED on a test
    # figure: columns at x=±0.063, which is exactly where its legs are.
    #
    # The legs are the right yardstick and the hips are not: a band taken at hip
    # height catches the hands as well on an arms-down figure, so the hips
    # measure wider than the arms and the test rejects the very thing it is
    # looking for.
    if leg_x is not None and leg_x > 1e-9:
        if max(abs(left_x), abs(right_x)) < leg_x * 1.3:
            return None

    return {
        "left_x": left_x,
        "right_x": right_x,
        "top_y": float(max(highs)),
        "bottom_y": float(min(lows)),
        "half": float(np.median(widths)) * 0.5,
    }


def _neck_frac(vertices: np.ndarray, lo: np.ndarray, height: float) -> float | None:
    """The fraction of stature where the body is narrowest below the head.

    A head sits on a neck, and a neck is a WAIST in the silhouette: narrower
    than the torso below it and than the head above it. That holds whether the
    head is a head or a fishbowl helmet, which is why this is measured rather
    than taken from the 0.80-of-stature figure that anthropometry gives for
    ordinary human proportions — on the astronaut sample that figure lands the
    shoulders (and therefore both arms) inside the helmet.

    Returns None when no such waist exists, e.g. a headless or blob-shaped mesh;
    the caller then keeps the anthropometric default.
    """
    fracs = [0.55 + 0.37 * i / 36 for i in range(37)]
    widths: list[float] = []
    for frac in fracs:
        yy = float(lo[1] + height * frac)
        band = vertices[np.abs(vertices[:, 1] - yy) < height * 0.012]
        widths.append(float(np.ptp(band[:, 0])) if band.size else 0.0)
    inner = [(w, i) for i, w in enumerate(widths) if 0 < i < len(widths) - 1 and w > 0]
    if not inner:
        return None
    _w, i = min(inner)
    # A real neck has the head above it: something up there must be wider again.
    if max(widths[i + 1 :], default=0.0) <= widths[i] * 1.08:
        return None
    return fracs[i]


def _arms_tpose(
    y, cx: float, cz: float, sh_off: float, hand_l: float, hand_r: float, height: float
) -> dict[str, np.ndarray]:
    """Arms out to the sides: the chain runs along X at a near-constant height."""
    return {
        "LeftShoulder": np.array([cx + sh_off * 0.5, y(0.80), cz]),
        "LeftArm": np.array([cx + sh_off, y(0.795), cz]),
        "LeftForeArm": np.array([cx + (hand_l - cx) * 0.55, y(0.79), cz]),
        "LeftHand": np.array([cx + (hand_l - cx) * 0.88, y(0.785), cz]),
        "LeftHandEnd": np.array([hand_l, y(0.783), cz]),
        "LeftHandThumb1": np.array([cx + (hand_l - cx) * 0.93, y(0.778), cz + height * 0.02]),
        "RightShoulder": np.array([cx - sh_off * 0.5, y(0.80), cz]),
        "RightArm": np.array([cx - sh_off, y(0.795), cz]),
        "RightForeArm": np.array([cx + (hand_r - cx) * 0.55, y(0.79), cz]),
        "RightHand": np.array([cx + (hand_r - cx) * 0.88, y(0.785), cz]),
        "RightHandEnd": np.array([hand_r, y(0.783), cz]),
        "RightHandThumb1": np.array([cx + (hand_r - cx) * 0.93, y(0.778), cz + height * 0.02]),
    }


def _arms_hanging(
    cols: dict[str, float], shoulder_y: float, cx: float, cz: float, sh_off: float, height: float
) -> dict[str, np.ndarray]:
    """Arms at the sides: the chain runs DOWN the arm, not out along X.

    `shoulder_y` comes from the neck and the column from the mesh, so the two
    ends of the chain are both measured; the elbow is placed between them at the
    proportion a human arm has. The hand keeps the column's own bottom rather
    than being interpolated, because that is the one point on the arm the
    silhouette states outright.
    """
    hand_y = cols["bottom_y"] + cols["half"]
    span = max(shoulder_y - hand_y, 1e-6)
    lx, rx = cols["left_x"], cols["right_x"]

    def at(x: float, frac: float) -> np.ndarray:
        """`frac` 0 at the shoulder, 1 at the fingertips."""
        return np.array([x, shoulder_y - span * frac, cz])

    return {
        "LeftShoulder": np.array([cx + sh_off * 0.5, shoulder_y, cz]),
        "LeftArm": np.array([lx, shoulder_y, cz]),
        "LeftForeArm": at(lx, 0.48),
        "LeftHand": at(lx, 1.0),
        "LeftHandEnd": at(lx, 1.12),
        "LeftHandThumb1": np.array([lx, shoulder_y - span * 1.06, cz + height * 0.02]),
        "RightShoulder": np.array([cx - sh_off * 0.5, shoulder_y, cz]),
        "RightArm": np.array([rx, shoulder_y, cz]),
        "RightForeArm": at(rx, 0.48),
        "RightHand": at(rx, 1.0),
        "RightHandEnd": at(rx, 1.12),
        "RightHandThumb1": np.array([rx, shoulder_y - span * 1.06, cz + height * 0.02]),
    }


def fit_skeleton(vertices: np.ndarray) -> dict[str, np.ndarray]:
    """Place every BONE_NAMES joint on this mesh, in world space (Y-up).

    Heights come from anthropometric fractions of the measured stature; the X/Z
    placement of limbs is measured off the mesh so it tracks the actual body.
    """
    lo = vertices.min(axis=0)
    hi = vertices.max(axis=0)
    height = float(hi[1] - lo[1])
    cx = float((lo[0] + hi[0]) * 0.5)
    cz = float((lo[2] + hi[2]) * 0.5)

    def y(frac: float) -> float:
        return float(lo[1] + height * frac)

    def slice_x_extremes(frac: float, band: float = 0.03) -> tuple[float, float]:
        yy = y(frac)
        sel = vertices[np.abs(vertices[:, 1] - yy) < height * band]
        if sel.size == 0:
            return cx, cx
        return float(sel[:, 0].min()), float(sel[:, 0].max())

    # Leg columns: measure the two clusters just above the ankles.
    gap = max(float(hi[0] - lo[0]), 1e-6) * 0.06
    ankle_band = vertices[np.abs(vertices[:, 1] - y(0.10)) < height * 0.03]
    runs = _slice_components(ankle_band[:, 0], gap) if ankle_band.size else []
    if len(runs) == 2:
        left_x = float((runs[1][0] + runs[1][1]) * 0.5)
        right_x = float((runs[0][0] + runs[0][1]) * 0.5)
    else:
        hip_l, hip_r = slice_x_extremes(0.50)
        quarter = (hip_r - hip_l) * 0.25
        left_x, right_x = cx + quarter, cx - quarter

    shoulder_l, shoulder_r = slice_x_extremes(0.80)
    arm_l, arm_r = slice_x_extremes(0.78, band=0.05)
    # Shoulder joints sit inboard of the silhouette; hands at the extremes.
    body_half = max((shoulder_r - shoulder_l) * 0.5, 1e-6)
    sh_off = min(body_half * 0.35, height * 0.09)
    hand_l, hand_r = arm_r, arm_l  # +X is the model's LEFT in glTF (Y-up, -Z fwd)

    # ARMS DOWN. The heights just above describe a T-pose; when the mesh says
    # its arms hang at its sides, run the chain down the measured columns
    # instead. Everything else — spine, legs, head — is unchanged, so a figure
    # that IS in T-pose takes exactly the path it always took.
    down = _arm_columns(
        vertices, lo, height, float(hi[0] - lo[0]), max(abs(left_x), abs(right_x))
    )
    if down is None:
        arms = _arms_tpose(y, cx, cz, sh_off, hand_l, hand_r, height)
    else:
        neck = _neck_frac(vertices, lo, height)
        arms = _arms_hanging(down, y((neck or 0.835) - 0.075), cx, cz, sh_off, height)

    joints: dict[str, np.ndarray] = {
        "Hips": np.array([cx, y(0.53), cz]),
        "Spine": np.array([cx, y(0.58), cz]),
        "Spine1": np.array([cx, y(0.635), cz]),
        "Spine2": np.array([cx, y(0.69), cz]),
        "Spine3": np.array([cx, y(0.745), cz]),
        "Neck": np.array([cx, y(0.835), cz]),
        "Head": np.array([cx, y(0.88), cz]),
        **arms,
        "LeftUpLeg": np.array([left_x, y(0.51), cz]),
        "LeftLeg": np.array([left_x, y(0.28), cz]),
        "LeftFoot": np.array([left_x, y(0.045), cz]),
        "LeftToeBase": np.array([left_x, y(0.02), cz + max(height * 0.05, 1e-4)]),
        "RightUpLeg": np.array([right_x, y(0.51), cz]),
        "RightLeg": np.array([right_x, y(0.28), cz]),
        "RightFoot": np.array([right_x, y(0.045), cz]),
        "RightToeBase": np.array([right_x, y(0.02), cz + max(height * 0.05, 1e-4)]),
    }
    missing = [n for n in BONE_NAMES if n not in joints]
    if missing:
        raise RuntimeError(f"skeleton fit is missing joints: {missing}")
    return _pull_joints_inside(joints, vertices, height)


#: How far a leaf joint retracts along its own bone, as a fraction of that
#: bone's length. Enough to clear a fingertip, small enough that the hand stays
#: a hand — MEASURED, it takes the worst overshoot from 27mm to under 10mm.
LEAF_RETRACT = 0.22


def _has_child(name: str) -> bool:
    return any(p == name for _, p in BONES)


def _pull_joints_inside(
    joints: dict[str, np.ndarray], vertices: np.ndarray, height: float
) -> dict[str, np.ndarray]:
    """Centre every joint ACROSS its limb, without sliding it along the limb.

    THE JOINTS ABOVE ARE GUESSES IN TWO OF THREE AXES. A hand is placed at the
    silhouette's x-extreme with y taken from a fixed fraction of height and z
    from the body's centre — so if the arm does not happen to sit at exactly
    0.783 of the model's height, the joint lands beside the arm rather than in
    it, and the skeleton visibly pokes out of the body. That is not cosmetic:
    this fit is what ARDY's motion drives, so a joint outside a limb swings that
    limb about the wrong pivot.

    THE CORRECTION IS PERPENDICULAR ONLY, and that restriction is the whole
    lesson. A free move to the local surface mean scores beautifully on "is the
    joint inside the mesh" — MEASURED 23/27 inside, worst 1.3mm — while dragging
    the hand joints out of the arms and into the TORSO, which is inside the mesh
    and utterly wrong. The user's screenshot showed the result: a skeleton with no
    arm bones at all. Inside-ness is necessary and nowhere near sufficient.

    So the neighbourhood mean is projected onto the plane through the original
    guess perpendicular to the bone, and the shift is capped. The joint can move
    across its limb to find the limb's axis; it cannot travel down the arm, and
    it cannot leave for a different body part.
    """
    if len(vertices) == 0 or height <= 0:
        return joints
    out: dict[str, np.ndarray] = {}
    for name, guess in joints.items():
        # The bone's direction: parent -> this joint, or this joint -> its first
        # child for the root. Movement along it is what must be forbidden.
        parent = BONE_PARENT.get(name)
        axis = None
        if parent is not None and parent in joints:
            axis = guess - joints[parent]
        else:
            child = next((c for c, p in BONES if p == name and c in joints), None)
            if child is not None:
                axis = joints[child] - guess
        if axis is not None:
            n = float(np.linalg.norm(axis))
            axis = axis / n if n > 1e-9 else None

        delta = vertices - guess
        d2 = np.einsum("ij,ij->i", delta, delta)
        placed = guess
        # Grow the neighbourhood until it holds enough surface to average. The
        # first radius is about a limb's thickness; the last is generous enough
        # for a joint that started just outside the body. A joint with no
        # surface near it keeps its guess rather than being dragged to the
        # centroid of something irrelevant.
        for frac in (0.05, 0.09, 0.15):
            near = vertices[d2 <= (height * frac) ** 2]
            if len(near) < 8:
                continue
            shift = near.mean(axis=0) - guess
            if axis is not None:
                # Drop the component along the bone: centre the joint in the
                # limb's cross-section, do not slide it up or down the limb.
                shift = shift - float(np.dot(shift, axis)) * axis
            # A correction bigger than a limb is a sign the neighbourhood caught
            # something else; clamp rather than trust it.
            cap = height * 0.06
            mag = float(np.linalg.norm(shift))
            if mag > cap:
                shift = shift * (cap / mag)
            placed = guess + shift
            break

        # A LEAF joint sits at the silhouette's extreme by construction — the
        # fingertip, the toe — and no perpendicular move can pull it in, because
        # the direction it needs to go is straight back down its own bone. So
        # leaves retract a little toward their parent, which cannot take them
        # out of the limb. A hand joint belongs in the palm, not past the nails.
        if axis is not None and not _has_child(name) and parent in joints:
            bone = float(np.linalg.norm(placed - joints[parent]))
            placed = placed - axis * (bone * LEAF_RETRACT)
        out[name] = placed
    return out

def _segment_distance(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-point distance to the segment a→b (vectorised)."""
    ab = b - a
    denom = float(ab @ ab)
    if denom < 1e-12:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip(((points - a) @ ab) / denom, 0.0, 1.0)[:, None]
    return np.linalg.norm(points - (a + t * ab), axis=1)


def _geodesic_to_bones(
    vertices: np.ndarray,
    faces: np.ndarray,
    dists: np.ndarray,
    seed_frac: float = 0.35,
) -> np.ndarray | None:
    """Distance from every vertex to every bone ALONG THE SURFACE.

    THE REASON THIS EXISTS. Straight-line distance cannot tell an arm from the
    chest it is hanging beside. On a character modelled with its arms down —
    which is most of them — the upper-arm bone runs a couple of centimetres from
    the ribs, so torso vertices come out closer to it than to the spine and take
    real arm weight. Swing that arm and it drags the chest with it: MEASURED, a
    90-degree rotation of `LeftArm` on the astronaut tore a flap of surface off
    the shoulder and pulled it across the body.

    Along the SURFACE those two points are nowhere near each other — you have to
    travel down the arm, around the shoulder and back across the chest. So each
    bone seeds the vertices that are unambiguously its own (nearest to it, and
    within `seed_frac` of the closest vertex's distance), and a single Dijkstra
    per bone from a virtual source wired to all of its seeds gives the distance
    the deformation actually cares about.

    Returns None when the mesh has no usable edge graph or SciPy is absent, so
    the caller can fall back to the straight-line weights rather than fail a rig.
    """
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import dijkstra
    except ImportError:
        return None

    n = len(vertices)
    if n == 0 or len(faces) == 0:
        return None

    # Undirected edge graph of the mesh, weighted by real edge length.
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    length = np.linalg.norm(vertices[e[:, 0]] - vertices[e[:, 1]], axis=1)
    keep = length > 0
    e, length = e[keep], length[keep]
    if len(e) == 0:
        return None

    n_bones = dists.shape[1]
    nearest = dists.argmin(axis=1)
    out = np.empty_like(dists)

    for b in range(n_bones):
        own = np.where(nearest == b)[0]
        if len(own) == 0:
            # No vertex calls this bone its own — a tip inside the body, say.
            # Its straight-line field is the honest answer here.
            out[:, b] = dists[:, b]
            continue
        d_own = dists[own, b]
        cut = d_own.min() + seed_frac * (d_own.max() - d_own.min() + 1e-12)
        seeds = own[d_own <= cut]
        if len(seeds) == 0:
            seeds = own[: max(1, len(own) // 10)]

        # A virtual node (index n) joined to every seed with zero cost, so one
        # Dijkstra answers "distance to the nearest seed of this bone".
        rows = np.concatenate([e[:, 0], e[:, 1], np.full(len(seeds), n)])
        cols = np.concatenate([e[:, 1], e[:, 0], seeds])
        vals = np.concatenate([length, length, np.zeros(len(seeds))])
        g = coo_matrix((vals, (rows, cols)), shape=(n + 1, n + 1)).tocsr()
        d = dijkstra(g, directed=False, indices=n)[:n]
        # Disconnected islands come back as inf; the straight line is all we know.
        bad = ~np.isfinite(d)
        if bad.any():
            d = np.where(bad, dists[:, b], d)
        out[:, b] = d

    return out


def _smooth_weights(w: np.ndarray, faces: np.ndarray, n: int, rounds: int = 3) -> np.ndarray:
    """Average each vertex's weights with its neighbours', a few times.

    Weight painting is a job of two halves: decide WHICH bone owns a region, and
    make the handover between regions gradual. Distance answers the first and
    says nothing about the second, so a boundary between two bones is a cliff —
    and a cliff in the weights is a crack in the surface once the two bones move
    apart. Blurring along the mesh turns each cliff into a ramp a few vertices
    wide, which is what lets a shoulder rotate without the seam opening.

    Three rounds is enough to close the seams and few enough that a limb does
    not start dragging its neighbour again, which is the failure this whole path
    exists to avoid.
    """
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    if len(e) == 0:
        return w
    deg = np.bincount(e[:, 0], minlength=n) + np.bincount(e[:, 1], minlength=n)
    deg = np.maximum(deg, 1)[:, None]
    for _ in range(rounds):
        acc = np.zeros_like(w)
        np.add.at(acc, e[:, 0], w[e[:, 1]])
        np.add.at(acc, e[:, 1], w[e[:, 0]])
        # Half the vertex's own value, half its neighbourhood: a blur that keeps
        # the region's identity while softening its edge.
        w = 0.5 * w + 0.5 * (acc / deg)
        w /= w.sum(axis=1, keepdims=True)
    return w


def skin_weights(
    vertices: np.ndarray,
    joints: dict[str, np.ndarray],
    influences: int = 4,
    faces: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Skin weights from distance to the bones: (joint_index[N,4], weight[N,4]).

    Each bone is the segment from its head to its parent's head. Distance is
    measured ALONG THE MESH when `faces` is given (see `_geodesic_to_bones` for
    why that matters), and in a straight line otherwise.
    """
    names = BONE_NAMES
    n_verts = len(vertices)
    dists = np.empty((n_verts, len(names)), dtype=np.float64)
    for i, name in enumerate(names):
        head = joints[name]
        parent = BONE_PARENT[name]
        tail = joints[parent] if parent is not None else head
        d = _segment_distance(vertices, head, tail)
        if name in TIP_BONES:
            d = d * 2.5  # tips should not claim the whole limb
        dists[:, i] = d

    geodesic = False
    if faces is not None:
        geo = _geodesic_to_bones(vertices, faces, dists)
        if geo is not None:
            dists = geo
            geodesic = True

    scale = float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0))) or 1.0
    eps = scale * 1e-3

    # SOFTER FALLOFF ON GEODESIC DISTANCE. Inverse-CUBE was tuned for
    # straight-line distance, where the numbers are small and close together.
    # Geodesic distances are longer and spread much wider, so cubing them makes
    # the winner take essentially everything — and a vertex right next to it,
    # whose nearest bone differs, takes everything from a different bone. The
    # surface then splits along those boundaries instead of bending: MEASURED,
    # the first geodesic rig deformed into shards on any multi-bone pose while
    # single-bone bends were clean.
    power = 1.5 if geodesic else 3.0
    full = 1.0 / np.power(dists + eps, power)
    full /= full.sum(axis=1, keepdims=True)

    if geodesic and faces is not None:
        full = _smooth_weights(full, faces, len(vertices))

    order = np.argsort(-full, axis=1)[:, :influences]
    weights = np.take_along_axis(full, order, axis=1)
    total = weights.sum(axis=1, keepdims=True)
    weights = np.divide(weights, total, out=np.zeros_like(weights), where=total > 0)
    # A vertex that somehow got nothing still has to sum to 1, or it collapses
    # to the origin when the mesh is posed.
    dead = (total[:, 0] <= 0)
    if dead.any():
        weights[dead, 0] = 1.0
    return order.astype(np.uint16), weights.astype(np.float32)
