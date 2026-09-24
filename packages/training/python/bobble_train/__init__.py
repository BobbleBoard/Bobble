"""bobble_train — Bobble's training worker, shared renderer and export helpers.

SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). The modules
land with their packages: the NDJSON worker and the MLX backend (TR-2), the shared
Qwen3.5 renderer with span masks (LR-08, ``render.py``) and the export steps
(TR-10). Owned by the TRAIN lane, except ``render.py`` (LORA).
"""

__version__ = "0.0.0"
