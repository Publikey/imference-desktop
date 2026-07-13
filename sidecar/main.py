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

    Engine runtime knobs are read by RuntimeConfig.from_env() — IMAGE_DEVICE,
    IMAGE_MODEL_CDN, IMAGE_MODEL_CACHE, IMAGE_USE_TINY_VAE,
    IMAGE_ENABLE_CPU_OFFLOAD, MAX_GPU_MODELS, MAX_CPU_MODELS. The Go parent sets
    the CDN + offline cache so a cold load never touches HuggingFace.
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

# Handle under which the single local model is registered. Arbitrary — the
# engine behavior is driven by the backend= passed to register_model, not this
# name. Kept stable so generate() can reference it.
MODEL_NAME = "local"


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

    # All runtime knobs come from the engine's documented env contract via
    # RuntimeConfig.from_env(): IMAGE_DEVICE, IMAGE_MODEL_CDN, IMAGE_MODEL_CACHE,
    # IMAGE_USE_TINY_VAE, IMAGE_ENABLE_CPU_OFFLOAD, MAX_GPU_MODELS, MAX_CPU_MODELS.
    # The Go parent sets the CDN + offline cache (base-components never hit
    # HuggingFace) and, later, the user's machine-tuning toggles. Anything unset
    # falls back to the engine's host-adaptive defaults (device=auto, etc.).
    runtime = RuntimeConfig.from_env()
    logger.info(
        "Engine runtime: device=%s use_tiny_vae=%s enable_offload=%s "
        "model_cdn=%s model_cache_dir=%s",
        runtime.device, runtime.use_tiny_vae, runtime.enable_offload,
        runtime.model_cdn, runtime.model_cache_dir,
    )

    # Backend selection comes from the Go parent (from the selected catalog
    # entry). Defaults keep the historical SDXL single-file behavior. Z-Image
    # finetunes ship transformer-only and need a base_model repo for the shared
    # tokenizer/text-encoder/VAE (resolved offline via the CDN).
    backend = os.environ.get("IMFERENCE_LOCAL_BACKEND", "sdxl").strip() or "sdxl"
    base_model = os.environ.get("IMFERENCE_LOCAL_BASE_MODEL", "").strip() or None
    shift_raw = os.environ.get("IMFERENCE_BACKEND_SHIFT", "").strip()
    shift = float(shift_raw) if shift_raw else None

    logger.info(
        "Loading engine: backend=%s weights=%s base_model=%s shift=%s",
        backend, weights, base_model, shift,
    )
    eng = Engine(runtime=runtime).load()
    eng.register_model(MODEL_NAME, backend=backend, weights_path=weights, base_model=base_model)
    logger.info(
        f"Sidecar ready on {eng._device.torch_str if eng._device else 'unknown'} device"
    )
    # Stash resolved device + backend config so generate() can dispatch per
    # backend and echo the device without reaching into Engine private state.
    return {
        "engine": eng,
        "device": eng._device.torch_str if eng._device else "unknown",
        "backend": backend,
        "shift": shift,
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

    # img2img: when a base64 source image is present, decode it to a PIL image
    # and let the engine denoise from it. In img2img the engine derives the
    # output size from the source, so width/height are ignored. None → text2img.
    source_image = None
    src_b64 = payload.get("source_image") or payload.get("sourceImage")
    if src_b64:
        from PIL import Image

        source_image = Image.open(io.BytesIO(base64.b64decode(src_b64))).convert("RGB")
    strength = payload.get("strength")
    if not strength:  # None or 0 → engine default
        strength = 0.75

    gen_kwargs = dict(
        model=MODEL_NAME,
        prompt=prompt,
        negative_prompt=payload.get("negative_prompt") or payload.get("negativePrompt"),
        width=payload.get("width") or 1024,
        height=payload.get("height") or 1024,
        num_steps=payload.get("num_steps") or payload.get("numSteps") or 28,
        guidance_scale=payload.get("guidance_scale")
        or payload.get("guidanceScale")
        or 6.0,
        seed=payload.get("seed"),
        source_image=source_image,
        strength=strength,
        batch=1,
    )

    if ctx.get("backend") == "zimage":
        # Z-Image has no CLIP tokenizer (no clip_skip) and a fixed flow-matching
        # scheduler (scheduler ignored). Its sampler behavior is controlled by
        # backend_options["shift"] instead, supplied by the Go side from the
        # model's catalog entry.
        shift = ctx.get("shift")
        if shift:
            gen_kwargs["backend_options"] = {"shift": float(shift)}
    else:
        # SDXL: per-model clip-skip + scheduler injected by the Go side from the
        # catalog entry. None → engine uses its defaults.
        gen_kwargs["clip_skip"] = payload.get("clip_skip") or payload.get("clipSkip")
        gen_kwargs["scheduler"] = payload.get("scheduler") or payload.get("schedulerDefault")

    result = engine.generate(**gen_kwargs)

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


def _warm() -> None:
    """Pre-stage base-components from the CDN so the first real generation does
    not pay the download. Reads the same env contract as setup()
    (IMAGE_MODEL_CDN / IMAGE_MODEL_CACHE), so the parent must set them before
    invoking. SDXL only (~365 MB) — Z-Image / WAN bases are large and are warmed
    lazily on selection instead of here. warm() is best-effort: a failed prefetch
    logs a warning and falls back to a lazy fetch at first use.

    Run standalone:  python main.py warm
    """
    from imference_engine import Engine, RuntimeConfig

    specs = [("sdxl", None)]
    logger.info("Warming base-components: %s", specs)
    Engine(runtime=RuntimeConfig.from_env()).load().warm(specs)
    logger.info("Warm complete")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "warm":
        _warm()
    else:
        run()
