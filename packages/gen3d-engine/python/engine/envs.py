"""Per-model runtime provisioning: tool clones (pinned), uv venvs, the
AutoRemesher release binary, and the gated-mirror pipeline.json patch.

Everything is idempotent — re-running after a partial failure resumes.
"""

from __future__ import annotations

import json
import os
import platform
import plistlib
import subprocess
import sys
import threading
import shutil
import urllib.request
from pathlib import Path

from .registry import Registry


def _run(cmd: list[str], cwd: Path | None, log, env: dict | None = None) -> None:
    log("$ " + " ".join(cmd))
    merged = dict(os.environ)
    if env:
        merged.update(env)
    result = subprocess.run(
        cmd, cwd=str(cwd) if cwd else None, env=merged, capture_output=True, text=True
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise RuntimeError(f"{cmd[0]} failed ({result.returncode}): {tail}")


def _uv_env(registry: Registry) -> dict:
    """PATH with uv's directory in front (setup scripts probe `command -v uv`)."""
    uv_dir = str(Path(registry.uv_path).parent)
    return {"PATH": uv_dir + os.pathsep + os.environ.get("PATH", "")}


def provision(registry: Registry, model: dict, log, cancelled: threading.Event) -> None:
    env_kind = model["env"]
    if env_kind == "trellis":
        # The MLX tree is the one that runs 1024 and can texture an existing
        # mesh, and — with the app's prebuilt Metal wheels — the one a Mac
        # without Xcode can have at all. The PyTorch-MPS tree is provisioned
        # beside it only where its Metal backends can be compiled; a Mac
        # without a compiler gets the MLX tree alone, which runs everything.
        _provision_trellis_mlx(registry, log)
        if _metal_env() or _metal_compiler_present():
            _provision_trellis(registry, log)
        else:
            log("No Metal compiler on this Mac — the MLX TRELLIS tree is the engine here")
    elif env_kind == "mageflow":
        _provision_mageflow(registry, log)
    elif env_kind == "cubepart":
        _provision_cubepart(registry, log)
    elif env_kind == "skintokens":
        _provision_skintokens(registry, log)
    elif env_kind == "binary":
        _provision_autoremesher(registry, model, log)
    elif env_kind == "meshtools":
        _provision_meshtools(registry, log)
    elif env_kind == "audio":
        _provision_audio(registry, log)
    elif env_kind == "ardy":
        _provision_ardy(registry, log)
    else:
        raise RuntimeError(f"unknown env kind: {env_kind}")


def _metal_compiler_present() -> bool:
    """Can `xcrun metal` run here? Only a full Xcode carries it."""
    if shutil.which("xcrun") is None:
        return False
    probe = subprocess.run(["xcrun", "-f", "metal"], capture_output=True)
    return probe.returncode == 0


#: The Metal packages requirements_macos.txt names as source archives — the
#: three builds that need Xcode's `metal`. Shipped prebuilt instead.
_METAL_SOURCE_PACKAGES = ("mtldiffrast", "cumesh", "flex_gemm")


#: What the texturing pipeline needs that requirements_macos.txt does not
#: name — MEASURED on a fresh cache (gen3d-ootb-probe): the BiRefNet
#: background remover's remote code imports kornia and timm and the working
#: environment had them (and onnxruntime, scikit-image) installed by hand.
#: transformers is pinned to the version that environment runs; the file's
#: `<5` bound is dropped for it.
_MLX_TREE_EXTRAS = (
    "transformers==5.14.1",
    "kornia==0.8.3",
    "timm==1.0.28",
    "onnxruntime",
    "scikit-image",
)


def _requirements_without_metal_sources(tool: Path) -> Path:
    """requirements_macos.txt minus the `pkg @ https://…tar.gz` Metal lines and
    the transformers bound (_MLX_TREE_EXTRAS pins it)."""
    src = tool / "requirements_macos.txt"
    kept = []
    for line in src.read_text().splitlines():
        head = line.split("@", 1)[0].strip().lower()
        if "@" in line and head in _METAL_SOURCE_PACKAGES:
            continue
        if line.strip().lower().startswith("transformers"):
            continue
        kept.append(line)
    out = tool / ".requirements_prebuilt.txt"
    out.write_text("\n".join(kept) + "\n")
    return out


def _prebuilt_manifest(registry: Registry) -> dict | None:
    """The shipped prebuilt set for this platform, when it is here."""
    path = registry.prebuilt("darwin-arm64", "manifest.json")
    if path is None or platform.machine() != "arm64" or platform.system() != "Darwin":
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _metal_env() -> dict:
    """The Metal wheel builds need Apple's `metal` compiler. Command Line
    Tools alone lack it; if a full Xcode is present, point DEVELOPER_DIR at it
    for the build only (no system-level xcode-select change). Verified on this
    machine: CLT-active + Xcode 26.6 in /Applications — DEVELOPER_DIR is what
    makes mtlbvh/mtldiffrast/mtlmesh/mtlgemm compile."""
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if xcode.exists():
        probe = subprocess.run(["xcrun", "-f", "metal"], capture_output=True)
        if probe.returncode != 0:
            return {"DEVELOPER_DIR": str(xcode)}
    return {}


def _provision_trellis_mlx(registry: Registry, log) -> None:
    """The MLX TRELLIS checkout — geometry at 3x the speed, and the only path
    that can texture an existing mesh.

    This had NO provisioning at all: the checkout existed on the machine it was
    set up on by hand, and a fresh Mac would silently fall back to the slower
    PyTorch-MPS tree with no texturing pipeline and no 1024 resolution. "Works
    out of the box" cannot rest on a directory somebody made once.

    The o_voxel CPU extension is built here too. It is a hard requirement for
    encoding a mesh's shape latent, it compiles with the clang in Command Line
    Tools (no Xcode, no Metal compiler), and the checkout ships it unbuildable —
    see patches/o_voxel_cpu.py for the three reasons and the fixes.
    """
    tool = registry.ensure_tool_clone("trellis2-apple", log)
    py = registry.venv_python("trellis2-apple")
    env = _uv_env(registry)
    env["HF_HOME"] = str(registry.hf_home)
    env.update(_metal_env())

    # THE PREBUILT SET. The user (2026-09-15): "all basic stuff needs to work out
    # of the box". The Metal rasteriser and the sparse GEMM kernels only build
    # with Xcode's `metal` compiler, and the o_voxel shape encoder with a C++
    # compiler — neither of which a fresh Mac has. The app ships them built
    # (packages/gen3d-engine/prebuilt, built once on a Mac that had Xcode,
    # against the torch the manifest pins), so the environment here is
    # wheels all the way down. A machine WITH Xcode still takes this path:
    # a prebuilt wheel is the same code, minutes sooner. The source build is
    # the fallback for a platform the manifest does not cover.
    manifest = _prebuilt_manifest(registry)
    if not py.exists():
        log("Creating the MLX TRELLIS environment…")
        _run([registry.uv_path, "venv", "--python", "3.12", ".venv"], tool, log, env)
        if manifest is not None:
            wheels = [
                str(w) for w in (registry.prebuilt("darwin-arm64", n) for n in manifest["wheels"])
                if w is not None
            ]
            log("Installing the MLX TRELLIS requirements (prebuilt Metal wheels)…")
            _run(
                [registry.uv_path, "pip", "install", "--python", str(py),
                 f"torch=={manifest['torch']}", *_MLX_TREE_EXTRAS,
                 "-r", str(_requirements_without_metal_sources(tool)), *wheels],
                tool, log, env,
            )
        else:
            _run(
                [registry.uv_path, "pip", "install", "--python", str(py),
                 "--no-build-isolation", "-r", "requirements_macos.txt"],
                tool, log, env,
            )

    # Import-time guard on the texturing pipeline, and the shape encoder itself.
    # The prebuilt wheel above already carries o_voxel._C; this is the source
    # build for a platform without one.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "patches"))
    try:
        import o_voxel_cpu

        o_voxel_cpu.apply(tool, py, registry.uv_path, env, log)
    except Exception as err:  # noqa: BLE001 — a missing extension is degraded, not fatal
        log(f"o_voxel CPU extension unavailable ({err}); texture-from-image will be off")


def _provision_trellis(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("trellis-mac", log)
    if not registry.venv_python("trellis-mac").exists():
        log("Running trellis-mac setup.sh (venv + Metal backends + MPS patches)…")
        env = _uv_env(registry)
        env["HF_HOME"] = str(registry.hf_home)
        env.update(_metal_env())
        # MACOSX_DEPLOYMENT_TARGET is set inside setup.sh; SKIP nothing — the
        # Metal texture baker is the quality path on this hardware.
        _run(["bash", "setup.sh"], tool, log, env)
        # transformers 5.14's conversion-mapping pass breaks the remote-code
        # rembg model ('Config' has no attribute 'model_type'); 4.57.1 has
        # DINOv3ViT and predates the regression. einops is required by the
        # ZhengPeng7/BiRefNet remote code. Both verified on this machine.
        py = str(registry.venv_python("trellis-mac"))
        _run(
            [registry.uv_path, "pip", "install", "--python", py, "transformers==4.57.1", "einops"],
            tool,
            log,
        )
    patch_gated_mirrors(registry, log)


def patch_gated_mirrors(registry: Registry, log) -> None:
    """When no HF token exists, point the cached TRELLIS pipeline configs at
    the byte-identical public mirrors (camenduru dinov3 / 1038lab RMBG-2.0).

    The snapshot files are symlinks into blobs/ — we replace the SYMLINK with a
    patched regular file so the shared blob store stays pristine.
    """
    try:
        from huggingface_hub import get_token

        if get_token():
            log("HF token present — keeping official gated repos")
            return
    except ImportError:
        pass
    mirrors: dict = registry.spec.get("gatedMirrors") or {}
    if not mirrors:
        return
    repo_dir = registry.hf_home / "hub" / "models--microsoft--TRELLIS.2-4B" / "snapshots"
    if not repo_dir.is_dir():
        return
    for snapshot in repo_dir.iterdir():
        for name in ("pipeline.json", "texturing_pipeline.json"):
            cfg = snapshot / name
            if not cfg.exists():
                continue
            text = cfg.read_text()
            patched = text
            for official, mirror in mirrors.items():
                patched = patched.replace(official, mirror)
            if patched != text:
                cfg.unlink()
                cfg.write_text(patched)
                log(f"patched {name} → public mirrors (no HF token)")


#: The Mage-Flow port's source, pinned by commit — the fallback where the app's
#: prebuilt tree (which ships it as a wheel, manifest key "mflux") is absent.
#: NO mflux release carries Mage-Flow: the port (mflux-community/mflux#483) was
#: closed unmerged, and PyPI 0.18.0 through 0.20.0 have no
#: `mflux-generate-mage-flow`. The old pin here, `mflux==0.18.0`, was the
#: port's own version string, so it installed the PyPI release WITHOUT the
#: commands — a fresh Mac got no fast image path and no edits at all.
MFLUX_MAGE_FLOW_SOURCE = (
    "mflux @ https://github.com/ivanfioravanti/mflux/archive/"
    "859eeeca40b0c47a7bc2d8941072f0220e3425cf.tar.gz"
)


def _mflux_requirement(registry: Registry) -> str:
    """The shipped wheel when the prebuilt tree has it, else the pinned source."""
    manifest = _prebuilt_manifest(registry)
    name = (manifest or {}).get("mflux")
    wheel = registry.prebuilt("darwin-arm64", name) if isinstance(name, str) and name else None
    return str(wheel) if wheel is not None else MFLUX_MAGE_FLOW_SOURCE


def _provision_mflux(registry: Registry, log) -> None:
    """The MLX image path — `mflux-generate-mage-flow` and its `-edit` twin.

    jobs.py prefers this over the PyTorch Mage tree (11 s vs 71 s a picture,
    and image EDITS exist only here) and it was a venv somebody made by hand:
    a fresh Mac had no fast path and no edits at all. One venv, one wheel.
    A venv whose mflux lacks the commands (the old PyPI pin) is repaired.
    """
    cli, edit_cli = registry.mflux_cli(), registry.mflux_edit_cli()
    if cli.exists() and edit_cli.exists():
        return
    tool = registry.tool_dir("mflux")
    tool.mkdir(parents=True, exist_ok=True)
    uv = registry.uv_path
    python = registry.venv_python("mflux")
    if not python.exists():
        log("Creating the MLX image venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.12"], tool, log)
    log("Installing mflux with Mage-Flow…")
    _run(
        [
            uv, "pip", "install", "--python", str(python),
            "--reinstall-package", "mflux", _mflux_requirement(registry),
        ],
        tool,
        log,
    )
    if not (cli.exists() and edit_cli.exists()):
        raise RuntimeError("the installed mflux has no Mage-Flow commands")


def _provision_mageflow(registry: Registry, log) -> None:
    # The fast path first; a failure here leaves the PyTorch tree to carry it.
    try:
        _provision_mflux(registry, log)
    except Exception as err:  # noqa: BLE001 — degraded, not fatal
        log(f"mflux unavailable ({err}); images will run on the PyTorch tree")
    tool = registry.ensure_tool_clone("Mage", log)
    mage_flow = tool / "mage_flow"
    if not registry.venv_python("Mage").exists():
        uv = registry.uv_path
        log("Creating Mage-Flow venv (torch 2.13 + transformers 5.5, no flash-attn on MPS)…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        py = str(registry.venv_python("Mage"))
        _run([uv, "pip", "install", "--python", py, "-r", str(mage_flow / "requirements.txt")], tool, log)
        _run([uv, "pip", "install", "--python", py, "-e", str(mage_flow), "--no-deps"], tool, log)


def _provision_cubepart(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("cube", log)
    cubepart = tool / "cubepart"
    if not registry.venv_python("cube").exists():
        uv = registry.uv_path
        log("Creating CubePart venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        py = str(registry.venv_python("cube"))
        # fpsample pinned to 0.3.3: the last release with a macOS arm64 wheel
        # (1.0.x is a source-only Rust/C++ build, which a fresh Mac cannot
        # compile — MEASURED as the one thing in this env that needed a
        # compiler). cubepart calls bucket_fps_kdline_sampling(pc, n, h=…),
        # which 0.3.3 has with the same signature.
        # mlx: cubepart_worker swaps the denoiser to MLX (_cubepart_mlx.py);
        # the working environment had it by hand and a fresh one died on
        # "No module named 'mlx'" after loading 9.9 GB of checkpoint.
        _run(
            [uv, "pip", "install", "--python", py, "-e", str(cubepart), "fpsample==0.3.3", "mlx"],
            tool, log,
        )
        # cubepart's loose `diffusers>=0.30` resolves to 0.39+, whose
        # QwenEmbedRope.forward reordered args and breaks the QwenImage hijack
        # ("got multiple values for argument 'device'" — reproduced here).
        # 0.38.0 matches the hijack's calling convention.
        _run([uv, "pip", "install", "--python", py, "diffusers==0.38.0"], tool, log)


# A .pth line beginning with "import" is EXECUTED at interpreter startup, which
# is the only hook early enough here: SkinTokens' autocast decorators bind when
# src.model is imported, and its bpy subprocess imports the same modules
# independently, so a flag parsed inside a worker would already be too late.
_SKINTOKENS_PTH = (
    "import os, sys; "
    "_r = os.path.abspath(os.path.join(sys.prefix, os.pardir)); "
    "sys.path.insert(0, _r); "
    '__import__("apple_compat")\n'
)


def _provision_skintokens(registry: Registry, log) -> None:
    """Clone SkinTokens, build its venv, and install the Apple Silicon shims.

    Upstream states "An NVIDIA GPU with at least 14 GB of memory is required"
    and installs flash-attn. None of that is load-bearing for inference: the
    CUDA dependency is in HOW attention is computed and in a capability probe,
    not in the maths. The shims live in python/shims/skintokens/ as real
    reviewable files and are COPIED in — never patched over the checkout — so
    the clone stays a clean `git clone` at a pinned commit.

    MEASURED once they are in place: a rig in 76s at fp32 on MPS, against 1103s
    on CPU. fp32 is not an optimisation but a correctness requirement — see the
    shims' README.
    """
    tool = registry.ensure_tool_clone("SkinTokens", log)
    py = registry.skintokens_python()
    if not py.exists():
        uv = registry.uv_path
        log("Creating the SkinTokens venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        _run([uv, "pip", "install", "--python", str(py), "torch", "torchvision"], tool, log)
        _run(
            [uv, "pip", "install", "--python", str(py), "-r", str(tool / "requirements.txt")],
            tool,
            log,
        )

    # Rewritten on every provision, so a checkout pulled forward can never end
    # up running against stale shims.
    log("Installing the Apple Silicon shims…")
    shims = Path(__file__).resolve().parent.parent / "shims" / "skintokens"
    for name in ("flash_attn_interface.py", "apple_compat.py"):
        shutil.copyfile(shims / name, tool / name)
    site = next((tool / ".venv" / "lib").glob("python*/site-packages"), None)
    if site is None:
        raise RuntimeError("the SkinTokens venv has no site-packages")
    (site / "skintokens_apple_compat.pth").write_text(_SKINTOKENS_PTH)

    ckpt = (
        tool / "experiments" / "articulation_xl_quantization_256_token_4" / "grpo_1400.ckpt"
    )
    if not ckpt.exists():
        log("Downloading the SkinTokens weights…")
        _run([str(py), "download.py", "--model"], tool, log)


def _provision_quadriflow(registry: Registry, log) -> None:
    """QuadriFlow, the PRIMARY quad remesher — from the shipped prebuilt copy.

    It was a hand-built binary in `bin/` that nothing provisioned: a fresh Mac
    had no remesher at all and every quad retopology failed at the exec. The
    app ships the arm64 build (BSD, hjwdzh/QuadriFlow) and copies it in.
    """
    cli = registry.quadriflow_cli()
    if cli.exists():
        return
    shipped = registry.prebuilt("darwin-arm64", "quadriflow")
    if shipped is None:
        log("QuadriFlow is not shipped for this platform; quad retopology will be unavailable")
        return
    log("Installing QuadriFlow…")
    shutil.copyfile(shipped, cli)
    cli.chmod(0o755)
    subprocess.run(["xattr", "-d", "com.apple.quarantine", str(cli)], capture_output=True)


def _provision_autoremesher(registry: Registry, model: dict, log) -> None:
    _provision_quadriflow(registry, log)
    cli = registry.autoremesher_cli()
    spec = registry.spec["autoremesher"]
    if not cli.exists():
        dmg = registry.bin_dir / "autoremesher.dmg"
        if not dmg.exists() or dmg.stat().st_size != int(spec["dmgBytes"]):
            log(f"Downloading AutoRemesher 1.0.0 ({spec['dmgUrl']})…")
            urllib.request.urlretrieve(spec["dmgUrl"], dmg)
        log("Mounting dmg + installing autoremesher.app…")
        attach = subprocess.run(
            ["hdiutil", "attach", "-nobrowse", "-plist", str(dmg)],
            capture_output=True,
            check=True,
        )
        mount_point = None
        for entity in plistlib.loads(attach.stdout).get("system-entities", []):
            if entity.get("mount-point"):
                mount_point = entity["mount-point"]
        if mount_point is None:
            raise RuntimeError("hdiutil attach produced no mount point")
        try:
            _run(
                ["cp", "-R", str(Path(mount_point) / "autoremesher.app"), str(registry.bin_dir)],
                None,
                log,
            )
        finally:
            subprocess.run(["hdiutil", "detach", mount_point, "-quiet"], capture_output=True)
        subprocess.run(
            ["xattr", "-dr", "com.apple.quarantine", str(registry.bin_dir / "autoremesher.app")],
            capture_output=True,
        )
        dmg.unlink(missing_ok=True)
    make_autoremesher_headless(registry, log)
    _provision_meshtools(registry, log)


def make_autoremesher_headless(registry: Registry, log) -> None:
    """Stop AutoRemesher from bouncing into the Dock on every retopo.

    AutoRemesher is a Qt app that also accepts `--input/--output`; even on the
    headless path it constructs a QApplication. Its qmake-generated Info.plist
    declares `NSPrincipalClass=NSApplication` with `CFBundlePackageType=APPL`
    and no LSUIElement, so LaunchServices registers each run as a FOREGROUND
    application — verified with `lsappinfo info <pid>` reporting
    type="Foreground" during a real retopo.

    LSUIElement=true is the documented "agent" opt-out: same Cocoa platform
    plugin, no Dock tile and no menu bar. Editing Info.plist breaks the bundle
    seal, so we re-sign ad-hoc afterwards. Idempotent — it also repairs an
    install made before this fix existed.
    """
    app_dir = registry.bin_dir / "autoremesher.app"
    plist_path = app_dir / "Contents" / "Info.plist"
    if not plist_path.exists():
        return
    try:
        info = plistlib.loads(plist_path.read_bytes())
    except Exception as err:  # noqa: BLE001 — never block a retopo on this
        log(f"could not read autoremesher Info.plist: {err}")
        return
    if info.get("LSUIElement") is True:
        return
    info["LSUIElement"] = True
    plist_path.write_bytes(plistlib.dumps(info))
    # Re-seal: the signature covers Info.plist. An ad-hoc signature is enough —
    # the bundle is already de-quarantined, so Gatekeeper does not evaluate it.
    subprocess.run(
        ["codesign", "--force", "--sign", "-", str(app_dir)], capture_output=True
    )
    log("Patched autoremesher.app → LSUIElement (no Dock tile)")


# trimesh's repair paths (fill_holes, fix_winding, connected-component split)
# are graph-backed: without networkx they RAISE, the retopo input reaches
# AutoRemesher unhealed, and the remesh comes back full of holes. scipy backs
# the spatial queries those repairs use. Both are load-bearing, not optional.
MESHTOOLS_PACKAGES = [
    "trimesh==4.5.3",
    "numpy",
    "pillow",
    "networkx",
    "scipy",
    # Quadric decimation — the retopo stage caps input density before handing
    # the mesh to AutoRemesher (see _meshprep.decimate_to for the measurement).
    "fast-simplification",
    # UV unwrapping, so retopology can bake the original's texture onto the new
    # topology instead of dropping it (see _texbake).
    "xatlas",
    # trimesh reaches for these by name: marching cubes (make_manifold's closed
    # surface) is scikit-image, spatial queries are rtree, booleans/repair are
    # manifold3d. MEASURED on a fresh cache: the quad retopo died on
    # "No module named 'skimage'" — the working venv had all three by hand.
    "scikit-image",
    "rtree",
    "manifold3d",
]
MESHTOOLS_IMPORTS = [
    "trimesh",
    "numpy",
    "PIL",
    "networkx",
    "scipy",
    "fast_simplification",
    "xatlas",
    "skimage",
    "rtree",
    "manifold3d",
]


#: What the ardy venv must import before it counts as provisioned.
# mlx.core: the text encoder runs in MLX (workers/_llm2vec_mlx.py) — an ardy
# venv from before that port lacks it and is re-provisioned by this probe.
ARDY_IMPORTS = ("ardy", "torch", "peft", "vector_quantize_pytorch", "mlx.core")
# The MLX the encoder was validated on (cosine 0.99993 against PyTorch fp32).
ARDY_MLX = "mlx==0.32.0"


def _provision_ardy(registry: Registry, log) -> None:
    """NVIDIA ARDY (text -> human motion) in its own venv.

    Its own venv rather than sharing one: ARDY pins `transformers==5.8.1` for
    the LLM2Vec text encoder it vendors, and the audio stack runs 5.12. That is
    not a conflict worth negotiating — a venv costs disk, a wrong transformers
    costs a text encoder that loads and returns nonsense.

    NOTHING IS PATCHED HERE. Every other native tool in this file needs source
    fixes to run on a Mac; ARDY does not. The two places it assumes CUDA are
    both call-site decisions (which device to pick, and a float64 rest-pose
    buffer MPS cannot hold), and motion_worker.py handles both without touching
    the checkout — see cast_f64_buffers and to_device there.
    """
    uv = registry.uv_path
    tool = registry.ensure_tool_clone("ardy", log)
    python = tool / ".venv" / "bin" / "python"
    if not python.exists():
        log("Creating the motion venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.12"], tool, log)
    probe = subprocess.run(
        [str(python), "-c", "import " + ", ".join(ARDY_IMPORTS)],
        capture_output=True,
        text=True,
    )
    if probe.returncode == 0:
        return
    log("Installing ARDY (torch + LLM2Vec text encoder)…")
    # THE CHECKOUT IS WHAT RUNS, both ways. An editable install is a .pth line
    # pointing at the tree plus a build of MotionCorrection's C++ extension —
    # and that build is a CMake run a fresh Mac cannot do. So the extension is
    # shipped built (motion_correction-*.whl in the prebuilt tree, from this
    # same pinned commit), the dependencies come from pyproject, and the .pth
    # line is written by hand: the skeleton assert in motion_worker.py still
    # reads the pinned source. A platform the manifest does not cover takes
    # the editable build as before.
    manifest = _prebuilt_manifest(registry)
    wheel = None if manifest is None else registry.prebuilt("darwin-arm64", manifest.get("motionCorrection", ""))
    if wheel is None:
        _run([uv, "pip", "install", "--python", str(python), "-e", str(tool), ARDY_MLX], tool, log)
        return
    deps = _project_dependencies(tool / "pyproject.toml")
    # pillow: the working venv had it by hand (the worker's texture pass-through).
    _run(
        [uv, "pip", "install", "--python", str(python), *deps, "pillow", ARDY_MLX, str(wheel)],
        tool,
        log,
    )
    site = next((tool / ".venv" / "lib").glob("python*/site-packages"), None)
    if site is None:
        raise RuntimeError("the ARDY venv has no site-packages")
    (site / "ardy-checkout.pth").write_text(str(tool) + "\n")


def _project_dependencies(pyproject: Path) -> list[str]:
    """`[project] dependencies` of a pyproject.toml, as pip requirement strings."""
    import tomllib

    data = tomllib.loads(pyproject.read_text())
    return list(data.get("project", {}).get("dependencies", []))


def _provision_meshtools(registry: Registry, log) -> None:
    """Tiny mesh-prep venv (weld/heal + GLB↔OBJ) for the retopo worker.

    Repairs an EXISTING venv too — an install from before networkx was required
    would otherwise silently keep producing holed retopology.
    """
    uv = registry.uv_path
    meshtools = registry.tool_dir("meshtools")
    python = registry.meshtools_python()
    if not python.exists():
        meshtools.mkdir(parents=True, exist_ok=True)
        log("Creating meshtools venv (trimesh)…")
        _run([uv, "venv", str(meshtools / ".venv"), "--python", "3.12"], meshtools, log)
    probe = subprocess.run(
        [str(python), "-c", "import " + ", ".join(MESHTOOLS_IMPORTS)],
        capture_output=True,
        text=True,
    )
    if probe.returncode == 0:
        return
    log("Installing meshtools dependencies (trimesh + repair stack)…")
    _run([uv, "pip", "install", "--python", str(python), *MESHTOOLS_PACKAGES], meshtools, log)


def write_registry_note(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))


#: What the audio venv must be able to import before it counts as provisioned.
AUDIO_IMPORTS = ("parakeet_mlx", "mlx_audio", "numpy")


def _provision_audio(registry: Registry, log) -> None:
    """One venv for all three audio ops, plus the thinksound.cpp build for SFX.

    ONE venv on purpose: text→speech, speech→text and text→sound share MLX and
    numpy, and a 24 GB machine should never hold two of these at once anyway
    (jobs.py runs a single worker at a time for exactly this reason).

    The SFX side is a native build rather than a wheel — thinksound.cpp is GGML
    with a Metal backend, so it is compiled here the same way AutoRemesher and
    QuadriFlow are. Two upstream fixes are needed on macOS and are applied to
    the checkout after clone (see _patch_thinksound_for_macos).
    """
    uv = registry.uv_path
    audio = registry.tool_dir("audio")
    python = audio / ".venv" / "bin" / "python"
    if not python.exists():
        audio.mkdir(parents=True, exist_ok=True)
        log("Creating the audio venv…")
        _run([uv, "venv", str(audio / ".venv"), "--python", "3.12"], audio, log)
    probe = subprocess.run(
        [str(python), "-c", "import " + ", ".join(AUDIO_IMPORTS)],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        log("Installing the audio stack (parakeet-mlx + mlx-audio)…")
        _run([uv, "pip", "install", "--python", str(python), "parakeet-mlx", "mlx-audio"], audio, log)

    # SFX: clone + build thinksound.cpp. Skipped entirely if it is already built,
    # since this is a multi-minute compile.
    tool = registry.ensure_tool_clone("thinksound.cpp", log)
    cli = tool / "build" / "ts-dasheng_generate"
    if cli.exists():
        return
    _patch_thinksound_for_macos(tool, log)
    log("Building thinksound.cpp (GGML + Metal)…")
    _run(["cmake", "-S", str(tool), "-B", str(tool / "build"), "-DCMAKE_BUILD_TYPE=Release"], tool, log)
    _run(["cmake", "--build", str(tool / "build"), "-j", "8"], tool, log)


def _patch_thinksound_for_macos(tool: Path, log) -> None:
    """Two upstream bugs that make thinksound.cpp unusable on a Mac.

    BOTH were hit on a real run, and neither is subtle once seen:

    1. `ts_resolve_gguf_dir` finds its own executable with
       `read_symlink("/proc/self/exe")`. That path is Linux-only; on macOS the
       throw escapes `main()` before any argument is parsed, so even `--help`
       died with an uncaught filesystem_error. Darwin's answer is
       _NSGetExecutablePath.

    2. `ts-dasheng_generate` wrote a perfectly good wav and then aborted with
       SIGABRT (exit 134) inside a STATIC destructor: ggml keeps its Metal
       devices in a function-local static whose destructor asserts the
       residency-set collection is empty, and something in the model wrappers
       has not freed a buffer. A caller reading the exit status sees a failure
       that did not happen. Leaving via _Exit after the file is closed skips
       static teardown; the kernel reclaims the memory. This does NOT fix the
       leak — that is worth reporting upstream — it stops the leak from being
       reported as a failed generation.

    Both are applied idempotently, so a re-provision over a patched checkout is
    a no-op rather than a double edit.
    """
    utils = tool / "src" / "common" / "ts_utils.cpp"
    if utils.exists():
        text = utils.read_text()
        if "_NSGetExecutablePath" not in text:
            log("Patching thinksound: /proc/self/exe is Linux-only")
            text = text.replace(
                'fs::path exe = fs::read_symlink("/proc/self/exe");',
                "fs::path exe;\n"
                "#if defined(__APPLE__)\n"
                "    { char buf[4096]; uint32_t sz = sizeof(buf);\n"
                "      if (_NSGetExecutablePath(buf, &sz) == 0) {\n"
                "          std::error_code ec; fs::path c = fs::canonical(fs::path(buf), ec);\n"
                "          exe = ec ? fs::path(buf) : c; } }\n"
                "#else\n"
                "    { std::error_code ec; exe = fs::read_symlink(\"/proc/self/exe\", ec);\n"
                "      if (ec) exe.clear(); }\n"
                "#endif",
            )
            if "#include <mach-o/dyld.h>" not in text:
                i = text.index("#include")
                text = text[:i] + "#if defined(__APPLE__)\n#include <mach-o/dyld.h>\n#endif\n" + text[i:]
            utils.write_text(text)

    gen = tool / "src" / "tools" / "dasheng_generate.cpp"
    if gen.exists():
        text = gen.read_text()
        if "std::_Exit(0)" not in text:
            log("Patching thinksound: skip static teardown after writing the wav")
            text = text.replace(
                "    return 0;\n}",
                "    // ggml's static Metal-device destructor asserts its residency set is\n"
                "    // empty and it is not, aborting AFTER a good wav is written. Leave\n"
                "    // before static teardown; the kernel reclaims the rest.\n"
                "    fflush(nullptr);\n"
                "    std::_Exit(0);\n}",
            )
            if "#include <cstdlib>" not in text:
                i = text.index("#include")
                text = text[:i] + "#include <cstdlib>\n" + text[i:]
            gen.write_text(text)
