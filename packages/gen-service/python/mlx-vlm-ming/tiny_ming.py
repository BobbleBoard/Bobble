"""A tiny Ming-Image-0.1-Design checkpoint with random weights, on disk.

Same layout the real MLX conversions use (nativ-community's 4-bit and 8-bit,
mlx-vlm's convert.py): a merged `text_encoder/`, `transformer/` and `vae/` in
MLX format, config-only `mllm/`, `connector/` and `mlp/`, a tokenizer in
`mllm/`, and the scheduler config. Every shape is shrunk: a 3-layer MoE
encoder with 4 experts, a 2-layer DiT, a narrow VAE. It builds in about a
second, weighs ~3 MB, and runs the REAL mlx-vlm pipeline end to end at
256x256, so the patches in patches/ (and later the Bobble driver) are tested
on the code they change, with no download.

Needs the design env (mlx + the mlx-vlm wheel). Used by test_patches.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import mlx.core as mx  # noqa: E402
from mlx.utils import tree_flatten  # noqa: E402

LLM = {
    "hidden_size": 64,
    "num_hidden_layers": 3,
    "num_experts": 4,
    "num_experts_per_tok": 2,
    "num_shared_experts": 1,
    "first_k_dense_replace": 1,
    "n_group": 2,
    "topk_group": 1,
    "moe_router_topk_scaling_factor": 2.5,
    "partial_rotary_factor": 0.5,
    "rope_theta": 600000,
    "num_attention_heads": 2,
    "num_key_value_heads": 1,
    "head_dim": 32,
    "moe_intermediate_size": 32,
    "intermediate_size": 64,
    "vocab_size": 128,
    "norm_topk_prob": True,
    "rms_norm_eps": 1e-6,
    "image_patch_token": 125,
    "image_start_token": 126,
    "image_end_token": 127,
}
CONNECTOR = {
    "architectures": ["Qwen2ForCausalLM"],
    "hidden_size": 32,
    "num_hidden_layers": 2,
    "num_attention_heads": 2,
    "num_key_value_heads": 1,
    "intermediate_size": 64,
    "rope_theta": 1000000.0,
    "rms_norm_eps": 1e-6,
    "vocab_size": 128,
}
BRIDGE = {
    "diffusion_c_input_dim": 16,
    "diffusion_inner_dim": 128,  # = the DiT's dim: cap_feats_2 joins its tokens
    "img_gen_scales": [2],  # 2x2 = 4 learnable query tokens
    "selected_hidden_states_layers": [1, 2, 3],
}
DIT = {
    "_class_name": "DiffusionTransformer",
    "dim": 128,
    "n_heads": 1,
    "n_kv_heads": 1,
    "n_layers": 2,
    "n_refiner_layers": 1,
    "intermediate_size": 128,
    "axes_dims": [32, 48, 48],
    "cap_feat_dim": 16,
    "in_channels": 16,
    "all_patch_size": [2],
    "all_f_patch_size": [1],
    "rope_theta": 256.0,
    "norm_eps": 1e-5,
    "t_scale": 1000.0,
}
VAE = {
    "_class_name": "AutoencoderKLQwenImage",
    "z_dim": 16,
    "base_dim": 8,
    "dim_mult": [1, 2, 4, 4],  # three downsamples: the pipeline's 8x latent
    "num_res_blocks": 1,
    "temperal_downsample": [False, True, True],
    "input_channels": 4,
    "scaling_factor": 8.0064,
    "shift_factor": 0.0,
}
WORDS = (
    "a an the red blue green poster word sign bold title headline logo button "
    "screen card clean minimal background transparent with and of on for in "
    "hello bobble kyoto design ui app first second third"
).split()
CHAT_TEMPLATE = (
    "{% for m in messages %}{{ m['role'] }} {{ m['content'] }} {% endfor %}"
    "{% if add_generation_prompt %}assistant{% endif %}"
)


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2))


def _save(directory: Path, model, config: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    weights = dict(tree_flatten(model.parameters()))
    mx.save_safetensors(str(directory / "model.safetensors"), weights)
    _write_json(directory / "config.json", config)


def _write_tokenizer(directory: Path) -> None:
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast

    vocab = {
        w: i for i, w in enumerate(["<unk>", "<pad>", "user", "assistant", *WORDS])
    }
    assert max(vocab.values()) < LLM["image_patch_token"]
    tokenizer = Tokenizer(models.WordLevel(vocab=vocab, unk_token="<unk>"))
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    fast = PreTrainedTokenizerFast(
        tokenizer_object=tokenizer, unk_token="<unk>", pad_token="<pad>"
    )
    fast.chat_template = CHAT_TEMPLATE
    fast.save_pretrained(str(directory))


def write_configs(root: str | Path) -> Path:
    """The config files alone: enough for MingImageConfig.from_model_path."""
    root = Path(root)
    _write_json(
        root / "mllm" / "config.json",
        {
            "architectures": ["BailingMM2NativeForConditionalGeneration"],
            "llm_config": LLM,
        },
    )
    _write_json(root / "connector" / "config.json", CONNECTOR)
    _write_json(root / "mlp" / "config.json", BRIDGE)
    _write_json(root / "transformer" / "config.json", DIT)
    _write_json(root / "vae" / "config.json", VAE)
    _write_json(
        root / "scheduler" / "scheduler_config.json",
        {"num_train_timesteps": 1000, "shift": 6.0},
    )
    return root


def random_encoder(root: str | Path, seed: int = 0):
    """A MingImageTextEncoder for the checkpoint at ``root``, random but seeded."""
    from mlx_vlm.models.ming_image.config import MingImageConfig
    from mlx_vlm.models.ming_image.text_encoder import MingImageTextEncoder

    config = MingImageConfig.from_model_path(root)
    mx.random.seed(seed)
    encoder = MingImageTextEncoder(config)
    # Upstream starts the learnable query tokens at zero; random ones keep the
    # conditioning (and so every picture) sensitive to the weights.
    encoder.query_tokens = mx.random.normal(encoder.query_tokens.shape) * 0.5
    mx.eval(encoder.parameters())
    return encoder


def save_encoder(root: str | Path, encoder, quantization: dict | None = None) -> None:
    """Write ``encoder`` (float or quantized) as the checkpoint's text_encoder/."""
    config: dict = {"mlx_format": True}
    if quantization is not None:
        config["quantization"] = quantization
    _save(Path(root) / "text_encoder", encoder, config)


def make_tiny_checkpoint(root: str | Path, seed: int = 0) -> Path:
    """Write a complete, float, random tiny checkpoint to ``root``."""
    from mlx_vlm.models.ming_image.config import MingImageConfig
    from mlx_vlm.models.ming_image.transformer import MingImageTransformer
    from mlx_vlm.models.ming_image.vae import build_vae

    root = write_configs(root)
    _write_tokenizer(root / "mllm")
    config = MingImageConfig.from_model_path(root)
    save_encoder(root, random_encoder(root, seed))
    mx.random.seed(seed + 1)
    transformer = MingImageTransformer(config.dit)
    mx.eval(transformer.parameters())
    _save(root / "transformer", transformer, {**DIT, "mlx_format": True})
    vae = build_vae(config.vae)
    mx.eval(vae.parameters())
    _save(root / "vae", vae, {**VAE, "mlx_format": True})
    return root
