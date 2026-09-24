# bobble-train

The Python half of `packages/training`: one uv project whose pins both the
TRAIN and LORA lanes use.

| Module | Package | Owner |
|---|---|---|
| `bobble_train/worker.py`, `ndjson.py`, `control.py`, `data.py`, `backends/mlx_backend.py` | TR-2 | TRAIN |
| `bobble_train/render.py` (the shared Qwen3.5 renderer, span masks) | LR-08 | LORA |
| `bobble_train/export/*` | TR-10 | TRAIN |

```sh
uv sync                     # dependencies + pytest (the MLX stack on Apple Silicon only)
uv run pytest               # the tests
```

The worker never shares the MLX engine venv; the app runs it as
`uv run --no-project --python 3.12 --with <pins> python -m bobble_train.worker`
(deliverables/research/training.md §4). A full `uv sync` on Apple Silicon
downloads about 82 MB of wheels (read from `uv.lock`: mlx-metal 42.5 MB, numpy
12 MB, transformers 11.2 MB, the rest small), under the 200 MB line where a
download becomes a BENCH step (PLAN.md R13). The model weights a training run
needs are a separate, BENCH-sized download.

```sh
uv run --no-project --python 3.12 --with pytest pytest -q   # the skeleton's test, no sync
```
