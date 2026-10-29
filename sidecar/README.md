# Sidecar — Python child process speaking runqy-python stdio protocol

Long-running Python process spawned by the Wails Go side at app startup.
Communicates over **stdin/stdout JSON-lines** (no HTTP, no port) using
[runqy-python](https://pypi.org/project/runqy-python/) — the same protocol
the GPU workers (`sdxl-multimodel-v2`) use under Runqy in production. One
subprocess per app = one loaded engine.

Wire shape:

```
Go → Python (stdin)  : {"task_id": "...", "payload": {...}}
Python → Go (stdout) : {"task_id": "...", "result": {...}, "error": null}
                       or {"status": "ready"}  (sent once after @load)
Python → Go (stderr) : logs (everything written via Python's logging module)
```

Stderr is streamed live by the Go parent into the in-app LogPanel — so
engine internals (`Loading SDXL pipeline…`, `BatchSizer: …`, etc.) show up
without any extra plumbing.

## Auto-install via the app

The desktop's **Install Engine** button creates a venv at
`%LOCALAPPDATA%\imference-desktop-go\engine-venv\` and pip-installs everything
needed (a GPU torch matching the detected vendor — NVIDIA CUDA, AMD ROCm, or
Apple MPS — plus `imference-engine[runtime]` and `runqy-python`). You don't
need to set up the venv manually unless you want a specific Python
interpreter or to debug from a shell.

## Manual setup (debugging only)

```powershell
# 1. Fresh venv (somewhere stable)
#    NVIDIA: py -3.11 works. AMD on Windows: MUST be py -3.12 (AMD's ROCm
#    wheels are cp312-only).
py -3.11 -m venv C:\envs\imference
C:\envs\imference\Scripts\Activate.ps1

# 2. GPU torch FIRST — else pip pulls CPU torch later and you get fp16-on-CPU
#    hangs at ~0 steps/s (cu124/rocm6.4 match imference-engine's torch>=2.6 pin)
# NVIDIA:
pip install torch --index-url https://download.pytorch.org/whl/cu124
# AMD on Windows (preview; Python 3.12 + Radeon RX 7000/9000 / Ryzen AI only):
#   pip install --no-cache-dir `
#     https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1+rocm7.2.1-cp312-cp312-win_amd64.whl `
#     https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1+rocm7.2.1-cp312-cp312-win_amd64.whl
# AMD on Linux:
#   pip install torch --index-url https://download.pytorch.org/whl/rocm6.4

# 3. imference-engine with the image-backend extras (keep the tag in sync with
#    EngineTarball in internal/installer/installer.go)
pip install "imference-engine[sdxl,sd15,zimage,flux,chroma,qwenimage,anima,krea2,tools] @ https://github.com/Publikey/imference-engine/archive/refs/tags/v0.5.1.tar.gz"
#    (or, from a checkout: pip install -e "C:\path\to\imference-engine[sdxl,...,tools]")

# 3b. GPU flavor of onnxruntime for the editing tools (replaces the CPU wheel)
# NVIDIA:            pip uninstall -y onnxruntime && pip install onnxruntime-gpu
# Windows (AMD/Intel): pip uninstall -y onnxruntime && pip install onnxruntime-directml

# 4. Sidecar deps (runqy-python)
pip install -r "C:\git windows\imference-desktop-go\sidecar\requirements.txt"

# 5. (Optional) sd_embed for weighted prompts + BREAK keyword
pip install "sd-embed @ git+https://github.com/xhinker/sd_embed.git@main"
```

## Manual run (talking to it by hand without the Wails app)

```powershell
$env:IMFERENCE_LOCAL_SDXL_PATH = "C:\path\to\sdxl_base.safetensors"
C:\envs\imference\Scripts\python.exe C:\git windows\imference-desktop-go\sidecar\main.py
```

Wait for `{"status": "ready"}` on stdout, then send a task line on stdin:

```
{"task_id":"t1","payload":{"prompt":"a cat","width":512,"height":512,"num_steps":12,"guidance_scale":6.0}}
```

You'll get back a `{"task_id":"t1","result":{"seeds":[...],"images":["<base64>"],...}}` line.

## Editing-tools sidecar (`tools_main.py`)

A second, light process for the editing tools (`imference_engine.tools`):
upscale, remove background, eraser, click-to-select, restore faces, describe,
image and video utilities. It loads no generation model, is started by the app
on the first local tool run and stopped after a few idle minutes (models
released first). Same runqy stdio protocol; the payload carries an `op`:

```
{"task_id":"t1","payload":{"op":"run","job_id":"j1","tool_id":"resize","inputs":{"image":"C:\\in.png"},"params":{"width":512},"output_dir":"C:\\out"}}
-> {"task_id":"t1","result":{"ok":true,"result":{"tool_id":"resize","outputs":[{"name":"image","type":"image","format":"png","path":"C:\\out\\resize-1a2b3c4d.png",...}],...}}}
{"task_id":"t2","payload":{"op":"release"}}   -> {"ok":true,"released":2}
{"task_id":"t3","payload":{"op":"catalog"}}   -> {"ok":true,"catalog":{...}}
{"task_id":"t4","payload":{"op":"probe"}}     -> {"ok":true,"providers":[...],"ffmpeg":true,"torch_device":"cuda","ram_gb":31.9}
```

Failures are typed: `{"ok":false,"error":{"code":"oom","message":"..."}}`
(codes: `invalid_input`, `too_large`, `unsupported_runtime`, `weights_missing`,
`oom`, `timeout`, `internal`). Outputs are always files under `output_dir` —
never base64 on stdout. Progress goes to stderr as
`IMTOOL_PROGRESS {"task_id":"<job_id>","stage":"loading","fraction":0.5}`
(stages `downloading_weights`, `loading`, `running`, `encoding`).

Env: `IMFERENCE_TOOLS_DEVICE` (auto | cpu | cuda | directml | rocm | mps),
`TOOLS_MODEL_CDN` (weights mirror, default `<IMAGE_MODEL_CDN>/tools`),
`TOOLS_MODEL_CACHE` (weights cache).

The generation tools (vary / inpaint / outpaint) run in `main.py` instead, on
the loaded model: a `generate` payload with a `tool_id` (+ `job_id`, `inputs`,
`params`, `output_dir`) answers `{"tool": <ToolResult>}` or
`{"tool_error": {code, message}}`.

Tests: `python -m pytest sidecar/tests` (needs `imference-engine[tools]`).
