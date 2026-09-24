"""Are the catalog's weight sources still there, still public, and still the
same bytes? Checked against the live Hugging Face hub WITHOUT downloading a
single weight file.

Written after `microsoft/Mage-Flow-*` vanished (401 to everyone, 2026-09-23):
the first sign was a fresh install's download failing. This makes the check a
command instead:

    cd packages/gen3d-engine/python
    uv run --no-project --python 3.12 --with huggingface_hub==0.34.4 \\
        python tools/check_sources.py tests/fixtures/mage-flow-registry.json \\
        [--models mageflow,mageflow-edit] [--fetch-small /path/to/fresh/hf-home]

The registry is the JSON the app writes for the sidecar (catalog.ts
`toSidecarRegistry()`, found at `<cache>/gen3d/registry.json`) or the test
fixture. Everything is ANONYMOUS (token=False), because a fresh install has no
token. For every repo a model downloads it reports: reachable and not gated;
each pinned file present with the pinned size and sha256 (the hub's LFS
metadata, not a download); each literal allow-pattern present. `legacyRepos`
are reported too but never fail the run — they are expected to be gone.

`--fetch-small DIR` then downloads, into DIR as HF_HOME, only each repo's
small files (literal patterns that are not pinned, and glob patterns other
than weights), through the same `snapshot_download` the sidecar uses. Exit 1
when any current source fails.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path

GLOB = set("*?[")
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".gguf", ".pt", ".pth", ".ckpt", ".npz")


def _small_patterns(spec: dict) -> list[str]:
    pinned = {p["path"] for p in spec.get("pinned") or []}
    out = []
    for pattern in spec.get("allowPatterns") or []:
        if GLOB & set(pattern):
            if not pattern.endswith(WEIGHT_SUFFIXES):
                out.append(pattern)
        elif pattern not in pinned and not pattern.endswith(WEIGHT_SUFFIXES):
            out.append(pattern)
    return out


def check_repo(api, spec: dict) -> list[str]:
    """Problems with one repo spec; empty when it is all there."""
    from huggingface_hub.utils import GatedRepoError, HfHubHTTPError, RepositoryNotFoundError

    repo = spec["repo"]
    try:
        info = api.model_info(repo, token=False, files_metadata=False)
    except RepositoryNotFoundError as err:
        return [f"{repo}: not found / not public ({err.__class__.__name__}: {str(err).splitlines()[0]})"]
    except GatedRepoError:
        return [f"{repo}: gated"]
    except HfHubHTTPError as err:
        return [f"{repo}: {str(err).splitlines()[0]}"]
    problems = []
    if getattr(info, "gated", False):
        problems.append(f"{repo}: gated ({info.gated}) — a fresh install has no token")
    listed = {s.rfilename for s in (info.siblings or [])}
    pins = spec.get("pinned") or []
    if pins:
        found = {
            f.path: f
            for f in api.get_paths_info(repo, [p["path"] for p in pins], token=False)
            if getattr(f, "size", None) is not None
        }
        for pin in pins:
            f = found.get(pin["path"])
            if f is None:
                problems.append(f"{repo}: {pin['path']} is missing")
                continue
            sha = getattr(getattr(f, "lfs", None), "sha256", None)
            if f.size != pin["bytes"]:
                problems.append(f"{repo}: {pin['path']} is {f.size} bytes, pinned {pin['bytes']}")
            if sha != pin["sha256"]:
                problems.append(f"{repo}: {pin['path']} sha256 {sha}, pinned {pin['sha256']}")
    for pattern in spec.get("allowPatterns") or []:
        if GLOB & set(pattern):
            if not any(fnmatch.fnmatch(name, pattern) for name in listed):
                problems.append(f"{repo}: nothing matches {pattern!r}")
        elif pattern not in listed:
            problems.append(f"{repo}: {pattern} is missing")
    return problems


def fetch_small(spec: dict, hf_home: Path) -> tuple[int, list[str]]:
    """Download the repo's small files into `hf_home`; (bytes, paths)."""
    patterns = _small_patterns(spec)
    if not patterns:
        return 0, []
    from huggingface_hub import snapshot_download

    snap = Path(snapshot_download(spec["repo"], allow_patterns=patterns, token=False))
    files = sorted(p for p in snap.rglob("*") if p.is_file())
    return sum(p.stat().st_size for p in files), [str(p.relative_to(snap)) for p in files]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("registry")
    ap.add_argument("--models", default="", help="comma-separated ids (default: every model)")
    ap.add_argument("--fetch-small", default="", help="a FRESH directory to use as HF_HOME")
    args = ap.parse_args()

    if args.fetch_small:
        # Before the hub is imported: it freezes HF_HOME into module constants.
        home = Path(args.fetch_small)
        home.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(home)
        os.environ.pop("HF_TOKEN", None)
    from huggingface_hub import HfApi

    api = HfApi()
    models = json.loads(Path(args.registry).read_text())["models"]
    wanted = {m for m in args.models.split(",") if m}
    failed = False
    for model in models:
        if wanted and model["id"] not in wanted:
            continue
        print(f"{model['id']}")
        for spec in model["repos"]:
            problems = check_repo(api, spec)
            failed = failed or bool(problems)
            pins = len(spec.get("pinned") or [])
            print(f"  {'FAIL' if problems else 'ok  '} {spec['repo']}"
                  + (f" ({pins} pinned file(s) match)" if pins and not problems else ""))
            for p in problems:
                print(f"       {p}")
            if args.fetch_small and not problems and _small_patterns(spec):
                n, files = fetch_small(spec, Path(args.fetch_small))
                print(f"       fetched {len(files)} small file(s), {n:,} bytes: {', '.join(files)}")
        for spec in model.get("legacyRepos") or []:
            problems = check_repo(api, spec)
            print(f"  {'gone' if problems else 'up  '} {spec['repo']} (legacy — honoured on disk only)")
            for p in problems:
                print(f"       {p}")
    print("FAIL" if failed else "OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
