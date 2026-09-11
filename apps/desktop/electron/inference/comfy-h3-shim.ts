/**
 * A ONE-FUNCTION SHIM DROPPED INTO THE USER'S ComfyUI SO MiniMax H3 LOADS.
 *
 * ## Why this exists at all
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

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
`;
