"""Model registry + on-disk layout. Facts (repos/patterns/sizes) come from the
TypeScript catalog via the --registry JSON; this module owns PATHS and the
installed-state checks against them.

Layout under the cache root (~/.cache/bobble/gen3d):
  hf/         HF_HOME for every weight download (standard hub cache)
  src/        cloned tool repos + their venvs (trellis-mac, Mage, cube, ...)
  bin/        the AutoRemesher .app
  installed/  <model-id>.json stamps written after weights+env verification
  assembled/  checkpoint dirs built from other repos' files (a model's
              `layout`): symlinks into hf/ plus a few small files
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import uuid
from pathlib import Path

# Pinned tool-repo commits (verified working together on this hardware,
# 2026-07-23). Bump deliberately.
TOOL_REPOS = {
    "trellis-mac": (
        "https://github.com/shivampkumar/trellis-mac.git",
        "d58628f4f5b9c3de8274cb110074154f4b31cef2",
    ),
    "trellis2-apple": (
        # The MLX tree: geometry at ~3x the PyTorch-MPS tree's speed, the only
        # path that runs 1024, and the only one carrying the texturing pipeline
        # that can paint an EXISTING mesh. It was missing from this table
        # entirely, so `_provision_trellis_mlx` raised KeyError on any machine
        # that did not already have the checkout — i.e. every machine but the
        # one it was set up on by hand.
        "https://github.com/pedronaugusto/trellis2-apple.git",
        # Pinned like SkinTokens and for the same reason: patches/o_voxel_cpu.py
        # writes a file this checkout does not ship and rewrites two of its
        # sources, so an upstream change needs those re-checked rather than
        # silently applied to something different.
        "6055b868734af6e12769d229d90580e775fae9f0",
    ),
    "SkinTokens": (
        "https://github.com/VAST-AI-Research/SkinTokens.git",
        # Pinned deliberately: the shims written by _provision_skintokens patch
        # around specific upstream behaviour (an H100 probe that RAISES without
        # CUDA, a hard-coded flash_attention_2, and `@torch.autocast('cuda')`
        # decorators that bind at import time). An upstream change to any of
        # those needs the shims re-checked, so this must not drift silently.
        "273b691d35989d71cd17ff2895fdc735097b92d1",
    ),
    "Mage": (
        "https://github.com/microsoft/Mage.git",
        "df7f84d9f8fc991d189d929f03cff623b430a4a2",
    ),
    "cube": (
        "https://github.com/Roblox/cube.git",
        "3c6d06ddbef3160a1e1950cb13ab63dd12a61e50",
    ),
    "ardy": (
        "https://github.com/nv-tlabs/ardy.git",
        # Not patched, unlike the entries below — ARDY runs on Metal unmodified,
        # with the device handling done at the call site in motion_worker.py.
        # Pinned anyway: the worker asserts ARDY's skeleton is still cskel27
        # joint-for-joint, and a pin makes that assert a build-time promise
        # rather than a runtime surprise.
        "693f74d13b3d04a0a22ce127ee79c929dd89756b",
    ),
    "thinksound.cpp": (
        "https://github.com/pwilkin/thinksound.cpp.git",
        # Pinned for the same reason as SkinTokens: _patch_thinksound_for_macos
        # rewrites two specific places in this tree (the /proc/self/exe lookup
        # in ts_utils.cpp and the return from dasheng_generate's main). Both
        # patches match on exact source text, so an upstream edit to either
        # must be re-checked rather than silently no-op.
        "be3c11a474af",
    ),
}


class Registry:
    def __init__(self, spec: dict, cache_dir: Path) -> None:
        self.spec = spec
        self.cache_dir = cache_dir
        self.hf_home = cache_dir / "hf"
        self.src_dir = cache_dir / "src"
        self.bin_dir = cache_dir / "bin"
        self.stamp_dir = cache_dir / "installed"
        for d in (self.hf_home, self.src_dir, self.bin_dir, self.stamp_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.uv_path = shutil.which("uv") or str(Path.home() / ".local" / "bin" / "uv")
        # What the app ships ready-built for this platform (see prebuilt_dir):
        # the Metal wheels a fresh Mac cannot compile, and QuadriFlow.
        prebuilt = spec.get("prebuiltDir")
        self.prebuilt_dir: Path | None = (
            Path(prebuilt) if isinstance(prebuilt, str) and prebuilt else None
        )

    @classmethod
    def load(cls, registry_path: Path, cache_dir: Path) -> "Registry":
        return cls(json.loads(registry_path.read_text()), cache_dir)

    # ---- spec access ------------------------------------------------------
    def model_ids(self) -> list[str]:
        return [m["id"] for m in self.spec["models"]]

    def model(self, model_id: str) -> dict | None:
        for m in self.spec["models"]:
            if m["id"] == model_id:
                return m
        return None

    def pipeline_type(self, resolution: str) -> str:
        return self.spec["pipelineTypes"].get(resolution, "512")

    # ---- paths -------------------------------------------------------------
    def stamp_path(self, model_id: str) -> Path:
        return self.stamp_dir / f"{model_id}.json"

    def tool_dir(self, name: str) -> Path:
        return self.src_dir / name

    def venv_python(self, tool: str) -> Path:
        return self.tool_dir(tool) / ".venv" / "bin" / "python"

    def autoremesher_cli(self) -> Path:
        return self.bin_dir / "autoremesher.app" / "Contents" / "MacOS" / "autoremesher"

    def mflux_cli(self) -> Path:
        """Mage-Flow-Turbo via mflux (MIT) — the FAST image path.

        MEASURED, all outputs checked by eye: Mage-Flow-Turbo on PyTorch MPS
        71s; FLUX.2 Klein 4B on MLX 13s / 17.94 GB; Mage-Flow-Turbo on MLX
        **11s / 14.69 GB** at 8-bit — fastest, lightest, and the best image.
        (4-bit Mage-Flow renders NOISE while exiting 0 — see mlx_image_worker.)
        """
        return self.tool_dir("mflux") / ".venv" / "bin" / "mflux-generate-mage-flow"

    def mflux_edit_cli(self) -> Path:
        """Mage-Flow-Edit-Turbo — edit an existing image from a text instruction.

        MEASURED: 9s for a 1024px edit at 4 steps, 14.76 GB peak, on the same
        mflux venv as generation. Its transformer is a separate download from
        the generator's; the text encoder and VAE are the same files.
        """
        return self.tool_dir("mflux") / ".venv" / "bin" / "mflux-generate-mage-flow-edit"

    def quadriflow_cli(self) -> Path:
        """QuadriFlow (MIT) — the PRIMARY quad remesher.

        AutoRemesher could not remesh TRELLIS output at all on this machine: it
        dies on an assertion inside its vendored geogram 1.8.3
        (`hexdom/quad_cover.cpp:207`) even on a flawless watertight mesh, and at
        smaller inputs it simply never converges (measured: crash in 2-4s at
        200k faces, >7min no-output at 30k and 80k, every target-quad setting).
        QuadriFlow remeshed the identical model in 15s at 100% quads. It is also
        a plain CLI with no Qt, so it cannot take a dock tile.
        """
        return self.bin_dir / "quadriflow"

    def mlx_trellis_dir(self) -> Path:
        """The MLX TRELLIS checkout, when it has been provisioned."""
        return self.tool_dir("trellis2-apple")

    def geometry_tool_dir(self) -> Path:
        """MLX TRELLIS when present, else the PyTorch-MPS checkout.

        MEASURED on the same image at 512, both output meshes rendered and
        compared side by side (indistinguishable): MPS 225s (82s load + 137s
        generate) vs MLX **76s** (3s + 73s) — 3x, at identical quality.
        """
        mlx = self.mlx_trellis_dir()
        return mlx if (mlx / ".venv" / "bin" / "python").exists() else self.tool_dir("trellis-mac")

    def trellis_snapshot_dir(self) -> Path | None:
        """The cached TRELLIS.2-4B snapshot dir (has pipeline.json + ckpts)."""
        base = self.hf_home / "hub" / "models--microsoft--TRELLIS.2-4B" / "snapshots"
        if not base.exists():
            return None
        for d in sorted(base.iterdir()):
            if (d / "pipeline.json").exists():
                return d
        return None

    def geometry_python(self) -> Path:
        return self.geometry_tool_dir() / ".venv" / "bin" / "python"

    def skintokens_dir(self) -> Path:
        """The SkinTokens checkout, when it has been provisioned."""
        return self.tool_dir("SkinTokens")

    def skintokens_python(self) -> Path:
        return self.skintokens_dir() / ".venv" / "bin" / "python"

    def has_skintokens(self) -> bool:
        """True when the learned rigger is usable.

        Needs the venv AND the checkpoint: a half-provisioned checkout would
        otherwise take the rig stage and fail at load, when the geometric rigger
        would have produced something.
        """
        ckpt = (
            self.skintokens_dir()
            / "experiments"
            / "articulation_xl_quantization_256_token_4"
            / "grpo_1400.ckpt"
        )
        return self.skintokens_python().exists() and ckpt.exists()

    def meshtools_python(self) -> Path:
        return self.tool_dir("meshtools") / ".venv" / "bin" / "python"

    # ---- hub cache --------------------------------------------------------------
    def hub_repo_dir(self, repo: str) -> Path:
        """`models--org--name` in the hub cache (a symlink to its library shelf
        once the app has shelved it — every path below follows it)."""
        return self.hf_home / "hub" / ("models--" + repo.replace("/", "--"))

    def repo_snapshot(self, spec: dict) -> Path | None:
        """The snapshot dir holding a COMPLETE copy of `spec`, or None.

        Complete means every pinned file resolves to the blob its sha256 names
        and every literal allow-pattern is a file (a glob needs one match). This
        reads the cache layout directly rather than asking huggingface_hub:
        `snapshot_download(local_files_only=True)` answers yes for a snapshot
        folder that exists at all, which an interrupted download also leaves.
        `refs/main`'s snapshot is tried first, then the rest, newest first.
        """
        base = self.hub_repo_dir(spec["repo"]) / "snapshots"
        if not base.is_dir():
            return None
        try:
            head = (self.hub_repo_dir(spec["repo"]) / "refs" / "main").read_text().strip()
        except OSError:
            head = ""
        try:
            others = [d for d in base.iterdir() if d.is_dir() and d.name != head]
        except OSError:
            return None
        others.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        first = [base / head] if head and (base / head).is_dir() else []
        for snap in first + others:
            if snapshot_complete(snap, spec):
                return snap
        return None

    def pin_mismatch(self, spec: dict) -> str | None:
        """Why a freshly downloaded `spec` is not the pinned bytes, or None.

        The hub names an LFS blob after its sha256, so a file the hub now serves
        with different bytes lands under a different name — this says which.
        """
        base = self.hub_repo_dir(spec["repo"]) / "snapshots"
        try:
            snaps = sorted(base.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True)
        except OSError:
            return f"{spec['repo']} left no snapshot in the cache"
        for pin in spec.get("pinned") or []:
            for snap in snaps:
                path = snap / pin["path"]
                if not path.exists():
                    continue
                got = Path(os.path.realpath(path)).name
                if got != pin["sha256"] and path.is_symlink():
                    return (
                        f"{spec['repo']}: {pin['path']} is not the pinned file "
                        f"(sha256 {got[:12]}…, expected {pin['sha256'][:12]}…) — refusing to use it"
                    )
                break
            else:
                return f"{spec['repo']}: {pin['path']} did not download"
        return None

    # ---- installed checks ---------------------------------------------------
    def legacy_snapshot(self, model_id: str) -> Path | None:
        """A complete copy of a repo this model used to download, or None."""
        model = self.model(model_id) or {}
        for spec in model.get("legacyRepos") or []:
            snap = self.repo_snapshot(spec)
            if snap is not None:
                return snap
        return None

    def weights_present(self, model_id: str) -> bool:
        """True when the weights are on disk: every repo complete, or a
        complete legacy copy (see `legacyRepos` in the catalog)."""
        model = self.model(model_id)
        if model is None:
            return False
        if not model["repos"]:
            return True
        if self.legacy_snapshot(model_id) is not None:
            return True
        if model.get("layout") or any(r.get("pinned") for r in model["repos"]):
            return all(self.repo_snapshot(r) is not None for r in model["repos"])
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            return False
        for repo in model["repos"]:
            try:
                snapshot_download(
                    repo["repo"],
                    allow_patterns=list(repo.get("allowPatterns") or []) or None,
                    local_files_only=True,
                )
            except Exception:
                return False
        return True

    def model_dir(self, model_id: str) -> Path | None:
        """The checkpoint directory a worker loads for `model_id`, or None.

        A complete legacy snapshot wins (it IS the release's directory); else a
        model with a `layout` gets its assembled directory, rebuilt if anything
        in it no longer matches its sources; else None.
        """
        legacy = self.legacy_snapshot(model_id)
        if legacy is not None:
            return legacy
        model = self.model(model_id) or {}
        layout = model.get("layout")
        if not layout:
            return None
        snaps: dict[str, Path] = {}
        for spec in model["repos"]:
            snap = self.repo_snapshot(spec)
            if snap is None:
                return None
            snaps[spec["repo"]] = snap
        return self.ensure_layout(model_id, layout, snaps)

    def assembled_dir(self, model_id: str) -> Path:
        return self.cache_dir / "assembled" / model_id

    def ensure_layout(self, model_id: str, layout: list[dict], snaps: dict[str, Path]) -> Path:
        """Build (or keep) `assembled/<model_id>` from `layout`.

        Symlinks point at the SNAPSHOT paths (never the resolved blobs), so the
        hub's own indirection — and the library shelf the app may move a repo
        to — stays in the chain. Built beside the target and swapped in, so a
        reader never sees half a directory.
        """
        dest = self.assembled_dir(model_id)
        if _layout_matches(dest, layout, snaps):
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".{model_id}.{uuid.uuid4().hex[:8]}"
        try:
            for entry in layout:
                target = tmp / entry["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                if entry["kind"] == "text":
                    target.write_bytes(entry["text"].encode("utf-8"))
                elif entry["kind"] == "file":
                    os.symlink(str(snaps[entry["repo"]] / entry["source"]), target)
                elif entry["kind"] == "dir":
                    source = snaps[entry["repo"]]
                    for rel in _snapshot_files(source):
                        link = target / rel
                        link.parent.mkdir(parents=True, exist_ok=True)
                        os.symlink(str(source / rel), link)
                else:
                    raise ValueError(f"unknown layout entry kind {entry['kind']!r}")
            old = None
            if dest.exists() or dest.is_symlink():
                old = dest.parent / f".{model_id}.old.{uuid.uuid4().hex[:8]}"
                dest.rename(old)
            tmp.rename(dest)
            if old is not None:
                shutil.rmtree(old, ignore_errors=True)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return dest

    def env_present(self, model_id: str) -> bool:
        model = self.model(model_id)
        if model is None:
            return False
        env = model["env"]
        if env == "trellis":
            # Either tree runs the geometry; the MLX one is the fast one and
            # the only one a Mac without Xcode can have (prebuilt wheels).
            return (
                self.venv_python("trellis2-apple").exists()
                or self.venv_python("trellis-mac").exists()
            )
        if env == "mageflow":
            return self.venv_python("Mage").exists()
        if env == "cubepart":
            # CubePart lives in the 'cube' checkout; this env check serves it.
            return self.venv_python("cube").exists()
        if env == "paint":
            return self.venv_python("Hunyuan3D-2.1-mac").exists()
        if env == "binary":
            return self.autoremesher_cli().exists() and self.meshtools_python().exists()
        if env == "skintokens":
            return self.has_skintokens()
        if env == "meshtools":
            # The humanoid rigger runs entirely inside the mesh-prep venv —
            # nothing to download, so "installed" == the venv is usable.
            return self.meshtools_python().exists()
        if env in ("ardy", "audio"):
            # Both are plain venvs under their own tool dir, named after the env.
            return self.venv_python(env).exists()
        # An env with no case here can NEVER report installed, no matter what is
        # downloaded — which is exactly what happened to ardy-motion: the model
        # was complete on disk and the panel still said "isn't downloaded yet",
        # and no amount of using the download button could have fixed it.
        # test_env_present_covers_every_env keeps a new env from landing mute.
        raise ValueError(f"env_present has no case for env {env!r}")

    def is_installed(self, model_id: str) -> bool:
        if not (self.weights_present(model_id) and self.env_present(model_id)):
            return False
        # A stamp records "the download finished". Models with NO weights to
        # download (the AutoRemesher binary, the local humanoid rigger) are
        # fully described by env_present, and demanding a stamp they can never
        # earn just makes a working tool look uninstalled.
        model = self.model(model_id)
        if model is not None and not model["repos"]:
            return True
        return self.stamp_path(model_id).exists()

    def write_stamp(self, model_id: str) -> None:
        self.stamp_path(model_id).write_text(json.dumps({"id": model_id, "ok": True}))

    # ---- prebuilt ------------------------------------------------------------
    def prebuilt(self, *parts: str) -> Path | None:
        """A file under the shipped prebuilt tree, or None when it is not there."""
        if self.prebuilt_dir is None:
            return None
        p = self.prebuilt_dir.joinpath(*parts)
        return p if p.exists() else None

    # ---- tool sources ----------------------------------------------------------
    def ensure_tool_clone(self, name: str, log) -> Path:
        """The tool's source tree at its pinned commit — WITHOUT git.

        The user (2026-09-15): "all basic stuff needs to work out of the box". A
        `git clone` on a Mac that has never installed the Command Line Tools is
        not a clone: it is the "would you like to install the developer tools?"
        dialog, and the sidecar hanging behind it. So a missing tree comes down
        as GitHub's archive of the pinned commit (a plain tarball, unpacked with
        Python's own tarfile) and remembers its pin in `.bobble-pin`.

        A tree that is already here is left as it is: a git checkout made
        before this existed is moved to the pin only when git can actually run
        (never prompting for it), and a tarball tree is at its pin by
        construction.
        """
        url, pin = TOOL_REPOS[name]
        dest = self.tool_dir(name)
        if dest.exists():
            if (dest / ".git").exists() and git_usable():
                subprocess.run(
                    ["git", "-C", str(dest), "checkout", pin], check=False, capture_output=True
                )
            return dest
        log(f"Fetching {name}…")
        try:
            fetch_tool_archive(url, pin, dest)
        except Exception as err:  # noqa: BLE001 — the archive is the way; git is the old one
            if not git_usable():
                raise RuntimeError(
                    f"could not fetch {name} from GitHub ({err}) and git is not available"
                ) from err
            log(f"Archive download failed ({err}); cloning {name} with git instead…")
            subprocess.run(["git", "clone", url, str(dest)], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(dest), "checkout", pin], check=True, capture_output=True
            )
        return dest


_GLOB_CHARS = frozenset("*?[")


def pinned_file_ok(path: Path, pin: dict) -> bool:
    """Is `path` (a snapshot entry) the pinned file?

    In the hub cache a snapshot entry is a symlink to `blobs/<etag>`, and an LFS
    file's etag is the sha256 of its bytes — so the name the link resolves to
    IS the check, with nothing hashed. A plain file (a cache written without
    symlinks, as the hub library does where it cannot make them) is held to
    its size, the one thing cheap to check.
    """
    try:
        if not path.is_file():  # follows the link: a dangling one is not a file
            return False
        if path.is_symlink():
            return Path(os.path.realpath(path)).name == pin["sha256"]
        return path.stat().st_size == pin["bytes"]
    except OSError:
        return False


def snapshot_complete(snap: Path, spec: dict) -> bool:
    """Every pinned file right, and every allow-pattern satisfied, in `snap`."""
    for pin in spec.get("pinned") or []:
        if not pinned_file_ok(snap / pin["path"], pin):
            return False
    for pattern in spec.get("allowPatterns") or []:
        if _GLOB_CHARS & set(pattern):
            if not any(p.is_file() for p in snap.glob(pattern)):
                return False
        elif not (snap / pattern).is_file():
            return False
    return True


def _snapshot_files(root: Path) -> list[Path]:
    """Every file under a snapshot dir, relative to it, in a stable order."""
    out: list[Path] = []
    for dirpath, _dirs, files in os.walk(root, followlinks=True):
        out.extend(Path(dirpath, name).relative_to(root) for name in files)
    return sorted(out)


def _link_ok(link: Path, expected: Path) -> bool:
    try:
        return link.is_symlink() and os.readlink(link) == str(expected) and link.exists()
    except OSError:
        return False


def _layout_matches(dest: Path, layout: list[dict], snaps: dict[str, Path]) -> bool:
    """Does `dest` already hold exactly this layout over these snapshots?"""
    if not dest.is_dir():
        return False
    try:
        for entry in layout:
            target = dest / entry["path"]
            kind = entry["kind"]
            if kind == "text":
                if target.is_symlink() or not target.is_file():
                    return False
                if target.read_bytes() != entry["text"].encode("utf-8"):
                    return False
            elif kind == "file":
                if not _link_ok(target, snaps[entry["repo"]] / entry["source"]):
                    return False
            elif kind == "dir":
                source = snaps[entry["repo"]]
                want = _snapshot_files(source)
                have = sorted(p.relative_to(target) for p in target.rglob("*") if p.is_symlink())
                if want != have or not all(_link_ok(target / r, source / r) for r in want):
                    return False
            else:
                return False
    except OSError:
        return False
    return True


def git_usable() -> bool:
    """True when `git` runs here without asking macOS to install anything.

    On a Mac without the Command Line Tools `/usr/bin/git` exists and is the
    stub that opens the install dialog; `xcode-select -p` failing is how that
    is told apart from a real git, without ever running the stub.
    """
    if shutil.which("git") is None:
        return False
    if shutil.which("xcode-select") is not None:
        probe = subprocess.run(["xcode-select", "-p"], capture_output=True)
        if probe.returncode != 0:
            return False
    return True


def archive_url(repo_url: str, pin: str) -> str:
    """`https://github.com/o/r.git` + pin → GitHub's tarball of that commit."""
    base = repo_url.removesuffix(".git").rstrip("/")
    return f"{base}/archive/{pin}.tar.gz"


def fetch_tool_archive(repo_url: str, pin: str, dest: Path) -> None:
    """Download the pinned tarball and unpack it as `dest`.

    GitHub's archive has one top-level folder (`<repo>-<ref>`); that folder
    becomes `dest`. Unpacked beside `dest` first and renamed last, so a failed
    download never leaves a half tree that looks provisioned.
    """
    url = archive_url(repo_url, pin)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent, prefix=f".{dest.name}-") as tmp:
        tar_path = Path(tmp) / "src.tar.gz"
        # No system proxy handler: macOS proxies have broken localhost fetches
        # before (gen-service); GitHub is reached the plain way.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=120) as resp, tar_path.open("wb") as out:
            shutil.copyfileobj(resp, out)
        with tarfile.open(tar_path) as tar:
            tar.extractall(tmp, filter="data")
        tops = [p for p in Path(tmp).iterdir() if p.is_dir()]
        if len(tops) != 1:
            raise RuntimeError(f"unexpected archive layout for {url}: {[t.name for t in tops]}")
        (tops[0] / ".bobble-pin").write_text(pin + "\n")
        shutil.move(str(tops[0]), str(dest))
