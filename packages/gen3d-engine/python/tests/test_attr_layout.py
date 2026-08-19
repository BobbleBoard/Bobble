"""voxels.npz stores the attribute layout as TEXT; something has to read it back.

`save_voxels` writes `np.asarray(str(mesh_out.layout))` because an npz saved
with allow_pickle=False cannot hold a dict of slices. Nothing parsed it, so a
volume loaded from disk carried a layout of type `str`, and the reference
o_voxel bake — which indexes it as a mapping — died with

    base_color = np.clip(attrs_full[..., attr_layout['base_color']]…)
    TypeError: string indices must be integers, not 'str'

on every Texture-stage re-bake. It looked like the memory failures its opt-in
switch documents, because the stage catches it, falls back to the KDTree baker
and finishes: nothing said the reference path had never been reached.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "workers" / "trellis_worker.py").read_text(
    encoding="utf-8"
)

SAVED = (
    "{'base_color': slice(0, 3, None), 'metallic': slice(3, 4, None), "
    "'roughness': slice(4, 5, None), 'alpha': slice(5, 6, None)}"
)


def _parse(text):
    """The function's body, lifted so this runs on a bare interpreter."""
    if isinstance(text, dict):
        return text
    out = {}
    for name, start, stop in re.findall(r"'(\w+)':\s*slice\((\d+),\s*(\d+)", str(text)):
        out[name] = slice(int(start), int(stop))
    return out


def test_a_saved_layout_reads_back_as_slices():
    got = _parse(SAVED)
    assert got["base_color"] == slice(0, 3)
    assert got["metallic"] == slice(3, 4)
    assert got["roughness"] == slice(4, 5)
    assert got["alpha"] == slice(5, 6)


def test_a_live_layout_passes_through_untouched():
    live = {"base_color": slice(0, 3)}
    assert _parse(live) is live


def test_the_loader_actually_calls_the_parser():
    assert 'layout=parse_attr_layout(str(z["layout"]))' in SRC


def test_an_unreadable_layout_is_refused_rather_than_returned_empty():
    # An empty dict would fail later, inside the bake, as a KeyError with no
    # trace back to the file that was actually malformed.
    assert 'raise ValueError(f"unreadable attr layout' in SRC
