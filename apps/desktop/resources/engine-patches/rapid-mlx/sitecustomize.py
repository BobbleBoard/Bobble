"""Bobble's patch for rapid-mlx's thinking cap: end the thought in words.

rapid-mlx enforces a per-request thinking budget (`reasoning_max_tokens`) at
decode time: once the budget is spent, the only token the model may sample is
`</think>`. That stops the thought mid-sentence with nothing to tell the model
why, and the user asked for the opposite: a message, mandatory, that ends the
thought the way llama.cpp's `--reasoning-budget-message` does ("I've been
thinking a while now, I have to stop and just do something").

This file rides in on PYTHONPATH only when Bobble launches rapid-mlx
(supervisor-entry.ts), so Python imports it at start-up as `sitecustomize`. It
patches nothing until rapid-mlx itself imports the two modules involved, and
then only:

- the processor builder, to remember the message's token ids (the tokenizer is
  only in hand there), and
- the processor's forced distribution: when the budget is spent, it forces the
  message's tokens one per step, then `</think>`;
- the chat route's builder, so tool turns get the cap at all (see
  `_patch_route`).

It reuses the processor's own counter (`_think_count` keeps counting while the
message is forced, so `_think_count - _budget` is how much of the message is
out). That counter is in rapid-mlx's MTP snapshot, so speculative decoding
rolls the message back with everything else.

If rapid-mlx's internals ever change shape, the patch logs a line and stands
down. The budget then still works, just without the words.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import os
import sys

_BUDGET = "vllm_mlx.api.reasoning_budget"
_ROUTE = "vllm_mlx.routes.chat"
_MESSAGE = os.environ.get("BOBBLE_THINK_END_MESSAGE") or (
    "\n\nOkay, I've been thinking about this for a long while now. I have enough "
    "to go on, so I'll stop here and act on the best plan I have.\n"
)


_DEBUG = os.environ.get("BOBBLE_THINK_END_DEBUG") == "1"


def _log(text: str) -> None:
    try:
        sys.stderr.write(f"[bobble-think-end] {text}\n")
    except Exception:
        pass


def _encode(tokenizer, text: str) -> tuple[int, ...]:
    for call in (
        lambda: tokenizer.encode(text, add_special_tokens=False),
        lambda: tokenizer.encode(text),
    ):
        try:
            ids = call()
            if hasattr(ids, "ids"):
                ids = ids.ids
            return tuple(int(i) for i in ids)
        except Exception:
            continue
    return ()


def _patch(module) -> None:
    cls = getattr(module, "ReasoningBudgetLogitsProcessor", None)
    build = getattr(module, "build_reasoning_budget_processor", None)
    original_force = getattr(cls, "_force_distribution", None) if cls else None
    if cls is None or build is None or original_force is None:
        _log("rapid-mlx's budget module changed shape; the cap runs without the message")
        return

    def build_with_message(tokenizer, *args, **kwargs):
        proc = build(tokenizer, *args, **kwargs)
        if _DEBUG:
            _log(f"budget processor {'built' if proc is not None else 'declined'} ({args!r:.120})")
        if proc is not None:
            ids = _encode(tokenizer, _MESSAGE)
            # never force the closing marker as part of the message
            end = getattr(proc, "_think_end_id", None)
            proc._bobble_message_ids = tuple(i for i in ids if i != end)
        return proc

    def force_with_message(self, logits):
        ids = getattr(self, "_bobble_message_ids", ())
        spent = getattr(self, "_think_count", 0) - getattr(self, "_budget", 0)
        width = int(logits.shape[-1])
        if ids and 0 <= spent < len(ids) and 0 <= ids[spent] < width:
            import mlx.core as mx

            if spent == 0 and _DEBUG:
                _log(f"budget spent at {getattr(self, '_think_count', '?')} tokens; ending in words")

            row = mx.where(
                mx.arange(width) == ids[spent], mx.array(0.0), mx.array(-float("inf"))
            ).astype(logits.dtype)
            return mx.broadcast_to(row, logits.shape)
        return original_force(self, logits)

    module.build_reasoning_budget_processor = build_with_message
    cls._force_distribution = force_with_message
    _log("thinking cap ends with a message")


def _patch_route(module) -> None:
    """Let the cap apply to tool turns too.

    rapid-mlx keeps the decode-time cap off any request that carries tools
    unless its constrained tool grammar is on (the grammar holds tool tokens
    back until `</think>`, so a forced close cannot land inside a call). Bobble
    runs with that grammar off (RAPID_MLX_CONSTRAIN_TOOLS=0: it looped the 4B
    6 times in 10), so without this every agent turn — nearly all of them —
    thought uncapped and only had its visible reasoning trimmed afterwards.
    The models Bobble runs write tool calls after `</think>`, never inside it,
    so closing the thought in words first is safe for them.
    """
    build = getattr(module, "_build_reasoning_budget_processor", None)
    if build is None:
        _log("rapid-mlx's chat route changed shape; tool turns keep its own cap")
        return

    def build_for_tools_too(*args, **kwargs):
        kwargs["allow_tools"] = True
        return build(*args, **kwargs)

    module._build_reasoning_budget_processor = build_for_tools_too


_PATCHES = {_BUDGET: _patch, _ROUTE: _patch_route}


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        patch = _PATCHES.get(fullname)
        if patch is None:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None:
            return None
        loader = spec.loader
        exec_module = loader.exec_module

        def exec_and_patch(module):
            exec_module(module)
            try:
                patch(module)
            except Exception as exc:  # never break the engine over the message
                _log(f"patch skipped: {exc!r}")

        loader.exec_module = exec_and_patch
        return spec


sys.meta_path.insert(0, _Finder())
