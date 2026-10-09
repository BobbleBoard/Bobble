"""How many quads to ask QuadriFlow for — and why a fixed number was wrong.

The user, looking at a retopologised car: "does quadriflow usually destroy quality
like that? it seemed like it did on that example, look closer?"

It did, and it was not QuadriFlow. Same binary, same input OBJ, only `-f`
changed:

    -f  20000  ->  17,633 quads, 14s — the door mirror comes out as a spray of
                   loose shards, the rocker and wheel arch are torn. The CLAY
                   render shows all of it, so it is the geometry, not the bake.
    -f  60000  ->  52,169 quads, 30s — mirror is one coherent solid, smooth.
    -f 120000  -> 106,130 quads, 85s.

The default was 20,000 against a 300,000-face input: a 17x reduction in a single
step, which a stair-stepped marching-cubes surface does not survive. The lever
is the target, not the solver — `-sharp` and `-mcf`, the flags that look like
the answer, both ran past 420s on this input and were killed, against 14s plain.

These tests read the source rather than importing it: retopo_worker pulls in
trimesh at module scope, which lives in the meshtools venv and not in whatever
interpreter runs the suite.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "workers" / "retopo_worker.py").read_text(
    encoding="utf-8"
)


def _target(in_faces: int) -> int:
    """Re-implement adaptive_target_quads from the constants in the source."""
    per = eval(re.search(r"QUADS_PER_INPUT_FACE = (.+)", SRC).group(1))  # noqa: S307
    lo = int(re.search(r"MIN_ADAPTIVE_QUADS = ([\d_]+)", SRC).group(1).replace("_", ""))
    hi = int(re.search(r"MAX_ADAPTIVE_QUADS = ([\d_]+)", SRC).group(1).replace("_", ""))
    return int(min(hi, max(lo, in_faces * per)))


def test_a_trellis_sized_input_asks_for_far_more_than_the_old_default():
    # 300,000 faces is what the bake budget hands on, and 20,000 shattered it.
    assert _target(300_000) >= 45_000


def test_the_reduction_stays_under_the_ratio_that_shattered():
    for faces in (120_000, 300_000, 600_000):
        assert faces / _target(faces) <= 8, f"{faces} reduces too hard"


def test_a_small_model_is_not_inflated():
    assert _target(5_000) == _target(1)


def test_a_huge_model_is_capped():
    assert _target(50_000_000) == _target(10_000_000)


def test_the_default_defers_to_the_worker_rather_than_pinning_a_number():
    # 0 means "size it from the input"; a literal default here is what made the
    # adaptive path unreachable for every run that did not come from the UI.
    assert re.search(r'"--target-quads", type=int, default=0', SRC) is not None


def test_the_engine_does_not_override_the_adaptive_default():
    jobs = (Path(__file__).resolve().parents[1] / "engine" / "jobs.py").read_text(
        encoding="utf-8"
    )
    assert 'options.get("targetQuads") or 0' in jobs
