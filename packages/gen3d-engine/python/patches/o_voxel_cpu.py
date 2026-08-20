"""Make o_voxel's CPU extension actually compile, and build it.

WHY THIS EXISTS. `o_voxel._C` is a hard requirement for encoding a mesh's shape
latent — `mesh_to_flexible_dual_grid` has no Python fallback — and that is the
first step of texturing an existing mesh. Without it the stage dies with
"name '_C' is not defined".

The checkout's setup.py already has a complete CPU branch: plain C++ with Eigen,
no CUDA, no Metal, so it builds with the clang in Command Line Tools. It had
simply never been compiled, and three things stopped it:

1. `src/ext_cpu.cpp`, the entry point that branch requires, is not in the repo,
   so setup.py silently produced no extension at all.
2. `third_party/eigen` is an uninitialised git submodule.
3. The CPU sources carry CUDA-isms that nvcc accepts and clang does not — a `d`
   suffix on double literals (`1e-6d`, `0.0d`), and brace-initialising the
   fork's own `int4` from `size_t` values, which is a narrowing conversion.

All three are fixed here rather than upstream so a re-provision cannot lose
them, and each edit is idempotent — running this twice is a no-op.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

EXT_CPU = '''// CPU-ONLY pybind entry point for o_voxel._C — written by
// packages/gen3d-engine/python/patches/o_voxel_cpu.py, see that file for why.
//
// Binds exactly the functions in setup.py's `cpu_sources`: the two converters
// and the six octree codecs. The CUDA entries in src/ext.cpp are deliberately
// absent — their .cu files are not compiled in this branch, so naming them here
// would fail to link. Serialization (z-order/hilbert) is out for the same
// reason.
#include <torch/extension.h>

#include "convert/api.h"
#include "io/api.h"

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("mesh_to_flexible_dual_grid_cpu", &mesh_to_flexible_dual_grid_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("textured_mesh_to_volumetric_attr_cpu", &textured_mesh_to_volumetric_attr_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("encode_sparse_voxel_octree_cpu", &encode_sparse_voxel_octree_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("decode_sparse_voxel_octree_cpu", &decode_sparse_voxel_octree_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("encode_sparse_voxel_octree_attr_parent_cpu", &encode_sparse_voxel_octree_attr_parent_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("decode_sparse_voxel_octree_attr_parent_cpu", &decode_sparse_voxel_octree_attr_parent_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("encode_sparse_voxel_octree_attr_neighbor_cpu",
          &encode_sparse_voxel_octree_attr_neighbor_cpu,
          py::call_guard<py::gil_scoped_release>());
    m.def("decode_sparse_voxel_octree_attr_neighbor_cpu",
          &decode_sparse_voxel_octree_attr_neighbor_cpu,
          py::call_guard<py::gil_scoped_release>());
}
'''

#: `1e-6d` / `0.0d` — nvcc takes the suffix, standard C++ has no `d` for doubles.
_DOUBLE_SUFFIX = re.compile(r"(?<![\w.])(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)d(?![\w.])")


def _fix_cuda_isms(path: Path) -> bool:
    text = original = path.read_text(encoding="utf-8")
    text = _DOUBLE_SUFFIX.sub(r"\1", text)
    # `torch::zeros({N, C})` where N and C are size_t: the brace-init list is
    # int64_t, so clang calls it narrowing. Same class of problem, different
    # type, and the compiler names the cast it wants.
    text = re.sub(
        r"torch::zeros\(\{([A-Za-z_]\w*), ([A-Za-z_]\w*)\}",
        r"torch::zeros({static_cast<int64_t>(\1), static_cast<int64_t>(\2)}",
        text,
    )
    # Same narrowing through `torch::from_blob(x.data(), {x.size()}, …)`, where
    # size() is size_t and the shape list is int64_t.
    text = re.sub(
        r"(torch::from_blob\([^,]+,\s*)\{([A-Za-z_]\w*\.size\(\))\}",
        r"\1{static_cast<int64_t>(\2)}",
        text,
    )
    # int4/int3 are brace-initialised from size_t indices; clang calls that
    # narrowing and refuses. An explicit cast is what the compiler asks for.
    text = re.sub(
        r"int4 quad_indices\{([^}]*)\}",
        lambda m: "int4 quad_indices{"
        + ", ".join(f"static_cast<int>({p.strip()})" for p in m.group(1).split(","))
        + "}",
        text,
    )
    if text == original:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def apply(checkout: Path, python: Path, uv: str, env: dict, log) -> bool:
    """Patch and build. Returns True when `o_voxel._C` imports afterwards."""
    root = checkout / "o-voxel"
    if not root.is_dir():
        log("o-voxel not in this checkout — skipping the CPU extension")
        return False

    probe = subprocess.run(
        [str(python), "-c", "from o_voxel import _C"], capture_output=True, env=env
    )
    if probe.returncode == 0:
        return True

    ext_cpu = root / "src" / "ext_cpu.cpp"
    if not ext_cpu.exists():
        ext_cpu.write_text(EXT_CPU, encoding="utf-8")
        log("o_voxel: wrote the missing CPU entry point")

    if not (root / "third_party" / "eigen" / "Eigen" / "Dense").exists():
        log("o_voxel: fetching the Eigen submodule…")
        subprocess.run(
            ["git", "submodule", "update", "--init", "--depth", "1",
             "o-voxel/third_party/eigen"],
            cwd=checkout, env=env, check=False,
        )

    for rel in (
        "src/convert/flexible_dual_grid.cpp",
        "src/convert/volumetic_attr.cpp",
        "src/io/svo.cpp",
        "src/io/filter_parent.cpp",
        "src/io/filter_neighbor.cpp",
    ):
        src = root / rel
        if src.exists() and _fix_cuda_isms(src):
            log(f"o_voxel: made {Path(rel).name} compile with clang")

    log("o_voxel: building the CPU extension…")
    subprocess.run(
        [uv, "pip", "install", "--python", str(python), "--no-build-isolation", str(root)],
        cwd=checkout, env=env, check=False,
    )
    ok = subprocess.run(
        [str(python), "-c", "from o_voxel import _C"], capture_output=True, env=env
    ).returncode == 0
    log(f"o_voxel: CPU extension {'built' if ok else 'unavailable'}")
    return ok
