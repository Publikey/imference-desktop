# Sidecar — local Python HTTP wrapper

Tiny FastAPI app that exposes `imference_engine.Engine.generate()` over localhost
HTTP. The Wails app (Go side) spawns it as a child process at startup and kills it on quit.
This is the same `main.py` as the Electron POC sibling repo — verbatim copy.

## Manual setup (one-time, per user)

The app does NOT bundle Python. You provide a venv that has both `imference-engine`
and the sidecar's deps installed, then point the app at your `python.exe`. If you
already set up the venv for `imference-desktop` (Electron), it's directly reusable
here — no need to redo this.

```powershell
# 1. Create a fresh venv (somewhere stable, e.g. C:\envs\imference)
py -3.11 -m venv C:\envs\imference
C:\envs\imference\Scripts\Activate.ps1

# 2. CUDA torch BEFORE imference-engine (else pip pulls the CPU wheel and you'll
#    get a "fp16 hangs on CPU" warning from the engine).
pip install torch --index-url https://download.pytorch.org/whl/cu121

# 3. imference-engine with runtime extras
pip install -e "C:\git windows\imference-engine[runtime]"

# 4. Sidecar's own deps (fastapi, uvicorn)
pip install -r "C:\git windows\imference-desktop-go\sidecar\requirements.txt"

# 5. (Optional) sd_embed for weighted prompts + BREAK keyword
pip install "sd-embed @ git+https://github.com/xhinker/sd_embed.git@main"
```

Then in the app's settings dialog (cog icon top-right), set **Python path** to
`C:\envs\imference\Scripts\python.exe` and **SDXL weights path** to your
local `.safetensors`.

## Manual run (for debugging without the Wails app)

```powershell
$env:IMFERENCE_LOCAL_SDXL_PATH = "C:\path\to\sdxl_base.safetensors"
$env:IMFERENCE_SIDECAR_PORT = "38000"
C:\envs\imference\Scripts\python.exe C:\git windows\imference-desktop-go\sidecar\main.py
# In another shell:
curl http://127.0.0.1:38000/healthz
```
