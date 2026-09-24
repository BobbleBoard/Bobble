"""
Run the REAL `office.py make|edit` against the replay stub (no model).

    python office_replay.py <replies.json> <scratch-dir> make pptx --brief "…" --out deck.pptx

The scratch dir becomes PI_OFFICE_GEN_SCRATCH, so the spec office.py rendered
(last_<kind>_spec.json) and every request it sent (requests.jsonl, one JSON
line each) land there for the eval to read. office.py's own JSON reply is
printed on stdout, exactly as the harness's office tool would see it.
"""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parents[1] / "office-gen" / "office.py"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main() -> int:
    replies, scratch, *args = sys.argv[1:]
    Path(scratch).mkdir(parents=True, exist_ok=True)
    port = free_port()
    log = str(Path(scratch) / "requests.jsonl")
    srv = subprocess.Popen([sys.executable, str(HERE / "replay_server.py"), replies, str(port), log])
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        env = {**os.environ, "PI_OFFICE_GEN_SERVER": f"http://127.0.0.1:{port}",
               "PI_OFFICE_GEN_SCRATCH": scratch, "PI_OFFICE_GEN_OFFLINE": "1",
               "no_proxy": "*", "NO_PROXY": "*"}
        r = subprocess.run([sys.executable, str(OFFICE), *args], env=env, capture_output=True,
                           text=True, timeout=300)
        sys.stderr.write(r.stderr)
        sys.stdout.write(r.stdout)
        return r.returncode
    finally:
        srv.terminate()
        srv.wait(timeout=5)


if __name__ == "__main__":
    sys.exit(main())
