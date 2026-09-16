"""ARDY's text encoder — LLM2Vec (bidirectional Llama-3-8B-Instruct + two LoRA
adapters) — in MLX, merged once and quantized.

ARDY conditions a clip on ONE 4096-d vector per prompt, mean-pooled from
`McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised`. Upstream runs
it in PyTorch on the CPU: 16 GB of bfloat16 weights plus PEFT stacking two
adapters — on a 24 GB Mac that is a swap storm (MEASURED on a fresh cache:
50–75k pages/s for the twenty seconds of "Reading the prompt", which the memory
guard rightly ends a job for). The earlier "8 GB in bf16" was wrong by half:
Llama-3-8B is eight billion parameters, sixteen gigabytes at two bytes each.

So the same computation is done once, streamed, and kept: every projection
gets both LoRA deltas folded in (exact — LoRA is additive: W' = W + α/r·B·A for
each adapter in turn) in float32 and is quantized to `bits` for MLX. One
tensor is in memory at a time while baking, the result is a few safetensors
shards under the engine's models dir, and reading a sentence afterwards is
sub-second on ~9.5 GB (8-bit) instead of ~11 s on 16 GB that does not fit.

What LLM2Vec does around the transformer is replicated here line for line
(tokenize/prepare_for_tokenization/get_pooling in ardy/model/llm2vec):
the Llama-3 user header around the text, the `!@#$%^&*()` instruction split
that makes the embed mask cover the text tokens + `<|eot_id|>` only, and
mean pooling over exactly those positions of the final-normed hidden states.
Validated against the fp32 PyTorch embedding cached for "A person walks
forward." — see BAKED_NOTE / the numbers in motion_worker.py.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Callable

import numpy as np

SEPARATOR = "!@#$%^&*()"
BASE_REPO = "meta-llama/Meta-Llama-3-8B-Instruct"
MNTP_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUPERVISED_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
LAYERS_PER_SHARD = 8
# The baked folder's name carries the quantization so a different choice is a
# different folder, never a silently reused one.
BAKED_DIR_NAME = "ardy-text-encoder-mlx-{bits}bit"


def baked_dir(models_dir: Path, bits: int) -> Path:
    return models_dir / BAKED_DIR_NAME.format(bits=bits)


def is_baked(out: Path) -> bool:
    """A complete bake: the manifest is written LAST, after every shard."""
    return (out / "bobble-bake.json").exists()


# ── the one-time bake ────────────────────────────────────────────────────────


def bake(
    out: Path,
    *,
    base_snapshot: Path,
    mntp_snapshot: Path,
    supervised_snapshot: Path,
    bits: int = 8,
    group_size: int = 64,
    note: Callable[[str], None] | None = None,
) -> Path:
    """Merge both adapters into the base weights and quantize them for MLX.

    Streams the base's shards one tensor at a time (safetensors `safe_open`),
    so the peak is one float32 projection (~235 MB) plus the shard being
    assembled (~2 GB at 8-bit), never the 16 GB model.
    """
    import mlx.core as mx
    import torch
    from safetensors import safe_open

    say = note or (lambda _m: None)
    tmp = out.with_name(out.name + ".partial")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    config = json.loads((mntp_snapshot / "config.json").read_text())
    n_layers = int(config["num_hidden_layers"])

    def lora(snapshot: Path) -> tuple[dict, float]:
        cfg = json.loads((snapshot / "adapter_config.json").read_text())
        scale = float(cfg["lora_alpha"]) / float(cfg["r"])
        assert not cfg.get("use_rslora", False), "rslora scaling is not handled"
        tensors: dict[str, torch.Tensor] = {}
        with safe_open(str(snapshot / "adapter_model.safetensors"), framework="pt") as f:
            for k in f.keys():
                tensors[k] = f.get_tensor(k).float()
        return tensors, scale

    adapters = [lora(mntp_snapshot), lora(supervised_snapshot)]

    index = json.loads((base_snapshot / "model.safetensors.index.json").read_text())["weight_map"]
    handles: dict[str, object] = {}

    def base(key: str) -> torch.Tensor:
        file = index[key]
        if file not in handles:
            handles[file] = safe_open(str(base_snapshot / file), framework="pt").__enter__()
        return handles[file].get_tensor(key)

    def merged(key: str) -> torch.Tensor:
        """A projection with every adapter's delta folded in, float32."""
        w = base(key).float()
        for tensors, scale in adapters:
            stem = key.replace("model.", "base_model.model.", 1).removesuffix(".weight")
            a = tensors.get(f"{stem}.lora_A.weight")
            b = tensors.get(f"{stem}.lora_B.weight")
            if a is None or b is None:
                raise RuntimeError(f"adapter has no LoRA pair for {key}")
            w = w + scale * (b @ a)
        return w

    def quantized(prefix: str, w: torch.Tensor, into: dict) -> None:
        wq, scales, biases = mx.quantize(mx.array(w.numpy()), group_size=group_size, bits=bits)
        into[f"{prefix}.weight"] = wq
        into[f"{prefix}.scales"] = scales
        into[f"{prefix}.biases"] = biases

    def bf16(w: torch.Tensor):
        return mx.array(w.float().numpy()).astype(mx.bfloat16)

    shard_files: list[str] = []
    shard: dict = {"model.embed_tokens.weight": bf16(base("model.embed_tokens.weight"))}
    for i in range(n_layers):
        say(f"Preparing the text encoder (one time) — layer {i + 1}/{n_layers}")
        pre = f"model.layers.{i}"
        for proj in ("q_proj", "k_proj", "v_proj", "o_proj"):
            quantized(f"{pre}.self_attn.{proj}", merged(f"{pre}.self_attn.{proj}.weight"), shard)
        for proj in ("gate_proj", "up_proj", "down_proj"):
            quantized(f"{pre}.mlp.{proj}", merged(f"{pre}.mlp.{proj}.weight"), shard)
        for norm in ("input_layernorm", "post_attention_layernorm"):
            shard[f"{pre}.{norm}.weight"] = bf16(base(f"{pre}.{norm}.weight"))
        if (i + 1) % LAYERS_PER_SHARD == 0 or i + 1 == n_layers:
            if i + 1 == n_layers:
                shard["model.norm.weight"] = bf16(base("model.norm.weight"))
            mx.eval(*shard.values())
            name = f"model-{len(shard_files) + 1:02d}.safetensors"
            mx.save_safetensors(str(tmp / name), shard)
            shard_files.append(name)
            shard = {}
            mx.clear_cache()

    for h in handles.values():
        h.__exit__(None, None, None)  # type: ignore[attr-defined]

    for f in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config.json"):
        shutil.copyfile(mntp_snapshot / f, tmp / f)
    (tmp / "bobble-bake.json").write_text(
        json.dumps(
            {
                "base": BASE_REPO,
                "adapters": [MNTP_REPO, SUPERVISED_REPO],
                "quantization": {"bits": bits, "group_size": group_size},
                "shards": shard_files,
                "layers": n_layers,
            },
            indent=2,
        )
        + "\n"
    )
    if out.exists():
        shutil.rmtree(out)
    tmp.rename(out)
    return out


# ── the model ────────────────────────────────────────────────────────────────


def _build(config: dict, bits: int, group_size: int):
    """The LLM2Vec trunk: Llama with NO causal mask, quantized projections.

    Attribute names mirror the Hugging Face checkpoint (model.layers.N.self_attn
    .q_proj …) so the baked shards load by name.
    """
    import mlx.core as mx
    import mlx.nn as nn

    dims = int(config["hidden_size"])
    n_heads = int(config["num_attention_heads"])
    n_kv = int(config["num_key_value_heads"])
    head_dim = dims // n_heads
    inter = int(config["intermediate_size"])
    eps = float(config["rms_norm_eps"])
    theta = float(config.get("rope_theta", 500000.0))

    class Attention(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.q_proj = nn.Linear(dims, n_heads * head_dim, bias=False)
            self.k_proj = nn.Linear(dims, n_kv * head_dim, bias=False)
            self.v_proj = nn.Linear(dims, n_kv * head_dim, bias=False)
            self.o_proj = nn.Linear(n_heads * head_dim, dims, bias=False)

        def __call__(self, x):
            b, n, _ = x.shape
            q = self.q_proj(x).reshape(b, n, n_heads, head_dim).transpose(0, 2, 1, 3)
            k = self.k_proj(x).reshape(b, n, n_kv, head_dim).transpose(0, 2, 1, 3)
            v = self.v_proj(x).reshape(b, n, n_kv, head_dim).transpose(0, 2, 1, 3)
            q = mx.fast.rope(q, head_dim, traditional=False, base=theta, scale=1.0, offset=0)
            k = mx.fast.rope(k, head_dim, traditional=False, base=theta, scale=1.0, offset=0)
            # Bidirectional: every token attends to every token (mask=None).
            o = mx.fast.scaled_dot_product_attention(q, k, v, scale=head_dim**-0.5, mask=None)
            return self.o_proj(o.transpose(0, 2, 1, 3).reshape(b, n, -1))

    class Mlp(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.gate_proj = nn.Linear(dims, inter, bias=False)
            self.up_proj = nn.Linear(dims, inter, bias=False)
            self.down_proj = nn.Linear(inter, dims, bias=False)

        def __call__(self, x):
            return self.down_proj(nn.silu(self.gate_proj(x)) * self.up_proj(x))

    class Block(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.self_attn = Attention()
            self.mlp = Mlp()
            self.input_layernorm = nn.RMSNorm(dims, eps=eps)
            self.post_attention_layernorm = nn.RMSNorm(dims, eps=eps)

        def __call__(self, x):
            x = x + self.self_attn(self.input_layernorm(x))
            return x + self.mlp(self.post_attention_layernorm(x))

    class Trunk(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.embed_tokens = nn.Embedding(int(config["vocab_size"]), dims)
            self.layers = [Block() for _ in range(int(config["num_hidden_layers"]))]
            self.norm = nn.RMSNorm(dims, eps=eps)

        def __call__(self, ids):
            x = self.embed_tokens(ids).astype(mx.float32)
            for layer in self.layers:
                x = layer(x)
            return self.norm(x)

    class Model(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.model = Trunk()

        def __call__(self, ids):
            return self.model(ids)

    model = Model()
    nn.quantize(
        model,
        group_size=group_size,
        bits=bits,
        class_predicate=lambda _p, m: isinstance(m, nn.Linear),
    )
    return model


class Llm2VecMlx:
    """Drop-in for ardy's LLM2VecEncoder: `encoder(texts) -> (feat, lengths)`
    with feat [B, 1, 4096] float32 and lengths all 1."""

    def __init__(self, folder: Path) -> None:
        import mlx.core as mx
        from transformers import AutoTokenizer

        self.folder = Path(folder)
        bake_info = json.loads((self.folder / "bobble-bake.json").read_text())
        config = json.loads((self.folder / "config.json").read_text())
        q = bake_info["quantization"]
        self.model = _build(config, int(q["bits"]), int(q["group_size"]))
        weights: list = []
        for name in bake_info["shards"]:
            weights.extend(mx.load(str(self.folder / name)).items())
        self.model.load_weights(weights, strict=True)
        mx.eval(self.model.parameters())
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.folder))
        self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"
        self.max_length = 512
        self.doc_max_length = 400
        self.name_or_path = config.get("_name_or_path", "")

    # LLM2Vec.encode → _convert_to_str → prepare_for_tokenization → tokenize
    def _convert_to_str(self, text: str) -> str:
        tok = lambda t: self.tokenizer(  # noqa: E731
            t, truncation=True, max_length=self.max_length, add_special_tokens=False
        )["input_ids"]
        n = len(tok(text))
        while n > self.doc_max_length:
            ratio = self.doc_max_length / n
            text = " ".join(text.split()[: int(len(text.split()) * ratio)])
            n = len(tok(text))
        return f"{SEPARATOR}{text}"  # instruction is always "" for ARDY

    def _prepare(self, text: str) -> str:
        if self.name_or_path == BASE_REPO:
            return "<|start_header_id|>user<|end_header_id|>\n\n" + text.strip() + "<|eot_id|>"
        return text

    def _tokens(self, text: str) -> tuple[list[int], int]:
        """Token ids of the whole prompt and how many trailing ones are the text."""
        parts = text.split(SEPARATOR)
        tail = parts[1] if len(parts) > 1 else ""
        whole = "".join(parts)
        ids = self.tokenizer(
            whole, truncation=True, max_length=self.max_length, add_special_tokens=True
        )["input_ids"]
        tail_ids = self.tokenizer(
            tail, truncation=True, max_length=self.max_length, add_special_tokens=False
        )["input_ids"]
        return ids, len(tail_ids)

    def embed(self, text: str) -> np.ndarray:
        import mlx.core as mx

        ids, n_text = self._tokens(self._prepare(self._convert_to_str(text)))
        hidden = self.model(mx.array([ids]))[0]  # [T, dims] float32
        # get_pooling, mean mode with skip_instruction: the LAST n_text
        # positions; n_text == 0 means the whole sequence (Python's [-0:]).
        pooled = hidden[-n_text:].mean(axis=0) if n_text > 0 else hidden.mean(axis=0)
        mx.eval(pooled)
        return np.array(pooled, dtype=np.float32)

    def __call__(self, texts):
        import torch

        is_string = isinstance(texts, str)
        batch = [texts] if is_string else list(texts)
        feats = np.stack([self.embed(t) for t in batch], axis=0)[:, None, :]  # [B, 1, D]
        lengths = [1] * len(batch)
        out = torch.from_numpy(feats)
        if is_string:
            return out[0], lengths[0]
        return out, lengths
