# Imference Desktop

A desktop app for AI image generation — run models **in the cloud** or
**locally on your own GPU**, from one clean interface. Windows & macOS.

Built with [Wails](https://wails.io) (Go + React).

## Download

Grab the latest build from the [**Releases**](https://github.com/Publikey/imference-desktop/releases) page.

**Windows** — the installer (`…-windows-amd64-installer.exe`) or the portable
`.exe`.
**macOS** — the `.dmg` (universal: Intel & Apple Silicon).

> The app isn't code-signed yet, so the OS will warn on first launch:
> - **Windows**: SmartScreen → *More info* → *Run anyway*.
> - **macOS**: right-click the app → *Open* (or `xattr -cr "/Applications/Imference Desktop.app"`).

## Features

- **Cloud** — generate on [imference.com](https://imference.com). Pay with an
  **API key (credits)** or **x402 (USDC on Base)**.
- **Local** — one-click engine install, then run **SDXL** / **Z-Image** models
  on your GPU. The engine starts/stops on demand.
- **Per-model parameters** from the catalog (format, steps, CFG, seed, quality
  tags, negative prompt), image-to-image, and a metadata-rich **gallery** with
  filters and a fullscreen viewer.

### Requirements

- Windows 10/11 (x64) or macOS 12+.
- **Local generation**: an NVIDIA GPU (CUDA) on Windows, or Apple Silicon on
  macOS. The installer sets up an isolated Python environment; models are
  downloaded on demand (~6–7 GB each).
- **Cloud generation**: an imference.com API key, or a funded x402 wallet.

## Build from source

Requires [Go](https://go.dev) 1.24+, [Node](https://nodejs.org) 20+, and the
Wails CLI:

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0

wails dev     # run in dev mode (hot reload)
wails build   # produce a binary in build/bin/
```

Releases are built automatically by GitHub Actions on a pushed `v*` tag
(see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Status

Early public release — expect rough edges, and please
[open issues](https://github.com/Publikey/imference-desktop/issues). In-app
auto-update and code signing are on the way.
