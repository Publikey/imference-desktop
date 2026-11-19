# Editing tools

Right-click any image in the gallery (or open it and press **Edit**) to run a
tool on it. Every tool shows where it will run before you start:

| Badge | Meaning |
|---|---|
| **Local** | Runs on this computer at full speed (GPU, or a light CPU tool). Nothing is uploaded. |
| **Local (slow)** | Runs on this computer on the CPU — no compatible GPU runtime was found. Still private, just slower. |
| **Cloud** | This computer can't run it (engine not installed, not enough memory, no generation model loaded…): it runs on imference.com at the price shown. |

- **Where it runs.** Settings → *Editing tools* picks the default: **Auto**
  (local when the badge says so, otherwise the cloud), **Always local** or
  **Always cloud**; each run can override it. If a local run fails because the
  machine runs out of memory or lacks a runtime, the app *proposes* the cloud
  with its price — it never switches silently.
- **Privacy.** Local tools never upload anything. Cloud runs show *"Runs in
  the cloud: your image is uploaded"* and the price before you start; uploads
  are deleted from the cloud within 24 hours.
- **How it works.** Image and video tools run in a small separate tools engine
  (ONNX models of 2–500 MB, downloaded on first use and cached) that starts on
  demand and frees its memory after a few idle minutes. *Vary*, *Repaint* and
  *Expand* run on the generation model you have loaded (any model that does
  image-to-image). Results land in your gallery with a **tool** badge and the
  tool's settings in their metadata; you can chain another tool on a result.
- **Edit with instructions.** Describe the change in plain words ("replace
  the sky with a sunset", "remove the man on the left", "make it a watercolor")
  and optionally add up to two reference images ("put the hat from image 2 on
  the cat"). It uses an instruction-edit model (Qwen-Image-Edit 2511 or
  LongCat-Image-Edit Turbo), not your text-to-image model; the instruction is
  saved as the result's prompt.
  - *Local*: pick the edit model in the dialog when the catalog offers
    several, and load it as your local model. Qwen-Image-Edit
    needs a CUDA or ROCm GPU with about **12 GB of VRAM** (the app streams the
    20B transformer with group offload) and about **64 GB of RAM**.
    LongCat-Image-Edit Turbo runs on an 8 GB card but reserves about 37 GB of
    memory while loading: plan for 48 GB of RAM. An edit
    model can't generate from a prompt: while it is loaded, Generate points
    you to *Edit with instructions*, and *Vary / Repaint / Expand* run in the
    cloud.
  - *Otherwise* it runs in the cloud on `qwen-image-edit-2511` (or another
    edit model you pick in the dialog) at that model's price.

The local API that lets AI agents run these tools is described in
[AI agents and the local API](local-api.md).
