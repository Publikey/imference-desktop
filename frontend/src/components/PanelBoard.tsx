import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsLeftRight, ChevronsRightLeft, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { beginPointerDrag } from "@/lib/pointer-drag";

// ---------------------------------------------------------------------------
// PanelBoard — the main window's panels (Create / Activity / Gallery), arranged
// as drag-reorderable COLUMNS: each column stacks one or more panels top-to-
// bottom, so a panel can sit beside another (new column) or under it (same
// column). The arrangement persists across launches; the Activity panel can
// also collapse to a slim rail.
// ---------------------------------------------------------------------------

export type PanelId = "create" | "queue" | "gallery";
export type PanelColumns = PanelId[][];

const ALL_PANELS: PanelId[] = ["create", "queue", "gallery"];
const DEFAULT_COLUMNS: PanelColumns = [["create"], ["queue"], ["gallery"]];
const STORAGE_KEY = "imference.panels.v2";
const LEGACY_KEY = "imference.panels.v1"; // flat order → migrate to one-per-column

// Manual-resize bounds for a sidebar column (px). The gallery column always
// grows to fill the rest, so it isn't width-controlled.
const MIN_COL_PX = 240;
const MAX_COL_PX = 640;

type PersistedLayout = {
  columns: PanelColumns;
  collapsed: Partial<Record<PanelId, boolean>>;
  /** Per-panel manual width override in px (drag-to-resize). */
  widths: Partial<Record<PanelId, number>>;
};

// A stored layout is valid only if its columns are a partition of the exact
// known panel set (no dupes, none missing) — guards against stale/renamed keys.
function validColumns(cols: unknown): cols is PanelColumns {
  if (!Array.isArray(cols)) return false;
  const flat: unknown[] = [];
  for (const col of cols) {
    if (!Array.isArray(col)) return false;
    flat.push(...col);
  }
  if (flat.length !== ALL_PANELS.length) return false;
  return ALL_PANELS.every((id) => flat.includes(id));
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedLayout>;
      const columns = validColumns(p.columns) ? (p.columns as PanelColumns) : DEFAULT_COLUMNS;
      return { columns, collapsed: p.collapsed ?? {}, widths: p.widths ?? {} };
    }
    // Migrate a v1 flat order (each panel becomes its own column).
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const p = JSON.parse(legacy) as { order?: PanelId[]; collapsed?: Record<string, boolean> };
      if (Array.isArray(p.order) && validColumns(p.order.map((id) => [id]))) {
        return { columns: p.order.map((id) => [id]), collapsed: p.collapsed ?? {}, widths: {} };
      }
    }
  } catch {
    // corrupted storage → defaults
  }
  return { columns: DEFAULT_COLUMNS, collapsed: {}, widths: {} };
}

/** Panel arrangement state (2D columns), persisted to localStorage. */
export function usePanelLayout() {
  const [layout, setLayout] = useState<PersistedLayout>(loadLayout);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // storage unavailable — layout still works for this session
    }
  }, [layout]);

  const setColumns = useCallback(
    (columns: PanelColumns) => setLayout((l) => ({ ...l, columns })),
    []
  );
  const toggleCollapsed = useCallback(
    (id: PanelId) =>
      setLayout((l) => ({ ...l, collapsed: { ...l.collapsed, [id]: !l.collapsed[id] } })),
    []
  );
  const setWidths = useCallback(
    (widths: Partial<Record<PanelId, number>>) => setLayout((l) => ({ ...l, widths })),
    []
  );

  return {
    columns: layout.columns,
    collapsed: layout.collapsed,
    widths: layout.widths,
    setColumns,
    toggleCollapsed,
    setWidths,
  };
}

export type PanelSpec = {
  title: string;
  icon: ReactNode;
  /** Small count/status chip next to the title. */
  badge?: ReactNode;
  /** Right side of the header (e.g. "Clear" in the Activity panel). */
  actions?: ReactNode;
  /** Preferred sidebar width in rem (18 or 25); ignored when `grow`. */
  width?: number;
  /** The main, growing column (the gallery). */
  grow?: boolean;
  /** Collapsible to a slim rail (Activity panel). */
  collapsible?: boolean;
  content: ReactNode;
};

const FLIP_MS = 420;

/** Where a dragged panel lands relative to the hovered one. */
type DropMode = "above" | "below" | "left" | "right";

/**
 * FLIP transitions for the panels: when the arrangement changes their layout
 * box, each panel slides from its old position to the new one instead of
 * teleporting. Measure-invert-play against the previous frame's rects; the panel
 * under the cursor is skipped (it tracks the drag ghost).
 */
function usePanelFlip(layoutKey: string, dragId: PanelId | null) {
  const nodes = useRef(new Map<PanelId, HTMLElement>());
  const prev = useRef(new Map<PanelId, DOMRect>());

  const register = useCallback((id: PanelId, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [id, el] of nodes.current) {
      el.style.transition = "none";
      el.style.transform = "none";
      const next = el.getBoundingClientRect();
      const before = prev.current.get(id);
      prev.current.set(id, next);

      const dx = before ? before.left - next.left : 0;
      const dy = before ? before.top - next.top : 0;
      if (!before || reduce || id === dragId || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) {
        el.style.transition = "";
        el.style.transform = "";
        continue;
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = `transform ${FLIP_MS}ms var(--ease-out-expo)`;
        el.style.transform = "";
      });
      const clear = () => {
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", clear);
      };
      el.addEventListener("transitionend", clear);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  return register;
}

export function PanelBoard({
  columns,
  onColumnsChange,
  collapsed,
  onToggleCollapsed,
  widths,
  onWidthsChange,
  panels,
}: {
  columns: PanelColumns;
  onColumnsChange: (c: PanelColumns) => void;
  collapsed: Partial<Record<PanelId, boolean>>;
  onToggleCollapsed: (id: PanelId) => void;
  widths: Partial<Record<PanelId, number>>;
  onWidthsChange: (w: Partial<Record<PanelId, number>>) => void;
  panels: Record<PanelId, PanelSpec>;
}) {
  const { t } = useTranslation();
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [resizing, setResizing] = useState(false);
  const registerNode = usePanelFlip(JSON.stringify(columns) + JSON.stringify(collapsed), dragId);


  // A non-grow column's width: the widest manual override among its panels, else
  // its spec default (rem → px). The gallery column grows and isn't sized here.
  const colWidthPx = useCallback(
    (col: PanelId[]) =>
      Math.max(...col.map((id) => widths[id] ?? (panels[id].width ?? 25) * 16)),
    [widths, panels]
  );

  // Drag the divider between columns ci and ci+1. Resizes the non-grow neighbour
  // (prefer the left column); the gallery flexes to absorb the change. Live —
  // every pointermove writes the new width (persisted on release).
  const startResize = useCallback(
    (e: React.PointerEvent, ci: number) => {
      const left = columns[ci];
      const right = columns[ci + 1];
      const leftGrow = left?.some((id) => panels[id].grow);
      const rightGrow = right?.some((id) => panels[id].grow);
      let target: PanelId[];
      let sign: number;
      if (left && !leftGrow) {
        target = left;
        sign = 1; // drag right → widen the left column
      } else if (right && !rightGrow) {
        target = right;
        sign = -1; // left is the gallery → drag right shrinks the right column
      } else {
        return; // both sides flexible — nothing to size
      }
      e.preventDefault();
      const startX = e.clientX;
      const startW = colWidthPx(target);
      setResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const w = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, startW + (ev.clientX - startX) * sign));
        const next = { ...widths };
        for (const id of target) next[id] = w;
        onWidthsChange(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizing(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [columns, panels, widths, colWidthPx, onWidthsChange]
  );

  const canResize = (ci: number) => {
    const left = columns[ci];
    const right = columns[ci + 1];
    const leftFixed = left && !left.some((id) => panels[id].grow);
    const rightFixed = right && !right.some((id) => panels[id].grow);
    return !!(leftFixed || rightFixed);
  };

  // Live 2D reorder while dragging: place `from` relative to the hovered `to`.
  const moveTo = useCallback(
    (from: PanelId, to: PanelId, mode: DropMode) => {
      if (from === to) return;
      // Remove `from`, dropping any column it emptied.
      let next: PanelColumns = columns
        .map((col) => col.filter((id) => id !== from))
        .filter((col) => col.length > 0);
      const ci = next.findIndex((col) => col.includes(to));
      if (ci < 0) return;
      if (mode === "above" || mode === "below") {
        const col = [...next[ci]];
        col.splice(col.indexOf(to) + (mode === "below" ? 1 : 0), 0, from);
        next = next.map((c, i) => (i === ci ? col : c));
      } else {
        const at = mode === "right" ? ci + 1 : ci;
        next = [...next.slice(0, at), [from], ...next.slice(at)];
      }
      if (JSON.stringify(next) !== JSON.stringify(columns)) onColumnsChange(next);
    },
    [columns, onColumnsChange]
  );

  // Reorder via pointer events (not native HTML5 drag): WebKit/WKWebView doesn't
  // fire drop/dragend reliably for in-page drags, which left the drag state stuck
  // on. pointerup always fires, so the state always clears. Live reorder is
  // driven by hit-testing the panel under the cursor (data-panel-id).
  const startReorder = useCallback(
    (e: React.PointerEvent, from: PanelId) => {
      beginPointerDrag(e, {
        onStart: () => setDragId(from),
        onMove: (x, y) => {
          const target = document
            .elementFromPoint(x, y)
            ?.closest<HTMLElement>("[data-panel-id]");
          const to = target?.dataset.panelId as PanelId | undefined;
          if (!to || to === from) return;
          const r = target!.getBoundingClientRect();
          const rx = (x - (r.left + r.width / 2)) / r.width;
          const ry = (y - (r.top + r.height / 2)) / r.height;
          const horizontal = window.innerWidth >= 1280 && Math.abs(rx) > Math.abs(ry);
          const mode: DropMode = horizontal ? (rx < 0 ? "left" : "right") : ry < 0 ? "above" : "below";
          moveTo(from, to, mode);
        },
        onEnd: () => setDragId(null),
      });
    },
    [moveTo]
  );

  return (
    <div className="flex w-full flex-col gap-6 xl:flex-row xl:items-start xl:gap-2">
      {columns.map((col, ci) => {
        const grow = col.some((id) => panels[id].grow);
        const rail = col.length === 1 && !!collapsed[col[0]] && !!panels[col[0]].collapsible;
        // A collapsed rail keeps its fixed slim width; otherwise the manual /
        // default width drives the column via a CSS var (only applied at xl).
        const columnClass = cn(
          "flex flex-col gap-4",
          grow
            ? "min-w-0 xl:flex-1"
            : rail
              ? "mx-auto xl:mx-0 xl:sticky xl:top-4 xl:w-12 xl:shrink-0"
              : "mx-auto w-full max-w-2xl xl:mx-0 xl:max-w-none xl:w-[var(--col-w)] xl:shrink-0 xl:sticky xl:top-4"
        );
        const style =
          grow || rail
            ? undefined
            : ({ "--col-w": `${colWidthPx(col)}px` } as React.CSSProperties);
        // Key by position, not content: a content key remounts the whole column
        // on every live reorder, destroying the dragged panel's node (and its
        // dragend) mid-drag.
        return (
          <Fragment key={ci}>
            <div className={columnClass} style={style}>
              {col.map((id) => (
                <Panel
                  key={id}
                  id={id}
                  spec={panels[id]}
                  collapsed={!!collapsed[id]}
                  rail={rail}
                  onToggleCollapsed={() => onToggleCollapsed(id)}
                  dragId={dragId}
                  startReorder={startReorder}
                  registerNode={registerNode}
                />
              ))}
            </div>
            {/* Resize divider — only between columns, only on the desktop row
                layout, and only when a neighbour has a fixed (non-grow) width. */}
            {ci < columns.length - 1 &&
              (canResize(ci) ? (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("panels.resize")}
                  onPointerDown={(e) => startResize(e, ci)}
                  onDoubleClick={() => {
                    // Double-click resets the adjacent fixed column to its default.
                    const target = columns[ci].some((id) => panels[id].grow)
                      ? columns[ci + 1]
                      : columns[ci];
                    const next = { ...widths };
                    for (const id of target) delete next[id];
                    onWidthsChange(next);
                  }}
                  className={cn(
                    "group hidden shrink-0 cursor-col-resize items-center justify-center xl:flex xl:w-2 xl:self-stretch",
                    resizing && "select-none"
                  )}
                >
                  <div
                    className={cn(
                      "h-16 w-0.5 rounded-full transition-colors",
                      resizing
                        ? "bg-[var(--brand-from)]"
                        : "bg-border/50 group-hover:bg-[var(--brand-from)]/60"
                    )}
                  />
                </div>
              ) : (
                <div className="hidden xl:block xl:w-2 xl:shrink-0" />
              ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function Panel({
  id,
  spec,
  collapsed,
  rail,
  onToggleCollapsed,
  dragId,
  startReorder,
  registerNode,
}: {
  id: PanelId;
  spec: PanelSpec;
  collapsed: boolean;
  rail: boolean; // collapsed AND alone in its column → slim vertical rail
  onToggleCollapsed: () => void;
  dragId: PanelId | null;
  startReorder: (e: React.PointerEvent, id: PanelId) => void;
  registerNode: (id: PanelId, el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const dragging = dragId === id;
  const droppable = dragId !== null && dragId !== id;

  const grip = (
    <button
      type="button"
      onPointerDown={(e) => startReorder(e, id)}
      title={t("panels.dragToReorder")}
      aria-label={t("panels.dragToReorder")}
      className="panel-grip text-muted-foreground/40 hover:text-muted-foreground -ml-1 rounded p-0.5 transition-colors"
    >
      <GripVertical className="size-3.5" />
    </button>
  );

  // Collapsed + alone → a slim rail (vertical on desktop) that expands on click.
  if (collapsed && spec.collapsible && rail) {
    return (
      <section
        ref={(el) => registerNode(id, el)}
        className={cn("shrink-0 transition-opacity", dragging && "panel-dragging", droppable && "panel-drop-hint")}
        data-panel-id={id}
        aria-label={spec.title}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={t("panels.expand")}
          aria-label={t("panels.expand")}
          aria-expanded={false}
          className={cn(
            "bg-card/60 hover:border-primary/30 hover:bg-card group flex w-full items-center justify-center gap-2 rounded-2xl border py-2.5 shadow-sm backdrop-blur transition-colors",
            "xl:min-h-40 xl:w-12 xl:flex-col xl:gap-2.5 xl:py-4"
          )}
        >
          <span className="text-muted-foreground group-hover:text-foreground transition-colors [&_svg]:size-4">
            {spec.icon}
          </span>
          {spec.badge}
          <ChevronsLeftRight className="text-muted-foreground/50 group-hover:text-foreground size-3.5 transition-colors" />
        </button>
      </section>
    );
  }

  // Collapsed but stacked with siblings → a compact full-width bar.
  if (collapsed && spec.collapsible) {
    return (
      <section
        ref={(el) => registerNode(id, el)}
        className={cn("min-w-0 transition-opacity", dragging && "panel-dragging", droppable && "panel-drop-hint")}
        data-panel-id={id}
        aria-label={spec.title}
      >
        <div className="flex items-center gap-1.5 px-1">
          {grip}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={false}
            title={t("panels.expand")}
            className="bg-card/60 hover:border-primary/30 hover:bg-card group flex flex-1 items-center gap-2 rounded-xl border px-3 py-2 shadow-sm backdrop-blur transition-colors"
          >
            <span className="text-muted-foreground [&_svg]:size-4">{spec.icon}</span>
            <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.14em]">
              {spec.title}
            </h2>
            {spec.badge}
            <ChevronsLeftRight className="text-muted-foreground/50 group-hover:text-foreground ml-auto size-3.5 transition-colors" />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={(el) => registerNode(id, el)}
      className={cn("flex min-w-0 flex-col gap-3 transition-opacity", dragging && "panel-dragging", droppable && "panel-drop-hint")}
      data-panel-id={id}
      aria-label={spec.title}
    >
      <header className="flex h-6 select-none items-center gap-1.5 px-1">
        {grip}
        <span className="text-muted-foreground [&_svg]:size-3.5">{spec.icon}</span>
        <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.14em]">
          {spec.title}
        </h2>
        {spec.badge}
        <div className="ml-auto flex items-center gap-1.5">
          {spec.actions}
          {spec.collapsible && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title={t("panels.collapse")}
              aria-label={t("panels.collapse")}
              aria-expanded
              className="text-muted-foreground/50 hover:text-foreground rounded p-0.5 transition-colors"
            >
              <ChevronsRightLeft className="size-3.5" />
            </button>
          )}
        </div>
      </header>
      <div className="min-w-0 flex-1">{spec.content}</div>
    </section>
  );
}
