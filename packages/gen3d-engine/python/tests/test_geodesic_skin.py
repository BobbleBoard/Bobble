"""Skin weights must be measured ALONG THE SURFACE, not through the air.

the user, on a preset that mangled the model: "so skintokens needed then."

The tearing was real but the cause was ours. `skin_weights` measured straight-
line distance from each vertex to each bone SEGMENT, and on a character modelled
with its arms at its sides — which the rigger now binds arms-down, to match the
mesh — the upper-arm bone runs a couple of centimetres from the ribs. Chest
vertices therefore came out closer to the arm than to the spine and took real
arm weight, so rotating that arm dragged the chest with it. MEASURED on the
astronaut: a 90-degree rotation of `LeftArm` tore a flap off the shoulder and
pulled it across the body; with geodesic distance the same bend is clean.

Along the surface the two are nowhere near each other — you travel down the arm,
around the shoulder and back across the chest — which is the whole point.

These build a tiny mesh rather than loading an asset, so they run anywhere numpy
and scipy do.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))

try:
    from _humanoid import _geodesic_to_bones, _smooth_weights
except ImportError as err:  # trimesh lives in the meshtools venv
    from _skip import Skip

    raise Skip(f"needs the meshtools venv ({err})") from err


def _needs_scipy() -> None:
    """The geodesic pass returns None without scipy (skinning falls back to
    straight-line distance), so these tests can only run where scipy is."""
    try:
        import scipy.sparse  # noqa: F401
    except ImportError as err:
        from _skip import Skip

        raise Skip(f"needs scipy ({err})") from err


def _strip(n: int, x: float, y0: float, y1: float):
    """A vertical ribbon of `n` rows at a fixed x — a stand-in for a limb."""
    ys = np.linspace(y0, y1, n)
    v = np.stack([np.full(n, x), ys, np.zeros(n)], axis=1)
    v = np.repeat(v, 2, axis=0)
    v[1::2, 2] = 0.05
    faces = []
    for i in range(n - 1):
        a, b = 2 * i, 2 * i + 1
        faces += [[a, b, a + 2], [b, b + 2, a + 2]]
    return v, np.array(faces, dtype=np.int64)


def test_an_arm_beside_the_chest_is_far_away_along_the_surface():
    _needs_scipy()
    """The case that broke: an arm hanging beside a torso, JOINED at the top.

    Joined matters. Two separate shells have no path between them at all, and
    the code correctly falls back to the straight line there rather than calling
    the distance infinite — a character is one connected surface, and the point
    is that the path from chest to arm is LONG (up over the shoulder and back
    down), not that it is missing.
    """
    torso, f1 = _strip(20, 0.0, 0.0, 1.0)
    arm, f2 = _strip(20, 0.06, 0.0, 1.0)
    verts = np.concatenate([torso, arm])
    faces = [f1, f2 + len(torso)]
    # Weld the two tops together — the shoulder.
    a_top, b_top = len(torso) - 2, len(torso) - 1
    c_top, d_top = len(verts) - 2, len(verts) - 1
    faces.append(np.array([[a_top, b_top, c_top], [b_top, d_top, c_top]], dtype=np.int64))
    faces = np.concatenate(faces)

    d = np.stack(
        [
            np.linalg.norm(verts - np.array([0.0, 0.5, 0.0]), axis=1),
            np.linalg.norm(verts - np.array([0.06, 0.5, 0.0]), axis=1),
        ],
        axis=1,
    )
    # In a straight line a mid-torso vertex is nearly as close to the arm bone
    # as to its own — 6cm away — which is exactly how the chest ended up weighted
    # to the arm.
    torso_mid = len(torso) // 2
    assert d[torso_mid, 1] < 0.1

    geo = _geodesic_to_bones(verts, faces, d)
    assert geo is not None
    # Along the surface it has to go up to the shoulder and back down, so the
    # arm is now unambiguously the further of the two.
    assert geo[torso_mid, 1] > geo[torso_mid, 0] * 2
    assert geo[torso_mid, 1] > d[torso_mid, 1] * 3


def test_a_vertex_keeps_its_own_bone_closest():
    _needs_scipy()
    verts, faces = _strip(20, 0.0, 0.0, 1.0)
    d = np.stack(
        [
            np.linalg.norm(verts - np.array([0.0, 0.1, 0.0]), axis=1),
            np.linalg.norm(verts - np.array([0.0, 0.9, 0.0]), axis=1),
        ],
        axis=1,
    )
    geo = _geodesic_to_bones(verts, faces, d)
    assert geo is not None
    # Bottom of the strip stays nearest the bottom bone, top the top one.
    assert geo[0].argmin() == 0
    assert geo[-1].argmin() == 1


def test_smoothing_softens_a_cliff_without_moving_the_regions():
    """A hard handover between bones is a crack once they move apart."""
    verts, faces = _strip(20, 0.0, 0.0, 1.0)
    n = len(verts)
    w = np.zeros((n, 2))
    w[: n // 2, 0] = 1.0
    w[n // 2 :, 1] = 1.0

    out = _smooth_weights(w.copy(), faces, n)
    assert np.allclose(out.sum(axis=1), 1.0)
    # The two ends still belong to their own bone...
    assert out[0, 0] > 0.9
    assert out[-1, 1] > 0.9
    # ...but the boundary is now a ramp rather than a step.
    mid = out[n // 2 - 1 : n // 2 + 1]
    assert mid.min() > 0.01, "the handover is still a cliff"


def test_a_mesh_with_no_edges_falls_back_rather_than_failing():
    verts = np.zeros((3, 3))
    assert _geodesic_to_bones(verts, np.zeros((0, 3), dtype=np.int64), np.zeros((3, 2))) is None
