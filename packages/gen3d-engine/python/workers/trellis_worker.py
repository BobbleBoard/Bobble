"""TRELLIS.2 worker — image → 3D geometry (+ native PBR texture) on MPS.

Runs inside the trellis-mac venv with cwd = the trellis-mac checkout (jobs.py
guarantees both). The generation/bake flow is adapted from trellis-mac's
generate.py (MIT); the differences are the NDJSON progress protocol, the
geometry-FIRST artifact push (untextured GLB the moment vertices exist, while
texturing continues), and `--no-texture` collapsing the tex-SLAT sampling to a
single step (upstream run() has no skip flag; one step costs ~nothing and the
result is discarded).

Stage identities on stdout: 'geometry' until the untextured GLB is emitted,
then 'texture' for tex sampling + baking.
"""

from __future__ import annotations

import argparse
import json
import gc
import os
import sys
import time
from pathlib import Path
from typing import NamedTuple

# --- backend env BEFORE torch/trellis imports (mirrors trellis-mac) ---------
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
# LET A BIG JOB FINISH INSTEAD OF FAILING AT THE CAP.
#
# MPS refuses an allocation that would take the process past a fraction of the
# machine's "recommended working set", and on unified memory that cap sits well
# below what the Mac can actually provide — so a mesh whose surface fills more
# voxels than the cap allows died with "MPS backend out of memory" partway
# through, having already spent minutes. MEASURED on the astronaut: 774,044
# voxels at 512³ hit the wall on a 24 GB Mac, and with the cap lifted the same
# job completed in 112s.
#
# Removing the cap does not make a job that already fits use any more memory —
# it only stops the allocator refusing one that would have to lean on swap. This
# is a per-job subprocess, so the blast radius is the job.
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")

TRELLIS_ROOT = Path.cwd()  # jobs.py sets cwd to the geometry checkout
sys.path.insert(0, str(TRELLIS_ROOT / "TRELLIS.2"))
sys.path.insert(0, str(TRELLIS_ROOT))  # backends/ package (texture baker)
sys.path.append(str(TRELLIS_ROOT / "stubs"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# The TEXTURE baker lives in the trellis-mac checkout (`backends/`), which the
# MLX checkout does not carry. When geometry runs from the MLX tree the cwd is
# trellis2-apple, so `from backends.texture_baker import …` failed with
# "No module named 'backends'" and texturing died AFTER the mesh was built.
# Add the sibling checkout so both trees' modules resolve regardless of which
# one geometry came from.
_SIBLING_TRELLIS = TRELLIS_ROOT.parent / "trellis-mac"
if _SIBLING_TRELLIS != TRELLIS_ROOT and (_SIBLING_TRELLIS / "backends").is_dir():
    sys.path.append(str(_SIBLING_TRELLIS))
    sys.path.append(str(_SIBLING_TRELLIS / "stubs"))

from _device import empty_cache, pick_device  # noqa: E402
from _progress import ROUTER, artifact, emit, patch_tqdm, progress, stage_done  # noqa: E402

try:
    import flex_gemm  # noqa: F401

    os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")
except (ImportError, RuntimeError):
    # "pytorch", NOT "none". There is no conv_none module in the checkout, so
    # `none` is not a fallback at all — it is an import error deferred until the
    # first model that actually builds a SparseConv3d. Nothing at 512 does, so
    # this looked fine for as long as 512 was the only resolution anyone ran;
    # the 1024 shape decoder builds one immediately and died with
    #     ModuleNotFoundError: No module named 'trellis2.modules.sparse.conv.conv_none'
    # which the pipeline loader then re-raised as a 404 for a HuggingFace repo
    # called "ckpts/shape_dec_next_dc_f16c32_fp16" — so the one resolution that
    # would not run reported itself as a missing download.
    #
    # The checkout's own __detect_defaults() picks 'pytorch' on Darwin when its
    # flex_gemm MPS probe fails, and conv_pytorch.py is right there beside the
    # others. This just stops overriding that with a value it cannot honour.
    os.environ.setdefault("SPARSE_CONV_BACKEND", "pytorch")

patch_tqdm()
ROUTER.default_stage = "geometry"
# All three samplers run BEFORE any mesh exists, so all three are the geometry
# stage — routing "texture slat" to the texture stage lit the Modeled chunk
# green ~7s before the model appeared in the viewport. The spans lay the loops
# end to end so the geometry bar climbs 0→100 once instead of three times.
ROUTER.desc_map = {
    "sparse structure": ("geometry", "Sampling sparse structure", (0.0, 0.34)),
    "shape slat": ("geometry", "Sampling shape latents", (0.34, 0.67)),
    "texture slat": ("geometry", "Sampling texture latents", (0.67, 1.0)),
}

class WorkerFailure(Exception):
    """A failure whose `error` event has ALREADY been emitted.

    Lets `run_one` fail without deciding how the process should end: the
    one-shot path exits non-zero (jobs.py turns that into a job error), while a
    `--serve` worker stays alive so the next job doesn't re-pay the model load.
    """


WATCHDOG_SIGNATURES = ("non-zero size", "BVH needs at least 8 triangles")
WATCHDOG_HELP = (
    "The Metal GPU watchdog killed a long-running kernel (empty mesh). "
    "Try a lower resolution, or retry with fewer windows/displays active."
)


# What the VIEWER is handed for the geometry-first push. The raw marching-cubes
# mesh is not a preview: a measured 1024_cascade run produced 14,264,186
# triangles / 256 MB, and pushing that at the renderer wedged the window for
# minutes (the user's "the app freezes completely"). The full-resolution file is
# still written and is still what downstream stages consume — only what gets
# DISPLAYED is capped.
PREVIEW_FACE_BUDGET = 240_000


# Fraction of the mesh's faces below which a connected component is treated as
# debris rather than a part of the model. 0.1% of a 3M-face mesh is ~3k faces;
# real parts are far bigger, specks far smaller.
DEBRIS_FACE_FRACTION = 0.001


def drop_debris(tm, label: str):
    """Remove disconnected speck components from a generated mesh.

    MEASURED on a 512 tank run: `geometry.glb` came back as **10,981 connected
    components** with the largest holding only 77% of the faces — i.e. a mostly
    correct model surrounded by ~11k floaters. That debris is what made the
    viewport look like confetti, and it is far worse after decimation, which
    spends its face budget on the specks and shatters the main body (the preview
    measured 20,257 components, largest just 27.7%).

    So drop components below {@link DEBRIS_FACE_FRACTION} of the total. The
    threshold is deliberately tiny — real multi-part models (a turret, separate
    treads) are orders of magnitude larger than a speck, so they survive. Returns
    the mesh unchanged if anything goes wrong: cleanup must never fail a run.
    """
    try:
        comps = tm.split(only_watertight=False)
    except Exception:  # noqa: BLE001
        return tm
    if len(comps) <= 1:
        return tm
    import trimesh as _tm

    total = max(1, len(tm.faces))
    keep = [c for c in comps if len(c.faces) >= total * DEBRIS_FACE_FRACTION]
    if not keep:  # everything looked like debris — keep the biggest component
        keep = [max(comps, key=lambda c: len(c.faces))]
    if len(keep) == len(comps):
        return tm
    merged = _tm.util.concatenate(keep)
    # Report under whatever stage is running — hardcoding "geometry" pulled the
    # UI back to the Modeling chunk for the whole texture bake.
    progress(
        ROUTER.default_stage,
        f"Cleaned {label} — dropped {len(comps) - len(keep):,} stray fragments "
        f"({len(tm.faces) - len(merged.faces):,} faces)",
    )
    return merged


def weld_and_clean(mesh_out, label: str):
    """Weld the raw TRELLIS mesh and strip its debris, ONCE per generation.

    Everything downstream needs this first, for two reasons that share one fix:

      * The raw mesh carries render-duplicated vertices, so its triangles do not
        share vertices and quadric decimation cannot collapse an edge between
        them — it shreds the surface into islands instead of simplifying it.
      * Even welded, the mesh arrives with thousands of stray specks that eat
        the decimator's face budget and speckle the result.

    MEASURED on an F-22 through the real UI, counting components by POSITION
    (a textured mesh is duplicated at every UV seam, so trimesh's default merge
    reports the atlas charts rather than the geometry): the textured model went
    from **5,033 components / largest 92.3%** to **817 / 98.0%** once the bake
    ran on a welded, de-specked mesh — that 7.7% of loose faces is the black
    speckle over the wings.

    Returns arrays in TRELLIS's ORIGINAL frame: the texture bake samples
    voxel-space coords/attrs and must not see the Y-up rotation, which each
    exporter applies for itself.
    """
    import numpy as np
    import trimesh

    tm = trimesh.Trimesh(
        vertices=mesh_out.vertices.cpu().numpy(),
        faces=mesh_out.faces.cpu().numpy(),
        process=False,
    )
    tm.merge_vertices()
    tm = drop_debris(tm, label)
    return np.asarray(tm.vertices), np.asarray(tm.faces)


def to_gltf_up(verts):
    """TRELLIS emits Z-up; glTF is Y-up by spec. Convert (x,y,z) → (x, z, -y).

    The user: "why is the plane on its nose… it seems suspiciously perfect 90
    degrees… are you sure it generates Y up as opposed to z up". The user was right,
    and it is not model-side. MEASURED on a tank, identical on BOTH backends
    (so it is TRELLIS's convention, not ours): extents X=0.516 Y=1.000 Z=0.603
    — the vehicle's LENGTH lay along Y, and a Y-up viewer therefore stood it on
    its nose. After the conversion: X=0.516 Y=0.603 Z=1.000, i.e. length along
    Z and height along Y, and the render sits flat on its tracks.
    """
    import numpy as np

    v = np.asarray(verts)
    return np.column_stack([v[:, 0], v[:, 2], -v[:, 1]])


def from_gltf_up(verts):
    """Inverse of to_gltf_up: (x, y, z) → (x, -z, y).

    A mesh read back from one of our GLBs is Y-up, but the voxel volume the
    colours are sampled from is in TRELLIS's original frame, so a standalone
    bake has to go back before it can sample.
    """
    import numpy as np

    v = np.asarray(verts)
    return np.column_stack([v[:, 0], -v[:, 2], v[:, 1]])


def save_voxels(mesh_out, out_path: Path) -> None:
    """Persist the voxel colour volume beside the mesh.

    This is what lets the Texture stage run on its own — re-baking an edited or
    retopologised mesh without regenerating it, and without a second 11.4 GB
    texture model on disk (the user: "if trellis bundles a texturing model that can
    do good pbr and such, can you just utilize that instead of a separate
    hunyuan paint please"). The baker samples by POSITION, so any mesh in the
    same frame can be textured from this — which is exactly what retopo → texture
    needs. Stored as fp16: it is a colour field, and half the bytes.
    """
    import numpy as np

    try:
        np.savez_compressed(
            out_path,
            coords=mesh_out.coords.cpu().numpy().astype(np.int32),
            attrs=mesh_out.attrs.cpu().numpy().astype(np.float16),
            origin=mesh_out.origin.cpu().numpy().astype(np.float32),
            voxel_size=np.asarray(mesh_out.voxel_size, dtype=np.float32),
            layout=np.asarray(str(mesh_out.layout)),
        )
    except Exception as err:  # noqa: BLE001 — a missing sidecar is not a failed run
        progress("texture", f"could not save voxel colours for re-texturing ({err})")


def export_untextured_glb(verts, faces, out_path: Path) -> tuple[int, int]:
    """Write the full-resolution geometry, rotated into glTF's Y-up."""
    import trimesh

    tm = trimesh.Trimesh(vertices=to_gltf_up(verts), faces=faces, process=False)
    tm.export(str(out_path))
    # Report what was actually WRITTEN, not the pre-weld input: the raw vertex
    # count is inflated by the duplicates weld_and_clean merged away.
    return int(len(tm.vertices)), int(len(tm.faces))


def export_preview_glb(verts, faces, out_path: Path, full_faces: int) -> Path | None:
    """A viewer-sized copy of the geometry. Returns None when the full mesh is
    already small enough to display directly.

    Takes the ALREADY welded + de-specked mesh, which is what makes decimation
    work at all: on a raw mesh the triangles do not share vertices, so quadric
    decimation cannot collapse an edge between two of them and shreds the
    surface into islands instead of simplifying it (measured on an icosphere
    re-emitted unwelded: 1,029 disconnected bodies at 2,048 faces, versus 1
    welded — the same face count, but confetti instead of a model). That
    confetti is what the viewer used to show, and the user read it as the model
    itself: "the model is capable of much higher quality results, something is
    going wrong at inference" — it was the preview, not inference.
    """
    if full_faces <= PREVIEW_FACE_BUDGET:
        return None
    import trimesh

    try:
        tm = trimesh.Trimesh(vertices=to_gltf_up(verts), faces=faces, process=False)
        reduced = tm.simplify_quadric_decimation(face_count=PREVIEW_FACE_BUDGET)
        # Decimation detaches a few new slivers of its own (measured: 660
        # components / 1.7% of faces on an already-clean input) — sweep again.
        reduced = drop_debris(reduced, "preview")
        reduced.export(str(out_path))
        progress(
            "geometry",
            f"Preview ready — {len(reduced.faces):,} of {full_faces:,} triangles",
        )
        return out_path
    except Exception as err:  # noqa: BLE001 — a preview must never fail the run
        progress("geometry", f"preview simplification unavailable ({err})")
        return None


# A TRELLIS surface is stair-stepped voxel faces, so adjacent triangles differ
# by ~90° and xatlas splits a chart at nearly every edge — the atlas ends up as
# tens of thousands of tiny islands rather than a few big ones. Each island then
# needs its own padding, so the texel budget has to be counted PER FACE.
#
# MEASURED at 1024px on a 200k-face helicopter: 1,048,576 texels / 200,000 faces
# = 5 texels per face, i.e. ~2x2 including padding. The extracted atlas was
# almost entirely seam bleed, which is what the user saw as "texturing is completely
# messed up" — the bake was right, the sheet was far too small to hold it.
MIN_TEXELS_PER_FACE = 64

# Triangles handed to the baker, when the caller does not say.
#
# This was 65,000, chosen as "exactly what a 2048 atlas holds at 64 texels per
# face" — which optimised the atlas and quietly capped the MODEL. The user hit it
# from the other end: every generation came back at exactly 65,000 faces and
# visibly softer than the HF demo, whose decimation target defaults to 300,000
# and which returned 288,000 for the same input image. A budget that is always
# the binding constraint is not a budget, it is a hidden resolution setting.
#
# 300,000 matches the reference. At 4096² that is ~56 texels/face, just under
# the 64 target, so atlas_size_for lands on 4096 and the extra detail is real
# rather than smeared. The cost is what the old comment recorded for 200k/4096:
# minutes rather than seconds, and a GLB in the tens of MB. That is the right
# default for a tool whose output is the deliverable, and the UI's Face limit
# control now actually reaches this (it did not before — see jobs.py), so the
# cheap-and-soft end of the trade is one click away instead of mandatory.
BAKE_FACE_BUDGET = 300_000

#: Faces handed to the texturing pipeline's shape ENCODER. Far below the bake
#: budget on purpose — see texture_from_image for the measurement.
ENCODE_FACE_BUDGET = 150_000

# The Metal baker (o_voxel + mtldiffrast) does not survive real volumes on this
# machine: MEASURED three times on a 1.28M-voxel helicopter it failed every
# time — twice with an allocation error ("Invalid buffer size: 14.75 GiB", then
# "MPS backend out of memory … tried to allocate 6.69 GiB") and once by dying
# outright at 4096px, leaving no file and no error. The KDTree baker produces
# the same channels, is verified correct, and cannot take the process with it,
# so it is the default. Set PI_GEN3D_METAL_BAKE=1 to try Metal first.
METAL_BAKE = os.environ.get("PI_GEN3D_METAL_BAKE", "0") == "1"

STAGE_TEXTURE = "texture"


def undo_baker_gamma(base_color_img):
    """Cancel the linear->sRGB conversion the KDTree baker applies.

    TRELLIS's voxel base_color attribute is ALREADY display-referred. The
    reference pipeline — o_voxel.postprocess.to_glb, which is what the HF demo
    runs — writes it straight out:

        base_color = np.clip(attrs[..., base_color] * 255, 0, 255).astype(uint8)

    trellis-mac's KDTree baker instead does `np.power(base_color, 1/2.2)` before
    quantising (backends/texture_baker.py). That is a second gamma on top of the
    one already baked in, and it only lifts values — 0.20 -> 0.48, 0.50 -> 0.73 —
    so every colour drifts toward white and loses saturation. It is why our
    output looked washed out beside the demo's saturated blues and golds.

    The baker is upstream (a git checkout we provision, not our file), so this
    inverts it here rather than editing a dependency that re-provisioning would
    overwrite. Exact inverse, applied to the uint8 the baker hands back.
    """
    import numpy as np

    linear = (base_color_img.astype(np.float32) / 255.0) ** 2.2
    return np.clip(linear * 255.0 + 0.5, 0, 255).astype(np.uint8)


def atlas_size_for(n_faces: int, requested: int) -> int:
    """The smallest power-of-two atlas that gives each face room to breathe."""
    import math

    need = math.sqrt(max(1, n_faces) * MIN_TEXELS_PER_FACE)
    size = 1 << math.ceil(math.log2(max(need, 1024.0)))
    # Never go BELOW what was asked for, and never past 4096 — beyond that the
    # PNGs cost more than the detail is worth at these mesh densities.
    return int(min(4096, max(requested, size)))


class VoxelVolume(NamedTuple):
    """The colour field a bake samples — from a live generation or from disk."""

    coords: object
    attrs: object
    origin: object
    voxel_size: float
    layout: object


def volume_of(mesh_out) -> VoxelVolume:
    return VoxelVolume(
        coords=mesh_out.coords.cpu(),
        attrs=mesh_out.attrs.cpu(),
        origin=mesh_out.origin.cpu(),
        voxel_size=mesh_out.voxel_size,
        layout=mesh_out.layout,
    )


def load_voxels(path: Path) -> VoxelVolume:
    """Read back a volume saved by save_voxels (see the Texture stage)."""
    import numpy as np
    import torch

    z = np.load(path, allow_pickle=False)
    return VoxelVolume(
        coords=torch.from_numpy(z["coords"]),
        attrs=torch.from_numpy(z["attrs"].astype(np.float32)),
        origin=torch.from_numpy(z["origin"]),
        voxel_size=float(z["voxel_size"]),
        layout=parse_attr_layout(str(z["layout"])),
    )



def parse_attr_layout(text: str) -> dict:
    """Turn the layout string saved in voxels.npz back into slices.

    `save_voxels` writes `np.asarray(str(mesh_out.layout))` because an npz saved
    with allow_pickle=False cannot hold a dict of slices. Nothing turned it back,
    so a volume READ FROM DISK carried a layout of type str — and the reference
    Metal bake indexes it as a mapping:

        base_color = np.clip(attrs_full[..., attr_layout['base_color']]…)
        TypeError: string indices must be integers, not 'str'

    which is why the o_voxel path failed on every Texture-stage re-bake. That
    failure is separate from the memory ones its opt-in switch documents, and it
    would have looked exactly like them from outside: the stage falls back to the
    KDTree baker and finishes, so nothing says the reference path was never
    reached.
    """
    import re

    if isinstance(text, dict):
        return text
    out: dict[str, slice] = {}
    for name, start, stop in re.findall(r"'(\w+)':\s*slice\((\d+),\s*(\d+)", str(text)):
        out[name] = slice(int(start), int(stop))
    if not out:
        raise ValueError(f"unreadable attr layout: {text!r}")
    return out


def dilate_atlas(img, valid, passes: int = 8):
    """Pad each UV island with its OWN colour, not a blur of the empty gutter.

    THE DARK-CRACKLE BUG. The user, on a textured generation: "texture wireframe
    artifacting" — every triangle edge carried a thin dark line, so the model
    looked cracked all over. The geometry is perfect (the clay render is clean),
    so it is entirely in the baked sheet.

    A TRELLIS surface is stair-stepped, so xatlas splits a chart at nearly every
    edge: the atlas is tens of thousands of tiny islands with 1-2 texel gutters
    between them. Bilinear filtering and mipmaps read slightly OUTSIDE a triangle
    at its border, so those gutter texels have to carry the island's colour.

    The upstream baker does try — it dilates 8 times and fills each new ring with
    `uniform_filter(channel, size=3)`. But that box blur averages over the ring's
    neighbourhood INCLUDING the texels that are still black, so the padding it
    writes comes out at a fraction of the island's brightness. The gutter ends up
    dark rather than unfilled, which is exactly the dark rim we see. (This also
    defeated the first version of this function: it was handed the baker's
    POST-padding mask, so it considered those dark texels already covered and
    left them alone.)

    So the fill here is a proper nearest-colour dilation seeded from the TRUE
    triangle coverage: only genuinely-covered texels vote, and each pass averages
    over covered neighbours ONLY. Vectorised with numpy shifts — a per-texel loop
    over 4096x4096 would take minutes.
    """
    import numpy as np

    out = img.astype(np.uint8, copy=True)
    covered = valid.astype(bool, copy=True)
    if covered.ndim == 3:
        covered = covered[..., 0]
    if not covered.any() or covered.all():
        return out

    # Everything outside the real coverage is unknown, whatever the baker left
    # there — that is the dark ring we are replacing.
    for _ in range(passes):
        holes = ~covered
        if not holes.any():
            break
        acc = np.zeros((*out.shape[:2], out.shape[2]), dtype=np.float32)
        cnt = np.zeros(out.shape[:2], dtype=np.float32)
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            nbr_c = np.roll(covered, shift, axis=axis)
            nbr_v = np.roll(out, shift, axis=axis)
            take = nbr_c & holes
            acc[take] += nbr_v[take].astype(np.float32)
            cnt[take] += 1.0
        fill = cnt > 0
        if not fill.any():
            break
        out[fill] = (acc[fill] / cnt[fill][:, None]).astype(np.uint8)
        covered |= fill
    return out


def uv_unwrap_padded(vertices, faces, size, padding=4):
    """Unwrap with a real GUTTER between charts, which xatlas will not do by default.

    trellis-mac calls `xatlas.parametrize(v, f)`, which takes the default
    PackOptions — and that default padding is ZERO. Charts are therefore packed
    edge to edge, so a chart of red paint can sit directly against a chart of
    black tyre or dark cabin. Any filtered fetch near that border mixes the two,
    which is what the dark specks scattered over the paint actually are: not
    noise in the field (measured: zero isolated dark voxels), not unsampled
    texels (measured: the baker's gate never fires), and not the far side of a
    thin panel (measured: rejecting behind-surface voxels moved the count by
    0.8%). Zoom the atlas to 1:1 and it is plain — angular chart-shaped black and
    grey patches abutting the red, with no gutter anywhere.

    Padding restores the gutter so `dilate_atlas` fills each chart's border with
    that chart's OWN colour, and a neighbour's colour is never within the filter
    footprint. `resolution` has to be set too, or padding is measured against an
    atlas size xatlas picked for itself rather than the one we are about to bake.
    """
    import numpy as np
    import xatlas

    atlas = xatlas.Atlas()
    atlas.add_mesh(
        np.ascontiguousarray(vertices.astype(np.float32)),
        np.ascontiguousarray(faces.astype(np.uint32)),
    )
    pack = xatlas.PackOptions()
    pack.padding = padding
    pack.resolution = int(size)
    pack.bilinear = True
    atlas.generate(pack_options=pack)
    vmapping, indices, uvs = atlas[0]
    return vertices[vmapping], indices.reshape(-1, 3), uvs, vmapping


def bake_atlas_front_facing(verts, faces, uvs, coords, attrs, origin, voxel_size, size):
    """Sample the voxel colour field into an atlas, from IN FRONT of the surface.

    THE CAUSE OF THE DARK SPECKS ON THE PAINT. trellis-mac's `bake_texture`
    takes the 8 nearest voxels to each texel and inverse-distance-weights them,
    with no notion of which SIDE of the surface they are on:

        distances, indices = tree.query(query_points, k=k_neighbors)
        weights = 1.0 / (distances + eps)
        weights[distances > voxel_size * 2.0] = 0.0

    A car's body panels are thin shells — red on the outside, dark cabin and
    wheel well on the inside — and at 512^3 the two surfaces are a voxel or two
    apart. So a texel on the bonnet reaches straight THROUGH the panel and
    averages in the darkness behind it, which is why the paint came out peppered
    with dark specks.

    Ruled out first, by measurement, so this is the cause rather than the next
    guess: the field is not noisy (ZERO of its 56,129 dark voxels sit isolated in
    a bright neighbourhood — they are coherent dark regions, i.e. real tyres and
    interiors); the texels are not unsampled (every covered texel has a voxel
    within the baker's own cut-off, so its `has_neighbor` gate never fires); and
    alpha cannot be used to mask them (uniformly 1.000 across every voxel).

    The fix is to give the sampler the one piece of information it was missing —
    the surface normal, interpolated per texel by rasterising the same triangles
    with vertex normals in place of positions — and drop any neighbour that lies
    behind the surface. A texel with nothing at all in front of it keeps the
    plain nearest voxel rather than going black.

    No gamma here on purpose: the attributes are already display-referred, which
    is what the reference `to_glb` relies on when it writes
    `clip(attrs * 255)` straight out. The baker's extra pow(1/2.2) is the reason
    a separate undo step existed.
    """
    import numpy as np
    import trimesh
    from scipy.spatial import cKDTree

    from backends.texture_baker import _rasterize_uv_triangles

    positions, cover = _rasterize_uv_triangles(verts, faces, uvs, size)
    vn = trimesh.Trimesh(vertices=verts, faces=faces, process=False).vertex_normals
    normals, _ = _rasterize_uv_triangles(np.asarray(vn, dtype=np.float32), faces, uvs, size)

    ys, xs = np.where(cover)
    base = np.zeros((size, size, 3), dtype=np.uint8)
    mr = np.zeros((size, size, 3), dtype=np.uint8)
    if len(ys) == 0:
        return base, mr, cover

    P = positions[ys, xs]
    N = normals[ys, xs]
    N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)

    voxel_world = coords.astype(np.float32) * voxel_size + origin + voxel_size * 0.5
    dist, idx = cKDTree(voxel_world).query(P, k=8, workers=-1)
    offs = voxel_world[idx] - P[:, None, :]
    ahead = np.einsum("mkc,mc->mk", offs, N)

    weights = 1.0 / (dist + voxel_size * 0.1)
    weights[dist > voxel_size * 3.0] = 0.0
    # BEHIND THE SURFACE — the other face of a thin panel. Half a voxel of slack
    # keeps the shell's own voxels, which straddle the surface they describe.
    weights[ahead < -voxel_size * 0.5] = 0.0
    total = weights.sum(axis=1, keepdims=True)
    blind = total[:, 0] <= 0
    if blind.any():
        weights[blind] = 0.0
        weights[blind, 0] = 1.0
        total[blind] = 1.0
    sampled = (attrs[idx] * (weights / total)[..., None]).sum(axis=1)

    base[ys, xs] = (np.clip(sampled[:, 0:3], 0, 1) * 255).astype(np.uint8)
    # glTF metallic-roughness packing: G roughness, B metallic.
    mr[ys, xs, 1] = (np.clip(sampled[:, 4], 0, 1) * 255).astype(np.uint8)
    mr[ys, xs, 2] = (np.clip(sampled[:, 3], 0, 1) * 255).astype(np.uint8)
    progress("texture", f"Sampled {len(ys):,} texels ({int(blind.sum()):,} with nothing in front)")
    return base, mr, cover


def export_glb_pbr(vertices, faces, uvs, base_color_img, mr_img, out_path, finish="pbr") -> None:
    """Write the textured GLB ourselves instead of trellis-mac's exporter.

    Two things that exporter does are wrong, and both are silent.

    1. METAL IS MULTIPLIED AWAY. It builds the material as
       `PBRMaterial(baseColorTexture=…, metallicFactor=0.0, roughnessFactor=0.8)`
       and THEN attaches `metallicRoughnessTexture`. glTF multiplies factor by
       texture, so a metallicFactor of 0 zeroes the entire metal channel the
       bake just spent minutes producing. MEASURED on the car: the MR map holds
       435,304 texels above 0.5 metallic (peak 213/255) and every one of them
       renders as plain dielectric. Chrome, paint flake and bare metal all come
       out looking like matte plastic, which is a large part of why our output
       did not look like the reference renders. Factors of 1.0 mean "use the
       maps", which is the whole point of having baked them.

    2. NO NORMALS. The GLB goes out with POSITION and TEXCOORD_0 only, so every
       consumer has to invent them: our viewer calls computeVertexNormals, but
       Blender/Unity/Unreal — the Send To targets — flat-shade it, and a
       decimated marching-cubes surface flat-shaded is all facets. Writing them
       is a few hundred KB against a file already in the tens of MB.

    Kept from the original: nothing else changes, so the atlas, the UVs and the
    face order are byte-identical to what the bake produced.

    `finish` is the user's Grey/Color/PBR setting as it reaches the bake: the
    colour finish writes the base colour alone as a plain dielectric (metal 0,
    roughness 0.85 — the same painted look the retopo re-bake gives), so the
    baked metal/roughness stays out of a model the person asked for as colour.
    """
    import trimesh
    from PIL import Image as PILImage

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if finish == "color":
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=PILImage.fromarray(base_color_img),
            metallicFactor=0.0,
            roughnessFactor=0.85,
        )
        mr_img = None
    else:
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=PILImage.fromarray(base_color_img),
            metallicFactor=1.0,
            roughnessFactor=1.0,
        )
    if mr_img is not None:
        material.metallicRoughnessTexture = PILImage.fromarray(mr_img)
    mesh.visual = trimesh.visual.TextureVisuals(uv=uvs, material=material)
    # Touching `vertex_normals` computes them; include_normals then writes them.
    _ = mesh.vertex_normals
    mesh.export(str(out_path), include_normals=True)


def encode_voxel_budget() -> int:
    """Occupied voxels the shape encoder can take on THIS machine.

    Unified memory means the GPU budget is the machine's RAM, so this scales
    with it rather than being a constant tuned on one laptop. The ratio comes
    from the measurement that failed: ~775k voxels exhausted a 24 GB Mac, so
    roughly 26k voxels per GB is the ceiling and two thirds of that is a working
    figure with room for the rest of the pipeline.
    """
    try:
        total_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / (1024**3)
    except (ValueError, OSError, AttributeError):
        total_gb = 16.0
    return int(total_gb * 26_000 * 0.66)


def count_encode_voxels(mesh, resolution: int) -> int:
    """How many voxels this mesh's surface occupies at `resolution`.

    The same dual-grid conversion the encoder runs, asked for its size only. It
    is CPU work and takes seconds, against minutes for the sampling it guards.
    """
    import numpy as np
    import o_voxel
    import torch

    voxel_indices, _dual, _hit = o_voxel.convert.mesh_to_flexible_dual_grid(
        torch.from_numpy(np.asarray(mesh.vertices)).float().cpu(),
        torch.from_numpy(np.asarray(mesh.faces)).long().cpu(),
        grid_size=resolution,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        face_weight=1.0,
        boundary_weight=0.2,
        regularization_weight=1e-2,
        timing=False,
    )
    return int(len(voxel_indices))


def texture_from_image(args) -> None:
    """Paint an EXISTING mesh from a reference image — no voxels, no Xcode.

    The user: "can I texture existing models…?"

    Not before this. The Texture stage was only ever a RE-BAKE: the generation
    saved a voxel colour field beside its mesh and texturing sampled it again,
    so a mesh that did not come out of a generation here — anything imported,
    anything modelled elsewhere — had no colours to re-bake and the stage
    refused. That is most of the meshes a person owns.

    TRELLIS.2 ships `Trellis2TexturingPipeline` for exactly this: it conditions
    the texture flow on an IMAGE plus the shape latent of whatever mesh you hand
    it. Its four checkpoints are already inside the TRELLIS.2-4B download, so
    this costs no extra bytes.

    WHY THE IMPORT IS PROPPED UP. That module refuses to load at all without
    `cumesh` + `mtldiffrast`, and `cumesh` needs `mtlbvh`, which is a Metal
    kernel that compiles only with a full Xcode — not Command Line Tools. Most
    Macs do not have Xcode, this one does not, and a 10 GB developer install is
    not something to put between a user and a texture button.

    It does not need them. Reading the module, the rasteriser is used in exactly
    one place — `postprocess_mesh`, to UV-unwrap a mesh that has no UVs and to
    rasterise those UVs into per-texel positions. We already do both, with
    `uv_unwrap_padded` (xatlas) and `_rasterize_uv_triangles`, and our baker is
    better anyway: it samples front-facing only and pads charts with their own
    colour. So the guard gets a stub to satisfy, the pipeline is used for the
    part only it can do — image + shape -> a PBR colour volume — and the atlas
    is baked here.
    """
    import numpy as np
    import torch
    import trimesh
    from PIL import Image as PILImage

    # The module-level guard checks `backends.MeshBackend is not None` and
    # nothing on the sampling path ever calls it — postprocess_mesh, the only
    # caller, is the step we replace.
    import trellis2.backends as _backends

    if _backends.MeshBackend is None:
        class _UnwrapNotUsed:  # pragma: no cover - exists to satisfy an import
            def __init__(self, *_a, **_k) -> None:
                raise RuntimeError(
                    "the Metal mesh backend is unavailable and should not be reached — "
                    "this worker unwraps with xatlas"
                )

        _backends.MeshBackend = _UnwrapNotUsed

    from trellis2.pipelines import Trellis2TexturingPipeline

    weights = os.environ.get("PI_GEN3D_MLX_WEIGHTS") or "microsoft/TRELLIS.2-4B"
    resolution = 512 if str(args.pipeline_type).startswith("512") else 1024
    progress(STAGE_TEXTURE, "Loading the texturing pipeline (first load ≈100 s)…")
    t0 = time.time()
    pipeline = Trellis2TexturingPipeline.from_pretrained(weights, "texturing_pipeline.json")
    pipeline.to(torch.device(pick_device()))
    progress(STAGE_TEXTURE, f"Pipeline loaded in {time.time() - t0:.0f}s — painting…")

    # DROP THE FLOW MODEL WE ARE NOT GOING TO USE. The pipeline loads both the
    # 512 and the 1024 texture flow models — 1.3B parameters each — and a run
    # uses exactly one. On unified memory the idle one is not free, it is a
    # couple of gigabytes standing between this stage and finishing.
    unused = "tex_slat_flow_model_1024" if resolution == 512 else "tex_slat_flow_model_512"
    if pipeline.models.get(unused) is not None:
        del pipeline.models[unused]
        gc.collect()
        empty_cache()

    # BiRefNet (background removal) loads at the checkpoint's own precision —
    # half — while its transform hands it float32, so the first conv dies with
    # "Input type (float) and bias type (c10::Half) should be the same". Forcing
    # the weights to float32 matches the input rather than the other way round,
    # because the alternative is casting inside someone else's remote-code model.
    # DINOv3 MOVED A LEVEL DOWN. The feature extractor walks `self.model.layer`,
    # which was the layer list in the transformers this fork was written
    # against; in 5.x `DINOv3ViTModel` keeps the encoder at `.model` and the
    # layers at `.model.layer`, so the walk dies with "'DINOv3ViTModel' object
    # has no attribute 'layer'". Aliasing the list back onto the model is the
    # smallest correct fix — the layers are the same modules either way, and
    # nothing else in the extractor changed.
    cond_model = getattr(getattr(pipeline, "image_cond_model", None), "model", None)
    if cond_model is not None and not hasattr(cond_model, "layer"):
        inner_encoder = getattr(cond_model, "model", None)
        layers = getattr(inner_encoder, "layer", None) or getattr(inner_encoder, "layers", None)
        if layers is not None:
            cond_model.layer = layers

    rembg = getattr(pipeline, "rembg_model", None)
    inner = getattr(rembg, "model", None)
    if inner is not None and hasattr(inner, "float"):
        inner.float()

    mesh = trimesh.load(args.mesh, force="mesh", process=False)
    image = pipeline.preprocess_image(PILImage.open(args.image[0]).convert("RGB"))

    # ENCODE FROM A LIGHTER COPY. The shape latent's cost scales with the mesh
    # handed to it, and a generated model arrives at seven figures: MEASURED,
    # the 1,099,136-face astronaut exhausted 30 GiB of unified memory inside
    # encode_shape_slat while a 165,694-face figure sailed through. What comes
    # out of the pipeline is a voxel COLOUR FIELD, not a mesh, so it does not
    # care how dense the shape it was encoded from was — and the atlas is baked
    # onto the full-resolution mesh afterwards either way. Decimating only the
    # copy that gets encoded is therefore free of quality, and it is what makes
    # this run on a machine with less memory rather than only on a big one.
    encode_mesh = mesh
    if len(mesh.faces) > ENCODE_FACE_BUDGET:
        try:
            import fast_simplification

            ratio = 1.0 - (ENCODE_FACE_BUDGET / len(mesh.faces))
            verts_s, faces_s = fast_simplification.simplify(
                np.asarray(mesh.vertices, dtype=np.float32),
                np.asarray(mesh.faces, dtype=np.int32),
                ratio,
            )
            encode_mesh = trimesh.Trimesh(verts_s, faces_s, process=False)
            progress(
                STAGE_TEXTURE,
                f"Encoding shape from {len(faces_s):,} of {len(mesh.faces):,} faces…",
            )
        except ImportError:
            pass

    # Background removal is finished with; so is the image encoder once the
    # conditioning exists. Each is released the moment its output is in hand
    # rather than at the end, because the peak is in the middle.
    if rembg is not None and hasattr(rembg, "to"):
        rembg.to("cpu")
    gc.collect()

    t1 = time.time()
    torch.manual_seed(args.seed)
    cond = pipeline.get_cond([image], resolution)
    cond_holder = getattr(pipeline, "image_cond_model", None)
    if cond_holder is not None and hasattr(cond_holder, "to"):
        cond_holder.to("cpu")
    gc.collect()
    empty_cache()

    prepared = pipeline.preprocess_mesh(encode_mesh)

    # PREDICT THE COST BEFORE PAYING IT. What drives the shape encoder is the
    # number of OCCUPIED VOXELS, and that is surface area at the grid
    # resolution — not face count. MEASURED on the astronaut: decimating from
    # 1,528,728 faces to 150,000 and then to 40,000 moved occupancy by 0.2%
    # (774,044 -> 775,944), because the surface is the same surface either way.
    # So decimating cannot rescue a mesh that is too detailed, and the honest
    # thing is to say so BEFORE spending three minutes arriving at an allocator
    # failure the user cannot interpret.
    #
    # The dual grid itself is cheap and runs on the CPU, so asking it first
    # costs seconds and answers the question exactly.
    occupied = count_encode_voxels(prepared, resolution)
    budget_voxels = encode_voxel_budget()
    progress(
        STAGE_TEXTURE,
        f"Shape occupies {occupied:,} voxels at {resolution}³ "
        f"(this machine allows about {budget_voxels:,})",
    )
    if occupied > budget_voxels:
        over = occupied / max(budget_voxels, 1)
        # OVER THE BUDGET BY MUCH IS A REFUSAL NOW. This used to lean on swap
        # and finish "roughly Nx slower" — and it did, until the machine got a
        # memory guard (2026-09-16, after the user's Mac restarted under exactly
        # this stage): a job swapping at 6.7x over is what the guard pauses and
        # then ends, and it ends it with the picture unpainted after three
        # minutes of loading. Saying so before the load is the honest version.
        # Retopologising first does NOT help and is not suggested — MEASURED, it
        # moved the astronaut from 697,472 voxels to 993,180, because a remesh's
        # open edges add surface rather than remove it. A little over still
        # runs (the guard has the swap to watch).
        if over > 1.5:
            msg = (
                f"This model's surface is {over:.1f}x what this Mac can encode for "
                f"texturing ({occupied:,} voxels at {resolution}³, about "
                f"{budget_voxels:,} fit) — it would swap hard and be stopped to keep the "
                "Mac responsive. Generate the model with a Color or PBR finish instead, "
                "or texture it on a Mac with more memory."
            )
            emit(event="error", message=msg)
            del pipeline
            empty_cache()
            raise WorkerFailure(msg)
        progress(
            STAGE_TEXTURE,
            f"That is a little past what fits in memory ({over:.1f}x), so this will use "
            f"some swap and take longer than usual.",
        )

    shape_slat = pipeline.encode_shape_slat(prepared, resolution)
    tex_model = pipeline.models[
        "tex_slat_flow_model_512" if resolution == 512 else "tex_slat_flow_model_1024"
    ]
    tex_slat = pipeline.sample_tex_slat(cond, tex_model, shape_slat, {})

    # HAND THE MEMORY BACK BEFORE DECODING. Sampling is done with the flow
    # model, the image encoder, the background remover and the shape encoder,
    # and none of them are needed to decode — but on unified memory they are
    # still holding most of it. MEASURED: decode asked for another 934 MiB with
    # 29.69 GiB already resident and died on the MPS watermark, on a machine
    # with plenty of room once the finished stages let go.
    for spent in ("tex_slat_flow_model_512", "tex_slat_flow_model_1024", "shape_slat_encoder"):
        module = pipeline.models.get(spent)
        if module is not None:
            module.to("cpu")
    for attr in ("image_cond_model", "rembg_model"):
        holder = getattr(pipeline, attr, None)
        if holder is not None and hasattr(holder, "to"):
            holder.to("cpu")
    del cond, shape_slat, tex_model
    gc.collect()
    empty_cache()

    pbr = pipeline.decode_tex_slat(tex_slat)
    progress(STAGE_TEXTURE, f"Colour field predicted in {time.time() - t1:.0f}s — baking…")

    # The volume, in the layout our baker expects: base_color, metallic,
    # roughness. `coords` carry a leading batch column.
    layout = pipeline.pbr_attr_layout
    feats = pbr.feats.detach().float().cpu().numpy()
    attrs = np.concatenate(
        [
            feats[:, layout["base_color"]],
            feats[:, layout["metallic"]],
            feats[:, layout["roughness"]],
        ],
        axis=1,
    )
    coords = pbr.coords[:, 1:4].detach().int().cpu().numpy()
    origin = np.array([-0.5, -0.5, -0.5], dtype=np.float32)
    voxel_size = 1.0 / float(resolution)

    # The atlas goes on the mesh the user gave us, at the same budget the
    # generate path uses — not on the decimated copy the encoder saw.
    bake_mesh = mesh
    budget = args.bake_faces or BAKE_FACE_BUDGET
    if len(mesh.faces) > budget:
        try:
            import fast_simplification

            ratio = 1.0 - (budget / len(mesh.faces))
            bv, bf = fast_simplification.simplify(
                np.asarray(mesh.vertices, dtype=np.float32),
                np.asarray(mesh.faces, dtype=np.int32),
                ratio,
            )
            bake_mesh = trimesh.Trimesh(bv, bf, process=False)
        except ImportError:
            pass
    # THE ATLAS MUST BE BAKED IN THE VOLUME'S OWN SPACE. `preprocess_mesh`
    # does not just normalise — it centres, scales into the unit cube AND swaps
    # axes (y = -z, z = y). The colour field comes out in THAT space, so baking
    # against the mesh's original coordinates samples empty space: MEASURED,
    # 5,190,327 of 5,668,518 texels found nothing in front of them, and the
    # result was a black, sideways model. Running the full-resolution mesh
    # through the same preprocess puts both in one frame.
    bake_prepared = pipeline.preprocess_mesh(bake_mesh)
    verts = np.asarray(bake_prepared.vertices, dtype=np.float32)
    faces = np.asarray(bake_prepared.faces, dtype=np.int64)
    size = atlas_size_for(len(faces), args.texture_size)
    new_verts, new_faces, uvs, _ = uv_unwrap_padded(verts, faces, size)
    base_color_img, mr_img, cover = bake_atlas_front_facing(
        new_verts, new_faces, uvs, coords, attrs, origin, voxel_size, size
    )
    base_color_img = dilate_atlas(base_color_img, cover)
    mr_img = dilate_atlas(mr_img, cover)

    out_path = Path(args.out_dir) / "model.glb"
    export_uvs = np.column_stack([uvs[:, 0], 1.0 - uvs[:, 1]])
    # Undo preprocess_mesh's swap exactly — it did y = -z, z = y, so the way
    # back is y = z', z = -y'. Using the generate path's `to_gltf_up` here would
    # be a different rotation and lay the model on its side.
    out_verts = np.asarray(new_verts, dtype=np.float32).copy()
    y_prime = out_verts[:, 1].copy()
    out_verts[:, 1] = out_verts[:, 2]
    out_verts[:, 2] = -y_prime
    export_glb_pbr(
        out_verts, new_faces, export_uvs, base_color_img, mr_img, out_path, args.finish
    )
    del pipeline
    empty_cache()
    progress(STAGE_TEXTURE, f"Painted in {time.time() - t1:.0f}s")
    artifact(STAGE_TEXTURE, "model-glb", str(out_path), "Textured model")
    stage_done(STAGE_TEXTURE, "Texturing done")


def apply_colour_finish(glb):
    """Strip a baked GLB down to its painted colour — the user's "Color".

    o_voxel's exporter writes the full material (base colour + metal/roughness,
    sometimes a normal map). A colour finish keeps only the base colour and
    lights it as a plain dielectric, matching what export_glb_pbr writes for
    the same setting on the KDTree path, so the two bakers agree.
    """
    import trimesh

    geoms = glb.geometry.values() if isinstance(glb, trimesh.Scene) else [glb]
    for geom in geoms:
        material = getattr(getattr(geom, "visual", None), "material", None)
        if material is None or not isinstance(material, trimesh.visual.material.PBRMaterial):
            continue
        material.metallicRoughnessTexture = None
        material.normalTexture = None
        material.occlusionTexture = None
        material.metallicFactor = 0.0
        material.roughnessFactor = 0.85
    return glb


def bake_textures(
    volume: VoxelVolume,
    verts,
    faces,
    out_path: Path,
    texture_size: int,
    face_budget: int = 0,
    finish: str = "pbr",
) -> None:
    """Metal bake via o_voxel/mtldiffrast, KDTree fallback — adapted from
    trellis-mac generate.py (incl. its _grid_sample_3d transpose fix).

    `verts`/`faces` are the welded, de-specked surface (weld_and_clean), in
    TRELLIS's original frame — the colours are sampled by POSITION out of
    `volume`, so the two have to agree before the Y-up rotation is applied.
    Taking the volume as an argument rather than reaching into a live pipeline
    result is what lets the Texture stage re-bake a mesh on its own.
    """
    import torch
    from PIL import Image as PILImage

    use_metal = False
    try:
        if not METAL_BAKE:
            raise ImportError  # opt-in only — see METAL_BAKE
        import o_voxel.postprocess

        backend = getattr(o_voxel.postprocess, "_BACKEND", None)
        has_dr = getattr(o_voxel.postprocess, "_HAS_DR", False)
        use_metal = backend == "metal" and has_dr
        if use_metal and not getattr(o_voxel.postprocess, "_HAS_FLEX_GEMM", False):
            import torch.nn.functional as F_gs

            def _gs3d_fix(feats, coords, shape, grid, mode="trilinear"):
                B, C = shape[0], shape[1]
                D, H, W = shape[2], shape[3], shape[4]
                dense = torch.zeros(B, C, D, H, W, dtype=feats.dtype, device=feats.device)
                bi = coords[:, 0].long()
                cx = coords[:, 1].long()
                cy = coords[:, 2].long()
                cz = coords[:, 3].long()
                dense[bi, :, cx, cy, cz] = feats
                grid_norm = torch.stack(
                    [
                        grid[..., 2] / (W - 1) * 2 - 1,
                        grid[..., 1] / (H - 1) * 2 - 1,
                        grid[..., 0] / (D - 1) * 2 - 1,
                    ],
                    dim=-1,
                ).reshape(B, 1, 1, -1, 3)
                sampled = F_gs.grid_sample(
                    dense, grid_norm, mode="bilinear", align_corners=True, padding_mode="border"
                )
                M = grid.shape[1]
                return sampled.reshape(B, C, M).permute(0, 2, 1).reshape(B * M, C)

            o_voxel.postprocess._grid_sample_3d = _gs3d_fix
    except (ImportError, AttributeError):
        use_metal = False

    coords, attrs, layout = volume.coords, volume.attrs, volume.layout
    voxel_size = volume.voxel_size
    target_faces = min(face_budget or BAKE_FACE_BUDGET, len(faces))
    size = atlas_size_for(target_faces, texture_size)

    if use_metal:
        try:
            progress("texture", f"Baking PBR textures via Metal ({size}px)…")
            import fast_simplification
            import o_voxel

            verts_np, faces_np = verts, faces
            if len(faces_np) > target_faces:
                ratio = 1.0 - (target_faces / len(faces_np))
                simp_verts, simp_faces = fast_simplification.simplify(verts_np, faces_np, ratio)
                simp_verts_t = torch.from_numpy(simp_verts).float()
                simp_faces_t = torch.from_numpy(simp_faces.astype("int32"))
            else:
                simp_verts_t = torch.from_numpy(verts_np).float()
                simp_faces_t = torch.from_numpy(faces_np.astype("int32"))
            glb = o_voxel.postprocess.to_glb(
                vertices=simp_verts_t.cpu(),
                faces=simp_faces_t.cpu(),
                attr_volume=attrs,
                coords=coords,
                attr_layout=layout,
                voxel_size=voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=target_faces,
                texture_size=size,
                verbose=True,
            )
            if finish == "color":
                apply_colour_finish(glb)
            glb.export(str(out_path))
            return
        except RuntimeError as err:
            progress("texture", f"Metal bake failed ({err}); falling back to KDTree baker…")

    progress("texture", f"Baking PBR textures ({size}px)…")
    bake_verts, bake_faces = verts, faces
    if len(faces) > target_faces:
        try:
            import fast_simplification

            ratio = 1.0 - (target_faces / len(faces))
            bake_verts, bake_faces = fast_simplification.simplify(verts, faces, ratio)
        except ImportError:
            pass
    new_verts, new_faces, uvs, _ = uv_unwrap_padded(bake_verts, bake_faces, size)
    base_color_img, mr_img, true_cover = bake_atlas_front_facing(
        new_verts,
        new_faces,
        uvs,
        coords.float().numpy(),
        attrs.float().numpy(),
        volume.origin.float().numpy(),
        voxel_size,
        size,
    )
    base_color_img = dilate_atlas(base_color_img, true_cover)
    mr_img = dilate_atlas(mr_img, true_cover)
    PILImage.fromarray(base_color_img)  # touch to validate
    # FLIP V FOR EXPORT — this is the bug behind "texturing is completely messed
    # up". The baker rasterizes into an image array, so its v runs DOWNWARD with
    # the rows; trimesh's TextureVisuals takes UVs in the OBJ/OpenGL convention
    # where v runs UPWARD, and flips them itself when it writes the GLB. The two
    # flips do not cancel — they compose into an upside-down lookup, and because
    # the atlas is thousands of small charts, "upside down" does not read as a
    # mirrored texture but as coloured static.
    #
    # PROVEN by rewriting the UVs of an already-exported model.glb and reloading
    # it: identical bytes otherwise, and the helicopter went from static to a
    # correctly painted light-blue airframe with grey rotors and yellow trim.
    # Only the EXPORT is flipped; bake_texture above must keep the baker's own
    # convention or the atlas it produces would be wrong too.
    import numpy as np

    export_uvs = np.column_stack([uvs[:, 0], 1.0 - uvs[:, 1]])
    # Rotate to glTF's Y-up ONLY at export: the bake above samples voxel-space
    # coords/attrs/origin, which must stay in TRELLIS's original frame or the
    # texture lands on the wrong faces. A rigid rotation leaves UVs and face
    # indices untouched, so converting the positions here is safe.
    export_glb_pbr(
        to_gltf_up(new_verts), new_faces, export_uvs, base_color_img, mr_img, out_path, finish
    )


def load_pipeline():
    """Load TRELLIS-2 — MLX when this checkout provides it, else PyTorch MPS.

    MEASURED on the same image at 512, output meshes rendered and compared
    side by side (visually indistinguishable — same turret, barrel, wheels):

        PyTorch MPS   225s total   (82s load + 137s generate)
        MLX            76s total   ( 3s load +  73s generate)   ← 3x faster

    The load alone is 82s → 3s, which matters twice over: it is 36% of a cold
    MPS run, and it is what `--serve` exists to amortise.
    """
    t0 = time.time()
    mlx_pipeline = os.environ.get("PI_GEN3D_MLX_WEIGHTS", "")
    if mlx_pipeline:
        progress("geometry", "Loading TRELLIS-2 (MLX)…")
        from mlx_backend.pipeline import create_mlx_pipeline

        pipeline = create_mlx_pipeline(weights_path=mlx_pipeline)
        # BiRefNet ships fp16 weights while the preprocessing transform yields
        # fp32 — the conv then dies with "Input type (float) and bias type
        # (c10::Half) should be the same". It is tiny next to the 4B pipeline,
        # so promote it rather than downcast the image.
        try:
            pipeline.rembg_model.model.float()
        except Exception:  # noqa: BLE001 — never fail a run over the matte model
            pass
    else:
        progress("geometry", "Loading TRELLIS-2 pipeline (first load ≈100 s)…")
        import torch

        from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline

        pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
        pipeline.to(torch.device(pick_device()))
    progress("geometry", f"Pipeline loaded in {time.time() - t0:.0f}s — generating…")
    return pipeline


def run_bake_only(args) -> None:
    """Re-bake an EXISTING mesh from a saved colour volume — the Texture stage.

    This is what replaced Hunyuan Paint (11.4 GB of weights: the paintpbr subset
    plus dinov2-giant) for texturing. TRELLIS already produces PBR for the model
    it generates, and the volume it sampled is small enough to keep, so
    texturing a mesh again — after a retopo, say — needs no second model at all.
    The user: "if trellis bundles a texturing model that can do good pbr and such,
    can you just utilize that instead of a separate hunyuan paint please (shaves
    off a bit of disk space too)".

    It only works on a mesh this app generated: the volume is the generation's
    own output. An imported mesh has no colours to sample and says so, rather
    than emitting an untextured GLB and calling it done.
    """
    import trimesh

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ROUTER.default_stage = "texture"

    voxels = Path(args.voxels) if args.voxels else Path(args.mesh).with_name("voxels.npz")
    if not voxels.exists():
        # Say what was SEARCHED, not where the model came from. This message used
        # to end "…and this one was imported" — a guess about provenance the
        # worker has no way to make, and it was wrong for the case that actually
        # shipped: a TRELLIS-generated model whose retopo result sits in its own
        # job dir while the colours stay in the generation's.
        msg = (
            "No colour data to texture from — the Texture stage re-bakes from the "
            "voxel colour field the generation saved, and there is none in "
            f"{voxels.parent}. A model imported from a file never has one; for a "
            "generated model the colours stay in the job folder that produced it."
        )
        emit(event="error", message=msg)
        raise WorkerFailure(msg)

    progress("texture", "Loading colours…")
    volume = load_voxels(voxels)
    tm = trimesh.load(args.mesh, force="mesh", process=False)
    tm.merge_vertices()
    # The GLB on disk is Y-up; the volume is in TRELLIS's frame.
    verts = from_gltf_up(tm.vertices)
    model_path = out_dir / "model.glb"
    bake_textures(
        volume, verts, tm.faces, model_path, args.texture_size, args.bake_faces, args.finish
    )
    artifact("texture", "model-glb", str(model_path), "Textured model")
    stage_done("texture", "Texturing done")


def run_one(pipeline, args) -> None:
    """One generation against an already-loaded pipeline."""
    from PIL import Image as PILImage

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Per-request reset: a served worker survives across jobs, and the texture
    # branch below mutates the router's default stage. Without this, job N+1's
    # early progress would be misrouted to 'texture'.
    ROUTER.default_stage = "geometry"

    imgs = [PILImage.open(p) for p in args.image]
    if len(imgs) > 1:
        progress("geometry", f"Conditioning on {len(imgs)} images…")
    tex_params = {} if args.texture else {"steps": 1}
    t_gen = time.time()
    try:
        # Multiple images → multi-image conditioning when the pipeline supports
        # it (upstream `run_multi_image`); otherwise fall back to the first view.
        if len(imgs) > 1 and hasattr(pipeline, "run_multi_image"):
            outputs = pipeline.run_multi_image(
                imgs,
                seed=args.seed,
                pipeline_type=args.pipeline_type,
                tex_slat_sampler_params=tex_params,
            )
        else:
            outputs = pipeline.run(
                imgs[0],
                seed=args.seed,
                pipeline_type=args.pipeline_type,
                tex_slat_sampler_params=tex_params,
            )
    except (IndexError, AssertionError) as err:
        if any(sig in str(err) for sig in WATCHDOG_SIGNATURES):
            emit(event="error", message=WATCHDOG_HELP)
            raise WorkerFailure(WATCHDOG_HELP) from err
        raise
    mesh_out = outputs[0] if isinstance(outputs, list) else outputs

    # Weld + de-speck ONCE, then hand the same surface to every consumer. Doing
    # it per-export cost a MEASURED 87s on a 512 run (206s vs 119s) for three
    # identical passes over a 1.5M-face mesh.
    clean_verts, clean_faces = weld_and_clean(mesh_out, "geometry")

    geo_path = out_dir / "geometry.glb"
    n_verts, n_faces = export_untextured_glb(clean_verts, clean_faces, geo_path)
    if n_verts == 0 or n_faces == 0:
        emit(event="error", message=WATCHDOG_HELP)
        raise WorkerFailure(WATCHDOG_HELP)
    # The viewer gets the preview; `path` stays the full-resolution mesh so
    # every downstream stage still runs on the real geometry.
    preview = export_preview_glb(
        clean_verts, clean_faces, out_dir / "geometry-preview.glb", n_faces
    )
    emit(
        event="artifact",
        stage="geometry",
        kind="model-glb",
        path=str(geo_path),
        label="Untextured geometry",
        **({"previewPath": str(preview)} if preview is not None else {}),
    )
    stage_done(
        "geometry",
        f"Geometry done — {n_verts:,} vertices / {n_faces:,} triangles in {time.time() - t_gen:.0f}s",
    )

    if args.texture and getattr(mesh_out, "attrs", None) is not None:
        # Bake-time tqdm loops (simplify/xatlas inside o_voxel) carry no
        # recognizable desc — route them to the texture stage from here on so
        # overallPercent never jumps back to the geometry band.
        ROUTER.default_stage = "texture"
        model_path = out_dir / "model.glb"
        # Keep the colour field beside the result so the Texture stage can
        # re-bake this asset later without regenerating it.
        save_voxels(mesh_out, out_dir / "voxels.npz")
        bake_textures(
            volume_of(mesh_out), clean_verts, clean_faces, model_path,
            args.texture_size, args.bake_faces, args.finish,
        )
        artifact("texture", "model-glb", str(model_path), "Textured model")
        stage_done("texture", "Texturing done")


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    # One-or-more unlabeled input images (repeat --image). TRELLIS.2 pools
    # multiple views; a single image is the common case.
    ap.add_argument("--image", action="append", dest="image")
    ap.add_argument("--out-dir")
    ap.add_argument(
        "--pipeline-type",
        default="512",
        choices=["512", "1024", "1024_cascade", "1536_cascade"],
    )
    tex = ap.add_mutually_exclusive_group()
    tex.add_argument("--texture", action="store_true", default=True)
    tex.add_argument("--no-texture", dest="texture", action="store_false")
    ap.add_argument("--texture-size", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--prompt", default="")
    # Persistent mode: load the pipeline once, then take one job per stdin line.
    ap.add_argument("--serve", action="store_true")
    # Texture stage: re-bake an existing mesh, no pipeline load at all.
    ap.add_argument("--bake-only", action="store_true")
    ap.add_argument(
        "--texture-from-image",
        action="store_true",
        help="paint --mesh from --image; no voxel field needed",
    )
    ap.add_argument("--mesh")
    ap.add_argument("--voxels")
    ap.add_argument("--bake-faces", type=int, default=0)
    # What the bake writes: the painted colour alone, or the full PBR material.
    ap.add_argument("--finish", choices=["color", "pbr"], default="pbr")
    return ap


def _serve(ap: argparse.ArgumentParser) -> None:
    """Read one job per line on stdin, reusing the loaded pipeline.

    Each line is a JSON array of the SAME CLI args a one-shot run would take, so
    the request shape has exactly one definition. After each job we emit
    `{"event":"job-done"}` — the manager's terminator — and a failure is reported
    as an `error` event WITHOUT exiting, so one bad job never costs the 82s
    reload for the next.
    """
    pipeline = load_pipeline()
    emit(event="ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            args = ap.parse_args(json.loads(line))
        except Exception as err:  # malformed request — report, stay alive
            emit(event="error", message=f"bad request: {err}")
            emit(event="job-done")
            continue
        try:
            run_one(pipeline, args)
        except WorkerFailure:
            pass  # already reported by run_one
        except Exception as err:
            emit(event="error", message=str(err))
        emit(event="job-done")


def main() -> None:
    ap = _build_parser()
    args = ap.parse_args()
    if args.serve:
        _serve(ap)
        return
    if args.texture_from_image:
        if not args.mesh or not args.image or not args.out_dir:
            ap.error("--texture-from-image needs --mesh, --image and --out-dir")
        try:
            texture_from_image(args)
        except WorkerFailure:
            sys.exit(2)
        return
    if args.bake_only:
        if not args.mesh or not args.out_dir:
            ap.error("--bake-only needs --mesh and --out-dir")
        try:
            run_bake_only(args)
        except WorkerFailure:
            sys.exit(2)
        return
    if not args.image or not args.out_dir:
        ap.error("--image and --out-dir are required")
    try:
        run_one(load_pipeline(), args)
    except WorkerFailure:
        sys.exit(2)  # error already emitted; jobs.py surfaces the non-zero exit


if __name__ == "__main__":
    main()
