// The gallery: filters, masonry tiles, selection, context menu.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { modLabel } from "@/components/CommandPalette";
import { ToolMenuList } from "@/components/ToolBits";
import type { ToolSource } from "@/components/ToolEditor";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { scrollRootOf } from "@/lib/engines";
import { GALLERY_CHANGED_EVENT, isWeb } from "@/lib/target";
import type { GalleryFacets, GalleryFilter, GenerationMeta, Job, SavedImage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import { Segmented } from "@/components/ds";
import {
  Check,
  Copy,
  FolderOpen,
  ImageIcon,
  LayoutGrid,
  Maximize2,
  RotateCcw,
  Search,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lightbox } from "./Lightbox";
import { isVideoSrc, tileClickGuard } from "./shared";

// ---------------------------------------------------------------------------
// Gallery — this session's finished generations + the saved-image history, in
// an aspect-aware masonry (any format). Adjustable columns, infinite scroll
// over the saved history, click-to-fullscreen, and delete. In-flight jobs live
// in the Activity panel, not here.
// ---------------------------------------------------------------------------

export const GALLERY_PAGE = 24;

export const EMPTY_FILTER: GalleryFilter = { engine: "", modelCode: "", source: "", text: "" };

export type LightboxItem = { src: string; meta?: GenerationMeta | null };

// One image in the gallery's viewable sequence — the unit the lightbox steps
// through and every action targets. `name` (a filename) keys delete/reveal; it's
// null for a session job not yet written to disk.
export type ViewerItem = {
  name: string | null;
  savedPath?: string;
  meta?: GenerationMeta | null;
  /** "video" hides image-only actions (img2img) in the menu/lightbox. */
  kind?: string;
  getSrc: () => Promise<string>;
};

// What a tile hands to the context menu. Adds the tile's position in the viewer
// sequence so "Open" can jump straight there.
export type TileTarget = ViewerItem & { index: number };

// Shared gallery behaviors handed to every tile (open, context menu, selection,
// drag). `index` is the tile's position in the viewer sequence.
export type GalleryShared = {
  openAt: (index: number) => void;
  openMenu: (e: React.MouseEvent, target: TileTarget) => void;
  selectionActive: boolean;
  isSelected: (name: string) => boolean;
  tileClick: (e: React.MouseEvent, name: string | null, index: number) => void;
  toggle: (name: string | null, index: number) => void;
  startImageDrag: (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null, name?: string | null) => void;
  /**
   * The one tile allowed to play sound, by file name (null = the whole grid is
   * muted). Video tiles autoplay muted and looping, so without a single owner an
   * unmuted grid would be pure cacophony.
   */
  audibleName: string | null;
  toggleAudible: (name: string) => void;
};

// Basename of a saved path, for matching a session job to its file on disk.
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function Gallery({
  jobs,
  toolOutputs,
  onUseAsSource,
  onImageDragStart,
  onReuseSettings,
  onHideJob,
  onOpenTool,
}: {
  jobs: Job[];
  /** Gallery files written by tool runs (Activity jobs): pulled into the grid. */
  toolOutputs: string[];
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onImageDragStart: (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null, name?: string | null) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onHideJob: (id: string) => void;
  /** Open an item in the Edit panel. */
  onOpenTool: (toolId: string, source: ToolSource, maskMode?: "select") => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<SavedImage[]>([]);
  const [done, setDone] = useState(false);
  // Mirrors `done` for loadMore: the reset below clears both, then loads at once
  // — reading the state there saw the stale `true` of a fully loaded gallery,
  // so the reload waited for the bottom of the gallery to scroll into view.
  const doneRef = useRef(false);
  const [loading, setLoading] = useState(false);
  // Two columns on a phone (three leaves ~110px thumbnails), three otherwise.
  const [cols, setCols] = useState(() => (window.innerWidth < 640 ? 2 : 3));
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_FILTER);
  const [facets, setFacets] = useState<GalleryFacets | null>(null);
  // Multi-selection (keyed by filename), the context menu, and the fullscreen
  // viewer (an index into the viewable sequence, or null when closed).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; target: TileTarget } | null>(null);
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  // At most one tile plays sound at a time — unmuting one mutes whichever had it.
  const [audibleName, setAudibleName] = useState<string | null>(null);
  const anchorRef = useRef<number | null>(null); // last-toggled index, for Shift-range
  const viewItemsRef = useRef<ViewerItem[]>([]); // the viewable sequence, in display order
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false); // guards against overlapping page loads
  const savedRef = useRef<SavedImage[]>([]);
  savedRef.current = saved;
  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;
  // Disk-pagination offset, tracked separately from `saved.length` because we
  // also PREPEND freshly-generated images (below) — using saved.length as the
  // offset would then skip disk rows.
  const diskCountRef = useRef(0);
  // Session jobs already folded into `saved`, so we don't merge them twice.
  const mergedRef = useRef<Set<string>>(new Set());

  const refreshFacets = useCallback(() => {
    void api.galleryFacets().then(setFacets).catch(() => {});
  }, []);
  useEffect(refreshFacets, [refreshFacets]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    api
      .listSavedImages(diskCountRef.current, GALLERY_PAGE, filter)
      .then((page) => {
        diskCountRef.current += page.length;
        setSaved((cur) => {
          const seen = new Set(cur.map((x) => x.name));
          return [...cur, ...page.filter((p) => !seen.has(p.name))];
        });
        if (page.length < GALLERY_PAGE) {
          doneRef.current = true;
          setDone(true);
        }
      })
      .catch(() => {
        doneRef.current = true;
        setDone(true);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [filter]);

  // Web: the gallery moved (folder picked / access granted) → reload in place.
  const [location, setLocation] = useState(0);
  useEffect(() => {
    if (!isWeb) return;
    const onChange = () => {
      setLocation((n) => n + 1);
      refreshFacets();
    };
    window.addEventListener(GALLERY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(GALLERY_CHANGED_EVENT, onChange);
  }, [refreshFacets]);

  // Initial load + reset-and-reload whenever the filter (or, web, the
  // gallery's location) changes.
  useEffect(() => {
    savedRef.current = [];
    diskCountRef.current = 0;
    setSaved([]);
    doneRef.current = false;
    setDone(false);
    loadingRef.current = false;
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, location]);

  // Fold freshly-finished session generations into the gallery as real saved
  // images (the Activity panel already covers live progress, so the gallery no
  // longer shows transient session tiles). Prepended newest-first with their
  // in-memory bytes so they appear instantly; a later disk page dedupes them.
  useEffect(() => {
    const fresh: SavedImage[] = [];
    for (const j of jobs) {
      if (mergedRef.current.has(j.id)) continue;
      const img = j.image;
      if (!img?.savedPath) continue; // save failed → only visible in Activity
      mergedRef.current.add(j.id);
      const m = img.meta;
      fresh.push({
        name: baseName(img.savedPath),
        kind: isVideoSrc(img.imageBase64) ? "video" : "image",
        source: img.source,
        seed: img.seed ?? m?.seed ?? 0,
        savedPath: img.savedPath,
        width: m?.width ?? 0,
        height: m?.height ?? 0,
        meta: m,
        src: img.imageBase64,
      });
    }
    if (fresh.length) {
      setSaved((cur) => {
        const seen = new Set(cur.map((s) => s.name));
        const add = fresh.filter((s) => !seen.has(s.name)).reverse();
        return add.length ? [...add, ...cur] : cur;
      });
    }
  }, [jobs]);

  // Infinite scroll: load the next page as the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0]?.isIntersecting) loadMore();
      },
      { root: scrollRootOf(el), rootMargin: "800px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done]);

  // Hide session job-tiles whose on-disk file was just deleted (so the deleted
  // image doesn't linger as a fresh tile).
  const hideJobsFor = useCallback(
    (names: Set<string>) => {
      for (const j of jobsRef.current) {
        const n = j.image?.savedPath ? baseName(j.image.savedPath) : null;
        if (n && names.has(n)) onHideJob(j.id);
      }
    },
    [onHideJob]
  );

  const deleteNames = useCallback(
    (names: string[]) => {
      if (names.length === 0) return;
      void Promise.allSettled(names.map((n) => api.deleteSavedImage(n))).then(() => {
        const set = new Set(names);
        setSaved((s) => s.filter((x) => !set.has(x.name)));
        setSelected((cur) => {
          const next = new Set(cur);
          names.forEach((n) => next.delete(n));
          return next;
        });
        hideJobsFor(set);
        refreshFacets();
        toast.toast(t("toast.deleted", { count: names.length }));
      });
    },
    [hideJobsFor, refreshFacets, toast, t]
  );

  const deleteOne = useCallback(
    async (name: string) => {
      const ok = await confirm({
        title: t("gallery.deleteTitle", { count: 1 }),
        description: t("gallery.deleteConfirm", { name }),
        confirmLabel: t("gallery.deleteAction"),
        cancelLabel: t("common.cancel"),
      });
      if (ok) deleteNames([name]);
    },
    [deleteNames, confirm, t]
  );

  const deleteSelected = useCallback(async () => {
    const names = [...selected];
    if (names.length === 0) return;
    const ok = await confirm({
      title: t("gallery.deleteTitle", { count: names.length }),
      description: t("gallery.deleteSelectedConfirm", { count: names.length }),
      confirmLabel: t("gallery.deleteAction"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) deleteNames(names);
  }, [selected, deleteNames, confirm, t]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Open an editing tool on a gallery item, in the Edit panel (closes the
  // viewer, which would cover it).
  const openTool = useCallback(
    (toolId: string, target: ViewerItem, maskMode?: "select") => {
      setViewIndex(null);
      setMenu(null);
      onOpenTool(toolId, { name: target.name, kind: target.kind, meta: target.meta, getSrc: target.getSrc }, maskMode);
    },
    [onOpenTool]
  );

  // Tool outputs are already on disk: pull their gallery rows (with metadata)
  // and prepend them.
  const addSavedOutputs = useCallback(
    (names: string[]) => {
      const want = new Set(names);
      void api
        .listSavedImages(0, Math.max(GALLERY_PAGE, names.length + 4), EMPTY_FILTER)
        .then((page) => {
          const fresh = page.filter((p) => want.has(p.name));
          if (!fresh.length) return;
          diskCountRef.current += fresh.length;
          setSaved((cur) => {
            const seen = new Set(cur.map((x) => x.name));
            const add = fresh.filter((f) => !seen.has(f.name));
            return add.length ? [...add, ...cur] : cur;
          });
        })
        .catch(() => {});
      refreshFacets();
    },
    [refreshFacets]
  );

  // Tool runs finish in Activity: pull each new output into the grid once.
  const toolMergedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = toolOutputs.filter((n) => !toolMergedRef.current.has(n));
    if (!fresh.length) return;
    fresh.forEach((n) => toolMergedRef.current.add(n));
    addSavedOutputs(fresh);
  }, [toolOutputs, addSavedOutputs]);

  const openAt = useCallback((index: number) => {
    // The viewer plays its own audio: hand it a silent grid rather than two
    // soundtracks at once.
    setAudibleName(null);
    if (index >= 0) setViewIndex(index);
  }, []);

  // Unmute this tile (and mute the previous owner), or mute it if it's the one
  // already playing.
  const toggleAudible = useCallback(
    (name: string) => setAudibleName((cur) => (cur === name ? null : name)),
    []
  );

  // Toggle one tile's selection; remember it as the Shift-range anchor.
  const toggle = useCallback((name: string | null, index: number) => {
    if (!name) return;
    anchorRef.current = index;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Click on a tile: modifier-click selects (⌘/Ctrl toggles, Shift extends the
  // range from the anchor); a plain click opens the fullscreen viewer.
  const tileClick = useCallback(
    (e: React.MouseEvent, name: string | null, index: number) => {
      // A click that immediately followed a pointer image-drag isn't a real
      // click — swallow it so the lightbox doesn't open on drop.
      if (tileClickGuard.suppressed) return;
      if ((e.metaKey || e.ctrlKey) && name) {
        toggle(name, index);
        return;
      }
      if (e.shiftKey && name && anchorRef.current != null) {
        const [lo, hi] = [Math.min(anchorRef.current, index), Math.max(anchorRef.current, index)];
        const range = viewItemsRef.current
          .slice(lo, hi + 1)
          .map((v) => v.name)
          .filter((n): n is string => !!n);
        setSelected((cur) => new Set([...cur, ...range]));
        return;
      }
      openAt(index);
    },
    [toggle, openAt]
  );

  const openMenu = useCallback((e: React.MouseEvent, target: TileTarget) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  // Latest values for the once-subscribed keyboard listener.
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;
  const viewIndexRef = useRef(viewIndex);
  viewIndexRef.current = viewIndex;
  const menuRef = useRef(menu);
  menuRef.current = menu;

  // Keyboard: ⌘/Ctrl+A selects all, Delete removes the selection, Escape clears
  // it. Ignored while typing in a field, or when a modal (viewer/menu) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        const names = viewItemsRef.current.map((v) => v.name).filter((n): n is string => !!n);
        if (names.length) {
          e.preventDefault();
          setSelected(new Set(names));
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        setSelected((cur) => {
          if (cur.size > 0) {
            e.preventDefault();
            deleteSelectedRef.current();
          }
          return cur;
        });
      } else if (e.key === "Escape" && viewIndexRef.current == null && !menuRef.current) {
        setSelected((cur) => (cur.size > 0 ? new Set() : cur));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the open viewer valid when the sequence shrinks (e.g. after a delete):
  // clamp to the last item, or close if nothing is left.
  useEffect(() => {
    const n = viewItemsRef.current.length;
    setViewIndex((vi) => (vi != null && vi >= n ? (n > 0 ? n - 1 : null) : vi));
  }, [saved.length, jobs.length]);

  const filtered =
    filter.engine !== "" || filter.modelCode !== "" || filter.source !== "" || filter.text !== "";

  const shared: GalleryShared = {
    openAt,
    openMenu,
    selectionActive: selected.size > 0,
    isSelected: (name) => selected.has(name),
    tileClick,
    toggle,
    startImageDrag: onImageDragStart,
    audibleName,
    toggleAudible,
  };

  // Build the tile list + the parallel viewer sequence (same order) whose index
  // every tile, the menu, and the lightbox share. Tiles are spread across `cols`
  // columns round-robin so the reading order is LEFT-TO-RIGHT; each column stacks
  // at natural height → true masonry. Session generations are folded into `saved`
  // (see the merge effect), so the gallery is a single uniform stream.
  const tiles: { key: string; el: React.ReactElement }[] = [];
  const viewItems: ViewerItem[] = [];
  const pushView = (v: ViewerItem) => {
    viewItems.push(v);
    return viewItems.length - 1;
  };
  for (const g of saved) {
    const index = pushView({
      name: g.name,
      savedPath: g.savedPath || undefined,
      meta: g.meta,
      kind: g.kind,
      getSrc: () => (g.src ? Promise.resolve(g.src) : api.getSavedImage(g.name)),
    });
    tiles.push({ key: g.name, el: <SavedTile image={g} index={index} shared={shared} onDelete={deleteOne} /> });
  }
  viewItemsRef.current = viewItems;
  const columns: { key: string; el: React.ReactElement }[][] = Array.from({ length: cols }, () => []);
  tiles.forEach((t, i) => columns[i % cols].push(t));
  const empty = tiles.length === 0;
  // First page still loading → show a skeleton grid, not the "no images" empty
  // state (which used to flash before the first page arrived).
  const initialLoading = empty && loading;

  return (
    <div className="flex flex-col gap-3 pb-20">
      {/* Filters wrap among themselves; the column picker keeps its corner. */}
      <div className="flex items-start justify-between gap-2">
        <FilterBar facets={facets} filter={filter} onChange={setFilter} />
        <ColumnPicker cols={cols} onChange={setCols} />
      </div>

      {initialLoading ? (
        <GallerySkeleton cols={cols} />
      ) : empty ? (
        <div className="relative flex min-h-[60vh] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl text-center lg:min-h-[70vh]">
          <div className="canvas-glow pointer-events-none absolute inset-0" />
          {/* Three ghost tiles fanned behind the mark: the gallery-to-be. */}
          <div aria-hidden className="empty-fan relative mb-4 h-28 w-40">
            <span className="empty-fan-tile -rotate-[10deg] -translate-x-9" />
            <span className="empty-fan-tile rotate-[9deg] translate-x-9" />
            <span className="empty-fan-tile z-[1] flex items-center justify-center">
              <span className="brand-surface flex size-11 items-center justify-center rounded-xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
                <ImageIcon className="size-5" strokeWidth={1.75} />
              </span>
            </span>
          </div>
          <p className="text-foreground relative text-base font-semibold tracking-[-0.011em]">
            {filtered ? t("gallery.emptyFiltered") : t("gallery.empty")}
          </p>
          {!filtered && <p className="text-muted-foreground relative max-w-72 text-sm">{t("gallery.emptyHint", { keys: `${modLabel}↵` })}</p>}
          {filtered && (
            <button
              type="button"
              onClick={() => setFilter({ engine: "", modelCode: "", source: "", text: "" })}
              className="text-foreground hover:bg-muted relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
            >
              <X className="size-3.5" /> {t("gallery.clearFilters")}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {columns.map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
              {col.map((t) => (
                <div key={t.key}>{t.el}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      {!done && <div ref={sentinelRef} className="h-4 w-full" />}
      {/* Loading the NEXT page (not the first) → append a row of skeleton tiles. */}
      {loading && !initialLoading && <GallerySkeleton cols={cols} rows={1} />}

      {/* Floating selection bar. */}
      {selected.size > 0 && (
        <div className="animate-in fade-in slide-in-from-bottom-2 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-popover/95 px-2 py-2 pl-4 shadow-2xl backdrop-blur">
          <span className="text-sm font-medium tabular-nums">
            {t("gallery.selectedCount", { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={deleteSelected}
            className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <Trash2 className="size-3.5" /> {t("gallery.deleteSelected")}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            {t("gallery.clearSelection")}
          </button>
        </div>
      )}

      {menu && (
        <TileContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          onClose={() => setMenu(null)}
          onOpenAt={openAt}
          onUseAsSource={onUseAsSource}
          onReuseSettings={onReuseSettings}
          onDelete={deleteOne}
          onTool={openTool}
        />
      )}

      {viewIndex != null && viewItems[viewIndex] && (
        <Lightbox
          items={viewItems}
          index={viewIndex}
          onIndex={setViewIndex}
          onClose={() => setViewIndex(null)}
          onUseAsSource={onUseAsSource}
          onReuseSettings={onReuseSettings}
          onDelete={deleteOne}
          onTool={openTool}
        />
      )}
    </div>
  );
}

export function FilterBar({
  facets,
  filter,
  onChange,
}: {
  facets: GalleryFacets | null;
  filter: GalleryFilter;
  onChange: (f: GalleryFilter) => void;
}) {
  const { t } = useTranslation();
  const active =
    filter.engine !== "" || filter.modelCode !== "" || filter.source !== "" || filter.text !== "";
  // Guard against nil slices (Go marshals empty slices as null).
  const models = facets?.models ?? [];
  const engines = facets?.engines ?? [];
  const sources = facets?.sources ?? [];

  // Debounce the search box so typing doesn't reload the gallery per keystroke.
  const [q, setQ] = useState(filter.text);
  useEffect(() => setQ(filter.text), [filter.text]); // stay in sync on external Clear
  const commitRef = useRef<(text: string) => void>(() => {});
  commitRef.current = (text: string) => onChange({ ...filter, text });
  useEffect(() => {
    if (q === filter.text) return;
    const id = setTimeout(() => commitRef.current(q), 250);
    return () => clearTimeout(id);
  }, [q, filter.text]);

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="text-subtle pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("gallery.search")}
          aria-label={t("gallery.search")}
          className="ds-field h-8 w-36 pl-8 pr-2 text-xs sm:w-44"
        />
      </div>
      {models.length > 0 && (
        <FacetSelect
          label={t("gallery.filterModel")}
          value={filter.modelCode}
          facets={models}
          onChange={(v) => onChange({ ...filter, modelCode: v })}
        />
      )}
      {engines.length > 1 && (
        <FacetSelect
          label={t("gallery.filterEngine")}
          value={filter.engine}
          facets={engines}
          onChange={(v) => onChange({ ...filter, engine: v })}
        />
      )}
      {sources.length > 1 && (
        <FacetSelect
          label={t("gallery.filterSource")}
          value={filter.source}
          facets={sources}
          onChange={(v) => onChange({ ...filter, source: v })}
        />
      )}
      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-muted-foreground hover:text-foreground text-xs font-medium"
        >
          {t("common.clear")}
        </button>
      )}
    </div>
  );
}

export function FacetSelect({
  label,
  value,
  facets,
  onChange,
}: {
  label: string;
  value: string;
  facets: { value: string; label: string; count: number }[];
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select size="sm" value={value} onChange={onChange} className="max-w-40" aria-label={label}>
      <option value="">{t("gallery.filterAll", { label })}</option>
      {facets.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label} ({f.count})
        </option>
      ))}
    </Select>
  );
}

export function ColumnPicker({ cols, onChange }: { cols: number; onChange: (n: number) => void }) {
  const { t } = useTranslation();
  return (
    <Segmented
      label={t("gallery.columns", { count: cols })}
      value={cols}
      onChange={onChange}
      options={[1, 2, 3, 4].map((n) => ({ value: n, label: n, title: t("gallery.columns", { count: n }) }))}
      leading={<LayoutGrid className="text-subtle mx-1 size-3.5 shrink-0" aria-hidden />}
      className="h-8 shrink-0"
      itemClassName="h-[26px] min-w-[26px] px-1.5 tabular-nums"
    />
  );
}

// Masonry-shaped skeleton grid shown while a gallery page loads, so the layout
// is reserved instead of a bare spinner (no reflow when the images arrive).
export function GallerySkeleton({ cols, rows = 3 }: { cols: number; rows?: number }) {
  const ratios = [1, 1.3, 0.82, 1.15, 0.95, 1.25];
  return (
    <div className="flex items-start gap-3">
      {Array.from({ length: cols }).map((_, ci) => (
        <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
          {Array.from({ length: rows }).map((_, ri) => (
            <Skeleton
              key={ri}
              className="w-full rounded-xl"
              style={{ aspectRatio: ratios[(ci + ri * cols) % ratios.length] }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// A small selection checkbox overlaid on a tile — visible on hover or whenever a
// selection is in progress.
export function SelectCheckbox({
  checked,
  active,
  onToggle,
}: {
  checked: boolean;
  active: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
      aria-label={t("gallery.select")}
      aria-pressed={checked}
      className={cn(
        "absolute left-1.5 top-1.5 z-10 flex size-5 items-center justify-center rounded-md border-2 shadow-sm transition",
        checked
          ? "border-[var(--brand-to)] bg-[var(--brand-to)] text-white"
          : "border-white/85 bg-black/35 text-transparent hover:bg-black/50",
        active || checked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  );
}

// A saved image from the output folder. Bytes are fetched lazily (base64 over the
// Wails bridge) only when the tile scrolls into view; its aspect box is reserved
// from the known dimensions so the masonry lays out any format without jumps.
export function SavedTile({
  image,
  index,
  shared,
  onDelete,
}: {
  image: SavedImage;
  index: number;
  shared: GalleryShared;
  onDelete: (name: string) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  // Freshly-merged images carry their bytes in memory (image.src) → render at
  // once, no disk read; folder images fetch lazily on scroll-in.
  const [src, setSrc] = useState<string | null>(image.src ?? null);
  const srcRef = useRef<string | null>(src);
  srcRef.current = src;
  // Mirrors `audible` (computed below) for the release observer, which must not
  // unload the tile the user is listening to.
  const audibleRef = useRef(false);

  // Whether the tile is actually on screen — drives playback, not loading.
  const [onScreen, setOnScreen] = useState(false);

  // Three bands, because loading, keeping and playing are three questions.
  //
  // Bytes arrive over the bridge as a base64 data URL, so a loaded tile costs
  // its file size (+⅓ for base64) in the JS heap for as long as it stays
  // loaded — and the gallery mounts every tile it has ever paged in. Worse for
  // video: `autoPlay loop` decodes forever, on screen or not, so a long scroll
  // used to leave dozens of clips looping behind the viewport.
  //
  // Load at 400px (ready before it's seen), release past 1200px (hysteresis, so
  // a tile parked near the edge doesn't thrash), play only when visible.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const load = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && !srcRef.current) {
          void api.getSavedImage(image.name).then(setSrc).catch(() => {});
        }
      },
      { root: scrollRootOf(el), rootMargin: "400px" }
    );
    const release = new IntersectionObserver(
      ([e]) => {
        // Never drop the tile currently playing sound: the user picked it, and
        // it keeps playing off screen on purpose.
        if (!e?.isIntersecting && srcRef.current && !audibleRef.current) setSrc(null);
      },
      { root: scrollRootOf(el), rootMargin: "1200px" }
    );
    const visible = new IntersectionObserver(([e]) => setOnScreen(!!e?.isIntersecting));

    load.observe(el);
    release.observe(el);
    visible.observe(el);
    return () => {
      load.disconnect();
      release.disconnect();
      visible.disconnect();
    };
  }, [image.name]);

  const aspect = image.width > 0 && image.height > 0 ? image.width / image.height : 1;
  const selected = shared.isSelected(image.name);
  const isVideo = image.kind === "video" || isVideoSrc(src);
  const audible = isVideo && shared.audibleName === image.name;
  // `muted` is a DOM property, not just an attribute: set it on the element
  // itself rather than trusting the JSX prop to re-apply on every toggle. The
  // play() nudge covers a browser that pauses a clip when it gains sound (the
  // click that got us here is the gesture that permits it).
  const videoRef = useRef<HTMLVideoElement>(null);
  audibleRef.current = audible;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !audible;
    // Decode only what's being watched. A muted clip behind the viewport is
    // pure GPU/CPU burn — the one exception is the tile the user unmuted, which
    // keeps playing so its sound doesn't cut out mid-scroll.
    if (onScreen || audible) void v.play().catch(() => {});
    else v.pause();
  }, [audible, onScreen, src]);

  // Ensure the bytes are available (img2img / drag from an un-scrolled tile).
  const ensureSrc = () => (srcRef.current ? Promise.resolve(srcRef.current) : api.getSavedImage(image.name).then((d) => { setSrc(d); return d; }));

  return (
    <figure
      ref={ref}
      // Pointer-based drag (not native HTML5) → reliable in WKWebView. A move
      // past threshold starts the img2img drag; a plain click still opens the
      // tile. Videos can't seed img2img → no drag affordance for them.
      onPointerDown={(e) => {
        // A finger moving over a tile is a scroll, not a drag: on touch, img2img
        // goes through the viewer's "use as source" instead.
        if (e.pointerType === "touch") return;
        if (image.kind === "video" || isVideoSrc(srcRef.current)) return;
        shared.startImageDrag(e, ensureSrc, srcRef.current, image.name);
      }}
      className={cn(
        "rise-in group bg-muted/40 relative cursor-zoom-in overflow-hidden rounded-xl ring-1 transition-[box-shadow,transform] duration-200 ease-[var(--im-ease-out)] hover:-translate-y-0.5 hover:shadow-lg",
        selected ? "ring-2 ring-[var(--brand-to)]" : "ring-border"
      )}
      title={image.name}
      // Capped, repeating stagger so a page of tiles cascades in without long
      // delays on later pages (infinite scroll).
      style={{ aspectRatio: aspect, animationDelay: `${(index % 10) * 30}ms` }}
      onClick={(e) => shared.tileClick(e, image.name, index)}
      onContextMenu={(e) =>
        shared.openMenu(e, {
          index,
          name: image.name,
          savedPath: image.savedPath || undefined,
          meta: image.meta,
          kind: image.kind,
          getSrc: ensureSrc,
        })
      }
    >
      {src ? (
        isVideo ? (
          // Looping inline preview — the tile IS the thumbnail. It starts muted
          // (autoplay demands it) and the speaker button below can hand it the
          // grid's single audio slot. Playback controls live in the lightbox;
          // the tile stays a simple click target.
          <video
            ref={videoRef}
            src={src}
            muted={!audible}
            loop
            autoPlay
            playsInline
            draggable={false}
            className="animate-in fade-in h-full w-full object-cover duration-300"
          />
        ) : (
          // draggable=false: an <img> is natively draggable, which would start a
          // browser image-drag and cancel our pointer-based img2img drag.
          <img
            src={src}
            alt={image.name}
            draggable={false}
            className="animate-in fade-in h-full w-full object-cover duration-300"
          />
        )
      ) : (
        <Skeleton className="h-full w-full rounded-none" />
      )}
      <SelectCheckbox
        checked={selected}
        active={shared.selectionActive}
        onToggle={() => shared.toggle(image.name, index)}
      />
      {/* Tile actions, clustered so nothing lands on the selection box in the
          opposite corner. Sound stays visible on a video (it's state, not just an
          action: it tells you which tile you're hearing); delete is hover-only. */}
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
        {isVideo && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              shared.toggleAudible(image.name);
            }}
            aria-label={audible ? t("gallery.mute") : t("gallery.unmute")}
            aria-pressed={audible}
            title={audible ? t("gallery.mute") : t("gallery.unmute")}
            className={cn(
              "rounded-full p-1.5 text-white transition",
              audible
                ? "bg-[var(--brand-to)] hover:brightness-110"
                : "bg-black/50 opacity-0 hover:bg-black/70 group-hover:opacity-100"
            )}
          >
            {audible ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(image.name);
          }}
          aria-label={t("gallery.deleteImage")}
          className="hidden rounded-full bg-black/50 p-1.5 text-white hover:bg-red-600/80 group-hover:block"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {image.source && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-1.5 py-0.5 font-medium capitalize">
            {image.source === "tool" && <Wand2 className="size-2.5" />}
            {image.source === "tool" && image.meta?.tool
              ? t(`tools.names.${image.meta.tool}`, { defaultValue: image.meta.tool })
              : image.source}
          </span>
        )}
        {image.seed > 0 && <span className="tabular-nums">{t("gallery.seed", { seed: image.seed })}</span>}
      </figcaption>
    </figure>
  );
}

// TileContextMenu — a small right-click menu positioned at the cursor. A
// full-screen backdrop captures the next click (and Escape) to dismiss.
export function TileContextMenu({
  x,
  y,
  target,
  onClose,
  onOpenAt,
  onUseAsSource,
  onReuseSettings,
  onDelete,
  onTool,
}: {
  x: number;
  y: number;
  target: TileTarget;
  onClose: () => void;
  onOpenAt: (index: number) => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onDelete: (name: string) => void;
  onTool: (toolId: string, target: ViewerItem, maskMode?: "select") => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clamp so the menu stays on screen (approx sizes; good enough without measuring).
  const W = 268;
  const H = Math.min(window.innerHeight - 16, 640);
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);
  const meta = target.meta;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="animate-in fade-in zoom-in-95 bg-popover absolute overflow-y-auto rounded-xl border p-1 shadow-2xl duration-100"
        style={{ left, top, width: W, maxHeight: H }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        <MenuItem
          icon={<Maximize2 />}
          label={t("gallery.ctxOpen")}
          onClick={run(() => onOpenAt(target.index))}
        />
        {target.kind !== "video" && (
          <MenuItem
            icon={<ImageIcon />}
            label={t("gallery.ctxUseAsSource")}
            onClick={run(() => onUseAsSource(target.getSrc))}
          />
        )}
        {meta?.prompt && (
          <MenuItem
            icon={<RotateCcw />}
            label={t("gallery.ctxReuse")}
            onClick={run(() => onReuseSettings(meta))}
          />
        )}
        {meta?.prompt && (
          <MenuItem
            icon={<Copy />}
            label={t("gallery.ctxCopyPrompt")}
            onClick={run(() => void navigator.clipboard?.writeText(meta.prompt).catch(() => {}))}
          />
        )}
        {target.savedPath && !isWeb && (
          <MenuItem
            icon={<FolderOpen />}
            label={t("gallery.ctxReveal")}
            onClick={run(() => void api.revealInFolder(target.savedPath!).catch(() => {}))}
          />
        )}
        {target.name && (
          <>
            <div className="bg-border/70 my-1 h-px" />
            <div className="ds-label px-2.5 pb-0.5 pt-1">
              {t("tools.edit")}
            </div>
            <ToolMenuList kind={target.kind} onPick={(id, mode) => { onTool(id, target, mode); onClose(); }} />
          </>
        )}
        {target.name && (
          <>
            <div className="bg-border/70 my-1 h-px" />
            <MenuItem
              icon={<Trash2 />}
              label={t("gallery.ctxDelete")}
              destructive
              onClick={run(() => onDelete(target.name!))}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors [&_svg]:size-4",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-accent"
      )}
    >
      <span className={cn("shrink-0", destructive ? "" : "text-muted-foreground")}>{icon}</span>
      {label}
    </button>
  );
}
