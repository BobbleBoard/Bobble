"""ARDY's text encoder in MLX (workers/_llm2vec_mlx.py), on a toy model.

The real thing is 16 GB of Llama and was validated against the cached fp32
PyTorch embedding (cosine 0.99993 — the number lives in motion_worker.py).
What can be pinned without those weights is everything around the transformer:

  - the bake folds BOTH LoRA adapters into every projection, exactly
    (W + α/r·B₁A₁ + α/r·B₂A₂, then quantized — recovered here by dequantizing);
  - the baked folder is complete and loads back through the same names;
  - the LLM2Vec prompt handling: the Llama-3 user header, the instruction
    separator, and mean pooling over the LAST n text tokens only.

Run: python tests/run.py   (from packages/gen3d-engine/python; needs mlx +
torch + safetensors — the ardy or cube venv)
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

from _skip import Skip

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "workers"))


def _deps():
    try:
        import mlx.core as mx  # noqa: F401
        import torch  # noqa: F401
        from safetensors.torch import save_file  # noqa: F401
    except ImportError as err:
        why = "needs mlx + torch + safetensors — run from the ardy or cube venv"
        if "pytest" in sys.modules:  # under pytest a Skip would count as a failure
            sys.modules["pytest"].skip(why)
        raise Skip(why) from err


TOY = {
    "_name_or_path": "meta-llama/Meta-Llama-3-8B-Instruct",
    "hidden_size": 64,
    "num_attention_heads": 4,
    "num_key_value_heads": 2,
    "intermediate_size": 96,
    "num_hidden_layers": 2,
    "rms_norm_eps": 1e-5,
    "rope_theta": 500000.0,
    "vocab_size": 256,
}


def _toy_snapshots(root: Path, seed: int = 0):
    """A base + two adapters laid out exactly like the Hugging Face repos."""
    import torch
    from safetensors.torch import save_file

    g = torch.Generator().manual_seed(seed)
    d, h, kv, inter, layers = 64, 4, 2, 96, 2
    hd = d // h
    base = root / "base"
    base.mkdir()
    weights: dict[str, torch.Tensor] = {
        "model.embed_tokens.weight": torch.randn(TOY["vocab_size"], d, generator=g) * 0.1,
        "model.norm.weight": torch.ones(d),
        "lm_head.weight": torch.randn(TOY["vocab_size"], d, generator=g),
    }
    shapes = {
        "self_attn.q_proj": (h * hd, d),
        "self_attn.k_proj": (kv * hd, d),
        "self_attn.v_proj": (kv * hd, d),
        "self_attn.o_proj": (d, h * hd),
        "mlp.gate_proj": (inter, d),
        "mlp.up_proj": (inter, d),
        "mlp.down_proj": (d, inter),
    }
    for i in range(layers):
        for name, (o, n) in shapes.items():
            weights[f"model.layers.{i}.{name}.weight"] = torch.randn(o, n, generator=g) * 0.05
        weights[f"model.layers.{i}.input_layernorm.weight"] = torch.ones(d)
        weights[f"model.layers.{i}.post_attention_layernorm.weight"] = torch.ones(d)
    # Two shards, like the real four.
    keys = sorted(weights)
    half = len(keys) // 2
    files = {"model-00001-of-00002.safetensors": keys[:half], "model-00002-of-00002.safetensors": keys[half:]}
    weight_map = {}
    for file, ks in files.items():
        save_file({k: weights[k].to(torch.bfloat16) for k in ks}, str(base / file))
        weight_map.update({k: file for k in ks})
    (base / "model.safetensors.index.json").write_text(json.dumps({"weight_map": weight_map}))

    adapters = []
    for j, name in enumerate(("mntp", "supervised")):
        folder = root / name
        folder.mkdir()
        (folder / "adapter_config.json").write_text(
            json.dumps({"r": 4, "lora_alpha": 8, "use_rslora": False})
        )
        tensors = {}
        for i in range(layers):
            for proj, (o, n) in shapes.items():
                # PEFT's naming, verified on the real adapters:
                # base_model.model.layers.N.mlp.down_proj.lora_A.weight
                stem = f"base_model.model.layers.{i}.{proj}"
                tensors[f"{stem}.lora_A.weight"] = torch.randn(4, n, generator=g) * 0.1
                tensors[f"{stem}.lora_B.weight"] = torch.randn(o, 4, generator=g) * 0.1
        save_file(tensors, str(folder / "adapter_model.safetensors"))
        adapters.append(tensors)
    (root / "mntp" / "config.json").write_text(json.dumps(TOY))
    for f in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"):
        (root / "mntp" / f).write_text("{}")
    return base, root / "mntp", root / "supervised", weights, adapters


def test_the_bake_folds_both_adapters_into_every_projection() -> None:
    _deps()
    import mlx.core as mx
    import torch

    import _llm2vec_mlx as L

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        base, mntp, sup, weights, adapters = _toy_snapshots(root)
        out = L.bake(
            root / "baked",
            base_snapshot=base,
            mntp_snapshot=mntp,
            supervised_snapshot=sup,
            bits=8,
            group_size=32,
        )
        assert L.is_baked(out)
        manifest = json.loads((out / "bobble-bake.json").read_text())
        loaded = {}
        for shard in manifest["shards"]:
            loaded.update(mx.load(str(out / shard)))
        key = "model.layers.1.mlp.down_proj"
        # The base is stored in bfloat16, so the exact answer starts from the
        # rounded base; the adapters are float32 and folded in at full width.
        want = weights[f"{key}.weight"].to(torch.bfloat16).float()
        for tensors in adapters:
            stem = key.replace("model.", "base_model.model.", 1)
            want = want + 2.0 * (tensors[f"{stem}.lora_B.weight"] @ tensors[f"{stem}.lora_A.weight"])
        got = mx.dequantize(
            loaded[f"{key}.weight"], loaded[f"{key}.scales"], loaded[f"{key}.biases"], 32, 8
        )
        err = float(mx.abs(got - mx.array(want.numpy())).max())
        scale = float(want.abs().max())
        # 8-bit over 32-groups: well under a percent of the range. Without the
        # merge the error would be the adapters' whole contribution (~0.1+).
        assert err < 0.01 * scale, (err, scale)
        assert "lm_head.weight" not in loaded  # an encoder has no head
        assert loaded["model.embed_tokens.weight"].dtype == mx.bfloat16


class _FakeTokenizer:
    """Whitespace tokens; the special markers are single tokens too."""

    def __init__(self) -> None:
        self.vocab: dict[str, int] = {}
        self.pad_token = None
        self.padding_side = "right"
        self.eos_token = "<eos>"

    def _id(self, tok: str) -> int:
        return self.vocab.setdefault(tok, 2 + len(self.vocab))

    def __call__(self, text, truncation=True, max_length=512, add_special_tokens=True):
        pieces = text.replace("<|eot_id|>", " <|eot_id|> ").split()
        ids = [self._id(p) for p in pieces][:max_length]
        if add_special_tokens:
            ids = [1, *ids]  # BOS
        return {"input_ids": ids}


def test_pooling_is_the_mean_over_the_text_tokens_only() -> None:
    """LLM2Vec with skip_instruction: the embed mask is the LAST n tokens,
    n = tokens of the text after the separator (text + <|eot_id|>). The
    header and BOS are attended to but not pooled."""
    _deps()
    import mlx.core as mx

    import _llm2vec_mlx as L

    enc = L.Llm2VecMlx.__new__(L.Llm2VecMlx)
    enc.tokenizer = _FakeTokenizer()
    enc.max_length = 512
    enc.doc_max_length = 400
    enc.name_or_path = "meta-llama/Meta-Llama-3-8B-Instruct"
    prepared = enc._prepare(enc._convert_to_str("A person walks forward."))
    assert prepared.startswith("<|start_header_id|>user<|end_header_id|>\n\n" + L.SEPARATOR)
    assert prepared.endswith("<|eot_id|>")
    ids, n = enc._tokens(prepared)
    # "A person walks forward. <|eot_id|>" → 4 words + eot = 5 pooled tokens;
    # BOS + header pieces come before them and are excluded.
    assert n == 5
    assert ids[0] == 1 and len(ids) > n

    calls = []

    class _Model:
        def __call__(self, batch):
            calls.append(batch)
            t = batch.shape[1]
            # hidden[i] = i, so the mean over the last n is the mean of the
            # last n positions — checkable by hand.
            return mx.broadcast_to(mx.arange(t, dtype=mx.float32)[None, :, None], (1, t, 8))

    enc.model = _Model()
    v = enc.embed("A person walks forward.")
    t = len(ids)
    assert v.shape == (8,)
    assert np.allclose(v, np.mean(np.arange(t - n, t)))
    feat, lengths = enc(["A person walks forward.", "A person waves."])
    assert tuple(feat.shape) == (2, 1, 8) and lengths == [1, 1]
