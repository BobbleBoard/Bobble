"""Mage-Flow's weights moved — the sidecar's half of the fix, with no weights.

`microsoft/Mage-Flow-*` answers 401 to everyone now (2026-09-23), so a fresh
install could fetch neither the 3D module's image model nor the chat's edit
model. The catalog now builds each checkpoint from Comfy-Org/Mage-Flow (the
transformer and VAE) and Qwen/Qwen3-VL-4B-Instruct (the text encoder), pinned
by sha256, and the sidecar assembles the diffusers directory the workers load.

Everything here runs against a FAKE hub cache laid out exactly like the real
one (blobs named by their sha256, snapshot entries symlinked to them), built
from `fixtures/mage-flow-registry.json` — which a vitest test keeps identical
to what catalog.ts actually writes, so the field names cannot drift apart.
Blobs are a few bytes: the checks read names and links, never 17 GB.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / "workers"))

from engine import downloads as dl  # noqa: E402
from engine import registry as reg  # noqa: E402
from engine.jobs import MFLUX_BASE_MODELS, JobManager  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "mage-flow-registry.json"
GLOB = set("*?[")


def _models() -> list[dict]:
    return json.loads(FIXTURE.read_text())["models"]


def _model(model_id: str) -> dict:
    return next(m for m in _models() if m["id"] == model_id)


def _spec(model_id: str, repo: str) -> dict:
    model = _model(model_id)
    return next(r for r in model["repos"] + model.get("legacyRepos", []) if r["repo"] == repo)


def _registry(root: Path) -> reg.Registry:
    return reg.Registry({"models": _models(), "gatedMirrors": {}, "pipelineTypes": {}}, root)


def _fake_repo(
    r: reg.Registry,
    spec: dict,
    *,
    rev: str = "a" * 40,
    wrong: tuple[str, ...] = (),
    drop: tuple[str, ...] = (),
) -> Path:
    """Write a hub-cache copy of `spec` and return its snapshot dir.

    Every pinned file becomes a blob named by its sha256 (or by a wrong one,
    for the paths in `wrong`); every literal allow-pattern a small file; a glob
    pattern one file that matches it. `drop` leaves paths out.
    """
    repo_dir = r.hub_repo_dir(spec["repo"])
    blobs, snap = repo_dir / "blobs", repo_dir / "snapshots" / rev
    blobs.mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    (repo_dir / "refs").mkdir(exist_ok=True)
    (repo_dir / "refs" / "main").write_text(rev)

    def put(path: str, blob: str) -> None:
        (blobs / blob).write_bytes(b"weights")
        link = snap / path
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink() or link.exists():
            link.unlink()
        os.symlink(os.path.relpath(blobs / blob, link.parent), link)

    for pin in spec.get("pinned") or []:
        if pin["path"] not in drop:
            put(pin["path"], "f" * 64 if pin["path"] in wrong else pin["sha256"])
    for pattern in spec.get("allowPatterns") or []:
        if GLOB & set(pattern):
            if not any(snap.glob(pattern)):
                path = pattern.replace("*", "fake")
                put(path, "small-" + path.replace("/", "_"))
        elif pattern not in drop and not (snap / pattern).exists():
            put(pattern, "small-" + pattern.replace("/", "_"))
    return snap


def _fake_new_sources(r: reg.Registry, model_id: str, **kw) -> dict[str, Path]:
    return {spec["repo"]: _fake_repo(r, spec, **kw) for spec in _model(model_id)["repos"]}


# ---- installed-ness -----------------------------------------------------------


def test_nothing_on_disk_is_not_installed() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        for model_id in ("mageflow", "mageflow-edit"):
            assert r.weights_present(model_id) is False
            assert r.model_dir(model_id) is None


def test_the_new_sources_assemble_the_release_layout() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        snaps = _fake_new_sources(r, "mageflow")
        assert r.weights_present("mageflow") is True
        d = r.model_dir("mageflow")
        assert d == r.assembled_dir("mageflow"), d
        layout = {e["path"]: e for e in _model("mageflow")["layout"]}
        # The four release configs, byte for byte.
        for path, entry in layout.items():
            if entry["kind"] == "text":
                assert (d / path).read_bytes() == entry["text"].encode(), path
        comfy = snaps["Comfy-Org/Mage-Flow"]
        # The transformer and VAE link to the pinned Comfy-Org files — through
        # the snapshot path, so the hub's own indirection stays in the chain.
        t = d / "transformer" / "diffusion_pytorch_model.safetensors"
        assert os.readlink(t) == str(comfy / "diffusion_models/mage_flow_turbo_bf16.safetensors")
        turbo_sha = _spec("mageflow", "Comfy-Org/Mage-Flow")["pinned"][0]["sha256"]
        assert Path(os.path.realpath(t)).name == turbo_sha
        v = d / "vae" / "diffusion_pytorch_model.safetensors"
        assert os.readlink(v) == str(comfy / "vae/mage_flow_vae_bf16.safetensors")
        # text_encoder/ holds a link to every file of the Qwen snapshot.
        te = sorted(p.name for p in (d / "text_encoder").iterdir())
        qwen = sorted(p.name for p in snaps["Qwen/Qwen3-VL-4B-Instruct"].iterdir())
        assert te == qwen and "model-00001-of-00002.safetensors" in te, te
        # A second call keeps the directory rather than rebuilding it.
        inode = d.stat().st_ino
        assert r.model_dir("mageflow") == d and d.stat().st_ino == inode


def test_generator_and_editor_share_one_comfy_snapshot_but_not_a_transformer() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        _fake_new_sources(r, "mageflow")
        # Only the editor's transformer is missing — the rest is shared.
        assert r.weights_present("mageflow-edit") is False
        _fake_new_sources(r, "mageflow-edit")
        gen, edit = r.model_dir("mageflow"), r.model_dir("mageflow-edit")
        assert gen is not None and edit is not None and gen != edit
        name = lambda d: Path(os.path.realpath(d / "transformer/diffusion_pytorch_model.safetensors")).name  # noqa: E731
        assert name(gen) == _spec("mageflow", "Comfy-Org/Mage-Flow")["pinned"][0]["sha256"]
        assert name(edit) == _spec("mageflow-edit", "Comfy-Org/Mage-Flow")["pinned"][0]["sha256"]
        vae = lambda d: os.path.realpath(d / "vae/diffusion_pytorch_model.safetensors")  # noqa: E731
        assert vae(gen) == vae(edit)


def test_a_file_with_other_bytes_is_not_the_model() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        comfy = _spec("mageflow-edit", "Comfy-Org/Mage-Flow")
        edit_file = comfy["pinned"][0]["path"]
        _fake_repo(r, comfy, wrong=(edit_file,))
        _fake_repo(r, _spec("mageflow-edit", "Qwen/Qwen3-VL-4B-Instruct"))
        assert r.weights_present("mageflow-edit") is False
        assert r.model_dir("mageflow-edit") is None
        why = r.pin_mismatch(comfy) or ""
        assert edit_file in why and "refusing" in why, why


def test_a_missing_file_is_not_the_model() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        comfy = _spec("mageflow", "Comfy-Org/Mage-Flow")
        _fake_repo(r, comfy, drop=("vae/mage_flow_vae_bf16.safetensors",))
        _fake_repo(r, _spec("mageflow", "Qwen/Qwen3-VL-4B-Instruct"))
        assert r.weights_present("mageflow") is False
        assert "did not download" in (r.pin_mismatch(comfy) or "")


def test_an_old_microsoft_snapshot_still_counts_and_is_what_loads() -> None:
    """Existing installs (the user's included) keep their 17 GB — never re-fetched."""
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        legacy = _fake_repo(r, _spec("mageflow-edit", "microsoft/Mage-Flow-Edit-Turbo"))
        assert r.weights_present("mageflow-edit") is True
        assert r.model_dir("mageflow-edit") == legacy
        assert not r.assembled_dir("mageflow-edit").exists()
        # The generator's legacy repo is a different one.
        assert r.weights_present("mageflow") is False


def test_an_incomplete_old_snapshot_does_not_count() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        spec = _spec("mageflow", "microsoft/Mage-Flow-Turbo")
        _fake_repo(r, spec, drop=("text_encoder/model-00002-of-00002.safetensors",))
        assert r.weights_present("mageflow") is False


def test_a_layout_whose_source_moved_is_rebuilt() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        _fake_new_sources(r, "mageflow")
        d = r.model_dir("mageflow")
        assert d is not None
        # The text encoder is re-downloaded at another revision (main moved):
        # the old snapshot goes, the links must follow the new one.
        qwen = _spec("mageflow", "Qwen/Qwen3-VL-4B-Instruct")
        old_snap = r.hub_repo_dir(qwen["repo"]) / "snapshots" / ("a" * 40)
        new_snap = _fake_repo(r, qwen, rev="b" * 40)
        for p in old_snap.iterdir():
            p.unlink()
        old_snap.rmdir()
        d2 = r.model_dir("mageflow")
        assert d2 == d
        link = d2 / "text_encoder" / "model-00001-of-00002.safetensors"
        assert os.readlink(link) == str(new_snap / "model-00001-of-00002.safetensors")
        assert link.exists()


def test_a_shelved_hub_dir_is_followed() -> None:
    """The app moves a finished download onto its library shelf and leaves a
    symlink behind (storage/library-migration.ts). Nothing here may care."""
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp) / "cache")
        _fake_new_sources(r, "mageflow")
        for repo in ("Comfy-Org/Mage-Flow", "Qwen/Qwen3-VL-4B-Instruct"):
            hub = r.hub_repo_dir(repo)
            shelf = Path(tmp) / "Library" / hub.name
            shelf.parent.mkdir(parents=True, exist_ok=True)
            hub.rename(shelf)
            os.symlink(os.path.relpath(shelf, hub.parent), hub)
        d = r.model_dir("mageflow")
        assert d is not None
        assert (d / "transformer" / "diffusion_pytorch_model.safetensors").exists()
        assert (d / "text_encoder" / "model-00002-of-00002.safetensors").exists()


# ---- downloads ----------------------------------------------------------------


def test_progress_counts_this_models_blobs_not_the_shared_repos() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        hf = Path(tmp)
        edit = _spec("mageflow-edit", "Comfy-Org/Mage-Flow")
        turbo = _spec("mageflow", "Comfy-Org/Mage-Flow")
        blobs = dl.repo_cache_dir(hf, edit["repo"]) / "blobs"
        blobs.mkdir(parents=True)
        # The generator's 8 GB transformer is already here (a sparse file).
        with open(blobs / turbo["pinned"][0]["sha256"], "wb") as f:
            f.truncate(turbo["pinned"][0]["bytes"])
        assert dl.pinned_bytes_on_disk(hf, edit) == 0
        assert dl.bytes_on_disk(hf, edit["repo"]) == turbo["pinned"][0]["bytes"]  # the old count
        # The shared VAE is complete and the editor's transformer half done.
        vae = next(p for p in edit["pinned"] if p["path"].startswith("vae/"))
        with open(blobs / vae["sha256"], "wb") as f:
            f.truncate(vae["bytes"])
        with open(blobs / (edit["pinned"][0]["sha256"] + ".incomplete"), "wb") as f:
            f.truncate(1_000_000)
        assert dl.pinned_bytes_on_disk(hf, edit) == vae["bytes"] + 1_000_000


class _Proc:
    def __init__(self, code: int) -> None:
        self.returncode = code

    def poll(self) -> int:
        return self.returncode

    def terminate(self) -> None:
        pass


def _manager(r: reg.Registry) -> tuple[dl.DownloadManager, list[dict]]:
    events: list[dict] = []
    bus = MagicMock()
    bus.publish.side_effect = events.append
    return dl.DownloadManager(r, bus), events


def _err_file(text: str = "") -> Path:
    fd, name = tempfile.mkstemp()
    os.write(fd, text.encode())
    os.close(fd)
    return Path(name)


def test_a_repo_already_whole_is_not_fetched_and_the_layout_is_built() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        model = _model("mageflow")
        # CubePart already fetched the text encoder.
        _fake_repo(r, _spec("mageflow", "Qwen/Qwen3-VL-4B-Instruct"))
        fetched: list[str] = []

        def spawn(repo: dict):
            fetched.append(repo["repo"])
            _fake_repo(r, repo)
            return _Proc(0), _err_file()

        m, events = _manager(r)
        with patch.object(m, "_spawn_fetch", side_effect=spawn), patch.object(dl.envs, "provision"):
            m._run(dl.DownloadTask("mageflow"), model)
        assert fetched == ["Comfy-Org/Mage-Flow"], fetched
        assert events[-2]["done"] is True and "error" not in events[-2], events[-2]
        assert r.stamp_path("mageflow").exists()
        assert (r.assembled_dir("mageflow") / "model_index.json").exists()


def test_old_weights_on_disk_skip_the_download_entirely() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        _fake_repo(r, _spec("mageflow-edit", "microsoft/Mage-Flow-Edit-Turbo"))
        m, events = _manager(r)
        spawn = MagicMock()
        with patch.object(m, "_spawn_fetch", spawn), patch.object(dl.envs, "provision"):
            m._run(dl.DownloadTask("mageflow-edit"), _model("mageflow-edit"))
        spawn.assert_not_called()
        assert r.stamp_path("mageflow-edit").exists()
        assert not r.assembled_dir("mageflow-edit").exists()


def test_a_failed_fetch_says_what_the_hub_said() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        # The real tail of `snapshot_download("microsoft/Mage-Flow-Turbo")`
        # under huggingface_hub 0.34.4, 2026-09-23 (paths shortened).
        tail = (
            "Traceback (most recent call last):\n"
            '  File ".../huggingface_hub/utils/_http.py", line 459, in hf_raise_for_status\n'
            "    raise _format(RepositoryNotFoundError, message, response) from e\n"
            "huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error. "
            "(Request ID: Root=1-6ab48533-2641e958517378f3462e5357;89f2594c)\n"
            "\n"
            "Repository Not Found for url: "
            "https://huggingface.co/api/models/microsoft/Mage-Flow-Turbo/revision/main.\n"
            "Please make sure you specified the correct `repo_id` and `repo_type`.\n"
            "If you are trying to access a private or gated repo, make sure you are "
            "authenticated. For more details, see https://huggingface.co/docs/huggingface_hub/authentication\n"
            "Invalid username or password.\n"
        )
        m, events = _manager(r)
        with (
            patch.object(m, "_spawn_fetch", return_value=(_Proc(1), _err_file(tail))),
            patch.object(dl.envs, "provision"),
        ):
            m._run(dl.DownloadTask("mageflow"), _model("mageflow"))
        err = events[-1].get("error", "")
        assert "RepositoryNotFoundError: 401" in err, err
        assert err.endswith("Invalid username or password."), err
        assert "Request ID" not in err, err
        assert not r.stamp_path("mageflow").exists()


def test_a_download_with_other_bytes_is_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        r = _registry(Path(tmp))
        _fake_repo(r, _spec("mageflow", "Qwen/Qwen3-VL-4B-Instruct"))

        def spawn(repo: dict):
            _fake_repo(r, repo, wrong=(repo["pinned"][0]["path"],))
            return _Proc(0), _err_file()

        m, events = _manager(r)
        with patch.object(m, "_spawn_fetch", side_effect=spawn), patch.object(dl.envs, "provision"):
            m._run(dl.DownloadTask("mageflow"), _model("mageflow"))
        err = events[-1].get("error", "")
        assert "refusing" in err and "mage_flow_turbo_bf16" in err, err
        assert not r.stamp_path("mageflow").exists()


# ---- jobs ----------------------------------------------------------------------


def _jobs(tmp: Path, *, mflux: bool, weights: Path | None = Path("/w/assembled/x")) -> JobManager:
    m = JobManager.__new__(JobManager)
    m.registry = MagicMock()
    cli = tmp / "mflux-generate-mage-flow"
    if mflux:
        cli.write_text("")
    m.registry.mflux_cli.return_value = cli
    m.registry.mflux_edit_cli.return_value = tmp / "mflux-generate-mage-flow-edit"
    m.registry.venv_python.return_value = Path("/venv/python")
    m.registry.tool_dir.return_value = tmp
    m.registry.model_dir.return_value = weights
    return m


def test_mflux_gets_the_checkpoint_directory_and_its_base_model() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = _jobs(Path(tmp), mflux=True)
        _py, script, args, _cwd = m._image_worker("a red car", Path(tmp) / "o.png")
        assert script.name == "mlx_image_worker.py"
        m.registry.model_dir.assert_called_with("mageflow")
        i = args.index("--model")
        assert args[i + 1] == "/w/assembled/x", args
        assert args[args.index("--base-model") + 1] == MFLUX_BASE_MODELS["mageflow"] == "mage-flow-turbo"

        _py, _s, args, _c = m._image_worker("make it blue", Path(tmp) / "e.png", "/in.png")
        m.registry.model_dir.assert_called_with("mageflow-edit")
        assert args[args.index("--edit-model") + 1] == "/w/assembled/x", args
        assert args[args.index("--edit-base-model") + 1] == "mage-flow-edit-turbo", args
        assert not any("microsoft/" in a for a in args), args


def test_the_pytorch_fallback_loads_the_directory_too() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = _jobs(Path(tmp), mflux=False)
        _py, script, args, _cwd = m._image_worker("a red car", Path(tmp) / "o.png")
        assert script.name == "mageflow_worker.py"
        assert args[args.index("--model") + 1] == "/w/assembled/x", args
        assert not any("microsoft/" in a for a in args), args


def test_missing_weights_say_so_instead_of_reaching_for_the_hub() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = _jobs(Path(tmp), mflux=True, weights=None)
        try:
            m._image_worker("a red car", Path(tmp) / "o.png")
        except RuntimeError as err:
            assert "download it again" in str(err)
        else:
            raise AssertionError("no weights must be an error")


def test_an_edit_needs_the_edit_model_not_the_generator() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = JobManager.__new__(JobManager)
        m.registry = MagicMock()
        m.sandbox_dir = Path(tmp)
        m._jobs = {}
        m._lock = MagicMock()
        m._run_generate = MagicMock()
        body = {"kind": "text", "prompt": "make it blue", "imageOnly": True, "editFrom": "/in.png"}

        m.registry.is_installed.side_effect = lambda i: i == "mageflow-edit"
        assert m.start_generate(body)["ok"] is True  # editor alone is enough

        m.registry.is_installed.side_effect = lambda i: i == "mageflow"
        res = m.start_generate(body)
        assert res == {"ok": False, "error": "Mage-Flow Edit is not installed yet"}, res

        gen = {"kind": "text", "prompt": "a red car", "imageOnly": True}
        m.registry.is_installed.side_effect = lambda i: i == "mageflow-edit"
        assert m.start_generate(gen) == {"ok": False, "error": "Mage-Flow is not installed yet"}


# ---- the MLX worker ------------------------------------------------------------


def test_the_worker_names_the_base_model_to_mflux_and_the_user() -> None:
    import mlx_image_worker as worker

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "o.png"
        calls: list[list[str]] = []

        def run(cmd, **kw):
            calls.append(cmd)
            out.write_bytes(b"png")
            return MagicMock(returncode=0, stderr="")

        argv = [
            "mlx_image_worker.py", "--prompt", "a red car", "--out", str(out),
            "--cli", "/bin/mflux-generate-mage-flow", "--model", "/w/assembled/mageflow",
            "--base-model", "mage-flow-turbo", "--preview-max-px", "0",
        ]
        buf = io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            patch.object(worker.subprocess, "run", side_effect=run),
            patch.object(worker, "is_blank", return_value=False),
            contextlib.redirect_stdout(buf),
        ):
            worker.main()
        cmd = calls[0]
        assert cmd[cmd.index("--model") + 1] == "/w/assembled/mageflow", cmd
        assert cmd[cmd.index("--base-model") + 1] == "mage-flow-turbo", cmd
        shown = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.startswith("{")]
        msg = next(e["message"] for e in shown if e.get("event") == "progress")
        assert "mage-flow-turbo" in msg and "/w/assembled" not in msg, msg


def test_the_worker_edits_with_the_edit_directory_and_its_base_model() -> None:
    import mlx_image_worker as worker

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "e.png"
        calls: list[list[str]] = []

        def run(cmd, **kw):
            calls.append(cmd)
            out.write_bytes(b"png")
            return MagicMock(returncode=0, stderr="")

        argv = [
            "mlx_image_worker.py", "--prompt", "make it blue", "--out", str(out),
            "--cli", "/bin/mflux-generate-mage-flow",
            "--edit-from", "/in/source.png", "--edit-cli", "/bin/mflux-generate-mage-flow-edit",
            "--edit-model", "/w/assembled/mageflow-edit", "--edit-base-model", "mage-flow-edit-turbo",
            "--preview-max-px", "0",
        ]
        buf = io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            patch.object(worker.subprocess, "run", side_effect=run),
            contextlib.redirect_stdout(buf),
        ):
            worker.main()
        cmd = calls[0]
        assert cmd[0] == "/bin/mflux-generate-mage-flow-edit", cmd
        assert cmd[cmd.index("--model") + 1] == "/w/assembled/mageflow-edit", cmd
        assert cmd[cmd.index("--base-model") + 1] == "mage-flow-edit-turbo", cmd
        assert cmd[cmd.index("--image-paths") + 1] == "/in/source.png", cmd
        events = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.startswith("{")]
        assert any(e.get("event") == "artifact" and e.get("label") == "Edited image" for e in events)
