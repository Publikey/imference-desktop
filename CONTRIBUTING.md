# Contributing to Imference Desktop

Thanks for your interest! Bug reports, feature requests, translations,
documentation fixes and code — all of it is welcome.

This is an early public release built by a small team, so the highest-value
contribution is usually **a good bug report**: the app touches a lot of
hardware and driver combinations we can't all test.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** from `main` for your changes
4. **Make your changes** and commit with clear messages
5. **Push** to your fork and open a **Pull Request**

## Development Setup

The app is [Wails v3](https://v3alpha.wails.io) — a Go backend with a React +
TypeScript frontend in one binary.

Requirements:
- [Go](https://go.dev) 1.25+
- [Node](https://nodejs.org) 20+
- The Wails3 CLI, pinned to the same alpha the release workflow uses

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.116

git clone https://github.com/Publikey/imference-desktop.git
cd imference-desktop

wails3 dev      # hot-reloading dev build
wails3 package  # production build + platform packaging (NSIS on Windows)
```

A local build reports its version as `dev`, which also disables the update
check — only CI stamps a real version (see `scripts/set-version.mjs`).

You do **not** need a GPU to work on most of the app: the UI, settings, gallery
and cloud paths all run without the local engine installed.

### Testing against a local engine checkout

The installer pins a tagged engine release (`EngineTarball` in
`internal/installer/installer.go`). To test unreleased engine code — e.g. the
editing tools before their tag exists — point the installer at a checkout:

```bash
export IMFERENCE_ENGINE_SOURCE=/path/to/imference-engine   # Windows: $env:IMFERENCE_ENGINE_SOURCE="C:\path\to\imference-engine"
wails3 dev
```

then click **Install / Reinstall** in Settings → Local engine. The engine is
installed editable (`pip install -e <path>[<extras>]`, same extras as the
release, `tools` included) and the startup version check leaves it alone, so
engine edits are live after an engine restart. The editing tools'
`sidecar/tools_main.py` is extracted next to `main.py`; its weights mirror
defaults to `$IMAGE_MODEL_CDN/tools` (override with `TOOLS_MODEL_CDN`,
cache dir with `TOOLS_MODEL_CACHE`).

The tool catalog the app ships (`internal/tools/catalog.json`) is a copy of the
engine's export — refresh it when the engine manifests change:

```bash
python -m imference_engine.tools export > internal/tools/catalog.json
```

The Python sidecar tests need the engine with the `tools` extra:

```bash
pip install -e "/path/to/imference-engine[tools,dev]"
python -m pytest sidecar/tests
```

## Layout

| Path | What lives there |
|---|---|
| `app.go`, `main.go` | The Wails-bound facade — every exported `*App` method becomes a frontend call |
| `internal/` | The real logic, one package per concern: `cloud` (imference.com HTTP client), `sidecar` (Python engine process), `tools` (editing tools: catalog, badges, routing, tools sidecar, local API), `installer`, `settings`, `gpu`, `wallet`, `x402`, `update` |
| `frontend/src/` | React app — `App.tsx` owns state, `components/` the UI, `lib/` the Go bridge and types |
| `frontend/src/locales/` | Translations (`en.json`, `zh-CN.json`) |
| `sidecar/` | The Python entry points the installed engine runs (`main.py` generation, `tools_main.py` editing tools) |
| `build/` | Wails packaging config and per-platform Taskfiles |

Keep business logic in `internal/` — `app.go` wires requests and emits events,
it doesn't decide things.

## Checks Before You Push

```bash
cd frontend && npm ci && npm run build   # runs tsc -b, so it type-checks too (and fills frontend/dist, which the Go root package embeds)
cd .. && go build ./... && go vet ./... && go test ./...
python -m pytest sidecar/tests            # needs imference-engine[tools] (see above)
```

CI builds the full app for Windows and macOS on a tagged release, so a change
that compiles on your platform can still break the other one — flag it in the
PR if you couldn't test both.

## Pull Requests

- **One PR per feature/fix** — keep changes focused
- **Write clear commit messages** — explain *why*, not just *what*
- **Say how you tested it** — which OS, which GPU, local or cloud mode
- **Update documentation** if your change affects user-facing behavior
- **Reference related issues** in your PR description (e.g., `Fixes #123`)

### Branch Naming

- `feature/short-description` — new features
- `fix/short-description` — bug fixes
- `docs/short-description` — documentation changes
- `i18n/short-description` — translations

## Questions

Not sure it's a bug? Ask in
[Discussions → Q&A](https://github.com/Publikey/imference-desktop/discussions/categories/q-a)
— "will it run on my GPU?", install trouble, or how to get a certain result.
The issue tracker is for confirmed bugs and feature requests.

## Bug Reports

Open an [issue](https://github.com/Publikey/imference-desktop/issues/new/choose)
with:
- **What happened** vs **what you expected**
- **Steps to reproduce**
- **Environment** — app version (Settings → bottom of the dialog), OS, GPU
  vendor and model, and whether you were in local or cloud mode
- **Logs** — the in-app Logs panel, copied for the failing run

Never paste your API key, wallet private key, or full `settings.json`.

## Feature Requests

Open an [issue](https://github.com/Publikey/imference-desktop/issues/new/choose)
describing:
- **The problem** you're trying to solve
- **Your proposed solution**
- **Alternatives** you've considered

## Translations

Adding a language means three things: a JSON file in
`frontend/src/locales/`, an entry in `SUPPORTED_LANGUAGES`
(`frontend/src/i18n.ts`), and a `README.<code>.md` if you want the landing page
translated too.

Keep the key set identical to `en.json` — a missing key silently falls back to
English. Chinese has no plural forms, so `zh-CN.json` legitimately omits the
`_one` variants; other languages may need their own plural categories.

Model names, file paths and engine output stay in English on purpose.

## Code Style

- **Go**: standard conventions (`gofmt`, `go vet`)
- **TypeScript/React**: no formatter or linter is wired up — match the
  surrounding file's style, and don't reformat code you aren't changing
- Comment the *why*, not the *what*. Most existing comments explain a
  constraint (a driver quirk, a server contract, an ordering requirement) —
  that's the bar
- Keep code readable — clarity over cleverness

## Community

- [Discussions](https://github.com/Publikey/imference-desktop/discussions) —
  questions, ideas, and generations worth showing off
- Be respectful and constructive
- We're building this together — every contribution matters

## Security

Found a vulnerability? **Don't open an issue** — see
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
