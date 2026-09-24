#!/bin/sh
# BENCH ONLY — a GPU job (Mage-Flow at 8 bits peaks ~15 GB; MEASURED 14.76 GB
# for an edit). Run it under the heavy lock, on AC, with the chat model parked:
#
#   node scripts/with-lock.mjs heavy -- sh packages/gen3d-engine/python/tools/bench_mageflow_assembled.sh
#
# SPK-02, end to end, with ZERO weights downloaded. Mage-Flow now installs from
# Comfy-Org/Mage-Flow + Qwen/Qwen3-VL-4B-Instruct, assembled into the release's
# diffusers directory. Those files have the SAME sha256 as the withdrawn
# microsoft/* release, whose snapshots sit on the library shelves. So this
# builds a scratch hub cache whose Comfy-Org and Qwen snapshots point at the
# shelved microsoft/* files, lets the real sidecar Registry assemble the
# directories (every pin is checked, by blob name), installs the shipped mflux
# wheel into a scratch venv, and runs the real image worker: one text → image,
# then one edit of that image. LOOK at both PNGs.
#
# DRY_RUN=1 stops before the model runs (no GPU): it assembles and prints.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)                    # packages/gen3d-engine/python
ENGINE=$(cd "$HERE/.." && pwd)                             # packages/gen3d-engine
LIB=${PI_DESKTOP_MODELS_DIR:-$HOME/Bobble/Models}
OUT=${OUT:-${TMPDIR:-/tmp}/bobble-bench-spk02}
WHEEL=$(ls "$ENGINE"/prebuilt/darwin-arm64/mflux-*+bobble.mageflow*.whl)
TURBO=$(ls -d "$LIB"/Image/Generation/microsoft__mage-flow-turbo/snapshots/*/ | head -1)
EDIT=$(ls -d "$LIB"/Image/Editing/microsoft__mage-flow-edit-turbo/snapshots/*/ | head -1)
COMFY_REV=6ff68fbf3c667325e961d551691b246791d5eec0
QWEN_REV=ebb281ec70b05090aa6165b016eac8ec08e71b17

rm -rf "$OUT/cache"
mkdir -p "$OUT"
HUB="$OUT/cache/hf/hub"

# One snapshot entry: a link to the shelved file (which resolves to its blob).
link() { mkdir -p "$(dirname "$1")"; ln -s "$2" "$1"; }

C="$HUB/models--Comfy-Org--Mage-Flow"
mkdir -p "$C/refs"; printf %s "$COMFY_REV" > "$C/refs/main"
link "$C/snapshots/$COMFY_REV/diffusion_models/mage_flow_turbo_bf16.safetensors" \
     "$TURBO/transformer/diffusion_pytorch_model.safetensors"
link "$C/snapshots/$COMFY_REV/diffusion_models/mage_flow_edit_turbo_bf16.safetensors" \
     "$EDIT/transformer/diffusion_pytorch_model.safetensors"
link "$C/snapshots/$COMFY_REV/vae/mage_flow_vae_bf16.safetensors" \
     "$EDIT/vae/diffusion_pytorch_model.safetensors"

Q="$HUB/models--Qwen--Qwen3-VL-4B-Instruct"
mkdir -p "$Q/refs"; printf %s "$QWEN_REV" > "$Q/refs/main"
for f in "$EDIT"/text_encoder/*; do
  name=$(basename "$f")
  case "$name" in README.md|.gitattributes) continue ;; esac
  link "$Q/snapshots/$QWEN_REV/$name" "$f"
done

echo "== assembling with the real Registry (pins checked by blob name)"
DIRS=$(cd "$HERE" && uv run --no-project --python 3.12 python - "$OUT/cache" <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, ".")
from engine.registry import Registry
spec = json.loads(Path("tests/fixtures/mage-flow-registry.json").read_text())
r = Registry({**spec, "gatedMirrors": {}, "pipelineTypes": {}}, Path(sys.argv[1]))
out = []
for model_id in ("mageflow", "mageflow-edit"):
    d = r.model_dir(model_id)
    if d is None or r.legacy_snapshot(model_id) is not None:
        sys.exit(f"{model_id}: not assembled from the new sources")
    out.append(str(d))
print(" ".join(out))
PY
)
set -- $DIRS
GEN_DIR=$1; EDIT_DIR=$2
echo "   generator: $GEN_DIR"
echo "   editor:    $EDIT_DIR"

echo "== the shipped mflux wheel in a scratch venv"
if [ ! -x "$OUT/venv/bin/mflux-generate-mage-flow-edit" ]; then
  uv venv "$OUT/venv" --python 3.12 -q
  uv pip install -q --python "$OUT/venv/bin/python" "$WHEEL"
fi
ls "$OUT"/venv/bin/mflux-generate-mage-flow*

GEN="$HERE/workers/mlx_image_worker.py"
set -- "$OUT/venv/bin/python" "$GEN" --prompt "a red toy car on a white table, studio light" \
  --out "$OUT/generated.png" --cli "$OUT/venv/bin/mflux-generate-mage-flow" \
  --model "$GEN_DIR" --base-model mage-flow-turbo --preview-max-px 0
echo "== text → image:"; echo "   $*"
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN: stopping before the model runs"; exit 0; fi
HF_HUB_OFFLINE=1 /usr/bin/time -l "$@" 2> "$OUT/generate.time"
tail -20 "$OUT/generate.time" | grep -E "real|maximum resident" || true

set -- "$OUT/venv/bin/python" "$GEN" --prompt "make the car bright blue" \
  --out "$OUT/edited.png" --cli "$OUT/venv/bin/mflux-generate-mage-flow" \
  --edit-from "$OUT/generated.png" --edit-cli "$OUT/venv/bin/mflux-generate-mage-flow-edit" \
  --edit-model "$EDIT_DIR" --edit-base-model mage-flow-edit-turbo --preview-max-px 0
echo "== edit:"; echo "   $*"
HF_HUB_OFFLINE=1 /usr/bin/time -l "$@" 2> "$OUT/edit.time"
tail -20 "$OUT/edit.time" | grep -E "real|maximum resident" || true

echo "LOOK at: $OUT/generated.png and $OUT/edited.png"
