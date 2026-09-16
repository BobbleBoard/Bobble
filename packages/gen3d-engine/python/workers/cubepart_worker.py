"""CubePart worker — mesh + part names → per-part meshes (Roblox/cubepart).

Runs inside the cube venv. The pipeline is pure PyTorch (adapted Qwen-Image /
DINOv2 code, no custom CUDA kernels) but its denoise is broken on MPS at every
dtype, so this stage runs on CPU — see the note in main(). Checkpoints come from
the HF cache snapshot (offline).

Part names come from the UI's prompt field (comma-separated). Without names
CubePart cannot segment (it is part-CONDITIONED decomposition, not automatic
segmentation), so we default to a generic schema and say so in the message.
"""

from __future__ import annotations

import argparse
import gc
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import ROUTER, artifact, patch_tqdm, progress, stage_done  # noqa: E402

STAGE = "segment"
DEFAULT_PARTS = ["main body", "top part", "bottom part", "left part", "right part"]

# Per-part face colours, baked into the exported GLB — so this palette IS UI:
# it is what the user looks at in the viewport after a segment run.
#
# Two things were wrong with the old list.
#   1. Entry 4 was (155, 89, 182) = #9b59b6, hue 283deg — PURPLE, against the
#      standing no-purple brief. Not an edge case either: DEFAULT_PARTS has
#      exactly five entries, so every default segmentation painted a purple
#      part. A DOM hue scan can never catch it because the colour lives in
#      vertex data inside a GLB, which is why it survived the last audit's
#      clean "0 purple hits".
#   2. It shared nothing with .tp-part-swatch in tripo.css, which is the LEGEND
#      for these very colours — the panel drew "Head" with an orange dot while
#      the head in the viewport was red, and had no rule at all past part 3.
#
# These eight are now the single palette, mirrored verbatim by .tp-part-swatch
# and by PART_COLORS in Viewer3D.tsx. Hues: 3, 26, 44, 84, 131, 176, 207, 211 —
# nothing in the 255-320 purple band. Guarded by
# python/tests/test_part_palette.py.
PART_PALETTE = [
    (232, 134, 58),   # #e8863a orange
    (74, 144, 217),   # #4a90d9 blue
    (88, 179, 104),   # #58b368 green
    (217, 180, 74),   # #d9b44a yellow
    (217, 96, 90),    # #d9605a red      (was purple)
    (63, 179, 172),   # #3fb3ac teal
    (154, 192, 95),   # #9ac05f lime
    (151, 163, 173),  # #97a3ad slate
]


def srgb_to_linear(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """PART_PALETTE is written in sRGB, the space its CSS twin lives in.

    glTF's COLOR_0 is LINEAR, and trimesh writes `face_colors` into it verbatim.
    Handing it sRGB bytes makes every renderer decode them a second time, so the
    part came out about a stop too bright: #e8863a orange rendered as pale cream
    and #4a90d9 blue as powder blue, which is exactly the mismatch the legend
    swatches were supposed to be free of. Converting here keeps one palette in
    one space and makes the GLB correct for Blender and every other viewer too,
    not just ours.
    """
    out = []
    for c in rgb:
        u = c / 255.0
        lin = u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
        out.append(round(lin * 255))
    return (out[0], out[1], out[2])

patch_tqdm()
ROUTER.default_stage = STAGE
# CubePart's diffusion loop has no tqdm description, and on CPU it runs for
# ~20 minutes — "Working… (12/30)" for that long tells the user nothing.
ROUTER.fallback_message = "Deciding which surface belongs to which part"


def install_extraction_progress(pipe, parts, evaluator_cls, before_decode=None) -> None:
    """Report the MESH EXTRACTION, which used to run in total silence.

    `input_to_part_shape()` runs the denoise AND the extraction in one call, and
    only the denoise is a tqdm loop — so patch_tqdm's readout froze on
    "Deciding which surface belongs to which part (30/30)" and stayed there for
    the whole extraction. MEASURED on a real run: over five minutes on that one
    stale sentence while the worker was genuinely busy (7 GB RSS, extracting),
    with a ticking elapsed counter as the only sign of life.

    There is no percentage here that would not be a lie. The coarse field pass
    is one shot over the whole batch, and the fine pass is per part but its cost
    per part depends on how much surface that part has, which is not known until
    it has been evaluated. So this reports the PHASE and the part index — both
    things that are true — rather than a bar that invents a denominator.

    Both hooks wrap what the pipeline already calls, so the pipeline call itself
    is untouched:

      * ``pipe.decode_shape`` — an INSTANCE attribute shadowing the bound
        method, which ``self.decode_shape(...)`` inside ``input_to_part_shape``
        picks up. This fires once, the moment the denoise ends.
      * ``evaluator_cls.evaluate`` — it receives the per-part "fine" callback,
        so wrapping that callback yields exactly one event per part, named.
        Pass None (upstream moved it) and the phase label still lands; only the
        per-part detail is lost.
    """
    real_decode = pipe.decode_shape

    def decode_with_progress(*a, **kw):
        if before_decode is not None:
            before_decode()
        progress(STAGE, f"Building part meshes ({len(parts)} parts)…")
        return real_decode(*a, **kw)

    pipe.decode_shape = decode_with_progress

    if evaluator_cls is None:
        return

    real_evaluate = evaluator_cls.evaluate

    def evaluate_with_progress(self, eval_func_coarse, eval_func_fine, *a, **kw):
        def fine(positions, batch_idx):
            name = parts[batch_idx] if batch_idx < len(parts) else f"part {batch_idx + 1}"
            progress(STAGE, f"Building part meshes — {name} ({batch_idx + 1}/{len(parts)})")
            return eval_func_fine(positions, batch_idx)

        result = real_evaluate(self, eval_func_coarse, fine, *a, **kw)
        progress(STAGE, f"Extracting surfaces from {len(parts)} parts…")
        return result

    evaluator_cls.evaluate = evaluate_with_progress



def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cube-dir", required=True)
    ap.add_argument("--parts", default="")
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--guidance-scale", type=float, default=7.5)
    # Upstream default is 8.5; on 24 GB unified memory the shape-VAE
    # extraction attention OOMs at 8.5 AFTER a full 30-step denoise
    # (27.9 GiB allocated, +3 GiB request — reproduced). 7.5 keeps the
    # extraction grid inside the MPS pool.
    ap.add_argument("--resolution-base", type=float, default=7.5)
    ap.add_argument("--seed", type=int, default=0)
    # None -> resolved by device below: the small chunks exist for the MPS pool.
    ap.add_argument("--chunk-size", type=int, default=None)
    ap.add_argument("--device", default="mlx", choices=["mlx", "mps", "cpu"])
    ap.add_argument(
        "--dtype",
        default="float32",
        choices=["float32", "bfloat16"],
        help="bfloat16 is upstream's behaviour and is BROKEN on MPS (see above)",
    )
    args = ap.parse_args()

    parts = [p.strip() for p in args.parts.split(",") if p.strip()] or DEFAULT_PARTS
    # CubePart's pipeline has eight part slots (num_parts = 8 inside
    # input_to_part_shape); a ninth name would index past its sample mask.
    if len(parts) > 8:
        progress(STAGE, f"Keeping the first 8 of {len(parts)} part names (CubePart's limit)")
        parts = parts[:8]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress(STAGE, "Locating CubePart weights…")
    os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "bobble" / "gen3d" / "hf"))
    from huggingface_hub import snapshot_download

    weights = Path(snapshot_download("Roblox/cubepart", local_files_only=True))

    progress(STAGE, "Loading CubePart pipeline (9.9 GB)…")
    import torch
    import trimesh

    # NO `torch.compile` HERE. cube_part decorates its autoencoder norm and
    # attention with `@torch.compile(fullgraph=True)`; inductor builds those
    # kernels with clang++, which a Mac without developer tools does not have
    # (MEASURED on a fresh cache: "InvalidCxxCompiler: No working C++ compiler
    # found" at "Encoding input mesh"), and TORCH_COMPILE_DISABLE left the
    # fullgraph decorator raising "frame is in the Dynamo skipfiles list"
    # instead. The decorator is replaced with the identity before cube_part is
    # imported: the eager path is what every CubePart number here was measured
    # on, and the encoder's few matmuls are not where the minutes go.
    def _eager(*c_args, **c_kwargs):
        if c_args and callable(c_args[0]):
            return c_args[0]
        return lambda fn: fn

    torch.compile = _eager  # type: ignore[assignment]

    sys.path.insert(0, str(Path(args.cube_dir) / "cubepart"))
    from cube_part.pipelines import PartShapeDenoiserPipeline, ShapeInput
    from cube_part.utils.mesh import load_mesh, sample_surface

    use_mlx = args.device == "mlx"
    dit_shape: dict[str, object] = {}
    if use_mlx:
        # THE 8.5 GB OF DiT BLOCKS NEVER ENTER TORCH. Upstream's constructor
        # builds the full transformer (8.6 GB of float32 parameters), then
        # `load_file`s the whole checkpoint into a dict (another 8.6 GB) and
        # copies it in — 17 GB of denoiser next to the 8.9 GB text encoder and
        # the 1.3 GB VAE, before the MLX copy was even built. MEASURED on a
        # fresh cache: "Loading CubePart pipeline" swapped at 22k pages/s and
        # the stage was ended by the memory guard at "Encoding input mesh".
        #
        # On the MLX path the torch DiT is only ever asked for its two
        # weightless parts (pos_embed, time_proj), so it is built with ZERO
        # blocks and the state dict is read without them: 46 MB of embedders
        # and norms instead of 8.6 GB. The blocks go straight from the
        # safetensors into MLX (streamed, one tensor at a time) — see install.
        import cube_part.systems.shape_denoiser as _system_module

        _real_build = _system_module.build_qwenimage_multi_model

        def _blockless_dit(
            model_type, in_channels, condition_channels, num_layers, enable_mrope=False,
            multi_attention_layer_index=None, **kw,
        ):
            dit_shape["num_layers"] = int(num_layers)
            dit_shape["multi_index"] = tuple(int(i) for i in (multi_attention_layer_index or ()))
            return _real_build(model_type, in_channels, condition_channels, 0, enable_mrope, [], **kw)

        def _state_dict_without_blocks(path):
            from safetensors import safe_open

            out = {}
            with safe_open(str(path), framework="pt") as f:
                for key in f.keys():
                    if "transformer_blocks." not in key:
                        out[key] = f.get_tensor(key)
            return out

        _system_module.build_qwenimage_multi_model = _blockless_dit
        _system_module.load_file = _state_dict_without_blocks

    # "mlx" runs the DiT in MLX and keeps every torch tensor on CPU.
    #
    # Putting the torch side back on MPS once the DiT was in MLX looked free —
    # the denoise is only 155s of a 529s run, the text encode (~148s) and the
    # extraction (~169s) are the larger halves. TRIED IT: 30 steps completed and
    # then "CubePart produced no part meshes". So the Metal problem was never
    # the DiT alone. Measured against CPU on the real inputs, the MPS text
    # encoder differs by 4.7e-3 and the shape VAE encode by 1.9e-4 — the same
    # order as the timestep error that put 1.2e-2 through the DiT, and CFG at
    # 7.5 amplifies a cond/uncond difference rather than cancelling it.
    # MPS also made the denoise SLOWER (7.40 vs 4.26 s/step): every step drags
    # the latents MPS -> CPU -> MLX -> CPU -> MPS with a sync at each hop.
    has_mps = torch.backends.mps.is_available()
    device = "cpu" if use_mlx or not has_mps else args.device
    if args.chunk_size is None:
        # 25k is a concession to the MPS pool (extraction, not the denoise, is
        # the memory peak there), so raising it on CPU looked free. MEASURED: at
        # 100k the extraction got SLOWER (~182s vs ~169s on the same mesh), so
        # the small chunks are not costing anything worth reclaiming here.
        args.chunk_size = 25_000

    # THIS STAGE RUNS ON CPU. Not because any single operation is wrong on MPS
    # — every one of them checks out — but because the error they each carry is
    # amplified by classifier-free guidance and compounds over 30 steps.
    #
    #   MPS bfloat16 / float16 / float32   30 steps, then every part fails
    #                                      marching cubes with "Surface level
    #                                      must be within volume data range"
    #   CPU  float32                       4 parts, correct         ← default
    #
    # I first wrote this off as "an MPS kernel defect inside the DiT". That was
    # WRONG, and measuring it properly is what corrected it. One forward pass
    # with identical inputs on each backend:
    #
    #   DiT forward          relative max|diff| 0.005   (std 0.80533 vs 0.80510)
    #   with the part mask   relative max|diff| 0.010, no NaN, no concentration
    #                        in the padded slots
    #   seeded init noise    std 1.0003 vs 1.0004, MPS reproducible
    #   scheduler step()     BIT-IDENTICAL (relative diff 0.000000)
    #   velocity conversion  identical
    #   VAE round trip · text encoder · decode_shape · timesteps   all fine
    #
    # "all fine" on that last line was a round-trip smoke test, and it was too
    # generous. Compared NUMERICALLY against CPU on the real inputs, the MPS
    # text encoder differs by 4.7e-3 and the shape encode by 1.9e-4 — so the
    # Metal error is spread across the whole pipeline, not localised in the DiT.
    # That is why the MLX port keeps the torch side on CPU (see above) instead
    # of only replacing the denoiser and moving the rest back to Metal.
    #
    # Nothing is broken. But ~1% relative error is LARGE for fp32 — a
    # well-conditioned network should agree with CPU to ~1e-5 — which says the
    # MPS matmuls are not carrying true fp32 precision. Guidance 7.5 multiplies
    # the gap between the conditional and unconditional predictions before it is
    # applied, and thirty steps of that walks the trajectory off-distribution
    # until the decoded field no longer crosses the iso-surface.
    #
    # PREDICTED AND CONFIRMED: at guidance 1.5 the MPS run survives — 3 parts,
    # ~13 min. But it is useless. The parts each span 72-100% of the model on
    # every axis (spread 0.075) because low guidance means the part names barely
    # bite: "rotor blades" came out 1.09 x 1.82 x 1.59 where the correct CPU run
    # gives 1.39 x 0.07 x 1.22 — flat, as blades are. Valid geometry, no
    # decomposition. So there is no fast MPS mode worth shipping.
    #
    # CPU costs ~25 min against ~13. Getting to "seconds" needs an MLX port of
    # the DiT, not a setting. `--device mps` is kept so a future torch release
    # can be retested in one run.

    if args.dtype != "bfloat16":
        _orig_autocast = torch.autocast

        class _NoAutocast(_orig_autocast):  # type: ignore[misc,valid-type]
            def __init__(self, device_type, *a, **kw):
                kw["enabled"] = False
                super().__init__(device_type, *a, **kw)

        torch.autocast = _NoAutocast

    config = Path(args.cube_dir) / "cubepart" / "configs" / "shape_denoiser_multimesh.yaml"
    pipe = PartShapeDenoiserPipeline(
        config_path=str(config),
        checkpoint_path=str(weights / "multi_part_dit.safetensors"),
        vae_checkpoint_path=str(weights / "vae.safetensors"),
        device=device,
        extract_geometry_fn_name="extract_geometry_coarse_to_fine",
    )

    if args.dtype != "bfloat16":
        _fwd = pipe.system._forward_diffusion_model
        _evicted = []

        def _fwd_lean(*a, **kw):
            if not _evicted and device == "mps":
                # First sampling step: the text conditioning is already computed.
                try:
                    pipe.system.base_model.to("cpu")
                    torch.mps.empty_cache()
                    progress(STAGE, "Freed the text encoder (8.9 GB) for the denoise")
                except Exception as err:  # noqa: BLE001 — never fail a run over this
                    progress(STAGE, f"could not free the text encoder ({err})")
                _evicted.append(True)
            # The DiT is fp32 but the text embeddings arrive fp16 and the
            # latents bf16, and Metal answers a mixed-dtype matmul by aborting
            # the process rather than raising. Cast at this one boundary.
            cast = lambda t: (  # noqa: E731
                t.float() if torch.is_tensor(t) and t.is_floating_point() else t
            )
            return _fwd(*[cast(x) for x in a], **{k: cast(v) for k, v in kw.items()})

        pipe.system._forward_diffusion_model = _fwd_lean

    if use_mlx:
        # The text encoder is an 8.9 GB LLM run on CPU, and it is handed one
        # sequence per part SLOT — 9 of them, doubled to 18 by classifier-free
        # guidance. But CubePart pads to 8 parts with "", and the negative
        # prompt is one string repeated, so a 3-part request asks it to encode
        # the same handful of strings over and over. Encoding the distinct ones
        # and reindexing is exact (eval mode, no dropout: same string in, same
        # embedding out) and it was ~148s of a 529s run.
        class _DedupEncoder(torch.nn.Module):
            def __init__(self, inner: torch.nn.Module) -> None:
                super().__init__()
                self.inner = inner  # stays a child module, so .to() still works

            def __getattr__(self, name):
                # The pipeline reaches into the encoder for more than forward()
                # (`.processor`, tokenizers, config). Without this the wrapper
                # is a wall rather than a pass-through.
                try:
                    return super().__getattr__(name)
                except AttributeError:
                    inner = self.__dict__.get("_modules", {}).get("inner")
                    if inner is None:
                        raise
                    return getattr(inner, name)

            def forward(self, prompts, *a, **kw):
                if not isinstance(prompts, (list, tuple)) or not all(
                    isinstance(p, str) for p in prompts
                ):
                    return self.inner(prompts, *a, **kw)
                uniq = list(dict.fromkeys(prompts))
                if len(uniq) == len(prompts):
                    return self.inner(prompts, *a, **kw)
                progress(STAGE, f"Encoding {len(uniq)} distinct prompts (of {len(prompts)})…")
                emb, mask = self.inner(uniq, *a, **kw)
                order = {p: i for i, p in enumerate(uniq)}
                idx = torch.tensor([order[p] for p in prompts], device=emb.device)
                return emb[idx], mask[idx]

        class _CachedEncoder(torch.nn.Module):
            """The text encoder's one answer, standing in for the encoder.

            Keeps what the pipeline reaches into besides forward() — the chat
            template's `processor`, `prompt_template_encode`, `hidden_size` —
            and holds NO weights. A different prompt list is a bug in the
            replication above, and says so rather than encoding wrongly.
            """

            def __init__(self, encoder, prompts, states, mask) -> None:
                super().__init__()
                self.processor = encoder.processor
                self.prompt_template_encode = encoder.prompt_template_encode
                self.hidden_size = int(encoder.hidden_size)
                self._prompts = list(prompts)
                self._states = states
                self._mask = mask

            def forward(self, prompts, *a, **kw):
                if list(prompts) != self._prompts:
                    raise RuntimeError(
                        "CubePart asked for prompts the worker did not pre-encode "
                        f"({len(prompts)} vs {len(self._prompts)}); the text encoder "
                        "was released to fit in memory"
                    )
                return self._states, self._mask

        pipe.system.base_model = _DedupEncoder(pipe.system.base_model)

        # THE TEXT ENCODER IS READ AND DROPPED BEFORE THE DENOISER ARRIVES.
        # It is an 8.9 GB Qwen3-VL run once per job, at the top of
        # input_to_part_shape; the 8.6 GB MLX denoiser is needed for every
        # step after. Holding both is 18.8 GB of weights on a 24 GB Mac —
        # the number that put every segment run into swap. So the prompts are
        # built here exactly as the pipeline builds them (pad to 8 parts, the
        # chat template, the negative prompt doubled on for CFG), encoded now,
        # and the encoder is replaced by its answer. The pipeline's own call
        # then costs nothing, and the peak becomes max(encoder, denoiser) +
        # VAE — MEASURED ~11 GB instead of ~27 GB.
        progress(STAGE, "Reading the part names…")
        num_parts = 8
        padded = list(parts[:num_parts]) + [""] * (num_parts - min(len(parts), num_parts))
        prompts = pipe.system.apply_part_text_template([padded])
        if args.guidance_scale > 0.0:
            prompts = prompts + [pipe.system.default_negative_prompt] * len(prompts)
        with torch.no_grad():
            text_states, text_mask = pipe.system.base_model(prompts)
        pipe.system.base_model = _CachedEncoder(pipe.system.base_model, prompts, text_states, text_mask)
        gc.collect()

    # Phase timings, because the shape of this run is not what it looks like:
    # once the DiT is fast, the encode and the extraction are the bill.
    marks: list[tuple[str, float]] = [("load", time.time())]

    def mark(name: str) -> None:
        marks.append((name, time.time()))
        progress(STAGE, f"{name} took {marks[-1][1] - marks[-2][1]:.0f}s")

    # THE MESH IS ENCODED BEFORE THE DENOISER ARRIVES. The shape VAE's encode
    # of 128k surface points is a torch-CPU pass with a couple of GB of
    # temporaries; MEASURED (footprint sampling), with the 8.6 GB MLX DiT
    # already resident it was the run's low point at 29% free, and through
    # the app — the app's own memory on top — the kernel went critical there.
    # Encoded first, its temporaries are gone before the denoiser loads.
    progress(STAGE, "Encoding input mesh…")
    mesh, _, _ = load_mesh(args.mesh)
    surface = sample_surface(mesh, num_samples=128_000)
    # float() BEFORE .to(device): sample_surface yields float64 and MPS
    # cannot receive float64 tensors (verified failure here).
    surface = torch.from_numpy(surface).float().unsqueeze(0).to(pipe.device)
    latents, _ = pipe.encode_shape(surface)
    del surface, mesh
    gc.collect()
    mark("mesh encode")

    if use_mlx:
        # The denoise is 27 transformer blocks run `steps` times; everything
        # else in this pipeline runs once. Moving just that to MLX is what
        # turns ~25 min of CPU into ~2 min, without touching the VAE, the text
        # encoder, the scheduler or the extraction.
        progress(STAGE, "Loading the denoiser into MLX (Metal)…")
        import _cubepart_mlx_bridge

        _cubepart_mlx_bridge.install(
            pipe.system,
            weights / "multi_part_dit.safetensors",
            num_layers=dit_shape["num_layers"],  # type: ignore[arg-type]
            multi_index=dit_shape["multi_index"],  # type: ignore[arg-type]
        )

    # Extraction is the largest phase left (~169s of a 335s run at 10 steps),
    # and it looked like the one place Metal was safe: it runs once, after the
    # last denoise step, so there is no trajectory left for its error to
    # compound along. TRIED IT — decode_shape on MPS made the whole run SLOWER,
    # 399s against 335s, and moved the fuselage extent 0.56 -> 0.59. Marching
    # cubes is the bulk of it and cannot move: use_warp needs CUDA, so it falls
    # back to skimage on the CPU on either path, leaving only the field
    # evaluation on-device to pay for shuttling the shape model across.

    # See install_extraction_progress: without this the readout freezes on
    # "… (30/30)" for the whole extraction.
    try:
        from cube_part.utils.field import ImplicitFieldCoarseToFineEvaluator as _Evaluator
    except Exception:  # noqa: BLE001 — upstream may move it; the phase label still lands
        _Evaluator = None
    install_extraction_progress(
        pipe,
        parts,
        _Evaluator,
        # The last denoise step is the denoiser's last use: 8.6 GB handed back
        # before the extraction's own temporaries (MEASURED ~5 GB) arrive.
        before_decode=(lambda: _cubepart_mlx_bridge.release(pipe.system)) if use_mlx else None,
    )

    progress(STAGE, f"Decomposing into {len(parts)} parts ({args.steps} steps)…")
    part_meshes = pipe.input_to_part_shape(
        ShapeInput(prompt=[parts], latents=latents),
        guidance_scale=args.guidance_scale,
        resolution_base=args.resolution_base,
        scheduler_type="dpm_solver",
        num_inference_steps=args.steps,
        # The extraction grid is the memory peak, not the denoise: fp16 finished
        # all 30 steps at 25.4 GiB and then asked for another 6.10 GiB to decode.
        # Smaller chunks trade a little speed for headroom.
        chunk_size=args.chunk_size,
        seed=args.seed,
        output_mesh=True,
    )
    mark("denoise + extract")

    progress(STAGE, f"Writing {len(parts)} part meshes…")
    scene = trimesh.Scene()
    saved = 0
    palette = PART_PALETTE
    for i, (verts, faces) in enumerate(part_meshes):
        if verts is None:
            continue
        name = parts[i].replace(" ", "_") if i < len(parts) else f"part_{i}"
        submesh = trimesh.Trimesh(verts, faces)
        submesh.visual.face_colors = srgb_to_linear(palette[i % len(palette)])
        submesh.export(str(out_dir / f"part_{i:02d}_{name}.glb"))
        scene.add_geometry(submesh, geom_name=f"part_{i:02d}_{name}")
        saved += 1

    if saved == 0:
        raise RuntimeError("CubePart produced no part meshes")
    combined = out_dir / "parts.glb"
    scene.export(str(combined))
    artifact(STAGE, "model-glb", str(combined), f"Segmented parts ({saved})")
    stage_done(STAGE, f"Segmented into {saved} parts")


if __name__ == "__main__":
    main()
