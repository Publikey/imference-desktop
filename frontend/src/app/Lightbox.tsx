// Full-screen viewer with generation details.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { ToolMenuList } from "@/components/ToolBits";
import { ENGINE_LABEL } from "@/lib/engines";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { isWeb } from "@/lib/target";
import type { GenerationMeta } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownLeft,
  FolderOpen,
  ImageIcon,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Star,
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
  onReusePrompt,
  onDelete,
  onTool,
}: {
  items: ViewerItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onReusePrompt: (prompt: string) => void;
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
  // The details panel (prompt, actions, parameters) beside the image; folded
  // away with I, and remembered, for those who only want to look.
  const [details, setDetails] = useState(() => {
    try {
      return localStorage.getItem(DETAILS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleDetails = useCallback(() => {
    setDetails((d) => {
      try {
        localStorage.setItem(DETAILS_KEY, d ? "0" : "1");
      } catch {
        /* not remembered */
      }
      return !d;
    });
  }, []);
  const favorites = useFavorites();

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
      else if (e.key === "i" || e.key === "I") toggleDetails();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next, editOpen, toggleDetails]);

  if (!current) return null;
  const meta = current.meta;
  const fav = !!current.name && favorites.has(current.name);
  const isVideo = current.kind === "video" || isVideoSrc(src);
  // Labeled actions, right under the prompt in the details panel: what to do
  // with this image, in words rather than a row of icons to decode.
  const actions: { key: string; icon: React.ReactNode; label: string; run: () => void }[] = [];
  if (meta?.prompt) {
    actions.push({ key: "reuse", icon: <RotateCcw />, label: t("gallery.ctxReuse"), run: () => onReuseSettings(meta) });
    actions.push({ key: "prompt", icon: <CornerDownLeft />, label: t("gallery.ctxReusePrompt"), run: () => onReusePrompt(meta.prompt) });
  }
  if (!isVideo) actions.push({ key: "ref", icon: <ImageIcon />, label: t("gallery.ctxUseAsSource"), run: () => onUseAsSource(current.getSrc) });
  if (meta?.prompt)
    actions.push({ key: "copy", icon: <Copy />, label: t("gallery.ctxCopyPrompt"), run: () => void navigator.clipboard?.writeText(meta.prompt).catch(() => {}) });
  if (current.savedPath && !isWeb)
    actions.push({ key: "reveal", icon: <FolderOpen />, label: t("gallery.ctxReveal"), run: () => void api.revealInFolder(current.savedPath!).catch(() => {}) });
  const showPanel = !full && details && (!!meta || actions.length > 0);

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
          {/* The image's own state and the destructive action, apart from the
              labeled actions in the details panel. */}
          {current.name && (
            <div className={group}>
              <button
                type="button"
                className={iconBtn}
                title={fav ? t("gallery.unfavorite") : t("gallery.favorite")}
                aria-label={fav ? t("gallery.unfavorite") : t("gallery.favorite")}
                aria-pressed={fav}
                onClick={() => toggleFavorite(current.name!)}
              >
                <Star className={cn(fav && "fill-amber-300 text-amber-300")} />
              </button>
              <button type="button" className={cn(iconBtn, "hover:bg-destructive/80")} title={t("gallery.ctxDelete")} aria-label={t("gallery.ctxDelete")} onClick={() => onDelete(current.name!)}>
                <Trash2 />
              </button>
            </div>
          )}
          <div className={group}>
          {!full && (
            <button
              type="button"
              className={cn(iconBtn, details && "bg-white/15 text-white")}
              title={details ? t("gallery.hideDetails") : t("gallery.showDetails")}
              aria-label={details ? t("gallery.hideDetails") : t("gallery.showDetails")}
              aria-pressed={details}
              onClick={toggleDetails}
            >
              <Info />
            </button>
          )}
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
            : cn(
                "max-h-full max-w-6xl gap-3 max-md:overflow-y-auto md:flex-row md:justify-center",
                // With the panel: both columns share one height, so the panel
                // reads as the image's caption rather than a card adrift.
                showPanel ? "md:items-stretch" : "md:items-center"
              )
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn("relative flex min-h-0 w-full items-center justify-center overflow-hidden max-md:flex-none md:w-auto", showPanel ? "md:flex-none" : "flex-1")}>
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
        {showPanel && <MetaPanel meta={meta ?? null} actions={actions} />}
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
          {!full && (
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-white/15 px-1">I</kbd>
              {t("gallery.lbDetails")}
            </span>
          )}
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

const DETAILS_KEY = "imference.lightbox.details";

function formatCreated(iso: string | undefined, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ").slice(0, 19);
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function MetaPanel({
  meta,
  actions = [],
}: {
  meta: GenerationMeta | null;
  actions?: { key: string; icon: React.ReactNode; label: string; run: () => void }[];
}) {
  const { t, i18n } = useTranslation();
  const rows: [string, string][] = [];
  const add = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "" && v !== 0) rows.push([k, String(v)]);
  };
  if (!meta) return <ActionList actions={actions} standalone />;
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
      {actions.length > 0 && <ActionList actions={actions} />}
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

// The viewer's actions as a labeled list: in the details panel under the
// prompt, or alone when the image has no metadata.
function ActionList({
  actions,
  standalone,
}: {
  actions: { key: string; icon: React.ReactNode; label: string; run: () => void }[];
  standalone?: boolean;
}) {
  if (!actions.length) return null;
  return (
    <div
      className={cn(
        "grid gap-0.5",
        standalone
          ? "bg-popover/95 text-popover-foreground w-full shrink-0 self-center rounded-2xl border p-2 shadow-2xl backdrop-blur md:w-72"
          : "-mx-2 -my-1"
      )}
    >
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={a.run}
          className="text-foreground hover:bg-accent flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>
  );
}
