<div align="center">

<img src="build/appicon.png" alt="Imference Desktop" width="96" />

# Imference Desktop

**AI image generation on your own GPU — or in the cloud. One app.**

Free · No subscription · Windows & macOS

[![Latest release](https://img.shields.io/github/v/release/Publikey/imference-desktop?label=latest&color=f59e0b)](https://github.com/Publikey/imference-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Publikey/imference-desktop/total?color=38bdf8)](https://github.com/Publikey/imference-desktop/releases)

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

- 🖥️ **Local generation, $0 per image** — run **SDXL** and **Z-Image** directly
  on your GPU. Your prompts and images never leave your machine.
- ☁️ **Cloud when you want it** — no GPU or a weak one? Generate on
  [imference.com](https://imference.com) from the same interface. Pay with an
  **API key (credits)** or **x402 (USDC on Base)** — the x402 route needs no
  account at all.
- ⚡ **One-click local engine** — the app installs an isolated inference engine
  for you (nothing touches your system Python) and starts/stops it on demand.
  Models download automatically when first used (~6–7 GB each).
- 🎛️ **Real controls** — per-model parameters straight from the catalog:
  format, steps, CFG, seed, quality tags, negative prompt. Plus
  **image-to-image**.
- 🗂️ **A gallery that remembers everything** — every generation is saved with
  its prompt, model and settings. Filter, search, and review in a fullscreen
  viewer.

<div align="center">

<!-- More screenshots: drop captures in docs/screenshots/ then uncomment -->
<!--
<img src="docs/screenshots/gallery.png" alt="Gallery" width="400" /> <img src="docs/screenshots/params.png" alt="Parameters" width="400" />
-->

</div>

## Requirements

| Mode | What you need |
|---|---|
| **Local** | Windows: an NVIDIA GPU (CUDA) · macOS: Apple Silicon. ~6–7 GB disk per model. |
| **Cloud** | Any machine — an [imference.com API key](https://imference.com/payments), or a funded x402 wallet. |

Learn more about the app on the
[imference.com/desktop](https://imference.com/desktop) page.

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
