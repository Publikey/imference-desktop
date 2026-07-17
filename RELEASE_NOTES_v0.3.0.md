# Imference Desktop v0.3.0

A ground-up overhaul of the desktop app: a new panel-based workspace, a
reimagined gallery and image viewer, a persistent activity dock, a full design
system, and a long list of reliability fixes. Also bumps the bundled
**imference-engine to v0.3.2**.

> Upgrading: no action needed — the app installs/updates the local engine to
> v0.3.2 on next launch if you use local generation.

## ✨ Highlights

- **New workspace** — the main window is now a set of drag-reorderable, stackable
  panels (Create / Gallery) you can arrange side-by-side or stacked, and resize.
  Your layout persists across launches.
- **Activity dock** — in-flight runs now live in a persistent bottom-right widget
  showing live cloud/local counts, with a pulse when a run starts, finishes, or
  fails. Click it for the full activity list. No more hunting for a panel that
  scrolled off-screen.
- **Reimagined gallery** — right-click actions, multi-select, prompt search, and
  drag an image straight onto the Create panel to use it as an img2img source.
- **Better image viewer** — click-to-zoom magnifier, keyboard navigation, and a
  true **fullscreen mode** (press `F`) with a solid backdrop and no side panel.
- **Command palette** — press `⌘K` / `Ctrl+K` to jump to any action.

## 🚀 New features

- Drag-reorderable, 2D-stackable, resizable panels with animated transitions.
- Persistent Activity dock + overlay (replaces the old Activity panel).
- Gallery: context menu, multi-select with a floating action bar, prompt search,
  drag-out to the OS, and drag-to-img2img.
- Image viewer: click-to-zoom, arrow-key navigation, `F` for fullscreen.
- Command palette (`⌘K`) and a global generate shortcut (`⌘/Ctrl+Enter`).
- Guided first-run onboarding in the Create panel.
- Manual light/dark theme toggle.
- Local generations are queued through a serial FIFO so requests never collide.
- Cancel button for in-progress local model downloads.

## 💅 Design & UX

- A shared design system: every native `select`/`checkbox`/dialog replaced with
  themed primitives (segmented controls, checkboxes, skeletons, progress, toasts).
- Create panel reworked: mode-tinted surface, cleaner model bar, format moved
  under the prompt (with custom dimensions in local mode), parameters below.
- Settings redesigned as an icon-led paned dialog.
- Payment bar on the main UI shows credits (API key) or USD (x402); switching
  happens in Settings.
- App-wide toasts + a restyled Logs panel for consistent feedback.
- Brand palette re-derived from the logo; loading skeletons and empty states
  throughout; motion polish with full `prefers-reduced-motion` coverage.
- Window opens at a size that lands in the two-column layout by default.

## 🐛 Fixes

- **Drag-and-drop reliability** — in-app drags (panel reorder, gallery→img2img)
  were rewritten on pointer events. WebKit/WKWebView doesn't fire HTML5
  `drop`/`dragend` reliably for in-page drags, which left panel drop-outlines
  stuck on and silently broke img2img; both now work everywhere.
- **Cloud downloads on slow connections** — the finished image download now
  retries transient failures with backoff instead of losing an image that was
  generated fine.
- **Local model download** — can now be cancelled; the partial file is cleaned up
  and the previous engine restored.
- **Cloud model picker** — no longer blocked while a local model is downloading.
- Gallery delete no longer leaves stale tiles; format selector overflow fixed;
  Create panel scroll no longer clips the last card or its rounded corner.

## 🔧 Under the hood

- Bundled **imference-engine → v0.3.2**.

---

**Full changelog:** v0.2.3...v0.3.0
