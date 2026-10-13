"""Fake generation sidecar (sidecar/main.py) for the App's generation-tool
tests: speaks the runqy stdio protocol without imference-engine.

A payload with tool_id writes <output_dir>/<tool>-out.png containing the
payload's inputs + params as JSON and answers {"tool": ToolResult}; a plain
generation payload is answered with an error (tests never send one).
Env: FAKE_GEN_LOG=<path> -> append each tool payload as one JSON line.
"""
import json
import os
import sys


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


sys.stderr.write("Sidecar ready on cuda:0 device\n")
sys.stderr.flush()
out({"status": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    payload = req.get("payload") or {}
    tid = req.get("task_id")
    if not payload.get("tool_id"):
        out({"task_id": tid, "result": None, "error": "fake: plain generation not supported", "retry": False})
        continue
    log = os.environ.get("FAKE_GEN_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps(payload) + "\n")
    params = dict(payload.get("params") or {})
    params["model"] = "local"
    os.makedirs(payload["output_dir"], exist_ok=True)
    path = os.path.join(payload["output_dir"], payload["tool_id"] + "-out.png")
    with open(path, "w") as f:
        json.dump({"inputs": payload.get("inputs"), "params": params}, f)
    out({"task_id": tid, "error": None, "retry": False, "result": {"tool": {
        "tool_id": payload["tool_id"], "tool_version": "1.0.0", "params": params, "duration_ms": 5,
        "runtime": "engine", "stages": [],
        "outputs": [{"name": "image", "type": "image", "format": "png", "path": path,
                     "width": 64, "height": 48, "data": {"seed": 1234}}],
    }}})
