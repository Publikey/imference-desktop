// The gallery: filters, masonry tiles, selection, context menu.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { modLabel } from "@/components/CommandPalette";
import { ToolMenuList } from "@/components/ToolBits";
import type { ToolSource } from "@/components/ToolEditor";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { WebGalleryLocation } from "@/components/WebGallerySection";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { scrollRootOf } from "@/lib/engines";
import { GALLERY_CHANGED_EVENT, isWeb } from "@/lib/target";
import type { GalleryFacets, GalleryFilter, GenerationMeta, Job, SavedImage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import { useStuck } from "@/lib/sticky";
import { downloadFile } from "@/lib/download";
import { forgetFavorites, toggleFavorite, useFavorites } from "@/lib/favorites";
import { Kbd, Segmented } from "@/components/ds";
import {
  Check,
  CornerDownLeft,
  Copy,
  Dices,
  Download,
  FolderOpen,
  SlidersHorizontal,
  Sparkles,
  ImageIcon,
  Star,
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
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  isFavorite: (name: string) => boolean;
  /** Hover actions on a tile: the two moves people make most from an image. */
  reuseSettings: (meta: GenerationMeta) => void;
  useAsSource: (getSrc: () => Promise<string>) => void;
};

// Day buckets for the gallery's section headers: Today, Yesterday, earlier this
// week, then one per month ("October 2026"). Images without a date (pre-
// metadata files) fall in "Older". Consecutive tiles only: the order on disk is
// kept, a header just marks where the bucket changes.
function dayBucket(iso: string | undefined, now: Date, lang: string, t: (k: string) => string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return t("gallery.undated");
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return t("gallery.today");
  if (days === 1) return t("gallery.yesterday");
  if (days < 7) return t("gallery.thisWeek");
  return new Intl.DateTimeFormat(lang, {
    month: "long",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(d);
}

// Basename of a saved path, for matching a session job to its file on disk.
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function Gallery({
  jobs,
  toolOutputs,
  onUseAsSource,
  onImageDragStart,
  onReuseSettings,
  onReusePrompt,
  onReuseSeed,
  onUsePrompt,
  onHideJob,
  onOpenTool,
}: {
  jobs: Job[];
  /** Gallery files written by tool runs (Activity jobs): pulled into the grid. */
  toolOutputs: string[];
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onImageDragStart: (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null, name?: string | null) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  /** Load the prompt alone, keeping the current parameters. */
  onReusePrompt: (prompt: string) => void;
  /** Fix the seed for the next runs. */
  onReuseSeed: (seed: number) => void;
  /** An example prompt from the empty gallery, into Create. */
  onUsePrompt: (prompt: string) => void;
  onHideJob: (id: string) => void;
  /** Open an item in the Edit panel. */
  onOpenTool: (toolId: string, source: ToolSource, maskMode?: "select") => void;
}) {
  const { t, i18n } = useTranslation();
  const favorites = useFavorites();
  // Favorites only: a view over the loaded pages. Stars live in this window,
  // not in the files, so the filter can't go to the backend — it pages the
  // whole history in instead (names and metadata only; bytes stay lazy).
  const [favOnly, setFavOnly] = useState(false);
  const toolbar = useStuck("top");
  const toast = useToast();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<SavedImage[]>([]);
  const [done, setDone] = useState(false);
  // Mirrors `done` for loadMore: the reset below clears both, then loads at once
  // — reading the state there saw the stale `true` of a fully loaded gallery,
  // so the reload waited for the bottom of the gallery to scroll into view.
  const doneRef = useRef(false);
  const [loading, setLoading] = useState(false);
  // Two columns on a phone (three leaves ~110px thumbnails), three otherwise;
  // then whatever the user picked last, per device class.
  const colsKey = window.innerWidth < 640 ? "imference.gallery.cols.phone" : "imference.gallery.cols";
  const [cols, setColsState] = useState(() => {
    try {
      const v = Number(localStorage.getItem(colsKey));
      if (v >= 1 && v <= 4) return v;
    } catch {
      /* default below */
    }
    return window.innerWidth < 640 ? 2 : 3;
  });
  const setCols = useCallback(
    (n: number) => {
      setColsState(n);
      try {
        localStorage.setItem(colsKey, String(n));
      } catch {
        /* not remembered */
      }
    },
    [colsKey]
  );
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
  // Both: a cloud result saved again from the history (CloudHistoryDialog).
  const [location, setLocation] = useState(0);
  useEffect(() => {
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

  // Favorites only: keep paging until the whole history is in (the sentinel
  // can't drive it — a few starred tiles never reach the bottom).
  useEffect(() => {
    if (favOnly && !done && !loading) loadMore();
  }, [favOnly, done, loading, loadMore]);

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
        forgetFavorites(names);
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
  // Star the whole selection (or un-star it, when every one is already starred).
  const favoriteSelected = useCallback(() => {
    const names = [...selected];
    const all = names.every((n) => favorites.has(n));
    names.filter((n) => all || !favorites.has(n)).forEach(toggleFavorite);
  }, [selected, favorites]);
  // Web: files one after the other (browsers ask once to allow several).
  const downloadSelected = useCallback(async () => {
    for (const n of selected) {
      try {
        await downloadFile(await api.getSavedImage(n), n);
      } catch {
        /* unreadable file: skip it */
      }
    }
  }, [selected]);

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
      } else if ((e.key === "Delete" || e.key === "Backspace") && viewIndexRef.current == null) {
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
    isFavorite: (name) => favorites.has(name),
    reuseSettings: onReuseSettings,
    useAsSource: onUseAsSource,
  };

  // Build the tile list + the parallel viewer sequence (same order) whose index
  // every tile, the menu, and the lightbox share. Tiles are spread across `cols`
  // columns round-robin so the reading order is LEFT-TO-RIGHT; each column stacks
  // at natural height → true masonry. Session generations are folded into `saved`
  // (see the merge effect), so the gallery is a single uniform stream.
  const groups: { label: string; tiles: { key: string; el: React.ReactElement }[] }[] = [];
  const viewItems: ViewerItem[] = [];
  const pushView = (v: ViewerItem) => {
    viewItems.push(v);
    return viewItems.length - 1;
  };
  const now = new Date();
  const shown = favOnly ? saved.filter((g) => favorites.has(g.name)) : saved;
  for (const g of shown) {
    const label = dayBucket(g.meta?.createdAt, now, i18n.language, t);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, tiles: [] });
    const index = pushView({
      name: g.name,
      savedPath: g.savedPath || undefined,
      meta: g.meta,
      kind: g.kind,
      getSrc: () => (g.src ? Promise.resolve(g.src) : api.getSavedImage(g.name)),
    });
    groups[groups.length - 1].tiles.push({ key: g.name, el: <SavedTile image={g} index={index} shared={shared} /> });
  }
  viewItemsRef.current = viewItems;
  // Masonry per day section: each section spreads its tiles over `cols`
  // columns round-robin, so the reading order stays left to right.
  const sections = groups.map((g) => {
    const columns: { key: string; el: React.ReactElement }[][] = Array.from({ length: cols }, () => []);
    g.tiles.forEach((tile, i) => columns[i % cols].push(tile));
    return { label: g.label, columns };
  });
  const empty = viewItems.length === 0;
  // First page still loading → show a skeleton grid, not the "no images" empty
  // state (which used to flash before the first page arrived).
  const initialLoading = empty && loading && !favOnly;
  const favEmpty = empty && favOnly;

  return (
    <div className="relative flex flex-col gap-3 pb-20">
      <div ref={toolbar.sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
      {/* One toolbar: search · filters · favorites | density. Sticky, so it
          stays at hand however far the gallery is scrolled; frosted only once
          it actually floats over the tiles. */}
      <div
        ref={toolbar.barRef}
        data-stuck={toolbar.stuck || undefined}
        className="gallery-toolbar sticky top-0 z-20 -mx-1.5 -my-1.5 flex items-center gap-2 px-1.5 py-1.5"
      >
        <FilterBar facets={facets} filter={filter} onChange={setFilter} />
        <button
          type="button"
          onClick={() => setFavOnly((v) => !v)}
          aria-pressed={favOnly}
          title={t("gallery.favoritesOnly")}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
            favOnly
              ? "border-warning/50 bg-warning/10 text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
          )}
        >
          <Star className={cn("size-3.5", favOnly && "fill-warning text-warning")} />
          <span className="max-md:sr-only">{t("gallery.favoritesOnly")}</span>
        </button>
        {isWeb && <WebGalleryLocation />}
        <ColumnPicker cols={cols} onChange={setCols} />
      </div>

      {initialLoading ? (
        <GallerySkeleton cols={cols} />
      ) : favEmpty ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-1.5 text-center">
          <Star className="text-warning mb-2 size-7" strokeWidth={1.5} />
          <p className="text-foreground text-base font-semibold tracking-[-0.011em]">
            {loading ? t("common.checking") : t("gallery.emptyFavorites")}
          </p>
          {!loading && <p className="text-muted-foreground max-w-72 text-sm">{t("gallery.emptyFavoritesHint")}</p>}
        </div>
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
          {!filtered && (
            <p className="text-muted-foreground relative max-w-72 text-sm">
              {t("gallery.emptyHint")}{" "}
              <span className="inline-flex translate-y-[-1px] items-center gap-1 align-middle">
                <Kbd>{modLabel}</Kbd>
                <Kbd>
                  <CornerDownLeft className="size-3" />
                </Kbd>
              </span>
            </p>
          )}
          {!filtered && (
            // A first image is one click away: the same examples as the tour.
            <div className="relative mt-4 flex max-w-xl flex-col items-center gap-2">
              <p className="ds-sublabel">{t("welcome.tryPrompt")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {(["sample1", "sample2", "sample3"] as const).map((k) => (
                  <button key={k} type="button" className="welcome-prompt" onClick={() => onUsePrompt(t(`welcome.${k}`))}>
                    <Sparkles className="size-3.5 shrink-0" />
                    <span>{t(`welcome.${k}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
        sections.map((sec, si) => (
          <section key={`${si}-${sec.label}`} className="flex flex-col gap-2" aria-label={sec.label}>
            <h3 className={cn("ds-sublabel flex items-center gap-2 px-0.5", si > 0 && "mt-3")}>
              {sec.label}
              <span className="bg-border/70 h-px flex-1" />
            </h3>
            <div className="flex items-start gap-3">
              {sec.columns.map((col, ci) => (
                <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
                  {col.map((tile) => (
                    <div key={tile.key}>{tile.el}</div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {!done && <div ref={sentinelRef} className="h-4 w-full" />}
      {/* Loading the NEXT page (not the first) → append a row of skeleton tiles. */}
      {loading && !initialLoading && <GallerySkeleton cols={cols} rows={1} />}

      {/* Floating selection bar. Portalled to <body>: inside the board, the
          panels' entrance transform makes `fixed` relative to the column, and
          the bar floated mid-gallery instead of at the window's bottom. */}
      {selected.size > 0 &&
        createPortal(
        <div className="animate-in fade-in slide-in-from-bottom-2 fixed bottom-[calc(1.5rem+var(--phone-nav-h))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-popover/95 px-2 py-2 pl-4 shadow-2xl backdrop-blur">
          <span className="text-sm font-medium tabular-nums">
            {t("gallery.selectedCount", { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={favoriteSelected}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <Star className="size-3.5" /> {t("gallery.favoriteSelected")}
          </button>
          {isWeb && (
            <button
              type="button"
              onClick={downloadSelected}
              className="hover:bg-muted inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
            >
              <Download className="size-3.5" /> {t("gallery.download")}
            </button>
          )}
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
        </div>,
        document.body
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
          onReusePrompt={onReusePrompt}
          onReuseSeed={onReuseSeed}
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
          onReusePrompt={onReusePrompt}
          onReuseSeed={onReuseSeed}
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

  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const count = (filter.engine ? 1 : 0) + (filter.modelCode ? 1 : 0) + (filter.source ? 1 : 0);
  const hasFacets = models.length > 0 || engines.length > 1 || sources.length > 1;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search className="text-subtle pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("gallery.search")}
          aria-label={t("gallery.search")}
          className="ds-field h-8 w-full pl-8 pr-2 text-xs"
        />
      </div>
      {hasFacets && (
        <>
          <button
            ref={anchorRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={open ? popId : undefined}
            aria-haspopup="dialog"
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
              count > 0 || open
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            <SlidersHorizontal className="size-3.5" />
            <span className="max-sm:sr-only">{t("gallery.filters")}</span>
            {count > 0 && (
              <span className="bg-primary text-primary-foreground grid size-4 place-items-center rounded-full text-2xs font-semibold tabular-nums">
                {count}
              </span>
            )}
          </button>
          <Popover id={popId} open={open} onOpenChange={setOpen} anchorRef={anchorRef} label={t("gallery.filters")} className="w-64 p-3">
            <div className="grid gap-3">
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
              <div className="flex justify-end border-t pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!active}
                  onClick={() => onChange(EMPTY_FILTER)}
                >
                  {t("common.clear")}
                </Button>
              </div>
            </div>
          </Popover>
        </>
      )}
      {active && !hasFacets && (
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
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="ds-sublabel">
        {label}
      </label>
    <Select id={id} size="sm" value={value} onChange={onChange} className="w-full">
      <option value="">{t("gallery.all")}</option>
      {facets.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label} ({f.count})
        </option>
      ))}
    </Select>
    </div>
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
}: {
  image: SavedImage;
  index: number;
  shared: GalleryShared;
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
  const favorite = shared.isFavorite(image.name);
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
      {/* Top right: state you want to see at a glance — the star (always shown
          once set) and, on a video, which tile has the sound. */}
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
            toggleFavorite(image.name);
          }}
          aria-label={favorite ? t("gallery.unfavorite") : t("gallery.favorite")}
          aria-pressed={favorite}
          title={favorite ? t("gallery.unfavorite") : t("gallery.favorite")}
          className={cn(
            "rounded-full bg-black/50 p-1.5 text-white transition hover:bg-black/70",
            favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
        >
          <Star className={cn("size-3.5", favorite && "fill-amber-300 text-amber-300")} />
        </button>
      </div>
      {/* Hover: what this image is (the prompt) and the two moves people make
          from it — run it again, or start from it. Delete stays in the menu,
          the viewer and the selection bar, away from a passing cursor. */}
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/75 via-black/45 to-transparent px-2.5 pb-2 pt-8 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {image.meta?.prompt && (
          <p className="line-clamp-2 text-xs leading-snug [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">{image.meta.prompt}</p>
        )}
        <div className="flex items-center gap-1.5 text-2xs">
          {image.source && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-1.5 py-0.5 font-medium capitalize">
              {image.source === "tool" && <Wand2 className="size-2.5" />}
              {image.source === "tool" && image.meta?.tool
                ? t(`tools.names.${image.meta.tool}`, { defaultValue: image.meta.tool })
                : image.source}
            </span>
          )}
          {image.seed > 0 && <span className="truncate tabular-nums text-white/75">{t("gallery.seed", { seed: image.seed })}</span>}
          <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1">
            {image.meta?.prompt && (
              <TileAction
                label={t("gallery.ctxReuse")}
                onClick={() => shared.reuseSettings(image.meta!)}
                icon={<RotateCcw />}
              />
            )}
            {!isVideo && (
              <TileAction
                label={t("gallery.ctxUseAsSource")}
                onClick={() => shared.useAsSource(ensureSrc)}
                icon={<ImageIcon />}
              />
            )}
          </span>
        </div>
      </figcaption>
    </figure>
  );
}

// A round icon button in a tile's hover bar.
function TileAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // A press here must not start the tile's img2img drag.
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={label}
      title={label}
      className="rounded-full bg-white/20 p-1.5 text-white backdrop-blur transition hover:bg-white/35 [&_svg]:size-3.5"
    >
      {icon}
    </button>
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
  onReusePrompt,
  onReuseSeed,
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
  onReusePrompt: (prompt: string) => void;
  onReuseSeed: (seed: number) => void;
  onDelete: (name: string) => void;
  onTool: (toolId: string, target: ViewerItem, maskMode?: "select") => void;
}) {
  const { t } = useTranslation();
  const favorites = useFavorites();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Placed at the cursor from its measured size: below and to the right of the
  // click, flipped above / to the left when that side has no room, and capped
  // to the window (it scrolls inside if taller). Hidden until measured.
  const W = 268;
  const M = 8;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // Re-placed whenever its content resizes: the Edit tools list arrives after
  // the first paint and makes the menu taller.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const h = Math.min(el.scrollHeight, vh - 2 * M);
      const left = x + W + M <= vw ? x : Math.max(M, x - W);
      const below = vh - y - M;
      const top = h <= below ? y : y - h >= M ? y - h : Math.max(M, vh - h - M);
      setPos({ left, top, maxHeight: vh - 2 * M });
    };
    place();
    const ro = new ResizeObserver(place);
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);
  const meta = target.meta;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Portalled to <body>: inside the board, an ancestor with a transform (the
  // panels' entrance animation) makes `fixed` relative to it, not the window.
  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className={cn(
          "animate-in fade-in zoom-in-95 bg-popover absolute overflow-y-auto rounded-xl border p-1 shadow-2xl duration-100",
          !pos && "invisible"
        )}
        style={{ left: pos?.left ?? x, top: pos?.top ?? y, width: W, maxHeight: pos?.maxHeight }}
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
            icon={<CornerDownLeft />}
            label={t("gallery.ctxReusePrompt")}
            onClick={run(() => onReusePrompt(meta.prompt))}
          />
        )}
        {!!meta?.seed && (
          <MenuItem
            icon={<Dices />}
            label={t("gallery.ctxReuseSeed", { seed: meta.seed })}
            onClick={run(() => onReuseSeed(meta.seed))}
          />
        )}
        {meta?.prompt && (
          <MenuItem
            icon={<Copy />}
            label={t("gallery.ctxCopyPrompt")}
            onClick={run(() => void navigator.clipboard?.writeText(meta.prompt).catch(() => {}))}
          />
        )}
        {target.name && (
          <MenuItem
            icon={<Star />}
            label={favorites.has(target.name) ? t("gallery.unfavorite") : t("gallery.favorite")}
            onClick={run(() => toggleFavorite(target.name!))}
          />
        )}
        {isWeb && target.name && (
          <MenuItem
            icon={<Download />}
            label={t("gallery.download")}
            onClick={run(() => void target.getSrc().then((src) => downloadFile(src, target.name!)).catch(() => {}))}
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
    </div>,
    document.body
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
