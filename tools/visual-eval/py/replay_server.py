"""
A REPLAY STUB for office.py — no model, no weights, no GPU.

office.py's make path asks an OpenAI-compatible server for JSON (a deck plan,
one fill per slide, a document spec, a chart spec). This answers those requests
from a file of canned replies, so the REAL entry point (`office.py make …`) runs
end to end, headless: slides_in, the retries, the renderers, the summary the
chat model is shown. Routing is by the system prompt office-gen itself sends.

Every request is appended to <log> as one JSON line ({system, user}), so a test
can check WHAT the pipeline asked the model (VQ-08: the planner prompt carries
the brief's parts), not only what it did with the answer.

    python3 replay_server.py replies.json <port> [log.jsonl]
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

REPLIES = json.load(open(sys.argv[1]))
PORT = int(sys.argv[2])
LOG = sys.argv[3] if len(sys.argv) > 3 else None


def route(system: str, user: str):
    if "presentation planner" in system:
        return REPLIES["plan"]
    if "content for ONE slide" in system:
        m = re.search(r"SLIDE (\d+) of (\d+)", user)
        i = int(m.group(1)) - 1 if m else 0
        return REPLIES["fills"][i]
    if "You design documents" in system or "You design spreadsheets" in system:
        return REPLIES["doc"]
    if "chart specification" in system:
        return REPLIES["chart"]
    if "emitting operations" in system:
        return REPLIES["edit"]
    raise KeyError("no canned reply for this request: " + system[:80])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n))
        msgs = body.get("messages", [])
        system = next((m["content"] for m in msgs if m["role"] == "system"), "")
        user = next((m["content"] for m in msgs if m["role"] == "user"), "")
        if LOG:
            with open(LOG, "a") as fh:
                fh.write(json.dumps({"system": system, "user": user}) + "\n")
        try:
            reply = route(system, user)
            content = reply if isinstance(reply, str) else json.dumps(reply)
            code, out = 200, {"choices": [{"message": {"role": "assistant", "content": content},
                                           "finish_reason": "stop"}]}
        except Exception as e:  # noqa: BLE001
            code, out = 500, {"error": str(e)}
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
