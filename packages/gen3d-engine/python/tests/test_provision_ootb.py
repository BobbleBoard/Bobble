"""Provisioning without developer tools — the user (2026-09-15): "all basic stuff
needs to work out of the box".

A fresh Mac has no git, no C++ compiler, no `metal`. These pin the three
things that make the engine's install possible there: tool sources arrive as
GitHub archives of the pinned commit (unpacked with tarfile, no `tar`, no git),
the MLX tree's requirements drop the three Metal source builds in favour of
the shipped wheels, and QuadriFlow is copied from the prebuilt tree.
"""

from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from engine import envs, registry as reg  # noqa: E402


def test_archive_url_is_the_pinned_tarball() -> None:
    url = reg.archive_url("https://github.com/Roblox/cube.git", "3c6d06dd")
    assert url == "https://github.com/Roblox/cube/archive/3c6d06dd.tar.gz", url


def _github_style_tarball(top: str, files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"{top}/{rel}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_fetch_tool_archive_unpacks_the_one_top_folder_as_dest() -> None:
    """The archive's `<repo>-<ref>` folder becomes the tool dir, pin recorded."""
    payload = _github_style_tarball("cube-3c6d06dd", {"README.md": "hi", "cubepart/x.py": "1"})

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    opener = MagicMock()
    opener.open.return_value = _Resp(payload)
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "cube"
        with patch.object(reg.urllib.request, "build_opener", return_value=opener):
            reg.fetch_tool_archive("https://github.com/Roblox/cube.git", "3c6d06dd", dest)
        assert (dest / "README.md").read_text() == "hi"
        assert (dest / "cubepart" / "x.py").exists()
        assert (dest / ".bobble-pin").read_text().strip() == "3c6d06dd"
        # Nothing half-unpacked left beside it.
        assert [p.name for p in Path(tmp).iterdir()] == ["cube"]
    opener.open.assert_called_once()
    assert opener.open.call_args.args[0].endswith("/cube/archive/3c6d06dd.tar.gz")


def test_ensure_tool_clone_never_runs_git_for_a_missing_tree() -> None:
    """The archive is the way in; git is only the fallback when the archive fails."""
    with tempfile.TemporaryDirectory() as tmp:
        r = reg.Registry.__new__(reg.Registry)
        r.src_dir = Path(tmp)
        calls: list[list[str]] = []
        with (
            patch.object(reg, "fetch_tool_archive") as fetch,
            patch.object(reg.subprocess, "run", side_effect=lambda cmd, **k: calls.append(cmd)),
        ):
            fetch.side_effect = lambda url, pin, dest: dest.mkdir()
            out = r.ensure_tool_clone("cube", lambda m: None)
        assert out == Path(tmp) / "cube"
        assert calls == [], f"git was run: {calls}"


def test_an_existing_tree_is_left_alone_without_git() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = reg.Registry.__new__(reg.Registry)
        r.src_dir = Path(tmp)
        (Path(tmp) / "ardy").mkdir()
        with patch.object(reg, "fetch_tool_archive") as fetch, patch.object(reg, "git_usable", return_value=False):
            r.ensure_tool_clone("ardy", lambda m: None)
        fetch.assert_not_called()


def test_metal_source_lines_are_dropped_from_the_requirements() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tool = Path(tmp)
        (tool / "requirements_macos.txt").write_text(
            "torch>=2.11.0\n"
            "mtldiffrast @ https://github.com/pedronaugusto/mtldiffrast/archive/main.tar.gz\n"
            "cumesh @ https://github.com/pedronaugusto/mtlmesh/archive/main.tar.gz\n"
            "flex_gemm @ https://github.com/pedronaugusto/mtlgemm/archive/main.tar.gz\n"
            "trimesh\n"
        )
        out = envs._requirements_without_metal_sources(tool)
        lines = [l for l in out.read_text().splitlines() if l.strip()]
        assert lines == ["torch>=2.11.0", "trimesh"], lines
        # …and the transformers bound goes too — the extras pin it.
        (tool / "requirements_macos.txt").write_text("transformers>=4.40.0,<5\nnumpy\n")
        out = envs._requirements_without_metal_sources(tool)
        assert [l for l in out.read_text().splitlines() if l.strip()] == ["numpy"]
        assert any(x.startswith("transformers==") for x in envs._MLX_TREE_EXTRAS)
        assert any(x.startswith("kornia") for x in envs._MLX_TREE_EXTRAS)
        assert any(x.startswith("timm") for x in envs._MLX_TREE_EXTRAS)


def test_the_shipped_prebuilt_set_is_complete_and_named_by_the_manifest() -> None:
    """The repo's own prebuilt tree: every wheel the manifest names exists."""
    root = ENGINE.parent / "prebuilt" / "darwin-arm64"
    manifest = json.loads((root / "manifest.json").read_text())
    for wheel in manifest["wheels"]:
        assert (root / wheel).exists(), wheel
        assert wheel.endswith("cp312-cp312-macosx_11_0_arm64.whl"), wheel
    assert (root / manifest["quadriflow"]).exists()
    assert manifest["torch"].count(".") == 2  # an exact pin, e.g. 2.13.0


def test_quadriflow_is_copied_from_the_prebuilt_tree() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = reg.Registry.__new__(reg.Registry)
        r.bin_dir = Path(tmp) / "bin"
        r.bin_dir.mkdir()
        r.prebuilt_dir = ENGINE.parent / "prebuilt"
        with patch.object(envs.subprocess, "run"):
            envs._provision_quadriflow(r, lambda m: None)
        cli = r.bin_dir / "quadriflow"
        assert cli.exists() and cli.stat().st_mode & 0o111, "not installed executable"


def test_installed_check_accepts_the_mlx_tree_alone() -> None:
    """A Mac without Xcode has only the MLX tree; that is a working engine."""
    r = reg.Registry.__new__(reg.Registry)
    r.model = lambda model_id: {"env": "trellis"}
    seen: list[str] = []

    def venv_python(tool: str):
        seen.append(tool)
        return MagicMock(exists=lambda: tool == "trellis2-apple")

    r.venv_python = venv_python
    assert r.env_present("trellis2") is True


def test_ardy_installs_from_the_tree_and_the_shipped_extension() -> None:
    """No CMake: deps from pyproject, the motion_correction wheel, a .pth line."""
    with tempfile.TemporaryDirectory() as tmp:
        tool = Path(tmp) / "ardy"
        (tool / ".venv" / "bin").mkdir(parents=True)
        (tool / ".venv" / "lib" / "python3.12" / "site-packages").mkdir(parents=True)
        (tool / "pyproject.toml").write_text(
            '[project]\nname = "ardy"\ndependencies = ["torch>=2.4", "peft>=0.19"]\n'
        )
        r = reg.Registry.__new__(reg.Registry)
        r.uv_path = "uv"
        r.src_dir = Path(tmp)
        r.prebuilt_dir = ENGINE.parent / "prebuilt"
        r.tool_dir = lambda name: tool
        runs: list[list[str]] = []
        with (
            patch.object(envs, "_run", side_effect=lambda cmd, *a, **k: runs.append(cmd)),
            patch.object(envs.subprocess, "run", return_value=MagicMock(returncode=1)),
        ):
            envs._provision_ardy(r, lambda m: None)
        install = next(c for c in runs if c[:3] == ["uv", "pip", "install"])
        assert "-e" not in install, install
        assert "torch>=2.4" in install and "peft>=0.19" in install, install
        assert any(a.endswith("motion_correction-1.0.0-cp312-cp312-macosx_11_0_arm64.whl") for a in install)
        pth = tool / ".venv" / "lib" / "python3.12" / "site-packages" / "ardy-checkout.pth"
        assert pth.read_text().strip() == str(tool)


def test_cubepart_pins_the_wheel_only_fpsample() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tool = Path(tmp) / "cube"
        (tool / "cubepart").mkdir(parents=True)
        r = reg.Registry.__new__(reg.Registry)
        r.uv_path = "uv"
        r.src_dir = Path(tmp)
        r.tool_dir = lambda name: tool
        r.venv_python = lambda name: tool / ".venv" / "bin" / "python"
        runs: list[list[str]] = []
        with patch.object(envs, "_run", side_effect=lambda cmd, *a, **k: runs.append(cmd)):
            envs._provision_cubepart(r, lambda m: None)
        install = next(c for c in runs if c[:3] == ["uv", "pip", "install"] and "-e" in c)
        assert "fpsample==0.3.3" in install, install


def test_the_meshtools_env_names_what_trimesh_reaches_for() -> None:
    """scikit-image (marching cubes), rtree, manifold3d — the fresh-cache misses."""
    for pkg in ("scikit-image", "rtree", "manifold3d"):
        assert pkg in envs.MESHTOOLS_PACKAGES, pkg
    for mod in ("skimage", "rtree", "manifold3d"):
        assert mod in envs.MESHTOOLS_IMPORTS, mod


def test_cubepart_gets_mlx_for_the_denoiser_swap() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tool = Path(tmp) / "cube"
        (tool / "cubepart").mkdir(parents=True)
        r = reg.Registry.__new__(reg.Registry)
        r.uv_path = "uv"
        r.src_dir = Path(tmp)
        r.tool_dir = lambda name: tool
        r.venv_python = lambda name: tool / ".venv" / "bin" / "python"
        runs: list[list[str]] = []
        with patch.object(envs, "_run", side_effect=lambda cmd, *a, **k: runs.append(cmd)):
            envs._provision_cubepart(r, lambda m: None)
        install = next(c for c in runs if "-e" in c)
        assert "mlx" in install, install


def test_mflux_is_provisioned_before_the_pytorch_image_tree() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = reg.Registry.__new__(reg.Registry)
        r.uv_path = "uv"
        r.src_dir = Path(tmp)
        r.tool_dir = lambda name: Path(tmp) / name
        r.venv_python = lambda name: Path(tmp) / name / ".venv" / "bin" / "python"
        r.mflux_cli = lambda: Path(tmp) / "mflux" / ".venv" / "bin" / "mflux-generate-mage-flow"
        runs: list[list[str]] = []
        with (
            patch.object(envs, "_run", side_effect=lambda cmd, *a, **k: runs.append(cmd)),
            patch.object(r, "ensure_tool_clone", side_effect=lambda name, log: (Path(tmp) / name)),
        ):
            (Path(tmp) / "Mage" / "mage_flow").mkdir(parents=True)
            envs._provision_mageflow(r, lambda m: None)
        assert any(f"mflux=={envs.MFLUX_PIN}" in c for c in runs), runs
