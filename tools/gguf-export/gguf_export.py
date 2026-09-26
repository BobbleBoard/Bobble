#!/usr/bin/env python3
"""
A Hugging Face model → a GGUF the app runs, with Unsloth's per-tensor recipe.

the user (2026-09-25): "make ggufs using unsloth dynamic ideally, run q6_k_m for all".
llama.cpp has no Q6_K_M — the Q6 K-quant is Q6_K — and Unsloth's own Q6 is
UD-Q6_K_XL: mostly Q6_K, with the tensors that suffer most at 6 bits kept at a
higher type. Unsloth does not publish the tool that chooses those tensors, but
it publishes the RESULT for every base model it quantizes, and a fine-tune has
its base's tensors, names and shapes. So the recipe is read off Unsloth's own
GGUF of the base model — the header only, a few MB by an HTTP range request —
and handed to llama-quantize as per-tensor overrides. (Their imatrix is not
published either; at 6 bits it changes little, and no calibration is used.)

Also the Training view's export (TR-10/11) when it is built: one model in, one
runnable GGUF (+ its vision projector) out, a manifest beside it, and nothing
left behind — the disk this runs on is the user's.

    gguf_export.py recipe --ud unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-UD-Q6_K_XL.gguf
    gguf_export.py export --repo XunmeiLiu/VFIG-4B --out ~/Bobble/Models/svg-bakeoff \\
        --ud unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-UD-Q6_K_XL.gguf
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HF = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
LLAMA_CPP = Path(os.environ.get("LLAMA_CPP", Path.home() / ".cache/bobble/omnisvg/llama.cpp"))
QUANTIZE = os.environ.get("LLAMA_QUANTIZE", shutil.which("llama-quantize") or "llama-quantize")
# The disk this runs on is the user's: never go below this much free.
MIN_FREE_GB = float(os.environ.get("GGUF_EXPORT_MIN_FREE_GB", "40"))

# ggml_type ids → names (ggml.h); only the ones a quantized model carries.
GGML_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1",
    10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS",
    17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S",
    23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M", 30: "BF16",
    34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4",
}


# ── reading a GGUF header over HTTP ──────────────────────────────────────────

class _Short(Exception):
    """The bytes fetched so far end inside the header."""


class _Reader:
    def __init__(self, buf: bytes) -> None:
        self.buf, self.at = buf, 0

    def take(self, n: int) -> bytes:
        if self.at + n > len(self.buf):
            raise _Short()
        out = self.buf[self.at:self.at + n]
        self.at += n
        return out

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def string(self) -> str:
        return self.take(self.u64()).decode("utf-8", "replace")

    def skip_value(self, vtype: int) -> None:
        sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
        if vtype in sizes:
            self.take(sizes[vtype])
        elif vtype == 8:
            self.take(self.u64())
        elif vtype == 9:
            etype, count = self.u32(), self.u64()
            if etype in sizes:
                self.take(sizes[etype] * count)
            else:
                for _ in range(count):
                    self.skip_value(etype)
        else:
            raise ValueError(f"unknown GGUF value type {vtype}")


def parse_tensor_types(buf: bytes) -> dict[str, str]:
    """Tensor name → ggml type name, from the start of a GGUF file."""
    r = _Reader(buf)
    if r.take(4) != b"GGUF":
        raise ValueError("not a GGUF file")
    version = r.u32()
    if version < 2:
        raise ValueError(f"GGUF v{version} is too old")
    n_tensors, n_kv = r.u64(), r.u64()
    for _ in range(n_kv):
        r.string()
        r.skip_value(r.u32())
    types: dict[str, str] = {}
    for _ in range(n_tensors):
        name = r.string()
        dims = r.u32()
        for _ in range(dims):
            r.u64()
        t = r.u32()
        r.u64()  # offset
        types[name] = GGML_TYPES.get(t, f"type{t}")
    return types


def fetch_tensor_types(ref: str) -> dict[str, str]:
    """`owner/repo/file.gguf` on the Hub → its tensor types, reading only the header."""
    repo, _, file = ref.rpartition("/")
    url = f"{HF}/{repo}/resolve/main/{file}"
    size = 8 << 20
    while True:
        req = urllib.request.Request(url, headers={"Range": f"bytes=0-{size - 1}"})
        with urllib.request.urlopen(req, timeout=60) as res:
            buf = res.read()
        try:
            return parse_tensor_types(buf)
        except _Short:
            if len(buf) < size:  # the whole file was shorter than asked
                raise
            size *= 2


def recipe_lines(types: dict[str, str], base: str) -> list[str]:
    """llama-quantize --tensor-type lines: every quantized tensor NOT at `base`."""
    lines = []
    for name, t in sorted(types.items()):
        if t in ("F32", base) or not name.endswith(".weight"):
            continue  # norms stay F32 by llama.cpp's own rule; the rest is the base type
        lines.append(f"^{re.escape(name)}$={t.lower()}")
    return lines


def summary(types: dict[str, str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for t in types.values():
        out[t] = out.get(t, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


# ── exporting ────────────────────────────────────────────────────────────────

def free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1e9


def need_space(path: Path, gb: float, what: str) -> None:
    left = free_gb(path) - gb
    if left < MIN_FREE_GB:
        sys.exit(f"not enough disk for {what}: {free_gb(path):.0f} GB free, it needs ~{gb:.0f} GB "
                 f"and {MIN_FREE_GB:.0f} GB must stay free")


def run(cmd: list[str], log: Path) -> None:
    with log.open("a") as f:
        f.write(f"\n$ {' '.join(cmd)}\n")
        f.flush()
        p = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        sys.exit(f"failed ({p.returncode}): {' '.join(cmd[:3])} … — see {log}")


def repo_size_gb(repo: str, allow: list[str] | None) -> float:
    with urllib.request.urlopen(f"{HF}/api/models/{repo}?blobs=true", timeout=60) as res:
        info = json.load(res)
    total = 0
    for s in info.get("siblings") or []:
        name = s["rfilename"]
        if allow is None or any(Path(name).match(a) for a in allow):
            total += s.get("size") or 0
    return total / 1e9


def export(args: argparse.Namespace) -> None:
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    name = args.name or args.repo.split("/")[-1]
    work = out / f".{name}.work"
    work.mkdir(exist_ok=True)
    log = out / f"{name}.log"
    started = time.time()
    manifest: dict = {"repo": args.repo, "name": name, "quant": args.quant}

    # One sharded copy of the weights: a repo that also carries a single-file
    # copy (VFIG-4B has both) would otherwise download it twice.
    allow = ["*.json", "*.jinja", "*.txt", "*.model", "tokenizer*", "vocab*", "merges*",
             "model-*-of-*.safetensors"]
    if args.single_file:
        allow = [a for a in allow if a != "model-*-of-*.safetensors"] + ["model.safetensors"]
    gb = repo_size_gb(args.repo, allow)
    manifest["download_gb"] = round(gb, 2)
    # The weights and a bf16 GGUF of the same size are on disk together once;
    # the weights go before the quantized copy is written.
    need_space(out, gb * 2.1, f"{args.repo}")

    hf_dir = work / "hf"
    from huggingface_hub import snapshot_download  # the export env has it
    t0 = time.time()
    snapshot_download(args.repo, local_dir=hf_dir, allow_patterns=allow)
    manifest["download_s"] = round(time.time() - t0)

    convert = LLAMA_CPP / "convert_hf_to_gguf.py"
    bf16 = work / f"{name}-BF16.gguf"
    t0 = time.time()
    if args.vision:
        mmproj = out / f"mmproj-{name}-F16.gguf"
        run([sys.executable, str(convert), str(hf_dir), "--mmproj", "--outtype", "f16",
             "--outfile", str(mmproj)], log)
        manifest["mmproj"] = mmproj.name
    run([sys.executable, str(convert), str(hf_dir), "--outtype", "bf16", "--outfile", str(bf16)], log)
    manifest["convert_s"] = round(time.time() - t0)
    if not args.keep_hf:
        shutil.rmtree(hf_dir, ignore_errors=True)

    quant = args.quant.upper()
    base = quant.replace("UD-", "").replace("_XL", "")
    cmd = [QUANTIZE]
    if args.ud:
        types = fetch_tensor_types(args.ud)
        lines = recipe_lines(types, base)
        recipe = out / f"{name}-{quant}.recipe.txt"
        recipe.write_text("\n".join(lines) + "\n")
        manifest["recipe"] = {"from": args.ud, "overrides": len(lines), "types": summary(types)}
        cmd += ["--tensor-type-file", str(recipe)]
        emb = types.get("token_embd.weight")
        head = types.get("output.weight")
        if emb and emb != base:
            cmd += ["--token-embedding-type", emb.lower()]
        if head and head != base:
            cmd += ["--output-tensor-type", head.lower()]
    gguf = out / f"{name}-{quant}.gguf"
    t0 = time.time()
    run(cmd + [str(bf16), str(gguf), base], log)
    manifest["quantize_s"] = round(time.time() - t0)
    manifest["gguf"] = gguf.name
    manifest["gguf_gb"] = round(gguf.stat().st_size / 1e9, 2)

    bf16.unlink(missing_ok=True)
    if not any(work.iterdir()):
        work.rmdir()
    manifest["total_s"] = round(time.time() - started)
    (out / f"{name}-{quant}.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("recipe", help="print an Unsloth GGUF's per-tensor types, from its header")
    r.add_argument("--ud", required=True, help="owner/repo/file.gguf on the Hub")
    r.add_argument("--base", default="Q6_K")
    e = sub.add_parser("export", help="download, convert and quantize one model")
    e.add_argument("--repo", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--name")
    e.add_argument("--quant", default="UD-Q6_K_XL")
    e.add_argument("--ud", help="the base model's Unsloth GGUF to copy the per-tensor recipe from")
    e.add_argument("--vision", action="store_true", help="also write the vision projector (mmproj)")
    e.add_argument("--single-file", action="store_true", help="the repo's weights are model.safetensors")
    e.add_argument("--keep-hf", action="store_true", help="keep the downloaded weights")
    a = ap.parse_args()
    if a.cmd == "recipe":
        types = fetch_tensor_types(a.ud)
        print(json.dumps({"types": summary(types), "overrides": recipe_lines(types, a.base)}, indent=1))
    else:
        export(a)


if __name__ == "__main__":
    main()
