import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsLeftRight, ChevronsRightLeft, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// PanelBoard — the main window's three panels (Create / Activity / Gallery),
// drag-reorderable by their header grip. The arrangement persists across
// launches; the Activity panel can also collapse to a slim rail.
// ---------------------------------------------------------------------------

export type PanelId = "create" | "queue" | "gallery";

const DEFAULT_ORDER: PanelId[] = ["create", "queue", "gallery"];
const STORAGE_KEY = "imference.panels.v1";

type PersistedLayout = {
  order: PanelId[];
  collapsed: Partial<Record<PanelId, boolean>>;
};

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedLayout>;
      // Accept the stored order only if it's a permutation of the known panels —
      // guards against stale keys after renames between versions.
      const order =
        Array.isArray(p.order) &&
        p.order.length === DEFAULT_ORDER.length &&
        DEFAULT_ORDER.every((id) => (p.order as PanelId[]).includes(id))
          ? (p.order as PanelId[])
          : DEFAULT_ORDER;
      return { order, collapsed: p.collapsed ?? {} };
    }
  } catch {
    // corrupted storage → defaults
  }
  return { order: DEFAULT_ORDER, collapsed: {} };
}

/** Panel arrangement state, persisted to localStorage. */
export function usePanelLayout() {
  const [layout, setLayout] = useState<PersistedLayout>(loadLayout);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // storage unavailable — layout still works for this session
    }
  }, [layout]);

  const setOrder = useCallback(
    (order: PanelId[]) => setLayout((l) => ({ ...l, order })),
    []
  );
  const toggleCollapsed = useCallback(
    (id: PanelId) =>
      setLayout((l) => ({ ...l, collapsed: { ...l.collapsed, [id]: !l.collapsed[id] } })),
    []
  );

  return { order: layout.order, collapsed: layout.collapsed, setOrder, toggleCollapsed };
}

export type PanelSpec = {
  title: string;
  icon: ReactNode;
  /** Small count/status chip next to the title. */
  badge?: ReactNode;
  /** Right side of the header (e.g. "Clear" in the Activity panel). */
  actions?: ReactNode;
  /** Column sizing/stickiness classes (applied to the panel root). */
  className?: string;
  /** Collapsible to a slim rail (Activity panel). */
  collapsible?: boolean;
  content: ReactNode;
};

const FLIP_MS = 420;

/**
 * FLIP transitions for the panel columns: when `order` (or a collapse) changes
 * their layout box, each panel slides from its old position to the new one
 * instead of teleporting. Measure-invert-play against the previous frame's
 * rects; the panel under the cursor is skipped (it tracks the drag ghost).
 */
function usePanelFlip(order: PanelId[], collapsedKey: string, dragId: PanelId | null) {
  const nodes = useRef(new Map<PanelId, HTMLElement>());
  const prev = useRef(new Map<PanelId, DOMRect>());

  const register = useCallback((id: PanelId, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [id, el] of nodes.current) {
      // Settle any in-flight transform so the box we read is the pure layout
      // position, not a mid-animation one (matters for rapid reorders).
      el.style.transition = "none";
      el.style.transform = "none";
      const next = el.getBoundingClientRect();
      const before = prev.current.get(id);
      prev.current.set(id, next);

      const dx = before ? before.left - next.left : 0;
      const dy = before ? before.top - next.top : 0;
      // Nothing to animate (first sight, reduced motion, the dragged panel, or
      // no movement) → drop the inline overrides so class transitions resume.
      if (!before || reduce || id === dragId || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) {
        el.style.transition = "";
        el.style.transform = "";
        continue;
      }

      // Invert: jump the element back to where it was, then release on the next
      // frame so the browser animates the transform back to identity.
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
    // Re-measure whenever the arrangement changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.join(), collapsedKey]);

  return register;
}

export function PanelBoard({
  order,
  onOrderChange,
  collapsed,
  onToggleCollapsed,
  panels,
}: {
  order: PanelId[];
  onOrderChange: (o: PanelId[]) => void;
  collapsed: Partial<Record<PanelId, boolean>>;
  onToggleCollapsed: (id: PanelId) => void;
  panels: Record<PanelId, PanelSpec>;
}) {
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const registerNode = usePanelFlip(order, JSON.stringify(collapsed), dragId);

  // Live reorder while dragging: the dragged panel is inserted before/after the
  // hovered one depending on which half of it the pointer is in. The midpoint
  // test is the hysteresis that prevents two panels from oscillating.
  const placeAround = useCallback(
    (from: PanelId, to: PanelId, before: boolean) => {
      const next = order.filter((p) => p !== from);
      const j = next.indexOf(to);
      next.splice(before ? j : j + 1, 0, from);
      if (next.join() !== order.join()) onOrderChange(next);
    },
    [order, onOrderChange]
  );

  return (
    <div className="flex w-full flex-col gap-6 xl:flex-row xl:items-start xl:gap-5">
      {order.map((id) => (
        <PanelColumn
          key={id}
          id={id}
          spec={panels[id]}
          collapsed={!!collapsed[id]}
          onToggleCollapsed={() => onToggleCollapsed(id)}
          dragId={dragId}
          setDragId={setDragId}
          placeAround={placeAround}
          registerNode={registerNode}
        />
      ))}
    </div>
  );
}

function PanelColumn({
  id,
  spec,
  collapsed,
  onToggleCollapsed,
  dragId,
  setDragId,
  placeAround,
  registerNode,
}: {
  id: PanelId;
  spec: PanelSpec;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  dragId: PanelId | null;
  setDragId: (id: PanelId | null) => void;
  placeAround: (from: PanelId, to: PanelId, before: boolean) => void;
  registerNode: (id: PanelId, el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const dragging = dragId === id;
  const droppable = dragId !== null && dragId !== id;

  const onDragOver = (e: React.DragEvent) => {
    if (!droppable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    // Row layout (xl+) reorders on the horizontal axis, stacked layout on the
    // vertical one. The board switches at Tailwind's xl breakpoint (1280px).
    const horizontal = window.innerWidth >= 1280;
    const before = horizontal
      ? e.clientX < rect.left + rect.width / 2
      : e.clientY < rect.top + rect.height / 2;
    placeAround(dragId!, id, before);
  };

  // Collapsed → a slim rail (vertical on desktop, a compact row when stacked)
  // that still shows the panel's icon + badge and expands on click.
  if (collapsed && spec.collapsible) {
    return (
      <section
        ref={(el) => registerNode(id, el)}
        className={cn(
          "shrink-0 transition-opacity",
          dragging && "panel-dragging",
          droppable && "panel-drop-hint"
        )}
        onDragOver={onDragOver}
        onDrop={(e) => e.preventDefault()}
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

  return (
    <section
      ref={(el) => registerNode(id, el)}
      className={cn(
        "flex min-w-0 flex-col gap-3 transition-opacity",
        spec.className,
        dragging && "panel-dragging",
        droppable && "panel-drop-hint"
      )}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      aria-label={spec.title}
    >
      <header className="flex h-6 select-none items-center gap-1.5 px-1">
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            // Some webviews require data for the drag to start.
            e.dataTransfer.setData("text/plain", id);
            setDragId(id);
          }}
          onDragEnd={() => setDragId(null)}
          title={t("panels.dragToReorder")}
          aria-label={t("panels.dragToReorder")}
          className="panel-grip text-muted-foreground/40 hover:text-muted-foreground -ml-1 rounded p-0.5 transition-colors"
        >
          <GripVertical className="size-3.5" />
        </button>
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
