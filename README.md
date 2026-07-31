<div align="center">

<img src="build/appicon.png" alt="Imference Desktop" width="96" />

# Imference Desktop

**Generate AI images and videos — on your own GPU or in the cloud. One app.**

Free · No subscription · Windows & macOS

[![Latest release](https://img.shields.io/github/v/release/Publikey/imference-desktop?label=latest&color=f59e0b)](https://github.com/Publikey/imference-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Publikey/imference-desktop/total?color=38bdf8)](https://github.com/Publikey/imference-desktop/releases)

**English** · [简体中文](README.zh-CN.md)

<img src="docs/screenshots/hero.png" alt="Imference Desktop — generation view" width="800" />

</div>

## ⬇️ Download

| Platform | Download |
|---|---|
| **Windows** 10/11 (x64) | [**Installer**](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-windows-amd64-installer.exe) · [Portable .exe](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-windows-amd64.exe) |
| **macOS** 12+ (Intel & Apple Silicon) | [**.dmg**](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-macos-universal.dmg) |

All versions and `checksums.txt` (SHA-256) are on the
[**Releases**](https://github.com/Publikey/imference-desktop/releases) page.

### ⚠️ First launch

The app isn't code-signed yet, so your OS shows a one-time warning. This is
expected — here's how to get past it:

- **Windows** — SmartScreen popup → click **More info** → **Run anyway**.
- **macOS** — right-click the app → **Open** → **Open**.
  If macOS still refuses: `xattr -cr "/Applications/Imference Desktop.app"`

You can verify your download against `checksums.txt` from the release.
The app checks for new versions at startup and shows a banner when one is
available; code signing and silent in-app auto-update are on the roadmap.

## Why Imference Desktop

- ⚡ **One-click setup** — the app installs an isolated inference engine for
  you (nothing touches your system Python), detects your GPU, and starts and
  stops the engine on demand. No terminal, no CUDA wrestling.
- 🖥️ **Local generation, $0 per image** — run **seven model families** on your
  own GPU: **SDXL, SD 1.5, Z-Image, FLUX, Chroma, Qwen-Image and Anima**. Your
  prompts and images never leave your machine.
- 🧩 **Preconfigured models, zero setup** — pick a model from the curated
  catalog and hit Generate: the weights **download automatically**, and every
  model ships pre-tuned (steps, CFG, resolutions, quality tags, negative
  prompt) so your first image already looks right.
- 📦 **Bring your own model** — load any local `.safetensors` checkpoint
  (e.g. downloaded from Civitai) and pick its family. The file is used in
  place — nothing is copied or uploaded.
- ☁️ **Cloud when you want it** — no GPU or a weak one? Generate images and
  **video** on [imference.com](https://imference.com) from the same interface.
  Pay with an **API key (credits)** or **x402 (USDC on Base)** — the x402
  route needs no account at all.
- 🎛️ **Real controls, simple interface** — format, steps, CFG, seed, quality
  tags, negative prompt, **image-to-image**. Stack generations in a queue,
  and even switch models mid-run — the app finishes the current image first.
- 🗂️ **A gallery that remembers everything** — every image and video is saved
  with its prompt, model and settings. Filter, search, and review in a
  fullscreen viewer.

<div align="center">

<!-- More screenshots: drop captures in docs/screenshots/ then uncomment -->
<!--
<img src="docs/screenshots/gallery.png" alt="Gallery" width="400" /> <img src="docs/screenshots/params.png" alt="Parameters" width="400" />
-->

</div>

## Requirements

| Mode | What you need |
|---|---|
| **Local** | Windows: an NVIDIA GPU (CUDA), or an AMD Radeon RX 7000/9000 (ROCm preview — needs Python 3.12 + a recent Adrenalin driver) · Linux: NVIDIA (CUDA) or AMD (ROCm) · macOS: Apple Silicon. ~6–7 GB disk per model. |
| **Cloud** | Any machine — an [imference.com API key](https://imference.com/payments), or a funded x402 wallet. |

Learn more about the app on the
[imference.com/desktop](https://imference.com/desktop) page.

## Anonymous usage stats

The app sends anonymous usage statistics to imference.com — a toggle in
**Settings → Privacy** turns this off at any time. The full payload is exactly
this, nothing more:

```json
{
  "install_id": "f3a91c…",              // random UUID, NOT derived from your machine
  "app_version": "0.4.2",
  "os": "windows", "os_version": "10.0.26100", "arch": "amd64",
  "ui_language": "en",
  "gpu": { "vendor": "nvidia", "name": "RTX 4090", "vram_gib": 24 },
  "days": [
    { "date": "2026-07-30", "models": [
      { "model_code": "sdxl-base", "engine": "image",
        "count": 12, "errors": 1, "avg_duration_ms": 8400 }
    ] }
  ]
}
```

What this means in practice:

- **Never sent:** prompts, images, seeds, generation parameters, file paths,
  hostname, wallet address, API key.
- The install ID is random (`crypto/rand`), never derived from hardware, and is
  **not** sent on any authenticated cloud call — so it cannot be joined to a
  cloud account. The request itself carries no auth, and the server stores
  neither the IP address nor anything derived from it.
- Counters are per-day, per-model aggregates of **local** generations only
  (cloud usage is already visible server-side).
- Generations with a user-supplied checkpoint report `model_code: "custom"` —
  your checkpoint's filename never leaves the machine; only the engine family
  (e.g. `anima`) is kept.
- Turning the toggle off stops all collection and deletes the local state,
  install ID included; turning it back on starts from a fresh identity.
- Dev builds (`version = "dev"`) never send anything.

## Feedback

This is an early public release — rough edges are expected.
[Open an issue](https://github.com/Publikey/imference-desktop/issues) for bugs
or feature requests; it directly shapes what gets built next.

<details>
<summary><b>Build from source</b></summary>

Built with [Wails v3](https://v3alpha.wails.io) (Go + React).

Requires [Go](https://go.dev) 1.25+, [Node](https://nodejs.org) 20+, and the
Wails3 CLI:

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.116

wails3 dev      # run in dev mode (hot reload)
wails3 package  # production build + platform packaging (NSIS on Windows)
```

Releases are built automatically by GitHub Actions on a pushed `v*` tag
(see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

</details>
