// Full-screen viewer with generation details.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { ToolMenuList } from "@/components/ToolBits";
import { ENGINE_LABEL } from "@/lib/engines";
import { isWeb } from "@/lib/target";
import type { GenerationMeta } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ViewerItem } from "./Gallery";
import { isVideoSrc } from "./shared";

// Fullscreen viewer over the gallery's viewable sequence: ←/→ (and edge arrows)
// navigate, and the same actions as the right-click menu act on the current
// image. Backdrop click or Esc closes.
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onUseAsSource,
  onReuseSettings,
  onDelete,
  onTool,
}: {
  items: ViewerItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onDelete: (name: string) => void;
  /** Editing tools; absent = no Edit menu (e.g. the unsaved session viewer). */
  onTool?: (toolId: string, target: ViewerItem, maskMode?: "select") => void;
}) {
  const { t } = useTranslation();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Click-to-zoom: a 2× magnifier whose focus follows the cursor. Reset on nav.
  const [zoom, setZoom] = useState(false);
  const swipeRef = useRef<{ x: number; y: number } | null>(null); // touch start, for swipe nav
  const [origin, setOrigin] = useState("50% 50%");
  useEffect(() => setZoom(false), [index]);
  // Distraction-free view: hide the meta panel, go solid black, fill the window.
  const [full, setFull] = useState(false);
  // The Edit (tools) dropdown in the action bar.
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => setEditOpen(false), [index]);

  const total = items.length;
  const current = items[index];
  const lightboxAspect =
    current?.meta?.width && current?.meta?.height ? current.meta.width / current.meta.height : 1;
  const hasPrev = index > 0;
  const hasNext = index < total - 1;
  const prev = useCallback(() => onIndex(Math.max(0, index - 1)), [index, onIndex]);
  const next = useCallback(() => onIndex(Math.min(total - 1, index + 1)), [index, total, onIndex]);

  // Fetch the current image's bytes on navigation (and after a delete shifts the
  // sequence, keyed by length).
  useEffect(() => {
    const cur = itemsRef.current[index];
    if (!cur) return;
    let alive = true;
    setLoading(true);
    setSrc(null);
    void cur
      .getSrc()
      .then((d) => alive && (setSrc(d), setLoading(false)))
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [index, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc leaves fullscreen first, then closes the viewer.
      if (e.key === "Escape") {
        if (editOpen) setEditOpen(false);
        else setFull((f) => (f ? false : (onClose(), false)));
      }
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "f" || e.key === "F") setFull((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next, editOpen]);

  if (!current) return null;
  const meta = current.meta;

  // Actions sit in frosted groups (edit | image actions | delete | view), each
  // button flat inside its group; the edge arrows are standalone discs.
  const iconBtn =
    "rounded-full p-1.5 text-white/85 transition hover:bg-white/15 hover:text-white disabled:opacity-30 sm:p-2 [&_svg]:size-[1.125rem]";
  const group = "flex items-center gap-0.5 rounded-full bg-white/10 p-1 backdrop-blur";
  const navBtn = "rounded-full bg-white/10 p-2 text-white backdrop-blur transition hover:bg-white/20";

  // Portal to <body>: the gallery renders inside <main> (relative z-10), whose
  // stacking context would otherwise trap this overlay below root-level fixed
  // chrome like the Activity dock.
  return createPortal(
    <div
      className={cn(
        "animate-in fade-in fixed inset-0 z-50 flex items-center justify-center",
        // Phones: room for the top bar; the image + details column scrolls below it.
        full ? "bg-black p-0" : "bg-black/85 px-3 pb-4 pt-16 backdrop-blur-sm md:p-6"
      )}
      onClick={onClose}
      onTouchStart={(e) => {
        const p = e.touches[0];
        swipeRef.current = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY } : null;
      }}
      onTouchEnd={(e) => {
        // Horizontal swipe = previous / next (not while zoomed: that's panning).
        const s = swipeRef.current;
        const p = e.changedTouches[0];
        swipeRef.current = null;
        if (!s || !p || zoom) return;
        const dx = p.clientX - s.x;
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(p.clientY - s.y) * 1.5) return;
        if (dx < 0 && hasNext) next();
        else if (dx > 0 && hasPrev) prev();
      }}
    >
      {/* Top bar: counter + actions + close. */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 px-3 py-3 sm:px-4" onClick={(e) => e.stopPropagation()}>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium tabular-nums text-white">
          {t("gallery.counter", { i: index + 1, n: total })}
        </span>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Editing tools: a dropdown of the tools for this item. */}
          {current.name && onTool && (
            <div className="relative">
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-neutral-900 shadow-lg transition hover:bg-white/90 [&_svg]:size-4",
                  editOpen && "bg-white/85"
                )}
                title={t("tools.edit")}
                aria-label={t("tools.edit")}
                aria-expanded={editOpen}
                onClick={() => setEditOpen((o) => !o)}
              >
                <Wand2 />
                <span className="text-sm font-semibold max-sm:hidden">{t("tools.edit")}</span>
                <ChevronDown className="max-sm:hidden" />
              </button>
              {editOpen && (
                <div
                  role="menu"
                  // Phones: pinned under the top bar across the screen — hung off
                  // the button, a 18rem menu runs off the left edge.
                  className="animate-in fade-in zoom-in-95 absolute right-0 top-full z-20 mt-2 max-h-[70vh] w-72 overflow-y-auto max-sm:fixed max-sm:inset-x-3 max-sm:top-14 max-sm:mt-0 max-sm:w-auto rounded-xl border border-white/15 bg-neutral-900/95 p-1 shadow-2xl backdrop-blur"
                >
                  <ToolMenuList
                    dark
                    kind={current.kind ?? (isVideoSrc(src) ? "video" : "image")}
                    onPick={(id, mode) => {
                      setEditOpen(false);
                      onTool(id, current, mode);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <div className={group}>
          {/* img2img needs an image source — hidden for videos. */}
          {!isVideoSrc(src) && (
            <button type="button" className={iconBtn} title={t("gallery.ctxUseAsSource")} aria-label={t("gallery.ctxUseAsSource")} onClick={() => onUseAsSource(current.getSrc)}>
              <ImageIcon />
            </button>
          )}
          {meta?.prompt && (
            <button type="button" className={iconBtn} title={t("gallery.ctxReuse")} aria-label={t("gallery.ctxReuse")} onClick={() => onReuseSettings(meta)}>
              <RotateCcw />
            </button>
          )}
          {meta?.prompt && (
            <button type="button" className={iconBtn} title={t("gallery.ctxCopyPrompt")} aria-label={t("gallery.ctxCopyPrompt")} onClick={() => void navigator.clipboard?.writeText(meta.prompt).catch(() => {})}>
              <Copy />
            </button>
          )}
          {current.savedPath && !isWeb && (
            <button type="button" className={iconBtn} title={t("gallery.ctxReveal")} aria-label={t("gallery.ctxReveal")} onClick={() => void api.revealInFolder(current.savedPath!).catch(() => {})}>
              <FolderOpen />
            </button>
          )}
          </div>
          {current.name && (
            <div className={group}>
              <button type="button" className={cn(iconBtn, "hover:bg-destructive/80")} title={t("gallery.ctxDelete")} aria-label={t("gallery.ctxDelete")} onClick={() => onDelete(current.name!)}>
                <Trash2 />
              </button>
            </div>
          )}
          <div className={group}>
          <button
            type="button"
            className={iconBtn}
            title={full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
            aria-label={full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
            onClick={() => setFull((f) => !f)}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button type="button" className={iconBtn} title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
            <X />
          </button>
          </div>
        </div>
      </div>

      {/* Prev / next edge arrows. */}
      {hasPrev && (
        <button type="button" className={cn(navBtn, "absolute left-4 top-1/2 z-10 -translate-y-1/2 pointer-coarse:hidden")} aria-label={t("gallery.prev")} onClick={(e) => { e.stopPropagation(); prev(); }}>
          <ChevronLeft className="size-6" />
        </button>
      )}
      {hasNext && (
        <button type="button" className={cn(navBtn, "absolute right-4 top-1/2 z-10 -translate-y-1/2 pointer-coarse:hidden")} aria-label={t("gallery.next")} onClick={(e) => { e.stopPropagation(); next(); }}>
          <ChevronRight className="size-6" />
        </button>
      )}

      <div
        className={cn(
          "flex w-full flex-col items-center",
          full
            ? "h-full max-w-none gap-0"
            : "max-h-full max-w-6xl gap-4 max-md:overflow-y-auto md:flex-row md:items-center"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden max-md:flex-none md:w-auto">
          {loading && !src && (
            // A dimensioned placeholder (from the known aspect) so the frame
            // doesn't jump when the full image resolves.
            <div
              className="skeleton max-h-[85vh] w-full max-w-[80vmin] rounded-xl bg-white/10"
              style={{ aspectRatio: lightboxAspect }}
            >
              <Loader2 className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />
            </div>
          )}
          {src &&
            (isVideoSrc(src) ? (
              // Video result (WAN): native controls, autoplay+loop, no magnifier
              // (zoom is an image affordance). Click falls through to the video's
              // own controls, so stop propagation to keep the overlay open.
              <video
                src={src}
                controls
                autoPlay
                loop
                playsInline
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "animate-in fade-in zoom-in-95 min-h-0 object-contain",
                  full ? "max-h-dvh max-w-full" : "max-h-[65dvh] rounded-xl shadow-2xl md:max-h-[85vh]"
                )}
              />
            ) : (
              <img
                src={src}
                alt=""
                draggable={false}
                onClick={(e) => { e.stopPropagation(); setZoom((z) => !z); }}
                onMouseMove={(e) => {
                  if (!zoom) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`);
                }}
                onMouseLeave={() => setOrigin("50% 50%")}
                style={{ transformOrigin: origin, transform: zoom ? "scale(2)" : "scale(1)", ["--ar" as string]: lightboxAspect }}
                className={cn(
                  "animate-in fade-in zoom-in-95 min-h-0 object-contain transition-transform duration-150",
                  // Fullscreen: edge-to-edge, no frame. Otherwise: framed, and as
                  // large as the window allows (a small file is scaled up too).
                  full ? "max-h-dvh max-w-full" : "lightbox-img max-h-[65dvh] rounded-xl shadow-2xl",
                  zoom ? "cursor-zoom-out" : "cursor-zoom-in"
                )}
              />
            ))}
        </div>
        {!full && meta && <MetaPanel meta={meta} />}
      </div>

      {/* Keyboard-hint footer — discoverable navigation + zoom affordance. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center pointer-coarse:hidden">
        <div className="flex items-center gap-3 rounded-full bg-white/10 px-3 py-1 text-2xs text-white/70 backdrop-blur">
          {total > 1 && (
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-white/15 px-1">←</kbd>
              <kbd className="rounded bg-white/15 px-1">→</kbd>
              {t("gallery.lbNav")}
            </span>
          )}
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-white/15 px-1">F</kbd>
            {full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-white/15 px-1">Esc</kbd>
            {t("common.close")}
          </span>
          <span className="hidden sm:inline">{t("gallery.lbZoom")}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function formatCreated(iso: string | undefined, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ").slice(0, 19);
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function MetaPanel({ meta }: { meta: GenerationMeta }) {
  const { t, i18n } = useTranslation();
  const rows: [string, string][] = [];
  const add = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "" && v !== 0) rows.push([k, String(v)]);
  };
  add(t("meta.model"), meta.modelName || meta.modelCode);
  add(t("meta.engine"), meta.engine ? (ENGINE_LABEL[meta.engine] ?? meta.engine) : "");
  add(t("meta.source"), meta.source === "local" || meta.source === "cloud" ? t(`mode.${meta.source}`) : meta.source);
  add(t("meta.size"), meta.width && meta.height ? `${meta.width}×${meta.height}` : "");
  add(t("meta.format"), meta.formatCode);
  add(t("meta.steps"), meta.numSteps);
  add(t("meta.cfg"), meta.guidanceScale);
  add(t("meta.scheduler"), meta.scheduler);
  add(t("meta.clipSkip"), meta.clipSkip);
  add(t("meta.seed"), meta.seed);
  if (meta.img2img) add(t("meta.img2img"), t("meta.strength", { strength: meta.strength ?? "" }));
  add(t("meta.loras"), (meta.loras ?? []).map((l) => `${l.name || l.path} (${l.weight})`).join(", "));
  if (meta.tool) {
    add(t("meta.tool"), t(`tools.names.${meta.tool}`, { defaultValue: meta.tool }));
    add(t("meta.ranOn"), meta.ranOn ? t(`tools.mode.${meta.ranOn}`) : "");
    add(t("meta.sourceImage"), meta.sourceImage);
  }
  add(t("meta.created"), formatCreated(meta.createdAt, i18n.language));

  return (
    <div className="bg-popover/95 text-popover-foreground flex w-full shrink-0 flex-col gap-4 overflow-y-auto rounded-2xl border p-5 text-sm shadow-2xl backdrop-blur md:max-h-[calc(100dvh-8rem)] md:w-80">
      {meta.prompt && (
        <div>
          <div className="ds-label mb-1">{t("meta.prompt")}</div>
          <p className="leading-relaxed">{meta.prompt}</p>
        </div>
      )}
      {meta.negativePrompt && (
        <div>
          <div className="ds-label mb-1">{t("meta.negative")}</div>
          <p className="text-muted-foreground leading-relaxed">{meta.negativePrompt}</p>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t pt-4 text-xs">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-medium tabular-nums" title={v}>{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
