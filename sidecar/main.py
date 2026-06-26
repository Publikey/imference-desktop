"""Python sidecar for imference-desktop-go.

Long-running process spawned by the Go side. Communicates over stdin/stdout
using runqy-python's JSON-lines protocol — same protocol the GPU workers
(sdxl-multimodel-v2) use under Runqy in production. One subprocess = one
loaded engine.

Wire shape (set by runqy_python):
  Go → Python (stdin)  : {"task_id": "...", "payload": {...}}
  Python → Go (stdout) : {"task_id": "...", "result": {...}, "error": null, "retry": false}
                         or {"status": "ready"} once the engine has loaded.
  Python → Go (stderr) : free-form logs (everything written via `logging`).

Logs from the engine and from this script land in stderr → the Go parent
streams them into the in-app LogPanel automatically. No need for a separate
log-tail endpoint.

Boot config via env vars:
    IMFERENCE_LOCAL_SDXL_PATH   absolute path to a .safetensors checkpoint (required)
"""
from __future__ import annotations

import base64
import io
import logging
import os
import sys

from runqy_python import load, run, task

# Force all logging output to stderr so the JSON protocol on stdout stays
# pristine. runqy_python._protect_stdout() also redirects sys.stdout to
# stderr internally — this is belt-and-suspenders.
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("imference.sidecar")

SDXL_MODEL_NAME = "sdxl"


def _env_bool(name: str) -> bool:
    """Parse a truthy env var: 1 / true / yes (case-insensitive) → True."""
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


@load
def setup() -> dict:
    """Loaded once before the first task. Initializes the engine and
    registers the user's SDXL checkpoint. The returned dict becomes the
    `context` argument passed to every @task call."""
    weights = os.environ.get("IMFERENCE_LOCAL_SDXL_PATH")
    if not weights:
        # Raising from @load makes runqy_python emit {"status":"error",...}
        # on stdout and exit 1 — the Go side surfaces that as a clean
        # startup error in the UI.
        raise RuntimeError("IMFERENCE_LOCAL_SDXL_PATH not set")
    if not os.path.isfile(weights):
        raise RuntimeError(f"SDXL weights not found at {weights}")

    # Lazy import — keeps the import chain off the critical path of stdout
    # protection (and helps if the user has a half-broken engine venv).
    from imference_engine import Engine, RuntimeConfig

    # Perf knobs exposed via env vars until the desktop Settings dialog grows
    # toggles for them. Both default off → behavior identical to the previous
    # sidecar. To enable, set the env var in the shell that launches the app:
    #   $env:IMFERENCE_USE_TINY_VAE = "1"        # ~10× faster VAE decode
    #   $env:IMFERENCE_ENABLE_CPU_OFFLOAD = "1"  # peak VRAM ↓ ~40% on SDXL
    use_tiny_vae = _env_bool("IMFERENCE_USE_TINY_VAE")
    enable_cpu_offload = _env_bool("IMFERENCE_ENABLE_CPU_OFFLOAD")
    logger.info(
        f"Engine perf flags: use_tiny_vae={use_tiny_vae}, "
        f"enable_cpu_offload={enable_cpu_offload}"
    )

    logger.info(f"Loading engine with SDXL weights: {weights}")
    eng = Engine(runtime=RuntimeConfig(
        device="auto",
        use_tiny_vae=use_tiny_vae,
        enable_cpu_offload=enable_cpu_offload,
    )).load()
    eng.register_model(SDXL_MODEL_NAME, backend="sdxl", weights_path=weights)
    logger.info(
        f"Sidecar ready on {eng._device.torch_str if eng._device else 'unknown'} device"
    )
    # Stash the resolved device in the context so generate() can echo it
    # for debugging without reaching into Engine private state.
    return {
        "engine": eng,
        "device": eng._device.torch_str if eng._device else "unknown",
    }


@task
def generate(payload: dict, ctx: dict) -> dict:
    """Handle one generation request. Payload mirrors the desktop's
    GenerationRequest (camelCase preserved between Go and the renderer).

    Returns a dict with seeds/images/errors arrays aligned by index.
    """
    engine = ctx["engine"]

    prompt = payload.get("prompt")
    if not prompt:
        # @task exceptions are surfaced as {error: traceback} on stdout —
        # so the Go side sees a clear failure rather than a silent empty image.
        raise ValueError("payload.prompt is required")

    result = engine.generate(
        model=SDXL_MODEL_NAME,
        prompt=prompt,
        negative_prompt=payload.get("negative_prompt") or payload.get("negativePrompt"),
        width=payload.get("width") or 1024,
        height=payload.get("height") or 1024,
        num_steps=payload.get("num_steps") or payload.get("numSteps") or 28,
        guidance_scale=payload.get("guidance_scale")
        or payload.get("guidanceScale")
        or 6.0,
        # Per-model config (clip-skip + scheduler) injected by the Go side from
        # the selected model's catalog entry. None → engine uses its defaults.
        clip_skip=payload.get("clip_skip") or payload.get("clipSkip"),
        scheduler=payload.get("scheduler") or payload.get("schedulerDefault"),
        seed=payload.get("seed"),
        batch=1,
    )

    errors_by_index = {e.batch_index: e.error for e in result.errors}
    images_b64: list[str] = []
    error_strs: list[str] = []
    for i, img in enumerate(result.images):
        if img is None:
            images_b64.append("")
            error_strs.append(errors_by_index.get(i, "unknown error"))
        else:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            images_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
            error_strs.append("")

    return {
        "seeds": result.seeds,
        "images": images_b64,
        "errors": error_strs,
        "device": ctx.get("device"),
    }


if __name__ == "__main__":
    run()
