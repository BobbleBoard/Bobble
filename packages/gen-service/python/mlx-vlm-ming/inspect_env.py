#!/usr/bin/env python3
"""What the design env holds, and what importing Ming pulls in.

Run it inside the env the app builds (README.md, "Verify"). It prints one JSON
object:
- the versions of python, mlx-vlm and mlx;
- the seconds `import mlx_vlm.models.ming_image` takes;
- the import graph by distribution: which installed distributions that
  import loads, and which are installed but never imported;
- every distribution's installed size, from its RECORD, and the total;
- where the import's time goes, per distribution (`python -X importtime`).
"""

import importlib.metadata as metadata
import json
import platform
import subprocess
import sys
import time

TARGET = "mlx_vlm.models.ming_image"


def installed_sizes() -> dict[str, int]:
    sizes: dict[str, int] = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        sizes[name] = sizes.get(name, 0) + sum((f.size or 0) for f in dist.files or [])
    return sizes


def import_seconds_by_distribution(limit: int = 12) -> dict[str, float]:
    """Where the import's time goes: each module's own time (`-X importtime`,
    one fresh process, .pyc already warm), summed per distribution. Everything
    nests under `mlx_vlm`'s __init__, so cumulative times say nothing."""
    run = subprocess.run(
        [sys.executable, "-X", "importtime", "-c", f"import {TARGET}"],
        capture_output=True,
        text=True,
        check=True,
    )
    by_package = metadata.packages_distributions()
    totals: dict[str, float] = {}
    for line in run.stderr.splitlines():
        parts = line[len("import time:") :].split("|")
        if not line.startswith("import time:") or len(parts) != 3:
            continue
        own, name = parts[0].strip(), parts[2].strip()
        if not own.isdigit():
            continue  # the header row
        top = name.split(".")[0]
        dist = (by_package.get(top) or ["(python)"])[0]
        totals[dist] = totals.get(dist, 0.0) + int(own) / 1e6
    ranked = sorted(totals.items(), key=lambda kv: -kv[1])[:limit]
    return {dist: round(seconds, 3) for dist, seconds in ranked}


def main() -> None:
    before = set(sys.modules)
    start = time.perf_counter()
    __import__(TARGET)
    seconds = time.perf_counter() - start
    loaded_tops = {name.split(".")[0] for name in set(sys.modules) - before}

    import mlx.core as mx
    import mlx_vlm

    by_package = metadata.packages_distributions()
    imported = sorted({d for top in loaded_tops for d in by_package.get(top, [])})
    sizes = installed_sizes()
    unused = sorted(set(sizes) - set(imported))
    report = {
        "python": platform.python_version(),
        "mlx_vlm": mlx_vlm.__version__,
        "mlx": mx.__version__,
        "import_seconds": round(seconds, 2),
        "distributions": len(sizes),
        "installed_mb": round(sum(sizes.values()) / 1e6, 1),
        "imported_mb": round(sum(sizes.get(d, 0) for d in imported) / 1e6, 1),
        "not_imported_mb": round(sum(sizes[d] for d in unused) / 1e6, 1),
        "imported_by_ming": imported,
        "installed_not_imported": {d: round(sizes[d] / 1e6, 1) for d in unused},
        "largest_mb": {
            name: round(size / 1e6, 1)
            for name, size in sorted(sizes.items(), key=lambda kv: -kv[1])[:12]
        },
        "import_seconds_by_distribution": import_seconds_by_distribution(),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
