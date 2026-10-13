"""Editing-tools sidecar for imference-desktop-go.

A second, light Python child process (separate from the generation sidecar in
main.py) that runs ``imference_engine.tools`` locally: upscale, remove
background, eraser, click-to-select, restore faces, describe, image and video
utilities. It needs no generation model, starts on the first tool run and is
stopped by the Go parent after a few idle minutes (models released first).

Same runqy-python JSON-lines protocol as main.py (see docs/tools.md in
imference-engine, section "Desktop"):

  Go -> Python (stdin)  : {"task_id": "...", "payload": {"op": "run", ...}}
  Python -> Go (stdout) : {"task_id": "...", "result": {"ok": true, "result": {...}}}
                          {"task_id": "...", "result": {"ok": false, "error": {"code", "message"}}}
  Python -> Go (stderr) : logs + one progress line per stage update:
                          IMTOOL_PROGRESS {"task_id": "<job id>", "stage": "...", "fraction": 0.5}

Ops:
  run      {"op": "run", "job_id", "tool_id", "inputs": {name: path | [paths]},
            "params": {...}, "output_dir", "device"?}  -> {"ok", "result": ToolResult.to_dict()}
  release  {"op": "release"}                           -> {"ok", "released": n}
  catalog  {"op": "catalog"}                           -> {"ok", "catalog": export()}
  probe    {"op": "probe"}                             -> {"ok", "providers", "ffmpeg", "torch_device", "ram_gb", "engine_version"}

Outputs are always written to files under output_dir; nothing image-sized ever
travels over stdout (the Go reader caps a line at 4 MB).

Env (set by the Go parent):
  IMFERENCE_TOOLS_DEVICE   auto | cpu | cuda | mps | rocm | directml (default auto)
  TOOLS_MODEL_CDN          weights mirror (default: <IMAGE_MODEL_CDN>/tools)
  TOOLS_MODEL_CACHE        weights cache directory
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys

from runqy_python import load, run, task

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("imference.tools-sidecar")

PROGRESS_PREFIX = "IMTOOL_PROGRESS "


def _emit_progress(task_id: str, stage: str, fraction: float) -> None:
    """One machine-readable progress line on stderr (the Go parent parses it
    into a "tools:progress" event; everything else on stderr is a log)."""
    try:
        line = PROGRESS_PREFIX + json.dumps({"task_id": task_id, "stage": stage, "fraction": round(float(fraction), 4)})
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover - progress must never fail a tool
        pass


def _error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def _ffmpeg_available() -> bool:
    if shutil.which("ffmpeg"):
        return True
    try:  # imageio-ffmpeg (pulled by the [tools] extra) bundles a binary
        import imageio_ffmpeg

        return bool(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        return False


def _ram_gb() -> float:
    """Total physical RAM in GiB, 0 when unknown. No psutil dependency."""
    try:
        if sys.platform == "win32":
            import ctypes

            class _MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            ms = _MS()
            ms.dwLength = ctypes.sizeof(_MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return ms.ullTotalPhys / 2**30
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except Exception:
        return 0.0


def _torch_device() -> str:
    """The torch device a torch-based tool (describe) would use, without
    importing torch when it isn't installed. "" = no torch."""
    import importlib.util

    if importlib.util.find_spec("torch") is None:
        return ""
    try:
        import torch

        if torch.cuda.is_available():
            return "rocm" if getattr(torch.version, "hip", None) else "cuda"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        return ""
    return "cpu"


def probe() -> dict:
    out = {"ok": True, "providers": [], "ffmpeg": _ffmpeg_available(), "ram_gb": round(_ram_gb(), 1),
           "torch_device": "", "engine_version": ""}
    try:
        import onnxruntime as ort

        out["providers"] = list(ort.get_available_providers())
    except Exception as e:  # onnxruntime missing -> no local ONNX tools
        out["onnxruntime_error"] = str(e)[:300]
    try:
        import importlib.metadata as md

        out["engine_version"] = md.version("imference-engine")
    except Exception:
        pass
    out["torch_device"] = _torch_device()
    return out


@load
def setup() -> dict:
    """Import the tools package once (cheap: no model is loaded until a tool
    runs). A missing/old engine fails here so Go reports a clean error."""
    try:
        import imference_engine.tools  # noqa: F401
    except ImportError as e:
        raise RuntimeError(f"imference_engine.tools is not installed (engine >= 0.5.0 with the [tools] extra): {e}")
    device = (os.environ.get("IMFERENCE_TOOLS_DEVICE") or "auto").strip() or "auto"
    logger.info("Tools sidecar ready (device=%s, cdn=%s, cache=%s)", device,
                os.environ.get("TOOLS_MODEL_CDN", ""), os.environ.get("TOOLS_MODEL_CACHE", ""))
    # Must be a non-None value: runqy only passes ctx to the handler when the
    # loader returned something.
    return {"device": device}


def _run(payload: dict, ctx: dict) -> dict:
    from imference_engine.tools import ToolError, run_tool

    tool_id = payload.get("tool_id") or ""
    job_id = str(payload.get("job_id") or "")
    output_dir = payload.get("output_dir")
    if not tool_id:
        return _error("invalid_input", "payload.tool_id is required")
    if not output_dir:
        return _error("invalid_input", "payload.output_dir is required")
    os.makedirs(output_dir, exist_ok=True)
    device = payload.get("device") or ctx.get("device") or "auto"
    try:
        res = run_tool(
            tool_id,
            payload.get("inputs") or {},
            payload.get("params") or {},
            output_dir=output_dir,
            device=device,
            timeout=payload.get("timeout") or None,
            on_progress=lambda stage, frac: _emit_progress(job_id, stage, frac),
        )
    except ToolError as e:
        logger.warning("tool %s failed: %s: %s", tool_id, e.code, e)
        return {"ok": False, "error": e.to_dict()}
    return {"ok": True, "result": res.to_dict()}


@task
def handle(payload: dict, ctx: dict) -> dict:
    op = (payload or {}).get("op") or "run"
    try:
        if op == "run":
            return _run(payload, ctx)
        if op == "release":
            from imference_engine.tools import release

            return {"ok": True, "released": release()}
        if op == "catalog":
            from imference_engine.tools import catalog

            return {"ok": True, "catalog": catalog.export()}
        if op == "probe":
            return probe()
        return _error("invalid_input", f"unknown op {op!r}")
    except Exception as e:  # never let a bug surface as a bare traceback
        logger.exception("tools op %s crashed", op)
        try:
            from imference_engine.tools.errors import classify

            return {"ok": False, "error": classify(e).to_dict()}
        except Exception:
            return _error("internal", f"{type(e).__name__}: {e}"[:500])


if __name__ == "__main__":
    run()
