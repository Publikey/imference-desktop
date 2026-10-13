"""Fake tools sidecar for internal/tools tests: speaks the runqy stdio
protocol of sidecar/tools_main.py without imference-engine or runqy-python.

Tools:  any    -> writes <output_dir>/<tool>-out.png (the inputs as JSON), two progress lines
        "slow"  -> sleeps 30 s (cancel test)
        "oom" (or params.fail == "oom") -> {"ok": false, "error": {"code": "oom", ...}}
        "nope"  -> invalid_input
        "crash" -> exits the process
Env:    FAKE_FAIL_LOAD=1 -> {"status": "error"} at startup
        FAKE_LOG=<path>  -> append every op name (release accounting)
"""
import json
import os
import sys
import time


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(op):
    p = os.environ.get("FAKE_LOG")
    if p:
        with open(p, "a") as f:
            f.write(op + "\n")


if os.environ.get("FAKE_FAIL_LOAD") == "1":
    out({"status": "error", "error": "@load failed: no engine"})
    sys.exit(1)
sys.stderr.write("fake tools sidecar starting\n")
out({"status": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    tid, p = req["task_id"], req.get("payload") or {}
    op = p.get("op", "run")
    log(op)
    if op == "probe":
        res = {"ok": True, "providers": ["CPUExecutionProvider"], "ffmpeg": True, "torch_device": "", "ram_gb": 16}
    elif op == "release":
        res = {"ok": True, "released": 1}
    elif op == "run":
        tool = p.get("tool_id")
        fail = (p.get("params") or {}).get("fail")
        if fail == "oom":
            tool = "oom"
        if tool not in ("slow", "oom", "crash", "nope"):
            sys.stderr.write("IMTOOL_PROGRESS " + json.dumps({"task_id": p.get("job_id"), "stage": "running", "fraction": 0.5}) + "\n")
            sys.stderr.flush()
            os.makedirs(p["output_dir"], exist_ok=True)
            path = os.path.join(p["output_dir"], tool + "-out.png")
            with open(path, "w") as f:
                f.write(json.dumps(p.get("inputs")))
            sys.stderr.write("IMTOOL_PROGRESS " + json.dumps({"task_id": p.get("job_id"), "stage": "encoding", "fraction": 1.0}) + "\n")
            sys.stderr.flush()
            res = {"ok": True, "result": {"tool_id": tool, "tool_version": "1.0.0", "params": p.get("params"),
                                          "outputs": [{"name": "image", "type": "image", "format": "png", "path": path,
                                                       "width": 8, "height": 4}],
                                          "duration_ms": 3, "runtime": "fake", "stages": ["running", "encoding"]}}
        elif tool == "slow":
            time.sleep(30)
            res = {"ok": True, "result": {}}
        elif tool == "oom":
            res = {"ok": False, "error": {"code": "oom", "message": "out of memory"}}
        elif tool == "crash":
            sys.exit(3)
        else:
            res = {"ok": False, "error": {"code": "invalid_input", "message": "unknown tool %r" % tool}}
    else:
        res = {"ok": False, "error": {"code": "invalid_input", "message": "unknown op"}}
    out({"task_id": tid, "result": res, "error": None, "retry": False})
