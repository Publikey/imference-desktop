<div align="center">

<img src="build/appicon.png" alt="Imference Desktop" width="96" />

# Imference Desktop

**90 curated AI image and video models. One app.**
Run them free on your own GPU, load any checkpoint you already have,
or switch to the cloud when you need more.

Free · No subscription · Windows & macOS

[![Latest release](https://img.shields.io/github/v/release/Publikey/imference-desktop?label=latest&color=f59e0b)](https://github.com/Publikey/imference-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Publikey/imference-desktop/total?color=38bdf8)](https://github.com/Publikey/imference-desktop/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/Publikey/imference-desktop/release.yml)](https://github.com/Publikey/imference-desktop/actions)
[![License](https://img.shields.io/github/license/Publikey/imference-desktop)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Publikey/imference-desktop?style=flat&logo=github)](https://github.com/Publikey/imference-desktop/stargazers)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](#download)

**English** · [简体中文](README.zh-CN.md)

[**Download**](#download) · [Quick start](#quick-start) · [Models](#models) · [Website](https://imference.com/desktop) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

<img src="docs/screenshots/hero.png" alt="Imference Desktop — generation view" width="800" />

</div>

<div align="center">

| **90** | **15** | **75+** | **25+** | **$0** |
|:---:|:---:|:---:|:---:|:---:|
| curated models | model families | run on your own GPU | LoRAs | per image, locally |

</div>

<a id="download"></a>

## ⬇️ Download

| Platform | Download |
|---|---|
| **Windows** 10/11 (x64) | [**Installer**](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-windows-amd64-installer.exe) · [Portable .exe](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-windows-amd64.exe) |
| **macOS** 12+ (Intel & Apple Silicon) | [**.dmg**](https://github.com/Publikey/imference-desktop/releases/latest/download/imference-desktop-go-macos-universal.dmg) |
| **Linux** | No prebuilt binary yet — [build from source](#build-from-source) |

All versions and `checksums.txt` (SHA-256) are on the
[**Releases**](https://github.com/Publikey/imference-desktop/releases) page.

<a id="quick-start"></a>

## 🚀 Quick start

1. **Download** the installer for your OS above and run it.
2. **Open the app.** It sets up its own inference engine in an isolated
   environment and detects your GPU. No terminal, no CUDA wrestling.
3. **Pick a model, hit Generate.** The weights download on their own and every
   model ships pre-tuned, so your first image already looks right.

No GPU? Flip the switch to **Cloud** and generate on
[imference.com](https://imference.com) from the same screen.

### ⚠️ First launch

The app isn't code-signed yet, so your OS shows a one-time warning. This is
expected — here's how to get past it:

- **Windows** — SmartScreen popup → click **More info** → **Run anyway**.
- **macOS** — right-click the app → **Open** → **Open**.
  If macOS still refuses: `xattr -cr "/Applications/Imference Desktop.app"`

You can verify your download against `checksums.txt` from the release.
The app checks for new versions at startup and shows a banner when one is
available; code signing and silent in-app auto-update are on the roadmap.

<a id="models"></a>

## 🎨 Models

Two ways to get a model, and you can mix them:

- **The curated catalog**: 90 hand-picked models that download in one click and
  arrive pre-tuned (steps, guidance, resolutions, quality tags, negative
  prompt). The fastest way to a good first image.
- **Your own checkpoints**: any `.safetensors` you downloaded from Civitai,
  Hugging Face or anywhere else. The catalog is a starting point, not a limit.

### Curated, on your own GPU — 11 families, 75+ models, $0 per image

| Family | Models | What it is good at |
|---|:---:|---|
| **Illustrious** | 28 | Anime and illustration, the biggest community catalog. LoRAs. |
| **Anima** | 16 | Modern anime models with strong prompt following. LoRAs. |
| **Krea 2** | 11 | Photoreal and stylized images in 8 steps. LoRAs. |
| **Z-Image** | 9 | Fast, realistic photos in 8 steps. LoRAs. |
| **SDXL** | 3 | The classic all-rounder. LoRAs. |
| **Pony** | 3 | Characters and stylized art. LoRAs. |
| **Qwen-Image** | 2 | Text and layout in 4 steps (Qwen-Image 2512), and editing by instruction (Qwen-Image-Edit). |
| **FLUX.2 klein** | 1 | An image in 4 steps; edits a reference image by instruction. |
| **ERNIE-Image** | 1 | Accurate text inside the image, 8 steps. |
| **Lumina-Image 2.0** | 1 | The base of the Neta anime finetunes. |
| **LongCat-Image-Edit** | 1 | Editing by instruction in 8 steps. |

Short on VRAM? For FLUX.2 klein, ERNIE-Image, Lumina-Image and Qwen-Image 2512
the app picks the build that fits your card; all four were measured on an
8 GB GPU.

### Any checkpoint you already have

Not in the catalog? Load it anyway. In the model picker, click **Add a
checkpoint…**, point at a local `.safetensors` file and pick its family:

**SDXL** (Illustrious, Pony, NoobAI and every other SDXL finetune) · **SD 1.5**
· **Z-Image** · **FLUX.1** · **Chroma** · **Qwen-Image** · **Qwen-Image-Edit**
· **Anima** · **Krea 2**

The file is used where it is: nothing is copied, nothing is uploaded. Your
model shows up next to the catalog ones, with the same controls, LoRAs and
gallery. LoRAs work the same way: import your own `.safetensors`.

### Cloud only — 4 more families, no GPU needed

| Family | Models | Type |
|---|---|---|
| **GPT Image** (OpenAI) | GPT Image-1, Image-2, 2.5 and 2.6 in Flare and Sunburst | Image, and editing by instruction |
| **FLUX 3** | FLUX 3, FLUX 3 Klein | Image |
| **MiniMax H3** | H3, H3 Max Turbo | Video with sound |
| **Wan 3.0** | Wan 3.0 | Video |

Most local models also run in the cloud (85 models in all), so a laptop without
a GPU gets the same catalog. Pay with credits or with **x402** (USDC on Base),
which needs no account.

## Why Imference Desktop

- ⚡ **Set up in one click.** The app installs its own engine, detects your
  GPU, and starts and stops the engine on demand.
- 🖥️ **Local, private, free.** Images made on your GPU cost nothing, and your
  prompts and pictures never leave your machine.
- 📦 **Not a walled garden.** Bring any checkpoint or LoRA you already have;
  the catalog is there to save you the setup, not to limit you.
- ☁️ **Cloud when you want it.** Same interface, one switch. Bigger models,
  video, or just no GPU at hand.
- 🧩 **25+ LoRAs.** Stack up to four styles, characters or detail boosters on
  Illustrious, Pony, SDXL, Z-Image, Krea 2 and Anima. One-click download from
  the catalog, or import your own `.safetensors`.
- 🎛️ **Real controls, simple screen.** Format, steps, guidance, seed, negative
  prompt, image-to-image. Queue generations and switch models mid-run.
- 🗂️ **A gallery that remembers.** Every image and video is saved with its
  prompt, model and settings. Filter, search, reuse a past recipe.
- 🪄 **Editing tools built in.** Edit with instructions, upscale, remove a
  background, erase an object, expand, repaint, restore faces.
- 🤖 **Driven by your AI agent.** Connect Claude Desktop, Claude Code, Cursor
  or any MCP app in one click and ask for an image in the chat.

<div align="center">

<!-- More screenshots: drop the captures in docs/screenshots/ then uncomment.
<img src="docs/screenshots/models.png" alt="Model picker" width="400" /> <img src="docs/screenshots/gallery.png" alt="Gallery" width="400" />
<img src="docs/screenshots/tools.png" alt="Editing tools" width="400" /> <img src="docs/screenshots/cloud.png" alt="Cloud mode" width="400" />
-->

</div>

## 🪄 Editing tools

Right-click any image in the gallery, or open it and press **Edit**.

- **Edit with instructions**: "replace the sky with a sunset", "remove the man
  on the left", with up to two reference images.
- **Upscale, vary, expand, repaint, restore faces.**
- **Remove background** and **magic eraser** with click-to-select.
- **Describe** an image, plus quick utilities: resize, crop, convert, strip
  metadata, trim or convert a video.

Each tool shows where it will run before you start: on your computer (nothing
is uploaded) or in the cloud at the price shown. The app never switches to the
cloud without asking. Details in [docs/editing-tools.md](docs/editing-tools.md).

## 🤖 AI agents (Claude, Cursor…)

Ask Claude for an image and your own GPU makes it, for free, live in the app.

1. Open **Settings → AI agents** and click **Connect** next to Claude Desktop
   or Claude Code. For any other MCP app, **Show setup** gives the snippet.
2. Restart the AI app and ask: *"Generate a lighthouse in a storm with
   Imference."*

Every run shows up in Activity, marked *via Claude*, and lands in your gallery.
Cloud runs spend your credits only if you allow it; that option is off by
default. Setup details and the local API are in
[docs/local-api.md](docs/local-api.md).

## Requirements

| Mode | What you need |
|---|---|
| **Local** | **Windows**: an NVIDIA GPU (CUDA), or an AMD Radeon RX 7000/9000 (ROCm preview, needs Python 3.12 and a recent Adrenalin driver). **macOS**: Apple Silicon. Python 3.11 or newer installed (the app builds its own isolated environment from it). About 6 to 13 GB of disk per model. |
| **Cloud** | Any machine, with an [imference.com API key](https://imference.com/payments) or a funded x402 wallet. |

Linux (NVIDIA CUDA / AMD ROCm) is supported by the engine and builds from
source, but there is no prebuilt binary yet: see
[Build from source](#build-from-source).

There is also a cloud-only **web version** of the app, as a prototype:
[docs/web.md](docs/web.md). More about the app on
[imference.com/desktop](https://imference.com/desktop).

## Feedback

This is an early public release — rough edges are expected.

- 🐛 **Something broken?** [Open an issue](https://github.com/Publikey/imference-desktop/issues/new/choose) — it directly shapes what gets built next.
- 💬 **A question, or not sure it's a bug?** [Discussions → Q&A](https://github.com/Publikey/imference-desktop/discussions/categories/q-a) — GPU support, install trouble, how-to.
- 🖼️ **Made something good?** [Show and tell](https://github.com/Publikey/imference-desktop/discussions/categories/show-and-tell).

<a id="build-from-source"></a>

<details>
<summary><b>Build from source</b></summary>

Built with [Wails v3](https://v3alpha.wails.io) (Go + React). This is also how
to run it on Linux, which the release workflow doesn't package yet.

Requires [Go](https://go.dev) 1.25+, [Node](https://nodejs.org) 20+, and the
Wails3 CLI:

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.116

wails3 dev      # run in dev mode (hot reload)
wails3 package  # production build + platform packaging (NSIS on Windows)
```

Releases are built automatically by GitHub Actions on a pushed `v*` tag
(see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo layout, the checks to run
before a PR, and how to add a language.

</details>

## License

[MIT](LICENSE) © Publikey Sàrl

Model weights are **not** covered by this license — each model on the catalog
carries its own terms (CreativeML, Apache-2.0, the Gemma Terms of Use for
Lumina-Image's text encoder, the providers' terms for GPT Image and FLUX 3…).
Check the license of any model you use, especially commercially.

Found a security issue? See [SECURITY.md](SECURITY.md) — please don't open a
public issue.
