/**
 * BOBBLE'S FIXES, DROPPED INTO THE USER'S ComfyUI AS FILES IT LOADS.
 *
 * Two of them, one directory (`bobble_comfy_fixes`), both registering no nodes:
 *
 *   __init__.py      MiniMax H3's text encoder is detected by the language
 *                    model, so a GGUF of it loads (below).
 *   mesh_on_cpu.py   ComfyUI's mesh post-processing runs on the CPU on Apple
 *                    Silicon, because on MPS it does not run at all
 *                    (COMFY_MESH_ON_CPU_PY, further below).
 *
 * ## Why the first one exists at all
 * H3's text encoder is Qwen3-VL-32B. The smallest official release of it is
 * 27GB (int8), which does not fit a 24GB Mac; the GGUF conversion is 19.8GB,
 * which does. But llama.cpp splits a vision-language model in two — language
 * model in the main file, vision tower in a separate `mmproj` — and ComfyUI
 * identifies this encoder by a VISION key. So every GGUF of it is unrecognisable
 * to ComfyUI, detection falls through to the nearest other 64-layer model
 * (Mistral3-24B), and the run dies inside a Mistral tokenizer.
 *
 * fp8 casts are refused on MPS, so GGUF is the only quant path that works here
 * at all. "ComfyUI cannot identify this GGUF" therefore means "H3 cannot run on
 * a Mac", which is why a shim is worth it rather than a workaround.
 *
 * ## Why it is shaped as a file we write rather than code we ship
 * §4: we author no custom nodes, because a node that imports ComfyUI is a
 * derivative of a GPL-3.0 program and would pull the app into that licence.
 * This does not change that rule, it respects it:
 *
 *   - the Python below is licensed GPL-3.0, the same licence as the program it
 *     extends, and says so in its own header;
 *   - nothing in the app imports it, links to it, or calls into it. The app
 *     writes a text file next to ComfyUI's other custom nodes, and ComfyUI — the
 *     GPL program, running in its own process — is what loads it;
 *   - it registers NO nodes. `NODE_CLASS_MAPPINGS` is empty. It corrects one
 *     model-detection predicate and gets out of the way, which also means a
 *     workflow never references it and nothing here depends on it existing.
 *
 * The upstream fix is to detect this encoder by the language model, which is the
 * half that is always present; until that lands, every Mac needs this file.
 */
export const COMFY_H3_SHIM_DIRNAME = 'bobble_comfy_fixes';

export const COMFY_H3_SHIM_PY = `"""
Bobble's ComfyUI fixes. Copyright (C) 2026 the Bobble authors.

This file is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details: <https://www.gnu.org/licenses/>.

It registers no nodes. It corrects one model-detection predicate:

TEXT-ONLY QWEN3-VL-32B (MiniMax H3's conditioning encoder)

H3 conditions on Qwen3-VL-32B truncated to 50 layers. ComfyUI recognises that
checkpoint by TWO keys — a language-model layer AND a vision-tower key:

    "visual.deepstack_merger_list.0.norm.weight" and
    "model.layers.49.self_attn.q_proj.weight"

which is a fine test for the safetensors release, where both towers are in one
file. It is the wrong test for a GGUF: llama.cpp puts the vision tower in a
SEPARATE mmproj file, so every GGUF conversion of this encoder carries the
language model alone.

The check below has to run BEFORE upstream's, because upstream does not fail to
recognise the file — it MISrecognises it. Without a vision key the chain falls
through to "hidden size 5120 and a 40th layer", which is Mistral3-24B, and the
run dies loading a Mistral tokenizer rather than anywhere informative.

The signature used here is the conjunction only this model satisfies: Qwen3
q-norm (Mistral has none), 151936 x 5120 embeddings, a 50th layer, and no vision
tower. Anything else still gets upstream's answer, unchanged. Text-to-video never
touches the vision half, so the language model alone is the whole requirement.
"""

import logging

import comfy.sd

_upstream_detect = comfy.sd.detect_te_model

QWEN3VL_32B_VOCAB = 151936
QWEN3VL_32B_HIDDEN = 5120


def is_text_only_qwen3vl_32b(sd) -> bool:
    emb = sd.get("model.embed_tokens.weight")
    return (
        emb is not None
        and tuple(emb.shape) == (QWEN3VL_32B_VOCAB, QWEN3VL_32B_HIDDEN)
        and "model.layers.0.self_attn.q_norm.weight" in sd       # Qwen3, not Mistral
        and "model.layers.49.self_attn.q_proj.weight" in sd      # deep enough for H3's 50
        and "visual.deepstack_merger_list.0.norm.weight" not in sd
        and "model.visual.deepstack_merger_list.0.norm.weight" not in sd
    )


def detect_te_model(sd):
    if is_text_only_qwen3vl_32b(sd):
        logging.info("[bobble] text-only Qwen3-VL-32B (MiniMax H3 encoder, no mmproj)")
        return comfy.sd.TEModel.QWEN3VL_32B
    return _upstream_detect(sd)


comfy.sd.detect_te_model = detect_te_model

# The second fix, same directory: mesh post-processing on the CPU on Apple Silicon.
from . import mesh_on_cpu  # noqa: E402,F401

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
`;

/** The file name of the second fix, beside `__init__.py` in the same directory. */
export const COMFY_MESH_ON_CPU_FILENAME = 'mesh_on_cpu.py';

/**
 * MESH POST-PROCESSING ON THE CPU.
 *
 * ComfyUI 0.35's native 3D pipeline (TRELLIS.2 / Pixal3D) ends in its own mesh
 * nodes — RemeshMesh, DecimateMesh, UnwrapMesh, the bakers — and they run their
 * scatter/sort passes on `get_torch_device()`. On MPS those passes come back
 * with NEGATIVE indices. MEASURED (ComfyUI 0.35.0, torch 2.13, M5 Pro):
 *
 *   RemeshMesh:    scatter: index -110 is out of bounds for dimension with size 7662540
 *   DecimateMesh:  scatter: index -804 is out of bounds for dimension 0 with size 2665628
 *
 * int64 index arithmetic MPS does not carry faithfully. The same code is sound
 * on the CPU — the whole chain then completes (decimate 38s, unwrap 6s, bakes
 * 70s at 512³ on the M5 Pro) — so while one of these nodes executes, the device
 * it asks for is the CPU. The samplers, the VAEs and PaintMesh keep MPS.
 *
 * The patch reaches the REGISTERED classes through `nodes.NODE_CLASS_MAPPINGS`.
 * ComfyUI imports comfy_extras/nodes_*.py under the bare file stem, so an
 * `import comfy_extras.nodes_mesh_postprocess` here would build a second, unused
 * copy of every class and patch that — it did, logged its success, and changed
 * nothing. Built-in extras load before custom nodes, so the mapping already
 * holds them when this file runs.
 *
 * Same licence story as the file above: GPL-3.0, written next to ComfyUI's
 * other custom nodes, loaded by ComfyUI in its own process, imported by nothing
 * of ours.
 */
export const COMFY_MESH_ON_CPU_PY = `"""
Bobble's ComfyUI fixes. Copyright (C) 2026 the Bobble authors. GPL-3.0-or-later,
as __init__.py in this directory says in full. Registers no nodes.

MESH POST-PROCESSING RUNS ON THE CPU ON APPLE SILICON.

ComfyUI's mesh3d nodes (DecimateMesh, RemeshMesh, UnwrapMesh, the bakers) run
their scatter/sort passes on get_torch_device(). On MPS those passes come back
with NEGATIVE indices — measured on ComfyUI 0.35.0 / torch 2.13:
  RemeshMesh:   "scatter: index -110 is out of bounds for dimension with size 7662540"
  DecimateMesh: "scatter: index -804 is out of bounds for dimension 0 with size 2665628"
int64 index arithmetic that MPS does not carry faithfully. The same code is
sound on the CPU, so while one of these nodes executes, the device it asks for
is the CPU. Nothing else changes: samplers, VAEs and painters keep MPS.
"""
import functools
import logging
import threading

import torch
import comfy.model_management as mm

_state = threading.local()
_orig_get_torch_device = mm.get_torch_device


def _get_torch_device():
    if getattr(_state, "cpu", False) and _orig_get_torch_device().type == "mps":
        return torch.device("cpu")
    return _orig_get_torch_device()


mm.get_torch_device = _get_torch_device

MESH_NODES = (
    "DecimateMesh", "RemeshMesh", "UnwrapMesh", "BakeTextureFromVoxel",
    "BakeNormalMapFromMesh", "BakeAmbientOcclusion", "RenderUVAtlas",
    "FillHoles", "WeldVertices", "MeshSmoothNormals",
)


def _to_cpu(mesh):
    """A MESH's tensors onto the CPU: the nodes .to(dev) most of what they touch,
    not all of it."""
    for name in ("vertices", "faces", "vertex_colors", "uvs", "normals", "face_counts", "vertex_counts"):
        t = getattr(mesh, name, None)
        if isinstance(t, torch.Tensor) and t.device.type == "mps":
            try:
                setattr(mesh, name, t.cpu())
            except Exception:
                pass
    return mesh


def _wrap(cls):
    orig = cls.execute.__func__ if hasattr(cls.execute, "__func__") else cls.execute

    @functools.wraps(orig)
    def execute(klass, *args, **kwargs):
        if _orig_get_torch_device().type != "mps":
            return orig(klass, *args, **kwargs)
        _state.cpu = True
        try:
            args = tuple(_to_cpu(a) if hasattr(a, "vertices") else a for a in args)
            kwargs = {k: (_to_cpu(v) if hasattr(v, "vertices") else v) for k, v in kwargs.items()}
            return orig(klass, *args, **kwargs)
        finally:
            _state.cpu = False

    cls.execute = classmethod(execute)


def install():
    # The REGISTERED classes: ComfyUI imports comfy_extras/nodes_*.py under the
    # bare file stem, so importing comfy_extras.nodes_mesh_postprocess here would
    # patch a second, unused copy. Built-in extras load before custom nodes.
    import nodes
    n = 0
    for name in MESH_NODES:
        cls = nodes.NODE_CLASS_MAPPINGS.get(name)
        if cls is not None and hasattr(cls, "execute"):
            _wrap(cls)
            n += 1
    logging.info("bobble_comfy_fixes: %d mesh nodes run on the CPU on Apple Silicon", n)


install()
`;
