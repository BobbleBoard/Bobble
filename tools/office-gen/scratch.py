"""
Where the pipeline may WRITE while it works, and whether it may reach the web.

The scripts used to drop `raw_*.txt`, `spec_*.json`, `ops.json` and a photo
cache next to themselves. Fine for a bare testbed; wrong inside the app, where
this directory ships read-only in the signed bundle and is shared by every
conversation. Everything transient goes under `scratch_dir()` instead — the app
points it at its own cache; a bare run gets the system temp dir.

Offline is the DEFAULT. Bobble promises that nothing typed into it leaves the
Mac, and a hero slide fetching a stock photo over the network breaks that
promise for a texture the palette then paints over anyway. `PI_OFFICE_GEN_OFFLINE=0`
opts back in for the testbed.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def scratch_dir() -> Path:
    raw = os.environ.get("PI_OFFICE_GEN_SCRATCH")
    p = Path(raw) if raw else Path(tempfile.gettempdir()) / "office-gen"
    p.mkdir(parents=True, exist_ok=True)
    return p


def offline() -> bool:
    return os.environ.get("PI_OFFICE_GEN_OFFLINE", "1") != "0"


def post_json(url: str, payload: dict, timeout: float = 600) -> dict:
    """POST to the LOCAL model server, bypassing any system proxy.

    MEASURED: with a proxy configured in macOS network settings, urllib routes
    127.0.0.1 through it and the request comes back "connection refused" while
    the server is demonstrably up — the same trap the gen workers hit. An opener
    with an empty ProxyHandler ignores the system settings entirely.
    """
    import json
    import urllib.request

    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as r:
        return json.loads(r.read())
