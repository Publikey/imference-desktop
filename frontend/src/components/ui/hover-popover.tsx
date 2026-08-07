import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Reveals text that a `truncate` had to cut off.
 *
 * A native `title` won't do here: it's slow, unstyled, doesn't wrap a long
 * engine error readably, and vanishes the moment you move the pointer — so the
 * message can't be selected and pasted into a bug report.
 *
 * Rendered through a portal because the panels it lives in are scroll
 * containers with `overflow`, which would clip an inline popup. It stays open
 * while the pointer travels from the trigger into the panel, which is what
 * makes the text selectable.
 */
export function HoverPopover({
  content,
  className,
  children,
}: {
  /** Full text to reveal. Nothing renders when empty. */
  content: string;
  /** Applied to the trigger wrapper — pass `truncate` to make it the clipped element. */
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  // Anchored by `top` when placed below the trigger, by `bottom` when flipped
  // above — so the panel grows away from the row and hugs it either way,
  // whatever the message's height turns out to be.
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
  } | null>(null);
  // Two timers: opening waits so a pointer merely crossing the row doesn't flash
  // a panel; closing waits so the pointer can cross the gap into the panel.
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    // Scrolled out of the panel it lives in: nothing left to point at.
    if (r.bottom < 0 || r.top > window.innerHeight) {
      setPos(null);
      return;
    }

    const margin = 8;
    const gap = 6;
    const width = Math.min(380, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin);

    // Prefer below, flip above only when that side is genuinely roomier.
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    setPos(
      below >= above
        ? { top: r.bottom + gap, left, width }
        : { bottom: window.innerHeight - r.top + gap, left, width }
    );
  }, []);

  const open = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    if (pos) return;
    openTimer.current = window.setTimeout(() => {
      const el = triggerRef.current;
      // Nothing is hidden → nothing to reveal. Saves a pointless panel on the
      // short messages that fit inline.
      if (!el || el.scrollWidth <= el.clientWidth + 1) return;
      place();
    }, 250);
  }, [place, pos]);

  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    closeTimer.current = window.setTimeout(() => setPos(null), 120);
  }, []);

  // Keep it anchored while the surrounding panel scrolls, and let Escape
  // dismiss it — a hover panel with no keyboard exit is a trap.
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", onKey);
    };
  }, [pos, place]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    []
  );

  if (!content) return <span className={className}>{children}</span>;

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={pos ? id : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className={cn("outline-none focus-visible:underline", className)}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            onMouseEnter={() => window.clearTimeout(closeTimer.current)}
            onMouseLeave={close}
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
            className="bg-popover text-popover-foreground fixed z-[90] max-h-56 overflow-y-auto rounded-lg border p-2.5 text-[11px] leading-relaxed shadow-lg"
          >
            {/* select-text so the message can be copied into a bug report; the
                panel survives the pointer entering it, which makes that possible. */}
            <p className="break-words whitespace-pre-wrap select-text">{content}</p>
          </div>,
          document.body
        )}
    </>
  );
}
