"""Tests for sidecar/tools_main.py — the editing-tools sidecar handler.

runqy_python is stubbed (the decorators just return the function), so the
handler is called directly like the runqy loop would. Needs imference-engine
with the [tools] extra:  pip install -e "<imference-engine>[tools,dev]"

    python -m pytest sidecar/tests
"""
from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

pytest.importorskip("imference_engine.tools")
PIL = pytest.importorskip("PIL.Image")

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "tools_main.py"


@pytest.fixture(scope="module")
def mod():
    stub = types.ModuleType("runqy_python")
    stub.load = lambda f: f
    stub.task = lambda f: f
    stub.run = lambda: None
    saved = sys.modules.get("runqy_python")
    sys.modules["runqy_python"] = stub
    try:
        spec = importlib.util.spec_from_file_location("tools_main_under_test", SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        yield m
    finally:
        if saved is not None:
            sys.modules["runqy_python"] = saved
        else:
            sys.modules.pop("runqy_python", None)


@pytest.fixture()
def ctx(mod):
    return mod.setup()


def _image(path: Path, size=(64, 48)) -> Path:
    PIL.new("RGB", size, (200, 10, 10)).save(path)
    return path


def test_run_resize_writes_a_file(mod, ctx, tmp_path, capsys):
    src = _image(tmp_path / "in.png")
    out_dir = tmp_path / "out"
    res = mod.handle({"op": "run", "job_id": "job-1", "tool_id": "resize",
                      "inputs": {"image": str(src)}, "params": {"width": 32},
                      "output_dir": str(out_dir)}, ctx)
    assert res["ok"] is True, res
    r = res["result"]
    assert r["tool_id"] == "resize"
    out = r["outputs"][0]
    assert out["type"] == "image" and Path(out["path"]).is_file()
    assert Path(out["path"]).parent == out_dir
    assert (out["width"], out["height"]) == (32, 24)
    # Nothing image-sized in the result: it must stay JSON-small.
    assert len(json.dumps(res)) < 4096

    # Progress lines carry the Go job id and named stages.
    lines = [ln for ln in capsys.readouterr().err.splitlines() if ln.startswith(mod.PROGRESS_PREFIX)]
    assert lines, "no IMTOOL_PROGRESS line on stderr"
    evs = [json.loads(ln[len(mod.PROGRESS_PREFIX):]) for ln in lines]
    assert all(e["task_id"] == "job-1" for e in evs)
    assert {e["stage"] for e in evs} <= {"downloading_weights", "loading", "running", "encoding"}


def test_tool_error_is_typed(mod, ctx, tmp_path):
    res = mod.handle({"op": "run", "tool_id": "resize", "inputs": {}, "params": {},
                      "output_dir": str(tmp_path)}, ctx)
    assert res["ok"] is False
    assert res["error"]["code"] == "invalid_input"

    res = mod.handle({"op": "run", "tool_id": "no-such-tool", "inputs": {}, "output_dir": str(tmp_path)}, ctx)
    assert res["ok"] is False and res["error"]["code"] == "invalid_input"

    res = mod.handle({"op": "run", "tool_id": "resize", "inputs": {"image": str(_image(tmp_path / "a.png"))},
                      "params": {"width": 999999}, "output_dir": str(tmp_path)}, ctx)
    assert res["ok"] is False and res["error"]["code"] == "invalid_input"


def test_release_catalog_probe(mod, ctx):
    assert mod.handle({"op": "release"}, ctx)["ok"] is True
    cat = mod.handle({"op": "catalog"}, ctx)
    assert cat["ok"] and any(t["id"] == "upscale" for t in cat["catalog"]["tools"])
    pr = mod.handle({"op": "probe"}, ctx)
    assert pr["ok"] is True
    assert "CPUExecutionProvider" in pr["providers"]
    assert isinstance(pr["ffmpeg"], bool)
    assert pr["ram_gb"] >= 0


def test_unknown_op(mod, ctx):
    res = mod.handle({"op": "dance"}, ctx)
    assert res == {"ok": False, "error": {"code": "invalid_input", "message": "unknown op 'dance'"}}


def test_generation_tool_without_engine_is_unsupported(mod, ctx, tmp_path):
    src = _image(tmp_path / "in.png")
    res = mod.handle({"op": "run", "tool_id": "vary", "inputs": {"image": str(src)},
                      "params": {"model": "local"}, "output_dir": str(tmp_path)}, ctx)
    assert res["ok"] is False and res["error"]["code"] == "unsupported_runtime"
