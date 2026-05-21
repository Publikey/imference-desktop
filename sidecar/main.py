"""FastAPI sidecar for imference-desktop.

Wraps imference_engine.Engine behind localhost HTTP so the Electron renderer
can call it from JavaScript. POC scope: SDXL only, one model, no auth, bind
on 127.0.0.1, no batching > 1.

Boot config via env vars:
    IMFERENCE_LOCAL_SDXL_PATH   absolute path to a .safetensors checkpoint (required)
    IMFERENCE_SIDECAR_PORT      TCP port to listen on (default 38000)
    IMFERENCE_SIDECAR_HOST      bind host (default 127.0.0.1 — don't change)

Run:
    python -m uvicorn sidecar.main:app --host 127.0.0.1 --port 38000
or:
    python sidecar/main.py  (uses uvicorn.run with the env-var port)
"""
from __future__ import annotations

import base64
import io
import logging
import os
import sys
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("imference.sidecar")

SDXL_MODEL_NAME = "sdxl"

app = FastAPI(title="imference-desktop sidecar", version="0.0.1")

# Engine is constructed at startup, not at import time, so uvicorn --reload doesn't
# re-pay the 30s load cost on every code change.
_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    return _engine


@app.on_event("startup")
def _startup() -> None:
    global _engine
    weights = os.environ.get("IMFERENCE_LOCAL_SDXL_PATH")
    if not weights:
        # Fail loud so Electron can show a clean error in the toast rather than
        # the sidecar appearing to start and then 503'ing on every request.
        logger.error("IMFERENCE_LOCAL_SDXL_PATH not set; aborting startup")
        raise RuntimeError("IMFERENCE_LOCAL_SDXL_PATH not set")
    if not os.path.isfile(weights):
        logger.error(f"IMFERENCE_LOCAL_SDXL_PATH points to a missing file: {weights}")
        raise RuntimeError(f"SDXL weights not found at {weights}")

    from imference_engine import Engine, RuntimeConfig
    logger.info(f"Loading engine with SDXL weights: {weights}")
    eng = Engine(runtime=RuntimeConfig(device="auto")).load()
    eng.register_model(SDXL_MODEL_NAME, backend="sdxl", weights_path=weights)
    _engine = eng
    logger.info("Sidecar ready")


@app.get("/healthz")
def healthz() -> dict:
    if _engine is None:
        # 503 lets the Electron health-check poller distinguish "starting" from
        # "down for good" — the spawn watchdog kills the process on its own timer.
        raise HTTPException(status_code=503, detail="engine not ready")
    device = _engine._device.torch_str if _engine._device else "unknown"
    return {"ok": True, "device": device, "model": SDXL_MODEL_NAME}


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    negative_prompt: Optional[str] = None
    width: int = 1024
    height: int = 1024
    num_steps: int = 28
    guidance_scale: float = 6.0
    seed: Optional[int] = None


class GenerateResponse(BaseModel):
    seeds: list[int]
    images: list[str]  # base64-encoded PNG, parallel to seeds
    errors: list[str]  # parallel to seeds; "" if no error


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    engine = _get_engine()

    result = engine.generate(
        model=SDXL_MODEL_NAME,
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        width=req.width,
        height=req.height,
        num_steps=req.num_steps,
        guidance_scale=req.guidance_scale,
        seed=req.seed,
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

    return GenerateResponse(
        seeds=result.seeds,
        images=images_b64,
        errors=error_strs,
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("IMFERENCE_SIDECAR_PORT", "38000"))
    host = os.environ.get("IMFERENCE_SIDECAR_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="info")
