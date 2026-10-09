"""The skinned GLB writer must put the texture on the right way up.

The user (2026-09-18), on a rigged model in the chat: "what's with this
artifacting". MEASURED: a clean bake (385fa85ad18b/model.glb) rigged into a
rigged.glb with identical positions, indices and texture bytes — and
`TEXCOORD_0 == (u, 1 - v)` of the source. glTF's texture origin is the top
left; trimesh keeps `visual.uv` bottom-left and flips V inside its own
exporter, which `write_skinned_glb` bypasses. On a TRELLIS atlas (a chart per
triangle) an upside-down texture does not look upside down — every triangle
lands on another triangle's chart, and the body reads as grey mottle. The
retopo worker (trimesh's exporter) was clean the whole time.

Pinned against trimesh's own exporter: the same mesh written both ways must
carry the same TEXCOORD_0.
"""

from __future__ import annotations

import importlib.util
import json
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

from _skip import Skip

WORKERS = Path(__file__).resolve().parents[1] / "workers"


def _needs(*modules: str):
    for name in modules:
        if importlib.util.find_spec(name) is None:
            raise Skip(f"{name} is not installed in this interpreter")


def _glbskin():
    sys.path.insert(0, str(WORKERS))
    spec = importlib.util.spec_from_file_location("_glbskin", WORKERS / "_glbskin.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_texcoords(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    clen, ctype = struct.unpack_from("<II", raw, 12)
    assert ctype == 0x4E4F534A
    gltf = json.loads(raw[20 : 20 + clen])
    blen = struct.unpack_from("<I", raw, 20 + clen)[0]
    bin_ = raw[28 + clen : 28 + clen + blen]
    prim = gltf["meshes"][0]["primitives"][0]
    acc = gltf["accessors"][prim["attributes"]["TEXCOORD_0"]]
    view = gltf["bufferViews"][acc["bufferView"]]
    off = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return np.frombuffer(bin_, dtype=np.float32, count=acc["count"] * 2, offset=off).reshape(-1, 2)


def test_skinned_writer_agrees_with_trimesh_on_v() -> None:
    _needs("trimesh", "PIL")
    import trimesh
    from PIL import Image

    glbskin = _glbskin()
    # A textured quad, two triangles, UVs off-centre so a flip is unmistakable.
    vertices = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float32)
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    uv = np.array([[0.1, 0.2], [0.9, 0.2], [0.9, 0.7], [0.1, 0.7]], dtype=np.float32)
    image = Image.new("RGBA", (8, 8), (200, 120, 40, 255))
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, image=image)

    with tempfile.TemporaryDirectory() as tmp:
        reference = Path(tmp) / "trimesh.glb"
        mesh.export(str(reference))
        ours = Path(tmp) / "skinned.glb"
        normals = np.tile(np.array([[0, 0, 1]], dtype=np.float32), (4, 1))
        glbskin.write_skinned_glb(
            str(ours),
            vertices,
            faces,
            normals,
            ["root"],
            {"root": None},
            {"root": np.zeros(3, dtype=np.float64)},
            np.zeros((4, 4), dtype=np.uint16),
            np.tile(np.array([[1, 0, 0, 0]], dtype=np.float32), (4, 1)),
            uv=uv,
            base_color_png=None,
        )
        theirs = _read_texcoords(reference)
        mine = _read_texcoords(ours)
    assert np.allclose(mine, theirs, atol=1e-6), (
        f"TEXCOORD_0 differs from trimesh's export:\n ours {mine.tolist()}\n trimesh {theirs.tolist()}"
    )
    # …and it IS the flip: trimesh's V is 1 - the bottom-left V it was given.
    assert np.allclose(theirs[:, 1], 1.0 - uv[:, 1], atol=1e-6)
