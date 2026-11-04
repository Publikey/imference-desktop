import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A click-opened panel anchored under a trigger (the header's engine pill).
 *
 * Portalled so the sticky header's overflow and stacking never clip it;
 * placed under the anchor, aligned to its start or end edge and kept inside
 * the window. Escape and a click outside close it, and focus goes back to the
 * trigger. The trigger owns `aria-expanded` / `aria-controls` (pass `id`).
 */
export function Popover({
  id,
  open,
  onOpenChange,
  anchorRef,
  align = "start",
  label,
  className,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  align?: "start" | "end";
  /** Accessible name of the dialog. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = panelRef.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const w = p.offsetWidth;
    const margin = 8;
    const raw = align === "end" ? r.right - w : r.left;
    setPos({
      top: r.bottom + 6,
      left: Math.max(margin, Math.min(raw, window.innerWidth - w - margin)),
    });
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      anchorRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
    };
  }, [open, onOpenChange, anchorRef, place]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={label}
      className={cn(
        "popover-panel bg-popover text-popover-foreground fixed z-50 rounded-2xl border shadow-lg",
        !pos && "invisible",
        className
      )}
      style={pos ?? { top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body
  );
}
