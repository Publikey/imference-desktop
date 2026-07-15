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

# 3. imference-engine with runtime extras
pip install "imference-engine[runtime] @ https://github.com/Publikey/imference-engine/archive/refs/tags/v0.2.1.tar.gz"

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
