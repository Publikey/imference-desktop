"""Tests for the generation sidecar's tool path (sidecar/main.py `_run_tool`):
generation tools (vary / inpaint / outpaint / instruct-edit) run on the loaded
engine. The engine is a stub that records what the tool asked of it, so no
model is needed. Needs imference-engine with the [tools] extra.

    python -m pytest sidecar/tests
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

pytest.importorskip("imference_engine.tools")
PIL = pytest.importorskip("PIL.Image")

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "main.py"


@pytest.fixture(scope="module")
def mod():
    stub = types.ModuleType("runqy_python")
    stub.load = lambda f: f
    stub.task = lambda f: f
    stub.run = lambda: None
    saved = sys.modules.get("runqy_python")
    sys.modules["runqy_python"] = stub
    try:
        spec = importlib.util.spec_from_file_location("main_under_test", SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        yield m
    finally:
        if saved is not None:
            sys.modules["runqy_python"] = saved
        else:
            sys.modules.pop("runqy_python", None)


class _Result:
    def __init__(self, images):
        self.images = images
        self.errors = []
        self.seeds = [0]


class StubEngine:
    """The single-model sidecar engine: one model registered as "local"."""

    def __init__(self, backend: str):
        self.backend = backend
        self.calls: list[dict] = []

    def registered_models(self):
        return ["local"]

    def model_backend(self, name):
        return self.backend if name == "local" else None

    def generate(self, **kw):
        self.calls.append(kw)
        return _Result([PIL.new("RGB", (96, 64), (10, 200, 10))])


def _image(path: Path, size=(64, 48)) -> Path:
    PIL.new("RGB", size, (200, 10, 10)).save(path)
    return path


def test_instruct_edit_with_references(mod, tmp_path):
    src = _image(tmp_path / "in.png")
    r1 = _image(tmp_path / "r1.png", (32, 32))
    r2 = _image(tmp_path / "r2.png", (40, 40))
    eng = StubEngine("qwenimage-edit")
    res = mod.generate({
        "tool_id": "instruct-edit", "job_id": "job-e",
        "inputs": {"image": str(src), "references": [str(r1), str(r2)]},
        # The Go side may forward the cloud model pick: the sidecar forces "local".
        "params": {"instruction": "put the cat from image 2 on the sofa", "model": "qwen-image-edit-2511",
                   "seed": 5, "steps": 8},
        "output_dir": str(tmp_path / "out"),
    }, {"engine": eng})
    assert "tool" in res, res
    out = res["tool"]["outputs"][0]
    assert Path(out["path"]).is_file()
    # keep_size (default true) resizes back to the input size.
    assert (out["width"], out["height"]) == (64, 48)
    call = eng.calls[0]
    assert call["model"] == "local"
    assert call["prompt"] == "put the cat from image 2 on the sofa"
    assert call["num_steps"] == 8 and call["seed"] == 5
    # The image plus both references are the condition images, in order.
    imgs = call["source_image"]
    assert isinstance(imgs, list) and [i.size for i in imgs] == [(64, 48), (32, 32), (40, 40)]


def test_instruct_edit_refuses_a_text_to_image_model(mod, tmp_path):
    src = _image(tmp_path / "in.png")
    res = mod.generate({
        "tool_id": "instruct-edit", "job_id": "job-x",
        "inputs": {"image": str(src)}, "params": {"instruction": "make it night"},
        "output_dir": str(tmp_path / "out"),
    }, {"engine": StubEngine("sdxl")})
    assert res["tool_error"]["code"] == "unsupported_runtime", res


def test_vary_refuses_an_edit_model(mod, tmp_path):
    src = _image(tmp_path / "in.png")
    res = mod.generate({
        "tool_id": "vary", "job_id": "job-v",
        "inputs": {"image": str(src)}, "params": {"prompt": "a fox"},
        "output_dir": str(tmp_path / "out"),
    }, {"engine": StubEngine("qwenimage-edit")})
    assert res["tool_error"]["code"] == "unsupported_runtime", res


def test_plain_generation_refused_on_an_edit_model(mod):
    with pytest.raises(ValueError, match="edits images"):
        mod.generate({"prompt": "a fox"}, {"engine": StubEngine("qwenimage-edit"), "backend": "qwenimage-edit"})
