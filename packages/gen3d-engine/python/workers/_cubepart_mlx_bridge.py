"""Swap CubePart's PyTorch DiT for the MLX one, leaving the pipeline intact.

Only the denoiser moves. The VAE, the text encoder, the scheduler and the
geometry extraction stay exactly as they are — they were all verified correct
and they run once, not once per step, so porting them would add risk for no
wall-clock gain. This installs a shim in the one place the sampling loop
touches: `system.diffusion_model`.

Two pieces deliberately stay in PyTorch even inside the shim, both because they
are shape/timestep-only (no weights, no per-step cost worth counting) and both
because reimplementing them is silently wrong-able:

  the rotary table    depends only on (parts, latents, text length)
  the timestep sinusoid   is conditioned by ~1e6 — see _cubepart_mlx._temb

METAL PRECISION. This machine's default MLX matmul path is ~8e-4 accurate in
float32 (measured against float64; MLX's own CPU backend is 4.7e-7, PyTorch CPU
3.8e-7). Compiling for an older GPU arch selects the precise kernel and takes
the whole 27-block forward from 1.7e-2 to 9e-6 against PyTorch — at 4.49 s vs
1.96 s per forward. Which one is correct enough is a question about the
sampler, not the kernel, so it is a flag rather than a hardcoded choice.
"""

from __future__ import annotations

import gc
import os
from pathlib import Path

import numpy as np
import torch

# MUST precede `import mlx.core` — MLX picks its Metal compile target when the
# library initialises, so setting this afterwards silently does nothing.
if os.environ.get("PI_CUBEPART_MLX_PRECISE", "1") == "1":
    os.environ.setdefault("MLX_METAL_GPU_ARCH", "applegpu_g14g")

import mlx.core as mx  # noqa: E402

from _cubepart_mlx import CubePartDiT  # noqa: E402

# MLX keeps the buffers a forward pass frees in a cache for the next one, and
# lets that cache grow without bound. The first denoise step of this DiT
# (18 rows x 9 slots x 1024 latents through 27 blocks) allocates several GB
# of temporaries that then sit cached next to the 8.6 GB of weights — on a
# 24 GB Mac, through the app, that first step is where the kernel went
# critical. A gigabyte of cache keeps the steady state fast; the rest goes
# back to the machine between steps.
mx.set_cache_limit(1 << 30)
from _cubepart_mlx_weights import load_weights  # noqa: E402


def _note(text: str) -> None:
    """A line in the job's progress stream (the worker's stage), best-effort."""
    try:
        from _progress import progress

        progress("segment", text)
    except Exception:  # noqa: BLE001 — a note must never break the run
        pass


class MlxDiT(torch.nn.Module):
    """Presents the PyTorch DiT's calling convention; computes in MLX."""

    def __init__(self, model: CubePartDiT, pos_embed, time_proj) -> None:
        super().__init__()
        self._mlx = model
        self._pos_embed = pos_embed
        self._time_proj = time_proj
        self._rope_cache: dict = {}
        # The text conditioning and the part mask are computed once per job and
        # then reused by every step, but they are the two biggest things
        # crossing into MLX (the embeddings are 18 x 192 x 2560 = 35 MB). Cache
        # them on the buffer address, holding a reference so the address cannot
        # be recycled under us while the entry is live.
        self._const_cache: dict = {}
        self._reported = False

    def _const(self, name: str, t: torch.Tensor, build):
        key = (t.data_ptr(), tuple(t.shape), str(t.dtype))
        hit = self._const_cache.get(name)
        if hit is None or hit[0] != key:
            # One entry PER NAME: keyed only by the buffer, the mask and the
            # embeddings would evict each other on every step and cache nothing.
            hit = (key, t, build(t))
            self._const_cache[name] = hit
        return hit[2]

    def _rope(self, img_shapes, txt_seq_lens):
        key = (repr(img_shapes), repr(txt_seq_lens))
        if key not in self._rope_cache:
            with torch.no_grad():
                fi, ft = self._pos_embed(img_shapes, txt_seq_lens, device="cpu")
            self._rope_cache[key] = (
                mx.array(fi.detach().cpu().numpy()),
                mx.array(ft.detach().cpu().numpy()),
            )
        return self._rope_cache[key]

    def forward(  # noqa: PLR0913 — mirrors the signature it replaces
        self,
        hidden_states,
        encoder_hidden_states=None,
        encoder_hidden_states_mask=None,
        timestep=None,
        img_shapes=None,
        txt_seq_lens=None,
        guidance=None,
        attention_kwargs=None,
        return_dict: bool = True,
    ):
        seq = hidden_states.shape[1]
        multi_freqs, txt_freqs = self._rope(img_shapes, txt_seq_lens)
        img_freqs = multi_freqs[:seq]

        with torch.no_grad():
            t_proj = self._time_proj(timestep.float().cpu()).float().numpy()

        mask = None
        if attention_kwargs and attention_kwargs.get("attention_mask") is not None:
            # Bool over KEYS (padded part slots). Additive form so MLX's SDPA
            # sees the same thing torch's does; -1e9 rather than -inf because
            # only keys are masked, never a whole query row, so there is no
            # all-masked softmax to protect and a finite value cannot produce
            # a NaN if that ever changes.
            mask = self._const(
                "mask",
                attention_kwargs["attention_mask"],
                lambda t: mx.array(
                    np.where(t.detach().cpu().numpy().astype(bool), 0.0, -1e9).astype(np.float32)
                ),
            )

        txt_mx = self._const(
            "txt",
            encoder_hidden_states, lambda t: mx.array(t.detach().float().cpu().numpy())
        )
        hs = mx.array(hidden_states.float().cpu().numpy())
        t_mx = mx.array(t_proj)
        # ONE GROUP OF SLOTS PER PASS. Classifier-free guidance stacks the
        # conditional and unconditional batches into 2 x num_multi rows; the
        # gated blocks attend within a group and the joint blocks within a
        # row, so the groups never see each other and running them one after
        # the other is the same arithmetic. MEASURED: the whole batch in one
        # pass peaked at 11.4 GB against 8.6 GB of weights — 2.8 GB of
        # temporaries on top, and through the app that first step is where a
        # 24 GB Mac went critical. Half the rows, half the temporaries.
        num_multi = multi_freqs.shape[0] // seq
        groups = max(1, hs.shape[0] // num_multi)
        if groups > 1 and hs.shape[0] % num_multi == 0:
            outs = []
            for g in range(groups):
                rows = slice(g * num_multi, (g + 1) * num_multi)
                # The mask is over keys within a group and is the same for
                # both halves ([1,1,1,L] from the pipeline); a per-group mask
                # ([G,1,1,L]) is sliced to its row.
                mask_g = mask if mask is None or mask.shape[0] == 1 else mask[g : g + 1]
                out_g = self._mlx(
                    hs[rows], txt_mx[rows], t_mx[rows], img_freqs, txt_freqs, multi_freqs, mask_g
                )
                mx.eval(out_g)
                outs.append(out_g)
            out = mx.concatenate(outs, axis=0)
        else:
            out = self._mlx(hs, txt_mx, t_mx, img_freqs, txt_freqs, multi_freqs, mask)
        mx.eval(out)
        if not self._reported:
            # Once, after the first step: the denoiser's true footprint — the
            # weights plus the temporaries the first forward pass allocated.
            self._reported = True
            _note(
                f"Denoiser after its first step: {mx.get_active_memory() / 1e9:.1f} GB in use, "
                f"{mx.get_peak_memory() / 1e9:.1f} GB peak, {mx.get_cache_memory() / 1e9:.1f} GB cached"
            )
        result = torch.from_numpy(np.array(out, copy=False)).to(hidden_states.device)
        if not return_dict:
            return (result,)
        return result


class _StreamedTensors:
    """The checkpoint as a read-on-demand mapping — one tensor in memory at a time.

    The DiT is 8.6 GB of float32. `load_file` read all of it into a numpy dict
    while the torch copy was still resident and the MLX copy was being built:
    three DiTs, ~26 GB on a 24 GB Mac. MEASURED, that is the "swapping at
    25–60k pages/s for twenty seconds" the memory guard now ends a job for.
    `safe_open` hands back one tensor per key instead, and load_weights turns
    each into an mx array before the next is read.
    """

    def __init__(self, path: Path) -> None:
        from safetensors import safe_open

        self._path = path
        with safe_open(str(path), framework="pt") as f:
            self._keys = list(f.keys())
        self._file = None

    def __contains__(self, key: str) -> bool:
        return key in self._keys

    def __iter__(self):
        return iter(self._keys)

    def __len__(self) -> int:
        return len(self._keys)

    def __getitem__(self, key: str) -> np.ndarray:
        from safetensors import safe_open

        if self._file is None:
            self._file = safe_open(str(self._path), framework="pt").__enter__()
        return self._file.get_tensor(key).float().numpy()

    def close(self) -> None:
        """Unmap the checkpoint. Its 8.6 GB of clean pages are reclaimable
        either way, but a mapping keeps them counted as active; unmapped, the
        kernel drops them first when the first denoise step asks for room."""
        if self._file is not None:
            self._file.__exit__(None, None, None)
            self._file = None


def install(
    system,
    checkpoint_path: str | Path,
    *,
    num_layers: int | None = None,
    multi_index: tuple[int, ...] | None = None,
) -> MlxDiT:
    """Replace `system.diffusion_model` with the MLX denoiser and free the torch one.

    THE TORCH DiT GOES FIRST. It is only needed for two weightless parts
    (pos_embed, time_proj) and its layer count; keeping its 8.6 GB alive while
    the MLX copy was built was the memory doubling that put this stage into
    swap on every 24 GB Mac.

    `num_layers` / `multi_index` are the checkpoint's shape when the torch DiT
    was built WITHOUT its blocks (cubepart_worker does that on the MLX path so
    the 8.5 GB of block weights never enter torch at all); otherwise they are
    read off the torch model as before.
    """
    torch_dit = system.diffusion_model
    if num_layers is None:
        num_layers = len(torch_dit.transformer_blocks)
    if multi_index is None:
        multi_index = tuple(int(i) for i in torch_dit.multi_attention_layer_index)
    pos_embed = torch_dit.pos_embed
    time_proj = torch_dit.time_text_embed.time_proj
    system.diffusion_model = None
    del torch_dit
    gc.collect()
    try:
        torch.mps.empty_cache()
    except Exception:  # noqa: BLE001 — no MPS, nothing to empty
        pass

    model = CubePartDiT(num_layers=num_layers, multi_index=multi_index)
    mx.reset_peak_memory()
    # WEIGHTS IN HALF PRECISION, ARITHMETIC IN FULL. The checkpoint is 8.6 GB
    # of float32; stored as float16 it is 4.3 GB, and MLX promotes every
    # matmul with a float32 activation to float32, so only the weights are
    # rounded (2^-11 relative). MEASURED on the real blocks (9 rows, precise
    # kernels): relative rms error 1.0e-3 against float32 storage, max
    # 7.3e-3 on values up to 8.6 — bfloat16 storage was 9.8e-3, the level
    # (1.7e-2) at which the pipeline's parts stopped crossing the iso-surface,
    # and is not offered. The 4.3 GB is what lets the first denoise step fit
    # beside the app on a 24 GB Mac; PI_CUBEPART_MLX_WEIGHTS=fp32 restores
    # the full-width weights for an A/B.
    dtype = mx.float32 if os.environ.get("PI_CUBEPART_MLX_WEIGHTS", "fp16") == "fp32" else mx.float16
    streamed = _StreamedTensors(Path(checkpoint_path))
    load_weights(model, streamed, dtype=dtype)
    mx.eval(model.parameters())
    streamed.close()
    mx.clear_cache()
    _note(
        f"Denoiser in MLX: {mx.get_active_memory() / 1e9:.1f} GB of {'float16' if dtype == mx.float16 else 'float32'} weights "
        f"({mx.get_peak_memory() / 1e9:.1f} GB peak while loading)"
    )

    shim = MlxDiT(model, pos_embed, time_proj)
    system.diffusion_model = shim
    gc.collect()
    return shim


def release(system) -> None:
    """Drop the MLX denoiser once the last step has run — 8.6 GB back before
    the extraction (torch, CPU) allocates its own."""
    shim = system.diffusion_model
    system.diffusion_model = None
    if isinstance(shim, MlxDiT):
        shim._mlx = None
        shim._const_cache.clear()
        shim._rope_cache.clear()
    del shim
    gc.collect()
    mx.clear_cache()
