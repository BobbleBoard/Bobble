"""An arm chain must follow the arms the MESH has, not the one a T-pose assumes.

The joint heights in `fit_skeleton` are fractions of stature taken from a figure
standing in a T: shoulders at 0.80, hands at 0.785, the whole chain laid out
along X. `probe_humanoid` already measures whether the mesh actually reaches
wide up there and says so when it does not — the astronaut sample scores
armSpanRatio 0.816, i.e. its upper body is NARROWER than its hips, with the
reason "no arm span detected at shoulder height" — and the fit went ahead and
placed a T-pose anyway. Both arms ended up drawn through the helmet while the
real arms carried no bones at all, and ARDY then swings a limb about a pivot
that is not in it.

The two figures below are the two cases that must not be confused: one with its
arms out, one with its arms down and an oversized head. Neither needs a mesh
file — a point cloud is all the fit reads.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))

from _humanoid import _arm_columns, _neck_frac, fit_skeleton  # noqa: E402

RNG = np.random.default_rng(7)


def _box(x0, x1, y0, y1, z0, z1, n=4000):
    return np.stack(
        [RNG.uniform(x0, x1, n), RNG.uniform(y0, y1, n), RNG.uniform(z0, z1, n)], axis=1
    )


def _legs_and_torso():
    """Shared lower body: two leg columns under a torso, 0 to 0.6 tall."""
    return np.concatenate(
        [
            _box(-0.16, -0.04, 0.0, 0.30, -0.08, 0.08),  # right leg
            _box(0.04, 0.16, 0.0, 0.30, -0.08, 0.08),  # left leg
            _box(-0.18, 0.18, 0.30, 0.62, -0.10, 0.10),  # torso
        ]
    )


def _tpose_figure():
    """Arms straight out at shoulder height, ordinary head."""
    return np.concatenate(
        [
            _legs_and_torso(),
            _box(-0.60, 0.60, 0.56, 0.63, -0.06, 0.06),  # the outstretched arms
            _box(-0.09, 0.09, 0.62, 0.70, -0.09, 0.09),  # neck + head
            _box(-0.13, 0.13, 0.70, 0.86, -0.12, 0.12),
        ]
    )


def _arms_down_figure():
    """Arms at the sides and a head far wider than the shoulders — a helmet.

    The arms touch the torso along the upper arm and only clear it lower down,
    which is what the real astronaut sample does; the detector has to work off
    the part that DOES separate.
    """
    return np.concatenate(
        [
            _legs_and_torso(),
            _box(-0.30, -0.20, 0.30, 0.50, -0.07, 0.07),  # right forearm + hand
            _box(0.20, 0.30, 0.30, 0.50, -0.07, 0.07),  # left forearm + hand
            _box(-0.26, 0.26, 0.50, 0.60, -0.09, 0.09),  # upper arms, merged in
            _box(-0.10, 0.10, 0.62, 0.68, -0.10, 0.10),  # the narrow neck
            _box(-0.30, 0.30, 0.68, 1.00, -0.28, 0.28),  # the helmet
        ]
    )


def test_a_figure_with_its_arms_out_keeps_the_tpose_chain():
    j = fit_skeleton(_tpose_figure())
    # Out along X, level in Y: that is what "T-pose" means for the chain.
    assert j["LeftHand"][0] > j["LeftArm"][0] > j["LeftShoulder"][0]
    assert abs(j["LeftHand"][1] - j["LeftShoulder"][1]) < 0.08


def test_arms_down_is_detected_only_when_the_mesh_splits_in_three():
    down = _arms_down_figure()
    lo = down.min(axis=0)
    height = float(down[:, 1].max() - lo[1])
    assert _arm_columns(down, lo, height, float(np.ptp(down[:, 0]))) is not None

    up = _tpose_figure()
    lo = up.min(axis=0)
    height = float(up[:, 1].max() - lo[1])
    assert _arm_columns(up, lo, height, float(np.ptp(up[:, 0]))) is None


def test_a_figure_with_its_arms_down_gets_a_chain_that_descends():
    j = fit_skeleton(_arms_down_figure())
    assert j["LeftShoulder"][1] > j["LeftForeArm"][1] > j["LeftHand"][1]
    assert j["RightShoulder"][1] > j["RightForeArm"][1] > j["RightHand"][1]
    # A REAL descent, not the 0.015-of-stature dip the T-pose chain also has:
    # without this the assertion above passes on exactly the bug it is here for.
    assert j["LeftShoulder"][1] - j["LeftHand"][1] > 0.15
    # ...and it is on the arm, not folded into the middle of the body.
    assert j["LeftHand"][0] > 0.12
    assert j["RightHand"][0] < -0.12


def test_the_shoulders_stay_out_of_an_oversized_head():
    verts = _arms_down_figure()
    # The helmet starts at y=0.68 of a 1.0-tall figure. Anthropometry would put
    # the shoulders at 0.80 — well inside it.
    j = fit_skeleton(verts)
    assert j["LeftShoulder"][1] < 0.68
    assert j["RightShoulder"][1] < 0.68


def test_the_neck_is_found_where_the_body_is_narrowest_under_the_head():
    verts = _arms_down_figure()
    lo = verts.min(axis=0)
    height = float(verts[:, 1].max() - lo[1])
    frac = _neck_frac(verts, lo, height)
    assert frac is not None
    assert 0.60 < frac < 0.70


def test_a_headless_body_has_no_neck_to_find():
    """No head above the waist means the anthropometric default must stand."""
    verts = _legs_and_torso()
    lo = verts.min(axis=0)
    height = float(verts[:, 1].max() - lo[1])
    assert _neck_frac(verts, lo, height) is None
