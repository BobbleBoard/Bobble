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


def test_every_shipped_extension_is_built_for_the_wheel_tag() -> None:
    """The extension inside each wheel matches the wheel's Python tag.

    The first motion_correction wheel was tagged cp312 but carried a
    ``_motion_correction.cpython-314-darwin.so`` (the build picked the system
    python) — Python 3.12 could not import it and every motion job died at
    post-processing with "No module named motion_correction._motion_correction".
    """
    import zipfile

    root = ENGINE.parent / "prebuilt" / "darwin-arm64"
    manifest = json.loads((root / "manifest.json").read_text())
    tag = manifest["python"]  # cp312
    suffix = f".cpython-{tag[2:]}-darwin.so"
    for wheel in [*manifest["wheels"], manifest["motionCorrection"]]:
        assert f"-{tag}-{tag}-" in wheel, wheel
        names = zipfile.ZipFile(root / wheel).namelist()
        extensions = [n for n in names if n.endswith(".so")]
        assert extensions, f"{wheel} ships no extension"
        for ext in extensions:
            assert ext.endswith(suffix), f"{wheel}: {ext} is not a {tag} build"


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
        # The text encoder runs in MLX now (_llm2vec_mlx.py); the venv gets it.
        assert envs.ARDY_MLX in install, install
        assert "mlx.core" in envs.ARDY_IMPORTS
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


def _mflux_registry(tmp: str) -> reg.Registry:
    r = reg.Registry.__new__(reg.Registry)
    r.uv_path = "uv"
    r.src_dir = Path(tmp)
    r.prebuilt_dir = ENGINE.parent / "prebuilt"
    r.tool_dir = lambda name: Path(tmp) / name
    r.venv_python = lambda name: Path(tmp) / name / ".venv" / "bin" / "python"
    bin_dir = Path(tmp) / "mflux" / ".venv" / "bin"
    r.mflux_cli = lambda: bin_dir / "mflux-generate-mage-flow"
    r.mflux_edit_cli = lambda: bin_dir / "mflux-generate-mage-flow-edit"
    return r


def _fake_install(r: reg.Registry, runs: list[list[str]], *, gives_commands: bool):
    """A stand-in for `_run` that records argv and, like the real wheel, drops
    the two console scripts into the venv (or, like PyPI 0.18.0, does not)."""

    def run(cmd, *a, **k):
        runs.append(cmd)
        if gives_commands and "install" in cmd:
            for cli in (r.mflux_cli(), r.mflux_edit_cli()):
                cli.parent.mkdir(parents=True, exist_ok=True)
                cli.write_text("#!/bin/sh\n")

    return run


def test_mflux_is_provisioned_before_the_pytorch_image_tree() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _mflux_registry(tmp)
        runs: list[list[str]] = []
        with (
            patch.object(envs, "_run", side_effect=_fake_install(r, runs, gives_commands=True)),
            patch.object(r, "ensure_tool_clone", side_effect=lambda name, log: (Path(tmp) / name)),
            patch.object(envs, "_prebuilt_manifest", return_value=None),
        ):
            (Path(tmp) / "Mage" / "mage_flow").mkdir(parents=True)
            envs._provision_mageflow(r, lambda m: None)
        first_install = next(i for i, c in enumerate(runs) if "install" in c)
        assert envs.MFLUX_MAGE_FLOW_SOURCE in runs[first_install], runs
        mage_venv = next(i for i, c in enumerate(runs) if "3.11" in c)
        assert first_install < mage_venv, runs


def test_mflux_comes_from_the_shipped_mage_flow_wheel_never_the_pypi_pin() -> None:
    """PyPI's mflux 0.18.0 (the old pin) has no `mflux-generate-mage-flow`, so
    installing it gave a fresh Mac no fast path and no edits. The shipped wheel
    is what goes in, and nothing pins a PyPI version."""
    manifest = json.loads((ENGINE.parent / "prebuilt" / "darwin-arm64" / "manifest.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        r = _mflux_registry(tmp)
        runs: list[list[str]] = []
        with (
            patch.object(envs, "_run", side_effect=_fake_install(r, runs, gives_commands=True)),
            # The real manifest, on any platform this suite runs on.
            patch.object(envs, "_prebuilt_manifest", return_value=manifest),
        ):
            envs._provision_mflux(r, lambda m: None)
        install = next(c for c in runs if "install" in c)
        wheel = [a for a in install if a.endswith(".whl")]
        assert len(wheel) == 1 and "+bobble.mageflow" in wheel[0], install
        assert Path(wheel[0]).exists(), wheel
        assert "--reinstall-package" in install, install
        assert not any(a.startswith("mflux==") for c in runs for a in c), runs


def test_a_venv_whose_mflux_lacks_mage_flow_is_repaired_or_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _mflux_registry(tmp)
        # The broken state the old pin left: a venv, mflux, no Mage-Flow commands.
        r.venv_python("mflux").parent.mkdir(parents=True)
        r.venv_python("mflux").write_text("")
        runs: list[list[str]] = []
        with patch.object(envs, "_run", side_effect=_fake_install(r, runs, gives_commands=False)):
            try:
                envs._provision_mflux(r, lambda m: None)
            except RuntimeError as err:
                assert "Mage-Flow" in str(err)
            else:
                raise AssertionError("an install without the commands must not pass")
        assert any("install" in c for c in runs), "the broken venv was left alone"
        # And once both commands exist, nothing is reinstalled.
        for cli in (r.mflux_cli(), r.mflux_edit_cli()):
            cli.write_text("#!/bin/sh\n")
        runs.clear()
        with patch.object(envs, "_run", side_effect=_fake_install(r, runs, gives_commands=True)):
            envs._provision_mflux(r, lambda m: None)
        assert runs == [], runs


def test_the_shipped_mflux_wheel_carries_both_mage_flow_commands() -> None:
    import zipfile

    root = ENGINE.parent / "prebuilt" / "darwin-arm64"
    manifest = json.loads((root / "manifest.json").read_text())
    wheel = root / manifest["mflux"]
    assert wheel.exists(), wheel
    with zipfile.ZipFile(wheel) as z:
        eps = next(n for n in z.namelist() if n.endswith(".dist-info/entry_points.txt"))
        text = z.read(eps).decode()
    assert "mflux-generate-mage-flow = " in text, text
    assert "mflux-generate-mage-flow-edit = " in text, text
