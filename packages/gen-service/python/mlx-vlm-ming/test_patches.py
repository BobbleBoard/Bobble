#!/usr/bin/env python3
"""
Tests for the four patches in patches/, run on the real mlx-vlm code with the
tiny random checkpoint from tiny_ming.py: no weights downloaded, well under a
minute on the GPU in all.

They need the design env (mlx plus the mlx-vlm wheel), so the plain
`python3 -m unittest` that covers worker.py does not collect them (this folder
is not a package). Run them in the env the app builds (README.md, "Verify"):

  uv run --no-project --python 3.12 --no-build --exclude-newer 2026-09-24T00:00:00Z \\
    --with ../wheels/mlx_vlm-0.7.3.dev0+bobble.ming-py3-none-any.whl \\
    python -m unittest -v test_patches

The before/after: with the stock commit's wheel (`STOCK=1 OUT=<dir> sh
build-wheel.sh`, then `--with` that) every patch test fails and the fixture
tests pass. With the shipped wheel all pass.

Stdlib unittest only, like test_worker.py.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

# Nothing here may reach the network: set before huggingface_hub is imported.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mlx.core as mx  # noqa: E402
import mlx_vlm  # noqa: E402
import mlx_vlm.models.ming_image.pipeline as pipeline_module  # noqa: E402
import mlx_vlm.models.ming_image.text_encoder as text_encoder_module  # noqa: E402
import numpy as np  # noqa: E402
from mlx_vlm.generate.image import generate_image  # noqa: E402
from mlx_vlm.models.ming_image import (  # noqa: E402
    MingImageGenerationModel,
    MingImagePipeline,
)
from mlx_vlm.models.ming_image.text_encoder import MingImageTextEncoder  # noqa: E402
from mlx_vlm.models.ming_image.weights import load_text_encoder  # noqa: E402
from mlx_vlm.quant_utils import quantize_model  # noqa: E402

import tiny_ming  # noqa: E402

PROMPT = "a red poster with the word hello"
SIZE = dict(width=256, height=256)


def _tiny(test: unittest.TestCase) -> Path:
    """A fresh tiny checkpoint in a temp dir removed after the test."""
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    return tiny_ming.make_tiny_checkpoint(Path(tmp.name) / "ming")


class Counter:
    """Wrap a function and count its calls."""

    def __init__(self, fn):
        self.fn = fn
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        return self.fn(*args, **kwargs)


class TestFixture(unittest.TestCase):
    """The tiny checkpoint drives the stock pipeline (passes before AND after)."""

    def test_version_is_a_bobble_build(self):
        self.assertTrue(mlx_vlm.__version__.startswith("0.7.3.dev0+bobble."))

    def test_one_picture_through_the_pipeline(self):
        pipe = MingImagePipeline(_tiny(self))
        image = pipe.generate_array(PROMPT, seed=1, steps=2, **SIZE)
        self.assertEqual(image.shape, (256, 256, 4))
        self.assertEqual(image.dtype, mx.uint8)
        pixels = np.array(image)
        # Random weights, but not a flat or saturated picture: seeds can differ.
        self.assertGreater(len(np.unique(pixels)), 8)


class TestOnStep(unittest.TestCase):
    """0001: a callback after each evaluated denoising step."""

    def test_generate_array_reports_every_step(self):
        pipe = MingImagePipeline(_tiny(self))
        seen = []
        pipe.generate_array(
            PROMPT, seed=1, steps=3, on_step=lambda i, n: seen.append((i, n)), **SIZE
        )
        self.assertEqual(seen, [(1, 3), (2, 3), (3, 3)])

    def test_the_generic_api_passes_it_through_request_extra(self):
        model = MingImageGenerationModel.from_model_id(str(_tiny(self)))
        seen = []
        result = generate_image(
            model, PROMPT, seed=2, steps=2, on_step=lambda i, n: seen.append(i), **SIZE
        )
        self.assertEqual(seen, [1, 2])
        self.assertEqual(result.color_space, "RGBA")


class TestEncodeOnceManySeeds(unittest.TestCase):
    """0002: one encode for N seeds; each seed reproduces alone; prompt two works."""

    def setUp(self):
        self.root = _tiny(self)
        self.loads = Counter(pipeline_module.load_text_encoder)
        self.encodes = Counter(MingImageTextEncoder.encode)
        self.transformers = Counter(pipeline_module.load_transformer)
        pipeline_module.load_text_encoder = self.loads
        pipeline_module.load_transformer = self.transformers
        MingImageTextEncoder.encode = lambda enc, ids: self.encodes(enc, ids)

    def tearDown(self):
        pipeline_module.load_text_encoder = self.loads.fn
        pipeline_module.load_transformer = self.transformers.fn
        MingImageTextEncoder.encode = self.encodes.fn

    def test_n_seeds_cost_one_encode(self):
        pipe = MingImagePipeline(self.root)
        out = list(pipe.generate_seeds(PROMPT, [3, 5, 7], steps=2, **SIZE))
        self.assertEqual([seed for seed, _ in out], [3, 5, 7])
        for _, image in out:
            self.assertEqual(image.shape, (256, 256, 4))
        self.assertEqual(self.encodes.calls, 1)
        self.assertEqual(self.loads.calls, 1)  # the constructor's, no reload
        self.assertEqual(self.transformers.calls, 1)
        # Different seeds, different pictures.
        self.assertFalse(np.array_equal(np.array(out[0][1]), np.array(out[1][1])))

    def test_a_seed_gives_the_same_picture_alone(self):
        together = dict(
            MingImagePipeline(self.root).generate_seeds(PROMPT, [3, 5], steps=2, **SIZE)
        )
        alone = MingImagePipeline(self.root).generate_array(
            PROMPT, seed=5, steps=2, **SIZE
        )
        np.testing.assert_array_equal(np.array(together[5]), np.array(alone))

    def test_encode_then_conditioning_equals_encoding_inside(self):
        pipe = MingImagePipeline(self.root)
        conditioning = pipe.encode(PROMPT)
        via = pipe.generate_array(
            PROMPT, seed=9, steps=2, conditioning=conditioning, **SIZE
        )
        inside = MingImagePipeline(self.root).generate_array(
            PROMPT, seed=9, steps=2, **SIZE
        )
        np.testing.assert_array_equal(np.array(via), np.array(inside))

    def test_bad_arguments_fail_before_the_encode(self):
        pipe = MingImagePipeline(self.root)
        with self.assertRaises(ValueError):
            pipe.generate_seeds(PROMPT, [1], steps=2, width=100, height=256)
        with self.assertRaises(ValueError):
            pipe.generate_seeds(PROMPT, [], steps=2, **SIZE)
        with self.assertRaises(ValueError):
            pipe.generate_seeds(PROMPT, [1], steps=2, guidance=2.0, **SIZE)
        self.assertEqual(self.encodes.calls, 0)

    def test_a_second_prompt_on_the_same_pipeline(self):
        # Upstream: AttributeError, the evicted encoder was never loaded back.
        pipe = MingImagePipeline(self.root)
        pipe.generate_array("a blue sign", seed=1, steps=2, **SIZE)
        second = pipe.generate_array("a green title", seed=1, steps=2, **SIZE)
        fresh = MingImagePipeline(self.root).generate_array(
            "a green title", seed=1, steps=2, **SIZE
        )
        np.testing.assert_array_equal(np.array(second), np.array(fresh))
        # The DiT was dropped before the encoder came back, then loaded again.
        self.assertEqual(self.transformers.calls, 3)  # two for `pipe`, one for fresh
        self.assertIsNone(pipe.text_encoder)  # and the encoder evicted again


class TestPerLayerQuantization(unittest.TestCase):
    """0003: mixed-precision checkpoints load, with or without per-path config."""

    @staticmethod
    def _recipe(path, module):
        # Routers stay float (as convert.py keeps them); attention and the
        # embedding at 8 bits; everything else at the 4-bit default.
        if path.endswith("gate.gate_proj"):
            return False
        if ".attention." in path or path.endswith("word_embeddings"):
            return {"group_size": 32, "bits": 8, "mode": "affine"}
        return True

    def _quantized(self, recipe):
        root = tiny_ming.write_configs(Path(self._tmp()) / "ming")
        encoder = tiny_ming.random_encoder(root)
        encoder, config = quantize_model(
            encoder, {}, 32, 4, "affine", quant_predicate=recipe
        )
        return root, encoder, config["quantization"]

    def _tmp(self) -> str:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return tmp.name

    def _assert_loads_as(self, root, reference):
        loaded = load_text_encoder(root)
        # Three words, then the image block: start, the 4 query tokens, end.
        ids = mx.array([[4, 5, 6] + [126] + [125] * 4 + [127]], dtype=mx.int32)
        for got, want in zip(loaded.encode(ids), reference.encode(ids), strict=True):
            np.testing.assert_array_equal(np.array(got), np.array(want))
        return loaded

    def test_mixed_checkpoint_with_defaults_only_config(self):
        # What this family's convert.py writes: the defaults, no per-path entries.
        root, encoder, quant = self._quantized(self._recipe)
        defaults = {k: quant[k] for k in ("group_size", "bits", "mode")}
        tiny_ming.save_encoder(root, encoder, defaults)
        loaded = self._assert_loads_as(root, encoder)
        attention = loaded.mllm.layers[0].attention.query_key_value
        self.assertEqual(attention.bits, 8)
        self.assertEqual(loaded.mllm.layers[1].mlp.switch_mlp.gate_proj.bits, 4)

    def test_mixed_checkpoint_with_per_path_config(self):
        # mlx-vlm's convention: quantize_model records each override by path.
        root, encoder, quant = self._quantized(self._recipe)
        self.assertIn("mllm.layers.0.attention.query_key_value", quant)
        tiny_ming.save_encoder(root, encoder, quant)
        self._assert_loads_as(root, encoder)

    def test_uniform_checkpoint_still_loads(self):
        # No regression for today's uniform 4-bit conversions (nativ-community).
        root, encoder, quant = self._quantized(
            lambda path, module: not path.endswith("gate.gate_proj")
        )
        tiny_ming.save_encoder(root, encoder, quant)
        loaded = self._assert_loads_as(root, encoder)
        self.assertEqual(loaded.mllm.layers[0].attention.query_key_value.bits, 4)


class TestPerLayerEval(unittest.TestCase):
    """0004: the encoder is evaluated one layer at a time, same numbers."""

    class _CountingMx:
        def __init__(self, real):
            self._real = real
            self.evals = 0

        def eval(self, *arrays):
            self.evals += 1
            return self._real.eval(*arrays)

        def __getattr__(self, name):
            return getattr(self._real, name)

    def _inputs(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        encoder = tiny_ming.random_encoder(tiny_ming.write_configs(Path(tmp.name)))
        ids = mx.array([[4, 5, 6, 7, 8, 9]], dtype=mx.int32)
        embeds = encoder.mllm.word_embeddings(ids)
        image_mask = mx.array([[False] * 6])
        return encoder, embeds, image_mask

    def test_one_eval_per_layer(self):
        encoder, embeds, image_mask = self._inputs()
        counting = self._CountingMx(text_encoder_module.mx)
        text_encoder_module.mx = counting
        try:
            encoder.mllm(embeds, image_mask)
        finally:
            text_encoder_module.mx = counting._real
        self.assertEqual(counting.evals, tiny_ming.LLM["num_hidden_layers"])

    def test_same_hidden_states_as_one_lazy_graph(self):
        encoder, embeds, image_mask = self._inputs()
        stepped = encoder.mllm(embeds, image_mask)
        # The upstream forward, by hand: one graph, evaluated at the end.
        from mlx_vlm.models.base import create_attention_mask

        mask = create_attention_mask(embeds, None)
        lazy, h = [], embeds
        for layer in encoder.mllm.layers:
            lazy.append(h)
            h = layer(h, mask, image_mask)
        lazy.append(encoder.mllm.norm(h))
        mx.eval(lazy)
        for a, b in zip(stepped, lazy, strict=True):
            np.testing.assert_array_equal(np.array(a), np.array(b))


if __name__ == "__main__":
    unittest.main()
