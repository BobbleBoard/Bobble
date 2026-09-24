"""Download manager: weights via huggingface_hub in a CANCELLABLE subprocess,
progress from polling the hub cache's per-repo blob dirs (resume-safe: bytes
already on disk count immediately), then environment provisioning (envs.py).

Progress convention on the /events stream (contract Gen3dDownloadUpdate):
  {type:"download", id, receivedBytes, totalBytes, done, error?}
Weights fill 0..97% of totalBytes; the env-provision phase holds at 97% until
everything is verified (the contract carries no message field for downloads,
so the last 3% simply reads as "finishing up").
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import envs
from .bus import EventBus
from .registry import Registry

ENV_PHASE_FRACTION = 0.97


def repo_cache_dir(hf_home: Path, repo: str) -> Path:
    return hf_home / "hub" / ("models--" + repo.replace("/", "--"))


def pinned_bytes_on_disk(hf_home: Path, spec: dict) -> int:
    """Bytes of exactly the pinned blobs present, partial downloads included.

    A repo two models share (Comfy-Org/Mage-Flow: the generator's and the
    editor's transformers) holds the other model's 8 GB too; counting the whole
    blobs dir would put this download at "done" before it began. The hub names
    an LFS blob after its sha256 and a partial one `<sha256>.incomplete`, so the
    pins say exactly which files are this download's.
    """
    blobs = repo_cache_dir(hf_home, spec["repo"]) / "blobs"
    total = 0
    for pin in spec.get("pinned") or []:
        for name in (pin["sha256"], pin["sha256"] + ".incomplete"):
            try:
                total += min((blobs / name).stat().st_size, int(pin["bytes"]))
                break
            except OSError:
                continue
    return total


def bytes_on_disk(hf_home: Path, repo: str) -> int:
    """Blob bytes present for a repo (includes *.incomplete resume files)."""
    blobs = repo_cache_dir(hf_home, repo) / "blobs"
    total = 0
    if blobs.is_dir():
        for f in blobs.iterdir():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    # xet-backed downloads stage under xet/ before materializing; blobs/ is
    # the stable signal and undercounts at worst (progress never regresses to
    # the UI because the manager keeps a monotonic max).
    return total


class DownloadTask:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.cancelled = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.done = False


class DownloadManager:
    def __init__(self, registry: Registry, bus: EventBus) -> None:
        self.registry = registry
        self.bus = bus
        self._tasks: dict[str, DownloadTask] = {}
        self._lock = threading.Lock()

    def is_downloading(self, model_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(model_id)
            return task is not None and not task.done

    def cancel(self, model_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(model_id)
        if task is None or task.done:
            return False
        task.cancelled.set()
        proc = task.proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
        return True

    def start(self, model_id: str) -> str | None:
        """Returns an error string, or None when the download thread started."""
        model = self.registry.model(model_id)
        if model is None:
            return f"unknown model: {model_id}"
        if self.is_downloading(model_id):
            return None  # already in flight — idempotent
        if self.registry.is_installed(model_id):
            return None
        task = DownloadTask(model_id)
        with self._lock:
            self._tasks[model_id] = task
        threading.Thread(target=self._run, args=(task, model), daemon=True).start()
        return None

    # ---- internals -----------------------------------------------------------
    def _emit(self, model_id: str, received: int, total: int, done: bool, error: str | None = None) -> None:
        event = {
            "type": "download",
            "id": model_id,
            "receivedBytes": int(received),
            "totalBytes": int(total),
            "done": done,
        }
        if error is not None:
            event["error"] = error
        self.bus.publish(event)

    def _run(self, task: DownloadTask, model: dict) -> None:
        model_id = task.model_id
        total = int(model["totalBytes"]) or 1
        weights_cap = int(total * ENV_PHASE_FRACTION)
        try:
            received_base = 0
            monotonic_max = 0
            # A complete copy from where the model USED to come from is its
            # weights (Mage-Flow's withdrawn microsoft/* repos): set up the
            # runtime, never fetch 17 GB again from the new source.
            repos = [] if self.registry.legacy_snapshot(model_id) is not None else model["repos"]
            for repo in repos:
                if task.cancelled.is_set():
                    raise InterruptedError("cancelled")
                repo_total = int(repo["bytes"])
                pinned = bool(repo.get("pinned"))
                # Already whole — shared with another model (the Qwen3-VL text
                # encoder CubePart uses) or fetched before: nothing to ask the
                # hub, which also keeps an offline re-install working.
                if pinned and self.registry.repo_snapshot(repo) is not None:
                    received_base += repo_total
                    monotonic_max = max(monotonic_max, min(received_base, weights_cap))
                    self._emit(model_id, monotonic_max, total, False)
                    continue
                proc, err_path = self._spawn_fetch(repo)
                task.proc = proc
                try:
                    while proc.poll() is None:
                        if task.cancelled.is_set():
                            proc.terminate()
                            raise InterruptedError("cancelled")
                        if pinned:
                            on_disk = pinned_bytes_on_disk(self.registry.hf_home, repo)
                        else:
                            on_disk = bytes_on_disk(self.registry.hf_home, repo["repo"])
                        on_disk = min(on_disk, repo_total)
                        monotonic_max = max(monotonic_max, min(received_base + on_disk, weights_cap))
                        self._emit(model_id, monotonic_max, total, False)
                        time.sleep(1.0)
                    if proc.returncode != 0:
                        reason = _last_line(err_path)
                        raise RuntimeError(
                            f"download failed for {repo['repo']} (exit {proc.returncode})"
                            + (f": {reason}" if reason else "")
                        )
                finally:
                    err_path.unlink(missing_ok=True)
                if pinned and self.registry.repo_snapshot(repo) is None:
                    raise RuntimeError(
                        self.registry.pin_mismatch(repo)
                        or f"{repo['repo']} downloaded but is not complete"
                    )
                received_base += repo_total
                monotonic_max = max(monotonic_max, min(received_base, weights_cap))
                self._emit(model_id, monotonic_max, total, False)

            # Weights complete — provision the runtime env (venv/clone/binary).
            self._emit(model_id, weights_cap, total, False)

            def log(msg: str) -> None:
                print(f"[gen3d provision {model_id}] {msg}", flush=True)

            envs.provision(self.registry, model, log, task.cancelled)
            if task.cancelled.is_set():
                raise InterruptedError("cancelled")
            # A model whose checkpoint is assembled from several repos gets its
            # directory now, so the first generation does not pay for it and a
            # broken layout fails here, on the download card, not in a job.
            if model.get("layout") and self.registry.model_dir(model_id) is None:
                raise RuntimeError(f"could not assemble the {model_id} checkpoint directory")
            self.registry.write_stamp(model_id)
            self._emit(model_id, total, total, True)
            self.bus.publish({"type": "catalog-changed", "at": int(time.time() * 1000)})
        except InterruptedError:
            self._emit(model_id, 0, total, True, "cancelled")
        except Exception as err:  # noqa: BLE001 — report, never crash the sidecar
            self._emit(model_id, 0, total, True, str(err))
        finally:
            task.done = True

    def _spawn_fetch(self, repo: dict) -> tuple[subprocess.Popen, Path]:
        """snapshot_download in a child process so cancel is a clean kill.

        Its stderr goes to a file whose last line becomes the error: "exit 1"
        alone hid that the Mage-Flow repos were answering 401.
        """
        payload = {
            "repo": repo["repo"],
            "allow": list(repo.get("allowPatterns") or []) or None,
        }
        script = (
            "import json,sys,os\n"
            "from huggingface_hub import snapshot_download\n"
            "spec=json.loads(sys.argv[1])\n"
            "snapshot_download(spec['repo'], allow_patterns=spec['allow'])\n"
        )
        env = dict(os.environ)
        env["HF_HOME"] = str(self.registry.hf_home)
        # Progress is read from the blobs on disk, not the bars; without them
        # the log holds only what went wrong (and stays small over 17 GB).
        env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
        fd, err_name = tempfile.mkstemp(prefix="gen3d-fetch-", suffix=".log")
        with os.fdopen(fd, "wb") as err:
            proc = subprocess.Popen(
                [sys.executable, "-c", script, __import__("json").dumps(payload)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=err,
            )
        return proc, Path(err_name)


_EXC_HEADER = re.compile(r"^[\w.]+(?:Error|Exception)\b(?::|$)")


def _last_line(path: Path, limit: int = 300) -> str:
    """What a failed child said: its exception line, plus the last line when the
    message runs on (the hub's 401 ends "…Invalid username or password.")."""
    try:
        lines = [ln.strip() for ln in path.read_text(errors="replace").splitlines() if ln.strip()]
    except OSError:
        return ""
    if not lines:
        return ""
    header = next((ln for ln in reversed(lines) if _EXC_HEADER.match(ln)), None)
    if header is None or header == lines[-1]:
        return lines[-1][:limit]
    header = re.sub(r"\s*\(Request ID: [^)]*\)", "", header)
    return f"{header[: limit // 2]} … {lines[-1]}"[:limit]
