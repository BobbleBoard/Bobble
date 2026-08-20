"""Build the neutral mannequin used to verify rigs and preset poses.

Not a test — a tool. `python tests/make_mannequin.py /tmp/mannequin.glb`

WHY A PURPOSE-BUILT SUBJECT. Verifying a pose needs a figure whose proportions
are not themselves the problem. The astronaut everything was first checked on
has a helmet nearly as wide as its shoulders and short arms, so any raised-arm
pose puts the hand inside the head — it reads as broken whatever the rig does,
and it sent several rounds of work chasing a fault that was the character.

It also has to be ONE WATERTIGHT SHELL. A figure assembled from separate
interpenetrating capsules has no connected surface at the shoulder, so the
geodesic skin weighting finds no path, falls back to straight-line distance and
tears at every joint — the exact defect the geodesic pass exists to remove. So
this evaluates a signed-distance union of capsules on a grid and marching-cubes
it, which is one shell by construction and is also what a generated model looks
like to the rigger.
"""

import sys

import numpy as np
import trimesh
from skimage import measure

# (start, end, radius) in a 1.0-tall figure, arms hanging at the sides.
CAPSULES = [
    ([0, 0.52, 0], [0, 0.82, 0], 0.105),        # torso
    ([0, 0.80, 0], [0, 0.88, 0], 0.058),        # neck
    ([0, 0.88, 0], [0, 0.95, 0], 0.078),        # head
    ([0.10, 0.80, 0], [0.155, 0.66, 0], 0.042),
    ([0.155, 0.66, 0], [0.175, 0.50, 0], 0.036),
    ([0.175, 0.50, 0], [0.18, 0.44, 0], 0.040),
    ([-0.10, 0.80, 0], [-0.155, 0.66, 0], 0.042),
    ([-0.155, 0.66, 0], [-0.175, 0.50, 0], 0.036),
    ([-0.175, 0.50, 0], [-0.18, 0.44, 0], 0.040),
    ([0.055, 0.54, 0], [0.06, 0.27, 0], 0.055),
    ([0.06, 0.27, 0], [0.062, 0.04, 0], 0.045),
    ([0.062, 0.05, 0], [0.062, 0.03, 0.07], 0.042),
    ([-0.055, 0.54, 0], [-0.06, 0.27, 0], 0.055),
    ([-0.06, 0.27, 0], [-0.062, 0.04, 0], 0.045),
    ([-0.062, 0.05, 0], [-0.062, 0.03, 0.07], 0.042),
]


def _segment_distance(points, a, b):
    a, b = np.array(a, float), np.array(b, float)
    ab = b - a
    t = np.clip(((points - a) @ ab) / (ab @ ab), 0.0, 1.0)[:, None]
    return np.linalg.norm(points - (a + t * ab), axis=1)


def build(n: int = 160) -> trimesh.Trimesh:
    xs = np.linspace(-0.30, 0.30, n)
    ys = np.linspace(-0.05, 1.02, int(n * 1.8))
    zs = np.linspace(-0.16, 0.16, int(n * 0.55))
    grid = np.stack(np.meshgrid(xs, ys, zs, indexing="ij"), axis=-1)
    pts = grid.reshape(-1, 3)
    sdf = np.full(len(pts), 1e9)
    for a, b, r in CAPSULES:
        sdf = np.minimum(sdf, _segment_distance(pts, a, b) - r)

    verts, faces, _n, _v = measure.marching_cubes(sdf.reshape(grid.shape[:3]), level=0.0)
    verts = np.stack(
        [
            xs[0] + verts[:, 0] * (xs[1] - xs[0]),
            ys[0] + verts[:, 1] * (ys[1] - ys[0]),
            zs[0] + verts[:, 2] * (zs[1] - zs[0]),
        ],
        axis=1,
    )
    mesh = trimesh.Trimesh(verts, faces, process=True)
    mesh.merge_vertices()
    mesh = max(mesh.split(only_watertight=False), key=lambda c: len(c.vertices))
    trimesh.smoothing.filter_taubin(mesh, iterations=6)
    return mesh


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mannequin.glb"
    m = build()
    m.export(out)
    print(f"{out}: {len(m.vertices):,} verts {len(m.faces):,} faces")
